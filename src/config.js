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
  port: num(env.PORT, 3000),
  publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'transfers.db'),
  adminToken: env.ADMIN_TOKEN || '',

  // Le franc CFA (XAF) est arrimé à l'euro : 1 EUR = 655,957 XAF, taux fixe.
  // On applique ce taux officiel sans marge, contrairement aux opérateurs classiques.
  eurToXaf: 655.957,

  fees: {
    fixedEur: num(env.FEE_FIXED_EUR, 0.99),
    percent: num(env.FEE_PERCENT, 1.0),
    minEur: num(env.FEE_MIN_EUR, 0.99),
  },

  limits: {
    minEur: num(env.MIN_AMOUNT_EUR, 5),
    maxEur: num(env.MAX_AMOUNT_EUR, 1000),
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
  },
};

config.airtel.enabled = Boolean(config.airtel.clientId && config.airtel.clientSecret);
config.stripe.enabled = Boolean(config.stripe.secretKey);

module.exports = config;
