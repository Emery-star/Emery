'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { quote, QuoteError } = require('../fees');
const { FriendsError, displayAccount } = require('./service');

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

/** Application « entre amis » : demandes, suivi et espace organisateur. */
function createFriendsApp({ config, friends, logger = console }) {
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
  app.use(express.json({ limit: '10kb' }));
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Requête JSON attendue' });
    next();
  });

  const fail = (res, err, context) => {
    if (err instanceof FriendsError || err instanceof QuoteError) return res.status(400).json({ error: err.message });
    logger.error(`${context} : ${err.message}`);
    res.status(500).json({ error: 'Une erreur est survenue. Réessayez dans un instant.' });
  };

  app.get('/api/config', (req, res) => {
    res.json({ mode: 'amis', rate: config.eurToXaf, fees: config.fees, limits: config.limits, methods: friends.methods(), operatorName: config.operator.name });
  });

  app.get('/api/quote', (req, res) => {
    const params = { direction: req.query.direction, amount: req.query.amount, payMethod: req.query.pay, payoutMethod: req.query.payout };
    try {
      const q = quote(params, config);
      q.firstTransferDiscount = quote({ ...params, firstTransfer: true }, config).discount;
      res.json(q);
    } catch (err) {
      fail(res, err, 'Devis');
    }
  });

  app.post('/api/requests', rateLimit({ windowMs: 60 * 60_000, max: 20 }), (req, res) => {
    try {
      const r = friends.create(req.body || {});
      res.status(201).json({ ...r, trackUrl: `/suivi.html?id=${r.id}&t=${r.accessToken}` });
    } catch (err) {
      fail(res, err, 'Nouvelle demande');
    }
  });

  app.get('/api/requests/:id', rateLimit({ windowMs: 60_000, max: 60 }), (req, res) => {
    const r = friends.forFriend(req.params.id, req.query.t);
    if (!r) return res.status(404).json({ error: 'Demande introuvable' });
    res.json(r);
  });

  app.post('/api/requests/:id/paid', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
    try {
      await friends.declarePaid(req.params.id, req.query.t, req.body.payerRef);
      res.json(friends.forFriend(req.params.id, req.query.t));
    } catch (err) {
      fail(res, err, 'Paiement annoncé');
    }
  });

  app.post('/api/requests/:id/cancel', rateLimit({ windowMs: 60_000, max: 10 }), (req, res) => {
    try {
      friends.cancelByFriend(req.params.id, req.query.t);
      res.json(friends.forFriend(req.params.id, req.query.t));
    } catch (err) {
      fail(res, err, 'Annulation');
    }
  });

  // Espace organisateur, protégé par ADMIN_TOKEN.
  const requireAdmin = (req, res, next) => {
    const auth = req.get('authorization') || '';
    const expected = `Bearer ${config.adminToken}`;
    const ok = config.adminToken.length >= 16 && auth.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'Code organisateur invalide' });
    next();
  };
  const adminLimit = rateLimit({ windowMs: 60_000, max: 120 });

  app.get('/api/admin/requests', adminLimit, requireAdmin, (req, res) => {
    res.json(friends.list({ status: req.query.status || undefined }).map((r) => ({ ...r, account_display: displayAccount(r) })));
  });

  app.post('/api/admin/requests/:id/:action', adminLimit, requireAdmin, (req, res) => {
    try {
      const r = friends.operatorAction(req.params.id, req.params.action, req.body || {});
      res.json({ ...r, account_display: displayAccount(r) });
    } catch (err) {
      fail(res, err, 'Action organisateur');
    }
  });

  const pub = path.join(__dirname, '..', '..', 'public');
  app.get('/styles.css', (req, res) => res.sendFile(path.join(pub, 'styles.css')));
  app.use(express.static(path.join(pub, 'amis')));
  return app;
}

module.exports = { createFriendsApp };
