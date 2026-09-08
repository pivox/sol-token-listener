# Executor Readiness Lock Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre le commit H2d exécutable par son rôle PostgreSQL dédié sans lui accorder de privilège `UPDATE`, tout en conservant la sérialisation et l'atomicité du bootstrap.

**Architecture:** Le mutex advisory transactionnel `hashtextextended(generationId, 51005)` reste l'unique verrou causal de génération et précède la validation de l'état risque. Le `SELECT ... FOR UPDATE` redondant est remplacé par un `SELECT` ordinaire. Les tests couvrent le repository réellement utilisé par readiness, le login PostgreSQL fermé et deux commits concurrents du même bootstrap.

**Tech Stack:** TypeScript strict ESM, Node.js 22, PostgreSQL 16, `pg`, `node:test` via `tsx`.

---

## Structure des fichiers

- `tests/executor-roles-provisioning.test.ts` : garde statique sur les lectures readiness compatibles avec les ACL exactes.
- `tests/executor-readiness-database.test.ts` : preuve PostgreSQL 16 de verrouillage, commit et refus de mutation avec le rôle dédié.
- `tests/execution-readiness.repository.test.ts` : preuve de sérialisation et rejeu concurrent du même bootstrap.
- `src/storage/execution-readiness.repository.ts` : validation de l'état initial sous mutex generation, sans row lock.
- `docs/superpowers/specs/2026-09-05-executor-readiness-bootstrap-design.md` : contrat H2d version 1.0.12.
- `docs/operations/executor-live-canary.md` : procédure opérateur version 1.17.2.

### Task 1: Reproduire l'incompatibilité d'autorité

**Files:**
- Modify: `tests/executor-roles-provisioning.test.ts`
- Modify: `tests/executor-readiness-database.test.ts`

- [ ] **Step 1: Pointer la garde statique vers le repository readiness**

Lire `src/storage/execution-readiness.repository.ts` dans le test de provisioning et vérifier que `execution_wallet_risk_state` n'est jamais ciblée par `FOR UPDATE`.

- [ ] **Step 2: Ajouter la preuve PostgreSQL réelle**

Dans le test du login readiness, insérer une génération et son état initial avec l'administrateur, puis exécuter sous `SET ROLE sol_token_executor_readiness` :

```sql
BEGIN;
SELECT state_revision
FROM execution_wallet_risk_state
WHERE generation_id=$1;
ROLLBACK;
```

Vérifier séparément que l'instruction suivante échoue avec `42501` :

```sql
UPDATE execution_wallet_risk_state
SET payload_version=1
WHERE generation_id=$1;
```

- [ ] **Step 3: Vérifier RED**

Run: `TEST_DATABASE_URL=<postgres16-admin-url> npx tsx --test tests/executor-roles-provisioning.test.ts tests/executor-readiness-database.test.ts`

Expected: FAIL sur la présence actuelle de `FOR UPDATE` dans le repository readiness.

### Task 2: Corriger le verrou redondant

**Files:**
- Modify: `src/storage/execution-readiness.repository.ts`

- [ ] **Step 1: Appliquer le changement minimal**

Remplacer uniquement :

```sql
FROM execution_wallet_risk_state WHERE generation_id=$1 FOR UPDATE
```

par :

```sql
FROM execution_wallet_risk_state WHERE generation_id=$1
```

- [ ] **Step 2: Vérifier GREEN**

Run: `TEST_DATABASE_URL=<postgres16-admin-url> npx tsx --test tests/executor-roles-provisioning.test.ts tests/executor-readiness-database.test.ts`

Expected: PASS, avec le rôle readiness toujours incapable d'exécuter `UPDATE`.

### Task 3: Prouver la concurrence et le rejeu

**Files:**
- Modify: `tests/execution-readiness.repository.test.ts`

- [ ] **Step 1: Ajouter le test concurrent**

Exécuter deux `commit(input)` concurrents sur le même repository et le même input, puis vérifier exactement une génération, un état risque, un snapshot wallet et un snapshot provider.

- [ ] **Step 2: Vérifier le test ciblé**

Run: `TEST_DATABASE_URL=<postgres16-admin-url> npx tsx --test tests/execution-readiness.repository.test.ts`

Expected: PASS avec les deux promesses résolues sur le même commit canonique.

### Task 4: Vérification, revue et livraison

**Files:**
- Verify: all modified files

- [ ] **Step 1: Exécuter la validation locale complète**

Run: `npm run build && npm run check && npm run lint && TEST_DATABASE_URL=<postgres16-admin-url> npm test && npm run docs:check`

Expected: toutes les commandes PASS ; les tests PostgreSQL ne sont pas ignorés.

- [ ] **Step 2: Effectuer au maximum deux cycles de revue**

Premier cycle : exactitude concurrence/ACL. Deuxième cycle seulement après correction d'un constat bloquant ou important.

- [ ] **Step 3: Créer et fusionner une PR séparée**

La PR ne modifie ni migration, ni provisioning, ni capacité live. Après CI verte et revue sans blocage, fusionner puis rejouer H2e/H2d avec une attestation fraîche.
