'use strict';

const test = require('node:test');
const assert = require('node:assert');
const baseConfig = require('../src/config');
const { openDb } = require('../src/db');
const { MockAirtelClient, AirtelClient } = require('../src/providers/airtel');
const { MockPayments } = require('../src/providers/payments');
const { MockPaypalClient, PaypalClient } = require('../src/providers/paypal');
const { MockSepaClient } = require('../src/providers/sepa');
const { createRails } = require('../src/rails');
const { createTransferService } = require('../src/transfers');
const { createApp } = require('../src/app');
const { createUserService } = require('../src/users');
const { MockKyc } = require('../src/compliance/kyc');
const { createScreening } = require('../src/compliance/screening');
const { createLimits } = require('../src/compliance/limits');
const { ConsoleNotifier } = require('../src/notifier');

const quiet = { error() {}, warn() {}, log() {} };
const ADMIN = 'jeton-admin-de-test-0123456789';
const config = { ...baseConfig, mode: 'demo', adminToken: ADMIN, limits: { ...baseConfig.limits, dailyEur: 1000, monthlyEur: 3000 } };

function setup() {
  const db = openDb(':memory:');
  const p = {
    airtel: new MockAirtelClient(),
    payments: new MockPayments('http://test'),
    paypal: new MockPaypalClient(),
    sepa: new MockSepaClient(),
    kyc: new MockKyc(),
    notifier: new ConsoleNotifier(quiet),
    screening: createScreening(baseConfig.sanctionsFile),
  };
  const rails = createRails({ config, ...p });
  const users = createUserService({ db, kyc: p.kyc, screening: p.screening, logger: quiet });
  const transfers = createTransferService({
    db, config, rails, users, notifier: p.notifier, screening: p.screening, limits: createLimits({ db, config }), logger: quiet,
  });
  return { ...p, db, rails, users, transfers };
}

const identity = { birthDate: '1990-05-12', country: 'FR', address: '12 rue de la Paix, 75002 Paris', idType: 'passeport', idNumber: '18AB12345' };

async function startApp() {
  const s = setup();
  const app = createApp({ config, transfers: s.transfers, users: s.users, rails: s.rails, airtel: s.airtel, payments: s.payments, kyc: s.kyc, logger: quiet });
  const server = await new Promise((r) => { const srv = app.listen(0, () => r(srv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, opts = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) };
    const res = await fetch(base + path, { ...opts, headers });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  const post = (path, body, opts) => call(path, { method: 'POST', body: JSON.stringify(body || {}), ...opts });
  /** Crée un compte, se connecte et fait vérifier l'identité (simulée). */
  async function signup(fullName = 'Marie Ndong', email = 'marie@example.com', kyc = {}) {
    cookie = '';
    assert.strictEqual((await post('/api/auth/register', { fullName, email, password: 'motdepasse-solide' })).status, 201);
    return post('/api/me/kyc', { fullName, ...identity, ...kyc });
  }
  const admin = (path, body) => (body === undefined
    ? call(path, { headers: { Authorization: `Bearer ${ADMIN}` } })
    : post(path, body, { headers: { Authorization: `Bearer ${ADMIN}` } }));
  return { ...s, server, call, post, signup, admin, logout: () => { cookie = ''; } };
}

const frSender = { recipientName: 'Paul Obame' };
const gaSender = { senderPhone: '077 12 34 56', recipientName: 'Marie Ndong' };

test('France -> Gabon : paiement carte puis dépôt Airtel, premier envoi offert, reçu par e-mail', async (t) => {
  const { server, call, post, airtel, signup, notifier } = await startApp();
  t.after(() => server.close());
  await signup();

  const created = await post('/api/transfers', { ...frSender, amount: 50, recipientPhone: '077 12 34 56' });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.quote.discount, 0.99);
  assert.strictEqual(created.body.quote.total, 50);
  const session = new URL(created.body.checkoutUrl).searchParams.get('session');

  assert.strictEqual((await post(`/api/mock-checkout/${session}/complete`)).status, 200);
  const st = await call(`/api/transfers/${created.body.id}?t=${created.body.accessToken}`);
  assert.strictEqual(st.body.status, 'completed');
  assert.strictEqual(st.body.receiveAmount, 32797);
  assert.strictEqual(airtel.sent.get(`D${created.body.id}`).amountXaf, 32797);

  // Un second webhook de paiement ne déclenche pas un second envoi.
  await post(`/api/mock-checkout/${session}/complete`);
  assert.strictEqual(airtel.sent.size, 1);

  // Le deuxième envoi du même expéditeur paie les frais normaux.
  const second = await post('/api/transfers', { ...frSender, amount: 50, recipientPhone: '077 12 34 56' });
  assert.strictEqual(second.body.quote.discount, 0);

  assert.strictEqual(notifier.sent.length, 1);
  assert.strictEqual(notifier.sent[0].to, 'marie@example.com');
  assert.match(notifier.sent[0].subject, /est arrivé/);
  assert.match(notifier.sent[0].text, /32\s797 FCFA/);

  const history = await call('/api/me/transfers');
  assert.strictEqual(history.body.length, 2);
});

test('France -> Gabon : échec Airtel => remboursement', async (t) => {
  const { server, call, post, payments , signup } = await startApp();
  t.after(() => server.close());
  await signup();
  const created = await post('/api/transfers', { ...frSender, amount: 20, recipientPhone: '077119999', payMethod: 'paypal' });
  const session = new URL(created.body.checkoutUrl).searchParams.get('session');
  await post(`/api/mock-checkout/${session}/complete`);
  const st = await call(`/api/transfers/${created.body.id}?t=${created.body.accessToken}`);
  assert.strictEqual(st.body.status, 'refunded');
  assert.strictEqual(payments.refunds.length, 1);
});

test('Gabon -> France : paiement Airtel (code PIN) puis virement SEPA', async (t) => {
  const { server, call, post, sepa , signup } = await startApp();
  t.after(() => server.close());
  await signup();
  const created = await post('/api/transfers', {
    ...gaSender, direction: 'ga_to_fr', payoutMethod: 'sepa', amount: 65596, recipientIban: 'FR76 3000 6000 0112 3456 7890 189',
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.checkoutUrl, null);
  assert.match(created.body.nextUrl, /^\/suivi\.html/);
  const path = `/api/transfers/${created.body.id}?t=${created.body.accessToken}`;
  assert.strictEqual((await call(path)).body.status, 'awaiting_payment');

  const after = await post(`/api/demo/airtel-pin/${created.body.id}?t=${created.body.accessToken}`);
  assert.strictEqual(after.body.status, 'completed');
  assert.strictEqual(after.body.receiveAmount, 100);
  assert.strictEqual(after.body.recipientAccount, 'FR76 •••• •••• 0189');
  assert.strictEqual([...sepa.sent.values()][0].amountEur, 100);
});

test('Gabon -> France : PayPal refusé => remboursement sur Airtel Money', async (t) => {
  const { server, post, airtel , signup } = await startApp();
  t.after(() => server.close());
  await signup();
  const created = await post('/api/transfers', {
    ...gaSender, direction: 'ga_to_fr', payoutMethod: 'paypal', amount: 20000, recipientEmail: 'echec@example.com',
  });
  const after = await post(`/api/demo/airtel-pin/${created.body.id}?t=${created.body.accessToken}`);
  assert.strictEqual(after.body.status, 'refunded');
  assert.strictEqual(airtel.refunds.length, 1);
});

test('Gabon -> France : solde insuffisant => paiement annulé, rien n’est versé', async (t) => {
  const { server, post, sepa , signup } = await startApp();
  t.after(() => server.close());
  await signup();
  const created = await post('/api/transfers', {
    ...gaSender, senderPhone: '077119999', direction: 'ga_to_fr', payoutMethod: 'sepa', amount: 20000,
    recipientIban: 'FR7630006000011234567890189',
  });
  const after = await post(`/api/demo/airtel-pin/${created.body.id}?t=${created.body.accessToken}`);
  assert.strictEqual(after.body.status, 'cancelled');
  assert.strictEqual(sepa.sent.size, 0);
});

test('refuse les saisies invalides et Wero (pas encore branché)', async (t) => {
  const { server, post , signup } = await startApp();
  t.after(() => server.close());
  await signup();
  const cases = [
    { ...frSender, amount: 20, recipientPhone: '066123456' },
    { ...frSender, amount: 99999, recipientPhone: '077123456' },
    { ...frSender, amount: 20, recipientPhone: '077123456', payMethod: 'wero' },
    { ...gaSender, direction: 'ga_to_fr', payoutMethod: 'sepa', amount: 20000, recipientIban: 'FR7630006000011234567890188' },
    { ...gaSender, direction: 'ga_to_fr', payoutMethod: 'wero', amount: 20000 },
  ];
  for (const c of cases) assert.strictEqual((await post('/api/transfers', c)).status, 400, JSON.stringify(c));
});

test('le suivi exige le jeton d’accès', async (t) => {
  const { server, call, post , signup } = await startApp();
  t.after(() => server.close());
  await signup();
  const created = await post('/api/transfers', { ...frSender, amount: 20, recipientPhone: '077123456' });
  assert.strictEqual((await call(`/api/transfers/${created.body.id}?t=mauvais`)).status, 404);
});

test('erreur réseau au versement : pas de remboursement aveugle, réconciliation ensuite', async () => {
  const s = setup();
  const realDisburse = s.airtel.disburse.bind(s.airtel);
  s.airtel.disburse = async () => { throw new Error('ETIMEDOUT'); };
  const u = await s.users.register({ email: 'a@b.fr', password: 'motdepasse-solide', fullName: 'Awa Mba' });
  await s.users.submitKyc(u.id, { fullName: 'Awa Mba', ...identity });

  const c = await s.transfers.create(s.users.find(u.id), { ...frSender, amount: 30, recipientPhone: '077123456' });
  const tr = s.transfers.findByCheckout(new URL(c.checkoutUrl).searchParams.get('session'));
  await s.transfers.onPaymentConfirmed({ transferId: tr.id, checkoutId: tr.checkout_id, paymentRef: 'pi_1' });
  assert.strictEqual(s.transfers.getPublic(c.id, c.accessToken).status, 'sending');
  assert.strictEqual(s.payments.refunds.length, 0);

  // Airtel avait finalement bien traité le dépôt.
  await realDisburse({ id: `D${tr.id}`, msisdn: tr.recipient_account, amountXaf: tr.receive_amount });
  await s.transfers.reconcile();
  assert.strictEqual(s.transfers.getPublic(c.id, c.accessToken).status, 'completed');
});

test('en mode live, les moyens sans prestataire configuré sont indisponibles', () => {
  const live = { ...baseConfig, mode: 'live', stripe: { enabled: false }, paypal: { enabled: false }, sepa: { enabled: false }, airtel: { enabled: true } };
  const m = createRails({ config: live, sepa: null }).methods();
  assert.deepStrictEqual(m.fr_to_ga.pay.filter((x) => x.available).map((x) => x.id), []);
  assert.deepStrictEqual(m.ga_to_fr.pay.filter((x) => x.available).map((x) => x.id), ['airtel']);
  assert.deepStrictEqual(m.ga_to_fr.payout.filter((x) => x.available).map((x) => x.id), []);
});

function fakeFetch(routes, calls) {
  return async (url, opts) => {
    calls.push({ url, opts });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = routes[key];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

test('client Airtel : jeton OAuth, décaissement et encaissement avec en-têtes Gabon', async () => {
  const calls = [];
  const client = new AirtelClient({ ...baseConfig.airtel, clientId: 'id', clientSecret: 's', pin: '1234' }, fakeFetch({
    '/token': { access_token: 'tok', expires_in: 180 },
    '/disbursements/': { data: { transaction: { status: 'TS', airtel_money_id: 'AM123' } }, status: { success: true } },
    '/merchant/v1/payments/': { data: { transaction: { id: 'C1', status: 'Success.' } }, status: { success: true } },
  }, calls));
  const r = await client.disburse({ id: 'D1', msisdn: '077123456', amountXaf: 1000, reference: 'r' });
  assert.deepStrictEqual(r, { status: 'success', providerRef: 'AM123', message: undefined });
  const d = calls[1];
  assert.strictEqual(d.opts.headers['X-Country'], 'GA');
  assert.strictEqual(d.opts.headers['X-Currency'], 'XAF');
  assert.strictEqual(d.opts.headers.Authorization, 'Bearer tok');
  assert.strictEqual(JSON.parse(d.opts.body).transaction.type, 'B2C');

  assert.deepStrictEqual(await client.collect({ id: 'C1', msisdn: '077123456', amountXaf: 5000, reference: 'r' }), { status: 'pending' });
  const body = JSON.parse(calls[2].opts.body);
  assert.deepStrictEqual(body.subscriber, { country: 'GA', currency: 'XAF', msisdn: '077123456' });
  assert.strictEqual(body.transaction.amount, 5000);
});

test('client PayPal : versement en euros vers un e-mail', async () => {
  const calls = [];
  const client = new PaypalClient({ clientId: 'a', clientSecret: 'b', baseUrl: 'https://pp' }, fakeFetch({
    '/oauth2/token': { access_token: 'pp', expires_in: 300 },
    '/payouts/BATCH1': { items: [{ transaction_status: 'SUCCESS' }] },
    '/payouts': { batch_header: { payout_batch_id: 'BATCH1' } },
  }, calls));
  const r = await client.payout({ id: 'Dabc', email: 'x@y.fr', amountEur: 12.5, note: 'n' });
  assert.deepStrictEqual(r, { status: 'pending', providerRef: 'BATCH1' });
  const item = JSON.parse(calls[1].opts.body).items[0];
  assert.deepStrictEqual(item.amount, { value: '12.50', currency: 'EUR' });
  assert.strictEqual(item.receiver, 'x@y.fr');
  assert.strictEqual((await client.status('BATCH1')).status, 'success');
});

test('comptes : inscription, connexion, mauvais mot de passe, déconnexion', async (t) => {
  const { server, call, post, logout } = await startApp();
  t.after(() => server.close());
  assert.strictEqual((await post('/api/auth/register', { fullName: 'Awa', email: 'awa@ex.fr', password: 'motdepasse-solide' })).status, 400);
  assert.strictEqual((await post('/api/auth/register', { fullName: 'Awa Mba', email: 'awa@ex.fr', password: 'court' })).status, 400);
  assert.strictEqual((await post('/api/auth/register', { fullName: 'Awa Mba', email: 'awa@ex.fr', password: 'motdepasse-solide' })).status, 201);
  assert.strictEqual((await post('/api/auth/register', { fullName: 'Awa Mba', email: 'AWA@ex.fr', password: 'motdepasse-solide' })).status, 400);
  assert.strictEqual((await call('/api/me')).body.email, 'awa@ex.fr');
  await post('/api/auth/logout');
  logout();
  assert.strictEqual((await call('/api/me')).status, 401);
  assert.strictEqual((await post('/api/auth/login', { email: 'awa@ex.fr', password: 'mauvais-mot-de-passe' })).status, 400);
  assert.strictEqual((await post('/api/auth/login', { email: 'inconnu@ex.fr', password: 'motdepasse-solide' })).status, 400);
  const ok = await post('/api/auth/login', { email: 'awa@ex.fr', password: 'motdepasse-solide' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await call('/api/me')).body.kycStatus, 'none');
});

test('envoi impossible sans connexion, sans identité vérifiée, ou avec un formulaire non JSON', async (t) => {
  const { server, call, post } = await startApp();
  t.after(() => server.close());
  const body = { ...frSender, amount: 20, recipientPhone: '077123456' };
  assert.strictEqual((await post('/api/transfers', body)).status, 401);
  await post('/api/auth/register', { fullName: 'Awa Mba', email: 'awa@ex.fr', password: 'motdepasse-solide' });
  const r = await post('/api/transfers', body);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /identité/);
  const form = await call('/api/transfers', { method: 'POST', body: 'amount=20', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.strictEqual(form.status, 415);
});

test('KYC : refus simulé, puis nouvelle demande acceptée ; mineur refusé', async (t) => {
  const { server, call, post, signup } = await startApp();
  t.after(() => server.close());
  const refused = await signup('Refus Test', 'r@ex.fr');
  assert.strictEqual(refused.body.status, 'rejected');
  assert.strictEqual((await call('/api/me')).body.kycStatus, 'rejected');
  const minor = await post('/api/me/kyc', { fullName: 'Awa Mba', ...identity, birthDate: '2015-01-01' });
  assert.strictEqual(minor.status, 400);
  const ok = await post('/api/me/kyc', { fullName: 'Awa Mba', ...identity });
  assert.strictEqual(ok.body.status, 'approved');
});

test('sanctions : un client listé reste en attente, un bénéficiaire listé est bloqué', async (t) => {
  const { server, call, post, signup, admin } = await startApp();
  t.after(() => server.close());
  const listed = await signup('Personne Sanction Test', 's@ex.fr');
  assert.strictEqual(listed.body.status, 'pending');
  const pending = await admin('/api/admin/users?kyc=pending');
  assert.strictEqual(pending.body.length, 1);
  assert.match(pending.body[0].kycReason, /Correspondance/);

  await signup('Marie Ndong', 'm@ex.fr');
  const r = await post('/api/transfers', { recipientName: 'Test Sanction Personne', amount: 20, recipientPhone: '077123456' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /support/);
});

test('plafond cumulé sur 24 h', async (t) => {
  const { server, post, signup } = await startApp();
  t.after(() => server.close());
  await signup();
  for (let i = 0; i < 2; i++) {
    assert.strictEqual((await post('/api/transfers', { ...frSender, amount: 450, recipientPhone: '077123456' })).status, 201);
  }
  const over = await post('/api/transfers', { ...frSender, amount: 150, recipientPhone: '077123456' });
  assert.strictEqual(over.status, 400);
  assert.match(over.body.error, /Plafond de 1000 €/);
});

test('admin : jeton requis, validation KYC manuelle et décision sur un envoi bloqué', async (t) => {
  const s = await startApp();
  t.after(() => s.server.close());
  assert.strictEqual((await s.call('/api/admin/transfers')).status, 401);
  assert.strictEqual((await s.call('/api/admin/transfers', { headers: { Authorization: 'Bearer mauvais' } })).status, 401);

  // Validation manuelle d'un dossier en attente.
  await s.signup('Personne Sanction Test', 's@ex.fr');
  const [u] = (await s.admin('/api/admin/users?kyc=pending')).body;
  assert.strictEqual((await s.admin(`/api/admin/users/${u.id}/kyc`, { decision: 'approved' })).body.kycStatus, 'approved');

  // Un versement resté sans réponse claire passe en vérification, puis l'équipe rembourse.
  const created = await s.post('/api/transfers', { ...frSender, amount: 40, recipientPhone: '077123456' });
  s.airtel.disburse = async () => { throw new Error('ETIMEDOUT'); };
  const session = new URL(created.body.checkoutUrl).searchParams.get('session');
  await s.post(`/api/mock-checkout/${session}/complete`);
  const id = created.body.id;
  assert.strictEqual((await s.admin('/api/admin/transfers?status=sending')).body.length, 1);
  // Refus tant que le transfert n'est pas « en vérification ».
  assert.strictEqual((await s.admin(`/api/admin/transfers/${id}/resolve`, { outcome: 'refund' })).status, 400);

  // Simule 6 h sans réponse claire d'Airtel.
  s.airtel.status = async () => ({ status: 'pending' });
  s.db.prepare("UPDATE transfers SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  await s.admin(`/api/admin/transfers/${id}/recheck`, {});
  assert.strictEqual(s.transfers.find(id).status, 'needs_review');

  assert.strictEqual((await s.admin(`/api/admin/transfers/${id}/resolve`, { outcome: 'cancel' })).status, 400);
  const done = await s.admin(`/api/admin/transfers/${id}/resolve`, { outcome: 'refund' });
  assert.strictEqual(done.body.status, 'refunded');
  assert.strictEqual(s.payments.refunds.length, 1);
  assert.match(s.notifier.sent.at(-1).subject, /remboursé/);
});
