'use strict';

const config = require('./config');
const { openDb } = require('./db');
const { AirtelClient, MockAirtelClient } = require('./providers/airtel');
const { StripePayments, MockPayments } = require('./providers/payments');
const { createTransferService } = require('./transfers');
const { createApp } = require('./app');

const db = openDb(config.dbPath);
const airtel = config.airtel.enabled ? new AirtelClient(config.airtel) : new MockAirtelClient();
const payments = config.stripe.enabled
  ? new StripePayments(config.stripe, config.publicUrl)
  : new MockPayments(config.publicUrl);
const transfers = createTransferService({ db, config, airtel, payments });
const app = createApp({ config, transfers, airtel, payments });

if (!config.airtel.enabled) console.warn('⚠  Airtel Money en mode SIMULATION (AIRTEL_CLIENT_ID absent)');
if (!config.stripe.enabled) console.warn('⚠  Paiement carte en mode SIMULATION (STRIPE_SECRET_KEY absent)');

// Réconciliation périodique des transferts en cours.
setInterval(() => transfers.reconcile().catch((e) => console.error(e)), 30_000).unref();
transfers.reconcile().catch((e) => console.error(e));

app.listen(config.port, () => console.log(`Serveur prêt sur ${config.publicUrl} (port ${config.port})`));
