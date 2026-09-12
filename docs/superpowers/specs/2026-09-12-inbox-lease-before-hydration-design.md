# Lease de l’inbox avant hydratation

**Version :** 1.0.0 — 2026-09-12

## Contexte

Le worker démarrait son `LeaseGuard` après le locator et la sauvegarde du
snapshot. Une hydratation RPC lente pouvait donc laisser expirer le lease
avant toute tentative de renouvellement. Les branches d’échec utilisaient
un renouvellement ponctuel distinct, sans protection pendant l’hydratation.

## Décision

Un seul `LeaseGuard` commence immédiatement après la validation du claim,
avant le locator, la restauration/projection du snapshot et toute persistance
d’échec. La branche existante de snapshot corrompu utilise également ce guard
avant de persister `NORMALIZATION_FAILED`.

Le renouvellement initial doit réussir et le timer doit être installé avant
l’hydratation. Les renouvellements périodiques restent actifs pendant le
locator, la projection, la sauvegarde du snapshot et le pipeline. Un checkpoint
d’autorité attend tout renouvellement en cours après le locator, avant la
sauvegarde du snapshot et avant le pipeline. Une perte de lease déjà constatée
interdit ces opérations et retourne `lease-lost`.

Chaque checkpoint compare aussi l’horloge locale validée à l’expiration
renouvelée connue. Si l’event loop ou le garbage collector est resté bloqué
jusqu’à cette expiration, le guard tente un renouvellement synchrone avant de
continuer. Un token entre-temps repris est donc refusé avant le snapshot ou le
pipeline ; un token toujours possédé repart avec une nouvelle durée complète.
Le renouvellement synchrone et le callback de timer partagent une seule promesse
single-flight. Le checkpoint annule d’abord son timer planifié ; même si un
callback déjà en file s’exécute, il rejoint la même décision d’autorité au lieu
d’ouvrir un second renouvellement concurrent. `finish()` mémorise cette
décision et reste strictement idempotent.

Les erreurs du locator et de normalisation utilisent le guard vivant : elles
ne démarrent aucun renouvellement ponctuel de rattrapage. Avant une écriture
terminale, `finish()` annule le timer, attend le renouvellement en cours et
vérifie l’autorité. Une erreur du locator garde sa classification interne
de confiance si le lease reste possédé ; sinon aucune erreur n’est persistée.
La même règle s’applique aux erreurs du pipeline et à `markProcessed`.

Un `finally` clôture le guard sur toutes les sorties, y compris les exceptions
de persistance. `finish()` reste idempotent. `close()` attend l’opération en
cours, y compris une hydratation bloquée ; il ne désactive pas prématurément
son renouvellement. Les erreurs de scheduler et d’annulation conservent leurs
états dégradés existants.

## Invariants et limites

- Une perte de lease pendant l’hydratation ou la projection n’écrit ni snapshot,
  ni échec, ni état traité, et n’appelle pas le pipeline.
- Les opérations de repository restent clôturées par le token de lease.
  Un checkpoint local ne remplace pas cette autorité atomique côté stockage.
- Une perte pendant une écriture ou un pipeline déjà commencé n’annule pas
  rétroactivement leurs effets ; leur idempotence existante permet la reprise.
- L’instant durable `observedAtMs`, la promotion de finalité, les snapshots
  réutilisés et la sérialisation de `runOnce()` ne changent pas.

## Hors périmètre

Aucune migration, nouveau paramètre, modification du locator, du wallet,
de l’exécution live ou de la taxonomie d’échec. Aucun changement de politique
de retry ou de finalité.

## Vérification

Les tests déterministes vérifient l’ordre claim → renewal → locator → snapshot
→ pipeline, le renouvellement pendant un locator bloqué, la perte de lease
pendant le locator et la projection, l’attente d’un renouvellement en cours
avant le snapshot, la classification de confiance sans renouvellement séparé,
et le nettoyage du timer en cas de réussite, d’échec ou de fermeture.
