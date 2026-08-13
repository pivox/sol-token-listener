# Paper Open Qualification Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authorize canonical qualification before paper quotes and atomically reject new paper-position inserts when that qualification is no longer current.

**Architecture:** The worker reauthorizes immediately after the snapshot null check and passes the rebuilt projection downstream. Strategy-linked ledger opens carry the expected report identity; the engine makes a current-qualification guard the first transaction operation, and PostgreSQL serializes it with qualification projection updates by acquiring the shared qualification-mint advisory key through commit.

**Tech Stack:** TypeScript, Node test runner, PostgreSQL, advisory locks, existing paper trading engine and repositories.

---

### Task 1: Authorize before paper quotes

**Files:**
- Modify: `tests/paper-decision-worker.test.ts`
- Modify: `src/application/paper-decision-worker.ts`

- [ ] **Step 1: Write failing order and tamper tests**

Add a paper-mode test whose qualification rebuilder records `authorize` and throws, while the quote router records `quote` and candidate builder records `candidate`. Assert the run fails with `DECISION_INVALID`, the trace is exactly `['authorize','fail']`, and quote/candidate/stage/complete counts are zero.

- [ ] **Step 2: Verify RED**

Run `npx tsx --test --test-name-pattern='before paper quotes' tests/paper-decision-worker.test.ts` and expect a quote call before the authorization failure.

- [ ] **Step 3: Move authorization before quotes**

Immediately after `currentQualification` is required, call:

```ts
let rebuilt:RebuiltQualification;
try {
  rebuilt=authorizedQualification(this.qualification.reauthorize(persisted),persisted);
} catch {
  return this.fail(job,lease,'DECISION_INVALID',false,null);
}
```

Then perform quotes and candidate creation using `rebuilt`, with candidate creation retaining its own invalid-decision catch.

- [ ] **Step 4: Verify GREEN**

Run the focused worker test and the complete worker test file; expect zero failures.

- [ ] **Step 5: Commit**

Commit the worker and test changes as `fix: authorize paper qualification before quotes (#15)`.

### Task 2: Define the atomic current-qualification contract

**Files:**
- Modify: `src/domain/paper-trading.ts`
- Modify: `src/ports/paper-trading-repository.ts`
- Modify: `src/paper/paper-trading-engine.ts`
- Modify: `src/application/validated-external-buys.strategy.ts`
- Modify: `tests/paper-trading-engine.test.ts`
- Modify: `tests/validated-external-buys.strategy.test.ts`

- [ ] **Step 1: Write failing engine contract tests**

Extend the fake transaction trace and assert a strategy-linked `open` calls `requireCurrentQualification({mint,reportId,qualificationEventId})` before `findPosition`, while `reconcileOpen` never calls the guard. Add a typed stale failure test asserting no find/insert call follows the guard failure.

- [ ] **Step 2: Verify RED**

Run `npx tsx --test --test-name-pattern='current qualification' tests/paper-trading-engine.test.ts`; expect the missing transaction method/order assertion to fail.

- [ ] **Step 3: Add command and transaction types**

Add `PaperCurrentQualificationIdentity`, an optional `expectedCurrentQualification` on `OpenPaperPositionCommand`, and:

```ts
requireCurrentQualification(identity:PaperCurrentQualificationIdentity):Promise<void>;
```

Add a distinct `QUALIFICATION_NOT_CURRENT` `PaperTradingError` code.

- [ ] **Step 4: Guard new opens first**

Have `ValidatedExternalBuysStrategy.open` populate the expected identity from candidate mint/report and qualification event id. In `PaperTradingEngine.open`, require this identity for strategy-linked commands and call `requireCurrentQualification` as the first callback operation. Leave `reconcileOpen` unchanged.

- [ ] **Step 5: Verify GREEN**

Run the engine and strategy test files and expect zero failures.

### Task 3: Serialize PostgreSQL validation with qualification projection

**Files:**
- Modify: `src/storage/paper-trading.repository.ts`
- Modify: `tests/paper-trading.repository.test.ts`
- Modify: `tests/paper-decision.repository.test.ts` or add the live orchestration case to `tests/paper-trading.repository.test.ts`

- [ ] **Step 1: Write failing repository SQL and live race tests**

Assert `requireCurrentQualification` first executes:

```sql
SELECT pg_advisory_xact_lock(
  hashtextextended('qualification-projection:' || $1, 0)
)
```

Then assert its validation query requires exact `report_id`, `mint`, `qualification_event_id`, `superseded_at IS NULL`, `purge_after > clock_timestamp()`, and non-orphaned report/event confirmation. In live PostgreSQL, stage an entry, pause before open, replace the current qualification, release open, and assert typed rejection with no new paper position, trade, or opened event. Add a lock-serialization case showing qualification replacement waits while open holds this advisory lock.

- [ ] **Step 2: Verify RED**

Run the focused repository tests with `TEST_DATABASE_URL=postgresql:///postgres`; expect the missing method/query failure.

- [ ] **Step 3: Implement the PostgreSQL guard**

Acquire the shared advisory lock, then execute a `SELECT ... FOR SHARE` joining the qualification event and accept exactly one row. Otherwise throw `PaperTradingError('QUALIFICATION_NOT_CURRENT', ...)`. Because this is the first paper transaction operation and qualification projection acquires only the same qualification lock before its own rows, no paper-held lock can participate in a cycle.

- [ ] **Step 4: Verify GREEN**

Run focused unit and live PostgreSQL tests and expect zero position/trade/open-event changes on stale rejection.

### Task 4: Map only typed stale opens to retry-only

**Files:**
- Modify: `src/application/paper-decision-worker.ts`
- Modify: `tests/paper-decision-worker.test.ts`

- [ ] **Step 1: Write failing mapping tests**

Make the fake strategy throw `PaperTradingError('QUALIFICATION_NOT_CURRENT', ...)` and assert `RPC_TRANSIENT`, retryable, null terminal result. Make it throw another paper error and assert the existing `DECISION_INVALID`, nonretryable, staged result behavior.

- [ ] **Step 2: Verify RED**

Run the two focused worker tests and expect stale to be incorrectly mapped to `DECISION_INVALID`.

- [ ] **Step 3: Add narrow mapping**

In the new-position open catch, branch only when `error instanceof PaperTradingError && error.code === 'QUALIFICATION_NOT_CURRENT'`; use `fail(...,'RPC_TRANSIENT',true,null)`. Preserve the existing catch behavior for every other error.

- [ ] **Step 4: Verify GREEN and regression matrix**

Run focused worker, engine, strategy, and repository tests; then live PostgreSQL paper tests, `npm test`, `npm run check`, `npm run lint`, and `git diff --check`.

- [ ] **Step 5: Commit**

Commit the atomic boundary, mapping, and tests as `fix: guard paper opens with current qualification (#15)`.
