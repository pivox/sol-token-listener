# PostgreSQL Live-Recovery Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent destructive PostgreSQL test cleanup from terminating a backend whose pool has reported closed before its network session has drained.

**Architecture:** Extract the proven #118 backend-drain barrier into one test helper, preserve its deterministic unit coverage, and place it between pool closure and forced cleanup in the live-recovery authority integration test. Production code remains untouched.

**Tech Stack:** TypeScript strict ESM, Node test runner, `pg`, PostgreSQL 16.

---

### Task 1: Share the bounded backend-drain barrier

**Files:**
- Create: `tests/helpers/postgres-backend-drain.ts`
- Create: `tests/postgres-backend-drain.test.ts`
- Modify: `tests/executor-worker-database-authority.test.ts`

- [x] Write failing tests importing the absent shared helper and covering `1 -> 0` plus a strict timeout.
- [x] Run `npx tsx --test tests/postgres-backend-drain.test.ts` and verify RED because the module is absent.
- [x] Move the existing five-second/100 ms implementation into the shared helper and import it from the worker authority test.
- [x] Re-run both focused tests and verify GREEN.

### Task 2: Gate live-recovery destructive cleanup

**Files:**
- Modify: `tests/execution-live.repository.test.ts`

- [x] Add the shared drain barrier after both pools close and before `pg_terminate_backend`.
- [x] Assert the termination safety net affects zero rows before dropping the database.
- [x] Run the PostgreSQL 16 target test and verify GREEN.
- [x] Repeat the target test at least twenty times with test concurrency one.

### Task 3: Verify and deliver

**Files:**
- Verify all files above and the versioned design/plan.

- [x] Run `npm run build`, `npm run check`, `npm run lint` and `git diff --check`.
- [x] Review the diff and prove no file under `src/` changed.
- [x] Commit, push and open one PR referencing #128 without requesting review or merging.

### Task 4: Extend the barrier to listener-authority cleanup

**Files:**
- Modify: `tests/listener-database-authority.test.ts`
- Modify: `tests/postgres-backend-drain.test.ts`

- [x] Add a failing structural test for close, drain, zero-termination assertion and drop order.
- [x] Reuse the shared barrier after both listener-authority pools close.
- [x] Assert the termination safety net affects zero rows before dropping the database and role.
- [x] Repeat the PostgreSQL 16 listener-authority test ten times sequentially.

### Task 5: Close every remaining database-name teardown race

**Files:**
- Modify: `tests/execution-worker-live-partition-migration.test.ts`
- Modify: `tests/executor-main.integration.test.ts`
- Modify: `tests/executor-roles-provisioning.test.ts`
- Modify: `tests/executor-worker-database-authority.test.ts`
- Modify: `tests/postgres-backend-drain.test.ts`

- [x] Add a repository-wide failing audit for every `datname`-scoped forced cleanup.
- [x] Gate all three migration 040, both role-provisioning and the executor-main cleanups.
- [x] Preserve the executor-main termination of one intentional PID unchanged.
- [x] Require captured termination results and zero-row assertions for all ten guarded sites.
- [x] Run the relevant PostgreSQL 16 tests and stress the migration 040 regression.
- [x] Run build, check, lint, docs and whitespace verification before push.

### Task 6: Make the teardown audit exhaustive and the gate effective

**Files:**
- Modify: `tests/executor-main.integration.test.ts`
- Modify: `tests/executor-worker-database-authority.test.ts`
- Modify: `tests/postgres-backend-drain.test.ts`

- [x] Discover every test SQL `DROP DATABASE IF EXISTS` recursively and compare it to an explicit inventory.
- [x] Distinguish forced database-name cleanup from two graceful isolated-role cleanups.
- [x] Add a failing AST audit that requires terminate, zero-row assertion and drop in one callback.
- [x] Group the two split executor cleanup callbacks so a failed assertion prevents the drop.
- [x] Re-run structural, PostgreSQL 16, build, check, lint, docs and whitespace verification.
