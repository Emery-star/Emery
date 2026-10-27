'use strict';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { quote, QuoteError } = require('../src/fees');
const { normalizeAirtelGabon } = require('../src/phone');
const { normalizeIban } = require('../src/validate');

test('France -> Gabon : prix d’appel jusqu’à 50 €, puis fixe + pourcentage', () => {
  assert.strictEqual(quote({ amount: 20 }, config).fee, 0.99);
  assert.strictEqual(quote({ amount: 50 }, config).fee, 0.99);
  const q = quote({ amount: 100 }, config);
  assert.strictEqual(q.fee, 2.99);
  assert.strictEqual(q.total, 102.99);
  assert.strictEqual(q.receiveAmount, 65595);
});

test('premier envoi : frais offerts dans la limite prévue', () => {
  assert.strictEqual(quote({ amount: 100, firstTransfer: true }, config).total, 100);
  const big = quote({ amount: 1000, firstTransfer: true }, config);
  assert.strictEqual(big.discount, 5);
  assert.strictEqual(big.total, 1000 + big.fee - 5);
});

test('PayPal ajoute un supplément affiché', () => {
  assert.strictEqual(quote({ amount: 100, payMethod: 'paypal' }, config).fee, 3.99);
});

test('Gabon -> France : montant en FCFA, frais en FCFA, reçu en euros', () => {
  const q = quote({ direction: 'ga_to_fr', amount: 65596, payoutMethod: 'sepa' }, config);
  assert.strictEqual(q.sendCurrency, 'XAF');
  assert.strictEqual(q.receiveAmount, 100);
  assert.strictEqual(q.fee, Math.ceil(2.99 * 655.957));
  assert.strictEqual(q.total, 65596 + q.fee);
});

test('nos frais restent inférieurs à Western Union et Ria, dans les deux sens', () => {
  for (const eur of [5, 20, 50, 51, 100, 300, 500, 1000]) {
    for (const direction of ['fr_to_ga', 'ga_to_fr']) {
      const amount = direction === 'fr_to_ga' ? eur : Math.ceil(eur * 655.957);
      const [ours, ...others] = quote({ direction, amount }, config).comparison;
      for (const o of others) {
        assert.ok(ours.cost < o.cost, `${direction} ${eur} € : ${o.name} moins cher`);
        assert.ok(ours.receive > o.receive, `${direction} ${eur} € : ${o.name} donne plus`);
      }
    }
  }
});

test('le devis refuse les montants hors limites', () => {
  assert.throws(() => quote({ amount: 1 }, config), QuoteError);
  assert.throws(() => quote({ amount: 5000 }, config), QuoteError);
  assert.throws(() => quote({ amount: 'abc' }, config), QuoteError);
  assert.throws(() => quote({ direction: 'ga_to_fr', amount: 1000 }, config), QuoteError);
  assert.throws(() => quote({ direction: 'xx', amount: 10 }, config), QuoteError);
});

test('normalisation des numéros Airtel Gabon', () => {
  assert.strictEqual(normalizeAirtelGabon('+241 077 12 34 56'), '077123456');
  assert.strictEqual(normalizeAirtelGabon('00241 74 12 34 56'), '074123456');
  assert.strictEqual(normalizeAirtelGabon('076123456'), '076123456');
  assert.strictEqual(normalizeAirtelGabon('77123456'), '077123456');
  assert.strictEqual(normalizeAirtelGabon('066123456'), null); // Moov
  assert.strictEqual(normalizeAirtelGabon('07712'), null);
});

test('validation des IBAN', () => {
  assert.strictEqual(normalizeIban('fr76 3000 6000 0112 3456 7890 189'), 'FR7630006000011234567890189');
  assert.strictEqual(normalizeIban('FR7630006000011234567890188'), null); // mauvaise clé
  assert.strictEqual(normalizeIban('FR76300060000112345678901'), null); // trop court
  assert.strictEqual(normalizeIban('GA2140001000000000000000000'), null); // hors zone gérée
});
