# Executor Simulation Database Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provisionner et prouver l'autorité PostgreSQL minimale permettant aux modes `dry-run` et `simulation-only` de fonctionner sans aucune capacité live.

**Architecture:** Étendre le script administratif rejouable avec une reconstruction fermée de `sol_token_executor_worker`, puis tester l'autorité effective sous un login `NOINHERIT` mono-membre. Réutiliser les processus compilés et le serveur RPC simulé existants pour prouver les deux flux réels sans keypair, signature ni soumission.

**Tech Stack:** TypeScript strict ESM, Node test runner, PostgreSQL 16, SQL ACL par colonne, processus Node compilé, RPC Solana simulé.

---

### Task 1: Spécifier l'autorité effective par des tests rouges

**Files:**
- Create: `tests/executor-worker-database-authority.test.ts`
- Modify: `tests/executor-main.integration.test.ts`
- Modify: `.github/workflows/ci.yml`

- [x] **Step 1: Ajouter le test statique de l'allowlist**

Lire `scripts/provision-executor-roles.sql` et exiger : remise à zéro du rôle,
ACL de colonnes sur les cinq tables d'exécution autorisées, lectures bornées de
`migrations` et `market_pools`, et seule séquence
`execution_intent_transitions_sequence_seq`.

```ts
assert.match(sql,
  /ALTER ROLE sol_token_executor_worker NOLOGIN NOSUPERUSER NOCREATEDB\s+NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/iu);
assert.doesNotMatch(executable,
  /GRANT\s+(?:ALL|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*TO\s+sol_token_executor_worker/iu);
```

- [x] **Step 2: Ajouter le test PostgreSQL 16 réel**

Créer une base isolée, appliquer les migrations, injecter des droits directs,
`PUBLIC`, default ACL, parent et propriété, rejouer le provisioning puis créer
un login `NOINHERIT` mono-membre. Vérifier chaque privilège avec
`has_column_privilege`, `has_sequence_privilege`, `has_schema_privilege` et
les catalogues.

```ts
listenerUrl.searchParams.set(
  'options',
  '-c role=sol_token_executor_worker -c search_path=pg_catalog,public',
);
assert.equal((await worker.query('SELECT current_user AS role')).rows[0]?.role,
  'sol_token_executor_worker');
```

- [x] **Step 3: Étendre les processus d'intégration au login dédié**

Dans le test réel, produire une intention via la connexion administrative,
lancer d'abord le processus compilé `dry-run`, puis une seconde intention et
le processus `simulation-only` avec `startScriptedPumpFunBuyRpc`. Attendre
l'assessment et l'artefact, puis vérifier qu'aucune méthode de soumission RPC
n'a été appelée.

```ts
assert.equal(rpc.methods.includes('sendTransaction'), false);
assert.equal(rpc.methods.includes('sendRawTransaction'), false);
assert.equal(rpc.simulatedTransactionWasUnsigned(), true);
```

- [x] **Step 4: Exécuter les tests et constater l'échec attendu**

Run:
```bash
TEST_EXECUTOR_ROLE_DATABASE_URL="$TEST_EXECUTOR_ROLE_DATABASE_URL" node --import tsx --test \
  tests/executor-worker-database-authority.test.ts \
  tests/executor-roles-provisioning.test.ts
```

Expected: FAIL parce que `sol_token_executor_worker` ne possède encore aucun
privilège positif.

### Task 2: Implémenter le provisioning fermé du worker

**Files:**
- Modify: `scripts/provision-executor-roles.sql`
- Modify: `src/storage/execution-intent.repository.ts`
- Test: `tests/executor-worker-database-authority.test.ts`

- [x] **Step 1: Reconstruire le rôle depuis zéro**

Ajouter les blocs `worker_parameter_acl`, `worker_parents`, `worker_schemas`,
`worker_types`, `worker_database_acl`, `worker_language_acl`,
`worker_default_acl`, `worker_columns` et `worker_ownership_guard` sur le même
modèle fermé que H2i. Révoquer aussi l'autorité héritée de `PUBLIC` avant les
grants positifs.

```sql
ALTER ROLE sol_token_executor_worker NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO sol_token_executor_worker;
```

- [x] **Step 2: Accorder uniquement les colonnes nécessaires**

Émettre des `GRANT SELECT (...)`, `INSERT (...)` et `UPDATE (...)` séparés
pour `execution_intents`, `execution_dry_run_assessments`,
`execution_attempts`, `execution_intent_transitions` et
`execution_simulation_artifacts`, puis deux `SELECT (...)` pour `migrations`
et `market_pools`.

```sql
GRANT USAGE ON SEQUENCE execution_intent_transitions_sequence_seq
TO sol_token_executor_worker;
```

- [x] **Step 3: Vérifier les tests ciblés verts**

Run:
```bash
TEST_EXECUTOR_ROLE_DATABASE_URL="$TEST_EXECUTOR_ROLE_DATABASE_URL" node --import tsx --test \
  tests/executor-worker-database-authority.test.ts \
  tests/executor-main.integration.test.ts \
  tests/execution-intent.repository.test.ts \
  tests/execution-dry-run.repository.test.ts \
  tests/execution-simulation.repository.test.ts \
  tests/execution-venue.repository.test.ts
```

Expected: PASS, zéro skip pour le test d'autorité et les deux processus
compilés.

### Task 3: Versionner les contrats et livrer la PR

**Files:**
- Modify: `docs/superpowers/specs/2026-08-30-executor-v1-design.md`
- Modify: `docs/superpowers/specs/2026-08-31-executor-live-canary-design.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/operations/executor-live-canary.md`
- Modify: `docs/system-overview.html`
- Modify: `tests/executor-live-main.integration.test.ts`

- [x] **Step 1: Monter les versions normatives**

Passer la spécification parent à `1.11.16`, la spécification canary à
`1.2.14`, ajouter leur historique et faire vérifier ces chaînes exactes par le
test d'intégration documentaire.

- [x] **Step 2: Documenter l'exploitation**

Décrire le login externe `0600`, l'option
`role=sol_token_executor_worker`, l'absence de migration automatique et les
deux commandes non signantes. Maintenir explicitement
`CANARY_NOT_STARTED`.

- [x] **Step 3: Lancer tous les critères de qualité**

Run:
```bash
npm run build && npm run check && npm run lint && npm test && npm run docs:check
```

Expected: PASS avec 0 test en échec.

- [ ] **Step 4: Revue et livraison**

Relire le diff, exécuter `git diff --check`, pousser la branche, ouvrir une PR
H2j dépendante de #85, demander au plus deux cycles Codex, résoudre les fils
valides et fusionner uniquement avec les trois jobs CI verts.

### Task 4: Isoler les lignes réservées au live (correction P1)

**Files:**
- Create: `migrations/040_execution_worker_live_partition.sql`
- Create: `tests/execution-worker-live-partition-migration.test.ts`
- Modify: `scripts/provision-executor-roles.sql`
- Modify: `src/storage/execution-intent.repository.ts`
- Modify: `src/storage/execution-operations.repository.ts`
- Modify: `src/storage/execution-live.repository.ts`
- Modify: `tests/executor-worker-database-authority.test.ts`
- Modify: `tests/execution-intent.repository.test.ts`
- Modify: `tests/execution-operations.repository.test.ts`
- Modify: `tests/execution-live.repository.test.ts`
- Modify: `tests/copy-migrations.test.ts`
- Modify: `docs/superpowers/specs/2026-08-30-executor-v1-design.md`
- Modify: `docs/superpowers/specs/2026-08-31-executor-live-canary-design.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/operations/executor-live-canary.md`
- Modify: `docs/system-overview.html`
- Modify: `tests/executor-live-main.integration.test.ts`

- [ ] **Step 1: Écrire les preuves rouges de partition et de migration**

Ajouter une migration-test PostgreSQL 16 qui applique 001–039, peuple chacune
des racines live historiques (armement cible/lock, lock pré-signature,
transaction signée, BUY/SELL de position live et autorisation de sortie), puis
applique 040. Exiger le backfill `live_reserved=true` du parent et des quatre
tables enfants, `false` pour les lignes non live, la monotonie `false -> true`,
les cinq tables avec RLS activée sans FORCE, et une application réussie avant
la création de `sol_token_executor_worker`.

Étendre le test du login dédié pour prouver qu'un membre worker sous `SET ROLE`
ne peut ni lire, louer, terminaliser, insérer un enfant, ni modifier une ligne
live. Couvrir aussi une course réelle entre insertion enfant et promotion : le
résultat doit être sérialisé, sans enfant `false` rattaché à un parent `true`.

Run:
```bash
TEST_EXECUTOR_ROLE_DATABASE_URL="$TEST_EXECUTOR_ROLE_DATABASE_URL" \
  node --import tsx --test \
  tests/execution-worker-live-partition-migration.test.ts \
  tests/executor-worker-database-authority.test.ts
```

Expected: FAIL parce que la migration 040, les policies et les guards
n'existent pas encore.

- [ ] **Step 2: Écrire les preuves rouges des transactions métier**

Dans les tests repositories, exiger que `armCanary()` verrouille et revalide le
BUY pristine, le promeuve avant l'admission, propage le marqueur aux enfants et
annule toute la promotion si l'admission ou la publication échoue. Exiger que
`createDeadlineExitIntentLocked()` crée et rejoue le SELL avec
`live_reserved=true`. Enfin, prouver que `DRY_RUN` et `EXECUTE` ne claim que
`false`, tandis que `LIVE_EXECUTE`, `LIVE_RECOVER`, `CONFIRM` et `RECONCILE` ne
claim que `true`.

Run:
```bash
node --import tsx --test \
  tests/execution-intent.repository.test.ts \
  tests/execution-operations.repository.test.ts \
  tests/execution-live.repository.test.ts
```

Expected: FAIL sur les nouveaux invariants `live_reserved`.

- [ ] **Step 3: Implémenter la migration 040 et fermer le provisioning**

Ajouter `live_reserved BOOLEAN NOT NULL DEFAULT FALSE` aux cinq tables. Faire
le backfill des racines live et de leurs enfants avant d'activer RLS. Installer
une policy permissive pour les rôles ordinaires et une policy restrictive dont
la détection de membership utilise `session_user`, l'OID optionnel de
`sol_token_executor_worker` et `pg_has_role`. Ne pas activer FORCE RLS.

Créer les guards enfants `SECURITY DEFINER` avec `search_path` fermé, révoquer
leur exécution à `PUBLIC`, et ne laisser le chemin worker verrouiller qu'un
parent `NOT live_reserved`. Étendre le provisioning rejouable afin de révoquer
toute autorité sur les nouvelles fonctions/colonnes puis n'accorder au worker
que la lecture de `live_reserved` nécessaire à ses projections ; ne jamais lui
accorder sa mutation.

Run:
```bash
npm run build && npm run check && npm run lint
TEST_EXECUTOR_ROLE_DATABASE_URL="$TEST_EXECUTOR_ROLE_DATABASE_URL" \
  node --import tsx --test \
  tests/execution-worker-live-partition-migration.test.ts \
  tests/executor-worker-database-authority.test.ts \
  tests/executor-roles-provisioning.test.ts
```

Expected: PASS, sans skip pour les tests PostgreSQL dédiés.

- [ ] **Step 4: Rendre promotion, SELL et claims transactionnels**

Ajouter `live_reserved` aux projections strictes et aux requêtes de claim.
Filtrer les claims non signants sur `false` et tous les claims live/recovery sur
`true`. Dans `armCanary()`, promouvoir le BUY après son lock et sa revalidation
pristine, avant l'admission ; l'opération reste dans la transaction existante.
Dans `createDeadlineExitIntentLocked()`, insérer le SELL directement réservé et
refuser un rejeu dont le marqueur diverge.

Run:
```bash
node --import tsx --test \
  tests/execution-intent.repository.test.ts \
  tests/execution-operations.repository.test.ts \
  tests/execution-live.repository.test.ts \
  tests/execution-dry-run.repository.test.ts \
  tests/execution-simulation.repository.test.ts
```

Expected: PASS, incluant les rollbacks atomiques et les claims par purpose.

- [ ] **Step 5: Versionner les contrats et documenter le risque résiduel**

Monter d'un patch les spécifications parent et canary, consigner l'historique
H2j P1, puis aligner architecture, runbook, vue système et assertions de
versions. Documenter que le worker ne voit et n'altère jamais une ligne live,
que l'administrateur/migrateur conserve son bypass, et qu'un déni de service
pré-promotion reste possible mais ne donne aucune capacité de signature ou de
soumission.

Run:
```bash
npm run docs:check
node --import tsx --test tests/executor-live-main.integration.test.ts
```

Expected: PASS avec les nouvelles versions exactes et `CANARY_NOT_STARTED`.

- [ ] **Step 6: Valider et terminer le cycle Codex 2/2**

Exécuter les tests PostgreSQL ciblés avec la base jetable dédiée, puis la suite
standard sans URL de test héritée afin d'éviter toute base implicite.

Run:
```bash
TEST_EXECUTOR_ROLE_DATABASE_URL="$TEST_EXECUTOR_ROLE_DATABASE_URL" \
  node --import tsx --test \
  tests/execution-worker-live-partition-migration.test.ts \
  tests/executor-worker-database-authority.test.ts \
  tests/executor-main.integration.test.ts
env -u TEST_DATABASE_URL -u TEST_EXECUTOR_ROLE_DATABASE_URL npm test
npm run build && npm run check && npm run lint && npm run docs:check
git diff --check
```

Expected: PASS intégral, aucune clé chargée, aucune signature et aucune méthode
de soumission appelée. Pousser la correction P1, demander le dernier cycle
Codex autorisé (2/2), résoudre uniquement les fils valides puis fusionner quand
les trois jobs CI sont verts et tous les fils bloquants résolus.
