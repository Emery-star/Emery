'use strict';

// Charge un fichier .env simple (KEY=VALUE) s'il existe, sans dépendance externe.
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = {
  // "demo" : tous les prestataires sont simulés. "live" : vrais prestataires uniquement.
  // "amis" : envois entre proches, l'organisateur fait lui-même les envois depuis ses comptes personnels.
  mode: ['live', 'amis'].includes(env.MODE) ? env.MODE : 'demo',
  port: num(env.PORT, 3000),
  publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'transfers.db'),
  adminToken: env.ADMIN_TOKEN || '',

  // Le franc CFA (XAF) est arrimé à l'euro : 1 EUR = 655,957 XAF, taux fixe.
  // On applique ce taux officiel sans marge, contrairement aux opérateurs classiques.
  eurToXaf: 655.957,

  // Grille : petit envoi à prix d'appel, puis fixe + pourcentage. Tout est calculé en euros.
  fees: {
    smallLimitEur: num(env.FEE_SMALL_LIMIT_EUR, 50),
    smallFeeEur: num(env.FEE_SMALL_EUR, 0.99),
    fixedEur: num(env.FEE_FIXED_EUR, 1.49),
    percent: num(env.FEE_PERCENT, 1.5),
    // PayPal coûte plus cher qu'une carte ou un virement : supplément répercuté et affiché.
    paypalSurchargePercent: num(env.FEE_PAYPAL_SURCHARGE_PERCENT, 1.0),
    // Premier envoi : frais offerts, dans la limite de ce montant.
    firstTransferFreeMaxEur: num(env.FIRST_TRANSFER_FREE_MAX_EUR, 5),
  },

  limits: {
    minEur: num(env.MIN_AMOUNT_EUR, 5),
    maxEur: num(env.MAX_AMOUNT_EUR, 1000),
    // Plafonds cumulés par client (équivalent euros).
    dailyEur: num(env.LIMIT_DAILY_EUR, 1000),
    monthlyEur: num(env.LIMIT_MONTHLY_EUR, 3000),
  },

  // Fichier JSON des personnes sous sanctions (voir src/compliance/screening.js).
  sanctionsFile: env.SANCTIONS_FILE || (env.MODE === 'live' ? '' : path.join(__dirname, 'compliance', 'sanctions-exemple.json')),

  // E-mails de reçu via Brevo (https://www.brevo.com). Sans clé : affichés dans la console.
  email: {
    brevoApiKey: env.BREVO_API_KEY || '',
    from: env.EMAIL_FROM || 'no-reply@example.com',
    fromName: env.EMAIL_FROM_NAME || 'EnvoiGabon',
  },

  // Mode "amis" : comptes personnels de l'organisateur, sur lesquels les amis paient.
  operator: {
    name: env.OPERATOR_NAME || '',
    airtel: env.OPERATOR_AIRTEL || '',
    paypalEmail: env.OPERATOR_PAYPAL_EMAIL || '',
    paypalMe: env.OPERATOR_PAYPALME || '',
    wero: env.OPERATOR_WERO || '',
    iban: env.OPERATOR_IBAN || '',
    whatsapp: env.OPERATOR_WHATSAPP || '',
  },

  // Notifications sur le téléphone de l'organisateur : ntfy (appli gratuite) et/ou Telegram.
  alerts: {
    ntfyServer: (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''),
    ntfyTopic: env.NTFY_TOPIC || '',
    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',
  },

  support: {
    email: env.SUPPORT_EMAIL || '',
    phone: env.SUPPORT_PHONE || '',
  },

  // Estimations indicatives des concurrents (frais fixes + marge de change).
  // À mettre à jour régulièrement depuis leurs simulateurs publics.
  competitors: {
    'Western Union': { fixedEur: num(env.WU_FIXED_EUR, 4.9), fxMarginPercent: num(env.WU_FX_MARGIN, 2.5) },
    Ria: { fixedEur: num(env.RIA_FIXED_EUR, 3.99), fxMarginPercent: num(env.RIA_FX_MARGIN, 1.8) },
  },

  airtel: {
    clientId: env.AIRTEL_CLIENT_ID || '',
    clientSecret: env.AIRTEL_CLIENT_SECRET || '',
    // Code PIN du compte de décaissement, chiffré avec la clé publique RSA du portail Airtel.
    pin: env.AIRTEL_DISBURSEMENT_PIN || '',
    publicKey: env.AIRTEL_PUBLIC_KEY || '',
    baseUrl: env.AIRTEL_BASE_URL || 'https://openapiuat.airtel.africa',
    country: 'GA',
    currency: 'XAF',
  },

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    // PayPal en paiement (France -> Gabon) passe par Stripe Checkout, à activer dans le tableau de bord Stripe.
    paypalEnabled: env.STRIPE_PAYPAL_ENABLED === 'true',
  },

  paypal: {
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    baseUrl: env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com',
  },

  // Virements SEPA sortants : à brancher sur un établissement partenaire (voir src/providers/sepa.js).
  sepa: {
    provider: env.SEPA_PROVIDER || '',
  },
};

config.airtel.enabled = Boolean(config.airtel.clientId && config.airtel.clientSecret);
config.stripe.enabled = Boolean(config.stripe.secretKey);
config.paypal.enabled = Boolean(config.paypal.clientId && config.paypal.clientSecret);
config.sepa.enabled = Boolean(config.sepa.provider);

module.exports = config;
