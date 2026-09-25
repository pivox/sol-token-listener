# Bounded Pump.fun Worker Admission Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `subagent-driven-development` or `executing-plans`; implement every task with
> test-driven development and keep the feature inactive.

**Goal:** Add the durable and configurable foundation required by #171 without
changing production claim behavior or enabling bounded admission.

**Architecture:** A dependency-free domain policy and strict environment parser
feed an inactive restart-only configuration. PostgreSQL migration 053 records a
monotone admission timestamp and prepares indexes. Legacy repository writes
materialize the historical admission evidence while existing claim SQL remains
untouched.

**Tech stack:** TypeScript strict ESM, Node.js `node:test`, PostgreSQL 16,
versioned SQL migrations, Docker Compose deployment contracts.

**Plan revision:** 1.0.0

---

### Task 1: Freeze the inactive domain and configuration contract

**Files:**

- Create: `src/domain/worker-admission.ts`
- Create: `tests/worker-admission.test.ts`
- Modify: `src/config/env.ts`
- Modify: `tests/config-safety.test.ts`

- [ ] **Step 1: Add RED domain tests**

Assert exact constants and a frozen V1 value with default window 45, minimum 1,
and maximum 3600. Assert invalid booleans and out-of-range/non-canonical window
values cannot construct a policy.

- [ ] **Step 2: Add RED configuration tests**

Cover absent values, explicit `false`, `true`, `0`, `3601`, `01`, `1.0`, `1e2`,
signed values, whitespace, and unsafe integers. The window must be parsed even
when disabled. `true` must fail with one stable message stating that activation
is not available until the admission/classification delivery.

- [ ] **Step 3: Run RED**

```bash
npx tsx --test --test-concurrency=1 \
  tests/worker-admission.test.ts tests/config-safety.test.ts
```

Expected: missing module/properties and configuration assertions fail.

- [ ] **Step 4: Implement the smallest domain and parser change**

Add immutable `listenerPumpFunBoundedWorkerAdmissionEnabled` and
`listenerPumpFunTrackingWindowSeconds` properties to `AppConfig`. Reuse the
strict boolean and canonical bounded-integer helpers. Construct the domain
value once and reject enabled mode before any listener composition.

- [ ] **Step 5: Run GREEN and static checks**

```bash
npx tsx --test --test-concurrency=1 \
  tests/worker-admission.test.ts tests/config-safety.test.ts
npm run check:backend
npm run lint:backend
```

- [ ] **Step 6: Commit**

```bash
git add src/domain/worker-admission.ts src/config/env.ts \
  tests/worker-admission.test.ts tests/config-safety.test.ts
git commit -m "feat(capacity): add inactive worker admission policy"
```

### Task 2: Add migration 053 with exact replay and drift protection

**Files:**

- Create: `migrations/053_transaction_inbox_worker_admission_foundation.sql`
- Create: `tests/transaction-inbox-worker-admission-migration.test.ts`
- Modify: migration-head assertions returned by
  `rg -l '052_transaction_inbox_urgent_fairness.sql' tests src scripts`

- [ ] **Step 1: Add RED install and upgrade tests**

Using the existing PostgreSQL test helpers, assert:

- a clean database applies 53 migrations with 053 as head;
- an exact 052 database upgrades without loss;
- `PENDING`, `PROCESSING`, `PROCESSED`, and `FAILED` backfill to `observed_at`;
- pristine `DEFERRED`, `IGNORED`, and `QUARANTINED` remain null.

- [ ] **Step 2: Add RED invariant tests**

Reject a null admission combined with processing status, lease, attempts,
snapshot/fingerprint, processed/retry/finality/manual-recovery evidence, and a
non-finite timestamp. Accept pristine pending/classification and terminal rows.
Prove null can become a finite timestamp exactly once and can never be changed
or cleared.

- [ ] **Step 3: Add RED replay, drift, and index tests**

Capture column/index/trigger OIDs, replay 053, and assert they are unchanged.
Mutate the column, check, trigger, function, and each index separately and
assert stable migration failures. Use `EXPLAIN` with deterministic fixtures to
show each partial index is eligible for its intended query.

- [ ] **Step 4: Run RED**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/transaction-inbox-worker-admission-migration.test.ts
```

Expected: migration 053 is absent and head assertions fail.

- [ ] **Step 5: Implement migration 053**

Follow the preflight/temp-expected/install/postflight pattern of migrations
050-052. Lock the inbox, distinguish first install from replay, validate exact
pre-existing structure, add the nullable column, backfill from `observed_at`,
install the check and monotonic trigger, create the two preparatory indexes,
and revalidate every installed object. Do not alter the 052 claim index.

- [ ] **Step 6: Update all exact migration-head consumers**

Change only the head/count expectations required by 053. Do not make strict
catalogue checks dynamic. Calculate and pin the exact SHA-256 only after the SQL
is final.

- [ ] **Step 7: Run GREEN**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/transaction-inbox-worker-admission-migration.test.ts \
  tests/migration-lock.test.ts \
  tests/executor-live-startup.test.ts \
  tests/executor-live-recovery-startup.test.ts
npm run check:backend
npm run lint:backend
```

- [ ] **Step 8: Commit**

```bash
git add migrations/053_transaction_inbox_worker_admission_foundation.sql \
  tests/transaction-inbox-worker-admission-migration.test.ts \
  src/execution-migrations/live-catalog.ts \
  src/executor-live/startup-validator.ts \
  src/executor-live-recovery/startup-validator.ts \
  scripts/deployment-smoke.mjs tests
git commit -m "feat(storage): add worker admission foundation"
```

### Task 3: Preserve legacy repository behavior with durable admission evidence

**Files:**

- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`

- [ ] **Step 1: Add RED repository tests**

Cover, at minimum:

- new WebSocket/legacy pending enqueue uses the row's `observed_at`;
- catch-up actionable insert is admitted using its durable decision clock;
- deferred-to-pending and tracked-trade promotion set admission once;
- replay preserves the original non-null timestamp;
- ignored/quarantined/deferred pristine rows remain null;
- old claim order, 32:1 urgent fairness, 3:1 launch/tracked fairness, retry, and
  restart behavior remain identical.

- [ ] **Step 2: Prove RED**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/transaction-inbox.repository.test.ts
```

Expected: assertions reading `worker_admitted_at` fail before repository SQL is
updated.

- [ ] **Step 3: Update write and promotion SQL only**

Materialize admission on legacy actionable inserts/promotions and preserve it
with `COALESCE`. Do not add `worker_admitted_at` to any claim predicate or
ordering in part A. Do not clear it on replay, demotion, finality, or orphaning.

- [ ] **Step 4: Run GREEN and focused regressions**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/transaction-inbox.repository.test.ts \
  tests/transaction-inbox-tracked-trade-migration.test.ts \
  tests/catch-up-admission-migration.test.ts
npm run check:backend
npm run lint:backend
```

- [ ] **Step 5: Commit**

```bash
git add src/storage/transaction-inbox.repository.ts \
  tests/transaction-inbox.repository.test.ts
git commit -m "feat(storage): record legacy worker admission"
```

### Task 4: Publish safe deployment contracts and documentation

**Files:**

- Modify: `.env.example`
- Modify: `deploy/env.example`
- Modify: `deploy/compose.yaml`
- Modify: `tests/deployment-artifacts.test.ts`
- Modify: `docs/system-overview.html`

- [ ] **Step 1: Add RED deployment assertions**

Require each variable exactly once in both safe examples, exact Compose
passthrough defaults `false` and `45`, the inactive/fail-closed wording, migration
head 053, drained rollout, rollback constraints, and explicit exclusions for
wallet/executor/RPC/cache.

- [ ] **Step 2: Run RED**

```bash
npx tsx --test --test-concurrency=1 tests/deployment-artifacts.test.ts
npm run docs:check
```

- [ ] **Step 3: Update artifacts and HTML overview**

Document that the two values are restart-only and part A cannot activate the
feature. Explain the durable column, monotonicity, exact legacy behavior, and
drain/migrate/deploy/restart sequence. Do not advertise the 45-second policy as
active.

- [ ] **Step 4: Run GREEN**

```bash
npx tsx --test --test-concurrency=1 tests/deployment-artifacts.test.ts
npm run docs:check
npm run check:backend
npm run lint:backend
```

- [ ] **Step 5: Commit**

```bash
git add .env.example deploy/env.example deploy/compose.yaml \
  tests/deployment-artifacts.test.ts docs/system-overview.html
git commit -m "docs(capacity): document inactive admission foundation"
```

### Task 5: Validate, review twice at most, and deliver PR A

- [ ] **Step 1: Start one task-owned PostgreSQL 16 instance**

Reuse the repository's existing test-container convention. Use a unique empty
database and a trap/finally cleanup. Do not leave a running container, network,
or temporary database.

- [ ] **Step 2: Run the complete fresh gate**

```bash
npm run build
npm run check
npm run lint
npm run docs:check
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test
```

Run frontend and deployment smoke commands required by CI. Record exact pass,
fail, and skip counts; unexplained PostgreSQL skips are not acceptable.

- [ ] **Step 3: Perform review cycle 1/2**

Review spec compliance, migration replay/drift, flag fail-closed semantics,
legacy claim equivalence, data safety, and prohibited scope. Reproduce every
finding before editing and correct confirmed findings TDD-first.

- [ ] **Step 4: Perform review cycle 2/2 only if needed**

Review the corrected diff once. Do not begin a voluntary third cycle. Any
blocking GitHub feedback after push is handled as closure of the second cycle.

- [ ] **Step 5: Re-run affected tests and the final gate**

Require a clean worktree, `git diff --check`, and evidence that no wallet,
signer, executor, RPC transport, block cache, or transaction-submission source
changed.

- [ ] **Step 6: Push and open one PR**

The PR must close #173, reference parent #171, state that the flag remains
inactive, list validation evidence, and explicitly exclude runtime admission,
wallet use, and real execution.

- [ ] **Step 7: Merge only when checks and blocking threads are green**

After merge, verify the exact `origin/main` merge commit and the post-merge CI
before starting #171-B.
