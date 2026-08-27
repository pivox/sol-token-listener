# Provider-affine strict catch-up implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver issue #60 as an inactive provider-pinned strict catch-up
foundation with exact checkpoint CAS, coalescing and durable strict-window
evidence.

**Architecture:** A provider-pinned source validates an explicit genesis hash
and owns one HTTP connection. A dedicated strict scanner captures both
boundaries, completes both backward walks before durable writes, enqueues
discoveries, and then advances checkpoints with exact CAS. A small coordinator
shares one in-flight scan promise. The existing policy-aware startup scanner
and production subscriber remain unchanged until #63.

**Tech Stack:** TypeScript strict ESM, `@solana/web3.js`, PostgreSQL, bigint,
Node test runner, migration 026.

---

### Task 1: Strict failure domain contract and replayable migration

**Files:**

- Create: `src/domain/strict-catch-up.ts`
- Create: `migrations/026_listener_strict_catch_up_failures.sql`
- Modify: `tests/transaction-ingestion-migration.test.ts`

- [ ] **Step 1: Write the failing migration and domain tests**

Define tests that require a deterministic frozen value with this public shape:

```ts
export interface StrictCatchUpFailure {
  readonly failureId: string;
  readonly checkpointKey: 'launchpad' | 'market';
  readonly previous: ProcessingCheckpoint | null;
  readonly providerId: RpcProviderId;
  readonly observedHeadSlot: bigint | null;
  readonly reasonCode: 'CATCH_UP_WINDOW_EXCEEDED';
  readonly detectedAtMs: number;
}
```

The ID must hash the version, checkpoint key, exact nullable boundary,
provider ID, nullable observed head and reason. Test invalid/accessor-backed
inputs, bigint bounds, canonical IDs, migration replay, nullable boundary
correlation, positional provider checks, unresolved `purge_after IS NULL`, and
resolved `purge_after = resolved_at + INTERVAL '4 hours'`.

- [ ] **Step 2: Run the tests and observe the expected missing-module/migration failure**

Run:

```bash
node --import tsx --test tests/transaction-ingestion-migration.test.ts
```

Expected: FAIL because migration 026 and the domain factory do not exist.

- [ ] **Step 3: Implement the minimal immutable domain factory and SQL table**

The migration must use this lifecycle:

```sql
CREATE TABLE IF NOT EXISTS listener_strict_catch_up_failures (
  failure_id TEXT PRIMARY KEY,
  checkpoint_key TEXT NOT NULL,
  previous_slot NUMERIC(78,0),
  previous_signature TEXT,
  provider_id TEXT NOT NULL,
  observed_head_slot NUMERIC(78,0),
  reason_code TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CHECK ((previous_slot IS NULL) = (previous_signature IS NULL)),
  CHECK ((resolved_at IS NULL AND purge_after IS NULL)
    OR purge_after = resolved_at + INTERVAL '4 hours')
);
```

Add closed checks for the two checkpoint keys, four positional provider IDs,
the reason code, non-negative numeric values, canonical signatures and the
deterministic ID prefix. Add indexes for unresolved-boundary resolution and
resolved purge. Never add floats, raw errors, endpoint URLs or secrets.

- [ ] **Step 4: Run the focused tests until green**

Run the same command. Expected: PASS (PostgreSQL live cases may skip only when
`TEST_DATABASE_URL` is absent).

- [ ] **Step 5: Commit the slice**

```bash
git add src/domain/strict-catch-up.ts migrations/026_listener_strict_catch_up_failures.sql tests/transaction-ingestion-migration.test.ts
git commit -m "feat: define durable strict catch-up failures (#60)"
```

### Task 2: Exact checkpoint CAS and strict failure repository

**Files:**

- Create: `src/ports/strict-catch-up-repository.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Require this narrow port:

```ts
export interface StrictCatchUpRepository {
  enqueue(value: TransactionNotification): Promise<void>;
  readCheckpoint(key: ProcessingCheckpointKey): Promise<ProcessingCheckpoint | null>;
  compareAndSwapCheckpoint(
    expected: ProcessingCheckpoint | null,
    next: ProcessingCheckpoint,
  ): Promise<void>;
  recordStrictCatchUpFailure(value: StrictCatchUpFailure): Promise<void>;
  resolveStrictCatchUpFailures(
    key: ProcessingCheckpointKey,
    previous: ProcessingCheckpoint | null,
    resolvedAtMs: number,
  ): Promise<void>;
}
```

Cover absent-to-present CAS, exact present-to-next CAS, same-slot signatures,
stale expected rows, invalid timestamps, idempotent failure replay preserving
the first detection, boundary-specific resolution and four-hour retention.

- [ ] **Step 2: Run and observe missing-method failures**

```bash
node --import tsx --test tests/transaction-inbox.repository.test.ts
```

- [ ] **Step 3: Implement PostgreSQL CAS and failure lifecycle**

Use one short transaction plus the existing checkpoint advisory-lock family.
For `expected === null`, insert with `ON CONFLICT DO NOTHING` and require one
row. For an existing expected value, update only where key, slot and signature
all match and require one row. Do not compare `updatedAtMs` for CAS identity.
Translate a zero-row CAS into the existing redacted
`TransactionInboxConflictError('checkpoint')`.

Insert strict failures with `ON CONFLICT (failure_id) DO NOTHING`, then verify
any existing row has the same immutable identity. Resolve every unresolved row
for the exact nullable boundary with one database clock and set four-hour
retention.

- [ ] **Step 4: Run focused repository and migration tests until green**

```bash
node --import tsx --test tests/transaction-inbox.repository.test.ts tests/transaction-ingestion-migration.test.ts
```

- [ ] **Step 5: Commit the slice**

```bash
git add src/ports/strict-catch-up-repository.ts src/storage/transaction-inbox.repository.ts tests/transaction-inbox.repository.test.ts
git commit -m "feat: add exact catch-up checkpoint CAS (#60)"
```

### Task 3: Provider-pinned Solana catch-up source

**Files:**

- Create: `src/solana/rpc/provider-pinned-catch-up-source.ts`
- Create: `tests/provider-pinned-catch-up-source.test.ts`

- [ ] **Step 1: Write failing source tests**

Specify an injectable RPC factory and an exported result containing only the
provider ID plus a `CatchUpSource`. Tests must prove that the catalog resolves
exactly once, `getGenesisHash` runs before signatures, every page uses the same
RPC object, a canonical 32-byte base58 expected hash is required, and mismatch,
RPC failure and hostile errors become fixed typed failures without URL leakage.

- [ ] **Step 2: Run and observe the missing-module failure**

```bash
node --import tsx --test tests/provider-pinned-catch-up-source.test.ts
```

- [ ] **Step 3: Implement the minimal pinned source**

Expose the following boundary:

```ts
export type ProviderPinnedCatchUpSourceErrorReason =
  | 'CONFIG_INVALID'
  | 'GENESIS_UNAVAILABLE'
  | 'GENESIS_MISMATCH';

export function createProviderPinnedCatchUpSource(
  catalog: RpcProviderCatalog,
  providerId: RpcProviderId,
  commitment: Commitment,
  expectedGenesisHash: string,
  dependencies?: ProviderPinnedCatchUpSourceDependencies,
): CatchUpSource;
```

The default factory constructs one `Connection` from the selected `httpUrl`
with no failover fetch. Validate genesis once per source instance before the
first list call, cache only a successful validation, and delegate page
normalization to `SolanaCatchUpSource`.

- [ ] **Step 4: Run the focused source tests until green**

Run the same command and `npm run check`.

- [ ] **Step 5: Commit the slice**

```bash
git add src/solana/rpc/provider-pinned-catch-up-source.ts tests/provider-pinned-catch-up-source.test.ts
git commit -m "feat: pin strict catch-up to one Solana provider (#60)"
```

### Task 4: Dedicated strict scanner

**Files:**

- Create: `src/application/strict-catch-up-scanner.ts`
- Create: `tests/strict-catch-up-scanner.test.ts`

- [ ] **Step 1: Write the scanner contract tests first**

Cover exact two-program boundary capture, multi-page `before` pagination,
newest-to-oldest response checks, full-scan-before-write behavior, merged
oldest-to-newest enqueues, nullable cold start, exact CAS arguments, no-op
unchanged frontier, enqueue failure, CAS conflict after one program, crash
replay, window exhaustion evidence and resolution after later success.

Require a result containing provider ID, discovery/enqueue/CAS/page counts and
the two captured boundaries. Require fixed typed stages:

```ts
export type StrictCatchUpScannerStage =
  | 'checkpoint-read'
  | 'source'
  | 'window'
  | 'enqueue'
  | 'checkpoint-cas'
  | 'failure-write'
  | 'failure-resolve';
```

- [ ] **Step 2: Run and verify the expected missing-module failure**

```bash
node --import tsx --test tests/strict-catch-up-scanner.test.ts
```

- [ ] **Step 3: Implement the strict scanner without importing live-edge policy**

Snapshot hostile inputs, keep all page rows in memory until both program walks
succeed, and persist one strict failure before returning a window error. Use
only `compareAndSwapCheckpoint`, never `storeCheckpoint` or
`recordCatchUpGap`. Treat a CAS conflict as transient and allow a later scan to
restart from fresh durable boundaries.

- [ ] **Step 4: Run focused scanner, legacy scanner and repository tests**

```bash
node --import tsx --test tests/strict-catch-up-scanner.test.ts tests/catch-up-scanner.test.ts tests/transaction-inbox.repository.test.ts
```

Expected: PASS and no regression in legacy live-edge behavior.

- [ ] **Step 5: Commit the slice**

```bash
git add src/application/strict-catch-up-scanner.ts tests/strict-catch-up-scanner.test.ts
git commit -m "feat: add strict CAS catch-up scanner (#60)"
```

### Task 5: Re-entrant coalescing coordinator

**Files:**

- Create: `src/application/strict-catch-up-coordinator.ts`
- Create: `tests/strict-catch-up-coordinator.test.ts`
- Modify: `tests/production-listener-factory.test.ts`

- [ ] **Step 1: Write failing concurrency and integration-guard tests**

Require concurrent `run()` calls to return the exact same promise, invoke the
scanner once, clear after fulfillment or rejection, and permit the next call.
Assert production imports neither strict module and still constructs the
legacy scanner/subscriber.

- [ ] **Step 2: Run and observe the expected missing-module failure**

```bash
node --import tsx --test tests/strict-catch-up-coordinator.test.ts tests/production-listener-factory.test.ts
```

- [ ] **Step 3: Implement minimal promise coalescing**

Use one nullable `inFlight` promise and a non-`async` `run()` method so callers
receive the same promise identity. Clear it in both settlement branches only
when it still references that run. Add no timer, retry, provider rotation or
health mutation.

- [ ] **Step 4: Run the focused tests until green**

Run the same command and `npm run check`.

- [ ] **Step 5: Commit the slice**

```bash
git add src/application/strict-catch-up-coordinator.ts tests/strict-catch-up-coordinator.test.ts tests/production-listener-factory.test.ts
git commit -m "feat: coalesce strict catch-up scans (#60)"
```

### Task 6: Retention, documentation and full delivery gate

**Files:**

- Modify: `src/storage/database.ts`
- Modify: `tests/transaction-ingestion-migration.test.ts`
- Modify: `tests/deployment-artifacts.test.ts`
- Modify: `docs/operations/rpc-qualification.md`
- Modify: `docs/superpowers/specs/2026-08-27-solana-websocket-failover-design.md`

- [ ] **Step 1: Write failing purge and packaging tests**

Require migration 026 in empty/replayable database tests and deployment smoke
inventory. Require purge to delete only resolved expired strict failures and
expose `listenerStrictCatchUpFailures` in its typed count result. An unresolved
old row must survive.

- [ ] **Step 2: Run and observe the expected failures**

```bash
node --import tsx --test tests/transaction-ingestion-migration.test.ts tests/deployment-artifacts.test.ts
```

- [ ] **Step 3: Implement purge and operational documentation**

Add one bounded delete:

```sql
DELETE FROM listener_strict_catch_up_failures
WHERE resolved_at IS NOT NULL
  AND purge_after <= clock_timestamp()
```

Document that #60 is inactive, requires an explicit trusted genesis hash at
its constructor boundary, emits no endpoint details and will be wired only by
#63. Increment the spec patch version only if review changes material behavior.

- [ ] **Step 4: Run the complete delivery gate**

```bash
npm run build
npm run check
npm run lint
npm run docs:check
npm test
git diff --check
```

Expected: every command passes; live PostgreSQL tests run when
`TEST_DATABASE_URL` is present. Inspect the diff for URLs, secrets, `any`,
signers, private keys, transaction construction/submission and accidental
production wiring.

- [ ] **Step 5: Review, push and merge**

Request an independent local review, correct blocking findings, then push one
PR closing #60. Request `@codex review`, allow at most three GitHub correction
cycles, merge only with green CI and no unresolved blocking thread, update the
#57 checklist, and continue with #61.
