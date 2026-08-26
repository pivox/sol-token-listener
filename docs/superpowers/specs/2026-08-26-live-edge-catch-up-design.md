# Live-edge catch-up design

## Problem

The listener currently walks at most `MAX_PAGES × PAGE_SIZE` signatures to
find each persisted Pump.fun or PumpSwap checkpoint. After a long interruption,
the boundary is outside that window. Startup then fails with
`CATCH_UP_WINDOW_EXCEEDED` after issuing enough requests to trigger HTTP 429 on
limited RPC plans.

The V1 product observes launches from the time the listener is online. It does
not need to reinterpret an unobserved historical interval as new launches, but
it must not hide that interval either.

## Selected behavior

`LISTENER_CATCH_UP_POLICY` supports two explicit policies:

- `live-edge` (V1 default): read at most one page per program and scan. If the
  checkpoint is present, enqueue only the newer signatures. If it is absent,
  enqueue none of that page, persist a catch-up gap, and atomically advance the
  checkpoint to the newest signature returned by the RPC.
- `strict`: preserve the existing bounded pagination and fail with
  `CATCH_UP_WINDOW_EXCEEDED` when the boundary cannot be reached.

An absent checkpoint keeps the existing cold-start behavior: one recent page
is accepted as the initial baseline. The runtime still scans before subscribing
and once after subscribing, so transactions arriving across the subscription
boundary converge through the idempotent inbox.

## Durable gap evidence

Migration `015_listener_catch_up_gaps.sql` creates
`listener_catch_up_gaps`. Each row contains a deterministic SHA-256 identity,
the program key, previous checkpoint, new baseline, observation time, and a
four-hour purge deadline. The repository inserts the gap and advances the
checkpoint in one PostgreSQL transaction. Replays use `ON CONFLICT DO NOTHING`.

The scanner emits a bounded, immutable gap notice only after the durable write
succeeds. Production maps it to a structured warning containing no RPC URL,
signature, wallet, or secret. The warning exposes only the stable event name,
program key, slots, and policy.

## Safety and failure behavior

- A gap without a non-empty current page remains fatal; no checkpoint is
  invented.
- Historical signatures abandoned by a rebaseline are never enqueued.
- Database failure rolls back both the gap and checkpoint advancement.
- `observe` and `paper` remain the only execution modes; no signer or
  transaction submission is introduced.
- The strict policy preserves the current forensic behavior.

## Verification

Tests cover recent checkpoint recovery, stale checkpoint rebaseline, one-page
RPC bounds, no historical enqueue, deterministic gap evidence, atomic
PostgreSQL writes, strict-mode failure, configuration parsing, structured logs,
and migration replay from an empty database.
