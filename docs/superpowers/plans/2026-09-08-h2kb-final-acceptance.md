# H2k-b Final Acceptance Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aligner les contrats et tests H2k-b sur le head 043 et obtenir une matrice d'acceptation entièrement verte sans démarrer le canary.

**Architecture:** Les corrections restent dans les contrats de test et les documents versionnés. Les frontières runtime ne gagnent aucune capacité wallet, signature, armement ou soumission ; le contrôle temporel produit reste fail-closed.

**Tech Stack:** TypeScript strict, Node test runner, PostgreSQL 16, Markdown versionné.

---

### Task 1: Stabiliser l'horloge de la fixture H2c

**Files:**
- Modify: `tests/execution-operations.repository.test.ts`

- [x] **Step 1: Ajouter une mesure RED à la frontière Node/PostgreSQL**

```ts
assert.equal(qualification.qualifiedAtMs <= databaseNowMs, true);
```

- [x] **Step 2: Observer la dérive**

Run: `TEST_DATABASE_URL=... npx tsx --test --test-concurrency=1 tests/execution-operations.repository.test.ts`

Expected: FAIL montrant `qualifiedAtMs = databaseNowMs + 1`.

- [x] **Step 3: Utiliser l'horloge PostgreSQL dans la fixture**

```ts
const nowMs = Number((await pool.query(
  "SELECT trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS database_now_ms",
)).rows[0]?.database_now_ms);
```

- [x] **Step 4: Vérifier deux passages complets**

Expected: 20/20 puis 20/20.

### Task 2: Aligner les garde-fous d'acceptation

**Files:**
- Modify: `tests/execution-preflight-intent-pair-migration.test.ts`
- Modify: `tests/execution-preflight-intent-preparation-migration.test.ts`
- Modify: `tests/helpers/execution-boundary.ts`
- Modify: `tests/executor-roles-provisioning.test.ts`

- [x] **Step 1: Conserver les assertions spécifiques 041/042 et attendre le head 043**
- [x] **Step 2: Autoriser uniquement le validateur causal local dans le graphe H2k-b**
- [x] **Step 3: Distinguer les grants par colonne des grants table-wide interdits**
- [x] **Step 4: Exécuter les tests ciblés et le lint**

Expected: tests ciblés, check et lint verts.

### Task 3: Versionner le constat de livraison H2k-b

**Files:**
- Modify: `docs/superpowers/specs/2026-09-05-executor-canary-intent-pair-design.md`
- Modify: `tests/executor-live-main.integration.test.ts`

- [x] **Step 1: Mettre la spec H2k en version 1.3.0**
- [x] **Step 2: Remplacer les formulations futures par le contrat livré, OFF par défaut**
- [x] **Step 3: Conserver explicitement `CANARY_NOT_STARTED` et l'absence de wallet**
- [x] **Step 4: Aligner le test documentaire sur les versions courantes**
- [x] **Step 5: Exécuter le test documentaire et `docs:check`**

Expected: documentation cohérente et tests verts.

### Task 4: Valider et livrer la branche

**Files:**
- Modify: `docs/checkpoints/2026-09-08-h2kb-final-review-fixes.md`

- [x] **Step 1: Exécuter build, check, lint, docs et diff-check**
- [x] **Step 2: Exécuter les tests backend/frontend et PostgreSQL 16**
- [x] **Step 3: Mettre à jour le checkpoint avec les preuves finales**
- [ ] **Step 4: Commit, push, CI verte et fusion sans troisième cycle de revue**

Expected: H2k-b fusionné, canary toujours non démarré.
