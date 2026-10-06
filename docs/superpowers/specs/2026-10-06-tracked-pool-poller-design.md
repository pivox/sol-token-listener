# Tracked pool poller — design

Date: 2026-10-06
Status: approved in conversation
Base: `main` at `a2cd6ab`

## Problem

The live canary runs the listener with `LISTENER_INGESTION_SCOPE=launchpad-only`, because the
program-wide PumpSwap feed (~800 signatures/s, 19,913 of 21,405 inbox rows in an early H2i run)
overloaded the RPC quota. In that scope the pipeline still decodes PumpSwap trades it receives, but
no PumpSwap signature is ever ingested, so `market_trades` stops filling once a token migrates.

Two exit rules of `creation-entry-v1` — **N distinct external buyers** and **creator early sell** —
are computed from bonding-curve trades *and* `market_trades` after the entry cursor
(`src/application/creation-entry-v1.strategy.ts:652-704`). After a migration they go blind.
Everything else already works without the feed: migration detection (pump.fun `migrate` tx),
take-profit and SELL quotes (pool reserves read by RPC), live SELL routing (`migrations JOIN
market_pools`), and the deadline exit (H2a recovery lane).

## Goal

Ingest PumpSwap trades for the few pools whose mint the project already tracks, with the smallest
possible change: no WebSocket work, no new ingestion mode, no live guard.

## Design

A new `TrackedPoolPoller` runs behind `LISTENER_TRACKED_POOL_POLL_ENABLED` (default `false`,
restart-only). Every `LISTENER_TRACKED_POOL_POLL_INTERVAL_MS` (default 10 000, 5 000–60 000),
sequentially:

1. **Select pools.** `market_pools` rows with `pool_state='active' AND confirmation_status<>'orphaned'
   AND pool_index=0` whose `base_mint` is returned by the existing `listWorkerTrackingMints`
   (fresh launches, eligible candidates, active paper sessions, paper positions, open execution
   intents, live positions). Cap 20 pools, most recently activated first; log a warning past the cap.
2. **Seed checkpoints.** A pool without a checkpoint gets one from its activation event
   (`market_pools.activation_event_id → domain_events.signature/slot`), `INSERT … ON CONFLICT DO
   NOTHING`. No trade after migration is lost; no cutover ever needed.
3. **Poll.** `rpc.http.getSignaturesForAddress(pool, { before, until: checkpoint.signature, limit:
   1000 }, 'finalized')`, at most 5 pages. `rpc.http` is the `SHARED_CLIENT` role: failover,
   attempt budget and role telemetry apply unchanged. Page checks mirror the strict scanner: slots
   never increase, no duplicate signature, no reused cursor, no row older than the checkpoint.
4. **Confirm the boundary.** One extra request `{ before: oldest signature read, limit: 1 }` must
   return exactly the checkpoint (signature and slot); otherwise nothing is enqueued and the
   checkpoint stays. This is also the normal outcome during the ~15 s before the migration
   transaction is finalized: the pool is "awaiting finalization", not failed.
5. **Enqueue.** Each signature enters the inbox with `source: 'CATCH_UP'`, `ingestionHint:
   'PUMPSWAP_POOL_TRADE'`, `ingestionHintMint: base_mint`, `programIds: [PUMPSWAP_PROGRAM_ID]`,
   `confirmationStatus: 'finalized'`. The inbox deduplicates by signature.
6. **Advance the checkpoint** to the newest signature (monotonic `WHERE slot <= new`).

### Inbox changes

- `TRANSACTION_INGESTION_HINTS` gains `PUMPSWAP_POOL_TRADE` (mint required). The notification
  validator allows this hint with `source: 'CATCH_UP'`.
- `convergeIngestion`: `PUMPSWAP_POOL_TRADE` → priority `TRACKED_TRADE`, status `PENDING`. The
  poller only enqueues tracked mints, so no authority re-check. Rows touching more than one program
  keep the existing `NORMAL/NONE` rule.
- `storedIngestionDecision` accepts the hint with `TRACKED_TRADE`; `enqueue` takes the mint lock for
  it as for `PUMPFUN_TRADE`; the admitted `TRACKED_TRADE` claim and preview SQL accept both hints.
- Within the `TRACKED_TRADE` lane, `PUMPFUN_TRADE` rows are claimed before `PUMPSWAP_POOL_TRADE` rows
  (then by slot as today): finalized pool rows are 15-25 s older than live bonding-curve rows and must
  not delay the trades that drive entries and exits. Ratios between lanes are unchanged.
- `hasNonTerminalProgramWork` ignores rows with `ingestion_hint='PUMPSWAP_POOL_TRADE'`, so poller
  rows cannot block a multi-worker restart.
- `syncTrackedMint`, `DEFERRED` handling and retention stay as they are: when a mint stops being
  tracked the poller simply stops polling it.

### Migration 060 `listener_tracked_pool_checkpoints`

- Table: `pool_address TEXT PRIMARY KEY REFERENCES market_pools ON DELETE CASCADE`, `slot NUMERIC(78,0)
  NOT NULL CHECK (slot >= 0)`, `signature TEXT NOT NULL CHECK (length BETWEEN 1 AND 128)`,
  `updated_at TIMESTAMPTZ NOT NULL`.
- `chain_transaction_inbox_ingestion_hint_check` widened so `PUMPSWAP_POOL_TRADE` carries a canonical
  mint like `PUMPFUN_TRADE`. No other constraint changes.
- Head bump in `live-catalog.ts` (name + sha256), both `startup-validator.ts` (`migrationHead`),
  `scripts/deployment-smoke.mjs`, and the tests asserting `059_…` as head.

### Unchanged on purpose

WebSocket session, strict scanner, `launchpad`/`market` checkpoints, pipeline, API state
(`pumpswap` stays `IDLE`: otherwise the API would require a fresh `market` checkpoint),
`listener-runtime.ts` (the poller is started/closed by the factory's returned wrapper, like the
attempt budget), heartbeat payload (cycle logs only), no live coverage guard (entries are
bonding-curve only; the deadline exit guarantees an exit).

### Errors

Per pool, per cycle: RPC error, 429, timeout, or an inconsistent page (increasing slots, duplicate
signature, row older than the checkpoint, non-finalized row) → the pool fails this cycle, checkpoint
unchanged, other pools continue; a timed-out sweep makes no further RPC call. Failed transactions
(`err` set) are not enqueued but still advance the checkpoint. **Page budget exhausted** (5 full pages
without reaching the checkpoint, probe unconfirmed) → the pool catches up to the live edge: the rows
read are enqueued, the checkpoint moves to the newest one, and the pool is reported `GAP_SKIPPED` with
the oldest slot read, so the gap is auditable. Trades older than the gap are lost for the "N buyers"
count (the deadline exit still sells); a pool is never left blind. Selection or database failure →
cycle fails, logged, retried next cycle. Shutdown waits at most the listener shutdown timeout for an
in-flight cycle and always proceeds to the runtime shutdown. The first cycle does not block
`start()`, so the API opens without waiting for it.

### Observability

One log per cycle (`listener.tracked_pool_poll_cycle`: tracked, enqueued, succeeded, failed,
awaiting boundary, gap skipped) and one per pool unless it succeeded this cycle and the previous one.
No URLs or keys.

## Lot 2 — cleanup

`src/executor-live/deadline-exit.service.ts` is an unused façade (the deadline exit runs in the H2a
recovery lane). Delete it, its test `tests/executor-live-deadline-exit.test.ts`, and its entry in
`tests/executor-architecture.test.ts`.

## Validation (observe-only, on explicit operator authorisation, after migration 060 is applied)

- `launchpad-only`, poller enabled, `TRANSACTION_SUBMISSION=false`.
- At least one tracked pool during the run (a mint with an active paper session that migrated).
- For that pool: ≥ 10 successful cycles, no window exceeded, `market_trades` rows appearing after
  the migration.
- Role telemetry: 0 HTTP 429 on `SHARED_CLIENT`.
- API `pumpswap` stays `IDLE`, health not degraded.
- Checklist line: H2a (recovery) runs alongside H2b.
- Precondition to confirm: in `launchpad-only` with bounded admission ON, the `migrate` transaction
  (WebSocket, no hint) must still be admitted, or `market_pools` never fills. Admission is OFF by
  default today.
