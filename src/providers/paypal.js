'use strict';

// Statuts d'un élément de versement PayPal Payouts.
function mapItemStatus(s) {
  if (s === 'SUCCESS') return 'success';
  if (['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED'].includes(s)) return 'failed';
  return 'pending'; // PENDING, UNCLAIMED, ONHOLD, NEW
}

/** Versements vers un compte PayPal (API Payouts) pour les envois Gabon -> France. */
class PaypalClient {
  constructor(cfg, fetchImpl = fetch) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await this.fetch(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal auth HTTP ${res.status}`);
    const body = await res.json();
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + Number(body.expires_in || 300) * 1000;
    return this.token;
  }

  async request(method, path, body) {
    const res = await this.fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await this.getToken()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`PayPal ${method} ${path} HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  async payout({ id, email, amountEur, note }) {
    const body = await this.request('POST', '/v1/payments/payouts', {
      // sender_batch_id unique : PayPal refuse un second lot avec le même identifiant (pas de double envoi).
      sender_batch_header: { sender_batch_id: id, email_subject: 'Vous avez reçu de l’argent du Gabon' },
      items: [{
        recipient_type: 'EMAIL',
        receiver: email,
        amount: { value: amountEur.toFixed(2), currency: 'EUR' },
        note,
        sender_item_id: id,
      }],
    });
    return { status: 'pending', providerRef: body.batch_header.payout_batch_id };
  }

  async status(batchId) {
    const body = await this.request('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
    const item = body.items && body.items[0];
    return { status: mapItemStatus(item && item.transaction_status), providerRef: batchId, message: item && item.errors && item.errors.message };
  }
}

/** Simulateur : un e-mail commençant par "echec" simule un compte PayPal refusé. */
class MockPaypalClient {
  constructor() {
    this.sent = new Map();
  }
  async payout({ id, email, amountEur }) {
    const ref = `MOCKPP-${id.slice(1, 9)}`;
    this.sent.set(ref, { email, amountEur, status: email.startsWith('echec') ? 'failed' : 'success' });
    return { status: 'pending', providerRef: ref };
  }
  async status(ref) {
    const p = this.sent.get(ref);
    return { status: p ? p.status : 'failed', providerRef: ref, message: p && p.status === 'failed' ? 'Compte PayPal refusé (simulé)' : undefined };
  }
}

module.exports = { PaypalClient, MockPaypalClient, mapItemStatus };
