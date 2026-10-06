# Tracked Pool Poller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In `launchpad-only` scope, ingest PumpSwap trades for the pools whose mint the project already tracks, by polling each pool's signatures and enqueuing them into the existing inbox.

**Architecture:** One new recurring component (`TrackedPoolPoller`) + one small repository (pool selection and per-pool checkpoints) + a new inbox hint `PUMPSWAP_POOL_TRADE` carried on `source: 'CATCH_UP'` notifications. Migration 060 adds the checkpoint table and widens one CHECK. The poller is started/closed by the wrapper the factory already returns; `listener-runtime.ts` is untouched.

**Tech Stack:** TypeScript ESM, `node:test` via `tsx`, `pg`, `@solana/web3.js`.

**Spec:** `docs/superpowers/specs/2026-10-06-tracked-pool-poller-design.md`

**Conventions (main):**
- Worktree: `/Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/reconcile`, branch `feature/market-per-pool-tracking-v2`. Run everything from there.
- Tests: `npx tsx --test tests/<file>.test.ts`; full suite `npm run test:backend`; typecheck `npm run check:backend`; lint `npm run lint:backend` (or `npx eslint <files>`).
- Tests are declared `void test(...)`. Postgres tests read `TEST_DATABASE_URL`, `context.skip` when unset, and use a per-file `withTemporarySchema` + `migrateDatabase({ pool })` (pattern: `tests/market-observation.repository.test.ts:557-576`). Never use the `solanabot` database.
- Simplicity is a requirement from the user: smallest change, reuse main's machinery, no optional extras.
- Never run the listener, `live:run`, `executor:live:*`, or anything contacting an RPC or the target database.
- Commit after each task (branch is not main), messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Do not push.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `migrations/060_listener_tracked_pool_checkpoints.sql` | create | Checkpoint table + widened `ingestion_hint_check` |
| `src/execution-migrations/live-catalog.ts`, `src/executor-live/startup-validator.ts`, `src/executor-live-recovery/startup-validator.ts`, `scripts/deployment-smoke.mjs`, tests citing `059_…` | modify | Migration head bump |
| `src/domain/transaction-ingestion.ts` | modify | New hint, validator |
| `src/storage/transaction-inbox.repository.ts` | modify | Priority, stored decision, claim SQL, mint lock, guard exemption |
| `src/storage/tracked-pool.repository.ts` | create | `listTrackedPools`, `readCheckpoint`, `seedCheckpoint`, `storeCheckpoint` |
| `src/application/tracked-pool-poller.ts` | create | Recurring cycle: select, seed, poll, confirm, enqueue, advance |
| `src/config/env.ts`, `.env.example` | modify | Two settings |
| `src/application/production-listener-factory.ts` | modify | Build the poller when enabled; start/close in the returned wrapper |
| `src/executor-live/deadline-exit.service.ts`, `tests/executor-live-deadline-exit.test.ts`, `tests/executor-architecture.test.ts` | delete / modify | Lot 2 cleanup |

---

### Task 1: Migration 060 and head bump

**Files:**
- Create: `migrations/060_listener_tracked_pool_checkpoints.sql`
- Modify: `src/execution-migrations/live-catalog.ts` (CATALOG, after the `059` line), `src/executor-live/startup-validator.ts:34,592`, `src/executor-live-recovery/startup-validator.ts:39,265`, `scripts/deployment-smoke.mjs:114`, every test returned by `grep -rl 059_transaction_inbox_qualification_attribution tests` (35 files; template commit: `git show --stat b41342c`)
- Test: `tests/transaction-inbox-pool-trade-migration.test.ts`

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS listener_tracked_pool_checkpoints (
  pool_address TEXT PRIMARY KEY REFERENCES market_pools(pool_address) ON DELETE CASCADE,
  slot NUMERIC(78,0) NOT NULL CHECK (slot >= 0),
  signature TEXT NOT NULL CHECK (LENGTH(signature) BETWEEN 1 AND 128),
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT chain_transaction_inbox_ingestion_hint_check,
  ADD CONSTRAINT chain_transaction_inbox_ingestion_hint_check CHECK (
    (ingestion_hint IN ('NONE', 'PUMPFUN_CREATE') AND ingestion_hint_mint IS NULL)
    OR (ingestion_hint IN ('PUMPFUN_TRADE', 'PUMPSWAP_POOL_TRADE') AND ingestion_hint_mint IS NOT NULL
      AND ingestion_hint_mint = BTRIM(ingestion_hint_mint)
      AND OCTET_LENGTH(ingestion_hint_mint) BETWEEN 32 AND 44
      AND ingestion_hint_mint COLLATE "C" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  );
```

Copy the mint predicate exactly from `migrations/047_transaction_inbox_tracked_trade_priority.sql:240-246`. Check with `grep -n "PUMPFUN_TRADE" migrations/048*.sql migrations/049*.sql` that no other CHECK rejects a `PUMPSWAP_POOL_TRADE` row with no catch-up classification (they only constrain classified rows; if one does apply to unclassified rows, widen it in this same file).

- [ ] **Step 2: Write the failing Postgres test**

Follow `tests/transaction-inbox-tracked-trade-migration.test.ts` for the harness. The test: migrate a temporary schema, insert a minimal `market_pools` row (read `migrations/005_pumpswap_market.sql:23-51` for required columns, or copy an insert helper from `tests/market-observation.repository.test.ts`), then assert:
- an insert into `listener_tracked_pool_checkpoints` works and `slot < 0` is rejected;
- an insert into `chain_transaction_inbox` with `ingestion_hint='PUMPSWAP_POOL_TRADE'` and a canonical mint is accepted, with a `NULL` mint rejected, and `'PUMPFUN_TRADE'` still accepted (copy an existing inbox insert from `tests/transaction-inbox.repository.test.ts:117`);
- `migration_history` ends with `060_listener_tracked_pool_checkpoints.sql`.

- [ ] **Step 3: Run it and confirm it fails**

Run: `TEST_DATABASE_URL=<disposable db> npx tsx --test tests/transaction-inbox-pool-trade-migration.test.ts`
Expected: the `PUMPSWAP_POOL_TRADE` insert fails the CHECK, and the head assertion fails. Without a database the test skips; then at least confirm `npm run test:backend` fails on the head assertions after step 4's catalog change until the tests are updated.

- [ ] **Step 4: Bump the head**

`shasum -a 256 migrations/060_listener_tracked_pool_checkpoints.sql` → add `060_listener_tracked_pool_checkpoints.sql <sha>` to `CATALOG`. Replace `059_transaction_inbox_qualification_attribution.sql` by `060_listener_tracked_pool_checkpoints.sql` in both `startup-validator.ts` (type literal and value), append the 060 name to the array in `scripts/deployment-smoke.mjs`, and update the 35 tests: where a test asserts the head (`canonical.at(-1)`, `migrationHead`, regexes) use 060; where it lists all migrations, append 060. Do not change tests that read `059_…` as a file to apply.

- [ ] **Step 5: Verify**

Run: `npm run check:backend && npm run test:backend` (and the new test with a database if available).
Expected: exit 0, `fail 0`. Commit: `feat(migrations): add tracked pool checkpoints and PUMPSWAP_POOL_TRADE hint (060)`.

---

### Task 2: Inbox hint `PUMPSWAP_POOL_TRADE`

**Files:**
- Modify: `src/domain/transaction-ingestion.ts:94-98` (hints), `:487-490` (CATCH_UP rule), `:504-509` (`isValidIngestionHintPair`)
- Modify: `src/storage/transaction-inbox.repository.ts`: `StoredIngestionHint` (~202), `enqueue` mint lock (~591-593), `convergeIngestion` (~4175-4231), `storedIngestionDecision` (~4300-4315), admitted claim SQL (~1463) and preview (~1555), `hasNonTerminalProgramWork` (~1681-1702)
- Test: `tests/tracked-pool-trade-ingestion.test.ts` (Postgres; reuse the harness and fixtures of `tests/tracked-trade-ingestion.integration.test.ts`)

- [ ] **Step 1: Write the failing test**

Cases, each through the real `PostgresTransactionInboxRepository`:
1. `enqueue({ source: 'CATCH_UP', ingestionHint: 'PUMPSWAP_POOL_TRADE', ingestionHintMint: <mint>, programIds: [PUMPSWAP_PROGRAM_ID], confirmationStatus: 'finalized', ... })` stores `ingestion_priority='TRACKED_TRADE'`, `processing_status='PENDING'`, `ingestion_hint='PUMPSWAP_POOL_TRADE'`.
2. With the worker admission policy **enabled**, the row has `worker_admitted_at IS NOT NULL` and `claim()` returns it (the mint must be in the tracking authority: seed an active paper session or use the fixture the integration test uses).
3. With admission **disabled**, `claim()` also returns it.
4. Re-enqueuing the same signature is idempotent (no error, single row).
5. `hasNonTerminalProgramWork(PUMPSWAP_PROGRAM_ID)` is `false` when the only PumpSwap rows are `PUMPSWAP_POOL_TRADE` rows, `true` with a `NONE`-hint PumpSwap row.
6. Validator: `assertValidTransactionNotification` rejects `PUMPSWAP_POOL_TRADE` with a `null` mint, and rejects `source: 'CATCH_UP'` with `PUMPFUN_TRADE` (unchanged rule). This case is pure and goes in the same file without a database.

- [ ] **Step 2: Run it and confirm it fails**

Run: `TEST_DATABASE_URL=<disposable db> npx tsx --test tests/tracked-pool-trade-ingestion.test.ts`
Expected: the validator rejects the hint (`Transaction notification ingestion hint is invalid.`).

- [ ] **Step 3: Implement**

Domain:
- Add `'PUMPSWAP_POOL_TRADE'` to `TRANSACTION_INGESTION_HINTS`.
- `isValidIngestionHintPair`: `(hint === 'PUMPFUN_TRADE' || hint === 'PUMPSWAP_POOL_TRADE') && typeof mint === 'string' && isCanonicalSolanaProgramId(mint)`.
- CATCH_UP rule: `if (record.source === 'CATCH_UP' && record.ingestionHint !== null && record.ingestionHint !== 'PUMPSWAP_POOL_TRADE') throw …` (keep the mint consistency covered by the pair check).

Repository:
- `StoredIngestionHint` union gains the hint.
- `enqueue`: lock the mint for both trade hints (`if (value.ingestionHint === 'PUMPFUN_TRADE' || value.ingestionHint === 'PUMPSWAP_POOL_TRADE')`). The `tracked` computation stays `PUMPFUN_TRADE`-only.
- `convergeIngestion`: after the `PUMPFUN_TRADE` branch add
  ```ts
  } else if (hint === 'PUMPSWAP_POOL_TRADE') {
    // The pool poller only enqueues pools whose mint is already tracked.
    priority = 'TRACKED_TRADE';
    if (status === 'DEFERRED') status = 'PENDING';
  }
  ```
  Leave the multi-program / WebSocket-NONE rule above it unchanged. Make sure the "catch-up replay preserves durable trade decision" early return (`incoming.ingestionHint !== 'PUMPFUN_TRADE' && hint === 'PUMPFUN_TRADE' && current !== null`) is not triggered for our hint (it is not: `hint` is ours).
- `storedIngestionDecision`: accept the hint; assert a canonical mint for both trade hints; allow `TRACKED_TRADE` with either trade hint.
- Admitted claim SQL (~1463): `AND inbox.ingestion_hint IN ('PUMPFUN_TRADE','PUMPSWAP_POOL_TRADE')`. Check the preview (~1555) and any other `ingestion_hint='PUMPFUN_TRADE'` filter in claim paths (`grep -n "ingestion_hint='PUMPFUN_TRADE'" src/storage/transaction-inbox.repository.ts`): widen those that select claimable `TRACKED_TRADE` rows; leave `syncTrackedMint`, demotion and DEFERRED-specific SQL alone.
- `hasNonTerminalProgramWork`: add `AND ingestion_hint <> 'PUMPSWAP_POOL_TRADE'` to the inner `WHERE`.

- [ ] **Step 4: Verify**

Run: the new test, then `npm run check:backend && npm run test:backend`.
Expected: all pass. Commit: `feat(inbox): accept PUMPSWAP_POOL_TRADE catch-up notifications as tracked trades`.

---

### Task 3: Tracked pool repository

**Files:**
- Create: `src/storage/tracked-pool.repository.ts`
- Test: `tests/tracked-pool.repository.test.ts` (Postgres)

- [ ] **Step 1: Write the failing test**

Seed in a temporary schema (after `migrateDatabase`): two `market_pools` rows with their `domain_events` activation rows (copy an insert helper from `tests/market-observation.repository.test.ts`), one active paper session for the first pool's mint (state `PAPER_HOLDING`, see `tests/tracked-trade-ingestion.integration.test.ts` for the minimal rows it needs), none for the second. Assert:
- `listTrackedPools(45)` returns only the first pool, with `baseMint`, `activationSignature`, `activationSlot`;
- `readCheckpoint(pool)` is `null`, `seedCheckpoint(pool, { slot, signature }, nowMs)` creates it, a second seed with other values does not overwrite;
- `storeCheckpoint(pool, { slot: higher, signature }, nowMs)` updates; a lower slot throws;
- a retracted/orphaned pool is excluded; with 25 tracked pools only 20 are returned, newest activation first.

- [ ] **Step 2: Run it and confirm it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
import type { Pool } from 'pg';
import { listWorkerTrackingMints } from './worker-tracking-mint-lock.js';

export interface TrackedPool {
  readonly poolAddress: string;
  readonly baseMint: string;
  readonly activationSignature: string;
  readonly activationSlot: bigint;
}

export interface PoolCheckpoint { readonly slot: bigint; readonly signature: string; }

export const MAX_TRACKED_POOLS = 20;

export class PostgresTrackedPoolRepository {
  public constructor(private readonly pool: Pool) {}

  public async listTrackedPools(trackingWindowSeconds: number): Promise<readonly TrackedPool[]> {
    const client = await this.pool.connect();
    try {
      const mints = await listWorkerTrackingMints(client, trackingWindowSeconds);
      if (mints.length === 0) return Object.freeze([]);
      const result = await client.query<{ pool_address: string; base_mint: string; signature: string; slot: string }>(
        `SELECT p.pool_address, p.base_mint, e.signature, e.slot::text AS slot
           FROM market_pools p
           JOIN domain_events e ON e.event_id = p.activation_event_id
          WHERE p.pool_state = 'active' AND p.confirmation_status <> 'orphaned' AND p.pool_index = 0
            AND p.base_mint = ANY($1::text[])
          ORDER BY e.slot DESC, p.pool_address
          LIMIT $2`,
        [mints, MAX_TRACKED_POOLS],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({
        poolAddress: row.pool_address, baseMint: row.base_mint,
        activationSignature: row.signature, activationSlot: BigInt(row.slot),
      })));
    } finally {
      client.release();
    }
  }

  public async readCheckpoint(poolAddress: string): Promise<PoolCheckpoint | null> { /* SELECT slot::text, signature */ }
  public async seedCheckpoint(poolAddress: string, value: PoolCheckpoint, nowMs: number): Promise<void> { /* INSERT … ON CONFLICT (pool_address) DO NOTHING */ }
  public async storeCheckpoint(poolAddress: string, value: PoolCheckpoint, nowMs: number): Promise<void> {
    /* UPDATE … SET slot=$2, signature=$3, updated_at=$4 WHERE pool_address=$1 AND slot <= $2; throw if rowCount !== 1 */
  }
}
```

Pass slots as `.toString()` strings into NUMERIC parameters. Report whether `listTrackedPools` exceeded the cap by also exposing `countTrackedPools` only if needed by the poller's warning; otherwise the poller logs when the result length equals `MAX_TRACKED_POOLS`.

- [ ] **Step 4: Verify** — run the test, `npm run check:backend`, eslint. Commit: `feat(storage): tracked pool selection and per-pool checkpoints`.

---

### Task 4: `TrackedPoolPoller`

**Files:**
- Create: `src/application/tracked-pool-poller.ts`
- Test: `tests/tracked-pool-poller.test.ts` (no database; fakes)

- [ ] **Step 1: Write the failing test**

Fakes: repository (`listTrackedPools`, `readCheckpoint`, `seedCheckpoint`, `storeCheckpoint`), inbox (`enqueue` collecting notifications), rpc (`getSignaturesForAddress(address, options, commitment)` returning scripted pages keyed by `options.before`/`options.until`/`options.limit`), a manual scheduler (`schedule` records callbacks, `cancel` records handles) and a fixed clock. Cases:
1. a pool without checkpoint is seeded from its activation, then polled;
2. idle pool: one page (empty) + one boundary probe returning the checkpoint → nothing enqueued, checkpoint unchanged, cycle report counts 1 success;
3. two pages then a short page, probe confirms → every signature enqueued as `{ source: 'CATCH_UP', ingestionHint: 'PUMPSWAP_POOL_TRADE', ingestionHintMint, programIds: [PUMPSWAP_PROGRAM_ID], confirmationStatus: 'finalized' }`, checkpoint stored at the newest row;
4. probe does not return the checkpoint → nothing enqueued, checkpoint unchanged, pool counted as `awaitingBoundary`;
5. five full pages (window exceeded) → nothing enqueued, pool counted `windowExceeded`, skipped for 1, then 2, then 4 cycles (backoff), reset after a success;
6. a page with increasing slots, or a duplicate signature, or a row with slot below the checkpoint → pool fails, others continue;
7. rpc throwing for pool A does not prevent pool B; `listTrackedPools` throwing fails the cycle and the next tick retries;
8. `start()` runs a first cycle then schedules at `intervalMs`; `close()` cancels the timer and waits for the in-flight cycle; `state()` is `RUNNING` after a successful cycle, `DEGRADED` after a failed cycle, `STOPPED` after close;
9. exactly 20 pools → the cycle report flags `capReached: true`.

- [ ] **Step 2: Run it and confirm it fails** (module not found).

- [ ] **Step 3: Implement**

Model the lifecycle on `RecurringFinalityReconciler` (`src/application/production-listener-factory.ts:858-1000`): `start()` runs one cycle and schedules; `schedule()` with the injectable scheduler; `close()` cancels and awaits the in-flight cycle (bounded by `shutdownTimeoutMs` with a local `Promise.race`; `settleController` in the factory is not exported — do not export it, keep the poller self-contained). Keep `state()` as `'STOPPED' | 'STARTING' | 'RUNNING' | 'DEGRADED'` from `ListenerRuntimeState`.

Core of one cycle (sequential):

```ts
const pools = await repository.listTrackedPools(trackingWindowSeconds);
for (const pool of pools) {
  if (backoff.skip(pool.poolAddress)) { report.backingOff += 1; continue; }
  let checkpoint = await repository.readCheckpoint(pool.poolAddress);
  if (checkpoint === null) {
    await repository.seedCheckpoint(pool.poolAddress, { slot: pool.activationSlot, signature: pool.activationSignature }, now());
    checkpoint = { slot: pool.activationSlot, signature: pool.activationSignature };
  }
  const outcome = await this.pollPool(pool, checkpoint); // SUCCEEDED | AWAITING_BOUNDARY | WINDOW_EXCEEDED | FAILED
  …
}
```

`pollPool`: pages via `rpc.getSignaturesForAddress(new PublicKey(pool), { before, until: checkpoint.signature, limit: PAGE_SIZE }, 'finalized')` with `PAGE_SIZE = 1000`, `MAX_PAGES = 5`; validate rows with `snapshotCatchUpPage` from `src/solana/rpc/catch-up-source.ts` and the checks listed in the spec; after a short page (or when the page budget is hit), probe `{ before: oldestSignature ?? undefined, limit: 1 }` (no `until`) and require exactly the checkpoint's signature and slot; on a short page + confirmed → enqueue every row (newest first is fine, the inbox orders by slot) then `storeCheckpoint` to `rows[0]`; short page + unconfirmed → `AWAITING_BOUNDARY`; budget hit + confirmed → success; budget hit + unconfirmed → `WINDOW_EXCEEDED` (backoff 1,2,4… cap 64). Any thrown error → `FAILED`. Per-pool work is bounded by a `sweepTimeoutMs` (30 000) race.

Notification built per row:
```ts
Object.freeze({
  signature: row.signature, slot: row.slot, source: 'CATCH_UP',
  ingestionHint: 'PUMPSWAP_POOL_TRADE', ingestionHintMint: pool.baseMint,
  programIds: Object.freeze([PUMPSWAP_PROGRAM_ID]),
  confirmationStatus: 'finalized', observedAtMs: now(),
})
```

Reports: `onCycle({ tracked, capReached, succeeded, awaitingBoundary, windowExceeded, backingOff, failed, enqueued, durationMs })` and `onPool({ poolAddress, outcome, pageCount, signaturesRead, errorName })` only when `outcome !== 'SUCCEEDED'` or the outcome changed since the previous cycle. Never include URLs.

- [ ] **Step 4: Verify** — run the test, `npm run check:backend`, eslint. Commit: `feat(listener): poll tracked PumpSwap pools into the inbox`.

---

### Task 5: Config and factory wiring

**Files:**
- Modify: `src/config/env.ts` (`AppConfig` + `parseConfig`), `.env.example`
- Modify: `src/application/production-listener-factory.ts` (build the poller; wrap start/close in the returned object, ~736-762)
- Test: `tests/config-safety.test.ts` (one case), `tests/production-listener-factory.test.ts` (one source-guard case)

- [ ] **Step 1: Write the failing tests**

Config: defaults `listenerTrackedPoolPollEnabled === false`, `listenerTrackedPoolPollIntervalMs === 10_000`; `LISTENER_TRACKED_POOL_POLL_INTERVAL_MS=4999` and `=60001` rejected; `=true`/`=15000` parsed.

Factory source guard (same style as the file's existing `readFile` + `assert.match` cases at `:71-75`): the source contains `new TrackedPoolPoller(` inside a `config.listenerTrackedPoolPollEnabled` condition, and the returned wrapper calls `poller.start()` after `runtime.start()` and `poller.close()` before `runtime.close()`.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement**

`env.ts`:
```ts
listenerTrackedPoolPollEnabled: parseBoolean(environment.LISTENER_TRACKED_POOL_POLL_ENABLED, false, 'LISTENER_TRACKED_POOL_POLL_ENABLED'),
listenerTrackedPoolPollIntervalMs: parseCanonicalBoundedInteger(environment.LISTENER_TRACKED_POOL_POLL_INTERVAL_MS, 10_000, 'LISTENER_TRACKED_POOL_POLL_INTERVAL_MS', 5_000, 60_000),
```
`.env.example`, next to `LISTENER_INGESTION_SCOPE`:
```
# Poll PumpSwap pools of tracked mints (paper sessions, positions, intents) so post-migration
# trades reach market_trades in launchpad-only scope. Restart-only.
LISTENER_TRACKED_POOL_POLL_ENABLED=false
LISTENER_TRACKED_POOL_POLL_INTERVAL_MS=10000
```

Factory, before the `return runtime` block:
```ts
const poller = config.listenerTrackedPoolPollEnabled
  ? new TrackedPoolPoller(
    new PostgresTrackedPoolRepository(pool),
    inbox,
    rpc.http,
    {
      intervalMs: config.listenerTrackedPoolPollIntervalMs,
      shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
      trackingWindowSeconds: config.listenerPumpFunTrackingWindowSeconds,
      onCycle: (report): void => { logger.info({ event: 'listener.tracked_pool_poll_cycle', ...report }, 'Cycle de sondage des pools suivis terminé.'); },
      onPool: (report): void => { logger.warn({ event: 'listener.tracked_pool_poll_pool', ...report }, 'Pool suivi hors succès.'); },
    },
  )
  : null;
```
Then generalise the existing wrapper so it always exists when `poller !== null || attemptBudget !== undefined`: `start` = `await runtime.start(); try { await poller?.start(); } catch (error) { await runtime.close(); throw error; }`; `close` = `await poller?.close(); attemptBudget?.close(); return runtime.close();`. `state`/`pipelineState` unchanged (poller health is in the logs only, by design).

- [ ] **Step 4: Verify** — `npx tsx --test tests/config-safety.test.ts tests/production-listener-factory.test.ts`, `npm run check:backend`, eslint. Commit: `feat(listener): wire the tracked pool poller behind a flag`.

---

### Task 6: Lot 2 — remove the unused deadline-exit façade

**Files:**
- Delete: `src/executor-live/deadline-exit.service.ts`, `tests/executor-live-deadline-exit.test.ts`
- Modify: `tests/executor-architecture.test.ts:776` (remove `'deadline-exit.service'`)

- [ ] **Step 1:** `grep -rn "deadline-exit.service\|createDeadlineExit\b" src tests scripts docs` — the only code references must be the three above (the recovery lane uses `createNextDeadlineExitIntent`, not this file). If a doc lists the file, update that line.
- [ ] **Step 2:** delete the two files, remove the array entry, run `npx tsx --test tests/executor-architecture.test.ts && npm run check:backend`.
- [ ] **Step 3:** Commit: `chore(executor-live): remove unused deadline-exit façade (exit runs in the H2a recovery lane)`.

---

### Task 7: Final verification

- [ ] `npm run check:backend && npm run lint:backend && npm run test:backend && git diff --check`; with a disposable `TEST_DATABASE_URL`, also run the three Postgres tests from Tasks 1–3. Report exact pass/skip counts and which Postgres tests ran.
- [ ] Hand-off note: migration 060 must be applied to the target database and the observation run only on explicit operator authorisation, with the criteria from the spec's "Validation" section.
