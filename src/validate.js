'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(input) {
  const e = String(input || '').trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 200 ? e : null;
}

// Pays de la zone SEPA les plus courants pour la diaspora, avec la longueur de leur IBAN.
const IBAN_LENGTHS = { FR: 27, BE: 16, DE: 22, ES: 24, IT: 27, LU: 20, NL: 18, PT: 25, CH: 21, MC: 27, IE: 22, AT: 20 };

/** Valide un IBAN (longueur par pays + clé de contrôle modulo 97). Retourne l'IBAN compact ou null. */
function normalizeIban(input) {
  const iban = String(input || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return null;
  const len = IBAN_LENGTHS[iban.slice(0, 2)];
  if (!len || iban.length !== len) return null;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1 ? iban : null;
}

function maskIban(iban) {
  return `${iban.slice(0, 4)} •••• •••• ${iban.slice(-4)}`;
}

function maskEmail(email) {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

module.exports = { normalizeEmail, normalizeIban, maskIban, maskEmail, IBAN_LENGTHS };
