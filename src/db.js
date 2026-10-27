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
      id               TEXT PRIMARY KEY,
      access_token     TEXT NOT NULL,
      status           TEXT NOT NULL,
      amount_eur       REAL NOT NULL,
      fee_eur          REAL NOT NULL,
      total_eur        REAL NOT NULL,
      received_xaf     INTEGER NOT NULL,
      sender_name      TEXT NOT NULL,
      sender_email     TEXT NOT NULL,
      recipient_name   TEXT NOT NULL,
      recipient_msisdn TEXT NOT NULL,
      checkout_id      TEXT,
      payment_ref      TEXT,
      airtel_ref       TEXT,
      failure_reason   TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
    CREATE INDEX IF NOT EXISTS idx_transfers_checkout ON transfers(checkout_id);
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
