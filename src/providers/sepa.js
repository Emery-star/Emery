'use strict';

/**
 * Virements SEPA sortants (Gabon -> compte bancaire en France / zone euro).
 *
 * Il n'existe pas d'API publique universelle pour émettre un virement : il faut un compte
 * chez un établissement qui en propose une (banque partenaire, Swan, Treezor, Mangopay…).
 * Pour brancher le vôtre, créez une classe avec les mêmes méthodes que MockSepaClient :
 *   transfer({ id, iban, name, amountEur, label }) -> { status, providerRef }
 *   status(providerRef)                             -> { status, providerRef, message }
 * où status vaut 'pending', 'success' ou 'failed', puis instanciez-la dans server.js.
 * Utilisez `id` comme clé d'idempotence auprès du prestataire pour éviter tout double virement.
 */
class MockSepaClient {
  constructor() {
    this.sent = new Map();
  }
  /** Un bénéficiaire dont le nom contient "echec" simule un virement rejeté. */
  async transfer({ id, iban, name, amountEur }) {
    const ref = `MOCKSEPA-${id.slice(1, 9)}`;
    this.sent.set(ref, { iban, amountEur, status: /echec/i.test(name) ? 'failed' : 'success' });
    return { status: 'pending', providerRef: ref };
  }
  async status(ref) {
    const t = this.sent.get(ref);
    return { status: t ? t.status : 'failed', providerRef: ref, message: t && t.status === 'failed' ? 'Virement rejeté par la banque (simulé)' : undefined };
  }
}

module.exports = { MockSepaClient };
