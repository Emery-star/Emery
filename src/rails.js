'use strict';

/**
 * Moyens de paiement (entrée de l'argent) et de versement (sortie) branchés sur les prestataires.
 * Chaque moyen présente la même interface au service des transferts :
 *   payIn  : start(tr) -> { checkoutId, url }, check(tr) -> { status, providerRef } (facultatif), refund(tr)
 *   payOut : send(tr) -> { status, providerRef, message }, check(tr) -> { status, providerRef, message }
 * Les identifiants envoyés à Airtel sont préfixés : C = encaissement, D = décaissement.
 */
function createRails({ config, airtel, payments, paypal, sepa }) {
  const live = config.mode === 'live';

  const stripeIn = {
    start: (tr) => payments.createCheckout(tr),
    refund: (tr) => payments.refund(tr.payment_ref),
  };

  const payIn = {
    card: { ...stripeIn, available: !live || config.stripe.enabled },
    paypal: { ...stripeIn, available: !live || (config.stripe.enabled && config.stripe.paypalEnabled) },
    airtel: {
      available: !live || config.airtel.enabled,
      async start(tr) {
        const r = await airtel.collect({
          id: `C${tr.id}`,
          msisdn: tr.sender_contact,
          amountXaf: tr.total,
          reference: `Envoi ${tr.id.slice(0, 8)}`,
        });
        if (r.status === 'failed') throw new Error(r.message || 'Demande de paiement Airtel refusée');
        return { checkoutId: `C${tr.id}`, url: null };
      },
      check: (tr) => airtel.collectionStatus(`C${tr.id}`),
      refund: (tr) => airtel.refundCollection(tr.payment_ref),
    },
  };

  const payOut = {
    airtel: {
      available: !live || config.airtel.enabled,
      send: (tr) => airtel.disburse({
        id: `D${tr.id}`,
        msisdn: tr.recipient_account,
        amountXaf: tr.receive_amount,
        reference: `Envoi ${tr.id.slice(0, 8)}`,
      }),
      check: (tr) => airtel.status(`D${tr.id}`),
    },
    paypal: {
      available: !live || config.paypal.enabled,
      send: (tr) => paypal.payout({
        id: `D${tr.id}`,
        email: tr.recipient_account,
        amountEur: tr.receive_amount,
        note: `De la part de ${tr.sender_name}`,
      }),
      check: (tr) => paypal.status(tr.payout_ref),
    },
    sepa: {
      available: !live || Boolean(config.sepa.enabled && sepa),
      send: (tr) => sepa.transfer({
        id: `D${tr.id}`,
        iban: tr.recipient_account,
        name: tr.recipient_name,
        amountEur: tr.receive_amount,
        label: `Envoi Gabon ${tr.id.slice(0, 8)}`,
      }),
      check: (tr) => sepa.status(tr.payout_ref),
    },
  };

  // Moyens proposés par sens d'envoi. Wero est affiché mais pas encore branché.
  const catalog = {
    fr_to_ga: {
      pay: [
        { id: 'card', label: 'Carte bancaire' },
        { id: 'paypal', label: 'PayPal', surcharge: true },
        { id: 'wero', label: 'Wero', soon: true },
      ],
      payout: [{ id: 'airtel', label: 'Airtel Money' }],
    },
    ga_to_fr: {
      pay: [{ id: 'airtel', label: 'Airtel Money' }],
      payout: [
        { id: 'sepa', label: 'Compte bancaire (IBAN)' },
        { id: 'paypal', label: 'PayPal', surcharge: true },
        { id: 'wero', label: 'Wero', soon: true },
      ],
    },
  };

  function methods() {
    const mark = (list, rail) => list.map((m) => ({ ...m, available: !m.soon && Boolean(rail[m.id] && rail[m.id].available) }));
    return Object.fromEntries(Object.entries(catalog).map(([dir, c]) => [dir, { pay: mark(c.pay, payIn), payout: mark(c.payout, payOut) }]));
  }

  function isAvailable(direction, payMethod, payoutMethod) {
    const m = methods()[direction];
    return Boolean(m && m.pay.some((x) => x.id === payMethod && x.available) && m.payout.some((x) => x.id === payoutMethod && x.available));
  }

  return { payIn, payOut, methods, isAvailable };
}

module.exports = { createRails };
