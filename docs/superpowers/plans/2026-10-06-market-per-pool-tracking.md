# Market Per-Pool Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace program-wide PumpSwap ingestion (~800 signatures/s) with ingestion scoped to the tracked pools, so the RPC budget follows real trades on the pools we care about.

**Architecture:** A pure selection function decides which active pools are tracked (6 h window + engaged mints, capped). A `MarketPoolTracker` refreshes that set every market interval, seeds missing per-pool checkpoints from the pool activation event, keeps one `onLogs(pool)` subscription per tracked pool, and runs a finalized `getSignaturesForAddress(pool, { until })` sweep per pool. The launchpad keeps its existing `StartupScanner`/`CatchUpScanner` path, now restricted to launchpad through an enabled-programs option. The live guard checks coverage per mint.

**Tech Stack:** TypeScript (ESM, `tsx`), `node:test`, `@solana/web3.js` 1.98.4, PostgreSQL via `pg`.

**Spec:** `docs/superpowers/specs/2026-10-06-market-per-pool-tracking-design.md`

**Conventions used throughout:**
- Run one test file: `npx tsx --test tests/<file>.test.ts`
- Full backend suite: `npm run test:backend`; typecheck: `npm run check:backend`; lint: `npx eslint <files>`
- Tests are declared `void test(...)` (the lint rule `no-floating-promises` rejects bare `test(...)`).
- Postgres tests read `LIVE_TEST_DATABASE_URL`, skip when it is unset, refuse the `solanabot` database, and work in a throw-away schema (pattern: `tests/recorded-live-edge-cutover.postgres.test.ts`).
- **Never** run the listener, `live:run`, or anything against the target RPC/database while executing this plan. Everything here is offline.
- **Commits:** the working tree already holds many uncommitted changes from earlier work. Do not commit unless the user asks; when asked, stage only the files listed in the task.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/application/market-pool-selection.ts` | create | Pure: which candidate pools are tracked, which are dropped by the cap |
| `migrations/023_market_pool_checkpoints.sql` | create | Per-pool checkpoint table |
| `src/storage/market-pool-tracking.repository.ts` | create | Candidate query, checkpoint read/seed/store/re-seed |
| `src/solana/rpc/pool-signature-source.ts` | create | Finalized `getSignaturesForAddress(pool, { before, until })` page reader |
| `src/application/pool-catch-up-scanner.ts` | create | One pool sweep: page to `until`, enqueue, advance checkpoint |
| `src/solana/rpc/pool-logs-subscriber.ts` | create | Dynamic set of `onLogs(pool)` subscriptions |
| `src/application/market-pool-tracker.ts` | create | Periodic cycle: refresh, seed, sync subscriptions, sweep pools; per-pool coverage |
| `src/application/listener-coverage.ts` | create | Composite scanner (launchpad + market) for the runtime and the live guard |
| `src/cli/market-pool-checkpoint-operator.ts` | create | Operator re-seed of one pool at the finalized frontier |
| `src/solana/rpc/program-subscriber.ts` | modify | `programIds` option; export `snapshotNotification` |
| `src/application/catch-up-scanner.ts` | modify | `programs` option |
| `src/application/production-listener-factory.ts` | modify | `StartupScanner` `programs` option, per-mint guard, wiring |
| `src/config/env.ts`, `.env.example` | modify | `MARKET_TRACKING_WINDOW_HOURS`, `MARKET_TRACKED_POOLS_MAX` |
| `package.json` | modify | `market:pool-checkpoint:operator` script |

---

### Task 1: Tracked pool selection (pure)

**Files:**
- Create: `src/application/market-pool-selection.ts`
- Test: `tests/market-pool-selection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectTrackedPools,
  type TrackedPoolCandidate,
} from '../src/application/market-pool-selection.js';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function candidate(pool: string, ageHours: number, engaged = false): TrackedPoolCandidate {
  return Object.freeze({
    poolAddress: pool,
    baseMint: `mint-${pool}`,
    engaged,
    activatedAtMs: NOW - ageHours * HOUR,
    activationSignature: `sig-${pool}`,
    activationSlot: 1_000n,
  });
}

const options = { nowMs: NOW, windowMs: 6 * HOUR, maxPools: 3 };

void test('tracks pools inside the window and engaged pools outside it', () => {
  const result = selectTrackedPools([
    candidate('fresh', 1),
    candidate('stale', 7),
    candidate('held', 30, true),
  ], options);
  assert.deepEqual(result.tracked.map((pool) => pool.poolAddress).sort(), ['fresh', 'held']);
  assert.deepEqual(result.droppedByCap, []);
});

void test('the cap drops the oldest window-only pools first and never an engaged pool', () => {
  const result = selectTrackedPools([
    candidate('a', 1),
    candidate('b', 2),
    candidate('c', 3),
    candidate('held', 40, true),
  ], options);
  assert.deepEqual(result.tracked.map((pool) => pool.poolAddress), ['held', 'a', 'b']);
  assert.deepEqual(result.droppedByCap.map((pool) => pool.poolAddress), ['c']);
});

void test('engaged pools beyond the cap are all kept', () => {
  const result = selectTrackedPools([
    candidate('h1', 10, true), candidate('h2', 10, true),
    candidate('h3', 10, true), candidate('h4', 10, true),
    candidate('fresh', 1),
  ], options);
  assert.equal(result.tracked.length, 4);
  assert.deepEqual(result.droppedByCap.map((pool) => pool.poolAddress), ['fresh']);
});

void test('rejects invalid options', () => {
  assert.throws(() => selectTrackedPools([], { ...options, maxPools: 0 }), TypeError);
  assert.throws(() => selectTrackedPools([], { ...options, windowMs: -1 }), TypeError);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test tests/market-pool-selection.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `market-pool-selection.js`.

- [ ] **Step 3: Implement**

```ts
export interface TrackedPoolCandidate {
  readonly poolAddress: string;
  readonly baseMint: string;
  readonly engaged: boolean;
  readonly activatedAtMs: number;
  readonly activationSignature: string;
  readonly activationSlot: bigint;
}

export interface TrackedPoolSelectionOptions {
  readonly nowMs: number;
  readonly windowMs: number;
  readonly maxPools: number;
}

export interface TrackedPoolSelection {
  readonly tracked: readonly TrackedPoolCandidate[];
  readonly droppedByCap: readonly TrackedPoolCandidate[];
}

// Engaged pools (paper session or open live position) are never dropped: losing their trade feed
// would blind an exposed position. The cap only trims window-only pools, oldest first.
export function selectTrackedPools(
  candidates: readonly TrackedPoolCandidate[],
  options: TrackedPoolSelectionOptions,
): TrackedPoolSelection {
  if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0
    || !Number.isSafeInteger(options.windowMs) || options.windowMs < 0
    || !Number.isSafeInteger(options.maxPools) || options.maxPools < 1) {
    throw new TypeError('Tracked pool selection options are invalid.');
  }
  const engaged = candidates.filter((pool) => pool.engaged);
  const windowOnly = candidates
    .filter((pool) => !pool.engaged && options.nowMs - pool.activatedAtMs < options.windowMs)
    .sort((left, right) => right.activatedAtMs - left.activatedAtMs
      || left.poolAddress.localeCompare(right.poolAddress));
  const room = Math.max(0, options.maxPools - engaged.length);
  return Object.freeze({
    tracked: Object.freeze([...engaged, ...windowOnly.slice(0, room)]),
    droppedByCap: Object.freeze(windowOnly.slice(room)),
  });
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx tsx --test tests/market-pool-selection.test.ts`
Expected: `ℹ pass 4`, `ℹ fail 0`.

---

### Task 2: Per-pool checkpoint table and repository

**Files:**
- Create: `migrations/023_market_pool_checkpoints.sql`
- Create: `src/storage/market-pool-tracking.repository.ts`
- Modify: `tests/helpers/current-migration-assertions.ts` (no change needed unless a test lists all migrations; check with `grep -rn "022_recorded_live_edge_cutover" tests`)
- Test: `tests/market-pool-tracking.postgres.test.ts`

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS market_pool_checkpoints (
  pool_address TEXT PRIMARY KEY REFERENCES market_pools(pool_address) ON DELETE CASCADE,
  slot NUMERIC(78,0) NOT NULL CHECK (slot >= 0),
  signature TEXT NOT NULL CHECK (length(signature) BETWEEN 1 AND 128),
  source TEXT NOT NULL CHECK (
    source IN ('pool-activation', 'rolling-catch-up', 'operator-approved-pool-frontier-seed')
  ),
  previous JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL
);
```

- [ ] **Step 2: Write the failing Postgres test**

The test builds a minimal schema with only the columns the repository reads, then applies migration 023.

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { PostgresMarketPoolTrackingRepository } from '../src/storage/market-pool-tracking.repository.js';

const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;
const HOUR = 3_600_000;

void test('market pool tracking repository: candidates, seeding, monotonic store, operator re-seed', async (context) => {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('LIVE_TEST_DATABASE_URL must point to a disposable PostgreSQL database.');
    return;
  }
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ''));
  assert.notEqual(databaseName, 'solanabot', 'pool tracking tests must never use the target database');
  const schema = `pool_tracking_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE domain_events (event_id TEXT PRIMARY KEY, signature TEXT NOT NULL,
        slot NUMERIC(78,0) NOT NULL, observed_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE market_pools (pool_address TEXT PRIMARY KEY, base_mint TEXT NOT NULL,
        activation_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
        pool_state TEXT NOT NULL, confirmation_status TEXT NOT NULL);
      CREATE TABLE paper_strategy_sessions (session_id TEXT PRIMARY KEY, mint TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE live_positions (position_id TEXT PRIMARY KEY, mint TEXT NOT NULL, status TEXT NOT NULL);
    `);
    await pool.query(await readFile(new URL('../migrations/023_market_pool_checkpoints.sql', import.meta.url), 'utf8'));

    const now = Date.UTC(2026, 9, 6, 12);
    const seedPool = async (name: string, ageHours: number, state = 'active', status = 'confirmed'): Promise<void> => {
      await pool.query('INSERT INTO domain_events VALUES ($1,$2,$3,$4)',
        [`evt-${name}`, `sig-${name}`, 500, new Date(now - ageHours * HOUR)]);
      await pool.query('INSERT INTO market_pools VALUES ($1,$2,$3,$4,$5)',
        [name, `mint-${name}`, `evt-${name}`, state, status]);
    };
    await seedPool('fresh', 1);
    await seedPool('stale', 10);
    await seedPool('paper', 20);
    await seedPool('live', 30);
    await seedPool('retracted', 1, 'retracted', 'orphaned');
    await pool.query("INSERT INTO paper_strategy_sessions VALUES ('s1','mint-paper','PAPER_HOLDING')");
    await pool.query("INSERT INTO paper_strategy_sessions VALUES ('s2','mint-stale','CLOSED')");
    await pool.query("INSERT INTO live_positions VALUES ('p1','mint-live','RECONCILIATION_REQUIRED')");

    const repository = new PostgresMarketPoolTrackingRepository(pool);
    const candidates = await repository.listCandidates(now - 6 * HOUR);
    assert.deepEqual(
      candidates.map((row) => [row.poolAddress, row.engaged]).sort(),
      [['fresh', false], ['live', true], ['paper', true]],
    );
    const fresh = candidates.find((row) => row.poolAddress === 'fresh');
    assert.equal(fresh?.activationSignature, 'sig-fresh');
    assert.equal(fresh?.activationSlot, 500n);
    assert.equal(fresh?.activatedAtMs, now - HOUR);

    assert.ok(fresh !== undefined);
    await repository.seedFromActivation(fresh, now);
    await repository.storeCheckpoint('fresh', { slot: 600n, signature: 'sig-600' }, now);
    await repository.seedFromActivation(fresh, now);
    assert.deepEqual(await repository.readCheckpoint('fresh'),
      { poolAddress: 'fresh', slot: 600n, signature: 'sig-600' }, 'seeding never overwrites');

    await assert.rejects(
      repository.storeCheckpoint('fresh', { slot: 599n, signature: 'sig-599' }, now),
      /monotonic/u,
    );

    await repository.reseedAtFrontier('fresh', { slot: 900n, signature: 'sig-900' }, now);
    const row = await pool.query<{ source: string; previous: { slot: string; signature: string; source: string } }>(
      "SELECT source, previous FROM market_pool_checkpoints WHERE pool_address='fresh'",
    );
    assert.equal(row.rows[0]?.source, 'operator-approved-pool-frontier-seed');
    assert.deepEqual(row.rows[0]?.previous, { slot: '600', signature: 'sig-600', source: 'rolling-catch-up' });
    assert.equal(await repository.readCheckpoint('stale'), null);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `LIVE_TEST_DATABASE_URL=<disposable db url> npx tsx --test tests/market-pool-tracking.postgres.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `market-pool-tracking.repository.js`. If no disposable database is available, the test skips; note it in the task report and still check that the module import fails by running without the variable (the import error happens before the skip).

- [ ] **Step 4: Implement the repository**

```ts
import type { Pool } from 'pg';
import type { TrackedPoolCandidate } from '../application/market-pool-selection.js';

export interface PoolCheckpoint {
  readonly poolAddress: string;
  readonly slot: bigint;
  readonly signature: string;
}

export interface PoolCheckpointPosition {
  readonly slot: bigint;
  readonly signature: string;
}

// Must match the active-state set of paper_strategy_sessions_active_idx (migration 015).
const ACTIVE_PAPER_STATES = Object.freeze([
  'BUY_PENDING', 'PAPER_HOLDING', 'WAITING_EXTERNAL_BUYS', 'EXIT_PENDING_QUOTE', 'SELL_PENDING',
]);

export class PostgresMarketPoolTrackingRepository {
  public constructor(private readonly pool: Pool) {}

  public async listCandidates(windowStartMs: number): Promise<readonly TrackedPoolCandidate[]> {
    const result = await this.pool.query<{
      pool_address: string; base_mint: string; signature: string; slot: string;
      activated_at_ms: string; engaged: boolean;
    }>(
      `SELECT * FROM (
         SELECT p.pool_address, p.base_mint, e.signature, e.slot::text AS slot,
                floor(extract(epoch FROM e.observed_at) * 1000)::bigint::text AS activated_at_ms,
                (EXISTS (SELECT 1 FROM paper_strategy_sessions s
                          WHERE s.mint = p.base_mint AND s.state = ANY($2::text[]))
                 OR EXISTS (SELECT 1 FROM live_positions l
                          WHERE l.mint = p.base_mint AND l.status IN ('OPEN','RECONCILIATION_REQUIRED'))
                ) AS engaged,
                e.observed_at
           FROM market_pools p
           JOIN domain_events e ON e.event_id = p.activation_event_id
          WHERE p.pool_state = 'active' AND p.confirmation_status <> 'orphaned'
       ) candidate
       WHERE candidate.engaged OR candidate.observed_at >= $1
       ORDER BY candidate.pool_address`,
      [new Date(windowStartMs), ACTIVE_PAPER_STATES],
    );
    return Object.freeze(result.rows.map((row) => Object.freeze({
      poolAddress: row.pool_address,
      baseMint: row.base_mint,
      engaged: row.engaged,
      activatedAtMs: Number(row.activated_at_ms),
      activationSignature: row.signature,
      activationSlot: BigInt(row.slot),
    })));
  }

  public async readCheckpoint(poolAddress: string): Promise<PoolCheckpoint | null> {
    const result = await this.pool.query<{ slot: string; signature: string }>(
      'SELECT slot::text AS slot, signature FROM market_pool_checkpoints WHERE pool_address = $1',
      [poolAddress],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : Object.freeze({ poolAddress, slot: BigInt(row.slot), signature: row.signature });
  }

  public async seedFromActivation(candidate: TrackedPoolCandidate, nowMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO market_pool_checkpoints (pool_address, slot, signature, source, updated_at)
       VALUES ($1, $2, $3, 'pool-activation', $4)
       ON CONFLICT (pool_address) DO NOTHING`,
      [candidate.poolAddress, candidate.activationSlot.toString(), candidate.activationSignature, new Date(nowMs)],
    );
  }

  public async storeCheckpoint(
    poolAddress: string,
    next: PoolCheckpointPosition,
    nowMs: number,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE market_pool_checkpoints
          SET slot = $2, signature = $3, source = 'rolling-catch-up', updated_at = $4
        WHERE pool_address = $1 AND slot <= $2`,
      [poolAddress, next.slot.toString(), next.signature, new Date(nowMs)],
    );
    if (result.rowCount !== 1) {
      throw new Error('Pool checkpoint store refused: missing row or non-monotonic slot.');
    }
  }

  public async reseedAtFrontier(
    poolAddress: string,
    frontier: PoolCheckpointPosition,
    nowMs: number,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE market_pool_checkpoints
          SET previous = jsonb_build_object('slot', slot::text, 'signature', signature, 'source', source),
              slot = $2, signature = $3, source = 'operator-approved-pool-frontier-seed', updated_at = $4
        WHERE pool_address = $1 AND slot <= $2`,
      [poolAddress, frontier.slot.toString(), frontier.signature, new Date(nowMs)],
    );
    if (result.rowCount !== 1) {
      throw new Error('Pool re-seed refused: missing checkpoint or frontier behind the checkpoint.');
    }
  }
}
```

Note: the error message for `storeCheckpoint` contains "monotonic", which the test matches.

- [ ] **Step 5: Run it and confirm it passes**

Run: `LIVE_TEST_DATABASE_URL=<disposable db url> npx tsx --test tests/market-pool-tracking.postgres.test.ts`
Expected: `ℹ pass 1`. Then run `grep -rn "022_recorded_live_edge_cutover" tests src` and, if any test asserts the exact list or count of migrations, add `023_market_pool_checkpoints.sql` there and re-run that test.

---

### Task 3: Finalized pool signature source

**Files:**
- Create: `src/solana/rpc/pool-signature-source.ts`
- Test: `tests/pool-signature-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { CatchUpSourceError } from '../src/solana/rpc/catch-up-source.js';
import { PoolSignatureSource } from '../src/solana/rpc/pool-signature-source.js';

const POOL = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const SIG = '5'.repeat(88);

function row(slot: number, status = 'finalized'): unknown {
  return { signature: SIG.slice(0, 87) + String((slot % 9) + 1), slot, err: null, memo: null, blockTime: null, confirmationStatus: status };
}

void test('reads finalized signatures with before and until', async () => {
  const calls: unknown[] = [];
  const source = new PoolSignatureSource({
    async getSignaturesForAddress(address: PublicKey, options: unknown, commitment: string) {
      calls.push([address.toBase58(), options, commitment]);
      return [row(10)];
    },
  });
  const page = await source.list(POOL, { before: undefined, until: 'until-sig' }, 1_000);
  assert.equal(page.length, 1);
  assert.equal(page[0]?.slot, 10n);
  assert.deepEqual(calls, [[POOL, { before: undefined, until: 'until-sig', limit: 1_000 }, 'finalized']]);
});

void test('rejects a non-finalized row', async () => {
  const source = new PoolSignatureSource({ async getSignaturesForAddress() { return [row(10, 'confirmed')]; } });
  await assert.rejects(source.list(POOL, { before: undefined, until: 'x' }, 10), CatchUpSourceError);
});

void test('wraps RPC failures and invalid pool addresses', async () => {
  const failing = new PoolSignatureSource({ async getSignaturesForAddress() { throw new Error('429'); } });
  await assert.rejects(failing.list(POOL, { before: undefined, until: 'x' }, 10), CatchUpSourceError);
  await assert.rejects(failing.list('not-a-key', { before: undefined, until: 'x' }, 10), CatchUpSourceError);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test tests/pool-signature-source.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement**

```ts
import { PublicKey } from '@solana/web3.js';
import {
  CatchUpSourceError,
  snapshotCatchUpPage,
  type CatchUpSignature,
} from './catch-up-source.js';

export interface PoolSignaturesRpc {
  getSignaturesForAddress(
    address: PublicKey,
    options: { readonly before: string | undefined; readonly until: string; readonly limit: number },
    commitment: 'finalized',
  ): Promise<unknown>;
}

export interface PoolSignatureCursor {
  readonly before: string | undefined;
  readonly until: string;
}

// Finalized reads only: a finalized checkpoint signature cannot be dropped by a fork, which makes
// `until` a safe stop condition. Real-time coverage comes from the processed WebSocket feed.
export class PoolSignatureSource {
  public constructor(private readonly rpc: PoolSignaturesRpc) {}

  public async list(
    poolAddress: string,
    cursor: PoolSignatureCursor,
    limit: number,
  ): Promise<readonly CatchUpSignature[]> {
    let address: PublicKey;
    try {
      address = new PublicKey(poolAddress);
    } catch {
      throw new CatchUpSourceError('request');
    }
    let response: unknown;
    try {
      response = await this.rpc.getSignaturesForAddress(
        address,
        { before: cursor.before, until: cursor.until, limit },
        'finalized',
      );
    } catch {
      throw new CatchUpSourceError('request');
    }
    const page = snapshotCatchUpPage(response, limit);
    if (page.some((row) => row.confirmationStatus !== 'finalized')) {
      throw new CatchUpSourceError('response');
    }
    return page;
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx tsx --test tests/pool-signature-source.test.ts`
Expected: `ℹ pass 3`. If `snapshotCatchUpPage` rejects the fixture rows (e.g. signature format checks), adjust the fixture to a valid 88-char base58 signature, not the source code.

---

### Task 4: One-pool catch-up scanner

**Files:**
- Create: `src/application/pool-catch-up-scanner.ts`
- Test: `tests/pool-catch-up-scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import {
  PoolCatchUpScanner,
  PoolCatchUpWindowExceededError,
  PoolCheckpointMissingError,
} from '../src/application/pool-catch-up-scanner.js';
import type { CatchUpSignature } from '../src/solana/rpc/catch-up-source.js';
import type { PoolCheckpoint } from '../src/storage/market-pool-tracking.repository.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';

function sig(slot: number): CatchUpSignature {
  return Object.freeze({ signature: `sig-${slot}`, slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null });
}

function harness(pages: readonly (readonly CatchUpSignature[])[], checkpoint: PoolCheckpoint | null) {
  const listCalls: unknown[] = [];
  const enqueued: TransactionNotification[] = [];
  const stored: unknown[] = [];
  let pageIndex = 0;
  const scanner = new PoolCatchUpScanner(
    { async list(pool, cursor, limit) { listCalls.push([pool, cursor, limit]); return pages[pageIndex++] ?? []; } },
    { async enqueue(notification) { enqueued.push(notification); } },
    {
      async readCheckpoint() { return checkpoint; },
      async storeCheckpoint(pool, next) { stored.push([pool, next]); },
    },
    { pageSize: 2, maxPages: 3, now: () => 1_000 },
  );
  return { scanner, listCalls, enqueued, stored };
}

const CHECKPOINT: PoolCheckpoint = Object.freeze({ poolAddress: 'pool', slot: 5n, signature: 'sig-5' });

void test('an idle pool costs one request and keeps its checkpoint', async () => {
  const { scanner, listCalls, enqueued, stored } = harness([[]], CHECKPOINT);
  const result = await scanner.scanPool('pool');
  assert.equal(listCalls.length, 1);
  assert.deepEqual(listCalls[0], ['pool', { before: undefined, until: 'sig-5' }, 2]);
  assert.equal(enqueued.length, 0);
  assert.equal(stored.length, 0);
  assert.equal(result.checkpointSlotAfter, '5');
});

void test('pages to until, enqueues every signature, then advances to the newest', async () => {
  const { scanner, listCalls, enqueued, stored } = harness([[sig(9), sig(8)], [sig(7)]], CHECKPOINT);
  const result = await scanner.scanPool('pool');
  assert.deepEqual(listCalls.map((call) => (call as [string, { before?: string }])[1].before), [undefined, 'sig-8']);
  assert.deepEqual(enqueued.map((row) => row.signature), ['sig-9', 'sig-8', 'sig-7']);
  assert.deepEqual(enqueued[0]?.programIds, [PUMPSWAP_PROGRAM_ID]);
  assert.equal(enqueued[0]?.source, 'CATCH_UP');
  assert.deepEqual(stored, [['pool', { slot: 9n, signature: 'sig-9' }]]);
  assert.equal(result.signaturesRead, 3);
  assert.equal(result.pageCount, 2);
  assert.equal(result.checkpointSlotAfter, '9');
});

void test('exceeding the page budget fails without enqueue or checkpoint move', async () => {
  const { scanner, enqueued, stored } = harness([[sig(20), sig(19)], [sig(18), sig(17)], [sig(16), sig(15)]], CHECKPOINT);
  await assert.rejects(scanner.scanPool('pool'), (error: unknown) =>
    error instanceof PoolCatchUpWindowExceededError && error.code === 'CATCH_UP_WINDOW_EXCEEDED');
  assert.equal(enqueued.length, 0);
  assert.equal(stored.length, 0);
});

void test('a pool without checkpoint is refused', async () => {
  const { scanner } = harness([], null);
  await assert.rejects(scanner.scanPool('pool'), PoolCheckpointMissingError);
});

void test('rows older than the checkpoint never move it backwards', async () => {
  const { scanner, stored } = harness([[sig(4)]], CHECKPOINT);
  await scanner.scanPool('pool');
  assert.equal(stored.length, 0);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test tests/pool-catch-up-scanner.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement**

```ts
import type { TransactionNotification } from '../domain/transaction-ingestion.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';
import {
  CatchUpSourceError,
  MAX_CATCH_UP_PAGE_SIZE,
  type CatchUpSignature,
} from '../solana/rpc/catch-up-source.js';
import type { PoolSignatureCursor } from '../solana/rpc/pool-signature-source.js';
import type { PoolCheckpoint, PoolCheckpointPosition } from '../storage/market-pool-tracking.repository.js';
import { MAX_CATCH_UP_PAGES } from './catch-up-scanner.js';

export interface PoolSignaturePageSource {
  list(poolAddress: string, cursor: PoolSignatureCursor, limit: number): Promise<readonly CatchUpSignature[]>;
}

export interface PoolCatchUpRepository {
  readCheckpoint(poolAddress: string): Promise<PoolCheckpoint | null>;
  storeCheckpoint(poolAddress: string, next: PoolCheckpointPosition, nowMs: number): Promise<void>;
}

export interface PoolCatchUpScannerOptions {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly now?: () => number;
}

export interface PoolSweepResult {
  readonly poolAddress: string;
  readonly checkpointSlotBefore: string;
  readonly checkpointSlotAfter: string;
  readonly pageCount: number;
  readonly signaturesRead: number;
  readonly signaturesEnqueued: number;
  readonly newestSlot: string | null;
  readonly oldestSlot: string | null;
}

export class PoolCheckpointMissingError extends Error {
  public readonly code = 'POOL_CHECKPOINT_MISSING' as const;

  public constructor(public readonly poolAddress: string) {
    super('Pool catch-up requires a durable checkpoint.');
    this.name = 'PoolCheckpointMissingError';
  }
}

export class PoolCatchUpWindowExceededError extends Error {
  public readonly code = 'CATCH_UP_WINDOW_EXCEEDED' as const;
  public readonly stage = 'window' as const;

  public constructor(
    public readonly poolAddress: string,
    public readonly pageCount: number,
    public readonly signaturesRead: number,
  ) {
    super('Pool catch-up window was exceeded.');
    this.name = 'PoolCatchUpWindowExceededError';
  }
}

export class PoolCatchUpScanner {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly now: () => number;

  public constructor(
    private readonly source: PoolSignaturePageSource,
    private readonly inbox: Pick<TransactionInboxRepository, 'enqueue'>,
    private readonly repository: PoolCatchUpRepository,
    options: PoolCatchUpScannerOptions,
  ) {
    if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > MAX_CATCH_UP_PAGE_SIZE
      || !Number.isSafeInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > MAX_CATCH_UP_PAGES) {
      throw new TypeError('Pool catch-up bounds are invalid.');
    }
    this.pageSize = options.pageSize;
    this.maxPages = options.maxPages;
    this.now = options.now ?? Date.now;
  }

  public async scanPool(poolAddress: string): Promise<PoolSweepResult> {
    const checkpoint = await this.repository.readCheckpoint(poolAddress);
    if (checkpoint === null) throw new PoolCheckpointMissingError(poolAddress);

    const rows: CatchUpSignature[] = [];
    let before: string | undefined;
    let pageCount = 0;
    for (;;) {
      if (pageCount === this.maxPages) {
        throw new PoolCatchUpWindowExceededError(poolAddress, pageCount, rows.length);
      }
      const page = await this.source.list(poolAddress, { before, until: checkpoint.signature }, this.pageSize);
      pageCount += 1;
      rows.push(...page);
      if (page.length < this.pageSize) break;
      const cursor = page.at(-1)?.signature;
      if (cursor === undefined || cursor === before) throw new CatchUpSourceError('pagination');
      before = cursor;
    }

    const observedAtMs = this.now();
    for (const row of rows) {
      const notification: TransactionNotification = Object.freeze({
        signature: row.signature,
        slot: row.slot,
        source: 'CATCH_UP',
        programIds: Object.freeze([PUMPSWAP_PROGRAM_ID]),
        confirmationStatus: row.confirmationStatus,
        observedAtMs,
      });
      await this.inbox.enqueue(notification);
    }

    const newest = rows[0];
    const advanced = newest !== undefined && newest.slot >= checkpoint.slot;
    if (advanced) {
      await this.repository.storeCheckpoint(
        poolAddress,
        { slot: newest.slot, signature: newest.signature },
        observedAtMs,
      );
    }
    return Object.freeze({
      poolAddress,
      checkpointSlotBefore: checkpoint.slot.toString(),
      checkpointSlotAfter: (advanced ? newest.slot : checkpoint.slot).toString(),
      pageCount,
      signaturesRead: rows.length,
      signaturesEnqueued: rows.length,
      newestSlot: rows[0]?.slot.toString() ?? null,
      oldestSlot: rows.at(-1)?.slot.toString() ?? null,
    });
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx tsx --test tests/pool-catch-up-scanner.test.ts`
Expected: `ℹ pass 5`. If `TransactionNotification`'s `source` or `confirmationStatus` types differ from what the existing `CatchUpScanner.persistScans` uses (`src/application/catch-up-scanner.ts:316-323`), align with that code.

---

### Task 5: Per-pool WebSocket subscriptions

**Files:**
- Modify: `src/solana/rpc/program-subscriber.ts` (export `snapshotNotification`, add `programIds` option)
- Create: `src/solana/rpc/pool-logs-subscriber.ts`
- Test: `tests/pool-logs-subscriber.test.ts`, `tests/program-subscriber.test.ts` (one new case)

- [ ] **Step 1: Write the failing tests**

`tests/pool-logs-subscriber.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicKey } from '@solana/web3.js';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { PoolLogsSubscriber } from '../src/solana/rpc/pool-logs-subscriber.js';
import type { ProgramLogsCallback, ProgramLogsConnection } from '../src/solana/rpc/program-subscriber.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';

const POOL_A = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const POOL_B = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SIGNATURE = '5'.repeat(88);

class FakeConnection implements ProgramLogsConnection {
  public nextId = 1;
  public readonly callbacks = new Map<number, ProgramLogsCallback>();
  public readonly filters = new Map<number, string>();
  public readonly stateWatchers = new Map<number, (state: string) => void>();
  public readonly removed: number[] = [];
  onLogs(filter: PublicKey, callback: ProgramLogsCallback): unknown {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    this.filters.set(id, filter.toBase58());
    return id;
  }
  watchSubscriptionState(id: number, callback: (state: string) => void): () => void {
    this.stateWatchers.set(id, callback);
    return () => { this.stateWatchers.delete(id); };
  }
  async removeOnLogsListener(id: number): Promise<void> { this.removed.push(id); }
  idFor(pool: string): number {
    const entry = [...this.filters].find(([, filter]) => filter === pool);
    assert.ok(entry !== undefined);
    return entry[0];
  }
}

void test('sync subscribes new pools and unsubscribes pools that left', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A, POOL_B]);
  assert.deepEqual([...connection.filters.values()].sort(), [POOL_A, POOL_B].sort());
  const idB = connection.idFor(POOL_B);
  await subscriber.sync([POOL_A]);
  assert.deepEqual(connection.removed, [idB]);
});

void test('a pool is healthy only after its subscription is acknowledged', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A]);
  assert.equal(subscriber.isHealthy(POOL_A), false);
  connection.stateWatchers.get(connection.idFor(POOL_A))?.('subscribed');
  assert.equal(subscriber.isHealthy(POOL_A), true);
  connection.stateWatchers.get(connection.idFor(POOL_A))?.('pending');
  assert.equal(subscriber.isHealthy(POOL_A), false);
});

void test('a failed subscription is replaced at the next sync', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A]);
  const first = connection.idFor(POOL_A);
  connection.stateWatchers.get(first)?.('subscribed');
  connection.stateWatchers.get(first)?.('unsubscribed');
  await subscriber.sync([POOL_A]);
  assert.deepEqual(connection.removed, [first]);
  assert.notEqual(connection.idFor(POOL_A), first);
});

void test('notifications are enqueued as PumpSwap WebSocket discoveries', async () => {
  const connection = new FakeConnection();
  const enqueued: TransactionNotification[] = [];
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue(value) { enqueued.push(value); } }, () => 42);
  await subscriber.sync([POOL_A]);
  connection.callbacks.get(connection.idFor(POOL_A))?.({ signature: SIGNATURE, err: null, logs: [] }, { slot: 77 });
  await subscriber.drain();
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.slot, 77n);
  assert.equal(enqueued[0]?.source, 'WEBSOCKET');
  assert.deepEqual(enqueued[0]?.programIds, [PUMPSWAP_PROGRAM_ID]);
});

void test('close removes every subscription and stops accepting', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A, POOL_B]);
  await subscriber.close();
  assert.equal(connection.removed.length, 2);
  await subscriber.sync([POOL_A]);
  assert.equal(connection.filters.size, 2, 'no new subscription after close');
});
```

Add to `tests/program-subscriber.test.ts` a case asserting that `new SolanaProgramSubscriber(connection, repository, { programIds: [PUMP_PROGRAM_ID] })` calls `onLogs` exactly once, with the pump.fun program. Reuse the fake connection already defined in that file; read the file first and follow its existing helpers.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx tsx --test tests/pool-logs-subscriber.test.ts tests/program-subscriber.test.ts`
Expected: `pool-logs-subscriber` fails with `ERR_MODULE_NOT_FOUND`; the new program-subscriber case fails because `onLogs` is called twice.

- [ ] **Step 3: Modify `program-subscriber.ts`**

1. Change `function snapshotNotification(` to `export function snapshotNotification(`.
2. Add to `ProgramSubscriberOptions`: `readonly programIds?: readonly string[];`
3. Add a field `private readonly programIds: readonly string[];` and set it in the constructor:

```ts
    const programIds = options.programIds ?? PROGRAM_IDS;
    if (programIds.length === 0 || new Set(programIds).size !== programIds.length) {
      throw new TypeError('Program subscriber program list is invalid.');
    }
    this.programIds = Object.freeze([...programIds]);
```

4. In `installListeners`, replace `for (const programId of PROGRAM_IDS)` with `for (const programId of this.programIds)`.

- [ ] **Step 4: Implement `pool-logs-subscriber.ts`**

```ts
import { PublicKey } from '@solana/web3.js';
import { PUMPSWAP_PROGRAM_ID } from '../../markets/pumpswap/constants.js';
import {
  PROGRAM_SUBSCRIBER_COMMITMENT,
  snapshotNotification,
  type ProgramLogsConnection,
  type ProgramSubscriberRepository,
} from './program-subscriber.js';

interface PoolListener {
  readonly id: number;
  readonly unwatch: () => void;
  subscribed: boolean;
  failed: boolean;
}

// One logsSubscribe(mentions: [pool]) per tracked pool. A listener that loses its subscription or
// fails an enqueue is marked failed and replaced at the next sync; the finalized pool sweep then
// recovers anything the WebSocket missed.
export class PoolLogsSubscriber {
  private readonly listeners = new Map<string, PoolListener>();
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  public constructor(
    private readonly connection: ProgramLogsConnection,
    private readonly repository: ProgramSubscriberRepository,
    private readonly now: () => number = Date.now,
  ) {}

  public async sync(pools: readonly string[]): Promise<void> {
    if (this.closed) return;
    const wanted = new Set(pools);
    for (const [pool, listener] of [...this.listeners]) {
      if (!wanted.has(pool) || listener.failed) await this.remove(pool, listener);
    }
    for (const pool of wanted) {
      if (!this.listeners.has(pool)) this.add(pool);
    }
  }

  public isHealthy(pool: string): boolean {
    const listener = this.listeners.get(pool);
    return listener !== undefined && listener.subscribed && !listener.failed;
  }

  public async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const [pool, listener] of [...this.listeners]) await this.remove(pool, listener);
    await this.drain();
  }

  private add(pool: string): void {
    const state = { subscribed: false, failed: false };
    const id = this.connection.onLogs(
      new PublicKey(pool),
      (notification, context) => { this.receive(pool, notification, context); },
      PROGRAM_SUBSCRIBER_COMMITMENT,
    );
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      throw new TypeError('Pool log subscription id is invalid.');
    }
    const unwatch = this.connection.watchSubscriptionState(id, (subscriptionState) => {
      const listener = this.listeners.get(pool);
      if (listener === undefined || listener.id !== id) return;
      if (subscriptionState === 'subscribed') listener.subscribed = true;
      else if (listener.subscribed) listener.failed = true;
    });
    this.listeners.set(pool, { id, unwatch, ...state });
  }

  private async remove(pool: string, listener: PoolListener): Promise<void> {
    this.listeners.delete(pool);
    listener.unwatch();
    await this.connection.removeOnLogsListener(listener.id);
  }

  private receive(pool: string, value: unknown, context: unknown): void {
    if (this.closed) return;
    const listener = this.listeners.get(pool);
    let notification;
    try {
      notification = snapshotNotification(PUMPSWAP_PROGRAM_ID, value, context, this.now());
    } catch {
      if (listener !== undefined) listener.failed = true;
      return;
    }
    if (notification === null) return;
    const task = this.repository.enqueue(notification)
      .catch(() => { if (listener !== undefined) listener.failed = true; });
    this.inFlight.add(task);
    void task.then(() => { this.inFlight.delete(task); });
  }
}
```

- [ ] **Step 5: Run them and confirm they pass**

Run: `npx tsx --test tests/pool-logs-subscriber.test.ts tests/program-subscriber.test.ts`
Expected: all pass, including every pre-existing program-subscriber case.

---

### Task 6: Market pool tracker

**Files:**
- Create: `src/application/market-pool-tracker.ts`
- Test: `tests/market-pool-tracker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketPoolTracker, type PoolSweepReport } from '../src/application/market-pool-tracker.js';
import type { TrackedPoolCandidate } from '../src/application/market-pool-selection.js';
import { PoolCatchUpWindowExceededError, type PoolSweepResult } from '../src/application/pool-catch-up-scanner.js';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function candidate(pool: string, ageHours = 1, engaged = false): TrackedPoolCandidate {
  return Object.freeze({
    poolAddress: pool, baseMint: `mint-${pool}`, engaged,
    activatedAtMs: NOW - ageHours * HOUR, activationSignature: `sig-${pool}`, activationSlot: 1n,
  });
}

function sweep(pool: string): PoolSweepResult {
  return Object.freeze({
    poolAddress: pool, checkpointSlotBefore: '1', checkpointSlotAfter: '2', pageCount: 1,
    signaturesRead: 1, signaturesEnqueued: 1, newestSlot: '2', oldestSlot: '2',
  });
}

class ManualScheduler {
  public readonly callbacks: (() => void)[] = [];
  schedule(callback: () => void): unknown { this.callbacks.push(callback); return callback; }
  cancel(): void {}
}

function harness(options: {
  candidates: () => readonly TrackedPoolCandidate[];
  failingPools?: ReadonlySet<string>;
  maxPools?: number;
}) {
  const seeded: string[] = [];
  const synced: (readonly string[])[] = [];
  const healthy = new Set<string>();
  const reports: PoolSweepReport[] = [];
  const tracker = new MarketPoolTracker(
    {
      repository: {
        async listCandidates() { return options.candidates(); },
        async seedFromActivation(pool) { seeded.push(pool.poolAddress); },
      },
      scanner: {
        async scanPool(pool) {
          if (options.failingPools?.has(pool)) throw new PoolCatchUpWindowExceededError(pool, 20, 20_000);
          return sweep(pool);
        },
      },
      subscriber: {
        async sync(pools) { synced.push(pools); pools.forEach((pool) => healthy.add(pool)); },
        isHealthy: (pool) => healthy.has(pool),
        async close() {},
      },
    },
    {
      intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: options.maxPools ?? 50,
      scheduler: new ManualScheduler(), now: () => NOW,
      onSweep: (report) => { reports.push(report); },
    },
  );
  return { tracker, seeded, synced, healthy, reports };
}

void test('start seeds, subscribes and sweeps every tracked pool, then reports HEALTHY', async () => {
  const { tracker, seeded, synced, reports } = harness({ candidates: () => [candidate('a'), candidate('b')] });
  await tracker.start();
  assert.deepEqual(seeded, ['a', 'b']);
  assert.deepEqual(synced, [['a', 'b']]);
  assert.deepEqual(reports.map((report) => [report.poolAddress, report.outcome]), [['a', 'SUCCEEDED'], ['b', 'SUCCEEDED']]);
  assert.equal(tracker.coverageState(), 'HEALTHY');
  await tracker.close();
});

void test('a failing pool is DEGRADED alone and only blocks its own mint', async () => {
  const { tracker, reports } = harness({
    candidates: () => [candidate('a'), candidate('b')],
    failingPools: new Set(['b']),
  });
  await tracker.start();
  assert.equal(tracker.coverageState(), 'DEGRADED');
  assert.equal(tracker.isMintCovered('mint-a'), true);
  assert.equal(tracker.isMintCovered('mint-b'), false);
  assert.equal(reports.find((report) => report.poolAddress === 'b')?.errorCode, 'CATCH_UP_WINDOW_EXCEEDED');
  await tracker.close();
});

void test('a mint without a tracked pool has no market requirement, a capped one is not covered', async () => {
  const { tracker } = harness({ candidates: () => [candidate('a', 1), candidate('b', 2)], maxPools: 1 });
  await tracker.start();
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), true);
  assert.equal(tracker.isMintCovered('mint-b'), false);
  await tracker.close();
});

void test('no tracked pool is HEALTHY', async () => {
  const { tracker } = harness({ candidates: () => [] });
  await tracker.start();
  assert.equal(tracker.coverageState(), 'HEALTHY');
  await tracker.close();
});

void test('a refresh failure degrades coverage without throwing from start', async () => {
  const tracker = new MarketPoolTracker(
    {
      repository: {
        async listCandidates() { throw new Error('db down'); },
        async seedFromActivation() {},
      },
      scanner: { async scanPool(pool) { return sweep(pool); } },
      subscriber: { async sync() {}, isHealthy: () => true, async close() {} },
    },
    { intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: 50, scheduler: new ManualScheduler(), now: () => NOW },
  );
  await tracker.start();
  assert.equal(tracker.coverageState(), 'DEGRADED');
  await tracker.close();
});

void test('a pool that leaves tracking is unsubscribed and forgotten', async () => {
  let pools = [candidate('a'), candidate('b')];
  const scheduler = new ManualScheduler();
  const synced: (readonly string[])[] = [];
  const tracker = new MarketPoolTracker(
    {
      repository: { async listCandidates() { return pools; }, async seedFromActivation() {} },
      scanner: { async scanPool(pool) { return sweep(pool); } },
      subscriber: { async sync(value) { synced.push(value); }, isHealthy: () => true, async close() {} },
    },
    { intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: 50, scheduler, now: () => NOW },
  );
  await tracker.start();
  pools = [candidate('a')];
  await tracker.runCycleForTest();
  assert.deepEqual(synced.at(-1), ['a']);
  assert.equal(tracker.isMintCovered('mint-b'), true, 'b is no longer tracked, so no market requirement');
  await tracker.close();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test tests/market-pool-tracker.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement**

```ts
import { selectTrackedPools, type TrackedPoolCandidate } from './market-pool-selection.js';
import type { PoolSweepResult } from './pool-catch-up-scanner.js';

export type MarketCoverageState = 'WARMING_UP' | 'HEALTHY' | 'DEGRADED';

export interface MarketPoolTrackerDependencies {
  readonly repository: {
    listCandidates(windowStartMs: number): Promise<readonly TrackedPoolCandidate[]>;
    seedFromActivation(candidate: TrackedPoolCandidate, nowMs: number): Promise<void>;
  };
  readonly scanner: { scanPool(poolAddress: string): Promise<PoolSweepResult> };
  readonly subscriber: {
    sync(pools: readonly string[]): Promise<void>;
    isHealthy(pool: string): boolean;
    close(): Promise<void>;
  };
}

export interface MarketPoolTrackerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface MarketPoolTrackerOptions {
  readonly intervalMs: number;
  readonly windowMs: number;
  readonly maxPools: number;
  readonly scheduler?: MarketPoolTrackerScheduler;
  readonly now?: () => number;
  readonly onSweep?: (report: PoolSweepReport) => void;
  readonly onCycle?: (report: MarketPoolCycleReport) => void;
}

export interface PoolSweepReport {
  readonly poolAddress: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly durationMs: number;
  readonly result: PoolSweepResult | null;
  readonly errorCode: string | null;
}

export interface MarketPoolCycleReport {
  readonly coverageState: MarketCoverageState;
  readonly trackedPools: readonly string[];
  readonly droppedByCap: readonly string[];
  readonly refreshFailed: boolean;
}

interface PoolStatus {
  lastOutcome: 'SUCCEEDED' | 'FAILED' | null;
  sweepsSucceeded: number;
  sweepsFailed: number;
}

const defaultScheduler: MarketPoolTrackerScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export class MarketPoolTracker {
  private readonly scheduler: MarketPoolTrackerScheduler;
  private readonly now: () => number;
  private tracked = new Map<string, TrackedPoolCandidate>();
  private mintToPool = new Map<string, string>();
  private droppedMints = new Set<string>();
  private readonly status = new Map<string, PoolStatus>();
  private refreshFailed = false;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;

  public constructor(
    private readonly dependencies: MarketPoolTrackerDependencies,
    private readonly options: MarketPoolTrackerOptions,
  ) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000) {
      throw new TypeError('Market pool tracker interval is invalid.');
    }
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? Date.now;
  }

  public async start(): Promise<void> {
    await this.runCycleForTest();
    this.schedule();
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) this.scheduler.cancel(this.timer);
    this.timer = null;
    if (this.inFlight !== null) await this.inFlight;
    await this.dependencies.subscriber.close();
  }

  public coverageState(): MarketCoverageState {
    if (this.refreshFailed) return 'DEGRADED';
    let warming = false;
    for (const pool of this.tracked.keys()) {
      const status = this.status.get(pool);
      if (status === undefined || status.lastOutcome === null) {
        warming = true;
      } else if (status.lastOutcome === 'FAILED' || !this.dependencies.subscriber.isHealthy(pool)) {
        return 'DEGRADED';
      }
    }
    return warming ? 'WARMING_UP' : 'HEALTHY';
  }

  // A mint in its bonding-curve phase has no pool, hence no market requirement. A mint whose pool
  // was dropped by the cap is explicitly not covered.
  public isMintCovered(mint: string): boolean {
    if (this.droppedMints.has(mint)) return false;
    const pool = this.mintToPool.get(mint);
    if (pool === undefined) return true;
    return this.status.get(pool)?.lastOutcome === 'SUCCEEDED' && this.dependencies.subscriber.isHealthy(pool);
  }

  /** Runs one refresh-and-sweep cycle; public for deterministic tests, also used by start(). */
  public runCycleForTest(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const operation = this.runCycle().finally(() => { this.inFlight = null; });
    this.inFlight = operation;
    return operation;
  }

  private async runCycle(): Promise<void> {
    if (this.closed) return;
    const nowMs = this.now();
    let droppedByCap: readonly TrackedPoolCandidate[] = [];
    try {
      const candidates = await this.dependencies.repository.listCandidates(nowMs - this.options.windowMs);
      const selection = selectTrackedPools(candidates, {
        nowMs, windowMs: this.options.windowMs, maxPools: this.options.maxPools,
      });
      for (const pool of selection.tracked) await this.dependencies.repository.seedFromActivation(pool, nowMs);
      this.tracked = new Map(selection.tracked.map((pool) => [pool.poolAddress, pool]));
      this.mintToPool = new Map(selection.tracked.map((pool) => [pool.baseMint, pool.poolAddress]));
      this.droppedMints = new Set(selection.droppedByCap.map((pool) => pool.baseMint));
      droppedByCap = selection.droppedByCap;
      for (const pool of [...this.status.keys()]) if (!this.tracked.has(pool)) this.status.delete(pool);
      await this.dependencies.subscriber.sync([...this.tracked.keys()]);
      this.refreshFailed = false;
    } catch {
      this.refreshFailed = true;
      this.publishCycle(droppedByCap);
      return;
    }
    for (const pool of this.tracked.keys()) {
      if (this.closed) return;
      await this.sweepPool(pool);
    }
    this.publishCycle(droppedByCap);
  }

  private async sweepPool(pool: string): Promise<void> {
    const status = this.status.get(pool) ?? { lastOutcome: null, sweepsSucceeded: 0, sweepsFailed: 0 };
    this.status.set(pool, status);
    const startedAtMs = this.now();
    let result: PoolSweepResult | null = null;
    let errorCode: string | null = null;
    try {
      result = await this.dependencies.scanner.scanPool(pool);
      status.lastOutcome = 'SUCCEEDED';
      status.sweepsSucceeded += 1;
    } catch (error) {
      status.lastOutcome = 'FAILED';
      status.sweepsFailed += 1;
      errorCode = readErrorCode(error);
    }
    const completedAtMs = this.now();
    try {
      this.options.onSweep?.(Object.freeze({
        poolAddress: pool,
        outcome: status.lastOutcome,
        startedAtMs,
        completedAtMs,
        durationMs: completedAtMs - startedAtMs,
        result,
        errorCode,
      }));
    } catch {
      // Telemetry must never affect coverage.
    }
  }

  private publishCycle(droppedByCap: readonly TrackedPoolCandidate[]): void {
    try {
      this.options.onCycle?.(Object.freeze({
        coverageState: this.coverageState(),
        trackedPools: Object.freeze([...this.tracked.keys()]),
        droppedByCap: Object.freeze(droppedByCap.map((pool) => pool.poolAddress)),
        refreshFailed: this.refreshFailed,
      }));
    } catch {
      // Telemetry must never affect coverage.
    }
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = this.scheduler.schedule(() => {
      this.timer = null;
      void this.runCycleForTest().finally(() => { this.schedule(); });
    }, this.options.intervalMs);
  }
}

function readErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_.-]{1,63}$/u.test(code)) return code;
    const stage = (error as { readonly stage?: unknown }).stage;
    if (typeof stage === 'string' && /^[a-z-]{1,32}$/u.test(stage)) return `POOL_CATCH_UP_${stage.toUpperCase()}`;
  }
  return 'POOL_CATCH_UP_FAILED';
}
```

Note: `CatchUpSourceError` has `stage` (`request`/`response`/`pagination`) and no `code`, so a 429 surfaces as `POOL_CATCH_UP_REQUEST`, mirroring the launchpad's `CATCH_UP_RPC_REQUEST`.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx tsx --test tests/market-pool-tracker.test.ts`
Expected: `ℹ pass 6`.

---

### Task 7: Restrict the program-wide scanners to enabled programs

**Files:**
- Modify: `src/application/catch-up-scanner.ts`
- Modify: `src/application/production-listener-factory.ts` (`StartupScanner`, lines ~400-1010)
- Test: `tests/catch-up-scanner.test.ts`, `tests/rolling-catch-up.test.ts` (one new case each)

- [ ] **Step 1: Write the failing tests**

In `tests/catch-up-scanner.test.ts`, add a case building `new CatchUpScanner(source, repository, { pageSize, maxPages, programs: ['launchpad'] })` (reuse that file's fake source/repository helpers), calling `scan({ launchpad: frontier })`, and asserting that the source was only asked for `PUMP_PROGRAM_ID` and that `result.programs.market` is `undefined`.

In `tests/rolling-catch-up.test.ts`, add a case building a `StartupScanner` with `{ programs: ['launchpad'], intervalsMs: { launchpad: 15_000 } }` (reuse that file's helpers), asserting that `scan()` resolves, that `readFinalizedFrontier` was only called with `'launchpad'`, that `result.programs.market` is `undefined`, and that `isCoverageHealthy()` becomes `true` after the first launchpad sweep succeeds.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx tsx --test tests/catch-up-scanner.test.ts tests/rolling-catch-up.test.ts`
Expected: the new cases fail (unknown option is ignored, market is still scanned).

- [ ] **Step 3: Modify `catch-up-scanner.ts`**

1. Make frontiers partial: `export type ProgramFinalizedFrontiers = Readonly<Partial<Record<ProgramKey, FinalizedProgramFrontier>>>;`
2. Add `readonly programs?: readonly CatchUpProgram[];` to `CatchUpScannerOptions`.
3. Add `private readonly programs: readonly ProgramDefinition[];` to `CatchUpScanner`, set in the constructor after the bounds check:

```ts
    const enabled = optionValue(options, 'programs') ?? ['launchpad', 'market'];
    if (enabled.length === 0 || new Set(enabled).size !== enabled.length
      || enabled.some((key) => key !== 'launchpad' && key !== 'market')) {
      throw new TypeError('Catch-up scanner program list is invalid.');
    }
    this.programs = Object.freeze(PROGRAMS.filter((program) => enabled.includes(program.key)));
```

   Check that `optionValue` accepts the new key; it reads an own property of `options` and is typed on `CatchUpScannerOptions`, so adding the field is enough. If it is constrained to specific keys, extend its key union.
4. In `scan()`, replace `for (const program of PROGRAMS)` with `for (const program of this.programs)`, and replace `validFrontiers(frontiers)` with `this.validEnabledFrontiers(frontiers)`:

```ts
  private validEnabledFrontiers(value: ProgramFinalizedFrontiers): boolean {
    return this.programs.every(({ key }) => validFrontier(key, value[key]));
  }
```

   Leave the module-level `validFrontiers` function in place only if something else uses it; otherwise delete it (`grep -n "validFrontiers" src`).
5. `CatchUpScanResult.programs` becomes `Readonly<Partial<Record<ProgramKey, CatchUpProgramScanResult>>>`. The `persistScans` body already builds it from `scans` only; adjust the cast at its end to the new type.
6. In `scanProgram`, refuse a program that is not enabled: `if (!this.programs.some((program) => program.key === programKey)) throw new CatchUpScannerError('frontier-validation', programKey);`

- [ ] **Step 4: Modify `StartupScanner` in `production-listener-factory.ts`**

1. Add to `StartupScannerOptions`: `readonly programs?: readonly RollingProgram[];` and make `intervalsMs` partial: `readonly intervalsMs?: Readonly<Partial<Record<RollingProgram, number>>>;`
2. Add a field `private readonly programs: readonly RollingProgram[];` set in the constructor (before the interval checks): `this.programs = Object.freeze([...(options.programs ?? ROLLING_PROGRAMS)]);` with the same validation as Task 7 step 3.3. Change the per-program interval check to iterate `this.programs` instead of `ROLLING_PROGRAMS`.
3. Replace **every** remaining use of `ROLLING_PROGRAMS` inside the class (`performBootstrap`, `scanWithOptionalCutover`, `refreshCoverageState`, `refreshCheckpointSlots`) with `this.programs`. Check with `grep -n "ROLLING_PROGRAMS" src/application/production-listener-factory.ts`: afterwards it should only appear in its declaration and in the constructor default.
4. In `performBootstrap`, build the durable frontiers and the result from `this.programs`:

```ts
      const durableFrontiers = new Map(this.programs.map((program) => [
        program, requireDurableFrontier(result, program),
      ] as const));
      for (const program of this.programs) {
        const frontier = durableFrontiers.get(program);
        if (frontier === undefined) continue;
        const status = this.programStatus[program];
        status.checkpointSlot = frontier.slot;
        status.checkpointSignature = frontier.signature;
        status.lastDurableFrontierSlot = frontier.slot;
        status.bootstrapMode = result.bootstrapModes[program] ?? null;
      }
```

   and return:

```ts
      return Object.freeze({
        programs: Object.freeze(Object.fromEntries(this.programs.map((program) => [program, Object.freeze({
          program,
          bootstrapMode: result.bootstrapModes[program] ?? 'STRICT_CATCH_UP',
          durableFrontier: durableFrontiers.get(program) as Readonly<{ signature: string; slot: string }>,
        })])) as ListenerBootstrapResult['programs']),
      });
```

5. Change `ListenerBootstrapResult` to
   `readonly programs: Readonly<{ launchpad: ListenerBootstrapProgramResult; market?: ListenerBootstrapProgramResult }>;`
   and `requireDurableFrontier`'s parameter type to accept a partial `programs` record (`result.programs[program]?.durableFrontier ?? null`).
6. In `scanWithOptionalCutover`, `bootstrapModes` is built from `this.programs`; type it `Readonly<Partial<Record<RollingProgram, ListenerBootstrapMode>>>`.
7. Fix the type errors in existing tests that read `result.programs.market.<field>` by using `result.programs.market?.<field>` (around 18 occurrences, `grep -rn "programs\.market" tests`). Runtime behaviour of those tests is unchanged: they use the default (both programs).

- [ ] **Step 5: Run the scanner tests, the typecheck and the full suite**

Run: `npx tsx --test tests/catch-up-scanner.test.ts tests/rolling-catch-up.test.ts tests/listener-bootstrap-cutover.test.ts tests/listener-bootstrap.test.ts && npm run check:backend`
Expected: all pass, typecheck exit 0.

---

### Task 8: Composite coverage and per-mint live guard

**Files:**
- Create: `src/application/listener-coverage.ts`
- Modify: `src/application/production-listener-factory.ts` (`guardLiveDecisionConsumer`)
- Test: `tests/listener-coverage.test.ts`, `tests/live-decision-coverage-guard.test.ts` (one new case)

- [ ] **Step 1: Write the failing tests**

`tests/listener-coverage.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { ListenerCoverage } from '../src/application/listener-coverage.js';
import type { MarketCoverageState } from '../src/application/market-pool-tracker.js';
import type { ListenerRuntimeState } from '../src/application/listener-runtime.js';

function parts(launchpadState: ListenerRuntimeState, launchpadHealthy: boolean, market: MarketCoverageState, covered = true) {
  const calls: string[] = [];
  const coverage = new ListenerCoverage(
    {
      async scan() { calls.push('launchpad.scan'); return 'bootstrap'; },
      async close() { calls.push('launchpad.close'); },
      state: () => launchpadState,
      isCoverageHealthy: () => launchpadHealthy,
    },
    {
      async start() { calls.push('market.start'); },
      async close() { calls.push('market.close'); },
      coverageState: () => market,
      isMintCovered: () => covered,
    },
  );
  return { coverage, calls };
}

void test('scan bootstraps the launchpad before starting the market tracker', async () => {
  const { coverage, calls } = parts('RUNNING', true, 'HEALTHY');
  assert.equal(await coverage.scan(), 'bootstrap');
  assert.deepEqual(calls, ['launchpad.scan', 'market.start']);
});

void test('close stops the market tracker before the launchpad', async () => {
  const { coverage, calls } = parts('RUNNING', true, 'HEALTHY');
  await coverage.close();
  assert.deepEqual(calls, ['market.close', 'launchpad.close']);
});

void test('state combines launchpad and market coverage', () => {
  assert.equal(parts('RUNNING', true, 'HEALTHY').coverage.state(), 'RUNNING');
  assert.equal(parts('RUNNING', true, 'DEGRADED').coverage.state(), 'DEGRADED');
  assert.equal(parts('RUNNING', true, 'WARMING_UP').coverage.state(), 'STARTING');
  assert.equal(parts('DEGRADED', false, 'HEALTHY').coverage.state(), 'DEGRADED');
});

void test('a mint is covered only when the launchpad is healthy and its pool is covered', () => {
  assert.equal(parts('RUNNING', true, 'DEGRADED', true).coverage.isMintCovered('m'), true);
  assert.equal(parts('RUNNING', true, 'HEALTHY', false).coverage.isMintCovered('m'), false);
  assert.equal(parts('DEGRADED', false, 'HEALTHY', true).coverage.isMintCovered('m'), false);
});
```

In `tests/live-decision-coverage-guard.test.ts`, add a case where `guardLiveDecisionConsumer(consumer, (_result, snapshot) => snapshot.mint === 'ok', onBlocked)` forwards a call whose second argument has `mint: 'ok'` and blocks one with `mint: 'ko'`. Read the file first and reuse its fixtures.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx tsx --test tests/listener-coverage.test.ts tests/live-decision-coverage-guard.test.ts`
Expected: `listener-coverage` fails with `ERR_MODULE_NOT_FOUND`; the new guard case fails on types or because the callback receives no arguments.

- [ ] **Step 3: Implement `listener-coverage.ts`**

```ts
import type { ListenerRuntimeState } from './listener-runtime.js';
import type { MarketCoverageState } from './market-pool-tracker.js';

export interface LaunchpadCoverage<TBootstrap> {
  scan(): Promise<TBootstrap>;
  close(): Promise<void>;
  state(): ListenerRuntimeState;
  isCoverageHealthy(): boolean;
}

export interface MarketCoverage {
  start(): Promise<void>;
  close(): Promise<void>;
  coverageState(): MarketCoverageState;
  isMintCovered(mint: string): boolean;
}

// The runtime sees a single scanner: launchpad bootstrap first (its cutover rules are unchanged),
// then the per-pool market tracker.
export class ListenerCoverage<TBootstrap> {
  public constructor(
    private readonly launchpad: LaunchpadCoverage<TBootstrap>,
    private readonly market: MarketCoverage,
  ) {}

  public async scan(): Promise<TBootstrap> {
    const result = await this.launchpad.scan();
    await this.market.start();
    return result;
  }

  public async close(): Promise<void> {
    try {
      await this.market.close();
    } finally {
      await this.launchpad.close();
    }
  }

  public state(): ListenerRuntimeState {
    const launchpad = this.launchpad.state();
    if (launchpad !== 'RUNNING') return launchpad;
    const market = this.market.coverageState();
    if (market === 'HEALTHY') return 'RUNNING';
    return market === 'DEGRADED' ? 'DEGRADED' : 'STARTING';
  }

  public isMintCovered(mint: string): boolean {
    return this.launchpad.isCoverageHealthy() && this.market.isMintCovered(mint);
  }
}
```

If `ListenerRuntimeState` is not exported from `listener-runtime.ts`, import it from where `production-listener-factory.ts` imports it (`grep -n "ListenerRuntimeState" src/application/production-listener-factory.ts | head -3`).

- [ ] **Step 4: Make the guard per-call**

In `production-listener-factory.ts`, change `guardLiveDecisionConsumer`'s second parameter from `isCoverageHealthy: () => boolean` to `isCoverageHealthy: (...args: TArgs) => boolean` and call it as `isCoverageHealthy(...args)`. Existing zero-argument callers still type-check.

- [ ] **Step 5: Run them and confirm they pass**

Run: `npx tsx --test tests/listener-coverage.test.ts tests/live-decision-coverage-guard.test.ts`
Expected: all pass.

---

### Task 9: Configuration

**Files:**
- Modify: `src/config/env.ts`, `.env.example`
- Test: `tests/config-safety.test.ts` (one new case)

- [ ] **Step 1: Write the failing test**

Add to `tests/config-safety.test.ts`, following how that file builds a config from an environment object (read it first):
- defaults: `marketTrackingWindowHours === 6`, `marketTrackedPoolsMax === 50`;
- `MARKET_TRACKING_WINDOW_HOURS=0` and `=169` are rejected; `MARKET_TRACKED_POOLS_MAX=0` and `=201` are rejected;
- `MARKET_TRACKING_WINDOW_HOURS=12`, `MARKET_TRACKED_POOLS_MAX=20` are read as numbers.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test tests/config-safety.test.ts`
Expected: the new case fails (`undefined !== 6`).

- [ ] **Step 3: Implement**

In `AppConfig` (next to `listenerRollingCatchUpMarketIntervalMs`, `src/config/env.ts:49`):

```ts
  readonly marketTrackingWindowHours: number;
  readonly marketTrackedPoolsMax: number;
```

In the config builder (next to `listenerRollingCatchUpMarketIntervalMs`, around line 234):

```ts
    marketTrackingWindowHours: parseCanonicalBoundedInteger(
      environment.MARKET_TRACKING_WINDOW_HOURS, 6, 'MARKET_TRACKING_WINDOW_HOURS', 1, 168,
    ),
    marketTrackedPoolsMax: parseCanonicalBoundedInteger(
      environment.MARKET_TRACKED_POOLS_MAX, 50, 'MARKET_TRACKED_POOLS_MAX', 1, 200,
    ),
```

In `.env.example`, after `LISTENER_ROLLING_CATCH_UP_MARKET_INTERVAL_MS`:

```
# Market ingestion follows only tracked PumpSwap pools: activated less than this many hours ago,
# or whose mint has an active paper session / open live position.
MARKET_TRACKING_WINDOW_HOURS=6
# Safety cap; engaged pools are always kept, the oldest window-only pools are dropped first.
MARKET_TRACKED_POOLS_MAX=50
```

Then fix every `AppConfig` object literal that no longer type-checks (`npm run check:backend` lists them) by adding `marketTrackingWindowHours: 6, marketTrackedPoolsMax: 50`.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx tsx --test tests/config-safety.test.ts && npm run check:backend`
Expected: pass, typecheck exit 0.

---

### Task 10: Production wiring

**Files:**
- Modify: `src/application/production-listener-factory.ts` (`createProductionListenerRuntime`, lines ~107-410)
- Test: `tests/production-listener-factory.test.ts` (one new case)

- [ ] **Step 1: Write the failing test**

Add a source-level guard to `tests/production-listener-factory.test.ts`, in the same style as its existing `readFile` checks:

```ts
void test('production market ingestion is per pool, not program-wide', async () => {
  const source = await readFile(new URL('../src/application/production-listener-factory.ts', import.meta.url), 'utf8');
  assert.match(source, /programIds:\s*\[PUMP_PROGRAM_ID\]/u, 'WebSocket subscriber is launchpad-only');
  assert.match(source, /programs:\s*\['launchpad'\]/u, 'program-wide catch-up is launchpad-only');
  assert.match(source, /new MarketPoolTracker\(/u);
  assert.match(source, /isMintCovered\(snapshot\.mint\)/u, 'live guard is per mint');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test --test-name-pattern="per pool, not program-wide" tests/production-listener-factory.test.ts`
Expected: FAIL on the first `assert.match`.

- [ ] **Step 3: Wire it**

In `createProductionListenerRuntime`:

1. Catch-up scanner, launchpad only:

```ts
  const catchUp = new CatchUpScanner(
    new SolanaCatchUpSource(catchUpRpc(rpc), config.commitment),
    inbox,
    {
      pageSize: config.listenerCatchUpPageSize,
      maxPages: config.listenerCatchUpMaxPages,
      programs: ['launchpad'],
    },
  );
```

2. WebSocket subscriber, launchpad only:

```ts
  const subscriber = new SolanaProgramSubscriber(
    new Web3ProgramLogsConnection(rpc.http),
    inbox,
    { programIds: [PUMP_PROGRAM_ID] },
  );
```

3. `StartupScanner` options: add `programs: ['launchpad'],` and reduce `intervalsMs` to `{ launchpad: config.listenerRollingCatchUpLaunchpadIntervalMs }`. The `readFinalizedFrontier` callback may stay as is (it is now only called with `'launchpad'`).

4. After the `StartupScanner` construction, build the market tracker:

```ts
  const poolTracking = new PostgresMarketPoolTrackingRepository(pool);
  const marketTracker = new MarketPoolTracker(
    {
      repository: poolTracking,
      scanner: new PoolCatchUpScanner(
        new PoolSignatureSource(rpc.http),
        inbox,
        poolTracking,
        { pageSize: config.listenerCatchUpPageSize, maxPages: config.listenerCatchUpMaxPages },
      ),
      subscriber: new PoolLogsSubscriber(new Web3ProgramLogsConnection(rpc.http), inbox),
    },
    {
      intervalMs: config.listenerRollingCatchUpMarketIntervalMs,
      windowMs: config.marketTrackingWindowHours * 3_600_000,
      maxPools: config.marketTrackedPoolsMax,
      onSweep: (report): void => {
        logger.info({ event: 'listener.market_pool_sweep', ...report }, 'Sweep pool market terminé.');
      },
      onCycle: (report): void => {
        if (report.droppedByCap.length > 0) {
          logger.warn({ event: 'listener.market_pool_cap_reached', ...report }, 'Plafond de pools market atteint.');
        } else {
          logger.info({ event: 'listener.market_pool_cycle', ...report }, 'Cycle pools market terminé.');
        }
      },
    },
  );
  const coverage = new ListenerCoverage(scanner, marketTracker);
```

   `rpc.http` (not `catchUpHttp`) is deliberate: its `RpcMethodTelemetry` counts the pool requests under `getSignaturesForAddress`, while `catchUpHttp`'s telemetry only recognises program IDs. Check that `PoolSignatureSource`'s `PoolSignaturesRpc` is satisfied by `Connection`; if TypeScript rejects the `commitment` literal or the options shape, wrap it: `{ getSignaturesForAddress: (address, options, commitment) => rpc.http.getSignaturesForAddress(address, options, commitment) }`.

5. Live guard, per mint:

```ts
  const guardedLiveDecisionConsumer = guardLiveDecisionConsumer(
    liveDecisionConsumer,
    (_result, snapshot) => coverage.isMintCovered(snapshot.mint) && subscriber.state === 'RUNNING',
    (): void => {
      logger.warn({
        event: 'listener.live_candidate_blocked_by_coverage',
        scannerState: coverage.state(),
        marketCoverageState: marketTracker.coverageState(),
        subscriberState: subscriber.state,
      }, 'Nouveau signal BUY live ignoré pendant une couverture dégradée.');
    },
  );
```

6. Heartbeat: replace `() => scanner.state()` with `() => coverage.state()`.
7. Runtime: pass `scanner: coverage` instead of `scanner` to `new SolanaListenerRuntime({...})`.
8. Add the imports: `PostgresMarketPoolTrackingRepository`, `MarketPoolTracker`, `PoolCatchUpScanner`, `PoolSignatureSource`, `PoolLogsSubscriber`, `ListenerCoverage`.

- [ ] **Step 4: Run it, then the full suite**

Run: `npx tsx --test tests/production-listener-factory.test.ts && npm run check:backend && npm run test:backend`
Expected: all pass; record the pass/fail/skip counts. Any newly failing pre-existing test must be understood and fixed, not skipped.

---

### Task 11: Operator re-seed CLI

**Files:**
- Create: `src/cli/market-pool-checkpoint-operator.ts`
- Modify: `package.json` (script)
- Test: `tests/market-pool-checkpoint-operator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarketPoolOperatorCommand } from '../src/cli/market-pool-checkpoint-operator.js';

const POOL = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

void test('parses an inspect command', () => {
  assert.deepEqual(parseMarketPoolOperatorCommand(['inspect', '--pool', POOL]),
    { action: 'inspect', pool: POOL, confirmed: false });
});

void test('a re-seed needs the explicit confirmation flag to be confirmed', () => {
  assert.deepEqual(parseMarketPoolOperatorCommand(['reseed-at-finalized-frontier', '--pool', POOL]),
    { action: 'reseed', pool: POOL, confirmed: false });
  assert.deepEqual(parseMarketPoolOperatorCommand([
    'reseed-at-finalized-frontier', '--pool', POOL, '--confirm-pool-history-gap',
  ]), { action: 'reseed', pool: POOL, confirmed: true });
});

void test('rejects unknown commands, missing or invalid pools', () => {
  assert.throws(() => parseMarketPoolOperatorCommand(['rebase', '--pool', POOL]), TypeError);
  assert.throws(() => parseMarketPoolOperatorCommand(['inspect']), TypeError);
  assert.throws(() => parseMarketPoolOperatorCommand(['inspect', '--pool', 'nope']), TypeError);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx --test tests/market-pool-checkpoint-operator.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement**

```ts
import { Connection, PublicKey } from '@solana/web3.js';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { PostgresMarketPoolTrackingRepository } from '../storage/market-pool-tracking.repository.js';

type MarketPoolOperatorCommand =
  | { readonly action: 'inspect'; readonly pool: string; readonly confirmed: false }
  | { readonly action: 'reseed'; readonly pool: string; readonly confirmed: boolean };

export function parseMarketPoolOperatorCommand(args: readonly string[]): MarketPoolOperatorCommand {
  const [command, ...rest] = args;
  if (command !== 'inspect' && command !== 'reseed-at-finalized-frontier') {
    throw new TypeError('Expected inspect or reseed-at-finalized-frontier.');
  }
  let pool: string | undefined;
  let confirmed = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--pool' && pool === undefined) {
      pool = rest[++index];
    } else if (argument === '--confirm-pool-history-gap' && command !== 'inspect' && !confirmed) {
      confirmed = true;
    } else {
      throw new TypeError('Unsupported or duplicate market pool operator argument.');
    }
  }
  if (pool === undefined) throw new TypeError('--pool is required.');
  try {
    new PublicKey(pool);
  } catch {
    throw new TypeError('--pool must be a valid public key.');
  }
  return command === 'inspect'
    ? Object.freeze({ action: 'inspect', pool, confirmed: false })
    : Object.freeze({ action: 'reseed', pool, confirmed });
}

async function main(args: readonly string[]): Promise<void> {
  const command = parseMarketPoolOperatorCommand(args);
  const databaseUrl = process.env.DATABASE_URL;
  const rpcUrl = process.env.SOLANA_HTTP_RPC_URL;
  if (databaseUrl === undefined || rpcUrl === undefined) {
    throw new Error('DATABASE_URL and SOLANA_HTTP_RPC_URL are required.');
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresMarketPoolTrackingRepository(pool);
    const checkpoint = await repository.readCheckpoint(command.pool);
    const connection = new Connection(rpcUrl, 'finalized');
    const [newest] = await connection.getSignaturesForAddress(new PublicKey(command.pool), { limit: 1 }, 'finalized');
    const frontier = newest === undefined ? null : { slot: BigInt(newest.slot), signature: newest.signature };
    const report = {
      pool: command.pool,
      checkpointSlot: checkpoint?.slot.toString() ?? null,
      finalizedFrontierSlot: frontier?.slot.toString() ?? null,
    };
    if (command.action === 'inspect' || !command.confirmed) {
      console.log(JSON.stringify({ ...report, applied: false }));
      return;
    }
    if (checkpoint === null || frontier === null) {
      throw new Error('Re-seed requires an existing checkpoint and a finalized frontier.');
    }
    await repository.reseedAtFrontier(command.pool, frontier, Date.now());
    console.log(JSON.stringify({ ...report, applied: true, reason: 'operator-approved-pool-frontier-seed' }));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Market pool operator failed.');
    process.exitCode = 1;
  });
}
```

The CLI never prints the RPC URL or database URL. In `package.json`, next to `listener:checkpoint:operator`:

```json
    "market:pool-checkpoint:operator": "node --env-file=live.env --import tsx src/cli/market-pool-checkpoint-operator.ts",
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx tsx --test tests/market-pool-checkpoint-operator.test.ts`
Expected: `ℹ pass 3`.

---

### Task 12: Final verification

- [ ] **Step 1: Full checks**

Run:

```bash
npm run check:backend
npx eslint src/application/market-pool-selection.ts src/storage/market-pool-tracking.repository.ts \
  src/solana/rpc/pool-signature-source.ts src/application/pool-catch-up-scanner.ts \
  src/solana/rpc/pool-logs-subscriber.ts src/application/market-pool-tracker.ts \
  src/application/listener-coverage.ts src/cli/market-pool-checkpoint-operator.ts \
  src/solana/rpc/program-subscriber.ts src/application/catch-up-scanner.ts \
  src/application/production-listener-factory.ts src/config/env.ts tests/market-pool-*.test.ts \
  tests/pool-*.test.ts tests/listener-coverage.test.ts
git diff --check
npm run test:backend
```

Expected: typecheck exit 0, no lint error, no whitespace error, test suite `fail 0`. Report the exact pass/skip counts and say which Postgres tests were skipped for lack of `LIVE_TEST_DATABASE_URL`.

- [ ] **Step 2: Hand-off note for the operator**

Do not run the listener. Report that the next on-chain step is an observation that **requires explicit operator authorisation**, with the criteria from the spec's "Validation criteria" section, including:
- one launchpad cutover may be needed (checkpoints are stale);
- migration `023_market_pool_checkpoints.sql` must be applied to the target database first (also needs authorisation);
- at least one tracked pool must exist during observation.
