'use strict';

const test = require('node:test');
const assert = require('node:assert');
const baseConfig = require('../src/config');
const { openDb } = require('../src/db');
const { createAlerts } = require('../src/friends/alerts');
const { createFriendsService } = require('../src/friends/service');
const { createFriendsApp } = require('../src/friends/app');

const quiet = { error() {}, warn() {}, log() {} };
const ADMIN = 'code-organisateur-de-test-123';
const config = {
  ...baseConfig,
  mode: 'amis',
  adminToken: ADMIN,
  publicUrl: 'https://envoi.example',
  operator: { name: 'Emery', airtel: '074 00 00 01', paypalEmail: 'orga@example.com', paypalMe: 'orgaexemple', wero: '0612345678', iban: '', whatsapp: '' },
};

async function start(cfg = config) {
  const db = openDb(':memory:');
  const alerts = createAlerts({}, { logger: quiet });
  const friends = createFriendsService({ db, config: cfg, alerts, logger: quiet });
  const app = createFriendsApp({ config: cfg, friends, logger: quiet });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, admin } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (admin) headers.Authorization = `Bearer ${ADMIN}`;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { db, friends, alerts, server, call };
}

const frToGa = {
  direction: 'fr_to_ga', payMethod: 'paypal', payoutMethod: 'airtel', amount: 100,
  recipientAccount: '077 12 34 56', recipientName: 'Paul Obame', senderName: 'Marie Ndong', senderContact: '06 11 22 33 44',
};

test('France -> Gabon : demande, instructions PayPal, paiement annoncé, alerte, envoi confirmé', async (t) => {
  const { server, call, alerts } = await start();
  t.after(() => server.close());

  const created = await call('/api/requests', { method: 'POST', body: frToGa });
  assert.strictEqual(created.status, 201);
  assert.match(created.body.code, /^EG-[A-Z2-9]{5}$/);
  assert.strictEqual(created.body.quote.discount, 3.99); // premier envoi : frais (2,99 + 1 % PayPal) offerts
  const { id, accessToken } = created.body;

  const view = await call(`/api/requests/${id}?t=${accessToken}`);
  assert.strictEqual(view.body.status, 'awaiting_payment');
  assert.strictEqual(view.body.instructions.to, 'orga@example.com');
  assert.strictEqual(view.body.instructions.link, 'https://paypal.me/orgaexemple/100.00EUR');
  assert.strictEqual(view.body.recipientAccount, '077 •• •• 56');

  const declared = await call(`/api/requests/${id}/paid?t=${accessToken}`, { method: 'POST', body: { payerRef: 'TX123' } });
  assert.strictEqual(declared.body.status, 'declared');
  assert.strictEqual(alerts.sent.length, 1);
  assert.match(alerts.sent[0].text, /Marie Ndong dit avoir payé 100,00\s€ par PayPal \(réf\. TX123\)/);
  assert.match(alerts.sent[0].text, /65\s595 FCFA à Paul Obame sur Airtel Money \+241 077 12 34 56/);

  // L'organisateur voit le numéro complet, confirme la réception puis l'envoi.
  const list = await call('/api/admin/requests?status=declared', { admin: true });
  assert.strictEqual(list.body[0].account_display, '+241 077 12 34 56');
  assert.strictEqual((await call(`/api/admin/requests/${id}/sent`, { method: 'POST', admin: true, body: {} })).status, 400);
  await call(`/api/admin/requests/${id}/received`, { method: 'POST', admin: true, body: {} });
  const sent = await call(`/api/admin/requests/${id}/sent`, { method: 'POST', admin: true, body: { ref: 'AM-998877' } });
  assert.strictEqual(sent.body.status, 'completed');

  const final = await call(`/api/requests/${id}?t=${accessToken}`);
  assert.strictEqual(final.body.status, 'completed');
  assert.strictEqual(final.body.payoutRef, 'AM-998877');
  assert.strictEqual(final.body.instructions, null);

  // Deuxième envoi du même contact : frais normaux.
  const second = await call('/api/requests', { method: 'POST', body: frToGa });
  assert.strictEqual(second.body.quote.discount, 0);
});

test('Gabon -> France : paiement sur le numéro Airtel de l’organisateur, réception Wero', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const created = await call('/api/requests', { method: 'POST', body: {
    direction: 'ga_to_fr', payMethod: 'airtel', payoutMethod: 'wero', amount: 65596,
    recipientAccount: '+33 6 98 76 54 32', recipientName: 'Marie Ndong', senderName: 'Paul Obame', senderContact: '077123456',
  } });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.quote.receiveAmount, 100);
  const view = await call(`/api/requests/${created.body.id}?t=${created.body.accessToken}`);
  assert.strictEqual(view.body.instructions.to, '+241 074 00 00 01');
  assert.strictEqual(view.body.instructions.amount, '65 596 FCFA');
  const list = await call('/api/admin/requests', { admin: true });
  assert.strictEqual(list.body[0].account_display, '0698765432');
});

test('annulation par l’ami, refus des moyens non configurés et des saisies invalides', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const c = await call('/api/requests', { method: 'POST', body: frToGa });
  const cancelled = await call(`/api/requests/${c.body.id}/cancel?t=${c.body.accessToken}`, { method: 'POST', body: {} });
  assert.strictEqual(cancelled.body.status, 'cancelled');
  assert.strictEqual((await call(`/api/requests/${c.body.id}/paid?t=${c.body.accessToken}`, { method: 'POST', body: {} })).status, 400);

  const bad = [
    { ...frToGa, payMethod: 'virement' },              // pas d'IBAN organisateur configuré
    { ...frToGa, recipientAccount: '066123456' },      // numéro Moov
    { ...frToGa, senderContact: 'abc' },
    { ...frToGa, amount: 5000 },
    { ...frToGa, direction: 'ga_to_fr', payMethod: 'airtel', payoutMethod: 'sepa', amount: 20000, recipientAccount: 'FR7630006000011234567890188' },
  ];
  for (const b of bad) assert.strictEqual((await call('/api/requests', { method: 'POST', body: b })).status, 400, JSON.stringify(b));
});

test('suivi et espace organisateur protégés', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const c = await call('/api/requests', { method: 'POST', body: frToGa });
  assert.strictEqual((await call(`/api/requests/${c.body.id}?t=faux`)).status, 404);
  assert.strictEqual((await call('/api/admin/requests')).status, 401);
  assert.strictEqual((await call(`/api/admin/requests/${c.body.id}/received`, { method: 'POST', body: {} })).status, 401);
});

test('les demandes jamais payées expirent après 48 h', async (t) => {
  const { server, call, db, friends } = await start();
  t.after(() => server.close());
  const c = await call('/api/requests', { method: 'POST', body: frToGa });
  db.prepare("UPDATE friend_requests SET created_at = '2000-01-01T00:00:00.000Z'").run();
  friends.expire();
  assert.strictEqual(friends.find(c.body.id).status, 'cancelled');
});

test('alertes ntfy et Telegram', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const alerts = createAlerts({ ntfyServer: 'https://ntfy.sh', ntfyTopic: 'mon-sujet-secret', telegramToken: 'T', telegramChatId: '42' }, { fetchImpl: fakeFetch, logger: quiet });
  await alerts.send({ title: 'Paiement annoncé EG-AAAAA', text: 'détails', url: 'https://x/admin.html' });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, 'https://ntfy.sh/mon-sujet-secret');
  assert.strictEqual(calls[0].opts.headers.Title, 'Paiement annonce EG-AAAAA');
  assert.strictEqual(calls[1].url, 'https://api.telegram.org/botT/sendMessage');
  assert.strictEqual(JSON.parse(calls[1].opts.body).chat_id, '42');
});
