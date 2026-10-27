'use strict';

/**
 * Vérification d'identité (KYC) des expéditeurs.
 *
 * Un prestataire (Ubble, Onfido, Sumsub, Veriff…) vérifie la pièce d'identité et un selfie sur sa propre page,
 * puis envoie sa décision par webhook. Pour en brancher un, créez une classe avec les mêmes méthodes :
 *   start(user)                    -> { status: 'pending', ref, url }  (url = page du prestataire)
 *   parseWebhook(rawBody, headers) -> { ref, status: 'approved' | 'rejected', reason } ou null
 * La signature du webhook doit être vérifiée dans parseWebhook.
 */
class MockKyc {
  /** Simulation : approuvé tout de suite, sauf si le nom contient "refus". */
  async start(user) {
    if (/refus/i.test(user.full_name)) {
      return { status: 'rejected', ref: `MOCKKYC-${user.id.slice(0, 8)}`, reason: 'Document illisible (simulé)' };
    }
    return { status: 'approved', ref: `MOCKKYC-${user.id.slice(0, 8)}` };
  }
}

module.exports = { MockKyc };

/**
 * Sans prestataire : chaque dossier reste « en attente » jusqu'à la décision de l'équipe dans l'espace admin
 * (après avoir obtenu et contrôlé la pièce d'identité par un canal sécurisé). Solution de démarrage uniquement.
 */
class ManualKyc {
  async start() {
    return { status: 'pending' };
  }
}

module.exports.ManualKyc = ManualKyc;
