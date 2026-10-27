# EnvoiGabon – envoi d'argent vers Airtel Money Gabon

Application web pour envoyer de l'argent depuis l'Europe vers un portefeuille **Airtel Money au Gabon**,
moins cher que Western Union ou Ria.

## Pourquoi c'est moins cher

Le franc CFA (XAF) est arrimé à l'euro : **1 € = 655,957 FCFA**, toujours. Western Union et Ria se rémunèrent
en grande partie sur une marge cachée dans le taux de change. Ici le taux officiel est appliqué tel quel et les
frais sont affichés clairement.

| Envoi de 100 € | Frais + marge de change | Le bénéficiaire reçoit |
|---|---|---|
| **EnvoiGabon** | **1,99 €** | **65 595 FCFA** |
| Ria (estimation) | ~5,79 € | ~64 414 FCFA |
| Western Union (estimation) | ~7,40 € | ~63 955 FCFA |

Les chiffres des concurrents sont des estimations à mettre à jour dans `.env` (`WU_*`, `RIA_*`).

## Fonctionnement

1. L'expéditeur saisit le montant : le simulateur affiche ce que reçoit le bénéficiaire et la comparaison.
2. Il saisit le numéro Airtel (074 / 076 / 077) et peut **vérifier le titulaire du compte** (API KYC Airtel)
   avant d'envoyer, pour éviter les erreurs de numéro.
3. Il paie par carte (Stripe Checkout).
4. Dès que Stripe confirme le paiement (webhook signé), le serveur envoie les FCFA sur le compte Airtel Money
   via l'API de décaissement B2C d'Airtel Africa.
5. Une page de suivi affiche l'état en temps réel. Si Airtel refuse le dépôt, **la carte est remboursée
   automatiquement**.

### Sécurité de l'argent

- Un paiement ne peut déclencher qu'**un seul** dépôt (transitions d'état atomiques, webhooks idempotents).
- Le montant payé est contrôlé avant tout envoi.
- En cas de réponse réseau incertaine d'Airtel, on **ne rembourse pas à l'aveugle** : la réconciliation interroge
  Airtel toutes les 30 s ; au-delà de 6 h sans réponse claire, le transfert passe en `needs_review`.
- Les callbacks Airtel ne sont pas pris pour argent comptant : le statut est revérifié auprès de l'API.
- Pages de suivi protégées par un jeton secret, limitation de débit, CSP stricte.

## Démarrer

Node.js ≥ 22.13 requis (utilise SQLite intégré).

```bash
npm install
npm start          # http://localhost:3000, en mode simulation
npm test
```

Sans clés Airtel ni Stripe, tout est **simulé** (bandeau jaune affiché). Numéros de test :
se terminant par `9999` → échec puis remboursement ; par `0000` → compte introuvable.

## Passer en réel

Copier `.env.example` en `.env` et remplir :

- **Airtel** : créer un compte sur <https://developers.airtel.africa>, application avec les produits
  *Disbursement* et *KYC* pour le pays **GA**. Tester en UAT puis demander le passage en production.
  Le compte de décaissement doit être approvisionné en XAF.
- **Stripe** : clé secrète + webhook `checkout.session.completed` pointant vers `https://votre-domaine/webhooks/stripe`.
- Callback Airtel à déclarer : `https://votre-domaine/webhooks/airtel`.
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

Les frais (0,99 € + 1 % par défaut) doivent couvrir : commission Stripe (~1,5 % + 0,25 € en zone euro),
commission de décaissement Airtel (à négocier) et coût d'approvisionnement du compte en XAF.
Ajustez `FEE_FIXED_EUR` / `FEE_PERCENT` selon vos contrats ; les tests vérifient que vous restez moins cher que
les estimations concurrentes.

## Structure

```
src/
  server.js             démarrage, réconciliation périodique
  app.js                routes HTTP (API, webhooks, fichiers statiques)
  transfers.js          cycle de vie d'un transfert (paiement → Airtel → remboursement)
  fees.js               calcul des frais et comparaison
  phone.js              validation des numéros Airtel Gabon
  providers/airtel.js   client Open API Airtel Africa (+ simulateur)
  providers/payments.js Stripe Checkout (+ simulateur)
public/                 interface web (accueil, suivi, paiement simulé)
test/                   tests (node --test)
```
