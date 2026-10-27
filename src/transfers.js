'use strict';

const crypto = require('node:crypto');
const { quote } = require('./fees');
const { normalizeAirtelGabon } = require('./phone');

// Cycle de vie :
//   awaiting_payment -> paid -> sending -> completed
//                                      \-> failed -> refunded
//   sending trop longtemps sans réponse claire -> needs_review (vérification manuelle)
const REVIEW_AFTER_MS = 6 * 60 * 60 * 1000;

class ValidationError extends Error {}

function createTransferService({ db, config, airtel, payments, logger = console }) {
  const now = () => new Date().toISOString();

  const stmt = {
    insert: db.prepare(`INSERT INTO transfers
      (id, access_token, status, amount_eur, fee_eur, total_eur, received_xaf, sender_name, sender_email,
       recipient_name, recipient_msisdn, created_at, updated_at)
      VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    get: db.prepare('SELECT * FROM transfers WHERE id = ?'),
    setCheckout: db.prepare('UPDATE transfers SET checkout_id = ?, updated_at = ? WHERE id = ?'),
    transition: db.prepare('UPDATE transfers SET status = ?, updated_at = ? WHERE id = ? AND status = ?'),
    setFields: db.prepare(`UPDATE transfers SET
      payment_ref = COALESCE(?, payment_ref), airtel_ref = COALESCE(?, airtel_ref),
      failure_reason = COALESCE(?, failure_reason), updated_at = ? WHERE id = ?`),
    byStatus: db.prepare('SELECT * FROM transfers WHERE status = ? ORDER BY created_at'),
    recent: db.prepare('SELECT * FROM transfers ORDER BY created_at DESC LIMIT ?'),
    event: db.prepare('INSERT INTO events (transfer_id, type, detail, created_at) VALUES (?, ?, ?, ?)'),
  };

  function log(id, type, detail) {
    stmt.event.run(id, type, detail ? JSON.stringify(detail) : null, now());
  }

  /** Passage d'état atomique : renvoie false si un autre traitement est déjà passé par là. */
  function transition(id, from, to, detail) {
    const ok = stmt.transition.run(to, now(), id, from).changes === 1;
    if (ok) log(id, to, detail);
    return ok;
  }

  function validate(input) {
    const q = quote(input.amountEur, config);
    const senderName = String(input.senderName || '').trim();
    const senderEmail = String(input.senderEmail || '').trim().toLowerCase();
    const recipientName = String(input.recipientName || '').trim();
    const msisdn = normalizeAirtelGabon(String(input.recipientPhone || ''));
    if (senderName.length < 2 || senderName.length > 100) throw new ValidationError('Nom de l’expéditeur invalide');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail) || senderEmail.length > 200) {
      throw new ValidationError('Adresse e-mail invalide');
    }
    if (recipientName.length < 2 || recipientName.length > 100) throw new ValidationError('Nom du bénéficiaire invalide');
    if (!msisdn) throw new ValidationError('Numéro Airtel Gabon invalide (ex. 077 12 34 56)');
    return { q, senderName, senderEmail, recipientName, msisdn };
  }

  async function create(input) {
    const v = validate(input);
    const id = crypto.randomUUID();
    const accessToken = crypto.randomBytes(16).toString('hex');
    const t = now();
    stmt.insert.run(id, accessToken, v.q.amountEur, v.q.feeEur, v.q.totalEur, v.q.receivedXaf,
      v.senderName, v.senderEmail, v.recipientName, v.msisdn, t, t);
    log(id, 'created', { amountEur: v.q.amountEur });

    const transfer = stmt.get.get(id);
    const checkout = await payments.createCheckout(transfer);
    stmt.setCheckout.run(checkout.checkoutId, now(), id);
    return { id, accessToken, checkoutUrl: checkout.url, quote: v.q };
  }

  /** Appelé quand le prestataire de paiement confirme l'encaissement. Idempotent. */
  async function onPaymentConfirmed({ transferId, checkoutId, paymentRef, amountCents }) {
    const tr = transferId && stmt.get.get(transferId);
    if (!tr) throw new ValidationError('Transfert inconnu');
    if (checkoutId && tr.checkout_id !== checkoutId) throw new ValidationError('Session de paiement incohérente');
    if (amountCents !== undefined && amountCents !== Math.round(tr.total_eur * 100)) {
      logger.error(`[transfert ${tr.id}] montant payé ${amountCents} ≠ attendu ${tr.total_eur}`);
      log(tr.id, 'amount_mismatch', { amountCents });
      return stmt.get.get(tr.id);
    }
    if (!transition(tr.id, 'awaiting_payment', 'paid', { paymentRef })) return stmt.get.get(tr.id);
    stmt.setFields.run(paymentRef || null, null, null, now(), tr.id);
    await sendToAirtel(tr.id);
    return stmt.get.get(tr.id);
  }

  async function sendToAirtel(id) {
    if (!transition(id, 'paid', 'sending')) return;
    const tr = stmt.get.get(id);
    try {
      const res = await airtel.disburse({
        id: tr.id,
        msisdn: tr.recipient_msisdn,
        amountXaf: tr.received_xaf,
        reference: `Envoi ${tr.id.slice(0, 8)}`,
      });
      stmt.setFields.run(null, res.providerRef, null, now(), id);
      await applyAirtelStatus(id, res);
    } catch (err) {
      // Erreur réseau ou réponse ambiguë : l'argent a peut-être été envoyé.
      // On ne rembourse pas à l'aveugle, la réconciliation interrogera Airtel.
      if (err.status && err.status >= 400 && err.status < 500) {
        await fail(id, `Refusé par Airtel (HTTP ${err.status})`);
      } else {
        logger.error(`[transfert ${id}] envoi Airtel incertain : ${err.message}`);
        log(id, 'airtel_error', { message: err.message });
      }
    }
  }

  async function applyAirtelStatus(id, res) {
    if (res.status === 'success') {
      transition(id, 'sending', 'completed', { providerRef: res.providerRef });
    } else if (res.status === 'failed') {
      await fail(id, res.message || 'Échec du dépôt Airtel Money');
    }
  }

  async function fail(id, reason) {
    if (!transition(id, 'sending', 'failed', { reason })) return;
    stmt.setFields.run(null, null, reason, now(), id);
    const tr = stmt.get.get(id);
    if (!tr.payment_ref) return;
    try {
      await payments.refund(tr.payment_ref);
      transition(id, 'failed', 'refunded');
    } catch (err) {
      logger.error(`[transfert ${id}] remboursement impossible : ${err.message}`);
      log(id, 'refund_error', { message: err.message });
    }
  }

  /** Interroge Airtel pour les transferts dont l'issue n'est pas encore connue. */
  async function reconcile() {
    for (const tr of stmt.byStatus.all('sending')) {
      try {
        const res = await airtel.status(tr.id);
        if (res.status === 'pending' && Date.now() - Date.parse(tr.updated_at) > REVIEW_AFTER_MS) {
          transition(tr.id, 'sending', 'needs_review');
          continue;
        }
        await applyAirtelStatus(tr.id, res);
      } catch (err) {
        logger.error(`[transfert ${tr.id}] réconciliation : ${err.message}`);
      }
    }
    // Rejoue les transferts payés dont l'envoi n'a pas démarré (ex. redémarrage du serveur).
    for (const tr of stmt.byStatus.all('paid')) await sendToAirtel(tr.id);
  }

  function getPublic(id, accessToken) {
    const tr = stmt.get.get(id);
    if (!tr || !accessToken) return null;
    const a = Buffer.from(tr.access_token);
    const b = Buffer.from(String(accessToken));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return {
      id: tr.id,
      status: tr.status,
      amountEur: tr.amount_eur,
      feeEur: tr.fee_eur,
      totalEur: tr.total_eur,
      receivedXaf: tr.received_xaf,
      recipientName: tr.recipient_name,
      recipientPhone: `${tr.recipient_msisdn.slice(0, 3)} •• •• ${tr.recipient_msisdn.slice(7)}`,
      airtelRef: tr.status === 'completed' ? tr.airtel_ref : null,
      createdAt: tr.created_at,
      updatedAt: tr.updated_at,
    };
  }

  return {
    create,
    onPaymentConfirmed,
    reconcile,
    getPublic,
    findByCheckout: (checkoutId) => db.prepare('SELECT * FROM transfers WHERE checkout_id = ?').get(checkoutId),
    recent: (limit = 100) => stmt.recent.all(limit),
  };
}

module.exports = { createTransferService, ValidationError };
