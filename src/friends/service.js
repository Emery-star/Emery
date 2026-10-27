'use strict';

const crypto = require('node:crypto');
const { quote } = require('../fees');
const { normalizeAirtelGabon, formatGabon } = require('../phone');
const { normalizeEmail, normalizeIban } = require('../validate');

// Cycle de vie d'une demande entre amis :
//   awaiting_payment -> declared (l'ami dit avoir payé) -> paid (l'organisateur a reçu) -> completed (envoyé)
//   awaiting_payment / declared -> cancelled          paid -> refunded (remboursé à la main)
const EXPIRE_AFTER_MS = 48 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O ni 1/I, faciles à confondre

class FriendsError extends Error {}

function normalizeFrenchPhone(input) {
  let d = String(input || '').replace(/[\s.\-()]/g, '');
  if (d.startsWith('+33')) d = '0' + d.slice(3);
  if (d.startsWith('0033')) d = '0' + d.slice(4);
  return /^0[67]\d{8}$/.test(d) ? d : null;
}

/** Identifiant Wero : numéro de mobile français ou adresse e-mail. */
function normalizeWero(input) {
  return normalizeFrenchPhone(input) || normalizeEmail(input);
}

function createFriendsService({ db, config, alerts, logger = console }) {
  const op = config.operator;
  const now = () => new Date().toISOString();

  db.exec(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id                TEXT PRIMARY KEY,
      code              TEXT NOT NULL UNIQUE,
      access_token      TEXT NOT NULL,
      status            TEXT NOT NULL,
      direction         TEXT NOT NULL,
      pay_method        TEXT NOT NULL,
      payout_method     TEXT NOT NULL,
      send_currency     TEXT NOT NULL,
      send_amount       REAL NOT NULL,
      fee               REAL NOT NULL,
      discount          REAL NOT NULL,
      total             REAL NOT NULL,
      receive_currency  TEXT NOT NULL,
      receive_amount    REAL NOT NULL,
      sender_name       TEXT NOT NULL,
      sender_contact    TEXT NOT NULL,
      recipient_name    TEXT NOT NULL,
      recipient_account TEXT NOT NULL,
      payer_ref         TEXT,
      payout_ref        TEXT,
      note              TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_friend_status ON friend_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_friend_sender ON friend_requests(sender_contact);
  `);

  const stmt = {
    insert: db.prepare(`INSERT INTO friend_requests
      (id, code, access_token, status, direction, pay_method, payout_method, send_currency, send_amount, fee, discount,
       total, receive_currency, receive_amount, sender_name, sender_contact, recipient_name, recipient_account,
       created_at, updated_at)
      VALUES (?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    get: db.prepare('SELECT * FROM friend_requests WHERE id = ?'),
    byCode: db.prepare('SELECT id FROM friend_requests WHERE code = ?'),
    transition: db.prepare(`UPDATE friend_requests SET status = ?, updated_at = ?,
      payer_ref = COALESCE(?, payer_ref), payout_ref = COALESCE(?, payout_ref), note = COALESCE(?, note)
      WHERE id = ? AND status = ?`),
    completedBy: db.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE sender_contact = ? AND status IN ('paid','completed')"),
    list: db.prepare('SELECT * FROM friend_requests ORDER BY created_at DESC LIMIT ?'),
    listByStatus: db.prepare('SELECT * FROM friend_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?'),
    expired: db.prepare("SELECT id FROM friend_requests WHERE status = 'awaiting_payment' AND created_at < ?"),
  };

  /** Moyens proposés, selon les comptes que l'organisateur a renseignés. */
  function methods() {
    const fr = [
      { id: 'paypal', label: 'PayPal', available: Boolean(op.paypalEmail), surcharge: true },
      { id: 'wero', label: 'Wero', available: Boolean(op.wero) },
      { id: 'virement', label: 'Virement bancaire', available: Boolean(op.iban) },
    ];
    const toFr = [
      { id: 'paypal', label: 'PayPal', available: Boolean(op.paypalEmail), surcharge: true },
      { id: 'wero', label: 'Wero', available: Boolean(op.wero) },
      { id: 'sepa', label: 'Compte bancaire (IBAN)', available: true },
    ];
    const airtelOk = Boolean(normalizeAirtelGabon(op.airtel));
    return {
      fr_to_ga: { pay: fr, payout: [{ id: 'airtel', label: 'Airtel Money', available: airtelOk }] },
      ga_to_fr: { pay: [{ id: 'airtel', label: 'Airtel Money', available: airtelOk }], payout: toFr },
    };
  }

  function isAvailable(direction, pay, payout) {
    const m = methods()[direction];
    return Boolean(m && m.pay.some((x) => x.id === pay && x.available) && m.payout.some((x) => x.id === payout && x.available));
  }

  function newCode() {
    for (;;) {
      const bytes = crypto.randomBytes(5);
      const code = 'EG-' + [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      if (!stmt.byCode.get(code)) return code;
    }
  }

  function create(input) {
    const direction = input.direction === 'ga_to_fr' ? 'ga_to_fr' : 'fr_to_ga';
    const payMethod = String(input.payMethod || '');
    const payoutMethod = String(input.payoutMethod || '');
    if (!isAvailable(direction, payMethod, payoutMethod)) throw new FriendsError('Ce moyen de paiement ou de réception n’est pas proposé.');

    const clean = (v) => String(v || '').trim().replace(/\s+/g, ' ');
    const senderName = clean(input.senderName);
    const recipientName = clean(input.recipientName);
    if (senderName.length < 3 || senderName.length > 100) throw new FriendsError('Indiquez votre prénom et votre nom.');
    if (recipientName.length < 3 || recipientName.length > 100) throw new FriendsError('Indiquez le prénom et le nom du bénéficiaire.');

    // Contact de l'expéditeur : pour qu'on puisse le joindre (WhatsApp, téléphone ou e-mail).
    const contactRaw = clean(input.senderContact);
    const senderContact = normalizeEmail(contactRaw) || normalizeAirtelGabon(contactRaw) || normalizeFrenchPhone(contactRaw)
      || (/^\+?\d[\d ]{7,17}$/.test(contactRaw) ? contactRaw.replace(/\s/g, '') : null);
    if (!senderContact) throw new FriendsError('Indiquez un numéro de téléphone ou un e-mail pour vous joindre.');

    let recipientAccount;
    if (payoutMethod === 'airtel') {
      recipientAccount = normalizeAirtelGabon(String(input.recipientAccount || ''));
      if (!recipientAccount) throw new FriendsError('Numéro Airtel Gabon du bénéficiaire invalide (ex. 077 12 34 56).');
    } else if (payoutMethod === 'paypal') {
      recipientAccount = normalizeEmail(input.recipientAccount);
      if (!recipientAccount) throw new FriendsError('Adresse e-mail PayPal du bénéficiaire invalide.');
    } else if (payoutMethod === 'wero') {
      recipientAccount = normalizeWero(input.recipientAccount);
      if (!recipientAccount) throw new FriendsError('Pour Wero, indiquez un mobile français (06/07…) ou un e-mail.');
    } else {
      recipientAccount = normalizeIban(input.recipientAccount);
      if (!recipientAccount) throw new FriendsError('IBAN invalide : vérifiez les chiffres (ex. FR76 …).');
    }

    const q = quote({
      direction,
      amount: input.amount,
      payMethod,
      payoutMethod,
      firstTransfer: stmt.completedBy.get(senderContact).n === 0,
    }, config);

    const id = crypto.randomBytes(10).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const code = newCode();
    const t = now();
    stmt.insert.run(id, code, token, direction, payMethod, payoutMethod, q.sendCurrency, q.sendAmount, q.fee, q.discount,
      q.total, q.receiveCurrency, q.receiveAmount, senderName, senderContact, recipientName, recipientAccount, t, t);
    return { id, code, accessToken: token, quote: q };
  }

  function move(id, from, to, { payerRef, payoutRef, note } = {}) {
    const list = Array.isArray(from) ? from : [from];
    for (const f of list) {
      if (stmt.transition.run(to, now(), payerRef || null, payoutRef || null, note || null, id, f).changes === 1) return true;
    }
    return false;
  }

  function checkToken(id, token) {
    const r = stmt.get.get(id);
    if (!r || !token) return null;
    const a = Buffer.from(r.access_token);
    const b = Buffer.from(String(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? r : null;
  }

  // --- Actions de l'ami ---

  async function declarePaid(id, token, payerRef) {
    const r = checkToken(id, token);
    if (!r) throw new FriendsError('Demande introuvable');
    const ref = String(payerRef || '').trim().slice(0, 60) || null;
    if (!move(id, 'awaiting_payment', 'declared', { payerRef: ref })) throw new FriendsError('Cette demande n’attend plus de paiement.');
    const fresh = stmt.get.get(id);
    await alerts.send({
      title: `Paiement annoncé ${fresh.code}`,
      text: [
        `${fresh.sender_name} dit avoir payé ${money(fresh.total, fresh.send_currency)} par ${PAY_LABEL[fresh.pay_method]}${ref ? ` (réf. ${ref})` : ''}.`,
        `À envoyer : ${money(fresh.receive_amount, fresh.receive_currency)} à ${fresh.recipient_name} sur ${PAYOUT_LABEL[fresh.payout_method]} ${displayAccount(fresh)}.`,
      ].join('\n'),
      url: `${config.publicUrl}/admin.html`,
    });
    return fresh;
  }

  function cancelByFriend(id, token) {
    if (!checkToken(id, token)) throw new FriendsError('Demande introuvable');
    if (!move(id, 'awaiting_payment', 'cancelled', { note: 'Annulée par l’expéditeur' })) {
      throw new FriendsError('Paiement déjà annoncé : contactez l’organisateur pour annuler.');
    }
    return stmt.get.get(id);
  }

  // --- Actions de l'organisateur ---

  function operatorAction(id, action, { ref, note } = {}) {
    const r = stmt.get.get(id);
    if (!r) throw new FriendsError('Demande introuvable');
    const cleanRef = String(ref || '').trim().slice(0, 80) || null;
    const cleanNote = String(note || '').trim().slice(0, 200) || null;
    const ok = {
      received: () => move(id, ['awaiting_payment', 'declared'], 'paid', { note: cleanNote }),
      sent: () => move(id, 'paid', 'completed', { payoutRef: cleanRef, note: cleanNote }),
      cancel: () => move(id, ['awaiting_payment', 'declared'], 'cancelled', { note: cleanNote || 'Paiement non reçu' }),
      refunded: () => move(id, 'paid', 'refunded', { note: cleanNote || 'Remboursé' }),
    }[action];
    if (!ok) throw new FriendsError('Action inconnue');
    if (!ok()) throw new FriendsError(`Action impossible : la demande est « ${r.status} ».`);
    return stmt.get.get(id);
  }

  /** Annule les demandes jamais payées après 48 h. */
  function expire() {
    for (const { id } of stmt.expired.all(new Date(Date.now() - EXPIRE_AFTER_MS).toISOString())) {
      move(id, 'awaiting_payment', 'cancelled', { note: 'Expirée : aucun paiement sous 48 h' });
    }
  }

  // --- Affichage ---

  /** Où et comment l'ami doit payer l'organisateur. */
  function paymentInstructions(r) {
    const amount = money(r.total, r.send_currency);
    if (r.pay_method === 'airtel') {
      return { method: 'Airtel Money', to: formatGabon(normalizeAirtelGabon(op.airtel)), name: op.name, amount, steps: [
        `Envoyez ${amount} par Airtel Money au ${formatGabon(normalizeAirtelGabon(op.airtel))}${op.name ? ` (${op.name})` : ''}.`,
        'Gardez le SMS de confirmation Airtel : vous pourrez indiquer sa référence.',
      ] };
    }
    if (r.pay_method === 'paypal') {
      const link = op.paypalMe ? `https://paypal.me/${encodeURIComponent(op.paypalMe)}/${r.total.toFixed(2)}EUR` : null;
      return { method: 'PayPal', to: op.paypalEmail, name: op.name, amount, link, steps: [
        `Envoyez ${amount} sur PayPal à ${op.paypalEmail}${link ? ' (ou utilisez le lien ci-dessous)' : ''}.`,
        `Indiquez le code ${r.code} dans le message.`,
      ] };
    }
    if (r.pay_method === 'wero') {
      return { method: 'Wero', to: op.wero, name: op.name, amount, steps: [
        `Dans l’appli de votre banque, ouvrez Wero et envoyez ${amount} à ${op.wero}${op.name ? ` (${op.name})` : ''}.`,
        `Indiquez le code ${r.code} dans le motif.`,
      ] };
    }
    return { method: 'Virement bancaire', to: op.iban.replace(/(.{4})/g, '$1 ').trim(), name: op.name, amount, steps: [
      `Faites un virement de ${amount} sur l’IBAN ${op.iban.replace(/(.{4})/g, '$1 ').trim()}${op.name ? ` au nom de ${op.name}` : ''}.`,
      `Indiquez le code ${r.code} comme motif. Un virement instantané arrive en quelques secondes.`,
    ] };
  }

  function forFriend(id, token) {
    const r = checkToken(id, token);
    if (!r) return null;
    return {
      id: r.id,
      code: r.code,
      status: r.status,
      direction: r.direction,
      payMethod: r.pay_method,
      payoutMethod: r.payout_method,
      sendCurrency: r.send_currency,
      sendAmount: r.send_amount,
      fee: r.fee,
      discount: r.discount,
      total: r.total,
      receiveCurrency: r.receive_currency,
      receiveAmount: r.receive_amount,
      recipientName: r.recipient_name,
      recipientAccount: displayAccount(r, true),
      payoutRef: r.status === 'completed' ? r.payout_ref : null,
      note: ['cancelled', 'refunded'].includes(r.status) ? r.note : null,
      instructions: ['awaiting_payment', 'declared'].includes(r.status) ? paymentInstructions(r) : null,
      operatorWhatsapp: op.whatsapp || null,
      createdAt: r.created_at,
    };
  }

  return {
    methods,
    create,
    declarePaid,
    cancelByFriend,
    operatorAction,
    expire,
    forFriend,
    list: ({ status, limit = 200 } = {}) => (status ? stmt.listByStatus.all(status, limit) : stmt.list.all(limit)),
    find: (id) => stmt.get.get(id),
  };
}

const PAY_LABEL = { airtel: 'Airtel Money', paypal: 'PayPal', wero: 'Wero', virement: 'virement' };
const PAYOUT_LABEL = { airtel: 'Airtel Money', paypal: 'PayPal', wero: 'Wero', sepa: 'IBAN' };

function money(n, cur) {
  return cur === 'EUR' ? n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }) : `${n.toLocaleString('fr-FR')} FCFA`;
}

/** Compte du bénéficiaire, complet pour l'organisateur, masqué sur la page publique de suivi. */
function displayAccount(r, masked = false) {
  const a = r.recipient_account;
  if (r.payout_method === 'airtel') return masked ? `${a.slice(0, 3)} •• •• ${a.slice(7)}` : formatGabon(a);
  if (r.payout_method === 'sepa') return masked ? `${a.slice(0, 4)} •••• ${a.slice(-4)}` : a.replace(/(.{4})/g, '$1 ').trim();
  if (masked && a.includes('@')) return `${a.slice(0, 2)}•••@${a.split('@')[1]}`;
  if (masked) return `${a.slice(0, 2)} •• •• ${a.slice(-2)}`;
  return a;
}

module.exports = { createFriendsService, FriendsError, normalizeWero, normalizeFrenchPhone, displayAccount, PAY_LABEL, PAYOUT_LABEL };
