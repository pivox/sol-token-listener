# Chemin simple — lot 2 : ingestion `creates-only` et poller de bonding curves

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add a `creates-only` ingestion scope (Pump WebSocket, only `create` notifications enqueued, no strict catch-up scan) and a bonding-curve poller that feeds the trades of the tracked mints through a new `PUMPFUN_CURVE_TRADE` inbox hint (migration 063).

**Architecture:** reuse the existing machinery. `creates-only` maps to the launchpad-only programs; the WebSocket session tags every non-create Pump notification `filteredReason: 'NOT_A_CREATE'`, which goes through the supervisor's existing `filtered` branch, so WebSocket health and slot progress stay intact. In the factory, `runStrictScan` and `prepareInitialFrontier` become no-ops in this scope. The `TrackedPoolPoller` gets two options, `ingestionHint` and `programId`, and runs a second time over a `PostgresTrackedCurveRepository`. That repository lists the bonding curves of tracked mints that have not migrated; each curve address is derived with `bondingCurvePda(mint)`. `PUMPFUN_CURVE_TRADE` mirrors `PUMPSWAP_POOL_TRADE` everywhere.

**Tech Stack:** TypeScript (tsx, node:test), PostgreSQL 16 (pg), @solana/web3.js 1.99.

Spec: `docs/superpowers/specs/2026-10-06-simple-path-design.md` (sections « Ingestion `creates-only` », « Pollers des mints suivis »).

**Deviation from the spec (simpler):** the curve address is derived from the mint (`bondingCurvePda`) rather than read from the event payload. The checkpoint table keys on `bonding_curve` and carries `mint REFERENCES token_launches(mint) ON DELETE CASCADE`, so token retention purges it.

**Environment:**
- Worktree `.worktrees/reconcile`, new branch `feat/creates-only` from up-to-date `main`.
- Disposable Postgres on `127.0.0.1:55432`:
  `TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/sol_token_listener_test`.
- Never use the native 5432.
- Never run a listener, an RPC or a real buy.

Single test: `TEST_DATABASE_URL=... npx tsx --test tests/<file>.test.ts`.
Full suite: `rm -rf dist && npm run build:backend && TEST_DATABASE_URL=... npm run test:backend`. Under load, the timeouts in `qualification-projection.repository.test.ts` are a known flaky case; rerun that file alone.

---

## File map

| File | Change |
|---|---|
| `src/config/env.ts` | `ListenerIngestionScope` gets `'creates-only'` |
| `src/application/listener-ingestion-programs.ts` | `creates-only` → launchpad programs |
| `src/solana/rpc/ws-program-session.ts` | `createsOnly` option, `NOT_A_CREATE` filtered reason |
| `src/application/websocket-failover-supervisor.ts` | accept `NOT_A_CREATE` in the filtered branch |
| `src/application/production-listener-factory.ts` | no-op scans, `createsOnly` session option, curve poller |
| `migrations/063_listener_tracked_curve_checkpoints.sql` | checkpoint table + widened hint CHECK |
| `src/domain/transaction-ingestion.ts` | `PUMPFUN_CURVE_TRADE` hint |
| `src/storage/transaction-inbox.repository.ts` | mirror `PUMPSWAP_POOL_TRADE` |
| `src/application/tracked-pool-poller.ts` | `ingestionHint`/`programId` options, `seedCheckpoint(target, …)` |
| `src/storage/tracked-pool.repository.ts` | `seedCheckpoint(target, …)` signature |
| `src/storage/tracked-curve.repository.ts` | new |
| `src/execution-migrations/live-catalog.ts`, `scripts/deployment-smoke.mjs` | register 063 |
| tests | see each task |

---

### Task 1: `creates-only` scope in configuration

**Files:**
- Modify: `src/config/env.ts` (type at line 27, parse at lines 254-259)
- Modify: `src/application/listener-ingestion-programs.ts`
- Test: `tests/config-safety.test.ts` (or the test file that already covers `LISTENER_INGESTION_SCOPE`: `grep -ln LISTENER_INGESTION_SCOPE tests/*.ts`)

- [ ] **Step 1: Write the failing tests.** In the test file that covers `LISTENER_INGESTION_SCOPE`, add:

```ts
void test('LISTENER_INGESTION_SCOPE accepts creates-only', () => {
  const config = loadConfig({ ...validEnvironment(), LISTENER_INGESTION_SCOPE: 'creates-only' });
  assert.equal(config.listenerIngestionScope, 'creates-only');
});

void test('creates-only ingests the launchpad program only', () => {
  assert.deepEqual(listenerIngestionPrograms('creates-only'), LAUNCHPAD_ONLY_INGESTION_PROGRAMS);
});
```

Use the file's own config helper (`loadConfig` / `validEnvironment` above are its usual names; reuse whatever that file already imports).

- [ ] **Step 2: Run them and see them fail.** Run `npx tsx --test <file>`. Expected: FAIL (`LISTENER_INGESTION_SCOPE` invalid / scope invalid).

- [ ] **Step 3: Implement.** In `src/config/env.ts`:

```ts
export type ListenerIngestionScope = 'launchpad-only' | 'launchpad-and-market' | 'creates-only';
```

and in the parse call: `['launchpad-only', 'launchpad-and-market', 'creates-only'],`.

Leave the existing guards alone (worker count > 1, page admission, coverage fast path all require `launchpad-only`). They reject `creates-only`, which matches the spec: those flags stay `false`.

In `src/application/listener-ingestion-programs.ts`:

```ts
  if (scope === 'launchpad-only' || scope === 'creates-only') return LAUNCHPAD_ONLY_INGESTION_PROGRAMS;
```

- [ ] **Step 4: Run the tests and see them pass.** Run the file again. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/application/listener-ingestion-programs.ts tests/
git commit -m "feat(config): add the creates-only listener ingestion scope"
```

### Task 2: `NOT_A_CREATE` filtering in the WebSocket session and supervisor

**Files:**
- Modify: `src/solana/rpc/ws-program-session.ts` (notification type line 35, options, emission ~line 455-475)
- Modify: `src/application/websocket-failover-supervisor.ts` (~lines 977-1022)
- Test: `tests/ws-program-session.test.ts`, the supervisor test that covers `PASSIVE_PUMP_ACCOUNT_MENTION` (`grep -ln PASSIVE_PUMP_ACCOUNT_MENTION tests/*.ts`)

- [ ] **Step 1: Write the failing session test.** In `tests/ws-program-session.test.ts`, copy the existing test that emits a Pump notification and asserts the observed payload. Make two variants with `createsOnly: true` in the dependencies:
  - logs with a create (the same fixture the file uses for `PUMPFUN_CREATE`): the observed notification has `hint: 'PUMPFUN_CREATE'` and no `filteredReason`;
  - logs with a trade (the fixture for `PUMPFUN_TRADE`): the observed notification is exactly `{ endpointId, program: 'pumpfun', signature, slot, hint: 'NONE', hintMint: null, filteredReason: 'NOT_A_CREATE' }`.

- [ ] **Step 2: Run it and see it fail.** Run `npx tsx --test tests/ws-program-session.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement in the session.**

```ts
export type WsProgramFilteredReason = 'PASSIVE_PUMP_ACCOUNT_MENTION' | 'NOT_A_CREATE';
// in WsProgramNotification:
  readonly filteredReason?: WsProgramFilteredReason;
```

Add `readonly createsOnly?: boolean;` to `WsProgramSessionDependencies`. Read it next to `classificationMode` in `openWsProgramSession`, rejecting a non-boolean the same way `admissionOption` does:

```ts
    createsOnly = dependencies.createsOnly ?? false;
    if (typeof createsOnly !== 'boolean') throw new TypeError();
```

In the notification handler, after computing `hint`, `hintMint` and `passiveMention`:

```ts
      const notACreate = createsOnly && program === 'pumpfun' && hint !== 'PUMPFUN_CREATE';
      let filteredReason: WsProgramFilteredReason | null = null;
      if (notACreate) filteredReason = 'NOT_A_CREATE';
      else if (passiveMention) filteredReason = 'PASSIVE_PUMP_ACCOUNT_MENTION';
      ...
        task = observe(Object.freeze({
          endpointId: endpoint.id,
          program,
          signature,
          slot: BigInt(slot),
          hint: notACreate ? 'NONE' : hint,
          hintMint: notACreate ? null : hintMint,
          ...(filteredReason === null ? {} : { filteredReason }),
        }));
```

- [ ] **Step 4: Run the session test and see it pass.** Expected: PASS.

- [ ] **Step 5: Write the failing supervisor test.** In the supervisor test file, copy the test that feeds a `filteredReason: 'PASSIVE_PUMP_ACCOUNT_MENTION'` notification. Make a variant with `filteredReason: 'NOT_A_CREATE'` and assert:
  - `reporter.observeFiltered` is called with the slot;
  - `reporter.observe` is not called;
  - `filteredNotificationMetrics().count` does not change, because the counter stays dedicated to passive mentions.

- [ ] **Step 6: Implement in the supervisor.**

```ts
      if (filtered && ((payload.filteredReason !== 'PASSIVE_PUMP_ACCOUNT_MENTION'
          && payload.filteredReason !== 'NOT_A_CREATE')
        || payload.program !== 'pumpfun' || payload.hint !== 'NONE' || payload.hintMint !== null)) {
        throw new TypeError();
      }
```

In the `if (filtered)` branch, increment `#filteredCounts` only when `payload.filteredReason === 'PASSIVE_PUMP_ACCOUNT_MENTION'`. Keep the reason in a local before the `try` exits.

- [ ] **Step 7: Run both test files and see them pass.**

- [ ] **Step 8: Commit**

```bash
git add src/solana/rpc/ws-program-session.ts src/application/websocket-failover-supervisor.ts tests/
git commit -m "feat(listener): filter non-create Pump notifications in creates-only sessions"
```

### Task 3: Factory wiring for `creates-only`, without strict scans

**Files:**
- Modify: `src/application/production-listener-factory.ts` (~lines 446-478)
- Test: the factory test (`grep -ln createProductionListenerRuntime tests/*.ts`)

- [ ] **Step 1: Implement.** Near the top of `createProductionListenerRuntime`:

```ts
  const createsOnly = config.listenerIngestionScope === 'creates-only';
```

Then:

```ts
      prepareInitialFrontier: async (providerId, signal): Promise<void> => {
        if (createsOnly || config.listenerCatchUpPolicy !== 'live-edge') return;
        ...
      openSession: (endpoint, observe, signal) => openWsProgramSession(endpoint, observe, signal, {
          programs: ingestionPrograms,
          workerAdmissionEnabled: workerAdmissionPolicy.enabled,
          createsOnly,
        }),
      runStrictScan: (providerId, signal): ReturnType<StrictCatchUpCoordinator['run']> => {
        // A missed create is a lost opportunity, not a gap to repair.
        if (createsOnly) return Promise.resolve(Object.freeze({
          providerId, discoveredCount: 0, enqueuedCount: 0, checkpointCasCount: 0, pageCount: 0,
          boundaries: Object.freeze({ launchpad: null, market: null }),
        }));
        ...
```

- [ ] **Step 2: Add a test if the factory test already builds a runtime from a config.** Build it with `LISTENER_INGESTION_SCOPE=creates-only` and assert it starts without calling `getSignaturesForAddress` on the program. If the factory has no such harness, skip this step: the session and supervisor tests cover the behaviour.

- [ ] **Step 3: Type-check.** Run `npm run build:backend`. Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/application/production-listener-factory.ts tests/
git commit -m "feat(listener): skip strict catch-up scans in the creates-only scope"
```

### Task 4: Migration 063 and the `PUMPFUN_CURVE_TRADE` hint in the domain

**Files:**
- Create: `migrations/063_listener_tracked_curve_checkpoints.sql`
- Create: `tests/transaction-inbox-curve-trade-migration.test.ts`
- Modify: `src/domain/transaction-ingestion.ts` (lines 94-99, 491-512)
- Modify: `src/execution-migrations/live-catalog.ts`, `scripts/deployment-smoke.mjs` (canonical list)
- Modify: the migration-count assertions in tests. Follow commit `22d3b64` (migration 062), which shows every file to touch.

- [ ] **Step 1: Write the migration.**

```sql
CREATE TABLE IF NOT EXISTS listener_tracked_curve_checkpoints (
  bonding_curve TEXT PRIMARY KEY CHECK (LENGTH(bonding_curve) BETWEEN 32 AND 44),
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  slot NUMERIC(78,0) NOT NULL CHECK (slot >= 0),
  signature TEXT NOT NULL CHECK (LENGTH(signature) BETWEEN 1 AND 128),
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS listener_tracked_curve_checkpoints_mint_idx
  ON listener_tracked_curve_checkpoints (mint);

ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT chain_transaction_inbox_ingestion_hint_check,
  ADD CONSTRAINT chain_transaction_inbox_ingestion_hint_check CHECK (
    (ingestion_hint IN ('NONE', 'PUMPFUN_CREATE') AND ingestion_hint_mint IS NULL)
    OR (ingestion_hint IN ('PUMPFUN_TRADE', 'PUMPFUN_CURVE_TRADE', 'PUMPSWAP_POOL_TRADE')
      AND ingestion_hint_mint IS NOT NULL
      AND ingestion_hint_mint = BTRIM(ingestion_hint_mint)
      AND OCTET_LENGTH(ingestion_hint_mint) BETWEEN 32 AND 44
      AND ingestion_hint_mint COLLATE "C" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  );
```

Check whether `chain_transaction_inbox.ingestion_hint` is a plain TEXT column or an enum: `grep -n "ingestion_hint " migrations/*.sql`. If it is an enum, add `ALTER TYPE ... ADD VALUE IF NOT EXISTS 'PUMPFUN_CURVE_TRADE'` (migration 060 needed none).

- [ ] **Step 2: Write the migration test.** Copy `tests/transaction-inbox-pool-trade-migration.test.ts` into `tests/transaction-inbox-curve-trade-migration.test.ts` and change:
  - `migrationName = '063_listener_tracked_curve_checkpoints.sql'`;
  - the contract fragments become `'listener_tracked_curve_checkpoints'`, `'REFERENCES token_launches(mint) ON DELETE CASCADE'`, `"'PUMPFUN_CURVE_TRADE'"`, `'chain_transaction_inbox_ingestion_hint_check'`;
  - the PG test seeds only the `token_launches` row (`'MINT'`), inserts a checkpoint `('CURVE'.padEnd(32, 'x'), 'MINT', 10, 'sig', now)`, asserts the slot and signature CHECKs (`23514`), inserts a `PUMPFUN_CURVE_TRADE` inbox row with a canonical mint, rejects one with a `null` mint and one with `' bad '`, then `DELETE FROM token_launches WHERE mint = 'MINT'` and asserts the checkpoint table is empty;
  - the schema prefix becomes `inbox_curve_trade_`.

- [ ] **Step 3: Run it and see it fail.** Run `npx tsx --test tests/transaction-inbox-curve-trade-migration.test.ts`. Expected: FAIL until the migration is registered.

- [ ] **Step 4: Register 063.**
  - Run `shasum -a 256 migrations/063_listener_tracked_curve_checkpoints.sql` and add the line `063_listener_tracked_curve_checkpoints.sql <sha>` after 062 in `src/execution-migrations/live-catalog.ts`.
  - Add `'063_listener_tracked_curve_checkpoints.sql',` after 062 in `scripts/deployment-smoke.mjs`.

- [ ] **Step 5: Add the hint to the domain.** In `src/domain/transaction-ingestion.ts`:

```ts
export const TRANSACTION_INGESTION_HINTS = Object.freeze([
  'NONE',
  'PUMPFUN_CREATE',
  'PUMPFUN_TRADE',
  'PUMPFUN_CURVE_TRADE',
  'PUMPSWAP_POOL_TRADE',
] as const);
```

```ts
  if (!isValidIngestionHintPair(record.ingestionHint, record.ingestionHintMint)
    || (isPollerHint(record.ingestionHint) && record.source !== 'CATCH_UP')) {
    throw new TypeError('Transaction notification ingestion hint is invalid.');
  }
  // Poller catch-up rows carry a tracked mint; the pair check covers it.
  if (record.source === 'CATCH_UP' && !isPollerHint(record.ingestionHint)
    && (record.ingestionHint !== null || record.ingestionHintMint !== null)) {
    throw new TypeError('Transaction notification ingestion hint is invalid for catch-up.');
  }
```

```ts
function isPollerHint(hint: unknown): boolean {
  return hint === 'PUMPFUN_CURVE_TRADE' || hint === 'PUMPSWAP_POOL_TRADE';
}

function isValidIngestionHintPair(hint: unknown, mint: unknown): boolean {
  if (hint === null && mint === null) return true;
  if (hint === 'PUMPFUN_CREATE' && mint === null) return true;
  return (hint === 'PUMPFUN_TRADE' || isPollerHint(hint))
    && typeof mint === 'string'
    && isCanonicalSolanaProgramId(mint);
}
```

In `tests/transaction-ingestion-contracts.test.ts`, duplicate the `PUMPSWAP_POOL_TRADE` cases for `PUMPFUN_CURVE_TRADE`:
  - accepted with `CATCH_UP` and a mint;
  - rejected with `WEBSOCKET`;
  - rejected without a mint.

- [ ] **Step 6: Update the migration counts.** Run the full suite. Each failure of the form "expected 62 migrations / last version 062" gets the same edit commit `22d3b64` made for 062 (`git show 22d3b64 --stat`).

- [ ] **Step 7: Run the touched files and see them pass.**

- [ ] **Step 8: Commit**

```bash
git add migrations/063_listener_tracked_curve_checkpoints.sql src/domain/transaction-ingestion.ts \
  src/execution-migrations/live-catalog.ts scripts/deployment-smoke.mjs tests/
git commit -m "feat(migrations): add tracked curve checkpoints and the PUMPFUN_CURVE_TRADE hint (063)"
```

### Task 5: `PUMPFUN_CURVE_TRADE` in the transaction inbox

**Files:**
- Modify: `src/storage/transaction-inbox.repository.ts`
- Test: `tests/tracked-pool-trade-ingestion.test.ts` (template) → `tests/tracked-curve-trade-ingestion.test.ts`

Every place below handles `PUMPSWAP_POOL_TRADE` today; `PUMPFUN_CURVE_TRADE` gets the same treatment.

- [ ] **Step 1: Write the failing test.** Copy `tests/tracked-pool-trade-ingestion.test.ts` into `tests/tracked-curve-trade-ingestion.test.ts`. Replace `PUMPSWAP_POOL_TRADE` with `PUMPFUN_CURVE_TRADE` and the program with `PUMP_PROGRAM_ID` (`src/launchpads/pumpfun/constants.ts`). Add one ordering test:
  - enqueue, on the same tracked mint and at the same slot, one `PUMPSWAP_POOL_TRADE`, one `PUMPFUN_CURVE_TRADE` and one `PUMPFUN_TRADE` (WebSocket);
  - claim three times;
  - expect the order `PUMPFUN_TRADE`, `PUMPFUN_CURVE_TRADE`, `PUMPSWAP_POOL_TRADE`.

Also add a `hasNonTerminalProgramWork(PUMP_PROGRAM_ID)` test: it must return `false` when the only pending row is a `PUMPFUN_CURVE_TRADE`.

- [ ] **Step 2: Run it and see it fail.** Expected: FAIL (hint invalid / stored hint invalid).

- [ ] **Step 3: Implement.** In `src/storage/transaction-inbox.repository.ts`:
  - line 202: `type StoredIngestionHint = 'NONE' | 'PUMPFUN_CREATE' | 'PUMPFUN_TRADE' | 'PUMPFUN_CURVE_TRADE' | 'PUMPSWAP_POOL_TRADE';`
  - enqueue (~line 592): lock the mint for `PUMPFUN_CURVE_TRADE` too:
    `if (value.ingestionHint === 'PUMPFUN_TRADE' || value.ingestionHint === 'PUMPFUN_CURVE_TRADE' || value.ingestionHint === 'PUMPSWAP_POOL_TRADE') {`
  - claim ordering: replace each `(ingestion_hint='PUMPSWAP_POOL_TRADE'),` with `(ingestion_hint='PUMPSWAP_POOL_TRADE'),(ingestion_hint='PUMPFUN_CURVE_TRADE'),`, and the same with the `inbox.` alias. That gives PUMPFUN_TRADE (false,false) < CURVE (false,true) < POOL (true,false). Lines ~245, ~284, ~1476, ~1564. Check with `grep -n "ingestion_hint='PUMPSWAP_POOL_TRADE')" src/storage/transaction-inbox.repository.ts`.
  - ~line 1465: `AND inbox.ingestion_hint IN ('PUMPFUN_TRADE','PUMPFUN_CURVE_TRADE','PUMPSWAP_POOL_TRADE')`
  - `hasNonTerminalProgramWork` (~line 1691): `AND ingestion_hint NOT IN ('PUMPFUN_CURVE_TRADE','PUMPSWAP_POOL_TRADE')`
  - `convergeIngestion` (~line 4221):

```ts
  } else if (hint === 'PUMPFUN_CURVE_TRADE' || hint === 'PUMPSWAP_POOL_TRADE') {
    // The pollers only enqueue addresses whose mint is already tracked.
    priority = 'TRACKED_TRADE';
    if (status === 'DEFERRED') status = 'PENDING';
  }
```

  - `storedIngestionDecision` (~line 4312): accept `PUMPFUN_CURVE_TRADE` in the hint list, in `assertCanonicalMint`, and in the `TRACKED_TRADE` coherence check.
  - Check for any other place with `grep -n "PUMPSWAP_POOL_TRADE" src/storage/transaction-inbox.repository.ts`. Each remaining occurrence must also handle `PUMPFUN_CURVE_TRADE`.

- [ ] **Step 4: Run both ingestion test files.** Run `tracked-curve-trade-ingestion` and `tracked-pool-trade-ingestion`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/transaction-inbox.repository.ts tests/tracked-curve-trade-ingestion.test.ts
git commit -m "feat(inbox): ingest PUMPFUN_CURVE_TRADE rows as tracked trades"
```

### Task 6: Poller options and the target-aware seed

**Files:**
- Modify: `src/application/tracked-pool-poller.ts`
- Modify: `src/storage/tracked-pool.repository.ts`
- Test: `tests/tracked-pool-poller.test.ts`, `tests/tracked-pool.repository.test.ts`

- [ ] **Step 1: Write the failing test.** In `tests/tracked-pool-poller.test.ts`:
  - let `harness` take an optional `extra: Partial<TrackedPoolPollerOptions>` that it spreads into the constructor options;
  - the harness `seedCheckpoint` now receives `(target: TrackedPool, value)` and records `target.poolAddress`;
  - add this test:

```ts
void test('the poller enqueues with the configured hint and program', async () => {
  const h = harness([trackedPool(POOL_A, MINT_A)], {
    [POOL_A]: historyScript([row('s2', 102), row('s1', 101), row(`act-${POOL_A}`, 100)]),
  }, { ingestionHint: 'PUMPFUN_CURVE_TRADE', programId: PUMP_PROGRAM_ID });
  await h.poller.start();
  assert.deepEqual(h.enqueued.map((value) => [value.ingestionHint, value.programIds[0]]), [
    ['PUMPFUN_CURVE_TRADE', PUMP_PROGRAM_ID], ['PUMPFUN_CURVE_TRADE', PUMP_PROGRAM_ID],
  ]);
});
```

- [ ] **Step 2: Run it and see it fail.** Expected: FAIL (the type rejects the options).

- [ ] **Step 3: Implement.** In `TrackedPoolPollerOptions`:

```ts
    seedCheckpoint(target: TrackedPool, value: PoolCheckpoint, nowMs: number): Promise<void>;
  ...
  /** Inbox hint and program for the enqueued rows; defaults to the PumpSwap pool values. */
  readonly ingestionHint?: 'PUMPSWAP_POOL_TRADE' | 'PUMPFUN_CURVE_TRADE';
  readonly programId?: string;
```

In `pollPool`, call `await repository.seedCheckpoint(pool, checkpoint, this.now());` and enqueue with:

```ts
        ingestionHint: this.options.ingestionHint ?? 'PUMPSWAP_POOL_TRADE',
        ingestionHintMint: pool.baseMint,
        programIds: Object.freeze([this.options.programId ?? PUMPSWAP_PROGRAM_ID]),
```

In `src/storage/tracked-pool.repository.ts`:

```ts
  public async seedCheckpoint(target: TrackedPool, value: PoolCheckpoint, nowMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO listener_tracked_pool_checkpoints (pool_address, slot, signature, updated_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (pool_address) DO NOTHING`,
      [target.poolAddress, value.slot.toString(), value.signature, new Date(nowMs)],
    );
  }
```

Update the `seedCheckpoint` calls in `tests/tracked-pool.repository.test.ts`: pass a `TrackedPool` object instead of the address.

- [ ] **Step 4: Run both test files and see them pass.**

- [ ] **Step 5: Commit**

```bash
git add src/application/tracked-pool-poller.ts src/storage/tracked-pool.repository.ts tests/
git commit -m "refactor(poller): configurable hint and program, target-aware checkpoint seed"
```

### Task 7: `PostgresTrackedCurveRepository`

**Files:**
- Create: `src/storage/tracked-curve.repository.ts`
- Create: `tests/tracked-curve.repository.test.ts`

- [ ] **Step 1: Write the failing test.** Reuse the temporary-schema helper from `tests/tracked-pool.repository.test.ts` and skip when `TEST_DATABASE_URL` is absent, as that file does. Insert `token_launches` rows directly with the column list from `tests/transaction-inbox-pool-trade-migration.test.ts` `seedPool`; set `created_slot` per mint. Test the exported `selectTrackedCurves(client, mints)` directly, so the test does not need to build the whole `listWorkerTrackingMints` authority. Cases:
  - three launches A (slot 10), B (slot 20), C (slot 30), called with `[A, B, C]`:
    - returns C, B, A (newest first);
    - each `poolAddress` equals `bondingCurvePda(new PublicKey(mint)).toBase58()`;
    - each `activationSignature`/`activationSlot` equals `created_signature`/`created_slot`.
  - B has an active `market_pools` row: B is excluded. Seed it as `seedPool` does, with `base_mint` = B.
  - a mint absent from `token_launches` is ignored.
  - 25 mints → 20 rows (`MAX_TRACKED_POOLS`).
  - Checkpoints: `seedCheckpoint` inserts `(curve, mint)`, a second seed is a no-op, `storeCheckpoint` moves forward, refuses to go backwards (throws), and `readCheckpoint` returns `null` for an unknown curve.

Use real base58 mints, not `'MINT'`, because `bondingCurvePda` needs a valid public key. `So11111111111111111111111111111111111111112` and keys from `Keypair.generate().publicKey.toBase58()` both work.

- [ ] **Step 2: Run it and see it fail.** Run `npx tsx --test tests/tracked-curve.repository.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement.**

```ts
import { PublicKey } from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import { bondingCurvePda } from '../launchpads/pumpfun/official-sdk.js';
import { MAX_TRACKED_POOLS, type PoolCheckpoint, type TrackedPool } from './tracked-pool.repository.js';
import { listWorkerTrackingMints } from './worker-tracking-mint-lock.js';

/**
 * Bonding curves of the tracked mints that have not migrated, in the TrackedPoolPoller target
 * shape: `poolAddress` is the bonding curve, `baseMint` the mint, the activation is the create.
 */
export class PostgresTrackedCurveRepository {
  public constructor(private readonly pool: Pool) {}

  public async listTrackedPools(trackingWindowSeconds: number): Promise<readonly TrackedPool[]> {
    const client = await this.pool.connect();
    try {
      const mints = await listWorkerTrackingMints(client, trackingWindowSeconds);
      return mints.length === 0 ? Object.freeze([]) : await selectTrackedCurves(client, mints);
    } finally {
      client.release();
    }
  }

  public async readCheckpoint(bondingCurve: string): Promise<PoolCheckpoint | null> {
    const result = await this.pool.query<{ slot: string; signature: string }>(
      `SELECT slot::text AS slot, signature
         FROM listener_tracked_curve_checkpoints WHERE bonding_curve = $1`,
      [bondingCurve],
    );
    const row = result.rows[0];
    return row === undefined ? null : { slot: BigInt(row.slot), signature: row.signature };
  }

  public async seedCheckpoint(target: TrackedPool, value: PoolCheckpoint, nowMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO listener_tracked_curve_checkpoints (bonding_curve, mint, slot, signature, updated_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (bonding_curve) DO NOTHING`,
      [target.poolAddress, target.baseMint, value.slot.toString(), value.signature, new Date(nowMs)],
    );
  }

  public async storeCheckpoint(bondingCurve: string, value: PoolCheckpoint, nowMs: number): Promise<void> {
    const result = await this.pool.query(
      `UPDATE listener_tracked_curve_checkpoints
          SET slot = $2, signature = $3, updated_at = $4
        WHERE bonding_curve = $1 AND slot <= $2`,
      [bondingCurve, value.slot.toString(), value.signature, new Date(nowMs)],
    );
    if (result.rowCount !== 1) {
      throw new Error('Tracked curve checkpoint is missing or would move backwards.');
    }
  }
}

/** Live positions first, then the newest launches; migrated mints are left to the pool poller. */
export async function selectTrackedCurves(
  client: Pick<PoolClient, 'query'>,
  mints: readonly string[],
): Promise<readonly TrackedPool[]> {
  const result = await client.query<{ mint: string; signature: string; slot: string }>(
    `SELECT launch.mint, launch.created_signature AS signature, launch.created_slot::text AS slot
       FROM token_launches AS launch
      WHERE launch.mint = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM market_pools AS pool
           WHERE pool.base_mint = launch.mint AND pool.pool_state = 'active'
             AND pool.confirmation_status <> 'orphaned')
      ORDER BY (launch.mint IN (SELECT mint FROM listener_worker_tracking_live_mints)) DESC,
               launch.created_slot DESC, launch.mint
      LIMIT $2`,
    [mints, MAX_TRACKED_POOLS],
  );
  return Object.freeze(result.rows.map((row) => Object.freeze({
    poolAddress: bondingCurvePda(new PublicKey(row.mint)).toBase58(),
    baseMint: row.mint,
    activationSignature: row.signature,
    activationSlot: BigInt(row.slot),
  })));
}
```

Check that `official-sdk.ts` exports `bondingCurvePda` with the signature `(mint: PublicKey) => PublicKey`: `grep -n bondingCurvePda src/launchpads/pumpfun/official-sdk.ts`. If it returns something else, adapt the call.

- [ ] **Step 4: Run it and see it pass.**

- [ ] **Step 5: Commit**

```bash
git add src/storage/tracked-curve.repository.ts tests/tracked-curve.repository.test.ts
git commit -m "feat(storage): list the bonding curves of tracked mints for the curve poller"
```

### Task 8: Start the curve poller in the `creates-only` scope

**Files:**
- Modify: `src/application/production-listener-factory.ts` (~lines 702-737)

- [ ] **Step 1: Implement.** Extract the poller construction into a local function and build two pollers:

```ts
  const pollerRpc = {
    getSignaturesForAddress: (address: PublicKey, { before, ...options }: {
      readonly before?: string | undefined; readonly until?: string; readonly limit: number;
    }, commitment: 'finalized'): Promise<unknown> => rpc.http.getSignaturesForAddress(
      address, before === undefined ? options : { ...options, before }, commitment,
    ),
  };
  const trackedPoller = (kind: 'pool' | 'curve'): TrackedPoolPoller => new TrackedPoolPoller({
    repository: kind === 'pool'
      ? new PostgresTrackedPoolRepository(databasePool)
      : new PostgresTrackedCurveRepository(databasePool),
    ...(kind === 'curve' ? { ingestionHint: 'PUMPFUN_CURVE_TRADE' as const, programId: PUMP_PROGRAM_ID } : {}),
    inbox,
    rpc: pollerRpc,
    intervalMs: config.listenerTrackedPoolPollIntervalMs,
    trackingWindowSeconds: config.listenerPumpFunTrackingWindowSeconds,
    shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
    scheduler: listenerScheduler,
    onCycle: (report): void => {
      logger.info({ event: `listener.tracked_${kind}_poll_cycle`, ...report }, `Cycle de sondage des ${kind === 'pool' ? 'pools' : 'bonding curves'} suivis terminé.`);
    },
    onPool: (report): void => {
      logger.warn({ event: `listener.tracked_${kind}_poll_target`, ...report }, `${kind === 'pool' ? 'Pool' : 'Bonding curve'} suivi hors succès.`);
    },
  });
  const pollers = [
    ...(config.listenerTrackedPoolPollEnabled ? [trackedPoller('pool')] : []),
    ...(createsOnly ? [trackedPoller('curve')] : []),
  ];
```

Keep the existing event names for the pool poller (`listener.tracked_pool_poll_cycle`, `listener.tracked_pool_poll_pool`) if a test or doc pins them: check with `grep -rn tracked_pool_poll tests docs`. If one does, build the names so the pool keeps them.

Then replace `poller` with `pollers`:

```ts
  if (pollers.length === 0 && attemptBudget === undefined) return runtime;
  ...
      for (const poller of pollers) void poller.start();
  ...
      try { await Promise.all(pollers.map((poller) => poller.close())); } finally { ... }
```

The curve poller in `creates-only` needs no new flag: the spec gives it no variable, and the scope is restart-only.

- [ ] **Step 2: Type-check, then run the factory and poller tests.** Run `npm run build:backend`, then `npx tsx --test tests/tracked-pool-poller.test.ts` plus the factory test file. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/application/production-listener-factory.ts
git commit -m "feat(listener): run the tracked curve poller in the creates-only scope"
```

### Task 9: Documentation, full suite, PR

**Files:**
- Modify: `.env.example` (or the env reference: `grep -rln LISTENER_INGESTION_SCOPE docs README.md .env.example`)
- Modify: `docs/superpowers/plans/2026-10-06-simple-path-CHECKPOINT.md`

- [ ] **Step 1: Document the scope.** Wherever `LISTENER_INGESTION_SCOPE` is documented, add `creates-only`:
  - Pump WebSocket only, only `create` notifications are enqueued;
  - no strict catch-up;
  - bonding-curve poller (10 s cadence, ≤ 20 curves) for the tracked mints;
  - restart-only.

- [ ] **Step 2: Run the full suite.**
  `rm -rf dist && npm run build:backend && TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/sol_token_listener_test npm run test:backend`.
  Expected: green, apart from the known qualification-projection timeouts under load (rerun that file alone).

- [ ] **Step 3: Update the checkpoint.** Mark lot 2 done (PR number) and set "next: lot 3".

- [ ] **Step 4: Commit, push, open the PR.**

```bash
git add -A docs .env.example
git commit -m "docs: document the creates-only ingestion scope"
git push -u origin feat/creates-only
gh pr create --base main --title "feat: creates-only ingestion and tracked curve poller (simple path lot 2)" --body-file <body>
```

PR body:
- summary of tasks 1-8;
- migration 063 (one table + widened CHECK, no data change);
- `creates-only` is opt-in, and the default stays `launchpad-and-market`;
- test plan.

- [ ] **Step 5: CI, merge, update.** Wait for CI to go green, then merge and update the local `main`.
