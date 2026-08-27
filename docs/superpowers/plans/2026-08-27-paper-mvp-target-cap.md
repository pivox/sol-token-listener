# Paper MVP Target Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale concurrent Paper MVP collections from persisting more valid samples than the immutable run target.

**Architecture:** Recompute the collector limit from every freshly loaded OCC snapshot and return a canonical no-op once the valid target is full. Independently enforce the same target under the repository run lock after observation inserts so any concurrent overfill rolls back atomically; unknown samples keep their separate one-thousand cap.

**Tech Stack:** TypeScript, Node test runner, PostgreSQL advisory/row locks.

---

### Task 1: Collector refreshed target limit

**Files:**
- Modify: `src/application/paper-mvp-collector.ts`
- Test: `tests/paper-mvp-collector.test.ts`

- [x] Write a unit test where the first collection becomes stale after another collection reaches the target, then assert the retry returns zero counts and performs no second source, provider, or progress call.
- [x] Run `npx tsx --test --test-name-pattern='stops an OCC retry at the refreshed target' tests/paper-mvp-collector.test.ts` and confirm it fails because the source is called again.
- [x] Compute `remaining = targetClosedPositions - closedPositions` after every load; return the canonical no-op when non-positive and pass `Math.min(input.limit, remaining)` to the source.
- [x] Re-run the focused collector test and confirm it passes.

### Task 2: Atomic repository target cap

**Files:**
- Modify: `src/storage/paper-mvp.repository.ts`
- Test: `tests/paper-mvp.repository.test.ts`

- [x] Write a PostgreSQL test that starts a target-one run, records one valid sample, then attempts a second distinct valid sample and verifies `PROGRESS_LIMIT_EXCEEDED`, unchanged samples, counters, and `updatedAtMs`.
- [x] Run the test with `TEST_DATABASE_URL=postgresql:///trading_paper_test` and confirm the second sample currently commits.
- [x] Extend the locked observation-count query to compare valid count with the locked run target while preserving the independent unknown cap.
- [x] Re-run the repository test and confirm the whole transaction rolls back.

### Task 3: Signal/deadline interleavings and gates

**Files:**
- Test: `tests/paper-mvp-cli.test.ts`
- Test: `tests/paper-mvp-collector.test.ts`

- [x] Add deterministic signal and deadline cases where an aborted collection commits one distinct sample and the final collection observes another; assert OCC retry/no-op and durable `closedPositions` never exceed the target.
- [x] Run focused CLI, collector, and live repository tests with zero skips.
- [x] Run `npm run check`, `npm run lint`, `npm run build`, `npm run docs:check`, and `git diff --check`.
- [x] Run `TEST_DATABASE_URL=postgresql:///trading_paper_test npm test` and confirm backend and frontend pass with zero skips.
- [x] Commit the focused fix without pushing.
