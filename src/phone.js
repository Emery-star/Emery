'use strict';

// Préfixes mobiles Airtel Gabon (plan de numérotation à 9 chiffres : 07X XX XX XX).
// Les numéros Moov/Libertis commencent par 06 et ne sont pas éligibles.
const AIRTEL_PREFIXES = ['074', '076', '077'];

/**
 * Normalise un numéro Airtel Gabon au format attendu par l'API Airtel (sans indicatif pays).
 * Accepte : "+241 077 12 34 56", "241077123456", "077123456", "77123456".
 * Retourne null si le numéro n'est pas un numéro Airtel Gabon valide.
 */
function normalizeAirtelGabon(input) {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/[\s.\-()]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.startsWith('241')) digits = digits.slice(3);
  // Ancien format à 8 chiffres sans le 0 initial.
  if (digits.length === 8 && digits.startsWith('7')) digits = '0' + digits;
  if (digits.length !== 9) return null;
  if (!AIRTEL_PREFIXES.some((p) => digits.startsWith(p))) return null;
  return digits;
}

function formatGabon(msisdn) {
  return `+241 ${msisdn.slice(0, 3)} ${msisdn.slice(3, 5)} ${msisdn.slice(5, 7)} ${msisdn.slice(7, 9)}`;
}

module.exports = { normalizeAirtelGabon, formatGabon, AIRTEL_PREFIXES };
