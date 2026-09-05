# Executor Simulation Database Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provisionner et prouver l'autorité PostgreSQL minimale permettant aux modes `dry-run` et `simulation-only` de fonctionner sans aucune capacité live.

**Architecture:** Étendre le script administratif rejouable avec une reconstruction fermée de `sol_token_executor_worker`, puis tester l'autorité effective sous un login `NOINHERIT` mono-membre. Réutiliser les processus compilés et le serveur RPC simulé existants pour prouver les deux flux réels sans keypair, signature ni soumission.

**Tech Stack:** TypeScript strict ESM, Node test runner, PostgreSQL 16, SQL ACL par colonne, processus Node compilé, RPC Solana simulé.

---

### Task 1: Spécifier l'autorité effective par des tests rouges

**Files:**
- Create: `tests/executor-worker-database-authority.test.ts`
- Modify: `tests/executor-roles-provisioning.test.ts`

- [ ] **Step 1: Ajouter le test statique de l'allowlist**

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

- [ ] **Step 2: Ajouter le test PostgreSQL 16 réel**

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

- [ ] **Step 3: Étendre les processus d'intégration au login dédié**

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

- [ ] **Step 4: Exécuter les tests et constater l'échec attendu**

Run:
```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" node --import tsx --test \
  tests/executor-worker-database-authority.test.ts \
  tests/executor-roles-provisioning.test.ts
```

Expected: FAIL parce que `sol_token_executor_worker` ne possède encore aucun
privilège positif.

### Task 2: Implémenter le provisioning fermé du worker

**Files:**
- Modify: `scripts/provision-executor-roles.sql`
- Test: `tests/executor-worker-database-authority.test.ts`

- [ ] **Step 1: Reconstruire le rôle depuis zéro**

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

- [ ] **Step 2: Accorder uniquement les colonnes nécessaires**

Émettre des `GRANT SELECT (...)`, `INSERT (...)` et `UPDATE (...)` séparés
pour `execution_intents`, `execution_dry_run_assessments`,
`execution_attempts`, `execution_intent_transitions` et
`execution_simulation_artifacts`, puis deux `SELECT (...)` pour `migrations`
et `market_pools`.

```sql
GRANT USAGE ON SEQUENCE execution_intent_transitions_sequence_seq
TO sol_token_executor_worker;
```

- [ ] **Step 3: Vérifier les tests ciblés verts**

Run:
```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" node --import tsx --test \
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

- [ ] **Step 1: Monter les versions normatives**

Passer la spécification parent à `1.11.16`, la spécification canary à
`1.2.14`, ajouter leur historique et faire vérifier ces chaînes exactes par le
test d'intégration documentaire.

- [ ] **Step 2: Documenter l'exploitation**

Décrire le login externe `0600`, l'option
`role=sol_token_executor_worker`, l'absence de migration automatique et les
deux commandes non signantes. Maintenir explicitement
`CANARY_NOT_STARTED`.

- [ ] **Step 3: Lancer tous les critères de qualité**

Run:
```bash
npm run build && npm run check && npm run lint && npm test && npm run docs:check
```

Expected: PASS avec 0 test en échec.

- [ ] **Step 4: Revue et livraison**

Relire le diff, exécuter `git diff --check`, pousser la branche, ouvrir une PR
H2j dépendante de #85, demander au plus trois cycles Codex, résoudre les fils
valides et fusionner uniquement avec les trois jobs CI verts.
