# Durable Solana WebSocket Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and expose a redacted, generation-fenced Solana WebSocket health snapshot while keeping the production failover supervisor inactive until issue #63.

**Architecture:** Migration 030 creates one canonical `listener_websocket_health` snapshot independent from the generic five-second heartbeat. A strict domain model and PostgreSQL repository own generation/revision CAS, immediate transitions, periodic freshness and post-enqueue observation watermarks. API V1 embeds the projection under `heartbeat.websocket`; the React console accepts both new and rolling old backends.

**Tech Stack:** TypeScript strict ESM, PostgreSQL migrations, Node test runner, `pg`, Zod, React, Vitest/Testing Library, Bootstrap, bigint-only slots/generations.

---

## File structure

- `migrations/030_listener_websocket_health.sql` — bounded snapshot, checks and inactive seed.
- `src/domain/websocket-health.ts` — stable enums, immutable snapshots, hostile-safe validators and public-state mapping.
- `src/ports/websocket-health-repository.ts` — neutral persistence contract and fixed result/error codes.
- `src/storage/websocket-health.repository.ts` — PostgreSQL generation/revision fencing and DB-clock writes.
- `src/application/websocket-health-reporter.ts` — immediate transition/touch lifecycle and enqueue-before-watermark callback.
- `tests/websocket-health-migration.test.ts` — empty/upgrade/replay migration and SQL constraints.
- `tests/websocket-health-domain.test.ts` — pure state/validation tests.
- `tests/websocket-health.repository.test.ts` — real PostgreSQL concurrency/restart/ABA tests.
- `tests/websocket-health-reporter.test.ts` — scheduler, shutdown and durable observation ordering.
- Existing API, retention, migration-manifest, frontend, safety and documentation files are modified only where listed below.

---

### Task 1: Migration 030 and inactive foundation

**Files:**
- Create: `migrations/030_listener_websocket_health.sql`
- Create: `tests/websocket-health-migration.test.ts`
- Modify: `scripts/deployment-smoke.mjs`
- Modify: `tests/deployment-artifacts.test.ts`
- Modify: `tests/migration-lock.test.ts`
- Modify: `tests/paper-claim-scheduler-migration.test.ts`
- Modify: `tests/transaction-ingestion-migration.test.ts`
- Modify: `tests/api-event-stream-migration.test.ts`
- Modify: `tests/creation-entry-migration.test.ts`
- Modify: `tests/paper-finality-replay-migration.test.ts`
- Modify: `tests/paper-mvp-migration.test.ts`
- Modify: `tests/participant-analytics-migration.test.ts`
- Modify: `tests/provider-affine-finality-migration.test.ts`
- Modify: `tests/social-persistence-retry-migration.test.ts`
- Modify: `tests/transaction-inbox-retry-migration.test.ts`
- Modify: `tests/transaction-inbox-timestamp-migration.test.ts`
- Modify: `tests/wallet-graph-migration.test.ts`

- [ ] **Step 1: Write the failing upgrade, empty-schema and replay tests**

Build a temporary PostgreSQL schema, apply 001–029, insert a hostile legacy
heartbeat whose WebSocket slot/signature are populated, then apply migration
030. Assert exactly one canonical row:

```ts
assert.deepEqual(row, {
  service_key: 'transaction-listener',
  payload_version: 1,
  supervision: 'INACTIVE',
  owner_generation: '0',
  revision: '0',
  phase: 'STOPPED',
  provider_id: null,
  candidate_provider_id: null,
  acknowledged_at: null,
  last_observation_at: null,
  last_observation_slot: null,
  recovery_status: 'NOT_REQUIRED',
});
```

Apply the SQL directly a second time and assert that the row is unchanged.
Also apply 001–030 to an empty schema and assert the migration history tail is
`030_listener_websocket_health.sql`.

- [ ] **Step 2: Prove the migration tests fail before SQL exists**

Run:

```bash
TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' \
  npm run test:backend -- --test-name-pattern='websocket health migration'
```

Expected: failure because migration 030 and its table do not exist.

- [ ] **Step 3: Add the normalized snapshot and checks**

Create the table with the exact columns from spec v1.0.1. Use unconstrained
`NUMERIC` plus explicit `NaN`, nonnegative, integral and `< 10^78` checks for
the observation slot, and `BIGINT` for generations/revision. A
`NUMERIC(78,0)` typmod is forbidden because PostgreSQL rounds fractional input
before a check constraint can reject it.
The SQL must define fixed checks for provider IDs, phases, reasons, paired null
fields, phase/provider/session coherence, recovery timestamps, nonnegative
integer numerics, and inactive generation zero. Seed only
`transaction-listener` with:

```sql
INSERT INTO listener_websocket_health (
  service_key,payload_version,supervision,owner_generation,revision,
  phase,recovery_status,updated_at
) VALUES (
  'transaction-listener',1,'INACTIVE',0,0,'STOPPED','NOT_REQUIRED',
  clock_timestamp()
) ON CONFLICT (service_key) DO NOTHING;
```

The migration must not select legacy `last_signature` or
`last_websocket_slot`.

- [ ] **Step 4: Exercise every SQL invariant**

Add table-driven rejected updates for invalid provider IDs, equal active and
candidate sessions, half-present observation/disconnect pairs, numeric `NaN`,
negative or fractional slots, incoherent recovery timestamps, phase/session
mismatches, and `INACTIVE` with positive generation. Add accepted rows for all
nine detailed phases.

- [ ] **Step 5: Advance all migration manifests to 030**

Replace assertions whose only purpose is the migration tail. Add
`030_listener_websocket_health.sql` to the deployment smoke allowlist and
artifact test. Do not rewrite tests that intentionally stop at an earlier
legacy migration fixture.

- [ ] **Step 6: Run migration-focused tests**

Run:

```bash
TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' npm run test:backend -- \
  --test-name-pattern='migration|websocket health'
```

Expected: all selected tests pass and direct replay adds no duplicate row.

- [ ] **Step 7: Commit the migration foundation**

```bash
git add migrations/030_listener_websocket_health.sql \
  tests/websocket-health-migration.test.ts scripts/deployment-smoke.mjs \
  tests/deployment-artifacts.test.ts tests/migration-lock.test.ts \
  tests/paper-claim-scheduler-migration.test.ts \
  tests/api-event-stream-migration.test.ts \
  tests/creation-entry-migration.test.ts tests/paper-finality-replay-migration.test.ts \
  tests/paper-mvp-migration.test.ts tests/participant-analytics-migration.test.ts \
  tests/provider-affine-finality-migration.test.ts \
  tests/social-persistence-retry-migration.test.ts \
  tests/transaction-inbox-retry-migration.test.ts \
  tests/transaction-inbox-timestamp-migration.test.ts \
  tests/transaction-ingestion-migration.test.ts tests/wallet-graph-migration.test.ts
git commit -m "feat: add durable websocket health schema (#62)"
```

---

### Task 2: Strict WebSocket health domain

**Files:**
- Create: `src/domain/websocket-health.ts`
- Create: `tests/websocket-health-domain.test.ts`

- [ ] **Step 1: Write failing enum, mapping and hostile-boundary tests**

Test the exact phase, recovery and reason sets from the spec, plus this public
mapping:

```ts
assert.equal(publicWebSocketState('STOPPED'), 'STOPPED');
assert.equal(publicWebSocketState('WAITING_FOR_ACKS'), 'CONNECTING');
assert.equal(publicWebSocketState('RUNNING'), 'ACKNOWLEDGED');
assert.equal(publicWebSocketState('RECOVERING'), 'RECOVERING');
assert.equal(publicWebSocketState('UNRECOVERABLE'), 'DEGRADED');
```

Test frozen valid snapshots, non-data properties, getters, proxies, inherited
values, invalid dates, unsafe numbers, non-bigint generations, generation
overflow, provider/session mismatches, and mutable nested input.

- [ ] **Step 2: Run the domain tests RED**

```bash
npm run test:backend -- --test-name-pattern='websocket health domain'
```

Expected: module-not-found or missing exported symbols.

- [ ] **Step 3: Implement constants, types and validator**

Export immutable constants and types:

```ts
export const WEBSOCKET_HEALTH_PHASES = Object.freeze([
  'STOPPED','CONNECTING','WAITING_FOR_ACKS','ACKNOWLEDGED','RECOVERING',
  'RUNNING','DEGRADED','UNRECOVERABLE','STOPPING',
] as const);
export const WEBSOCKET_RECOVERY_STATUSES = Object.freeze([
  'NOT_REQUIRED','REQUIRED','IN_PROGRESS','RECOVERED','FAILED',
] as const);
export const WEBSOCKET_HEALTH_STALE_AFTER_MS = 30_000;
export const MAX_WEBSOCKET_HEALTH_GENERATION = 9_223_372_036_854_775_807n;
```

Use `RpcProviderId` from `src/domain/rpc-provider.ts`. Validate own enumerable
data properties without invoking accessors, snapshot every nested input, and
return fully frozen values. Domain errors must use fixed messages only.

- [ ] **Step 4: Run domain tests GREEN and strict check**

```bash
npm run test:backend -- --test-name-pattern='websocket health domain'
npm run check:backend
```

Expected: all domain tests and TypeScript strict checking pass.

- [ ] **Step 5: Commit the domain**

```bash
git add src/domain/websocket-health.ts tests/websocket-health-domain.test.ts
git commit -m "feat: define websocket health lifecycle (#62)"
```

---

### Task 3: Generation-fenced PostgreSQL repository

**Files:**
- Create: `src/ports/websocket-health-repository.ts`
- Create: `src/storage/websocket-health.repository.ts`
- Create: `tests/websocket-health.repository.test.ts`

- [ ] **Step 1: Write failing canonical-read and owner-acquisition tests**

Use real PostgreSQL schemas. Cover:

- inactive generation zero to active generation one;
- clean stopped restart;
- fresh active owner rejected as `ACTIVE_INSTANCE`;
- stale active owner replaced with `UNEXPECTED_RESTART` and recovery required;
- previous `UNRECOVERABLE` starts strict recovery, never live-edge;
- exact `clock_timestamp()` ordering and no application time in persistence.

Assert the public repository error contains only a fixed code:

```ts
await assert.rejects(repository.beginOwner(input), (error: unknown) => {
  assert.ok(error instanceof WebSocketHealthRepositoryError);
  assert.equal(error.code, 'ACTIVE_INSTANCE');
  assert.doesNotMatch(String(error), /postgres|rpc|url|secret/iu);
  return true;
});
```

- [ ] **Step 2: Write failing transition, touch and observation tests**

Cover exact revision CAS, stale owner/revision rejection, generation exhaustion,
concurrent begin serialization, periodic `touch` that changes only
`heartbeat_at`, active/candidate session generations, provider-ID ABA, partial
ACK observations, out-of-order slots, and retired-session `STALE_SESSION`.

- [ ] **Step 3: Run repository tests RED**

```bash
TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' npm run test:backend -- \
  --test-name-pattern='websocket health repository'
```

Expected: missing repository/port failures.

- [ ] **Step 4: Define the neutral repository contract**

Export exact inputs/results without `pg` types:

```ts
export interface WebSocketHealthRepository {
  read(): Promise<WebSocketHealthSnapshot>;
  beginOwner(input: WebSocketHealthBeginOwner): Promise<WebSocketHealthSnapshot>;
  transition(input: WebSocketHealthTransition): Promise<WebSocketHealthSnapshot>;
  touch(ownerGeneration: bigint): Promise<void>;
  recordObservation(input: WebSocketHealthObservation):
    Promise<'RECORDED' | 'STALE_SESSION'>;
}
```

Fixed repository codes are `ACTIVE_INSTANCE`, `STALE_OWNER`,
`STALE_REVISION`, `GENERATION_EXHAUSTED`, `STATE_CONFLICT`, and
`DEPENDENCY_FAILED`.

- [ ] **Step 5: Implement transactional PostgreSQL behavior**

Use one canonical service key and parameterized SQL only. `beginOwner` uses
`SELECT ... FOR UPDATE`; transitions update with exact generation/revision in
the `WHERE` clause; `touch` updates only heartbeat freshness; observation uses
PostgreSQL time and accepts only the current active/candidate session pair.
Differentiate an expected zero-row stale result from an actual dependency
failure without exposing database text.

- [ ] **Step 6: Prove concurrency and rollback**

Add two-pool concurrent tests showing one fresh owner wins, stale revision does
not mutate the row, a forced trigger failure rolls back every field, and a
retired provider reappearing with a new session generation cannot accept an old
callback.

- [ ] **Step 7: Run repository and migration tests GREEN**

```bash
TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' npm run test:backend -- \
  --test-name-pattern='websocket health'
npm run check:backend
```

- [ ] **Step 8: Commit the repository**

```bash
git add src/ports/websocket-health-repository.ts \
  src/storage/websocket-health.repository.ts \
  tests/websocket-health.repository.test.ts
git commit -m "feat: fence websocket health ownership (#62)"
```

---

### Task 4: Inactive reporter and durable observation ordering

**Files:**
- Create: `src/application/websocket-health-reporter.ts`
- Create: `tests/websocket-health-reporter.test.ts`
- Modify: `tests/bootstrap-safety.test.ts`
- Modify: `tests/production-listener-factory.test.ts`

- [ ] **Step 1: Write failing reporter lifecycle tests**

Use a manual scheduler and fake repository. Cover immediate transition writes,
one periodic touch at a time, coalescing while a touch is pending, stale timer
callbacks after stop, bounded shutdown, cleanup failure remaining degraded, and
idempotent stop.

- [ ] **Step 2: Write failing enqueue-before-watermark tests**

Use ordered spies around the future session callback:

```ts
assert.deepEqual(order, ['enqueue:start', 'enqueue:done', 'health:start']);
```

Assert enqueue rejection makes zero health calls; health rejection occurs only
after durable enqueue and rejects the callback; `STALE_SESSION` is a safe no-op
after enqueue; no signature is passed to the health repository.

- [ ] **Step 3: Run reporter tests RED**

```bash
npm run test:backend -- --test-name-pattern='websocket health reporter'
```

- [ ] **Step 4: Implement the inactive reporter**

The reporter depends only on `TransactionInboxRepository.enqueue`,
`WebSocketHealthRepository`, an injected scheduler and fixed interval/shutdown
bounds. It exposes transition, observe, start-touch and stop operations but
does not import the WebSocket factory, provider catalog, strict scanner, app
configuration, or production runtime.

- [ ] **Step 5: Prove #63 remains inactive**

Extend source-safety tests to assert `createProductionListenerRuntime` still
constructs `SolanaProgramSubscriber` and does not import or instantiate
`openWsProgramSession`, `StrictCatchUpScanner`,
`ProviderPinnedStrictCatchUpSource`, or `PersistentWebSocketHealthReporter`.

- [ ] **Step 6: Run reporter, bootstrap and factory tests GREEN**

```bash
npm run test:backend -- --test-name-pattern='websocket health reporter|bootstrap safety|production listener factory'
npm run check:backend
```

- [ ] **Step 7: Commit the inactive application seam**

```bash
git add src/application/websocket-health-reporter.ts \
  tests/websocket-health-reporter.test.ts tests/bootstrap-safety.test.ts \
  tests/production-listener-factory.test.ts
git commit -m "feat: add inactive websocket health reporter (#62)"
```

---

### Task 5: Four-hour operational evidence retention

**Files:**
- Modify: `src/storage/database.ts`
- Modify: `tests/websocket-health-migration.test.ts`
- Modify: `tests/api-event-stream-migration.test.ts`
- Modify: `tests/paper-decision.repository.test.ts`
- Modify: `tests/paper-finality-replay-migration.test.ts`
- Modify: `tests/paper-mvp-collector.test.ts`
- Modify: `tests/paper-mvp.repository.test.ts`
- Modify: `tests/participant-analytics.repository.test.ts`
- Modify: `tests/social-evidence-migration.test.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `tests/transaction-ingestion-migration.test.ts`
- Modify: `tests/transaction-ingestion-recovery.test.ts`
- Modify: `tests/wallet-graph.repository.test.ts`

- [ ] **Step 1: Write failing retention tests**

Cover unresolved evidence retained without deadline, resolved evidence retained
at `completed_at + 4 hours`, exact pre-boundary preservation, exact boundary
purge, running-row disconnect/recovery clearing, stopped-row ACK/observation
clearing, and no `heartbeat_at` refresh during purge.

- [ ] **Step 2: Run retention tests RED**

```bash
TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' npm run test:backend -- \
  --test-name-pattern='websocket health.*retention'
```

- [ ] **Step 3: Add one bounded purge projection**

Inside `purgeExpiredFoundationData`, update only rows whose
`evidence_purge_after <= clock_timestamp()`. Clear resolved reason/timestamp
fields and set recovery to `NOT_REQUIRED`; for `STOPPED`, also clear ACK and
observation. Return a new `websocketHealthEvidence` count. Do not change
`heartbeat_at` or create a transition.

- [ ] **Step 4: Align existing purge result assertions**

Add the new zero/nonzero count to typed fixtures without loosening exact
deep-equality checks.

- [ ] **Step 5: Run all retention/migration tests GREEN**

```bash
TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' npm run test:backend -- \
  --test-name-pattern='purge|retention|websocket health migration'
```

- [ ] **Step 6: Commit retention**

```bash
git add src/storage/database.ts tests/websocket-health-migration.test.ts \
  tests/api-event-stream-migration.test.ts tests/paper-decision.repository.test.ts \
  tests/paper-finality-replay-migration.test.ts tests/paper-mvp-collector.test.ts \
  tests/paper-mvp.repository.test.ts tests/participant-analytics.repository.test.ts \
  tests/social-evidence-migration.test.ts tests/transaction-inbox.repository.test.ts \
  tests/transaction-ingestion-migration.test.ts \
  tests/transaction-ingestion-recovery.test.ts tests/wallet-graph.repository.test.ts
git commit -m "feat: expire resolved websocket health evidence (#62)"
```

---

### Task 6: Additive API V1 health projection

**Files:**
- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `tests/api-router.test.ts`
- Modify: `tests/api-safety.test.ts`
- Modify: `tests/deployment-healthcheck.test.ts`

- [ ] **Step 1: Write failing contract and projection tests**

Add exact backend fixtures for inactive stopped and every active detailed phase.
Assert the five-state mapping, positional IDs, timestamps, fixed reason codes,
`lastSignature: null`, frozen output, and absence of internal generations.

- [ ] **Step 2: Write failing aggregate-health tests**

Cover:

- inactive stopped does not alter an otherwise `OK` legacy health result;
- active running/fresh/recovered can be `OK`;
- active stale, connecting, acknowledged-only, recovering, degraded,
  unrecoverable and stopping are `DEGRADED`;
- any unresolved `listener_strict_catch_up_failures` row degrades;
- malformed WS rows and dependency failures return redacted degraded health;
- PostgreSQL unavailable retains HTTP 503 behavior.

- [ ] **Step 3: Run API tests RED**

```bash
npm run test:backend -- --test-name-pattern='API|health|deployment healthcheck'
```

- [ ] **Step 4: Extend backend contracts**

Add `ApiWebSocketHealth` and required `ApiHeartbeat.websocket`. Keep the V1
`lastSignature` property but document and enforce `null`. Every public nested
object is readonly and returned frozen.

- [ ] **Step 5: Project the canonical snapshot safely**

Read `transaction-listener` by primary key, not latest arbitrary service. Read
unresolved strict-failure existence with a bounded `EXISTS`. Decode each field
through explicit allowlists; never serialize a database row wholesale. Return
the inactive stopped default if no WS row exists during a rolling migration.

- [ ] **Step 6: Apply the transitional aggregate rule**

Ignore WS state only when supervision is `INACTIVE`. Under `ACTIVE`, require
fresh `heartbeatAt`, detailed `RUNNING`, public `ACKNOWLEDGED`, recovery
`NOT_REQUIRED|RECOVERED`, and no unresolved strict failure. Keep every existing
health gate.

- [ ] **Step 7: Run backend API and safety tests GREEN**

```bash
npm run test:backend -- --test-name-pattern='API|health|safety'
npm run check:backend
```

- [ ] **Step 8: Commit the API projection**

```bash
git add src/api/contracts.ts src/storage/api-projection.repository.ts \
  tests/api-contracts.test.ts tests/api-projection.repository.test.ts \
  tests/api-router.test.ts tests/api-safety.test.ts \
  tests/deployment-healthcheck.test.ts
git commit -m "feat: expose redacted websocket health API (#62)"
```

---

### Task 7: Frontend schema and diagnostic card

**Files:**
- Modify: `frontend/src/data/api-schemas.ts`
- Modify: `frontend/src/data/api-schemas.test.ts`
- Modify: `frontend/tests/fixtures/api.ts`
- Modify: `frontend/tests/e2e/mock-api.mjs`
- Modify: `frontend/src/features/health/health-page.tsx`
- Modify: `frontend/src/features/health/health-page.test.tsx`
- Modify: `frontend/tests/e2e/operator-console.spec.ts`

- [ ] **Step 1: Write failing rolling-compatibility schema tests**

Assert a complete new object parses, an old backend without `websocket` still
parses, invalid known enums/timestamps fail, and additive hostile fields remain
unrepresented in the inferred output used by the UI.

- [ ] **Step 2: Write failing health-card tests**

Assert allowlisted rendering of public state, detailed phase, active/candidate
positional IDs, heartbeat/ACK times, diagnostic watermark, fixed disconnect and
recovery codes. Assert the old-backend fallback text and absence of injected
URL, signature, stack, remote reason and arbitrary JSON fields.

- [ ] **Step 3: Run frontend tests RED**

```bash
npm test --workspace frontend -- --run api-schemas health-page
```

- [ ] **Step 4: Add the optional rolling schema**

Define the full strict field enums inside a loose `websocket` object, then make
only that object optional on the client. Keep slots as decimal strings and
timestamps through the existing timestamp schema.

- [ ] **Step 5: Render an explicit Bootstrap card**

Use fixed labels and `Timestamp`; do not render generic object entries. Label
`lastObservation` as “watermark diagnostic — pas une preuve de continuité”.
Display “Non disponible — backend antérieur” when absent.

- [ ] **Step 6: Update mock API and browser assertion**

Add one active degraded fixture to the E2E mock and assert the health page shows
the positional provider and fixed reason without any secret-like field.

- [ ] **Step 7: Run frontend unit and E2E tests GREEN**

```bash
npm test --workspace frontend -- --run api-schemas health-page
npm run frontend:e2e
```

- [ ] **Step 8: Commit the frontend**

```bash
git add frontend/src/data frontend/src/features/health frontend/tests
git commit -m "feat: show websocket health in operator console (#62)"
```

---

### Task 8: Versioned public and operational documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/api/v1.md`
- Modify: `docs/system-overview.html`
- Modify: `docs/superpowers/specs/2026-08-28-durable-websocket-health-design.md`
- Modify: `docs/superpowers/plans/2026-08-28-durable-websocket-health.md`
- Modify: `tests/config-safety.test.ts`
- Modify: `tests/deployment-artifacts.test.ts`
- Modify: `tests/bootstrap-safety.test.ts`

- [ ] **Step 1: Document the exact API object and transitional mode**

Describe backend-required/client-optional `heartbeat.websocket`, the five-state
summary, detailed phases, 30-second freshness, four-hour evidence cleanup,
strict-failure degradation, `lastSignature=null`, and `INACTIVE` behavior until
#63.

- [ ] **Step 2: Update the diagnostic HTML**

Add a Bootstrap section and SVG lifecycle:

```text
STOPPED -> CONNECTING -> WAITING_FOR_ACKS -> ACKNOWLEDGED
       -> RECOVERING -> RUNNING
failure -> DEGRADED -> recovery
```

State explicitly that last observation is not a completeness frontier and the
supervisor is not activated by #62.

- [ ] **Step 3: Add redaction and safety assertions**

Assert docs and public examples contain only positional provider IDs and fixed
codes, no provider URL placeholder that looks usable, no signature in the new
object, and no live/wallet/submission instructions.

- [ ] **Step 4: Mark completed plan steps and bump spec revision only if implementation differs**

Keep design version 1.0.1 when implementation matches exactly. If a reviewed
implementation change is necessary, increment to 1.0.1 and describe the change
at the top rather than silently editing semantics.

- [ ] **Step 5: Run documentation checks**

```bash
npm run docs:check
git diff --check
```

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs tests
git commit -m "docs: document durable websocket health (#62)"
```

---

### Task 9: Full gates, reviews and PR #62

**Files:**
- Verify all files changed since `origin/main`
- Update: issue #57 checklist only after merge

- [ ] **Step 1: Run a clean dependency and build gate**

```bash
npm install
npm run build
npm run check
npm run lint
npm run docs:check
```

Expected: all commands exit zero. Record, but do not automatically modify, the
existing npm vulnerability count.

- [ ] **Step 2: Run all backend and frontend tests on PostgreSQL**

```bash
TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' npm test
npm run frontend:e2e
```

Expected: zero failures/skips caused by the change, migration 001–030 succeeds
on an empty schema, and every pre-existing test remains green.

- [ ] **Step 3: Run final safety and diff checks**

```bash
git diff --check origin/main...HEAD
git status --short
rg -n 'Keypair|sendTransaction|sendRawTransaction|signTransaction|private.?key|EXECUTION_MODE=live' \
  src migrations frontend docs README.md
```

Inspect matches and confirm no new live capability, secret, provider URL or
generic remote-error serialization.

- [ ] **Step 4: Obtain sequential internal reviews**

First request specification compliance against design v1.0.1. After PASS,
request code quality/security/concurrency review. Address Critical/Important
findings with focused tests and rerun affected gates.

- [ ] **Step 5: Push and open one mergeable PR**

```bash
git push -u origin feature/issue-62-ws-health
gh pr create --base main --head feature/issue-62-ws-health \
  --title "feat: persist redacted Solana websocket health" \
  --body "Closes #62"
```

The PR body must summarize migration 030, inactive supervision, API/frontend
contract, four-hour evidence retention, tests, and absence of #63/live wiring.

- [ ] **Step 6: Run at most three GitHub correction/review cycles**

Request Codex review, wait for posted threads, verify each finding technically,
fix valid blockers with TDD, resolve answered threads, and request another
review only while fewer than three cycles have been used.

- [ ] **Step 7: Merge only on exact green HEAD**

Confirm all required checks are successful, merge state is clean and no
blocking thread remains. Squash-merge, delete the remote branch, verify issue
#62 closed, then mark #62 complete in issue #57. Do not activate issue #63 in
this PR.
