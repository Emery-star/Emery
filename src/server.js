'use strict';

const config = require('./config');
const { openDb } = require('./db');
const { AirtelClient, MockAirtelClient } = require('./providers/airtel');
const { StripePayments, MockPayments } = require('./providers/payments');
const { PaypalClient, MockPaypalClient } = require('./providers/paypal');
const { MockSepaClient } = require('./providers/sepa');
const { createRails } = require('./rails');
const { createTransferService } = require('./transfers');
const { createApp } = require('./app');

const live = config.mode === 'live';
if (live && !config.airtel.enabled) {
  console.error('MODE=live exige AIRTEL_CLIENT_ID et AIRTEL_CLIENT_SECRET.');
  process.exit(1);
}

// En mode démo, tout est simulé : on ne mélange jamais vrais et faux prestataires.
const airtel = live ? new AirtelClient(config.airtel) : new MockAirtelClient();
const payments = live && config.stripe.enabled ? new StripePayments(config.stripe, config.publicUrl) : new MockPayments(config.publicUrl);
const paypal = live && config.paypal.enabled ? new PaypalClient(config.paypal) : new MockPaypalClient();
// Virements SEPA : aucun client réel fourni, à brancher sur votre établissement partenaire (voir providers/sepa.js).
const sepa = live ? null : new MockSepaClient();

const db = openDb(config.dbPath);
const rails = createRails({ config, airtel, payments, paypal, sepa });
const transfers = createTransferService({ db, config, rails });
const app = createApp({ config, transfers, rails, airtel, payments });

if (!live) console.warn('⚠  Mode DÉMO : paiements et versements simulés (MODE=live pour la production)');

// Réconciliation périodique des transferts en cours.
setInterval(() => transfers.reconcile().catch((e) => console.error(e)), 15_000).unref();
transfers.reconcile().catch((e) => console.error(e));

app.listen(config.port, () => console.log(`Serveur prêt sur ${config.publicUrl} (port ${config.port})`));
