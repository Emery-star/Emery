'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { normalizeEmail } = require('./validate');
const { normalizeAirtelGabon } = require('./phone');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const ID_TYPES = ['passeport', 'carte_identite', 'titre_sejour'];
const COUNTRIES = ['FR', 'GA', 'BE', 'DE', 'ES', 'IT', 'LU', 'NL', 'PT', 'CH', 'MC', 'IE', 'AT'];

class UserError extends Error {}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Comptes clients, sessions et vérification d'identité (KYC). */
function createUserService({ db, kyc, screening, logger = console }) {
  const now = () => new Date().toISOString();
  const stmt = {
    insert: db.prepare(`INSERT INTO users (id, email, password_hash, full_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byKycRef: db.prepare('SELECT * FROM users WHERE kyc_ref = ?'),
    updateProfile: db.prepare(`UPDATE users SET full_name = ?, phone = ?, country = ?, birth_date = ?, address = ?,
      id_type = ?, id_number = ?, updated_at = ? WHERE id = ?`),
    setKyc: db.prepare('UPDATE users SET kyc_status = ?, kyc_ref = COALESCE(?, kyc_ref), kyc_reason = ?, updated_at = ? WHERE id = ?'),
    list: db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT ?'),
    listByKyc: db.prepare('SELECT * FROM users WHERE kyc_status = ? ORDER BY updated_at DESC LIMIT ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    session: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  };

  function checkName(name) {
    const n = String(name || '').trim().replace(/\s+/g, ' ');
    if (n.length < 3 || n.length > 100 || !n.includes(' ')) throw new UserError('Indiquez votre prénom et votre nom, comme sur votre pièce d’identité.');
    return n;
  }

  async function register({ email, password, fullName }) {
    const e = normalizeEmail(email);
    if (!e) throw new UserError('Adresse e-mail invalide');
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
      throw new UserError('Le mot de passe doit contenir au moins 10 caractères.');
    }
    const name = checkName(fullName);
    if (stmt.byEmail.get(e)) throw new UserError('Un compte existe déjà avec cette adresse e-mail.');
    const id = crypto.randomBytes(12).toString('hex');
    const t = now();
    stmt.insert.run(id, e, await hashPassword(password), name, t, t);
    return stmt.byId.get(id);
  }

  async function login({ email, password }) {
    const user = stmt.byEmail.get(normalizeEmail(email) || '');
    // Même message et même coût de calcul que le compte existe ou non.
    const ok = await verifyPassword(String(password || ''), user ? user.password_hash : 'scrypt$00$00')
      .catch(() => false);
    if (!user || !ok) throw new UserError('E-mail ou mot de passe incorrect.');
    return user;
  }

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    stmt.insertSession.run(sha256(token), userId, expires);
    stmt.purgeSessions.run(now());
    return { token, expires };
  }

  function userFromSession(token) {
    if (!token) return null;
    const s = stmt.session.get(sha256(token));
    if (!s || s.expires_at < now()) return null;
    return stmt.byId.get(s.user_id) || null;
  }

  const logout = (token) => token && stmt.deleteSession.run(sha256(token));

  /** Enregistre l'identité puis lance la vérification (prestataire KYC + listes de sanctions). */
  async function submitKyc(userId, input) {
    const user = stmt.byId.get(userId);
    if (!user) throw new UserError('Compte introuvable');
    if (user.kyc_status === 'approved') throw new UserError('Votre identité est déjà vérifiée.');
    if (user.kyc_status === 'pending') throw new UserError('Votre vérification est déjà en cours.');

    const name = checkName(input.fullName);
    const country = String(input.country || '').toUpperCase();
    if (!COUNTRIES.includes(country)) throw new UserError('Pays de résidence non pris en charge.');
    const birth = String(input.birthDate || '');
    const birthTime = Date.parse(birth);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || Number.isNaN(birthTime)) throw new UserError('Date de naissance invalide');
    const age = (Date.now() - birthTime) / (365.25 * 86400_000);
    if (age < 18 || age > 120) throw new UserError('Vous devez avoir au moins 18 ans.');
    const address = String(input.address || '').trim();
    if (address.length < 8 || address.length > 300) throw new UserError('Adresse complète requise.');
    if (!ID_TYPES.includes(input.idType)) throw new UserError('Type de pièce d’identité invalide');
    const idNumber = String(input.idNumber || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{5,20}$/.test(idNumber)) throw new UserError('Numéro de pièce d’identité invalide');
    let phone = null;
    if (input.phone) {
      phone = normalizeAirtelGabon(String(input.phone));
      if (!phone) throw new UserError('Numéro Airtel Gabon invalide (ex. 077 12 34 56)');
    }

    stmt.updateProfile.run(name, phone, country, birth, address, input.idType, idNumber, now(), userId);
    const updated = stmt.byId.get(userId);

    const hit = screening.check({ name, birthDate: birth });
    if (hit) {
      // On ne dit pas au client pourquoi : la conformité examine le dossier.
      logger.warn(`[KYC ${userId}] correspondance liste de sanctions : ${hit.listName}`);
      stmt.setKyc.run('pending', null, `Correspondance liste : ${hit.listName}`, now(), userId);
      return { status: 'pending', url: null };
    }

    const r = await kyc.start(updated);
    stmt.setKyc.run(r.status, r.ref || null, r.reason || null, now(), userId);
    return { status: r.status, url: r.url || null };
  }

  /** Décision du prestataire KYC (webhook) ou de l'équipe conformité. */
  function setKycDecision(userId, status, reason) {
    if (!['approved', 'rejected'].includes(status)) throw new UserError('Décision invalide');
    stmt.setKyc.run(status, null, reason || null, now(), userId);
    return stmt.byId.get(userId);
  }

  function publicProfile(u) {
    return {
      id: u.id,
      email: u.email,
      fullName: u.full_name,
      phone: u.phone,
      country: u.country,
      birthDate: u.birth_date,
      address: u.address,
      idType: u.id_type,
      kycStatus: u.kyc_status,
      kycReason: u.kyc_status === 'rejected' ? u.kyc_reason : null,
    };
  }

  return {
    register,
    login,
    createSession,
    userFromSession,
    logout,
    submitKyc,
    setKycDecision,
    publicProfile,
    find: (id) => stmt.byId.get(id),
    findByKycRef: (ref) => stmt.byKycRef.get(ref),
    list: ({ kyc: k, limit = 200 } = {}) => (k ? stmt.listByKyc.all(k, limit) : stmt.list.all(limit)),
  };
}

module.exports = { createUserService, UserError, hashPassword, verifyPassword, ID_TYPES, COUNTRIES };
