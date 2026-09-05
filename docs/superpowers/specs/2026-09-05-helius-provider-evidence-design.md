# Preuve de quota Helius pour le préflight externe — conception #51-H2e

**Version de spécification :** 1.0.2

**Version de la spécification parente :** 1.11.9

**Date :** 2026-09-05

**Statut :** APPROUVÉE — producteur externe non transactionnel

**Issue parente :** #51

**Dépendance :** #51-H2d fusionnée par la PR #80 (`e854c26`)

## Historique des versions

- **1.0.2 — 2026-09-05 :** revérifie l'expiration après signature et après
  écriture afin de ne jamais annoncer un succès devenu stale.

- **1.0.1 — 2026-09-05 :** refuse les secrets Helius directs et les symlinks
  d'entrée, borne la sortie et réapplique explicitement son mode `0600`.

- **1.0.0 — 2026-09-05 :** définit le producteur one-shot de preuve de quota
  Helius, son isolement des wallets et du runtime live, sa sortie atomique
  `0600` et son contrat avec le bootstrap H2d.

## 1. Problème constaté

H2d collecte l'état public finalisé du wallet et sait vérifier une preuve de
quota Ed25519. Il ne produit volontairement pas cette preuve. L'environnement
utilise Helius, dont l'Admin API officielle expose le plan, le cycle de
facturation, les crédits consommés et les crédits restants. Aucun composant du
dépôt ne convertit encore cette réponse en enveloppe canonique H2d.

Sans ce producteur, une valeur de quota devrait être saisie manuellement ou
inventée. H2e ferme seulement cette lacune. Il ne qualifie pas les dix autres
gates H2c et ne démarre aucun canary.

## 2. Résultat livré

Un processus séparé `executor:provider-evidence` :

1. lit une clé API Helius depuis un fichier externe strictement protégé ;
2. appelle une seule fois l'Admin API officielle pour un projet UUID exact ;
3. valide strictement et borne la réponse HTTP ;
4. convertit tous les crédits en entiers décimaux ;
5. construit le payload canonique accepté par H2d ;
6. le signe avec une clé d'attestation Ed25519 externe au dépôt ;
7. écrit atomiquement l'enveloppe dans un fichier `0600` ;
8. émet sur stdout un manifeste redacted, sans secret ni quota détaillé.

Le résultat terminal reste :

```text
PROVIDER_EVIDENCE_COLLECTED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```

## 3. Frontière de sécurité

Le processus H2e est distinct du listener, de H2a, de H2b, des opérations H2c
et de H2d. Il n'importe aucun module de wallet Solana, keypair de transaction,
construction, signature de transaction, soumission, armement ou PostgreSQL.

La clé Ed25519 H2e atteste uniquement un document de quota. Elle n'est jamais
une clé Solana et ne doit jamais être réutilisée comme telle. Les chemins de la
clé API, de la clé d'attestation et de la sortie sont absolus et externes au
dépôt. Les deux fichiers secrets doivent être des fichiers réguliers appartenant
à l'utilisateur courant et de mode `0400` ou `0600`.

La configuration refuse tout nom d'environnement relatif à une clé wallet,
une mnemonic, une recovery phrase, un keypair Solana, `EXECUTOR_MODE` ou
`LIVE_TRADING_ENABLED`, même vide. Aucune URL RPC ou URL PostgreSQL n'est
acceptée ni nécessaire.

## 4. Configuration exacte

```dotenv
HELIUS_PROJECT_ID=<uuid-du-projet>
HELIUS_API_KEY_PATH=/chemin/hors-git/helius-api-key
EXECUTOR_RPC_PROVIDER_ID=helius-primary
EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH=/chemin/hors-git/provider-attestation-key.pem
EXECUTOR_PROVIDER_EVIDENCE_PATH=/chemin/hors-git/provider-evidence.json
EXECUTOR_PROVIDER_EVIDENCE_TTL_MS=300000
EXECUTOR_PROVIDER_EVIDENCE_TIMEOUT_MS=5000
```

L'origine réseau est fixée dans le code à
`https://admin-api.helius.xyz`. Aucun override d'URL n'est prévu en production.
La clé API est envoyée dans l'en-tête `X-Api-Key`, jamais dans l'URL ou les
logs. Le projet doit correspondre à cette clé ; Helius refuse le désaccord.

## 5. Contrat Helius et conversion entière

La réponse acceptée contient exactement les champs utiles documentés :

- `creditsRemaining` ;
- `creditsUsed` ;
- `prepaidCreditsRemaining` ;
- `prepaidCreditsUsed` ;
- `subscriptionDetails.plan` ;
- `subscriptionDetails.creditsLimit` ;
- `subscriptionDetails.billingCycle.start|end` ;
- la ventilation `usage` connue.

Tous les compteurs doivent être des entiers JSON sûrs et positifs ou nuls.
Les champs inconnus sont refusés afin qu'une dérive du contrat soit visible.
La conversion durable utilise :

```text
usedUnits  = creditsUsed
limitUnits = creditsUsed + creditsRemaining + prepaidCreditsRemaining
```

Cette formule représente l'enveloppe totale actuellement consommée ou encore
disponible, y compris les crédits prépayés. Elle ne mélange pas les compteurs
de requêtes par produit avec les unités de crédit.

Le `billingPeriodId` lie le fournisseur, le fingerprint du projet et les deux
bornes UTC du cycle. Le projet UUID n'est pas écrit dans le manifeste stdout.
Le `measuredAtMs` est l'instant local immédiatement après réception complète
de la réponse. L'expiration est le minimum entre ce temps plus le TTL configuré
et la fin du cycle de facturation. Un reste inférieur à 30 secondes est refusé.

## 6. Transport borné

Le transport effectue exactement une requête GET par exécution, avec un timeout
borné et sans retry caché. Il exige HTTPS, un statut 200, un type JSON et un
corps d'au plus 64 KiB borné pendant le streaming. Les redirections sont
interdites. Un 401, 403, 429, timeout, JSON invalide ou contrat divergent
produit uniquement le code stable `HELIUS_PROVIDER_EVIDENCE_FAILED`.

## 7. Signature et écriture

Le payload est sérialisé par `canonicalStringifyJson`, puis signé en Ed25519.
L'enveloppe possède exactement :

```json
{
  "payloadVersion": 1,
  "algorithm": "Ed25519",
  "signedPayloadBase64": "<payload canonique>",
  "signatureBase64": "<signature>"
}
```

Avant écriture, H2e vérifie localement l'enveloppe avec la clé publique dérivée
et le vérificateur H2d existant. La sortie est créée dans le même répertoire via
un fichier temporaire exclusif `0600`, synchronisée, puis renommée atomiquement.
Un symlink ou un fichier appartenant à un autre utilisateur est refusé.

## 8. Manifeste redacted

Le document stdout expose seulement :

- `schemaVersion=helius-provider-evidence.v1` ;
- `state=PROVIDER_EVIDENCE_COLLECTED` ;
- `providerId` ;
- fingerprint du projet ;
- identifiant et fingerprint du snapshot ;
- dates de mesure et d'expiration ;
- clé publique SPKI DER base64 de l'attestation ;
- `CANARY_NOT_STARTED` et `NON_EXECUTED_NON_VALIDATED`.

Il n'expose jamais la clé API, la clé privée, leur chemin, l'URL appelée, le
projet UUID, le plan, les quotas détaillés ou une erreur brute.

## 9. Tests et acceptation

- parsing exact de la configuration et rejet des noms wallet/live ;
- droits, ownership, taille et type des fichiers secrets ;
- réponse Helius valide, limites numériques et dérive de schéma ;
- timeout, redirection, 429, corps trop grand et streaming borné ;
- conversion exacte des crédits et dates de cycle ;
- signature canonique vérifiée par le code H2d ;
- écriture atomique `0600`, refus des symlinks et manifeste redacted ;
- test d'architecture prouvant l'absence des imports live/wallet/DB ;
- build, check, lint, tests et documentation verts.

Le succès de H2e ne vaut ni `PASS` H2c, ni armement, ni autorisation de charger
le wallet. L'étape suivante reste H2d sur Mainnet, puis les onze preuves H2c et
le checkpoint humain exact avant toute signature Solana.
