# Executor Live Durable Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer #51-H1 avec des primitives PostgreSQL fermées permettant à un futur runtime live de réclamer séparément BUY, SELL et récupération, de relire les travaux de confirmation/réconciliation et de créer atomiquement les sorties arrivées à échéance, sans ajouter de capacité RPC, cryptographique ou de soumission.

**Architecture:** Les ports exposent des options de claim discriminées et des read-models minimaux construits exclusivement depuis le ledger verrouillé. PostgreSQL impose la priorité SELL, l'affinité provider, les fences de lease et l'unicité des sorties de deadline. Le comportement simulation-only existant reste compatible ; aucun entrypoint live n'est publié.

**Tech Stack:** TypeScript strict ESM, Node.js, PostgreSQL, `node:test`, migrations SQL rejouables, calculs financiers en `bigint`.

**Normative design:** `docs/superpowers/specs/2026-09-01-executor-live-orchestration-design.md` version 1.0.0, parent version 1.7.13, live foundation version 1.0.13.

---

### Task 1: Fermer le contrat de claim et ajouter la migration 037

**Files:**
- Modify: `src/ports/execution-intent-repository.ts`
- Create: `migrations/037_execution_live_orchestration.sql`
- Create: `tests/execution-live-orchestration-migration.test.ts`
- Modify: `tests/execution-intent-repository-contract.test.ts`
- Modify: `tests/wallet-graph-migration.test.ts`
- Modify: `tests/transaction-inbox-retry-migration.test.ts`
- Modify: `tests/execution-intent-migration.test.ts`

- [ ] **Step 1: Write failing contract and migration tests**

Assert the discriminated `ExecutionClaimOptions` surface, exact migration name,
partial `(side, requested_at, id)` index restricted to live-executable statuses,
empty-database application and clean replay. Update migration-head assertions to
037 only in tests that intentionally verify the complete catalogue.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot \
  npx tsx --test tests/execution-live-orchestration-migration.test.ts \
  tests/execution-intent-repository-contract.test.ts
```

Expected: FAIL because migration 037 and the new claim options do not exist.

- [ ] **Step 3: Implement the minimal port and additive migration**

Export `ExecutionClaimOptions` exactly as the normative design specifies. Keep
the legacy purposes side-free and add only an idempotent partial index; do not
alter financial tables or existing rows.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2 and the three migration-catalogue tests. Expected:
PASS with PostgreSQL integration tests executed, not skipped.

- [ ] **Step 5: Commit**

```bash
git add src/ports/execution-intent-repository.ts migrations/037_execution_live_orchestration.sql tests
git commit -m "feat: define live execution claims (#51)"
```

### Task 2: Implémenter les claims PostgreSQL par lane

**Files:**
- Modify: `src/storage/execution-intent.repository.ts`
- Modify: `tests/execution-intent.repository.test.ts`

- [ ] **Step 1: Write failing PostgreSQL claim tests**

Cover `LIVE_EXECUTE/SELL`, `LIVE_EXECUTE/BUY`, global SELL blocking including an
already leased SELL, deterministic order, concurrent uniqueness,
`LIVE_RECOVER` restricted to `SIGNED_NOT_SUBMITTED`, and `RECONCILE` excluding
that status. Preserve `EXECUTE`, `CONFIRM`, `RECONCILE` and `DRY_RUN` tests.

- [ ] **Step 2: Run the repository test and verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot \
  npx tsx --test tests/execution-intent.repository.test.ts
```

Expected: FAIL because the repository rejects the new exact option shapes.

- [ ] **Step 3: Implement closed parsing and SQL selection**

Parse the discriminated union before opening a connection. Add separate SQL
statements for BUY, SELL and recovery. Use PostgreSQL time, `FOR UPDATE SKIP
LOCKED`, UUID leases and the existing transition semantics. The BUY predicate
must use `NOT EXISTS` over every nonterminal executable SELL, not only unlocked
rows.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all PostgreSQL tests PASS without skips.

- [ ] **Step 5: Commit**

```bash
git add src/storage/execution-intent.repository.ts tests/execution-intent.repository.test.ts
git commit -m "feat: claim live execution lanes atomically (#51)"
```

### Task 3: Construire les read-models de confirmation et réconciliation

**Files:**
- Modify: `src/ports/execution-live-repository.ts`
- Modify: `src/storage/execution-live.repository.ts`
- Modify: `tests/execution-live-repository-contract.test.ts`
- Modify: `tests/execution-live.repository.test.ts`

- [ ] **Step 1: Write failing port and PostgreSQL tests**

Require `ExecutionLiveConfirmationWorkV1`,
`ExecutionLiveReconciliationWorkV1`, `readConfirmationWork` and
`readReconciliationWork`. Test valid BUY and SELL records, `bigint` values above
`Number.MAX_SAFE_INTEGER`, expired/foreign claims, and every provider,
signature, attempt, artifact, generation and causal-identity mismatch. Assert
the returned shapes and repository queries expose no signed transaction bytes.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot \
  npx tsx --test tests/execution-live-repository-contract.test.ts \
  tests/execution-live.repository.test.ts
```

Expected: FAIL because the read methods are absent.

- [ ] **Step 3: Implement confirmation read-model**

Under a transaction, lock and revalidate the active `SUBMITTED` claim with a
fresh DB timestamp, then join the `STARTED` attempt and `ACCEPTED` artifact.
Return only artifact ID, revision, signature and provider ID.

- [ ] **Step 4: Implement reconciliation read-model**

Under the same fencing discipline, construct
`ExecutionReconciliationRequestV1` exclusively from durable intent, attempt,
artifact and generation rows. Reuse domain validators and exact-row parsing;
never select or return signed bytes.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all tests PASS without skips.

- [ ] **Step 6: Commit**

```bash
git add src/ports/execution-live-repository.ts src/storage/execution-live.repository.ts \
  tests/execution-live-repository-contract.test.ts tests/execution-live.repository.test.ts
git commit -m "feat: expose durable live worker inputs (#51)"
```

### Task 4: Ajouter le scanner atomique des sorties à échéance

**Files:**
- Modify: `src/ports/execution-live-repository.ts`
- Modify: `src/storage/execution-live.repository.ts`
- Modify: `tests/execution-live.repository.test.ts`
- Modify: `tests/executor-live-deadline-exit.test.ts`

- [ ] **Step 1: Write failing scanner tests**

Test `null` when no position is due, exact deadline inclusivity, oldest-first
ordering, DB-time authority, two concurrent scanners, scanner versus targeted
call, replay after an indeterminate commit, and one deterministic
`maximum-holding:<positionId>` SELL intent.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot \
  npx tsx --test tests/execution-live.repository.test.ts \
  tests/executor-live-deadline-exit.test.ts
```

Expected: FAIL because `createNextDeadlineExitIntent` is absent.

- [ ] **Step 3: Factor the existing targeted mutation**

Move the locked position-to-SELL mutation into one transaction-local helper so
the existing `createDeadlineExitIntent` keeps its public behavior and the new
scanner cannot fork business logic.

- [ ] **Step 4: Implement the database-time scanner**

Acquire advisory lock `hashtextextended('execution-live-deadline-scan:v1',
51007)`, capture millisecond PostgreSQL time, select the oldest due `OPEN`
position, lock its generation, re-read it `FOR UPDATE`, and call the shared
mutation. Return `null` only when no due candidate exists.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all tests PASS without skips.

- [ ] **Step 6: Commit**

```bash
git add src/ports/execution-live-repository.ts src/storage/execution-live.repository.ts \
  tests/execution-live.repository.test.ts tests/executor-live-deadline-exit.test.ts
git commit -m "feat: scan live position deadlines atomically (#51)"
```

### Task 5: Versionner les contrats et prouver la frontière non-live

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-executor-live-orchestration-design.md`
- Modify: `docs/superpowers/specs/2026-08-31-executor-v1-design.md`
- Modify: `docs/superpowers/specs/2026-08-31-executor-live-canary-design.md`
- Modify: `docs/operations/executor-live-canary.md`
- Modify: `tests/executor-live-main.integration.test.ts`
- Modify: `tests/execution-live-repository-contract.test.ts`

- [ ] **Step 1: Write failing architecture assertions**

Assert no `executor:live:start` package script exists, no H1 production module
imports RPC/keypair/submission, and the operational state remains exactly
`LIVE_RUNTIME_NOT_COMPOSED`, `CANARY_NOT_STARTED`, and
`NON_EXECUTED / NON_VALIDATED`.

- [ ] **Step 2: Run architecture tests and verify RED where documentation is stale**

Run:

```bash
npx tsx --test tests/executor-live-main.integration.test.ts \
  tests/execution-live-repository-contract.test.ts
```

- [ ] **Step 3: Update versioned documentation**

Bump H1 to 1.0.1, parent to 1.7.14, live foundation to 1.0.14 and the runbook
patch version. Record only delivered H1 primitives and explicitly defer RPC,
signer, submission, runtime composition and canary to H2/manual operation.

- [ ] **Step 4: Run documentation and architecture gates**

Run:

```bash
npm run docs:check
npx tsx --test tests/executor-live-main.integration.test.ts \
  tests/execution-live-repository-contract.test.ts
git diff --check
```

Expected: PASS and no unresolved implementation marker in changed docs.

- [ ] **Step 5: Commit**

```bash
git add docs tests/executor-live-main.integration.test.ts \
  tests/execution-live-repository-contract.test.ts
git commit -m "docs: record durable live orchestration boundary (#51)"
```

### Task 6: Vérification exhaustive et livraison de la PR #51-H1

**Files:**
- Verify: repository-wide source, tests, migrations and docs

- [ ] **Step 1: Run all local gates with real PostgreSQL**

```bash
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npm run check
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npm run lint
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npm run docs:check
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npm run build
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npm test
git diff --check
```

- [ ] **Step 2: Perform two-stage local review**

First verify exact compliance with the normative design and this plan. Then
review code quality, SQL lock ordering, error redaction, type closure and
backward compatibility. Fix only evidenced findings and rerun affected gates.

- [ ] **Step 3: Push and open the PR**

Push `feat/issue-51h1-live-orchestration`, open a focused PR against `main`, and
state explicitly that it adds no RPC, keypair, submission, live entrypoint,
armament or canary execution.

- [ ] **Step 4: Run at most three GitHub review cycles**

For each cycle, request review, wait for completion, inspect every thread,
apply technically valid corrections, rerun proportional tests and push. Stop
after three cycles even if non-blocking suggestions remain; never start a
fourth cycle.

- [ ] **Step 5: Merge only on clean evidence**

Require green CI, zero unresolved blocking threads, a clean merge state and
all local gates from Step 1. Merge normally, update local `main`, and record the
merge commit. Do not arm or execute a canary.
