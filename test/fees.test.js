'use strict';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { quote, QuoteError } = require('../src/fees');
const { normalizeAirtelGabon } = require('../src/phone');

test('le devis applique le taux officiel sans marge', () => {
  const q = quote(100, config);
  assert.strictEqual(q.receivedXaf, 65595);
  assert.strictEqual(q.feeEur, 1.99);
  assert.strictEqual(q.totalEur, 101.99);
});

test('nos frais sont inférieurs à Western Union et Ria sur toute la plage', () => {
  for (const amount of [5, 20, 50, 100, 300, 500, 1000]) {
    const [ours, ...others] = quote(amount, config).comparison;
    for (const o of others) {
      assert.ok(ours.totalCostEur < o.totalCostEur, `${amount} € : ${o.name} moins cher`);
    }
  }
});

test('le devis refuse les montants hors limites', () => {
  assert.throws(() => quote(1, config), QuoteError);
  assert.throws(() => quote(5000, config), QuoteError);
  assert.throws(() => quote('abc', config), QuoteError);
});

test('normalisation des numéros Airtel Gabon', () => {
  assert.strictEqual(normalizeAirtelGabon('+241 077 12 34 56'), '077123456');
  assert.strictEqual(normalizeAirtelGabon('00241 74 12 34 56'), '074123456');
  assert.strictEqual(normalizeAirtelGabon('076123456'), '076123456');
  assert.strictEqual(normalizeAirtelGabon('77123456'), '077123456');
  assert.strictEqual(normalizeAirtelGabon('066123456'), null); // Moov
  assert.strictEqual(normalizeAirtelGabon('07712'), null);
});
