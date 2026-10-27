'use strict';

const crypto = require('node:crypto');

// Codes de statut Airtel : TS = succès, TF = échec, TA/TIP = en cours / ambigu.
function mapStatus(code) {
  if (code === 'TS') return 'success';
  if (code === 'TF' || code === 'TE') return 'failed';
  return 'pending';
}

/** Client pour l'Open API Airtel Africa (décaissements B2C vers un portefeuille Airtel Money). */
class AirtelClient {
  constructor(cfg, fetchImpl = fetch) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const res = await this.fetch(`${this.cfg.baseUrl}/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: 'client_credentials',
      }),
    });
    if (!res.ok) throw new Error(`Airtel auth HTTP ${res.status}`);
    const body = await res.json();
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + Number(body.expires_in || 180) * 1000;
    return this.token;
  }

  async request(method, path, body) {
    const token = await this.getToken();
    const res = await this.fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'X-Country': this.cfg.country,
        'X-Currency': this.cfg.currency,
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* réponse non JSON */ }
    if (!res.ok) {
      const err = new Error(`Airtel ${method} ${path} HTTP ${res.status}`);
      err.status = res.status;
      err.body = json || text;
      throw err;
    }
    return json;
  }

  encryptedPin() {
    if (!this.cfg.publicKey) return this.cfg.pin;
    const key = this.cfg.publicKey.includes('BEGIN')
      ? this.cfg.publicKey
      : `-----BEGIN PUBLIC KEY-----\n${this.cfg.publicKey}\n-----END PUBLIC KEY-----`;
    return crypto
      .publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(this.cfg.pin))
      .toString('base64');
  }

  /** Récupère le nom enregistré du titulaire du compte Airtel Money (KYC). */
  async lookupName(msisdn) {
    const body = await this.request('GET', `/standard/v1/users/${encodeURIComponent(msisdn)}`);
    const d = body && body.data;
    if (!d) return null;
    return [d.first_name, d.last_name].filter(Boolean).join(' ').trim() || null;
  }

  async disburse({ id, msisdn, amountXaf, reference }) {
    const body = await this.request('POST', '/standard/v2/disbursements/', {
      payee: { msisdn, wallet_type: 'NORMAL' },
      reference,
      pin: this.encryptedPin(),
      transaction: { amount: amountXaf, id, type: 'B2C' },
    });
    const tx = (body && body.data && body.data.transaction) || {};
    const ok = body && body.status && body.status.success;
    return {
      status: ok ? mapStatus(tx.status || 'TIP') : 'failed',
      providerRef: tx.airtel_money_id || tx.reference_id || null,
      message: body && body.status && body.status.message,
    };
  }

  async status(id) {
    const body = await this.request('GET', `/standard/v2/disbursements/${encodeURIComponent(id)}`);
    const tx = (body && body.data && body.data.transaction) || {};
    return { status: mapStatus(tx.status), providerRef: tx.airtel_money_id || null, message: tx.message };
  }

  /** Demande de paiement : le client reçoit une notification USSD et valide avec son code PIN Airtel. */
  async collect({ id, msisdn, amountXaf, reference }) {
    const c = this.cfg;
    const body = await this.request('POST', '/merchant/v1/payments/', {
      reference,
      subscriber: { country: c.country, currency: c.currency, msisdn },
      transaction: { amount: amountXaf, country: c.country, currency: c.currency, id },
    });
    if (!body || !body.status || !body.status.success) {
      return { status: 'failed', message: body && body.status && body.status.message };
    }
    return { status: 'pending' };
  }

  async collectionStatus(id) {
    const body = await this.request('GET', `/standard/v1/payments/${encodeURIComponent(id)}`);
    const tx = (body && body.data && body.data.transaction) || {};
    return { status: mapStatus(tx.status), providerRef: tx.airtel_money_id || null, message: tx.message };
  }

  async refundCollection(airtelMoneyId) {
    const body = await this.request('POST', '/standard/v1/payments/refund', {
      transaction: { airtel_money_id: airtelMoneyId },
    });
    if (!body || !body.status || !body.status.success) throw new Error('Remboursement Airtel refusé');
  }
}

/** Simulateur utilisé quand aucune clé Airtel n'est configurée (développement / démo). */
class MockAirtelClient {
  constructor() {
    this.sent = new Map();
    this.collections = new Map();
    this.refunds = [];
  }
  async lookupName(msisdn) {
    return msisdn.endsWith('0000') ? null : 'TITULAIRE TEST';
  }
  async disburse({ id, msisdn, amountXaf }) {
    // Un numéro se terminant par 9999 simule un échec, pour tester le remboursement.
    const status = msisdn.endsWith('9999') ? 'failed' : 'success';
    this.sent.set(id, { msisdn, amountXaf, status });
    return { status, providerRef: `MOCK-${id.slice(0, 8)}`, message: status === 'failed' ? 'Simulated failure' : 'OK' };
  }
  async status(id) {
    const tx = this.sent.get(id);
    return { status: tx ? tx.status : 'failed', providerRef: `MOCK-${id.slice(0, 8)}` };
  }
  async collect({ id, msisdn, amountXaf }) {
    this.collections.set(id, { msisdn, amountXaf, status: 'pending' });
    return { status: 'pending' };
  }
  /** Simule la saisie du code PIN par le client (9999 en fin de numéro = solde insuffisant). */
  confirmCollection(id) {
    const c = this.collections.get(id);
    if (c && c.status === 'pending') c.status = c.msisdn.endsWith('9999') ? 'failed' : 'success';
  }
  async collectionStatus(id) {
    const c = this.collections.get(id);
    if (!c) return { status: 'failed' };
    return { status: c.status, providerRef: `MOCKPAY-${id.slice(1, 9)}`, message: c.status === 'failed' ? 'Solde insuffisant (simulé)' : undefined };
  }
  async refundCollection(airtelMoneyId) {
    this.refunds.push(airtelMoneyId);
  }
}

module.exports = { AirtelClient, MockAirtelClient, mapStatus };
