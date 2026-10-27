'use strict';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { openDb } = require('../src/db');
const { MockAirtelClient, AirtelClient } = require('../src/providers/airtel');
const { MockPayments } = require('../src/providers/payments');
const { createTransferService } = require('../src/transfers');
const { createApp } = require('../src/app');

const quiet = { error() {}, warn() {}, log() {} };

async function startApp() {
  const db = openDb(':memory:');
  const airtel = new MockAirtelClient();
  const payments = new MockPayments('http://test');
  const transfers = createTransferService({ db, config, airtel, payments, logger: quiet });
  const app = createApp({ config, transfers, airtel, payments, logger: quiet });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, opts = {}) => {
    const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json' } });
    return { status: res.status, body: await res.json() };
  };
  return { server, call, payments, airtel, transfers };
}

const sender = { senderName: 'Marie Ndong', senderEmail: 'marie@example.com', recipientName: 'Paul Obame' };

test('parcours complet : création, paiement, dépôt Airtel', async (t) => {
  const { server, call, airtel } = await startApp();
  t.after(() => server.close());

  const created = await call('/api/transfers', {
    method: 'POST',
    body: JSON.stringify({ ...sender, amountEur: 50, recipientPhone: '077 12 34 56' }),
  });
  assert.strictEqual(created.status, 201);
  const session = new URL(created.body.checkoutUrl).searchParams.get('session');

  const paid = await call(`/api/mock-checkout/${session}/complete`, { method: 'POST' });
  assert.strictEqual(paid.status, 200);

  const status = await call(`/api/transfers/${created.body.id}?t=${created.body.accessToken}`);
  assert.strictEqual(status.body.status, 'completed');
  assert.strictEqual(status.body.receivedXaf, 32797);
  assert.strictEqual(airtel.sent.get(created.body.id).amountXaf, 32797);

  // Un second webhook de paiement ne déclenche pas un second envoi.
  await call(`/api/mock-checkout/${session}/complete`, { method: 'POST' });
  assert.strictEqual(airtel.sent.size, 1);
});

test('un échec Airtel déclenche le remboursement', async (t) => {
  const { server, call, payments } = await startApp();
  t.after(() => server.close());

  const created = await call('/api/transfers', {
    method: 'POST',
    body: JSON.stringify({ ...sender, amountEur: 20, recipientPhone: '077119999' }),
  });
  const session = new URL(created.body.checkoutUrl).searchParams.get('session');
  await call(`/api/mock-checkout/${session}/complete`, { method: 'POST' });

  const status = await call(`/api/transfers/${created.body.id}?t=${created.body.accessToken}`);
  assert.strictEqual(status.body.status, 'refunded');
  assert.strictEqual(payments.refunds.length, 1);
});

test('le suivi exige le jeton d’accès', async (t) => {
  const { server, call } = await startApp();
  t.after(() => server.close());
  const created = await call('/api/transfers', {
    method: 'POST',
    body: JSON.stringify({ ...sender, amountEur: 20, recipientPhone: '077123456' }),
  });
  const res = await call(`/api/transfers/${created.body.id}?t=mauvais`);
  assert.strictEqual(res.status, 404);
});

test('refuse les numéros non Airtel et les montants invalides', async (t) => {
  const { server, call } = await startApp();
  t.after(() => server.close());
  const moov = await call('/api/transfers', {
    method: 'POST',
    body: JSON.stringify({ ...sender, amountEur: 20, recipientPhone: '066123456' }),
  });
  assert.strictEqual(moov.status, 400);
  const tooMuch = await call('/api/transfers', {
    method: 'POST',
    body: JSON.stringify({ ...sender, amountEur: 99999, recipientPhone: '077123456' }),
  });
  assert.strictEqual(tooMuch.status, 400);
});

test('erreur réseau Airtel : pas de remboursement aveugle, réconciliation ensuite', async () => {
  const db = openDb(':memory:');
  const airtel = new MockAirtelClient();
  const realDisburse = airtel.disburse.bind(airtel);
  airtel.disburse = async () => { throw new Error('ETIMEDOUT'); };
  const payments = new MockPayments('http://test');
  const svc = createTransferService({ db, config, airtel, payments, logger: quiet });

  const c = await svc.create({ ...sender, amountEur: 30, recipientPhone: '077123456' });
  const tr = svc.findByCheckout(new URL(c.checkoutUrl).searchParams.get('session'));
  await svc.onPaymentConfirmed({ transferId: tr.id, checkoutId: tr.checkout_id, paymentRef: 'pi_1' });
  assert.strictEqual(svc.getPublic(c.id, c.accessToken).status, 'sending');
  assert.strictEqual(payments.refunds.length, 0);

  // Airtel a finalement bien traité le dépôt.
  await realDisburse({ id: tr.id, msisdn: tr.recipient_msisdn, amountXaf: tr.received_xaf });
  await svc.reconcile();
  assert.strictEqual(svc.getPublic(c.id, c.accessToken).status, 'completed');
});

test('client Airtel : jeton OAuth puis décaissement avec en-têtes Gabon', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    const body = url.endsWith('/token')
      ? { access_token: 'tok', expires_in: 180 }
      : { data: { transaction: { id: 'x', status: 'TS', airtel_money_id: 'AM123' } }, status: { success: true } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const client = new AirtelClient({ ...config.airtel, clientId: 'id', clientSecret: 's', pin: '1234' }, fakeFetch);
  const r = await client.disburse({ id: 'x', msisdn: '077123456', amountXaf: 1000, reference: 'r' });
  assert.deepStrictEqual(r, { status: 'success', providerRef: 'AM123', message: undefined });
  const d = calls[1];
  assert.match(d.url, /\/standard\/v2\/disbursements\/$/);
  assert.strictEqual(d.opts.headers['X-Country'], 'GA');
  assert.strictEqual(d.opts.headers['X-Currency'], 'XAF');
  assert.strictEqual(d.opts.headers.Authorization, 'Bearer tok');
  assert.strictEqual(JSON.parse(d.opts.body).transaction.type, 'B2C');
});
