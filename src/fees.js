'use strict';

const round2 = (n) => Math.round(n * 100) / 100;
const floor2 = (n) => Math.floor(n * 100 + 1e-6) / 100;

const DIRECTIONS = ['fr_to_ga', 'ga_to_fr'];

class QuoteError extends Error {}

/** Frais en euros pour un montant (équivalent euros) donné. */
function feeEur(amountEur, fees, surchargePercent = 0) {
  const base = amountEur <= fees.smallLimitEur ? fees.smallFeeEur : fees.fixedEur + (amountEur * fees.percent) / 100;
  return round2(base + (amountEur * surchargePercent) / 100);
}

/**
 * Calcule un devis.
 * - fr_to_ga : `amount` en euros envoyés, le bénéficiaire reçoit des FCFA sur Airtel Money.
 * - ga_to_fr : `amount` en FCFA envoyés depuis Airtel Money, le bénéficiaire reçoit des euros.
 * Les frais s'ajoutent au montant envoyé, dans la devise de l'expéditeur.
 */
function quote({ direction = 'fr_to_ga', amount, payMethod, payoutMethod, firstTransfer = false }, config) {
  if (!DIRECTIONS.includes(direction)) throw new QuoteError('Sens d’envoi inconnu');
  const raw = Number(amount);
  if (amount === '' || amount === null || !Number.isFinite(raw)) throw new QuoteError('Montant invalide');

  const rate = config.eurToXaf;
  const f = config.fees;
  const usesPaypal = payMethod === 'paypal' || payoutMethod === 'paypal';
  const surcharge = usesPaypal ? f.paypalSurchargePercent : 0;
  const toSend = direction === 'fr_to_ga' ? (eur) => eur : (eur) => Math.ceil(eur * rate);

  let sendAmount, amountEur, receiveAmount;
  if (direction === 'fr_to_ga') {
    sendAmount = round2(raw);
    amountEur = sendAmount;
    // Airtel Money ne gère pas les centimes de FCFA : arrondi à l'unité inférieure.
    receiveAmount = Math.floor(amountEur * rate);
  } else {
    sendAmount = Math.round(raw);
    amountEur = floor2(sendAmount / rate);
    receiveAmount = amountEur;
  }

  const { minEur, maxEur } = config.limits;
  if (amountEur < minEur) {
    throw new QuoteError(direction === 'fr_to_ga'
      ? `Montant minimum : ${minEur} €`
      : `Montant minimum : ${Math.ceil(minEur * rate).toLocaleString('fr-FR')} FCFA`);
  }
  if (amountEur > maxEur) {
    throw new QuoteError(direction === 'fr_to_ga'
      ? `Montant maximum : ${maxEur} €`
      : `Montant maximum : ${Math.floor(maxEur * rate).toLocaleString('fr-FR')} FCFA`);
  }

  const fee = toSend(feeEur(amountEur, f, surcharge));
  const discount = firstTransfer ? Math.min(fee, toSend(f.firstTransferFreeMaxEur)) : 0;
  const total = direction === 'fr_to_ga' ? round2(sendAmount + fee - discount) : sendAmount + fee - discount;

  return {
    direction,
    sendCurrency: direction === 'fr_to_ga' ? 'EUR' : 'XAF',
    receiveCurrency: direction === 'fr_to_ga' ? 'XAF' : 'EUR',
    sendAmount,
    fee,
    discount,
    total,
    receiveAmount,
    rate,
    paypalSurchargePercent: surcharge,
    comparison: compare(direction, sendAmount, amountEur, fee, receiveAmount, config),
  };
}

/** Coût réel estimé chez les concurrents : frais affichés + marge cachée sur le taux de change. */
function compare(direction, sendAmount, amountEur, ourFee, ourReceive, config) {
  const rate = config.eurToXaf;
  const others = Object.entries(config.competitors).map(([name, c]) => {
    const costEur = c.fixedEur + (amountEur * c.fxMarginPercent) / 100;
    const keep = 1 - c.fxMarginPercent / 100;
    return direction === 'fr_to_ga'
      ? { name, cost: round2(costEur), receive: Math.floor(amountEur * rate * keep) }
      : { name, cost: Math.ceil(costEur * rate), receive: floor2(amountEur * keep) };
  });
  return [{ name: 'EnvoiGabon', cost: ourFee, receive: ourReceive }, ...others];
}

module.exports = { quote, feeEur, QuoteError, DIRECTIONS };
