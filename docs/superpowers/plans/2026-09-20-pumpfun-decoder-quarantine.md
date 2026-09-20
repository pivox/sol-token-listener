# Pump.fun Decoder Quarantine and Replay Implementation Plan

Version: 1.0.2 — 2026-09-20 — issue #148

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve incompatible Pump.fun decoder evidence for four hours and allow one explicit, audited, idempotent replay after a decoder upgrade, without automatic retries or any execution capability.

**Architecture:** Keep the worker's existing terminal non-retryable `FAILED` lifecycle as the snapshot-bearing decoder quarantine. Add a closed domain classifier, a replay-safe migration containing a bounded recovery receipt, and a dedicated repository/CLI recovery path. Catch-up quarantines remain non-recoverable in V1 because their exact origin cannot be derived from the stored one-way fingerprint. Publish one aggregate worker decoder-quarantine count through a separate optional versioned health object.

**Tech Stack:** TypeScript strict ESM, PostgreSQL, Node test runner, Zod/API V1 contracts, structured JSON CLI output.

---

### Task 1: Closed taxonomy and local-only recovery contract

**Files:**
- Modify: `src/domain/observed-pipeline-failure.ts`
- Modify: `src/domain/transaction-ingestion.ts`
- Create: `scripts/recover-decoder-quarantine.ts`
- Modify: `package.json`
- Modify: `tests/observed-pipeline-failure.test.ts`
- Create: `tests/recover-decoder-quarantine-cli.test.ts`
- Modify: `tests/transaction-ingestion-contracts.test.ts`

- [ ] **Step 1: Write RED taxonomy tests**

Assert that only exact frozen ingestion failures for
`launchpad_observation.PUMP_SCHEMA_UNSUPPORTED` and
`launchpad_observation.PUMP_BORSH_TRUNCATED`, with
`code='PIPELINE_STAGE_FAILED'` and `retryable=false`, are eligible. Reject
`PUMP_BORSH_INVALID`, other stages, PumpSwap codes, public lookalikes, proxies,
extra keys and retryable variants.

- [ ] **Step 2: Implement the closed classifier**

Export a boolean classifier that consumes the already validated durable
`IngestionFailure`; do not inspect thrown error objects or messages. Keep the
existing WeakMap authority chain and retryability rules unchanged.

- [ ] **Step 3: Write RED recovery-result and CLI tests**

Define a decoder-specific result union with the five stable result codes from
the design. Test exact `--signature` plus `--confirm`, unknown/duplicate
arguments, mismatches, eligible success codes, ineligible/expired results,
redacted dependency errors, and source absence of wallet/signing/network-server
capabilities.

- [ ] **Step 4: Implement the local CLI boundary**

Define a required narrow repository interface local to the CLI around
`recoverDecoderQuarantine(signature)` and expose the testable CLI runner. Do not
make the global repository port optional merely to satisfy intermediate
sequencing. The production bootstrap and package command become active in Task
3 with the concrete repository method. The command emits one bounded JSON line
and never loads RPC, a wallet, signer, executor, HTTP server or submission
dependency.

- [ ] **Step 5: Verify Task 1**

Run targeted tests, `npm run check:backend`, targeted lint and
`git diff --check`. Commit the domain/CLI boundary independently.

### Task 2: Replay-safe migration 051 and recovery evidence

**Files:**
- Create: `migrations/051_transaction_inbox_decoder_quarantine_recovery.sql`
- Create: `tests/transaction-inbox-decoder-quarantine-migration.test.ts`
- Modify: `src/execution-migrations/live-catalog.ts`
- Modify: `src/executor-live/startup-validator.ts`
- Modify: `src/executor-live-recovery/startup-validator.ts`
- Modify: `scripts/deployment-smoke.mjs`
- Modify: migration-head assertions discovered with `rg -l '050_transaction_inbox_first_processing.sql' src tests scripts`

- [ ] **Step 1: Write RED migration tests**

Apply migrations 001–050, install 051 twice, and assert the exact recovery
table columns, primary key, bounds, finite/millisecond timestamps, reason/kind
allowlists, four-hour retention and indexes. Add negative fixtures for partial
tables, weakened constraints, incompatible indexes and invalid rows.

- [ ] **Step 2: Prove catch-up remains fail-closed**

Test that a pristine `QUARANTINED/PUMP_SCHEMA_UNSUPPORTED` row remains unchanged
and ineligible for decoder recovery. Its one-way evidence fingerprint cannot be
used to infer the original marker. Keep every migration-049 catch-up lifecycle
constraint unchanged.

- [ ] **Step 3: Implement migration 051**

Create `transaction_inbox_decoder_recoveries` without a foreign key to the
mutable inbox and without altering inbox/catch-up constraints. Add replay
preflight that compares canonical table, constraint and index definitions and
fails with SQLSTATE `23514` on partial or weakened installations.

- [ ] **Step 4: Advance the canonical migration head**

Append migration 051 and its SHA-256 to the live catalogue. Update both live
startup validators, deployment smoke and only tests that assert the current
head. Preserve historical-boundary assertions.

- [ ] **Step 5: Verify Task 2**

Run the new PostgreSQL migration test on one task-owned temporary database,
catalogue/startup/deployment tests, check, lint, docs and diff-check. Remove the
temporary database immediately. Commit migration/catalogue changes separately.

### Task 3: Atomic, idempotent repository recovery

**Files:**
- Modify: `src/ports/transaction-inbox-repository.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `src/storage/database.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `tests/transaction-ingestion-recovery.test.ts`

- [ ] **Step 1: Write RED worker-quarantine recovery tests**

Create a claimed row with saved immutable snapshot and each eligible exact
failure. Assert it is terminal, not automatically claimable, and recoverable
only before its deadline. Recovery must retain snapshot/fingerprint, clear
terminal/error/retry fields, reset the cycle, increment manual recovery once,
insert one receipt and return `DECODER_RECOVERY_SCHEDULED`.

- [ ] **Step 2: Write RED catch-up rejection tests**

Create pristine catch-up quarantines produced from decoder, normalization,
multi-mint and overflow markers that share the public reason
`PUMP_SCHEMA_UNSUPPORTED`. Assert every one is ineligible and byte-for-byte
unchanged because the stored fingerprint cannot prove the exact origin.

- [ ] **Step 3: Cover fail-closed concurrency and eligibility**

Test missing, expired, already processed, ordinary non-retryable failure,
retryable failure, `PUMP_BORSH_INVALID`, malformed fingerprint/snapshot, stale
lease, two concurrent recoveries, repeated CLI calls, rediscovery, catch-up
classification replay and finality advancement. No path may move or extend the
original deadline unless recovery commits.

- [ ] **Step 4: Implement one locked transaction**

Add the required `recoverDecoderQuarantine(signature)` method to
`TransactionInboxRepository`, the PostgreSQL implementation and the CLI
production bootstrap/package script; no optional port or cast is allowed.
Use the existing per-signature advisory lock plus `SELECT ... FOR UPDATE`.
Validate the worker form, retention and exact evidence. Insert the
receipt and update the inbox in one transaction. Preserve first-detection,
first-processing, snapshot, fingerprint, identity and classification fields.
Return stable frozen results and map database failures to the existing redacted
repository error.

- [ ] **Step 5: Add bounded receipt purge**

Extend shared retention cleanup with an indexed, bounded delete for decoder
recovery receipts whose own `purge_after <= clock_timestamp()`. Assert deletion
at the exact boundary and independence from inbox deletion.

- [ ] **Step 6: Verify Task 3**

Run targeted PostgreSQL tests on one temporary task-owned database, pure worker
and CLI suites, check/lint/diff-check, then remove the database. Commit the
repository lifecycle separately.

### Task 4: Aggregate observability and release gate

**Files:**
- Modify: `src/domain/transaction-ingestion.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: diagnostic frontend health types/components only where required
- Modify: associated domain/repository/API/frontend tests
- Modify: `docs/runbooks/mainnet-observe-dry-run.md`
- Modify: `docs/superpowers/specs/2026-09-20-pumpfun-decoder-quarantine-design.md`
- Modify: this plan

- [ ] **Step 1: Write RED aggregate contract tests**

Add `decoderQuarantinedCount` as a non-negative safe integer. Its SQL definition
counts unresolved eligible worker quarantines only. It must exclude catch-up
classifications, unrelated failures and successful rows and expose no
identifiers.

- [ ] **Step 2: Project a separate optional rolling-compatible metric**

Add `decoderQuarantine: RuntimeDecoderQuarantineMetricsV1` at heartbeat level
with only `version: 1` and `unresolvedCount`; do not modify the strict
`catchUpAdmission` V1 shape. Project the object through `/api/v1/health`, map
historical absence to `null`, reject unsafe counts/extra keys, and show the
number only in diagnostics.

- [ ] **Step 3: Document operator flow**

Document identification, decoder deployment, exact recovery command, result
codes, four-hour deadline, evidence purge, and the fact that replay is not a
trade authorization or success guarantee. Bump spec/plan versions for every
material review correction.

- [ ] **Step 4: Run the complete gate**

With one temporary PostgreSQL instance/database at most, run:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
npm test
git diff --check
```

Remove the task-owned database/container immediately. Confirm no wallet, key,
RPC Mainnet call, armament or submission occurred.

- [ ] **Step 5: Review, PR and merge**

Perform local specification and quality reviews, push, open the PR for #148,
request GitHub review, and use at most two review cycles. Merge only with all CI
checks green and no blocking thread, then verify post-merge `main` CI. Update the
ignored tracker before moving directly to roadmap point 3; the oversize-cache
work remains explicitly deferred.
