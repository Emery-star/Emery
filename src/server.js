'use strict';

const config = require('./config');
const { openDb } = require('./db');
const { AirtelClient, MockAirtelClient } = require('./providers/airtel');
const { StripePayments, MockPayments } = require('./providers/payments');
const { PaypalClient, MockPaypalClient } = require('./providers/paypal');
const { MockSepaClient } = require('./providers/sepa');
const { MockKyc, ManualKyc } = require('./compliance/kyc');
const { createScreening } = require('./compliance/screening');
const { createLimits } = require('./compliance/limits');
const { BrevoNotifier, ConsoleNotifier } = require('./notifier');
const { createRails } = require('./rails');
const { createUserService } = require('./users');
const { createTransferService } = require('./transfers');
const { createApp } = require('./app');

const live = config.mode === 'live';
function refuse(message) {
  console.error(`Démarrage refusé : ${message}`);
  process.exit(1);
}
if (live) {
  if (!config.airtel.enabled) refuse('MODE=live exige AIRTEL_CLIENT_ID et AIRTEL_CLIENT_SECRET.');
  if (!config.sanctionsFile) refuse('MODE=live exige SANCTIONS_FILE (liste de sanctions à jour).');
  if (config.adminToken.length < 32) refuse('MODE=live exige un ADMIN_TOKEN aléatoire d’au moins 32 caractères.');
  if (!config.publicUrl.startsWith('https://')) refuse('MODE=live exige une PUBLIC_URL en https.');
}

// En mode démo, tout est simulé : on ne mélange jamais vrais et faux prestataires.
const airtel = live ? new AirtelClient(config.airtel) : new MockAirtelClient();
const payments = live && config.stripe.enabled ? new StripePayments(config.stripe, config.publicUrl) : new MockPayments(config.publicUrl);
const paypal = live && config.paypal.enabled ? new PaypalClient(config.paypal) : new MockPaypalClient();
// Virements SEPA : aucun client réel fourni, à brancher sur votre établissement partenaire (voir providers/sepa.js).
const sepa = live ? null : new MockSepaClient();
// Vérification d'identité : à remplacer par le client de votre prestataire KYC (voir compliance/kyc.js).
const kyc = live ? new ManualKyc() : new MockKyc();
const notifier = config.email.brevoApiKey
  ? new BrevoNotifier({ apiKey: config.email.brevoApiKey, sender: { email: config.email.from, name: config.email.fromName } })
  : new ConsoleNotifier();

if (!live && !config.adminToken) {
  config.adminToken = require('node:crypto').randomBytes(18).toString('base64url');
  console.log(`Jeton de l'espace admin (démo) : ${config.adminToken}`);
}

const db = openDb(config.dbPath);
const screening = createScreening(config.sanctionsFile);
const rails = createRails({ config, airtel, payments, paypal, sepa });
const users = createUserService({ db, kyc, screening });
const transfers = createTransferService({
  db, config, rails, users, notifier, screening, limits: createLimits({ db, config }),
});
const app = createApp({ config, transfers, users, rails, airtel, payments, kyc });

if (!live) console.warn('⚠  Mode DÉMO : paiements, versements et vérification d’identité simulés (MODE=live pour la production)');
console.log(`Liste de sanctions : ${screening.size} entrée(s) chargée(s)`);

// Réconciliation périodique des transferts en cours.
setInterval(() => transfers.reconcile().catch((e) => console.error(e)), 15_000).unref();
transfers.reconcile().catch((e) => console.error(e));

app.listen(config.port, () => console.log(`Serveur prêt sur ${config.publicUrl} (port ${config.port})`));
