'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { openDb } = require('../db');
const { normalizeAirtelGabon } = require('../phone');
const { createAlerts } = require('./alerts');
const { createFriendsService } = require('./service');
const { createFriendsApp } = require('./app');

if (!normalizeAirtelGabon(config.operator.airtel)) {
  console.error('Démarrage refusé : OPERATOR_AIRTEL doit être votre numéro Airtel Money Gabon (ex. 074 12 34 56).');
  process.exit(1);
}
if (!config.operator.paypalEmail && !config.operator.wero && !config.operator.iban) {
  console.warn('⚠  Aucun moyen de paiement côté France (OPERATOR_PAYPAL_EMAIL, OPERATOR_WERO ou OPERATOR_IBAN) : seul le sens Gabon → France sera proposé.');
}
if (config.adminToken.length < 16) {
  config.adminToken = crypto.randomBytes(18).toString('base64url');
  console.warn(`⚠  ADMIN_TOKEN absent ou trop court. Code organisateur provisoire (change à chaque redémarrage) : ${config.adminToken}`);
}

const db = openDb(config.dbPath);
const alerts = createAlerts(config.alerts);
const friends = createFriendsService({ db, config, alerts });
const app = createFriendsApp({ config, friends });

if (!alerts.enabled) console.warn('⚠  Aucune alerte configurée (NTFY_TOPIC ou TELEGRAM_BOT_TOKEN) : les annonces de paiement s’affichent seulement ici.');

setInterval(() => friends.expire(), 10 * 60_000).unref();
friends.expire();

app.listen(config.port, () => console.log(`Mode entre amis prêt sur ${config.publicUrl} (port ${config.port}). Espace organisateur : ${config.publicUrl}/admin.html`));
