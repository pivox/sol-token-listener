# First-Processing Canary Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the first successful inbox processing time once and expose a bounded, redacted 15-minute canary cohort with an exact integer p95 and fail-closed verdict.

**Architecture:** Migration 050 adds an immutable nullable timestamp to the durable transaction inbox. A repository aggregate selects at most 50,001 rows from the fixed process cohort, returns aggregate counts only, and a strict domain constructor derives the versioned evidence and verdict. The existing heartbeat persists that snapshot; API V1 and the diagnostic frontend project only its fixed fields.

**Tech Stack:** TypeScript strict ESM, PostgreSQL, Node test runner, Zod, React/Vitest, Bootstrap diagnostics.

---

### Task 1: Immutable first-processing timestamp

**Files:**
- Create: `migrations/050_transaction_inbox_first_processing.sql`
- Create: `tests/transaction-inbox-first-processing-migration.test.ts`
- Modify: `src/storage/transaction-inbox.repository.ts:839-915`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `src/execution-migrations/live-catalog.ts`
- Modify: `src/executor-live/startup-validator.ts`
- Modify: `src/executor-live-recovery/startup-validator.ts`
- Modify: migration-head assertions returned by `rg -l '049_transaction_inbox_catch_up_admission_receipt.sql' tests src`

- [ ] **Step 1: Write RED migration tests**

Create a PostgreSQL-backed test that applies migrations 001-049, inserts one
historical processed row, applies 050 twice, and asserts:

```ts
assert.equal(historical.first_processed_at, null);
await assert.rejects(
  pool.query("UPDATE chain_transaction_inbox SET first_processed_at=NOW() WHERE signature='historical'"),
  /first_processed_at.*immutable/iu,
);
```

Also test that every pre-migration row is marked unavailable with both new
timestamps `NULL`. A fresh post-migration insert must receive an immutable,
finite millisecond `first_detected_at` from PostgreSQL and transition exactly
once to a matching `first_processed_at`; replacement, clearing, infinite
timestamps, and a partially/incompatibly installed schema fail closed.

- [ ] **Step 2: Run RED tests**

Run:

```bash
tsx --test tests/transaction-inbox-first-processing-migration.test.ts
```

Expected: fail because migration 050 does not exist.

- [ ] **Step 3: Implement replay-safe migration 050**

Add nullable `first_detected_at TIMESTAMPTZ`, nullable
`first_processed_at TIMESTAMPTZ`, a non-null
`first_processing_evidence_unavailable` marker, and a `first_detected_at`
cohort index. During the first install, mark every preexisting row unavailable
without setting either timestamp; only afterward install the database-clock
default for future `first_detected_at` inserts. Add exact finite/millisecond
checks and a `BEFORE UPDATE ON chain_transaction_inbox` trigger that makes both
timestamps and the true unavailable marker immutable. The trigger must allow
the initial processing timestamp only during a
`PROCESSING -> PROCESSED` transition, when the marker is false and
the old lease is present, the new lease is cleared, and
`first_processed_at = processed_at`. During rolling deployment, the same
success transition from an older binary with no timestamp must atomically set
the unavailable marker. The marker is monotonic. Reject replacement or clearing with
SQLSTATE `23514` and the stable message
`chain_transaction_inbox.first_processed_at is immutable`. Preflight must
verify exact existing columns, defaults, constraints, index, function, and trigger
definitions before treating a replay as successful.

- [ ] **Step 4: Write RED repository lifecycle tests**

Add tests proving the first `markProcessed` writes the same database completion
instant to `processed_at` and `first_processed_at`; lease loss writes neither;
and subsequent retry, replay, finalized/orphaned revision, and manual recovery
never change `first_processed_at`, even when `processed_at` is cleared or
replaced. Add both historical processed and historical reopened rows; replay
them and assert their timestamps remain `NULL` and unavailable markers remain
true. Simulate an older binary after migration and assert its success transition
is marked unavailable by the all-update trigger.

- [ ] **Step 5: Implement the atomic write**

Change the completion CTE to one millisecond database timestamp and extend the
existing update only:

```sql
WITH completed AS MATERIALIZED (
  SELECT date_trunc('milliseconds', clock_timestamp()) AS completed_at
)
UPDATE chain_transaction_inbox SET
  first_processed_at = CASE
    WHEN first_processing_evidence_unavailable THEN NULL
    ELSE COALESCE(first_processed_at, completed.completed_at)
  END,
  processed_at = completed.completed_at
```

Do not mention `first_processed_at` in retry, replay, finality, orphan, or
manual-recovery updates.

- [ ] **Step 6: Advance the canonical migration head**

Append migration 050 and its computed SHA-256 to
`LIVE_EXECUTION_MIGRATION_CATALOG`; replace only assertions that refer to the
current migration head with `050_transaction_inbox_first_processing.sql`.
Preserve tests that intentionally assert historical migration boundaries.

- [ ] **Step 7: Verify and commit**

Run:

```bash
tsx --test tests/transaction-inbox-first-processing-migration.test.ts tests/transaction-inbox.repository.test.ts
npm run check:backend
npm run lint:backend -- --no-warn-ignored migrations/050_transaction_inbox_first_processing.sql src/storage/transaction-inbox.repository.ts tests/transaction-inbox-first-processing-migration.test.ts tests/transaction-inbox.repository.test.ts
git diff --check
```

Expected: all executable tests and checks pass; database tests skip only when
`TEST_DATABASE_URL` is intentionally absent.

Commit:

```bash
git add migrations/050_transaction_inbox_first_processing.sql src/storage/transaction-inbox.repository.ts src/execution-migrations/live-catalog.ts src/executor-live/startup-validator.ts src/executor-live-recovery/startup-validator.ts tests
git commit -m "feat(listener): persist immutable first processing time"
```

### Task 2: Bounded aggregate and strict domain evidence

**Files:**
- Create: `src/domain/first-processing-canary.ts`
- Create: `tests/first-processing-canary.test.ts`
- Modify: `src/domain/transaction-ingestion.ts`
- Modify: `src/ports/transaction-inbox-repository.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`

- [ ] **Step 1: Write RED domain tests**

Define cases for one sample, nearest-rank small samples, exact 44,999/45,000
ms buckets, open cohort, zero samples, overflow, right-censored, tail-censored,
terminal, unavailable, and invalid counts. Assert fixed constants and verdicts:

```ts
assert.equal(FIRST_PROCESSING_THRESHOLD_MS, 45_000);
assert.equal(FIRST_PROCESSING_COHORT_DURATION_MS, 900_000);
assert.equal(FIRST_PROCESSING_COHORT_CAPACITY, 50_000);
assert.equal(evidence.verdict, 'PASS');
assert.equal(evidence.p95Ms, 44_999);
```

Add hostile-object, unsafe integer, extra-key, inconsistent-total, invalid time
ordering, impossible nullable-p95, and impossible-verdict rejection cases.

- [ ] **Step 2: Run the domain test and observe RED**

Run:

```bash
tsx --test tests/first-processing-canary.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the immutable evidence constructor**

Export the three constants, `FirstProcessingCanaryAggregate`,
`RuntimeFirstProcessingCanaryEvidenceV1`, and
`createFirstProcessingCanaryEvidence(aggregate)`. Freeze the aggregate and
derive verdict with this precedence:

```ts
const fail = invalidDurationCount > 0
  || (p95Ms !== null && p95Ms >= FIRST_PROCESSING_THRESHOLD_MS);
const incomplete = sampledAtMs < cohortEndsAtMs + FIRST_PROCESSING_THRESHOLD_MS
  || eligibleCount === 0 || overflowed || pendingCount > 0
  || terminalCount > 0 || unavailableCount > 0;
const verdict = fail ? 'FAIL' : incomplete ? 'INCONCLUSIVE' : 'PASS';
```

Require `pendingCount === rightCensoredCount + tailCensoredCount`,
`completedCount === underThresholdCount + atOrAboveThresholdCount`, and
`eligibleCount === completedCount + pendingCount + terminalCount +
unavailableCount + invalidDurationCount`.

- [ ] **Step 4: Write RED repository aggregate tests**

Using a fresh migrated schema, insert rows immediately before, inside, and at
the half-open cohort boundaries. Cover all disjoint statuses and durations,
including exact 44,999/45,000 ms, historical processed `NULL`, terminal rows,
50,001 deterministic rows, and a one-row sample. Assert the method returns no
signature, mint, program ID, or arbitrary label.

- [ ] **Step 5: Implement one-row PostgreSQL aggregation**

Add to `TransactionInboxRepository`:

```ts
beginFirstProcessingCanary(): Promise<number>;
firstProcessingCanary(
  cohortStartedAtMs: number,
): Promise<RuntimeFirstProcessingCanaryEvidenceV1>;
```

`beginFirstProcessingCanary` returns
`date_trunc('milliseconds', clock_timestamp())` as a safe epoch millisecond.
The SQL must use a materialized ordered CTE with `LIMIT 50001`, use the
50,001st row only as an overflow probe, aggregate only the first 50,000 rows,
capture one millisecond `sampledAtMs` from PostgreSQL, compute integer
milliseconds and
`percentile_disc(0.95)`, classify mutually exclusive states, and set overflow
from the probe row. Include only:

```sql
first_detected_at >= $1
AND first_detected_at < LEAST(sampled_at, $1 + INTERVAL '15 minutes')
```

Parse PostgreSQL `BIGINT` values through safe-count helpers, then call the
strict domain constructor. Never return selected row identifiers.

- [ ] **Step 6: Verify and commit**

Run:

```bash
tsx --test tests/first-processing-canary.test.ts tests/transaction-inbox.repository.test.ts
npm run check:backend
npm run lint:backend -- --no-warn-ignored src/domain/first-processing-canary.ts src/domain/transaction-ingestion.ts src/ports/transaction-inbox-repository.ts src/storage/transaction-inbox.repository.ts tests/first-processing-canary.test.ts tests/transaction-inbox.repository.test.ts
git diff --check
```

Expected: all pass or database-only cases explicitly skip without a test URL.

Commit:

```bash
git add src/domain/first-processing-canary.ts src/domain/transaction-ingestion.ts src/ports/transaction-inbox-repository.ts src/storage/transaction-inbox.repository.ts tests/first-processing-canary.test.ts tests/transaction-inbox.repository.test.ts
git commit -m "feat(listener): aggregate first processing canary evidence"
```

### Task 3: Heartbeat wiring and durable snapshot

**Files:**
- Modify: `src/domain/transaction-ingestion.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-ingestion-contracts.test.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`

- [ ] **Step 1: Write RED heartbeat tests**

Extend runtime contract tests with optional legacy absence, a valid frozen
snapshot, accessor/proxy/extra-field rejection, and inconsistent verdict
rejection. Extend heartbeat tests to assert startup calls
`beginFirstProcessingCanary()` once and both `RUNNING` and final `STOPPED`
writes call `firstProcessingCanary(cohortStartedAtMs)` and persist a detached
`firstProcessingCanary` object.

- [ ] **Step 2: Run focused tests and observe RED**

Run:

```bash
tsx --test tests/transaction-ingestion-contracts.test.ts tests/production-listener-factory.test.ts tests/transaction-inbox.repository.test.ts
```

Expected: new field and repository-call assertions fail.

- [ ] **Step 3: Wire the aggregate into every heartbeat**

Add optional `firstProcessingCanary` to `RuntimeHeartbeat`. In
`PersistentListenerHeartbeat.start`, initialize one database-clock cohort start
before the first heartbeat. In `write`, obtain counts, slots, and
`inbox.firstProcessingCanary(this.firstProcessingCohortStartedAtMs)`. The
aggregate query owns its database-clock `sampledAtMs`; the ordinary heartbeat
keeps its existing process-clock `updatedAtMs`. Preserve the stopped path's
rule that it performs no new RPC slot reads.

Validate and detach the evidence before adding this payload property:

```ts
firstProcessingCanary: createFirstProcessingCanaryEvidence(
  value.firstProcessingCanary,
)
```

Legacy heartbeats may omit the property. Production writes must include it;
malformed evidence fails closed without logging its contents.

- [ ] **Step 4: Verify and commit**

Run:

```bash
tsx --test tests/transaction-ingestion-contracts.test.ts tests/production-listener-factory.test.ts tests/transaction-inbox.repository.test.ts
npm run check:backend
npm run lint:backend -- --no-warn-ignored src/domain/transaction-ingestion.ts src/application/production-listener-factory.ts src/storage/transaction-inbox.repository.ts tests/transaction-ingestion-contracts.test.ts tests/production-listener-factory.test.ts tests/transaction-inbox.repository.test.ts
git diff --check
```

Expected: all pass.

Commit:

```bash
git add src/domain/transaction-ingestion.ts src/application/production-listener-factory.ts src/storage/transaction-inbox.repository.ts tests/transaction-ingestion-contracts.test.ts tests/production-listener-factory.test.ts tests/transaction-inbox.repository.test.ts
git commit -m "feat(listener): publish first processing heartbeat evidence"
```

### Task 4: API V1 and diagnostic frontend

**Files:**
- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `frontend/src/data/api-schemas.ts`
- Modify: `frontend/src/data/api-schemas.test.ts`
- Modify: `frontend/src/features/health/health-page.tsx`
- Modify: `frontend/src/features/health/health-page.test.tsx`
- Modify: `frontend/tests/fixtures/api.ts`

- [ ] **Step 1: Write RED API projection tests**

Add cases proving a valid fixed snapshot is deeply frozen and projected
unchanged, legacy/missing payload becomes `null`, and malformed/extra fields,
negative zero, unsafe integers, inconsistent counts, invalid p95/verdict, or
identifier fields such as `signature` and `mint` fail closed to degraded
health without leaking input.

- [ ] **Step 2: Implement the strict API projection**

Add `ApiFirstProcessingCanaryEvidenceV1` and optional/null
`heartbeat.firstProcessingCanary`. Parse it from the existing heartbeat JSON
with an exact field list and reuse the domain constructor or equivalent strict
scalar validation. Add `firstProcessingCanary: null` to empty/legacy heartbeat
builders. Do not add a database query or public endpoint.

- [ ] **Step 3: Write RED frontend schema and rendering tests**

Assert valid PASS/FAIL/INCONCLUSIVE evidence parses, legacy omission remains
`undefined`, explicit absence is `null`, hostile totals/fields are rejected,
and the page renders verdict, p95, bucket counts, overflow, and drain state
without rendering any signature or mint.

- [ ] **Step 4: Implement frontend contract and Bootstrap card**

Create a strict Zod schema mirroring every fixed version-1 invariant. Add a
`Premier traitement` health card with explicit unavailable states and these
core lines:

```tsx
<p>Verdict : <strong>{value.verdict}</strong></p>
<p>p95 : {value.p95Ms === null ? 'Indisponible' : `${value.p95Ms} ms`}</p>
<p>Sous 45 s : {value.underThresholdCount} ; à partir de 45 s : {value.atOrAboveThresholdCount}</p>
```

Derive drain completion only from `sampledAtMs >= cohortEndsAtMs + 45_000`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts
npm --prefix frontend test -- --run frontend/src/data/api-schemas.test.ts frontend/src/features/health/health-page.test.tsx
npm run check
npm run lint
git diff --check
```

Expected: backend and frontend checks pass.

Commit:

```bash
git add src/api/contracts.ts src/storage/api-projection.repository.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts frontend/src/data/api-schemas.ts frontend/src/data/api-schemas.test.ts frontend/src/features/health/health-page.tsx frontend/src/features/health/health-page.test.tsx frontend/tests/fixtures/api.ts
git commit -m "feat(api): expose first processing canary evidence"
```

### Task 5: Fail-closed operator runbook

**Files:**
- Modify: `docs/operations/block-hydration-canary.md`
- Modify: `tests/deployment-artifacts.test.ts`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/system-overview.html`

- [ ] **Step 1: Write RED documentation contract tests**

Require a fixed-field `jq` extraction for `firstProcessingCanary`, identical
`startedAt` and `cohortStartedAtMs`, a natural cohort close at T+15, an explicit
wait of at least 45 seconds before shutdown, final PostgreSQL extraction newer
than T+15, and verdict rules where censored/missing/overflowed evidence cannot
pass.

- [ ] **Step 2: Update the runbook and architecture status**

Document T0/T+5/T+15 capture, then:

```bash
sleep 45
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml \
  --project-name sol-token-listener stop --timeout 40 app
```

The text must explain that the fixed cohort closes at T+15 before the wait,
that no new cohort row is admitted during the drain, and that the final
`STOPPED` heartbeat comes from PostgreSQL. Add PASS/FAIL/INCONCLUSIVE examples
for exact 45 seconds, censored rows, empty traffic, overflow, restart, and
missing final evidence. State explicitly that this remains observe-only and
does not authorize a wallet or submission.

- [ ] **Step 3: Verify and commit**

Run:

```bash
tsx --test tests/deployment-artifacts.test.ts
npm run check:docs
git diff --check
```

Expected: all pass.

Commit:

```bash
git add docs/operations/block-hydration-canary.md docs/architecture/pumpfun-v1.md docs/system-overview.html tests/deployment-artifacts.test.ts
git commit -m "docs(operations): attest first processing canary latency"
```

### Task 6: Full verification and delivery

**Files:**
- Modify if required by generated checks: none expected

- [ ] **Step 1: Run the PostgreSQL migration suite in one task-scoped instance**

Start only the repository's task PostgreSQL service or one disposable instance,
export `TEST_DATABASE_URL`, run all migration and repository integration tests,
then stop and remove only that task-scoped instance immediately. Never touch
another project's containers.

Expected: migration 050 applies from empty and populated schemas, replays
cleanly, and all lifecycle tests pass.

- [ ] **Step 2: Run the complete quality gate**

Run:

```bash
npm run build
npm run check
npm run lint
npm test
git diff --check
git status --short
```

Expected: all commands pass and only intended tracked files are present.

- [ ] **Step 3: Audit security and behavior boundaries**

Run focused searches and confirm no result in the new evidence contract:

```bash
rg -n "signature|mint|private.?key|wallet|submit|sendTransaction" src/domain/first-processing-canary.ts docs/operations/block-hydration-canary.md
rg -n "first_processed_at\s*=" src migrations
```

Expected: the first search finds only explicit prohibitions in documentation;
the second finds migration/atomic `COALESCE` writes only. No signing,
submission, execution-mode, or wallet path changed.

- [ ] **Step 4: Commit any verification-only correction**

If verification required a real correction, rerun the affected gate and commit
only that correction. Otherwise create no empty commit.

- [ ] **Step 5: Push, open PR, and run at most two review cycles**

Push `feat/143-first-processing-canary-evidence`, open a PR linked to #143,
request Codex review, wait for CI, address blocking findings, and repeat no more
than once. Merge only with all required checks green and no unresolved blocking
thread. Then pull/fetch `main`, verify the merge commit and post-merge CI, close
#143 if GitHub did not close it automatically, and update the ignored local
tracking file without committing it.
