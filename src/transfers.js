'use strict';

const crypto = require('node:crypto');
const { quote } = require('./fees');
const { normalizeAirtelGabon } = require('./phone');
const { normalizeEmail, normalizeIban, maskIban, maskEmail } = require('./validate');

// Cycle de vie :
//   awaiting_payment -> paid -> sending -> completed
//          \-> cancelled             \-> failed -> refunded
//   issue inconnue trop longtemps -> needs_review (vérification manuelle)
const REVIEW_AFTER_MS = 6 * 60 * 60 * 1000;
const PAYMENT_REVIEW_AFTER_MS = 24 * 60 * 60 * 1000;
const COUNTED_STATUSES = "('paid','sending','completed','needs_review')";

class ValidationError extends Error {}

function createTransferService({ db, config, rails, logger = console }) {
  const now = () => new Date().toISOString();

  const stmt = {
    insert: db.prepare(`INSERT INTO transfers
      (id, access_token, status, direction, pay_method, payout_method, send_currency, send_amount, fee, discount,
       total, receive_currency, receive_amount, sender_name, sender_contact, recipient_name, recipient_account,
       created_at, updated_at)
      VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    get: db.prepare('SELECT * FROM transfers WHERE id = ?'),
    byCheckout: db.prepare('SELECT * FROM transfers WHERE checkout_id = ?'),
    setCheckout: db.prepare('UPDATE transfers SET checkout_id = ?, updated_at = ? WHERE id = ?'),
    transition: db.prepare('UPDATE transfers SET status = ?, updated_at = ? WHERE id = ? AND status = ?'),
    setFields: db.prepare(`UPDATE transfers SET
      payment_ref = COALESCE(?, payment_ref), payout_ref = COALESCE(?, payout_ref),
      failure_reason = COALESCE(?, failure_reason), updated_at = ? WHERE id = ?`),
    byStatus: db.prepare('SELECT * FROM transfers WHERE status = ? ORDER BY created_at'),
    previous: db.prepare(`SELECT COUNT(*) AS n FROM transfers WHERE sender_contact = ? AND status IN ${COUNTED_STATUSES}`),
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

  const isFirstTransfer = (senderContact) => stmt.previous.get(senderContact).n === 0;

  function validate(input) {
    const direction = input.direction || 'fr_to_ga';
    const payMethod = input.payMethod || (direction === 'fr_to_ga' ? 'card' : 'airtel');
    const payoutMethod = input.payoutMethod || (direction === 'fr_to_ga' ? 'airtel' : 'sepa');
    if (!rails.isAvailable(direction, payMethod, payoutMethod)) {
      throw new ValidationError('Ce moyen de paiement ou de réception n’est pas disponible.');
    }

    const senderName = String(input.senderName || '').trim();
    const recipientName = String(input.recipientName || '').trim();
    if (senderName.length < 2 || senderName.length > 100) throw new ValidationError('Nom de l’expéditeur invalide');
    if (recipientName.length < 2 || recipientName.length > 100) throw new ValidationError('Nom du bénéficiaire invalide');

    let senderContact, recipientAccount;
    if (direction === 'fr_to_ga') {
      senderContact = normalizeEmail(input.senderEmail);
      if (!senderContact) throw new ValidationError('Adresse e-mail invalide');
      recipientAccount = normalizeAirtelGabon(String(input.recipientPhone || ''));
      if (!recipientAccount) throw new ValidationError('Numéro Airtel Gabon du bénéficiaire invalide (ex. 077 12 34 56)');
    } else {
      senderContact = normalizeAirtelGabon(String(input.senderPhone || ''));
      if (!senderContact) throw new ValidationError('Votre numéro Airtel Money est invalide (ex. 077 12 34 56)');
      if (payoutMethod === 'sepa') {
        recipientAccount = normalizeIban(input.recipientIban);
        if (!recipientAccount) throw new ValidationError('IBAN invalide : vérifiez les chiffres (ex. FR76 …)');
      } else {
        recipientAccount = normalizeEmail(input.recipientEmail);
        if (!recipientAccount) throw new ValidationError('Adresse e-mail PayPal du bénéficiaire invalide');
      }
    }

    const q = quote({
      direction,
      amount: input.amount,
      payMethod,
      payoutMethod,
      firstTransfer: isFirstTransfer(senderContact),
    }, config);
    return { q, direction, payMethod, payoutMethod, senderName, senderContact, recipientName, recipientAccount };
  }

  async function create(input) {
    const v = validate(input);
    const id = crypto.randomBytes(10).toString('hex');
    const accessToken = crypto.randomBytes(16).toString('hex');
    const t = now();
    stmt.insert.run(id, accessToken, v.direction, v.payMethod, v.payoutMethod, v.q.sendCurrency, v.q.sendAmount,
      v.q.fee, v.q.discount, v.q.total, v.q.receiveCurrency, v.q.receiveAmount, v.senderName, v.senderContact,
      v.recipientName, v.recipientAccount, t, t);
    log(id, 'created', { total: v.q.total, currency: v.q.sendCurrency });

    try {
      const checkout = await rails.payIn[v.payMethod].start(stmt.get.get(id));
      stmt.setCheckout.run(checkout.checkoutId, now(), id);
      return { id, accessToken, checkoutUrl: checkout.url, quote: v.q };
    } catch (err) {
      transition(id, 'awaiting_payment', 'cancelled', { message: err.message });
      throw err;
    }
  }

  /** Appelé quand l'encaissement est confirmé (webhook Stripe ou statut Airtel). Idempotent. */
  async function onPaymentConfirmed({ transferId, checkoutId, paymentRef, amountCents }) {
    const tr = transferId && stmt.get.get(transferId);
    if (!tr) throw new ValidationError('Transfert inconnu');
    if (checkoutId && tr.checkout_id !== checkoutId) throw new ValidationError('Session de paiement incohérente');
    if (amountCents !== undefined && amountCents !== Math.round(tr.total * 100)) {
      logger.error(`[transfert ${tr.id}] montant payé ${amountCents} ≠ attendu ${tr.total}`);
      log(tr.id, 'amount_mismatch', { amountCents });
      return stmt.get.get(tr.id);
    }
    if (!transition(tr.id, 'awaiting_payment', 'paid', { paymentRef })) return stmt.get.get(tr.id);
    stmt.setFields.run(paymentRef || null, null, null, now(), tr.id);
    await sendPayout(tr.id);
    return stmt.get.get(tr.id);
  }

  async function sendPayout(id) {
    if (!transition(id, 'paid', 'sending')) return;
    const tr = stmt.get.get(id);
    const rail = rails.payOut[tr.payout_method];
    try {
      const res = await rail.send(tr);
      stmt.setFields.run(null, res.providerRef || null, null, now(), id);
      if (res.status === 'pending') {
        // Les versements PayPal et SEPA sont asynchrones : un premier contrôle tout de suite, puis la réconciliation.
        await applyPayoutStatus(id, await rail.check(stmt.get.get(id)));
      } else {
        await applyPayoutStatus(id, res);
      }
    } catch (err) {
      // Erreur réseau ou réponse ambiguë : l'argent a peut-être été envoyé.
      // On ne rembourse pas à l'aveugle, la réconciliation interrogera le prestataire.
      if (err.status && err.status >= 400 && err.status < 500) {
        await fail(id, `Refusé par le prestataire (HTTP ${err.status})`);
      } else {
        logger.error(`[transfert ${id}] versement incertain : ${err.message}`);
        log(id, 'payout_error', { message: err.message });
      }
    }
  }

  async function applyPayoutStatus(id, res) {
    if (res.status === 'success') {
      transition(id, 'sending', 'completed', { providerRef: res.providerRef });
    } else if (res.status === 'failed') {
      await fail(id, res.message || 'Échec du versement');
    }
  }

  async function fail(id, reason) {
    if (!transition(id, 'sending', 'failed', { reason })) return;
    stmt.setFields.run(null, null, reason, now(), id);
    const tr = stmt.get.get(id);
    if (!tr.payment_ref) return;
    try {
      await rails.payIn[tr.pay_method].refund(tr);
      transition(id, 'failed', 'refunded');
    } catch (err) {
      logger.error(`[transfert ${id}] remboursement impossible : ${err.message}`);
      log(id, 'refund_error', { message: err.message });
    }
  }

  /** Vérifie un encaissement Airtel en attente (le client valide avec son code PIN). */
  async function checkPayment(tr) {
    const rail = rails.payIn[tr.pay_method];
    if (!rail.check) return;
    const res = await rail.check(tr);
    if (res.status === 'success') {
      await onPaymentConfirmed({ transferId: tr.id, paymentRef: res.providerRef });
    } else if (res.status === 'failed') {
      if (transition(tr.id, 'awaiting_payment', 'cancelled', { message: res.message })) {
        stmt.setFields.run(null, null, res.message || 'Paiement non validé', now(), tr.id);
      }
    } else if (Date.now() - Date.parse(tr.created_at) > PAYMENT_REVIEW_AFTER_MS) {
      transition(tr.id, 'awaiting_payment', 'needs_review');
    }
  }

  async function reconcileOne(tr) {
    if (tr.status === 'awaiting_payment') return checkPayment(tr);
    if (tr.status === 'paid') return sendPayout(tr.id);
    if (tr.status !== 'sending') return;
    const res = await rails.payOut[tr.payout_method].check(tr);
    if (res.status === 'pending' && Date.now() - Date.parse(tr.updated_at) > REVIEW_AFTER_MS) {
      transition(tr.id, 'sending', 'needs_review');
      return;
    }
    await applyPayoutStatus(tr.id, res);
  }

  /** Fait avancer tous les transferts dont l'issue n'est pas encore connue. */
  async function reconcile() {
    for (const status of ['awaiting_payment', 'paid', 'sending']) {
      for (const tr of stmt.byStatus.all(status)) {
        try {
          await reconcileOne(tr);
        } catch (err) {
          logger.error(`[transfert ${tr.id}] réconciliation : ${err.message}`);
        }
      }
    }
  }

  function getPublic(id, accessToken) {
    const tr = stmt.get.get(id);
    if (!tr || !accessToken) return null;
    const a = Buffer.from(tr.access_token);
    const b = Buffer.from(String(accessToken));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let account = tr.recipient_account;
    if (tr.payout_method === 'airtel') account = `${account.slice(0, 3)} •• •• ${account.slice(7)}`;
    if (tr.payout_method === 'sepa') account = maskIban(account);
    if (tr.payout_method === 'paypal') account = maskEmail(account);
    return {
      id: tr.id,
      status: tr.status,
      direction: tr.direction,
      payMethod: tr.pay_method,
      payoutMethod: tr.payout_method,
      sendCurrency: tr.send_currency,
      sendAmount: tr.send_amount,
      fee: tr.fee,
      discount: tr.discount,
      total: tr.total,
      receiveCurrency: tr.receive_currency,
      receiveAmount: tr.receive_amount,
      recipientName: tr.recipient_name,
      recipientAccount: account,
      payoutRef: tr.status === 'completed' ? tr.payout_ref : null,
      failureReason: ['failed', 'refunded', 'cancelled'].includes(tr.status) ? tr.failure_reason : null,
      createdAt: tr.created_at,
      updatedAt: tr.updated_at,
    };
  }

  return {
    create,
    onPaymentConfirmed,
    reconcile,
    reconcileOne: (id) => {
      const tr = stmt.get.get(id);
      return tr ? reconcileOne(tr) : undefined;
    },
    getPublic,
    isFirstTransfer,
    findByCheckout: (checkoutId) => stmt.byCheckout.get(checkoutId),
    find: (id) => stmt.get.get(id),
    recent: (limit = 100) => stmt.recent.all(limit),
  };
}

module.exports = { createTransferService, ValidationError };
