'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS transfers (
      id                TEXT PRIMARY KEY,
      access_token      TEXT NOT NULL,
      user_id           TEXT NOT NULL,
      status            TEXT NOT NULL,
      direction         TEXT NOT NULL,          -- fr_to_ga | ga_to_fr
      pay_method        TEXT NOT NULL,          -- card | paypal | airtel
      payout_method     TEXT NOT NULL,          -- airtel | paypal | sepa
      send_currency     TEXT NOT NULL,
      send_amount       REAL NOT NULL,
      fee               REAL NOT NULL,
      discount          REAL NOT NULL,
      total             REAL NOT NULL,
      receive_currency  TEXT NOT NULL,
      receive_amount    REAL NOT NULL,
      amount_eur        REAL NOT NULL,          -- équivalent euros, pour les plafonds
      sender_name       TEXT NOT NULL,
      sender_contact    TEXT NOT NULL,          -- e-mail (France) ou numéro Airtel (Gabon)
      recipient_name    TEXT NOT NULL,
      recipient_account TEXT NOT NULL,          -- numéro Airtel, e-mail PayPal ou IBAN
      checkout_id       TEXT,
      payment_ref       TEXT,
      payout_ref        TEXT,
      failure_reason    TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
    CREATE INDEX IF NOT EXISTS idx_transfers_checkout ON transfers(checkout_id);
    CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfers(user_id, created_at);
    CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY,
      email          TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      full_name      TEXT NOT NULL,
      phone          TEXT,                     -- numéro Airtel Gabon, facultatif
      country        TEXT,                     -- pays de résidence
      birth_date     TEXT,
      address        TEXT,
      id_type        TEXT,                     -- passeport | carte_identite | titre_sejour
      id_number      TEXT,
      kyc_status     TEXT NOT NULL DEFAULT 'none', -- none | pending | approved | rejected
      kyc_ref        TEXT,
      kyc_reason     TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_id TEXT NOT NULL,
      type        TEXT NOT NULL,
      detail      TEXT,
      created_at  TEXT NOT NULL
    );
  `);
  return db;
}

module.exports = { openDb };
