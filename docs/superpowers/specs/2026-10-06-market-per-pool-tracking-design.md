# Market per-pool tracking — design

Date: 2026-10-06
Status: approved in conversation, pending written review

## Problem

The pre-canary A/B validation (2026-10-06) ended `BLOCKED` on HTTP 429s even after the RPC quota increase.
The market side follows the whole PumpSwap program (`onLogs(PUMPSWAP_PROGRAM_ID)` and
`getSignaturesForAddress(PUMPSWAP_PROGRAM_ID)`), i.e. ~800 signatures/s. Every enqueued signature is
fetched by the sequential inbox worker (`getTransaction`, plus `getBlock` before the per-slot cache added
the same day), yet `PumpSwapObservationPipeline` discards almost all of them: only trades on
`market_pools` rows with `pool_state='active'` are used. Migrations do not need the market feed, because a
migration transaction invokes the pump.fun program at top level and the launchpad feed already sees it.

## Goal

Make market ingestion proportional to the trades on the pools we actually track (target: fewer than 20
tracked pools), so the RPC budget is no longer driven by the global PumpSwap volume.

Non-goals: inbox worker throughput or parallelism, pool rotation beyond the cap, any launchpad change.

## Tracked pools

A pool is tracked when it is `pool_state='active'`, not `orphaned`, and either:

- it was activated less than `MARKET_TRACKING_WINDOW_HOURS` ago (default 6), or
- its mint (`market_pools.base_mint`) is engaged: a `paper_strategy_sessions` row whose `state` is in the
  active set of `paper_strategy_sessions_active_idx` (migration 015), or a `live_positions` row with
  `status` in `OPEN` / `RECONCILIATION_REQUIRED`.

The activation time is `domain_events.observed_at` of `market_pools.activation_event_id`; the same
event row gives the migration `signature` and `slot` used to seed the pool checkpoint.

`MARKET_TRACKED_POOLS_MAX` (default 50) is a safety cap. When exceeded, engaged pools are always kept,
the oldest window-only pools are dropped first, and a warning is logged.

## Components

1. **`ActivePoolRegistry`** (new). Holds the tracked pool set in memory. It is loaded from the database at
   start-up and refreshed at every market sweep (every 5 s), which is how newly activated pools are picked
   up. The per-transaction `loadActivePools()` query in the market pipeline is left as is: at the new
   volume it is no longer a concern.
2. **Per-pool WebSocket subscriptions.** `ProgramSubscriber` drops the PumpSwap program subscription and
   maintains one `onLogs(pool)` (logsSubscribe `mentions:[pool]`) per tracked pool, added or removed as
   the registry changes. The launchpad program subscription is unchanged.
3. **Per-pool catch-up.** Each market sweep (`LISTENER_ROLLING_CATCH_UP_MARKET_INTERVAL_MS`) runs
   sequentially over the tracked pools: `getSignaturesForAddress(pool, { until: checkpoint })` at
   `finalized` commitment, paginated within the existing `pageSize` / `maxPages` bounds, then it enqueues
   the signatures and advances the pool checkpoint, in the same order as the current scanner (enqueue
   first, checkpoint second). Finalized reads guarantee that a checkpoint signature can never be dropped
   by a fork, so `until` is a safe stop condition; real-time coverage comes from the `processed`
   WebSocket subscription.
   Existing catch-up telemetry is reused with per-pool counters.
4. **`market_pool_checkpoints`** (new table, new migration). One row per pool: pool address, signature,
   slot, source, timestamps. `processing_checkpoints`, its constraint and the rebase/cutover logic are
   left untouched; the legacy `market` row stops advancing and stays for history.

## Data flows

**Activation.** The pipeline confirms a migration from the launchpad transaction and writes the
`market_pools` activation as today (unchanged). At the next registry refresh (≤ 5 s), the pool becomes
tracked; having no checkpoint, it is seeded from its activation event (migration signature and slot,
`INSERT … ON CONFLICT DO NOTHING`), then `onLogs(pool)` is subscribed and the same sweep catches up from
the migration. Seeding from the migration rather than from "now" means no trade is lost between
activation and the first sweep.

**Leaving tracking** (window expired, not engaged). At the next sweep the registry drops the pool and the
WebSocket subscription is removed. The checkpoint is kept, so tracking resumes from it if the mint
becomes engaged again.

**Restart.** The registry reloads from the database; each pool resumes from its checkpoint. No cutover is
ever needed for a pool, since it is born with its checkpoint.

**Switch-over of existing pools.** Tracked pools that are already active at deployment are seeded the
same way, from their activation event. If the history since then exceeds the catch-up window, the pool
is `DEGRADED`, and only an explicit operator command can re-seed it at the current finalized frontier
(same principle as `operator-approved-live-edge-cutover`; the previous checkpoint is kept in the row's
`previous` JSON column as evidence).

## Error handling and coverage

- Errors are isolated per pool. A 429, an RPC error or `CATCH_UP_WINDOW_EXCEEDED` on one pool marks
  that pool `DEGRADED` and leaves its checkpoint unchanged; the other pools carry on.
- A pool returning to tracking whose gap exceeds the catch-up window is `DEGRADED`. There is never a
  silent cutover.
- Market coverage is `HEALTHY` only when every tracked pool is healthy. An empty tracked set is
  `HEALTHY`.
- The live decision coverage guard checks the pool of the mint being decided, not global market
  coverage: a mint with a tracked pool requires that pool to be healthy; a mint whose pool was dropped
  by the cap is not covered; a mint without any active pool (bonding-curve phase) has no market
  requirement. A degraded pool does not block a decision on another mint.
  A pool that aged out of the tracking window and whose mint is not engaged is treated like "no pool":
  live entries happen on the bonding curve, and any mint we hold is engaged, hence tracked.
- The guard fails closed: before the first completed tracker cycle, after a failed refresh, or when no
  cycle has completed for longer than `maxStalenessMs` (default `3 * intervalMs + sweepTimeoutMs`: the
  loop is stuck), no mint is covered, including bonding-curve mints.
- **Cycle-based freshness.** A pool is fresh when its last success happened in the cycle in progress or
  in the last completed cycle (a per-success cycle number, not a wall-clock age), and its WebSocket
  subscription is acknowledged. A slow or hanging pool lengthening a cycle therefore cannot make the
  healthy pools stale; the wall-clock bound only applies to the loop as a whole (above).
- **Backoff.** A sweep failing with `CATCH_UP_WINDOW_EXCEEDED` (or `POOL_CHECKPOINT_NOT_FOUND` outside
  the finalization grace) skips that pool for 1, 2, 4, … cycles, capped at 64, and resets on the next
  success. A skipped pool makes no RPC call, stays `FAILED` (its mint uncovered) and is reported with
  outcome `FAILED` and error code `POOL_SWEEP_BACKOFF`. Other failures (429, RPC errors, timeouts) are
  retried every cycle.
- **Awaiting finalization.** The activation checkpoint is often only `processed` when it is seeded, so
  the finalized sweep cannot confirm it yet. A pool that has never succeeded, whose activation is
  younger than `finalizationGraceMs` (default 90 s) and that fails with `POOL_CHECKPOINT_NOT_FOUND` is
  `AWAITING_FINALIZATION` (error code `POOL_AWAITING_FINALIZATION`): its mint is not covered, but it
  does not make global market coverage `DEGRADED`, and it is retried every cycle without backoff. After
  the grace the same failure is a normal `FAILED` with backoff.
- **No concurrent scans.** A scan abandoned on `POOL_SWEEP_TIMEOUT` may still be running; until it
  settles the pool is not scanned again and is reported `FAILED` with `POOL_SWEEP_STILL_RUNNING`.
- **WebSocket replacement.** A subscription that failed (enqueue or parse) is removed at one sync and
  re-added at the next, so the new listener never joins the still-`subscribed` web3.js subscription
  entry of the old one (web3.js 1.98.4 shares entries by `[method, args]` hash and would emit no new
  `subscribed` state, leaving the pool unhealthy).
- **Shutdown** is bounded: market and launchpad close in parallel (the first error is rethrown once
  both settled), the tracker waits at most `sweepTimeoutMs` for an in-flight cycle, and the pool
  subscriber waits at most `drainTimeoutMs` (default 5 s) for in-flight enqueues.
- None of the above relaxes the live entry guard: backoff, awaiting-finalization, still-running and
  stale pools all leave their mint uncovered, so live entries remain fail-closed in every case.
- The launchpad keeps its current bootstrap, rolling sweep and cutover logic; `StartupScanner` and
  `CatchUpScanner` get an enabled-programs option and run launchpad only in production.

## Testing (offline, TDD)

| Unit | Cases |
|---|---|
| Registry | window, engaged always included, cap drops oldest window-only pools first, orphaned excluded, refresh adds/removes |
| Pool checkpoint | seeded from activation event, never overwritten by seeding, monotonic store, operator re-seed keeps previous as evidence |
| Per-pool sweep | paginates to `until`, 429 on one pool does not affect others, checkpoint unchanged on failure, per-pool telemetry |
| Subscriptions | subscribe/unsubscribe on registry changes, no PumpSwap program subscription left |
| Coverage | `HEALTHY` only if all tracked pools healthy, empty set `HEALTHY`, live guard per mint |
| Switch-over | existing pool seeded from activation, window exceeded → `DEGRADED`, re-seed only through operator command |
| Non-regression | launchpad unchanged, listener never submits transactions (existing guard test) |

Postgres-backed cases follow the existing `*.postgres.test.ts` convention.

## Validation criteria (run only on explicit operator authorisation)

Observation A, observe-only, at least 120 s:

- `BOOTSTRAP_OK=true`, `coverageState=HEALTHY`, `TRANSACTION_SUBMISSION=false`.
- Launchpad: unchanged criteria (at least 5 successful sweeps, 0 `CATCH_UP_WINDOW_EXCEEDED`). One
  cutover authorised, launchpad only.
- Market, per tracked pool: at least 10 successful sweeps, 0 `CATCH_UP_WINDOW_EXCEEDED`, checkpoint
  advancing or unchanged for lack of activity.
- RPC pressure from the `Pression RPC du listener.` log: 0 HTTP 429 expected, bounded inbox backlog,
  `getTransaction` rate in line with real trades on tracked pools.
- At least one tracked pool must be present, either from a recent migration or from an explicitly
  authorised operator seeding.

Observation B: restart within 15 s, no cutover of any kind, each pool resumes exactly from its final A
checkpoint, same coverage criteria.
