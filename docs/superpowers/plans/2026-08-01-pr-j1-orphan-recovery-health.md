# PR J1 Orphan Recovery and Retryable Health Implementation Plan

**Goal:** Converge orphan compound replays through all projections and expose retryable inbox failures in health.

**Architecture:** Carry an explicit orphan-only missing-launch policy from the observed transaction pipeline into I1/I2 services and repository transactions. Add current-projection dissolution to PostgreSQL repositories. Split retryable failures in inbox counts and incorporate them into heartbeat backlog.

**Tech Stack:** TypeScript, Vitest, PostgreSQL.

---

### Task 1: Specify orphan-only dissolution

**Files:** `tests/launch-participant-analytics.service.test.ts`, `tests/wallet-graph-rebuild.service.test.ts`, `tests/observed-transaction-pipeline.test.ts`

1. Add failing tests for orphan missing-launch dissolution and active missing-launch errors.
2. Add the typed policy and narrow repository transaction operations.
3. Run the focused unit tests.

### Task 2: Implement PostgreSQL current-projection dissolution

**Files:** `src/storage/participant-analytics.repository.ts`, `src/storage/wallet-graph.repository.ts`, repository tests

1. Add failing repository assertions for current-row deletion with immutable audit preservation.
2. Implement transactional current-row deletion.
3. Run focused repository tests against PostgreSQL.

### Task 3: Specify retryable failed health backlog

**Files:** `tests/transaction-inbox.repository.test.ts`, heartbeat/API integration tests

1. Add failing assertions for `retryableFailed` and nonzero health backlog.
2. Extend inbox count contracts and SQL.
3. Safely sum retryable work into persistent heartbeat backlog.
4. Run focused tests.

### Task 4: Prove production end to end behavior

**Files:** `tests/transaction-ingestion-recovery.test.ts`

1. Add a real PostgreSQL confirmed-to-orphaned compound transaction test.
2. Assert the orphan inbox revision is processed, current projections are dissolved, audit is retained, and replay is idempotent.
3. Run the focused live PostgreSQL test, build, check, and lint.
