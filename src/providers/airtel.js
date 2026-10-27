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
}

/** Simulateur utilisé quand aucune clé Airtel n'est configurée (développement / démo). */
class MockAirtelClient {
  constructor() {
    this.sent = new Map();
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
}

module.exports = { AirtelClient, MockAirtelClient, mapStatus };
