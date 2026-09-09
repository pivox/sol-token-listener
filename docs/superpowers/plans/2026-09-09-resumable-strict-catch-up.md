# Resumable Strict Catch-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make strict Pump.fun/PumpSwap catch-up persist progress page by page and resume safely instead of becoming unrecoverable when one pass reaches its local page budget.

**Architecture:** Add one versioned strict-run aggregate and PostgreSQL table. The scanner enqueues a validated page before revision-CAS persisting its cursor, completes the run atomically with the canonical checkpoint, and emits a typed pause when more pages remain. The WebSocket supervisor keeps the run provider-affine and degraded until exact completion.

**Tech Stack:** TypeScript strict ESM, Node.js test runner, PostgreSQL 16, `pg`, Solana Web3 RPC, Pino structured logs.

---

## File map

- Create `src/domain/strict-catch-up-run.ts`: immutable run aggregate, validation, deterministic IDs, progress transitions.
- Create `migrations/046_listener_strict_catch_up_runs.sql`: checked durable run state and active-run uniqueness.
- Create `tests/strict-catch-up-run.test.ts`: pure domain boundary tests.
- Create `tests/strict-catch-up-run-migration.test.ts`: empty/replay/upgrade/concurrency/retention PostgreSQL tests.
- Modify `src/ports/strict-catch-up-repository.ts`: run read/create/progress/complete/fail/purge contracts.
- Modify `src/storage/transaction-inbox.repository.ts`: advisory-locked run persistence and checkpoint completion.
- Modify `src/application/strict-catch-up-scanner.ts`: per-page persistence and typed pause.
- Modify `src/application/strict-catch-up-coordinator.ts`: expose the pinned resume provider.
- Modify `src/application/websocket-failover-supervisor.ts`: same-provider retry and non-terminal paused health.
- Modify focused scanner, repository, supervisor, migration, database-retention, and configuration/documentation tests.
- Modify `src/storage/database.ts`: purge only terminal expired runs.
- Modify `src/execution-migrations/live-catalog.ts`: checksum migration 046.
- Modify `docs/architecture/pumpfun-v1.md`, `docs/api/v1.md`, and `.env.example`: document resumable strict semantics without changing defaults.

### Task 1: Define the durable run aggregate and schema

**Files:**
- Create: `src/domain/strict-catch-up-run.ts`
- Create: `migrations/046_listener_strict_catch_up_runs.sql`
- Create: `tests/strict-catch-up-run.test.ts`
- Create: `tests/strict-catch-up-run-migration.test.ts`

- [ ] **Step 1: Write failing aggregate tests**

Cover deterministic replay, frozen snapshots, proxy/accessor rejection, bounds,
revision overflow, valid `ACTIVE -> COMPLETED|FAILED|SUPERSEDED` transitions,
exact four-hour retention, and rejection of cursor/counter regression. Use a
canonical fixture shaped as:

```ts
const run = createStrictCatchUpRun({
  checkpointKey: 'launchpad',
  previous: Object.freeze({
    key: 'launchpad', slot: 10n, signature: 'old', updatedAtMs: 1_000,
  }),
  providerId: 'primary',
  observedHead: Object.freeze({ slot: 20n, signature: 'head' }),
  beforeSignature: 'tail',
  lastAcceptedSlot: 11n,
  pagesScanned: 1n,
  signaturesEnqueued: 9n,
  revision: 0n,
  startedAtMs: 2_000,
  updatedAtMs: 2_000,
});
```

- [ ] **Step 2: Run the domain test and verify it fails because the module is absent**

Run: `npm run build && node --test dist/tests/strict-catch-up-run.test.js`  
Expected: build fails with `Cannot find module '../src/domain/strict-catch-up-run.js'`.

- [ ] **Step 3: Implement immutable types and constructors**

Define these public contracts with no JavaScript financial floats or unsafe
coercions:

```ts
export const STRICT_CATCH_UP_RUN_ID_VERSION = 1 as const;
export const STRICT_CATCH_UP_RUN_STATES = Object.freeze([
  'ACTIVE', 'COMPLETED', 'FAILED', 'SUPERSEDED',
] as const);
export type StrictCatchUpRunState = (typeof STRICT_CATCH_UP_RUN_STATES)[number];
export type StrictCatchUpRunTerminalReason =
  | 'CATCH_UP_WINDOW_EXCEEDED'
  | 'CHECKPOINT_SUPERSEDED';

export interface StrictCatchUpRunHead {
  readonly slot: bigint;
  readonly signature: string;
}

export interface StrictCatchUpRun {
  readonly runId: string;
  readonly checkpointKey: ProcessingCheckpointKey;
  readonly previous: ProcessingCheckpoint;
  readonly providerId: RpcProviderId;
  readonly observedHead: StrictCatchUpRunHead;
  readonly beforeSignature: string;
  readonly lastAcceptedSlot: bigint;
  readonly pagesScanned: bigint;
  readonly signaturesEnqueued: bigint;
  readonly revision: bigint;
  readonly state: StrictCatchUpRunState;
  readonly terminalReason: StrictCatchUpRunTerminalReason | null;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs: number | null;
  readonly purgeAfterMs: number | null;
}
```

Export `createStrictCatchUpRun`, `advanceStrictCatchUpRun`,
`terminalizeStrictCatchUpRun`, and `assertValidStrictCatchUpRun`. Generate
`strict_catchup_run_<sha256>` from version, checkpoint key, previous
slot/signature, and provider ID. Apply the existing 128-byte signature,
`MAX_STRICT_CATCH_UP_SLOT`, `MAX_DATE_MS`, `bigint`, exact-key, plain-data,
frozen-object, and four-hour retention rules.

- [ ] **Step 4: Write the migration test first**

Assert migration 046 creates the four-state enum/table, identity and lifecycle
checks, `BIGINT` counters/revision, one partial unique `ACTIVE` row per
checkpoint key, resumable provider lookup index, terminal purge index, no
secret-like columns, direct replay, migrator replay from empty PostgreSQL, and
rejection of incompatible pre-existing schema.

- [ ] **Step 5: Implement migration 046**

Create a replay-safe enum and table with explicit named checks. Use:

```sql
CREATE UNIQUE INDEX listener_strict_catch_up_runs_active_key_unique
  ON listener_strict_catch_up_runs (checkpoint_key)
  WHERE state = 'ACTIVE';

CREATE INDEX listener_strict_catch_up_runs_terminal_purge_idx
  ON listener_strict_catch_up_runs (purge_after)
  WHERE state <> 'ACTIVE';
```

Enforce `purge_after = completed_at + INTERVAL '4 hours'` for terminal rows and
both fields null for `ACTIVE`. Validate any existing enum, columns, constraints,
and named indexes before accepting replay.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm run build && node --test dist/tests/strict-catch-up-run.test.js dist/tests/strict-catch-up-run-migration.test.js`  
Expected: all pass, using `TEST_DATABASE_URL` for PostgreSQL cases.  
Commit: `feat(ingestion): define resumable catch-up runs (#100)`

### Task 2: Add advisory-locked repository transitions

**Files:**
- Modify: `src/ports/strict-catch-up-repository.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `tests/strict-catch-up-run-migration.test.ts`

- [ ] **Step 1: Write failing port/repository tests**

Add tests for `readActiveStrictCatchUpRun`, `createStrictCatchUpRun`,
`advanceStrictCatchUpRun`, `completeStrictCatchUpRun`,
`failStrictCatchUpRun`, and `supersedeStaleStrictCatchUpRun`. Prove exact replay
is accepted, identity mismatch conflicts, revisions cannot skip/regress, two
writers cannot both advance, and stale checkpoint completion cannot mutate the
run or checkpoint.

- [ ] **Step 2: Extend the port with explicit transition inputs**

```ts
export interface CompleteStrictCatchUpRunInput {
  readonly run: StrictCatchUpRun;
  readonly nextCheckpoint: ProcessingCheckpoint;
}

export interface StrictCatchUpRepository {
  // existing operations remain
  readActiveStrictCatchUpRun(key: ProcessingCheckpointKey): Promise<StrictCatchUpRun | null>;
  createStrictCatchUpRun(value: StrictCatchUpRun): Promise<StrictCatchUpRun>;
  advanceStrictCatchUpRun(expected: StrictCatchUpRun, next: StrictCatchUpRun): Promise<void>;
  completeStrictCatchUpRun(input: CompleteStrictCatchUpRunInput): Promise<void>;
  failStrictCatchUpRun(expected: StrictCatchUpRun, failed: StrictCatchUpRun): Promise<void>;
  supersedeStaleStrictCatchUpRun(expected: StrictCatchUpRun, atMs: number): Promise<void>;
}
```

- [ ] **Step 3: Implement repository mappings and guarded SQL**

Reuse `pg_advisory_xact_lock(hashtextextended('transaction-checkpoint:' || $1,
0))`. Every update must match `run_id`, `state='ACTIVE'`, and expected
`revision`. `completeStrictCatchUpRun` must update the exact canonical
checkpoint and terminalize the exact run in one PostgreSQL transaction.
`createStrictCatchUpRun` must return exact replay or a typed checkpoint conflict,
never silently adopt a different provider/frontier.

- [ ] **Step 4: Run repository tests including real PostgreSQL and commit**

Run: `npm run build && node --test dist/tests/transaction-inbox.repository.test.js dist/tests/strict-catch-up-run-migration.test.js`  
Expected: all pass.  
Commit: `feat(ingestion): persist catch-up page progress (#100)`

### Task 3: Make the scanner page-resumable

**Files:**
- Modify: `src/application/strict-catch-up-scanner.ts`
- Modify: `tests/strict-catch-up-scanner.test.ts`
- Modify: `tests/transaction-ingestion-recovery.test.ts`

- [ ] **Step 1: Write failing scanner tests**

Add exact scenarios: two-page completion; budget pause after one page; second
invocation starts with persisted `before`; crash after all enqueues but before
progress CAS causes only idempotent replay; cancellation leaves the last durable
cursor; exact boundary is excluded; short history records the existing failure;
wrong provider is rejected; stale run is superseded; malformed slot/signature
continuation fails as source pagination; and canonical checkpoint moves only
after exact boundary.

- [ ] **Step 2: Add the typed pause contract**

```ts
export class StrictCatchUpPausedError extends Error {
  public readonly code = 'CATCH_UP_PAGE_BUDGET_EXHAUSTED' as const;
  public readonly retryable = true;
  public readonly stage = 'page-budget' as const;
  public constructor(
    public readonly providerId: RpcProviderId,
    public readonly checkpointKey: ProcessingCheckpointKey,
    public readonly runId: string,
    public readonly pagesScanned: bigint,
    public readonly signaturesEnqueued: bigint,
  ) {
    super('Strict catch-up paused after its page budget.');
    Object.freeze(this);
  }
}
```

Do not add this operational pause to terminal inbox error reason codes.

- [ ] **Step 3: Replace all-window buffering with page commits**

For each page, snapshot and validate rows, collect only rows before the exact
boundary, call existing `enqueue` sequentially, then create/advance the run.
Carry the frozen first-page head through all resumes. If the boundary appears,
construct the head checkpoint and call `completeStrictCatchUpRun`. Throw
`StrictCatchUpPausedError` only after the configured number of pages was fully
persisted and another page is required.

- [ ] **Step 4: Preserve merge and finality semantics**

Ensure duplicate signatures discovered through both configured programs are
merged by repository enqueue, every notification stays `CATCH_UP` with null
hint, status remains the source status, and an abort after an enqueue cannot
advance the cursor.

- [ ] **Step 5: Run scanner/recovery tests and commit**

Run: `npm run build && node --test dist/tests/strict-catch-up-scanner.test.js dist/tests/transaction-ingestion-recovery.test.js`  
Expected: all pass.  
Commit: `feat(ingestion): resume strict scans page by page (#100)`

### Task 4: Keep supervisor recovery pinned and honest

**Files:**
- Modify: `src/application/strict-catch-up-coordinator.ts`
- Modify: `src/application/websocket-failover-supervisor.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/websocket-failover-supervisor.test.ts`
- Modify: `tests/websocket-failover-supervisor.integration.test.ts`

- [ ] **Step 1: Write failing supervisor tests**

Prove a paused run closes the unpromoted candidate session, persists degraded
recoverable health, schedules bounded jitter, and attempts only the pinned
provider next. Prove restart reads the durable provider before selecting a
candidate. Prove differing active provider IDs keep recovery degraded. Preserve
the existing unanimous exact `CATCH_UP_WINDOW_EXCEEDED -> UNRECOVERABLE` test.

- [ ] **Step 2: Expose durable affinity through the coordinator**

Add `readPinnedProviderId(): Promise<RpcProviderId | null>` backed by active
run reads for configured checkpoint keys. Return one provider, null when no run
exists, and throw a typed retryable consistency error if active runs disagree.

- [ ] **Step 3: Handle pause separately from terminal window failure**

Extend `ProviderAttemptResult` with `kind: 'paused'`. The provider cycle must
short-circuit on paused, persist `DEGRADED` with a stable recoverable reason,
and schedule retry. It must not append the error to `windowErrors`, rotate to a
fallback, promote a candidate, or set `#unrecoverable`.

- [ ] **Step 4: Wire the repository-backed affinity and run tests**

Run: `npm run build && node --test dist/tests/websocket-failover-supervisor.test.js dist/tests/websocket-failover-supervisor.integration.test.js`  
Expected: all pass.  
Commit: `fix(listener): resume the pinned catch-up provider (#100)`

### Task 5: Retention, migration inventory, documentation, and full verification

**Files:**
- Modify: `src/storage/database.ts`
- Modify: `src/execution-migrations/live-catalog.ts`
- Modify: migration-head assertions under `tests/`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/api/v1.md`
- Modify: `.env.example`
- Modify: `tests/config-safety.test.ts`

- [ ] **Step 1: Write the failing retention test**

Insert one `ACTIVE` expired-looking row plus terminal rows immediately before,
at, and after their four-hour purge boundary. Assert maintenance keeps active
and future terminal rows and deletes only eligible terminal rows, including the
exact boundary.

- [ ] **Step 2: Add terminal-run cleanup**

Add this bounded predicate to the existing maintenance transaction and expose
its count in the existing cleanup result shape:

```sql
DELETE FROM listener_strict_catch_up_runs
WHERE state <> 'ACTIVE'
  AND purge_after <= clock_timestamp()
```

- [ ] **Step 3: Update migration inventory safely**

Run `sha256sum migrations/046_listener_strict_catch_up_runs.sql`, append the
exact checksum to `LIVE_EXECUTION_MIGRATION_CATALOG`, and update all tests that
explicitly assert migration head 045 to assert 046. Do not modify older
migration files or hashes.

- [ ] **Step 4: Document runtime semantics and safe tuning**

Document `PAUSED` versus `UNRECOVERABLE`, four-hour evidence retention,
provider affinity, page-size 1000 as an optional bounded H2i setting, and the
fact that RPC quota percentage does not prove instantaneous capacity. Keep the
default execution mode `observe`; do not add live variables.

- [ ] **Step 5: Run focused and complete validation**

Run in order:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
npm test
```

Expected: every command exits 0. PostgreSQL-backed tests must use the isolated
PostgreSQL 16 test URL and finish with no leaked schemas.

- [ ] **Step 6: Review the diff and commit**

Run: `git diff --check && git status --short && git diff --stat`  
Expected: only issue #100 files, no secrets, generated runtime evidence, wallet
files, or root-worktree changes.  
Commit: `docs(ingestion): document resumable strict recovery (#100)`

### Task 6: Deliver with two review cycles maximum

**Files:**
- No additional product files unless review finds a concrete defect.

- [ ] **Step 1: Push and open the focused PR**

Push `fix/issue-100-resumable-catch-up`, open a PR linked with `Closes #100`,
state explicitly that signing/submission remain absent, and request a posted
Codex review focused on no-loss recovery, CAS ordering, provider affinity,
retention, and migration replay.

- [ ] **Step 2: Complete review cycle 1**

Wait for all CI checks and review threads. Verify every finding technically,
fix only actionable defects with tests, push once, and reply to threads.

- [ ] **Step 3: Complete final review cycle 2**

Wait again for green CI and no blocking/unresolved threads. Make at most one
final correction push. Do not begin a third review cycle.

- [ ] **Step 4: Merge and re-anchor the isolated worktree**

Merge only with green required checks and no blocking feedback. Fetch
`origin/main`, detach the isolated worktree at the merge commit, and verify it
is clean. Do not switch, reset, or clean the dirty root worktree.

- [ ] **Step 5: Operational follow-up without a wallet**

Apply migration 046 and replay role provisioning on the isolated PostgreSQL 16
database. Collect fresh provider/readiness evidence, run H2i with strict
page-size 1000, and observe recovery plus a 15-minute capacity soak. Stop before
wallet conversion, signer loading, armament, or transaction submission. If
backlog does not shrink or creation-to-pair p95 exceeds 45 seconds, open the
separate tracked-mint trade-priority issue instead of weakening gates.

