# Atomic Paper Open Qualification Guard

## Goal

Prevent paper quotes and new paper positions from using a missing, invalid, or superseded canonical qualification while preserving exact historical reconciliation for positions that already exist.

## Early authorization

For a new paper decision, the worker must require and reauthorize the persisted current qualification immediately after loading the snapshot. This happens before quote routing and candidate creation. A failed reauthorization produces the existing no-decision failure path and must not call either dependency.

## Atomic open boundary

Strategy-linked open commands carry the expected qualification report identity. `PaperTradingEngine.open` invokes `PaperTradingTransaction.requireCurrentQualification` as the first operation in its transaction, before position lookups, events, or writes.

The PostgreSQL implementation:

1. Acquires `pg_advisory_xact_lock(hashtextextended('qualification-projection:' || mint, 0))`.
2. Verifies the exact report id, qualification event id, and mint.
3. Requires `superseded_at IS NULL`, an unexpired report, and non-orphaned report and qualification-event confirmation.
4. Holds the transaction-scoped advisory lock through the position, trade, and event inserts and commit.

This uses the same key as `PostgresQualificationProjectionRepository`, which takes its session advisory lock before beginning its transaction. Paper open takes the qualification lock before any other paper row or strategy lock. Qualification projection does not acquire paper locks, so the ordering has no lock cycle. The shared advisory key prevents qualification replacement between validation and insert.

`reconcileOpen` does not use the current-qualification guard because it may recover an already-created position from its exact historical qualification.

## Failure behavior

A missing or stale current identity raises a typed paper-trading error and rolls back the open transaction without a position, trade, or event. The decision worker maps this open failure to `RPC_TRANSIENT`, retryable, with a null terminal result so canonical projection catch-up can recover without domain mutation.

## Tests

- Paper-mode worker order test proves invalid qualification reauthorization happens before quotes and candidate creation.
- Engine/repository tests prove the qualification guard is the first transaction operation and that its failure prevents all inserts.
- Live PostgreSQL orchestration stages a decision, supersedes the qualification before releasing open, then proves open fails with no position/trade/open event.
- A live PostgreSQL lock test proves qualification replacement cannot enter its critical section between current validation and paper insert.
- Existing exact-current open and historical existing-position reconciliation tests remain green.
