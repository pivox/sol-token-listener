# Executor Readiness Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre plusieurs collectes H2d immuables et fraîches pour une même génération et une même révision de risque, sans élargir l'autorité readiness.

**Architecture:** La migration 045 remplace l'unicité historique `(generation_id, state_revision)` par l'unicité partielle du snapshot actif par génération. Le primitive d'append conserve le replay par identifiant, refuse toute régression de révision ou de temps, supersède l'actif avant l'insert dans la même transaction et laisse PostgreSQL garantir l'unicité concurrente.

**Tech Stack:** TypeScript strict ESM, PostgreSQL 16, `pg`, Node.js 22 test runner, migrations SQL rejouables.

---

## Structure des fichiers

- `migrations/045_execution_wallet_snapshot_refresh.sql` : évolution rejouable de l'unicité des snapshots wallet.
- `src/storage/execution-risk.repository.ts` : ordre total, garde de fraîcheur et supersession atomique.
- `src/executor-readiness/database.ts` : refus précoce de tout schéma antérieur à 045.
- `tests/execution-risk.repository.test.ts` : comportement RED/GREEN du primitive partagé.
- `tests/execution-readiness.repository.test.ts` : deux bootstraps frais à risque inchangé.
- `tests/execution-wallet-snapshot-refresh-migration.test.ts` : base vide, upgrade 044→045, replay et catalogue.
- `src/execution-migrations/live-catalog.ts` et validateurs/tests de tête : catalogue exact 045.
- `docs/superpowers/specs/2026-09-05-executor-readiness-bootstrap-design.md` et `docs/operations/executor-live-canary.md` : contrat opérateur versionné.

### Task 1: Prouver le défaut de refresh

- [ ] Modifier `tests/execution-risk.repository.test.ts` pour attendre qu'un second snapshot de même `stateRevision`, avec `observedAtMs` et slot supérieurs, réussisse, supersède le premier et conserve les deux lignes.
- [ ] Modifier `tests/execution-readiness.repository.test.ts` pour committer deux entrées H2d distinctes de génération 1 et révision 0, puis vérifier deux snapshots wallet, deux snapshots provider et un seul actif de chaque type.
- [ ] Avec `TEST_DATABASE_URL` déjà injectée depuis le secret PostgreSQL 16 hors Git, exécuter `npx tsx --test tests/execution-risk.repository.test.ts tests/execution-readiness.repository.test.ts` et constater l'échec `CONFLICT` dû à l'unicité actuelle.

### Task 2: Migrer l'invariant d'unicité

- [ ] Créer `migrations/045_execution_wallet_snapshot_refresh.sql` qui vérifie au plus un snapshot actif par génération, supprime `execution_wallet_snapshots_generation_revision_unique`, puis crée `execution_wallet_snapshots_current_generation_unique ON execution_wallet_snapshots(generation_id) WHERE superseded_at IS NULL`.
- [ ] Créer `tests/execution-wallet-snapshot-refresh-migration.test.ts` avant la migration afin de vérifier l'échec initial, puis couvrir application sur base vide, upgrade depuis 044, replay SQL et forme exacte des index/contraintes.
- [ ] Exécuter le test de migration et vérifier son passage après l'ajout SQL.

### Task 3: Rendre l'append frais, immuable et concurrent

- [ ] Dans `appendWalletSnapshotInTransaction`, sélectionner le snapshot actif avec l'ordre `state_revision DESC, observed_at DESC, snapshot_id DESC`.
- [ ] Autoriser une révision égale seulement lorsque `draft.observedAtMs` est strictement supérieur ; refuser une révision inférieure et tout temps non croissant.
- [ ] Superséder l'actif avant l'insert, dans la même transaction, afin de respecter l'index partiel ; le rollback restaure l'actif si l'insert échoue.
- [ ] Ajouter les tests RED puis GREEN pour replay exact, snapshot égal plus récent, égal non plus récent, révision inférieure, rollback injecté et deux refreshs concurrents.
- [ ] Exécuter les tests ciblés PostgreSQL et obtenir zéro échec.

### Task 4: Aligner la tête de migration et la documentation

- [ ] Ajouter 045 avec son SHA-256 au catalogue live, puis remplacer uniquement les assertions de tête 044 par 045 ; conserver 044 dans tous les inventaires historiques ordonnés.
- [ ] Faire vérifier explicitement la présence de 045 par l'autorité H2d et adapter son test fermé, afin qu'un binaire neuf refuse un schéma 044 avant toute écriture.
- [ ] Vérifier les versions 1.0.14 et 1.17.6, sans promesse de trade ni changement d'autorité.
- [ ] Exécuter `npm run build:backend`, `npm run check:backend`, `npm run lint:backend`, les tests de migration et `npm run docs:check`.

### Task 5: Vérifier et livrer

- [ ] Exécuter la suite complète avec PostgreSQL 16, vérifier les migrations sur schéma vide et l'upgrade réel 044→045.
- [ ] Faire deux cycles de revue maximum : cycle 1 sur invariants/concurrence/migration, cycle 2 après correction des seuls constats importants.
- [ ] Ouvrir une PR liée à #98, attendre la CI verte, fusionner, mettre à jour le checkout opérationnel exact-main, appliquer 045 et rejouer le provisioning deux fois.
- [ ] Régénérer H2e puis exécuter H2d deux fois pour prouver refresh et replay sans wallet secret.
