'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { quote, QuoteError } = require('./fees');
const { normalizeAirtelGabon, formatGabon } = require('./phone');
const { ValidationError } = require('./transfers');
const { UserError } = require('./users');

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

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Envoie l'erreur métier au client, et masque les erreurs techniques. */
function sendError(res, err, logger, context) {
  if (err instanceof ValidationError || err instanceof QuoteError || err instanceof UserError) {
    return res.status(400).json({ error: err.message });
  }
  logger.error(`${context} : ${err.message}`);
  res.status(500).json({ error: 'Une erreur est survenue. Réessayez dans un instant.' });
}

function createApp({ config, transfers, users, rails, airtel, payments, kyc, logger = console }) {
  const secureCookie = config.publicUrl.startsWith('https://');
  const COOKIE = 'sid';
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

  // Webhook du prestataire KYC (corps brut pour vérifier sa signature).
  app.post('/webhooks/kyc', express.raw({ type: '*/*', limit: '100kb' }), (req, res) => {
    if (!kyc.parseWebhook) return res.status(404).end();
    let decision;
    try {
      decision = kyc.parseWebhook(req.body, req.headers);
    } catch (err) {
      logger.warn(`Webhook KYC rejeté : ${err.message}`);
      return res.status(400).send('Signature invalide');
    }
    const user = decision && users.findByKycRef(decision.ref);
    if (user && user.kyc_status === 'pending') users.setKycDecision(user.id, decision.status, decision.reason);
    res.json({ received: true });
  });

  app.use(express.json({ limit: '20kb' }));

  // Protection CSRF : toute requête qui modifie quelque chose doit être en JSON (un formulaire d'un autre
  // site ne peut pas en envoyer sans autorisation CORS), et le cookie de session est SameSite=Lax.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Requête JSON attendue' });
    }
    next();
  });

  // Identifie le client connecté.
  app.use((req, res, next) => {
    req.sessionToken = parseCookies(req.headers.cookie)[COOKIE];
    req.user = users.userFromSession(req.sessionToken);
    next();
  });
  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Connectez-vous pour continuer.' }));

  function openSession(res, userId) {
    const { token, expires } = users.createSession(userId);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookie, expires: new Date(expires), path: '/' });
  }

  const authLimit = rateLimit({ windowMs: 15 * 60_000, max: 20 });

  app.post('/api/auth/register', authLimit, async (req, res) => {
    try {
      const user = await users.register(req.body || {});
      openSession(res, user.id);
      res.status(201).json(users.publicProfile(user));
    } catch (err) {
      sendError(res, err, logger, 'Inscription');
    }
  });

  app.post('/api/auth/login', authLimit, async (req, res) => {
    try {
      const user = await users.login(req.body || {});
      openSession(res, user.id);
      res.json(users.publicProfile(user));
    } catch (err) {
      sendError(res, err, logger, 'Connexion');
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    users.logout(req.sessionToken);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => {
    res.json({ ...users.publicProfile(req.user), firstTransfer: transfers.isFirstTransfer(req.user.id) });
  });

  app.post('/api/me/kyc', requireUser, rateLimit({ windowMs: 60 * 60_000, max: 10 }), async (req, res) => {
    try {
      res.json(await users.submitKyc(req.user.id, req.body || {}));
    } catch (err) {
      sendError(res, err, logger, 'KYC');
    }
  });

  app.get('/api/me/transfers', requireUser, (req, res) => {
    res.json(transfers.historyFor(req.user.id));
  });

  app.get('/api/config', (req, res) => {
    res.json({
      mode: config.mode,
      rate: config.eurToXaf,
      limits: config.limits,
      fees: config.fees,
      methods: rails.methods(),
      support: config.support,
    });
  });

  app.get('/api/quote', (req, res) => {
    const params = {
      direction: req.query.direction,
      amount: req.query.amount,
      payMethod: req.query.pay,
      payoutMethod: req.query.payout,
    };
    try {
      const q = quote(params, config);
      // Remise affichée pour un premier envoi (appliquée à la création si l'expéditeur est nouveau).
      q.firstTransferDiscount = quote({ ...params, firstTransfer: true }, config).discount;
      res.json(q);
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

  app.post('/api/transfers', requireUser, rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
    try {
      const r = await transfers.create(req.user, req.body || {});
      const trackUrl = `/suivi.html?id=${r.id}&t=${r.accessToken}`;
      res.status(201).json({ ...r, nextUrl: r.checkoutUrl || trackUrl, trackUrl });
    } catch (err) {
      sendError(res, err, logger, 'Création transfert');
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

  // Simulations, uniquement en mode démo.
  if (config.mode === 'demo') {
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

    // Simule la validation du paiement par code PIN sur le téléphone de l'expéditeur.
    app.post('/api/demo/airtel-pin/:id', async (req, res) => {
      if (!transfers.getPublic(req.params.id, req.query.t)) return res.status(404).json({ error: 'Transfert introuvable' });
      airtel.confirmCollection(`C${req.params.id}`);
      await transfers.reconcileOne(req.params.id);
      res.json(transfers.getPublic(req.params.id, req.query.t));
    });
  }

  // Espace équipe : jeton ADMIN_TOKEN dans l'en-tête Authorization.
  const requireAdmin = (req, res, next) => {
    const auth = req.get('authorization') || '';
    const expected = `Bearer ${config.adminToken}`;
    const ok = config.adminToken.length >= 16 && auth.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'Jeton administrateur invalide' });
    next();
  };
  const adminLimit = rateLimit({ windowMs: 60_000, max: 120 });

  app.get('/api/admin/transfers', adminLimit, requireAdmin, (req, res) => {
    res.json(transfers.recent({ status: req.query.status || undefined }));
  });

  app.get('/api/admin/users', adminLimit, requireAdmin, (req, res) => {
    res.json(users.list({ kyc: req.query.kyc || undefined }).map((u) => ({
      ...users.publicProfile(u),
      idNumber: u.id_number,
      kycReason: u.kyc_reason,
      createdAt: u.created_at,
    })));
  });

  app.post('/api/admin/users/:id/kyc', adminLimit, requireAdmin, (req, res) => {
    try {
      if (!users.find(req.params.id)) return res.status(404).json({ error: 'Client introuvable' });
      res.json(users.publicProfile(users.setKycDecision(req.params.id, req.body.decision, req.body.reason)));
    } catch (err) {
      sendError(res, err, logger, 'Décision KYC');
    }
  });

  app.post('/api/admin/transfers/:id/recheck', adminLimit, requireAdmin, async (req, res) => {
    try {
      await transfers.reconcileOne(req.params.id);
      res.json(transfers.find(req.params.id) || null);
    } catch (err) {
      sendError(res, err, logger, 'Revérification');
    }
  });

  app.post('/api/admin/transfers/:id/resolve', adminLimit, requireAdmin, async (req, res) => {
    try {
      res.json(await transfers.resolve(req.params.id, req.body.outcome));
    } catch (err) {
      sendError(res, err, logger, 'Décision transfert');
    }
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

module.exports = { createApp, maskName };
