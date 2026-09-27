# Pump.fun Bounded Tracking and Worker Admission Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` (recommended) or `executing-plans` to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver #177 as one independently mergeable PR that bounds enabled
Pump.fun trade tracking at 45 seconds unless durable business evidence extends
it, demotes expired pristine work safely, and exposes `workerAdmission.v1`.

**Architecture:** The existing frozen policy selects an exact legacy OFF path
or a PostgreSQL-authoritative ON path. Enabled ingress, synchronization and
pre-claim demotion share one multi-table authority built from a materialized
database clock. A separate immutable metrics aggregate flows through heartbeat,
API, frontend and canary without changing `catchUpAdmission` or introducing a
new worker.

**Tech Stack:** TypeScript strict ESM, Node.js `node:test`, PostgreSQL 16,
React, Zod, Bootstrap, existing V1 health API and redacted canary evaluator.

**Plan revision:** 1.0.1

---

## File map

**New files**

- `src/domain/worker-admission-metrics.ts`: exact immutable
  `workerAdmission.v1` aggregate and validator/snapshotter.
- `tests/worker-admission-metrics.test.ts`: hostile-input and invariant matrix.
- `migrations/056_transaction_inbox_bounded_tracking.sql`: three additive,
  drift-strict partial indexes and one restricted active-live-mint view.
- `tests/transaction-inbox-bounded-tracking-migration.test.ts`: install,
  upgrade, replay, drift and query-plan evidence for migration 056.
- `src/storage/worker-tracking-mint-lock.ts`: one shared advisory-lock namespace
  and canonical multi-mint ordering for every proof producer and demotion.

**Primary modified files**

- `src/domain/worker-admission.ts`: bounded demotion batch constant.
- `src/storage/transaction-inbox.repository.ts`: shared enabled authority,
  ingress/sync membership, bounded demotion, metrics and first-processing fence.
- `src/application/production-listener-factory.ts`: optional async metrics
  provider and heartbeat composition.
- `src/domain/transaction-ingestion.ts`: optional heartbeat object.
- `src/api/contracts.ts`, `src/storage/api-projection.repository.ts`: additive
  public API contract and projection.
- `frontend/src/data/api-schemas.ts`,
  `frontend/src/features/health/health-page.tsx`: rolling-compatible parsing and
  distinct health card.
- `scripts/lib/mainnet-observe-canary-verdict.ts`: independent bounded-admission
  gate.
- `docs/operations/block-hydration-canary.md`: activation and capture contract.

---

### Task 1: Freeze `workerAdmission.v1` test-first

**Files:**

- Create: `src/domain/worker-admission-metrics.ts`
- Create: `tests/worker-admission-metrics.test.ts`
- Modify: `src/domain/worker-admission.ts`
- Modify: `tests/worker-admission.test.ts`

- [ ] **Step 1: Write RED tests for the exact immutable aggregate**

Define a valid frozen fixture with exactly:

```ts
Object.freeze({
  version: 1,
  enabled: true,
  trackingWindowSeconds: 45,
  claimableBacklogCount: 8,
  classificationPendingCount: 2,
  oldestClassificationPendingAgeMs: 4_999,
  freshMintCount: 3,
  extendedMintCount: 2,
  demotedCount: 5,
})
```

Assert that `snapshotRuntimeWorkerAdmissionMetrics` returns a detached frozen
object. Reject missing/extra keys, proxies, accessors, non-frozen input,
negative zero, fractions, unsafe integers, invalid windows, a null oldest age
with positive pending count, and a non-null oldest age with zero pending count.
Assert disabled evidence requires pending/age/fresh/extended/demoted to be zero
but permits the legacy `claimableBacklogCount`.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test --test-concurrency=1 tests/worker-admission-metrics.test.ts
```

Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement the minimal domain contract**

Export:

```ts
export interface RuntimeWorkerAdmissionMetricsV1 {
  readonly version: 1;
  readonly enabled: boolean;
  readonly trackingWindowSeconds: number;
  readonly claimableBacklogCount: number;
  readonly classificationPendingCount: number;
  readonly oldestClassificationPendingAgeMs: number | null;
  readonly freshMintCount: number;
  readonly extendedMintCount: number;
  readonly demotedCount: number;
}

export function snapshotRuntimeWorkerAdmissionMetrics(
  value: unknown,
): RuntimeWorkerAdmissionMetricsV1;
```

Use own data descriptors, `isProxy`, exact keys, safe non-negative integers,
the existing `1..3600` window constants and a detached frozen return value. Add
`MAX_WORKER_ADMISSION_DEMOTIONS_PER_CLAIM = 256` to
`src/domain/worker-admission.ts` and test its exact positive safe-integer value.

- [ ] **Step 4: Run GREEN and static checks**

```bash
npx tsx --test --test-concurrency=1 \
  tests/worker-admission.test.ts tests/worker-admission-metrics.test.ts
npm run check:backend
npm run lint:backend
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit**

```bash
git add src/domain/worker-admission.ts \
  src/domain/worker-admission-metrics.ts \
  tests/worker-admission.test.ts tests/worker-admission-metrics.test.ts
git commit -m "feat(capacity): define worker admission metrics"
```

### Task 2: Add migration 056 and prove its exact indexes

**Files:**

- Create: `migrations/056_transaction_inbox_bounded_tracking.sql`
- Create: `tests/transaction-inbox-bounded-tracking-migration.test.ts`
- Modify: `src/execution-migrations/live-catalog.ts`
- Modify: `scripts/deployment-smoke.mjs`
- Modify: `scripts/provision-executor-roles.sql`
- Modify: `tests/listener-database-authority.test.ts`
- Modify: `tests/executor-roles-provisioning.test.ts`
- Modify: `tests/execution-live-orchestration-migration.test.ts`
- Modify: `tests/executor-live-main.integration.test.ts`
- Modify startup/migration fixture lists returned by:
  `rg -l "055_creation_entry_single_active_session" tests src scripts`

- [ ] **Step 1: Write RED source-contract tests**

Require migration head `056_transaction_inbox_bounded_tracking.sql`, forbid
data-changing statements, float types, secrets and submission terms, and assert
these exact logical definitions:

```sql
trading_candidates_worker_tracking_expiry_idx
  ON trading_candidates (eligible_until, mint)
  WHERE superseded_at IS NULL AND state='ELIGIBLE'
    AND confirmation_status<>'orphaned'

execution_intents_worker_tracking_mint_idx
  ON execution_intents (mint)
  WHERE terminal_at IS NULL

execution_live_positions_worker_tracking_mint_idx
  ON execution_live_positions (mint)
  WHERE state IN ('OPEN','EXIT_PENDING','UNKNOWN')
```

Also require a `security_barrier` view whose only column is `mint`, whose rows
are the active live-position predicate above, and whose name is fixed as
`listener_worker_tracking_live_mints`.

- [ ] **Step 2: Write RED PostgreSQL tests**

Against a task-owned PostgreSQL 16 schema, cover empty install, upgrade through
055, immediate replay, second migration-run no-op, stable index OIDs on direct
SQL replay, exact `pg_get_indexdef`, and named-object drift for each index
(wrong table, key, predicate, uniqueness, invalid/not-ready state). Add
100,000-row `EXPLAIN (FORMAT JSON)` fixtures proving candidate-expiry and active
intent/live membership predicates select the intended partial indexes. Assert
the view exposes no wallet, generation, armament, amount, deadline or state
column and rejects direct drift in definition/options.

- [ ] **Step 3: Run RED**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/transaction-inbox-bounded-tracking-migration.test.ts
```

Expected: missing migration failure.

- [ ] **Step 4: Implement migration 056**

Follow migration 053’s preflight/install/validate pattern. Lock only the three
affected tables while inspecting named objects. On first install create the
three ordinary partial btree indexes and the exact definer-owned
`security_barrier` active-mint view; on replay verify relation ownership,
access method, key count/order, predicate, validity/readiness/liveness and
non-unique/non-primary/non-exclusion properties plus view columns/definition.
Revoke `PUBLIC` and update provisioning to grant listener SELECT on the view,
never the base live table. Raise SQLSTATE `23514` for partial or incompatible
drift. Do not use `IF NOT EXISTS` as the only drift guard and do not edit
migrations 001–055.

- [ ] **Step 5: Update canonical migration catalogs**

Append migration 056 to `scripts/deployment-smoke.mjs`, all explicit test
fixtures and `src/execution-migrations/live-catalog.ts`. Compute its catalog
digest only after the SQL is final:

```bash
shasum -a 256 migrations/056_transaction_inbox_bounded_tracking.sql
```

- [ ] **Step 6: Run GREEN**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/transaction-inbox-bounded-tracking-migration.test.ts \
  tests/execution-live-orchestration-migration.test.ts \
  tests/executor-live-startup.test.ts tests/executor-live-recovery-startup.test.ts \
  tests/listener-database-authority.test.ts tests/executor-roles-provisioning.test.ts
npm run check:backend
npm run lint:backend
```

Expected: zero failures and zero unexplained PostgreSQL skips.

- [ ] **Step 7: Commit**

```bash
git add migrations/056_transaction_inbox_bounded_tracking.sql \
  tests/transaction-inbox-bounded-tracking-migration.test.ts \
  src/execution-migrations/live-catalog.ts scripts/deployment-smoke.mjs \
  scripts/provision-executor-roles.sql tests
git commit -m "feat(storage): index bounded tracking authority"
```

### Task 3: Replace enabled membership with one multi-table authority

**Files:**

- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `tests/deferred-retention.integration.test.ts`
- Create: `src/storage/worker-tracking-mint-lock.ts`
- Modify: `src/storage/launchpad-event.repository.ts`
- Modify: `src/storage/paper-decision.repository.ts`
- Modify: `src/storage/paper-trading.repository.ts`
- Modify: `src/storage/execution-intent.repository.ts`
- Modify: `src/storage/execution-live.repository.ts`
- Modify: `src/storage/execution-dry-run.repository.ts`
- Modify: `src/storage/execution-intent-expiration.ts`
- Modify: `src/storage/execution-operations.repository.ts`
- Modify: `src/storage/execution-risk.repository.ts`
- Modify: `src/storage/execution-simulation.repository.ts`
- Create: `tests/worker-tracking-mint-lock-architecture.test.ts`
- Modify: `tests/launchpad-event.repository.test.ts`
- Modify: `tests/paper-decision.repository.test.ts`
- Modify: `tests/paper-trading.repository.test.ts`
- Modify: `tests/execution-intent.repository.test.ts`
- Modify: `tests/execution-live.repository.test.ts`
- Modify: `tests/execution-dry-run.repository.test.ts`
- Modify: `tests/execution-operations.repository.test.ts`
- Modify: `tests/execution-risk.repository.test.ts`
- Modify: `tests/execution-simulation.repository.test.ts`

- [ ] **Step 1: Add RED database-clock boundary tests**

Freeze the database clock inside a transaction and create one canonical
`TokenLaunchDetected` event plus `token_launches` projection. Assert the mint is
tracked at `detected_at + 44.999 seconds` and not tracked at exactly
`detected_at + 45.000 seconds`. Deliberately pass conflicting JavaScript times
to prove they do not decide authority. Orphan the canonical domain event and
prove freshness disappears immediately.

Assert the existing V1 origin explicitly: `detected_at` equals blockchain time
when present and observed time only when blockchain time is null. A late
catch-up launch whose blockchain time is already 45 seconds old is expired; do
not reset its opportunity window.

- [ ] **Step 2: Add RED proof-family tests**

After launch expiry, create each proof independently and assert enabled
`enqueue`, `recordCatchUpClassification` and `syncTrackedMint` classify the
same mint as tracked:

```text
current non-orphaned ELIGIBLE candidate with eligible_until > db_time
active paper session in each of the five operational states
PAPER_HOLDING paper position
each non-terminal execution-intent status
OPEN / EXIT_PENDING / UNKNOWN live position
```

For negative cases, test superseded/expired/orphaned candidates, every terminal
paper/session/intent/live state, candidate boundary equality and
`MANUAL_REVIEW` without a holding. Then attach a `PAPER_HOLDING` position to the
manual-review session and prove that independent proof restores authority.

- [ ] **Step 3: Add RED union and ingress compatibility tests**

Prove multiple simultaneous proof rows grant one authority result; CREATE and
CREATE-plus-initial-BUY remain immediately admitted; ambiguous notifications
remain `PENDING/NORMAL/NULL`; tracked and untracked trades keep the Part B
table. Cover WebSocket-first/catch-up-first, replay and restart.

- [ ] **Step 4: Implement the shared enabled SQL authority**

Add one private SQL fragment/helper used only inside repository transactions.
Its CTE shape must be equivalent to:

```sql
database_clock AS MATERIALIZED (...),
fresh_launch AS MATERIALIZED (... canonical non-orphaned event ...),
extended_mint AS MATERIALIZED (
  SELECT mint FROM trading_candidates ...
  UNION SELECT mint FROM paper_strategy_sessions ...
  UNION SELECT mint FROM paper_positions WHERE status='PAPER_HOLDING'
  UNION SELECT mint FROM execution_intents ...
  UNION SELECT mint FROM listener_worker_tracking_live_mints
)
SELECT EXISTS(SELECT FROM fresh_launch)
    OR EXISTS(SELECT FROM extended_mint) AS active
```

Use `IS NOT DISTINCT FROM` for nullable inner-instruction identity. Preserve
the current advisory-lock order (mint, signature, row), immutable admission,
terminal-classification conflicts and exact disabled SQL branches.

Add `lockWorkerTrackingMints(client, mints)` in the new shared helper. It
validates canonical mints, deduplicates, sorts lexically and acquires
`pg_advisory_xact_lock(hashtextextended('transaction-inbox-mint:' || mint,0))`
in that order. Call it before any proof-row lock/mutation in launch, candidate,
paper session/position, execution-intent and live-position write transactions.
This includes dry-run, expiration, operations, risk, simulation and live
repositories that transition `execution_intents`; obtain the mint without a
row lock, acquire the mint lock, then re-read/revalidate the intent before its
existing mutation. Retention deletes need no lock because their predicates
require an already terminal/non-authoritative row. The architecture test must
enumerate every production TypeScript file containing an INSERT/UPDATE of the
five proof tables and fail if it is not covered by the shared protocol.
Repository tests must prove no producer locks or mutates its proof row before
the advisory-lock statement and that the listener role can query the view but
not `execution_live_positions`.

- [ ] **Step 5: Run GREEN**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/transaction-inbox.repository.test.ts \
  tests/deferred-retention.integration.test.ts \
  tests/observed-transaction-pipeline.test.ts \
  tests/worker-tracking-mint-lock-architecture.test.ts \
  tests/launchpad-event.repository.test.ts \
  tests/paper-decision.repository.test.ts \
  tests/paper-trading.repository.test.ts \
  tests/execution-intent.repository.test.ts \
  tests/execution-live.repository.test.ts \
  tests/execution-dry-run.repository.test.ts \
  tests/execution-operations.repository.test.ts \
  tests/execution-risk.repository.test.ts \
  tests/execution-simulation.repository.test.ts
npm run check:backend
npm run lint:backend
```

Expected: all enabled authority cases and every pre-existing OFF case pass.

- [ ] **Step 6: Commit**

```bash
git add src/storage/transaction-inbox.repository.ts \
  src/storage/worker-tracking-mint-lock.ts \
  src/storage/launchpad-event.repository.ts \
  src/storage/paper-decision.repository.ts \
  src/storage/paper-trading.repository.ts \
  src/storage/execution-intent.repository.ts \
  src/storage/execution-live.repository.ts \
  src/storage/execution-dry-run.repository.ts \
  src/storage/execution-intent-expiration.ts \
  src/storage/execution-operations.repository.ts \
  src/storage/execution-risk.repository.ts \
  src/storage/execution-simulation.repository.ts \
  tests/transaction-inbox.repository.test.ts \
  tests/deferred-retention.integration.test.ts \
  tests/worker-tracking-mint-lock-architecture.test.ts tests
git commit -m "feat(storage): bound Pump.fun tracking authority"
```

### Task 4: Demote expired pristine trades before enabled claims

**Files:**

- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `tests/transaction-ingestion-recovery.test.ts`

- [ ] **Step 1: Write RED batch/order/concurrency tests**

Insert 257 expired pristine admitted tracked trades in reverse order. Assert
one claim transaction demotes exactly 256 ordered by
`observed_at, observed_slot, signature`, a later poll demotes the last row, and
fairness counters change only if a row is actually claimed. Use two real
connections: lock the oldest eligible row in one transaction, run claim in the
other, and prove `SKIP LOCKED` progresses without waiting or double-demoting.

Add a producer/demotion race for each proof family. Hold the shared mint lock,
start both operations, then release in each order. Prove a proof committed
before the demotion lock blocks demotion, while a producer ordered after it is
linearized later. Prove multi-mint locks are lexical and cannot deadlock.

- [ ] **Step 2: Write RED pristine-fence matrix**

Starting from one valid pristine row, independently set each protected field:
attempt counters, lease, snapshot, fingerprint, error/retry/exhaustion,
`processed_at`, finality polls/provider/version, manual recovery,
`first_processed_at`, `first_processing_evidence_unavailable=TRUE`, decoder
quarantine and decoder recovery. Assert no case is demoted. Assert fresh or
extended mint authority also blocks demotion.

- [ ] **Step 3: Write RED terminal/idempotence tests**

For a demoted row assert admission and first detection remain unchanged,
priority becomes `NORMAL`, status becomes `DEFERRED`, terminal time is the one
materialized database clock, purge is exactly four hours later, and replay plus
repository restart are no-ops. Assert an unadmitted untracked deferred row is
not counted as a demotion.

- [ ] **Step 4: Implement the bounded CTE update**

In enabled `claim()`, after exhaustion reconciliation and before scheduler
selection, snapshot at most 256 candidate mints, acquire their shared advisory
locks in lexical order, then read exactly one millisecond-truncated PostgreSQL
clock. Pass that post-lock time to the reselected ordered candidate set,
business-authority revalidation, demotion update and tracked selection. Before
the limit, order temporal proof mints by their maximum structural expiry and
put proofless mints first; do not read another clock for this preview. Limit with
`MAX_WORKER_ADMISSION_DEMOTIONS_PER_CLAIM`, lock inbox candidates using
`FOR UPDATE OF inbox SKIP LOCKED`, repeat the pristine predicate including the
unavailable bit in the UPDATE, and preserve `worker_admitted_at`. Reuse
migration 053's admitted-claim index; add no inbox index.

Do not run the statement at all in OFF mode. Do not change the three claim
queries, scheduler ratios, lease calculation or RPC work gate.

- [ ] **Step 5: Run GREEN**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/transaction-inbox.repository.test.ts \
  tests/transaction-ingestion-recovery.test.ts
npm run check:backend
npm run lint:backend
```

- [ ] **Step 6: Commit**

```bash
git add src/storage/transaction-inbox.repository.ts \
  tests/transaction-inbox.repository.test.ts \
  tests/transaction-ingestion-recovery.test.ts
git commit -m "feat(storage): demote expired pristine Pump.fun trades"
```

### Task 5: Publish heartbeat metrics and preserve first-processing truth

**Files:**

- Modify: `src/domain/transaction-ingestion.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/transaction-ingestion-contracts.test.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Test (regression): `tests/first-processing-canary.test.ts`

- [ ] **Step 1: Write RED aggregate-query tests**

Populate overlapping fresh/business proofs and exact demoted rows. Assert one
repository sample returns union-distinct `freshMintCount` and
`extendedMintCount`, exact admitted claimable backlog, pending count/oldest
integer age, and only retained admitted demotions. Prove the zero/null relation
for no pending classifications and disabled zero semantics.

- [ ] **Step 2: Write RED heartbeat contract tests**

Add optional `RuntimeHeartbeat.workerAdmission`. Test omission for historical
heartbeats, exact frozen V1 acceptance, malicious/malformed rejection before
I/O, detached JSON persistence for RUNNING and STOPPED, and callback failure
causing the existing heartbeat write to fail closed.

- [ ] **Step 3: Write RED first-processing tests**

In ON mode, put an unclassified `worker_admitted_at IS NULL` row inside the
cohort and assert it is excluded. Classify/admit it and assert it becomes
eligible without changing `first_detected_at`. Demote an admitted overdue row
and assert it is excluded from the cohort. Repeat with policy omitted
and explicit false, asserting byte-equivalent legacy cohort results.

- [ ] **Step 4: Implement metrics and heartbeat wiring**

Add `workerAdmissionMetrics()` to the concrete repository. Sample one
millisecond PostgreSQL clock and return only the V1 aggregate. Add an optional
async `workerAdmissionMetrics` callback to `ListenerHeartbeatOptions`; the
production factory supplies `() => inbox.workerAdmissionMetrics()` and the
policy identity. Snapshot the callback result before persistence. Do not add it
to the generic inbox port if that would force unrelated test doubles to own a
production-only diagnostic.

Add ON-only cohort fences requiring non-null admission and excluding the exact
retained demotion shape; retain the existing SQL string/path unchanged in OFF.

- [ ] **Step 5: Run GREEN**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/worker-admission-metrics.test.ts \
  tests/transaction-ingestion-contracts.test.ts \
  tests/transaction-inbox.repository.test.ts \
  tests/production-listener-factory.test.ts \
  tests/first-processing-canary.test.ts
npm run check:backend
npm run lint:backend
```

- [ ] **Step 6: Commit**

```bash
git add src/domain/transaction-ingestion.ts \
  src/storage/transaction-inbox.repository.ts \
  src/application/production-listener-factory.ts tests
git commit -m "feat(listener): report bounded admission health"
```

### Task 6: Extend API and frontend rolling-compatibly

**Files:**

- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `frontend/src/data/api-schemas.ts`
- Modify: `frontend/src/data/api-schemas.test.ts`
- Modify: `frontend/tests/fixtures/api.ts`
- Modify: `frontend/src/features/health/health-page.tsx`
- Modify: `frontend/src/features/health/health-page.test.tsx`

- [ ] **Step 1: Write RED backend projection tests**

Add `ApiWorkerAdmissionMetricsV1` with the exact domain scalar fields and an
optional `ApiHeartbeat.workerAdmission`. Test valid projection, omitted legacy
payload to API `null`, malformed present payload rejection, no identifying
keys, integer bounds and detached/frozen output.

- [ ] **Step 2: Write RED frontend schema tests**

Extend the health fixture with one V1 object. Assert valid parsing, older API
omission to `undefined`, historical API null, exact zero/null relation, unknown
additive outer health fields accepted, and malformed/extra worker-admission
fields rejected.

- [ ] **Step 3: Write RED health-page tests**

Require a separate “Admission worker Pump.fun” card showing enabled/window,
claimable backlog, pending count/oldest age, fresh/extended mints and demotions.
Assert omitted renders “Non disponible — backend antérieur”, null renders
“Non disponible — heartbeat antérieur ou invalide”, and neither state is
labelled ready for execution.

- [ ] **Step 4: Implement minimal additive contracts and card**

Reuse the backend domain snapshotter when decoding persisted payload. In Zod,
make only the outer heartbeat property `.nullish()`; keep the V1 object strict.
Render integer values directly and render null oldest age as “Aucune”. Do not
alter API version, routes or `catchUpAdmission`.

- [ ] **Step 5: Run GREEN**

```bash
npx tsx --test --test-concurrency=1 \
  tests/api-contracts.test.ts tests/api-projection.repository.test.ts
npm test --workspace frontend -- --run
npm run check
npm run lint
```

Expected: backend and frontend pass with rolling compatibility.

- [ ] **Step 6: Commit**

```bash
git add src/api/contracts.ts src/storage/api-projection.repository.ts \
  tests/api-contracts.test.ts tests/api-projection.repository.test.ts \
  frontend/src/data/api-schemas.ts frontend/src/data/api-schemas.test.ts \
  frontend/tests/fixtures/api.ts \
  frontend/src/features/health/health-page.tsx \
  frontend/src/features/health/health-page.test.tsx
git commit -m "feat(api): expose worker admission diagnostics"
```

### Task 7: Add the fail-closed canary gate and safe activation runbook

**Files:**

- Modify: `scripts/lib/mainnet-observe-canary-verdict.ts`
- Modify: `tests/mainnet-observe-canary-verdict.test.ts`
- Modify: `tests/fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json` only to
  preserve its explicit historical contract expectation.
- Modify: `docs/operations/block-hydration-canary.md`
- Modify: `README.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/system-overview.html`
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Write RED evaluator tests**

Add `workerAdmission` to each snapshot and STOPPED heartbeat in a new passing
fixture builder. Add `workerAdmission` to the gate-name union and assert:

```text
missing/malformed/disabled evidence -> INCONCLUSIVE
oldest pending age = 44,999 ms -> eligible for PASS
oldest pending age = 45,000 ms -> FAIL
classification pending grows after T+5 -> FAIL
claimable backlog grows after T+5 -> FAIL
STOPPED claimable count != postStopActionableCount -> INCONCLUSIVE
coherent non-growing evidence -> PASS
```

Keep the historical `32c9bf4` fixture evaluable; absent new evidence must never
upgrade its overall FAIL. Reject signatures, mints, wallet fields and arbitrary
labels in the new object.

- [ ] **Step 2: Implement the independent gate**

Parse the exact V1 aggregate with the domain snapshotter. Require enabled=true,
window=45, coherent zero/null age semantics, chronological heartbeat samples,
non-growing classification debt and claimable backlog from T+5 through final,
and STOPPED/post-stop count agreement. Preserve overall precedence and every
existing gate implementation.

- [ ] **Step 3: Write RED runbook/deployment assertions**

Require examples/Compose to remain false, activation only after #177 merge and
green post-merge CI, T0/T+5/T+15/final/STOPPED capture, exact 45-second boundary,
all independent canary gates, rollback-to-OFF instructions, and explicit bans
on wallet, signer, executor, submission and trade authority.

- [ ] **Step 4: Update operator and architecture documentation**

Document the five authority proofs, `MANUAL_REVIEW` exception, migration 056,
bounded demotion, distinct metrics, first-processing fence and observe-only
canary acceptance. In `docs/system-overview.html`, replace the future #177 text
with delivered-but-disabled status and keep Bootstrap diagnostics explanatory.

- [ ] **Step 5: Run GREEN**

```bash
npx tsx --test --test-concurrency=1 \
  tests/mainnet-observe-canary-verdict.test.ts \
  tests/mainnet-observe-canary-cli.test.ts \
  tests/deployment-artifacts.test.ts
npm run docs:check
npm run check
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/mainnet-observe-canary-verdict.ts \
  tests/mainnet-observe-canary-verdict.test.ts \
  tests/fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json \
  docs/operations/block-hydration-canary.md README.md \
  docs/architecture/pumpfun-v1.md docs/system-overview.html \
  tests/deployment-artifacts.test.ts
git commit -m "docs(capacity): define bounded admission canary"
```

### Task 8: Validate and deliver #177

**Files:**

- Modify only files required by confirmed review findings.

- [ ] **Step 1: Run focused PostgreSQL gates**

Start one task-owned PostgreSQL 16 container with a temporary data directory.
Run migration 056, repository, recovery, finality, first-processing, API
projection and concurrency suites with `--test-concurrency=1`. Record zero
unexplained skips, then stop the container and remove only its task-owned data.

- [ ] **Step 2: Run the complete repository gates**

```bash
npm run build
npm run check
npm run lint
npm run docs:check
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:backend
npm test --workspace frontend -- --run
npm run frontend:e2e
npm run deployment:smoke
npm run deployment:smoke:signal
git diff --check
```

Expected: all commands pass; backend PostgreSQL suite has no unexplained skip;
deployment examples still keep the flag false.

- [ ] **Step 3: Review cycle 1/2**

Review the whole diff for: exact OFF equivalence, one database clock per
authority transaction, 44.999/45.000 boundary, all five proof families,
`MANUAL_REVIEW`, batch/order/SKIP LOCKED, pristine fences, migration drift,
first-processing truth, rolling compatibility, canary independence and
prohibited wallet/RPC/executor scope. Correct confirmed findings test-first.

- [ ] **Step 4: GitHub review cycle 2/2 and merge**

Push one branch and create one PR closing #177 and referencing #171. State that
the flag remains false and the post-merge canary is mandatory. Request one
GitHub review. Address blocking threads, push fixes, wait for green CI and
resolve threads without requesting a third review.

- [ ] **Step 5: Verify post-merge before activation**

Merge only at a clean reviewed SHA. Fetch main and wait for post-merge CI. Do
not enable the flag during the PR. After green post-merge CI, follow the
observe-only runbook as a separate operational step; a chat “go” is not wallet
or transaction authorization.

## Required non-regression evidence

- migrations 001–055 are byte-identical;
- OFF path has no new SQL membership/demotion/first-processing behavior;
- worker count, RPC concurrency, block cache and catch-up scheduler unchanged;
- no file under wallet, signer, transaction preparation or submission changes;
- execution-intent/live repository changes are restricted to the shared mint
  advisory lock before tracking-proof mutation and reveal no live payload;
- `EXECUTION_MODE=observe` requires no private key;
- duplicate, orphaned, finalized, retry, quarantine and four-hour retention
  behavior remains covered;
- no Mainnet run or real transaction occurs in this implementation PR.
