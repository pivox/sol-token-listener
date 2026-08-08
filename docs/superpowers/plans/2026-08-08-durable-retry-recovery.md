# Durable Retry Cap and Manual Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transaction-inbox retries finite and durable, expose exhaustion, and add a safe local manual-recovery command.

**Architecture:** PostgreSQL stores a per-row retry-policy snapshot, lifetime and per-cycle counters, terminal exhaustion, and an append-only recovery audit. The listener repository owns atomic scheduling and recovery; a local CLI is the only recovery entry point, while health remains read-only.

**Tech Stack:** TypeScript strict ESM, Node.js test runner, PostgreSQL 16, `pg`, existing HTTP API and structured JSON CLI conventions.

---

### Task 1: Lock retry policy and domain contracts

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/domain/transaction-ingestion.ts`
- Modify: `src/ports/transaction-inbox-repository.ts`
- Test: `tests/config-safety.test.ts`
- Test: `tests/transaction-ingestion-contracts.test.ts`

- [ ] **Step 1: Write failing configuration and contract tests**

Test exact maximum values, maximum-plus-one rejection, `exhaustedFailed`, `exhaustedCount`, `WORKER_LEASE_EXPIRED`, and frozen manual-recovery results.

- [ ] **Step 2: Verify the focused tests fail for missing bounds and fields**

Run: `npm test -- tests/config-safety.test.ts tests/transaction-ingestion-contracts.test.ts`

Expected: failures identify absent bounds and contracts.

- [ ] **Step 3: Add the minimal strict types and validators**

Bound max attempts to 100 and base delay to 60,000 ms. Add the lease-expiry error code, exhausted counts, and stable recovery result codes without `any` or financial floats.

- [ ] **Step 4: Verify the focused tests pass**

Run: `npm test -- tests/config-safety.test.ts tests/transaction-ingestion-contracts.test.ts`

Expected: zero failures.

### Task 2: Add the replayable PostgreSQL lifecycle

**Files:**
- Create: `migrations/011_transaction_inbox_retry_recovery.sql`
- Modify: `tests/transaction-ingestion-migration.test.ts`
- Modify: `tests/copy-migrations.test.ts`

- [ ] **Step 1: Write failing migration contract and live tests**

Require per-row policy, cycle attempts, exhaustion timestamps, four-hour terminal failures, heartbeat exhaustion, the recovery audit table, empty-schema application, replay, and legacy-row backfill.

- [ ] **Step 2: Verify migration tests fail because migration 011 is absent**

Run: `npm test -- tests/transaction-ingestion-migration.test.ts tests/copy-migrations.test.ts`

Expected: failures name migration 011 and its missing schema.

- [ ] **Step 3: Implement migration 011**

Use idempotent `ADD COLUMN IF NOT EXISTS`, named constraint replacement, deterministic backfill, bounded integer checks, and no destructive table drop.

- [ ] **Step 4: Verify SQL contracts and PostgreSQL live behavior**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm test -- tests/transaction-ingestion-migration.test.ts tests/copy-migrations.test.ts`

Expected: zero failures and migration replay applies nothing the second time.

### Task 3: Enforce the cap atomically in the repository

**Files:**
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `tests/production-listener-factory.test.ts`

- [ ] **Step 1: Write failing live repository tests**

Cover policy snapshot on enqueue, backoff from the stored base delay, exhaustion at the exact claim cap, non-retryable terminal retention, expired-lease exhaustion, actionable versus exhausted counts, and restart behavior.

- [ ] **Step 2: Verify the repository tests fail for infinite retry behavior**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm test -- tests/transaction-inbox.repository.test.ts tests/production-listener-factory.test.ts`

Expected: failures show an extra claim or missing terminal fields.

- [ ] **Step 3: Implement the minimal SQL transitions and factory wiring**

Inject the validated policy into the repository, snapshot it on enqueue, increment both counters on claim, reconcile expired leases before selection, and terminalize failures atomically.

- [ ] **Step 4: Verify repository and factory tests pass**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm test -- tests/transaction-inbox.repository.test.ts tests/production-listener-factory.test.ts`

Expected: zero failures.

### Task 4: Add idempotent manual recovery and audit

**Files:**
- Modify: `src/storage/transaction-inbox.repository.ts`
- Create: `scripts/recover-inbox.ts`
- Create: `tests/recover-inbox-cli.test.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing repository and CLI tests**

Cover exact double confirmation, scheduled recovery, repeated idempotent recovery, missing/ineligible results, policy refresh, immutable lifetime attempts, one audit row per exhausted cycle, redacted dependency failure, and absence of signing/submission imports.

- [ ] **Step 2: Verify tests fail because recovery does not exist**

Run: `npm test -- tests/recover-inbox-cli.test.ts tests/transaction-inbox.repository.test.ts`

Expected: module or method missing failures.

- [ ] **Step 3: Implement the repository transition and local CLI**

Parse only canonical named arguments, compare confirmation exactly, use a single row lock and transaction, emit one bounded JSON line, and map stable result codes to exit codes 0, 1, or 2.

- [ ] **Step 4: Verify manual recovery behavior**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm test -- tests/recover-inbox-cli.test.ts tests/transaction-inbox.repository.test.ts`

Expected: zero failures and one audit row for a repeated command.

### Task 5: Expose exhaustion in heartbeat and health

**Files:**
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`

- [ ] **Step 1: Write failing heartbeat and API tests**

Assert that exhausted failures are excluded from backlog, stored in `exhausted_transactions`, returned as `exhaustedCount`, and rejected when negative or unsafe.

- [ ] **Step 2: Verify focused tests fail on the missing health field**

Run: `npm test -- tests/production-listener-factory.test.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts`

Expected: failures identify the missing exhausted count.

- [ ] **Step 3: Thread the validated count through heartbeat storage and V1 health**

Keep the public route read-only and preserve nullable fields when no heartbeat exists.

- [ ] **Step 4: Verify the focused health tests pass**

Run: `npm test -- tests/production-listener-factory.test.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts`

Expected: zero failures.

### Task 6: Purge, documentation, and full verification

**Files:**
- Modify: `src/storage/database.ts`
- Modify: `tests/transaction-ingestion-migration.test.ts`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing purge test for every terminal inbox row**

Require deletion by `terminal_at` and `purge_after` regardless of processed or failed status, while preserving deletion ordering.

- [ ] **Step 2: Verify the purge test fails on the processed-only predicate**

Run: `npm test -- tests/transaction-ingestion-migration.test.ts`

Expected: failure identifies the processed-only deletion.

- [ ] **Step 3: Generalize purge and document operator semantics**

Document exact attempt semantics, four-hour retention, health visibility, CLI confirmation, and the absence of live execution.

- [ ] **Step 4: Run fresh complete verification**

Run: `npm run build && npm run check && npm run lint && npm run docs:check && TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm test`

Expected: all commands exit zero with no skipped PostgreSQL tests.
