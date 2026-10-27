'use strict';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Calcule un devis pour un montant envoyé en euros.
 * Le destinataire reçoit amountEur converti au taux officiel, les frais sont payés en plus.
 */
function quote(amountEur, config) {
  const amount = Number(amountEur);
  if (!Number.isFinite(amount)) throw new QuoteError('Montant invalide');
  if (amount < config.limits.minEur) throw new QuoteError(`Montant minimum : ${config.limits.minEur} €`);
  if (amount > config.limits.maxEur) throw new QuoteError(`Montant maximum : ${config.limits.maxEur} €`);

  const sent = round2(amount);
  const feeEur = round2(Math.max(config.fees.minEur, config.fees.fixedEur + (sent * config.fees.percent) / 100));
  // Airtel Money ne gère pas les centimes de XAF : on arrondit à l'unité inférieure.
  const receivedXaf = Math.floor(sent * config.eurToXaf);

  return {
    amountEur: sent,
    feeEur,
    totalEur: round2(sent + feeEur),
    rate: config.eurToXaf,
    receivedXaf,
    comparison: compare(sent, feeEur, config),
  };
}

/** Coût réel estimé chez les concurrents : frais affichés + marge cachée sur le taux de change. */
function compare(amountEur, ourFeeEur, config) {
  const ours = { name: 'Nous', totalCostEur: ourFeeEur, receivedXaf: Math.floor(amountEur * config.eurToXaf) };
  const others = Object.entries(config.competitors).map(([name, c]) => {
    const fxCost = (amountEur * c.fxMarginPercent) / 100;
    return {
      name,
      totalCostEur: round2(c.fixedEur + fxCost),
      receivedXaf: Math.floor(amountEur * config.eurToXaf * (1 - c.fxMarginPercent / 100)),
    };
  });
  return [ours, ...others];
}

class QuoteError extends Error {}

module.exports = { quote, QuoteError };
