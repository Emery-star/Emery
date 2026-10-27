'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { quote, QuoteError } = require('./fees');
const { normalizeAirtelGabon, formatGabon } = require('./phone');
const { ValidationError } = require('./transfers');

/** Limiteur de débit en mémoire, par IP. Suffisant pour une seule instance. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ error: 'Trop de requêtes, réessayez dans un instant.' });
    next();
  };
}

/** Masque partiellement le nom KYC : "JEAN DUPONT" -> "JEAN D*****". */
function maskName(name) {
  const [first, ...rest] = name.split(/\s+/);
  return [first, ...rest.map((w) => w[0] + '*'.repeat(Math.max(0, w.length - 1)))].join(' ');
}

function createApp({ config, transfers, airtel, payments, logger = console }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    next();
  });

  // Le webhook Stripe doit recevoir le corps brut pour vérifier la signature.
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!payments.parseWebhook) return res.status(404).end();
    let confirmed;
    try {
      confirmed = payments.parseWebhook(req.body, req.get('stripe-signature'));
    } catch (err) {
      logger.warn(`Webhook Stripe rejeté : ${err.message}`);
      return res.status(400).send('Signature invalide');
    }
    if (!confirmed) return res.json({ received: true });
    try {
      await transfers.onPaymentConfirmed(confirmed);
      res.json({ received: true });
    } catch (err) {
      logger.error(`Webhook Stripe : ${err.message}`);
      res.status(err instanceof ValidationError ? 400 : 500).json({ error: err.message });
    }
  });

  app.use(express.json({ limit: '10kb' }));

  app.get('/api/config', (req, res) => {
    res.json({
      rate: config.eurToXaf,
      limits: config.limits,
      fees: config.fees,
      sandbox: !config.airtel.enabled || !config.stripe.enabled,
    });
  });

  app.get('/api/quote', (req, res) => {
    try {
      res.json(quote(req.query.amount, config));
    } catch (err) {
      if (err instanceof QuoteError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.post('/api/recipients/verify', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
    const msisdn = normalizeAirtelGabon(String(req.body.phone || ''));
    if (!msisdn) return res.status(400).json({ error: 'Ce numéro n’est pas un numéro Airtel Gabon (074, 076, 077).' });
    try {
      const name = await airtel.lookupName(msisdn);
      if (!name) return res.status(404).json({ error: 'Aucun compte Airtel Money trouvé pour ce numéro.' });
      res.json({ phone: formatGabon(msisdn), holder: maskName(name) });
    } catch (err) {
      logger.error(`Vérification bénéficiaire : ${err.message}`);
      res.status(502).json({ error: 'Vérification indisponible pour le moment.' });
    }
  });

  app.post('/api/transfers', rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
    try {
      const r = await transfers.create(req.body || {});
      res.status(201).json(r);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof QuoteError) {
        return res.status(400).json({ error: err.message });
      }
      logger.error(`Création transfert : ${err.message}`);
      res.status(500).json({ error: 'Impossible de créer le transfert.' });
    }
  });

  app.get('/api/transfers/:id', rateLimit({ windowMs: 60_000, max: 60 }), (req, res) => {
    const t = transfers.getPublic(req.params.id, req.query.t);
    if (!t) return res.status(404).json({ error: 'Transfert introuvable' });
    res.json(t);
  });

  // Callback Airtel : on ne fait pas confiance au contenu, on revérifie le statut auprès d'Airtel.
  app.post('/webhooks/airtel', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
    res.json({ received: true });
    transfers.reconcile().catch((err) => logger.error(`Réconciliation : ${err.message}`));
  });

  // Paiement simulé (uniquement sans Stripe configuré).
  if (!payments.parseWebhook) {
    app.post('/api/mock-checkout/:session/complete', async (req, res) => {
      const tr = transfers.findByCheckout(req.params.session);
      if (!tr) return res.status(404).json({ error: 'Session inconnue' });
      await transfers.onPaymentConfirmed({
        transferId: tr.id,
        checkoutId: tr.checkout_id,
        paymentRef: `mock_pi_${crypto.randomBytes(6).toString('hex')}`,
      });
      res.json({ redirect: `/suivi.html?id=${tr.id}&t=${tr.access_token}` });
    });
  }

  app.get('/api/admin/transfers', (req, res) => {
    const auth = req.get('authorization') || '';
    const expected = `Bearer ${config.adminToken}`;
    const ok = config.adminToken && auth.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'Non autorisé' });
    res.json(transfers.recent(200));
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

module.exports = { createApp, maskName };
