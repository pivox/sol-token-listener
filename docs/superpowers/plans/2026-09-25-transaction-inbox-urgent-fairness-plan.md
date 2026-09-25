# Transaction Inbox Urgent Fairness Plan

Version: 1.0.0 — 2026-09-25 — issue #165

## Task 1 — Migration contract RED

Create PostgreSQL 16 tests for migration 052: clean install, 051 upgrade,
transactional replay, exact column/check/index validation, preserved urgent
counter, initialized launch counter, and indexed plans for each priority.

## Task 2 — Repository fairness RED

Replace the former shared urgent FIFO expectation with tests for the 3:1
internal ratio and unchanged 32:1 outer ratio. Add fallback, saturation,
cross-repository persistence, concurrent uniqueness, rollback, retry and lease
coverage before changing production code.

## Task 3 — Minimal GREEN

Add migration 052. In `claim()`, read both counters, select candidates through
closed static class-specific queries, and update both counters in the same
transaction as the lease. Do not add worker or HTTP concurrency.

Update the listener writer grant and its least-privilege tests for the new
counter.

## Task 4 — Documentation and verification

Document the exact `24L/8T/1N` saturated cycle and the fact that class fairness
does not prove throughput. Run focused PostgreSQL tests, build/check/lint/docs,
all backend/frontend tests, at most two review cycles, then PR/CI/fusion.

The Mainnet observe-only canary remains deferred until issue #166 is also
merged.
