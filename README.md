# EnvoiGabon – envoi d'argent France ⇄ Gabon via Airtel Money

Application web pour envoyer de l'argent **dans les deux sens** entre la France (zone euro) et le Gabon,
avec **Airtel Money** côté Gabon, moins cher que Western Union ou Ria.

| Sens | L'expéditeur paie avec | Le bénéficiaire reçoit sur |
|---|---|---|
| France → Gabon | carte bancaire, PayPal | Airtel Money |
| Gabon → France | Airtel Money (validation par code PIN) | compte bancaire (IBAN, virement SEPA), PayPal |

**Wero** apparaît comme « Bientôt » : pas encore branché (voir plus bas).

Version test en ligne, entièrement simulée : `demo/envoi-gabon-test.html` (fichier autonome à ouvrir dans un navigateur).

## Frais

Le franc CFA (XAF) est arrimé à l'euro : **1 € = 655,957 FCFA**, toujours. Le taux officiel est appliqué
sans marge ; Western Union et Ria se rémunèrent en grande partie sur une marge cachée dans le taux.

- **Premier envoi : frais offerts** (jusqu'à 5 €), par e-mail en France ou numéro Airtel au Gabon.
- **Prix d'appel : 0,99 €** jusqu'à 50 €.
- Au-delà : **1,49 € + 1,5 %**.
- PayPal : **+1 %**, car PayPal coûte plus cher qu'une carte ou un virement. Le supplément est affiché.
- Depuis le Gabon, les mêmes frais sont convertis en FCFA (arrondis au franc supérieur).

| Envoi | EnvoiGabon | Ria (estimation) | Western Union (estimation) |
|---|---|---|---|
| 30 € | 0,99 € | 4,53 € | 5,65 € |
| 100 € | 2,99 € | 5,79 € | 7,40 € |
| 500 € | 8,99 € | 12,99 € | 17,40 € |

Les chiffres des concurrents (frais + marge de change) sont des estimations à mettre à jour dans `.env`
(`WU_*`, `RIA_*`). Un test vérifie que vous restez moins cher dans les deux sens sur toute la plage.

## Fonctionnement

**France → Gabon** : paiement Stripe Checkout (carte ou PayPal) → webhook signé → dépôt sur le compte Airtel Money
du bénéficiaire (API Disbursement). Le nom du titulaire peut être vérifié avant l'envoi (API KYC).

**Gabon → France** : l'expéditeur reçoit sur son téléphone une demande de paiement Airtel et la valide avec son code
PIN (API Collection) → virement SEPA vers l'IBAN ou versement PayPal (API Payouts) au bénéficiaire.

Une page de suivi affiche l'état en temps réel.

### Sécurité de l'argent

- Un paiement ne peut déclencher qu'**un seul** versement (transitions d'état atomiques, webhooks idempotents,
  identifiants uniques transmis aux prestataires).
- Le montant payé est contrôlé avant tout versement.
- Si le versement est refusé, l'expéditeur est **remboursé automatiquement** sur le moyen utilisé (carte, PayPal
  ou Airtel Money).
- Si un prestataire ne répond pas clairement (coupure réseau), on **ne rembourse pas à l'aveugle** : la
  réconciliation interroge le prestataire toutes les 15 s ; sans réponse claire après 6 h, le transfert passe en
  `needs_review`.
- Les callbacks Airtel ne sont pas pris pour argent comptant : le statut est revérifié auprès de l'API.
- En mode `live`, aucun simulateur n'est utilisé : un moyen sans prestataire configuré n'est pas proposé.
- IBAN vérifiés (longueur par pays et clé de contrôle), pages de suivi protégées par jeton, limitation de débit, CSP stricte.

## Démarrer

Node.js ≥ 22.13 requis (utilise SQLite intégré).

```bash
npm install
npm start          # http://localhost:3000, en mode démo (tout simulé)
npm test
```

Scénarios de test en mode démo :

| Saisie | Résultat simulé |
|---|---|
| numéro Airtel du bénéficiaire finissant par `9999` | dépôt refusé, remboursement |
| numéro Airtel de l'expéditeur (Gabon) finissant par `9999` | solde insuffisant, paiement annulé |
| numéro finissant par `0000` | compte Airtel introuvable |
| e-mail PayPal commençant par `echec` | versement PayPal refusé, remboursement |
| nom du bénéficiaire contenant `echec` (IBAN) | virement rejeté, remboursement |

## Passer en réel (`MODE=live`)

Copier `.env.example` en `.env` et remplir :

- **Airtel** : compte sur <https://developers.airtel.africa>, application avec *Collection*, *Disbursement* et
  *KYC* pour le pays **GA**. Tester en UAT puis demander la production. Le compte de décaissement doit être
  approvisionné en XAF. Callback à déclarer : `https://votre-domaine/webhooks/airtel`.
- **Stripe** : clé secrète + webhook `checkout.session.completed` et `checkout.session.async_payment_succeeded`
  vers `https://votre-domaine/webhooks/stripe`. Pour PayPal en paiement, l'activer dans Stripe puis
  `STRIPE_PAYPAL_ENABLED=true`.
- **PayPal Payouts** : application sur <https://developer.paypal.com> avec l'accès *Payouts* (à demander à PayPal).
  Le compte doit être approvisionné en euros.
- **Virements SEPA** : il faut un compte chez un établissement qui permet d'émettre des virements par API
  (banque partenaire, Swan, Treezor, Mangopay…). Le simulateur est prêt (`src/providers/sepa.js`) : il reste à
  écrire le client de l'établissement choisi.
- **Wero** : les paiements Wero entre particuliers et commerçants passent par les banques et prestataires
  membres d'EPI. Il n'y a pas d'API publique directe : à activer quand votre prestataire de paiement le propose.
- Liste des transferts : `GET /api/admin/transfers` avec `Authorization: Bearer <ADMIN_TOKEN>`.

> À vérifier avec Airtel lors de l'intégration : le format exact du `msisdn` attendu pour le Gabon
> (avec ou sans le `0` initial, voir `src/phone.js`) et la clé publique de chiffrement du PIN.

## ⚠️ Obligations légales avant d'encaisser de l'argent réel

Transférer de l'argent pour le compte de tiers est une activité réglementée. Avant la mise en production :

- **En Europe** : agrément d'établissement de paiement (ACPR en France) ou statut d'agent d'un établissement agréé.
- **Au Gabon / CEMAC** : partenariat officiel avec Airtel Money Gabon et respect des règles COBAC / BEAC sur les
  transferts internationaux.
- **LCB-FT** : vérification d'identité (KYC) des expéditeurs, plafonds, filtrage des listes de sanctions,
  déclarations de soupçon. L'application inclut des plafonds par envoi mais **pas** encore de KYC expéditeur.

## Modèle économique

Les frais doivent couvrir : commission Stripe (~1,5 % + 0,25 € par carte en zone euro), commissions Airtel
(encaissement et décaissement, à négocier), frais PayPal Payouts et virements SEPA, et le coût de
l'approvisionnement des comptes en XAF et en EUR. Les envois de moins de 50 € à 0,99 € et le premier envoi offert
sont des produits d'appel : ils coûtent plus qu'ils ne rapportent, la marge vient des montants plus élevés.
Ajustez `FEE_FIXED_EUR` / `FEE_PERCENT` selon vos contrats ; les tests vérifient que vous restez moins cher que
les estimations concurrentes.

## Structure

```
src/
  server.js             démarrage, réconciliation périodique
  app.js                routes HTTP (API, webhooks, fichiers statiques)
  transfers.js          cycle de vie d'un transfert (paiement → versement → remboursement)
  rails.js              moyens de paiement et de versement, par sens d'envoi
  fees.js               calcul des frais et comparaison
  phone.js, validate.js numéros Airtel Gabon, IBAN, e-mails
  providers/airtel.js   Open API Airtel Africa : encaissement, décaissement, KYC (+ simulateur)
  providers/payments.js Stripe Checkout, carte et PayPal (+ simulateur)
  providers/paypal.js   PayPal Payouts (+ simulateur)
  providers/sepa.js     virements SEPA (simulateur, client réel à brancher)
public/                 interface web (accueil, suivi, paiement simulé)
demo/                   version test autonome, sans serveur
test/                   tests (node --test)
```
