# PR J1 Orphan Recovery and Retryable Health Design

## Goal

Make a confirmed-to-orphaned compound Pump transaction converge through the complete production pipeline, while keeping missing active launch state an error. Expose retryable failed inbox work through the persisted health backlog without treating terminal failures as work.

## Orphan reconciliation

`ObservedTransactionPipeline` derives a typed missing-launch policy solely from the observed confirmation status. `ORPHANED` selects `DISSOLVE_CURRENT`; every active status selects `ERROR`.

Participant analytics and wallet graph rebuild services pass that policy into their repository transactions. When canonical launch input exists, rebuilding is unchanged. When it is absent:

- `ERROR` throws the existing launch-not-found error.
- `DISSOLVE_CURRENT` invokes a narrow `dissolveCurrent(mint)` operation and returns without emitting replacement projections.

The PostgreSQL repositories delete only mutable/current projections. Immutable snapshots, domain-event history, inbox payloads, and raw transaction audit remain available. The pipeline then continues to PumpSwap reconciliation so market projections are retracted as part of the same orphan revision.

## Health accounting

Inbox counts retain the total failed metric and add `retryableFailed`, counting only `FAILED` rows with `retryable = true`. The persistent heartbeat backlog is the safe-integer sum of pending, processing, and retryable-failed work. Leased remains processing only, so `leased <= backlog` continues to hold and existing API health validation remains valid.

A fresh, running listener may remain `OK`, but it cannot report `OK` with a zero backlog while retryable work exists.

## Verification

PostgreSQL integration coverage will prove:

- one compound transaction creates active launch, participant, graph, and market projections;
- its orphan revision reaches `PROCESSED`, dissolves all current projections, and preserves immutable/raw audit;
- replaying the orphan revision is idempotent;
- active observations with a missing launch still throw;
- a real retryable `FAILED` inbox row produces a nonzero persisted and API health backlog while terminal failed rows do not join that backlog.
