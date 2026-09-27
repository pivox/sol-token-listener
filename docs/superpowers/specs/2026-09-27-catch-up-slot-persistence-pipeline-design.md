# Catch-up Slot Persistence Pipeline

Date: 2026-09-27

Issue: #183

Status: approved for implementation

Contract revision: 1.0.0

## Purpose

The exact Mainnet observe-only canary on `main@ca65ffb` ended with 13,073
unclassified inbox rows, 98.6% of its actionable backlog, despite zero HTTP
429. The catch-up classifier currently hydrates one slot, persists every
classification in that slot, and only then starts hydrating the next slot.
RPC latency and serial PostgreSQL latency are therefore added unnecessarily.

This change overlaps one future slot hydration with the current slot's serial
persistence. It does not add workers, cache capacity, RPC concurrency, database
write concurrency or transaction submission.

## Invariants

- The historical path remains exact when the new option is absent or false.
- Production enables the pipeline only with bounded worker admission.
- At most one future slot is hydrated ahead of the slot being persisted.
- The block cache remains the sole RPC scheduler and keeps one active fetch.
- Repository writes remain strictly serial and preserve slot/signature order.
- Receipts are returned in the same deterministic discovery order.
- A hydration, persistence or cancellation failure never starts a write for a
  later slot.
- A prefetched rejection is always observed before the classifier rejects.
- Coverage, finality, idempotence and catch-up checkpoint semantics are
  unchanged.

## Selected design

`PumpFunCatchUpBlockClassifierOptions` gains
`slotPersistencePipelineEnabled`, defaulting to false. With the option enabled,
the classifier processes the already validated slot list using a one-element
look-ahead:

1. start hydration for the current slot;
2. await it;
3. start hydration for the next slot and immediately attach a fulfillment/
   rejection capture;
4. persist the current slot's classifications sequentially;
5. advance to the captured next result;
6. repeat.

The look-ahead is never wider than one slot. A captured result object prevents
an unhandled rejection while current persistence is pending. If persistence or
abort fails, the classifier awaits the one look-ahead promise before propagating
the original failure and performs no write for that future slot.

Failed source transactions retain their existing direct-classification path.
Coverage remains one grouped read before missing work is pipelined. The output
map still restores discovery order after persistence.

## Activation

The production factory passes the option only from the already restart-only,
OFF-by-default bounded worker-admission policy. No new environment variable is
introduced, avoiding independently unsafe combinations.

## Acceptance

- deterministic three-slot test proves slot N+1 hydrates while the first write
  of N is blocked and N+2 has not started;
- repository write concurrency never exceeds one;
- persistence and receipt order remain unchanged;
- option false proves no look-ahead;
- hydration rejection, persistence rejection and abort settle the look-ahead
  without late writes or unhandled rejection;
- focused tests, build, check and lint pass;
- the following 15-minute canary retains `callerConcurrency=1`, at most one
  active RPC fetch, zero 429 and non-growing classification pending/backlog.

## Out of scope

Decoder layouts, funding attribution, wallet-graph serialization retries,
worker count, cache limits, database schema, H2c/H2d/H2e, wallet access and live
execution.
