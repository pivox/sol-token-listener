# Two-group Hydration Evidence Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document does not authorize execution, delegation, commits, or a live probe; the main agent owns the delivery sequence.

**Goal:** Deliver exact, immutable V2 hydration/admission/budget/memory evidence through heartbeat JSONB, public health projection, the frontend consumer, and a pure twenty-gate V2 canary evaluator while preserving every V1 contract and golden result.

**Architecture:** Four strict V2 sidecars form an all-or-nothing evidence bundle at the durable/public heartbeat boundary. V1 validators remain separate and unchanged. An explicit private canary V2 parser carries genuine V2 measurements into shared safety gates without manufacturing a V1 `callerConcurrency: 1` object; a new `capacityEnvelope` gate evaluates the independent V2 sidecars.

**Tech Stack:** Strict TypeScript/ESM, `node:test`/`tsx`, PostgreSQL JSONB, frontend-owned Zod/Vitest schemas, existing offline canary CLI.

**Design:** [Two-group hydration evidence v1.1.2](../specs/2026-10-03-two-group-hydration-evidence-design.md), spec commits `6ae22db`, `312fdb6`, `67268aa`; merged #227 baseline `main@74a31ce` is incorporated in this worktree. Do not replay or overwrite the ordinary-budget foundation or its local-admission fix.

---

## Scope, safety, and entry checks

This is one contract-only PR. It adds no metrics recorder, producer, config flag, factory wiring, timer, RPC, wallet, transaction submission, two-lane scheduler, cache concurrency, worker-pool change, classifier prefetch, or streaming reader. Production continues to emit exactly V1. The V2 examples below are synthetic test evidence, not observations or capacity proof.

The follow-up PR owns runtime two-group admission, fairness, provider/finality/epoch separation, ordered classification writes, restart replay, last-consumer abort, real streaming limits/RSS instrumentation, config fail-closed, and the short observe-only gain measurement. Do not execute or schedule the full fifteen-minute canary or any readiness step. Keep #215's unknown TradeEvent wire profile quarantined and its failed decoder gate unchanged.

- [ ] Confirm the worktree and applicable repository rules with read-only commands:

```sh
pwd
git status --short
git log -5 --oneline
rg --files -g AGENTS.md
df -Pk .
```

Expected: isolated `.worktrees/issue-218-v2-contract`; known spec/plan changes only. `Available * 1024` must exceed `5_000_000_000` bytes. If it does not, pause writes/heavy checks and report; do not remove another task's files. Read any applicable `AGENTS.md` before implementation. Do not inspect `.env`, secrets, or root-main changes.

- [ ] Use RED before each behavior change; a missing-module failure is appropriate only for the first domain/parser step. Later RED must be an assertion demonstrating missing behavior, not a typo or unrelated type error. Run GREEN before moving to the next task. Keep explicit evidence of the failing and passing assertions in the delivery report.

## File map

Create:

- `src/domain/two-group-hydration-evidence.ts`: four exact V2 types, validators, immutable snapshots, bundle validation, and STOPPED drain validation; no recorder or runtime imports.
- `tests/helpers/two-group-hydration-evidence-fixture.ts`: complete synthetic V2 sidecars for contract tests.
- `tests/two-group-hydration-evidence.test.ts`: bounds, exactness, provenance-free JSON parsing, immutability, pairing, and drain tests.
- `scripts/lib/mainnet-observe-canary-v2.ts`: explicit V2 input/result types, parser, V2 hydration/admission gates, capacity gate, and twenty-gate result assembly.
- `tests/mainnet-observe-canary-v2-verdict.test.ts`: V2 parser/evaluator contracts and negative evidence matrix.

Modify:

- `src/domain/transaction-ingestion.ts`: heartbeat unions and original-descriptor V2 validation only.
- `src/storage/transaction-inbox.repository.ts`: detached V2 JSONB write; no SQL/migration change.
- `src/api/contracts.ts`: public V1/V2 unions and optional budget/memory sidecars.
- `src/storage/api-projection.repository.ts`: discriminant-driven, atomic V2 health projection.
- `frontend/src/data/api-schemas.ts`: independent strict V2 schemas and coherent heartbeat refinement.
- `frontend/src/features/health/health-page.tsx`: discriminated hydration rendering and capacity diagnostics.
- `scripts/lib/mainnet-observe-canary-verdict.ts`: expose/reuse narrowly scoped common parsing/safety helpers without changing V1 runtime behavior, parser, gate list, thresholds, or result.
- `scripts/evaluate-mainnet-observe-canary.ts`: safe explicit V1/V2 dispatch after bounded file reading.
- Relevant existing tests listed under each task.

Do not modify `src/domain/block-hydration-admission.ts`, V1 hydration shape/validator, `src/config/env.ts`, `.env.example`, `src/application/production-listener-factory.ts`, `src/application/hydration-group-admission.ts`, `src/application/provider-affine-catch-up-hydration.ts`, `src/solana/rpc/block-transaction-cache.ts`, decoder files, migration files, or existing V1 fixture bytes.

## Contract decisions used by every task

1. V2 hydration removes `callerConcurrency`; it does not set it to two or forge it as one. `configuredGroups: 2` is independent of worker count.
2. Admission and cache counters describe different populations and sampling phases. Never require equality between `pendingClassifierGroups` and `queuedGroups`, or between their `activeGroups`. A cache fetch can wait for pacing after admission; a permit can outlive cache settlement.
3. Each sidecar validates its own current/max pairs. Historical maxima persist at shutdown. Do not enforce monotonicity on gauges, `oldestWaitMs`, or `lastWaitMs` across samples.
4. V1 heartbeat fields remain optional exactly as before. V2 heartbeat evidence requires all four sidecars, exact V2 identities, and no explicit `undefined`. V1 hydration/admission combined with a V2 budget or memory sidecar is invalid.
5. Public malformed V2 projects the whole four-sidecar bundle to `null`, not V1 or zero. Existing malformed/missing V1 projection behavior stays unchanged. Frontend accepts absent/null historical fields but rejects a partially populated or mixed V2 bundle.
6. Private V2 canary parsing preserves `MISSING`, `MALFORMED`, and `VALID` evidence states rather than synthesizing metrics. Missing evidence is INCONCLUSIVE; malformed or contradictory evidence, exceeded bounds, failed drain, changed provider membership, or positive `localRejections` is FAIL; positive `oversizedResponses` is INCONCLUSIVE. A simultaneous FAIL wins over missing/oversized evidence.
7. `startsInWindow` need not be zero at STOPPED: recent completed starts can remain in the rolling window. `queuedWaiters` must be zero and `closed` true. Retained entries/bytes must still be zero for the existing shutdown gate.
8. Domain snapshots may retain nonzero rejection/oversize counters as valid observations; verdict policy belongs in the evaluator. Do not reject these counts during persistence and thereby erase failure evidence.

### Complete test-side V2 evidence seed

Create the following in `tests/helpers/two-group-hydration-evidence-fixture.ts` during Task 1. It is intentionally not a runtime factory:

```ts
export function twoGroupHydrationEvidenceFixture() {
  const role = () => ({ grants: 0, cancellations: 0,
    oldestWaitMs: null as number | null, lastWaitMs: null as number | null,
    maximumWaitMs: null as number | null });
  return {
    blockHydration: {
      version: 2 as const, enabled: true as const, configuredGroups: 2 as const,
      locates: 0, hits: 0, misses: 0, inFlightJoins: 0, fetches: 0,
      forcedRefreshes: 0, evictions: 0, oversizeBypasses: 0, fetchFailures: 0,
      epochInvalidations: 0, retainedEntries: 0, retainedBytes: 0,
      inFlightFetches: 0, queuedFetches: 0,
      queueDelayMs: { last: null as number | null, maximum: null as number | null },
      activeGroups: 0, maximumActiveGroups: 0, queuedGroups: 0,
      maximumQueuedGroups: 0, maximumInFlightFetches: 0,
      maximumQueuedFetches: 0, sameGroupJoins: 0,
      unsettledAfterCancel: 0, maximumUnsettledAfterCancel: 0,
    },
    blockHydrationAdmission: {
      version: 2 as const, enabled: true as const, configuredGroups: 2 as const,
      registeredWorkers: 1, pendingWorkers: 0, maximumPendingWorkers: 0,
      pendingClassifierGroups: 0, maximumPendingClassifierGroups: 0,
      unboundReservations: 0, activeGroups: 0, maximumAdmitted: 0,
      worker: role(), classifier: role(),
    },
    ordinaryRpcBudget: {
      version: 2 as const, enabled: true as const, windowMs: 1000 as const,
      maxAttemptsPerWindow: 8 as const, maxWaiters: 64 as const,
      startsInWindow: 0, maximumStartsInWindow: 0,
      queuedWaiters: 0, maximumQueuedWaiters: 0, localRejections: 0, closed: false,
    },
    blockResponseMemory: {
      version: 2 as const, perResponseLimitBytes: 33_554_432 as const,
      totalInFlightLimitBytes: 67_108_864 as const,
      activeBodies: 0, inFlightBytes: 0, maximumInFlightBytes: 0,
      oversizedResponses: 0, maximumRssBytes: 67_108_864,
    },
  };
}

export function stoppedTwoGroupHydrationEvidenceFixture() {
  const value = twoGroupHydrationEvidenceFixture();
  value.ordinaryRpcBudget.closed = true;
  return value;
}
```

### Exact domain exports to implement

The new domain file exports the following types, all deeply readonly, and functions. `RuntimeHydrationAdmissionRoleMetricsV1` is imported as a type from the unchanged V1 admission module. Field names are precisely those in spec v1.1.2; no IDs, timestamps, body text, URLs, keys, slot, signature, mint, or provider field is added to these sidecars.

```ts
export interface RuntimeBlockHydrationMetricsV2 {
  readonly version: 2; readonly enabled: true; readonly configuredGroups: 2;
  readonly locates: number; readonly hits: number; readonly misses: number;
  readonly inFlightJoins: number; readonly fetches: number;
  readonly forcedRefreshes: number; readonly evictions: number;
  readonly oversizeBypasses: number; readonly fetchFailures: number;
  readonly epochInvalidations: number; readonly retainedEntries: number;
  readonly retainedBytes: number; readonly inFlightFetches: number;
  readonly queuedFetches: number;
  readonly queueDelayMs: Readonly<{ last: number | null; maximum: number | null }>;
  readonly activeGroups: number; readonly maximumActiveGroups: number;
  readonly queuedGroups: number; readonly maximumQueuedGroups: number;
  readonly maximumInFlightFetches: number; readonly maximumQueuedFetches: number;
  readonly sameGroupJoins: number; readonly unsettledAfterCancel: number;
  readonly maximumUnsettledAfterCancel: number;
}
export interface RuntimeBlockHydrationAdmissionMetricsV2 {
  readonly version: 2; readonly enabled: true; readonly configuredGroups: 2;
  readonly registeredWorkers: number; readonly pendingWorkers: number;
  readonly maximumPendingWorkers: number; readonly pendingClassifierGroups: number;
  readonly maximumPendingClassifierGroups: number; readonly unboundReservations: number;
  readonly activeGroups: number; readonly maximumAdmitted: number;
  readonly worker: RuntimeHydrationAdmissionRoleMetricsV1;
  readonly classifier: RuntimeHydrationAdmissionRoleMetricsV1;
}
export interface RuntimeOrdinaryRpcBudgetMetricsV2 {
  readonly version: 2; readonly enabled: true; readonly windowMs: 1000;
  readonly maxAttemptsPerWindow: 8; readonly maxWaiters: 64;
  readonly startsInWindow: number; readonly maximumStartsInWindow: number;
  readonly queuedWaiters: number; readonly maximumQueuedWaiters: number;
  readonly localRejections: number; readonly closed: boolean;
}
export interface RuntimeBlockResponseMemoryMetricsV2 {
  readonly version: 2; readonly perResponseLimitBytes: 33554432;
  readonly totalInFlightLimitBytes: 67108864; readonly activeBodies: number;
  readonly inFlightBytes: number; readonly maximumInFlightBytes: number;
  readonly oversizedResponses: number; readonly maximumRssBytes: number;
}
export interface RuntimeTwoGroupHydrationEvidenceV2 {
  readonly blockHydration: RuntimeBlockHydrationMetricsV2;
  readonly blockHydrationAdmission: RuntimeBlockHydrationAdmissionMetricsV2;
  readonly ordinaryRpcBudget: RuntimeOrdinaryRpcBudgetMetricsV2;
  readonly blockResponseMemory: RuntimeBlockResponseMemoryMetricsV2;
}
```

Function names and return contracts:

- `snapshotRuntimeBlockHydrationMetricsV2(value: unknown): RuntimeBlockHydrationMetricsV2`.
- `snapshotRuntimeBlockHydrationAdmissionMetricsV2(value: unknown): RuntimeBlockHydrationAdmissionMetricsV2`.
- `snapshotRuntimeOrdinaryRpcBudgetMetricsV2(value: unknown): RuntimeOrdinaryRpcBudgetMetricsV2`.
- `snapshotRuntimeBlockResponseMemoryMetricsV2(value: unknown): RuntimeBlockResponseMemoryMetricsV2`.
- `snapshotRuntimeTwoGroupHydrationEvidenceV2(value: unknown): RuntimeTwoGroupHydrationEvidenceV2`.
- `assertTwoGroupHydrationEvidenceForState(value: RuntimeTwoGroupHydrationEvidenceV2, state: 'RUNNING' | 'STOPPED' | 'OTHER'): void`.

All snapshot failures throw a fixed `TypeError('Two-group hydration evidence is invalid.')`; never interpolate input or retain a caller graph.

### Task 1: Exact domain snapshots, one sidecar at a time

**Files:** Create the domain, helper, and domain test files above. Read `src/domain/block-hydration-admission.ts` as the exact-descriptor/role reference; do not widen its V1 bounds.

- [ ] **Step 1: Write the first RED tests and complete fixture.** The first test below establishes ordinary-budget identity, rejection observation retention, JSON compatibility, and safe counts:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotRuntimeOrdinaryRpcBudgetMetricsV2 }
  from '../src/domain/two-group-hydration-evidence.js';
import { twoGroupHydrationEvidenceFixture }
  from './helpers/two-group-hydration-evidence-fixture.js';

void test('V2 budget snapshots detach exact observation data', () => {
  const value = twoGroupHydrationEvidenceFixture().ordinaryRpcBudget;
  value.localRejections = 1;
  const snapshot = snapshotRuntimeOrdinaryRpcBudgetMetricsV2(value);
  value.localRejections = 9;
  assert.equal(snapshot.localRejections, 1);
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(snapshotRuntimeOrdinaryRpcBudgetMetricsV2(
    JSON.parse(JSON.stringify(snapshot))), snapshot);
  for (const startsInWindow of [-0, -1, 0.5, NaN, Infinity, 9,
    Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => snapshotRuntimeOrdinaryRpcBudgetMetricsV2({
      ...snapshot, startsInWindow }), TypeError);
  }
});
```

- [ ] **Step 2: Run RED.** `npx tsx --test tests/two-group-hydration-evidence.test.ts`; expect the new domain import to be absent, with zero successful new assertions.
- [ ] **Step 3: Implement shared exact-record/count helpers and the budget snapshot.** Check `isProxy` before prototype/descriptors; accept only plain or null-prototype records; use `Reflect.ownKeys` so symbols/non-enumerable keys cannot escape exactness. Read only enumerable own data descriptors. Require safe non-negative integer and reject `Object.is(value, -0)`. Literal identity fields must match the interface. Copy/freeze a fresh object. Use this complete primitive validation code inside the module:

```ts
function invalid(): TypeError {
  return new TypeError('Two-group hydration evidence is invalid.');
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 0 || Object.is(value, -0)) throw invalid();
  return value;
}
function nullableCount(value: unknown): number | null {
  return value === null ? null : count(value);
}
function fields<const T extends readonly string[]>(
  value: unknown, names: T,
): Record<T[number], unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== names.length
    || keys.some((key) => typeof key !== 'string' || !names.includes(key))) throw invalid();
  const result = Object.create(null) as Record<T[number], unknown>;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    result[name as T[number]] = descriptor.value as unknown;
  }
  return result;
}
```

Import `isProxy` from `node:util/types`. Budget checks are `startsInWindow <= maximumStartsInWindow <= 8`, `queuedWaiters <= maximumQueuedWaiters <= 64`, exact literals, boolean `closed`, and unrestricted valid `localRejections` count. No cross-time or provider check belongs here.

- [ ] **Step 4: Run budget GREEN.** Run the same file; every budget assertion must pass before adding the next sidecar.
- [ ] **Step 5: Add RED hydration and memory tests.** For hydration, exercise exact upper boundaries (2 active/fetches/groups and queued distinct cache fetches, 64 retained entries, 67,108,864 retained bytes), each boundary plus one, current>maximum, removed `callerConcurrency`, unknown keys, queue-delay nullable counts, last>maximum, and deep-copy mutation. The separate 1,024 cap concerns caller waits in the runtime scheduler, not `queuedFetches`. Memory must accept exactly two bodies/64 MiB combined bytes and retain a positive `oversizedResponses`, then reject literal limit changes, unsafe RSS, three bodies, and current>maximum.

```ts
void test('V2 memory retains overflow observations but not caller-owned data', () => {
  const value = twoGroupHydrationEvidenceFixture().blockResponseMemory;
  value.oversizedResponses = 1;
  const snapshot = snapshotRuntimeBlockResponseMemoryMetricsV2(value);
  value.oversizedResponses = 2;
  assert.equal(snapshot.oversizedResponses, 1);
  assert.throws(() => snapshotRuntimeBlockResponseMemoryMetricsV2({
    ...snapshot, inFlightBytes: 67_108_865, maximumInFlightBytes: 67_108_865 }), TypeError);
});
```

- [ ] **Step 6: Run RED, implement the two exact snapshot functions, and run GREEN.** Hydration's numeric field list is every numeric interface property except its literals and `queueDelayMs`; memory's numeric list is every numeric property except literals. Build field manifests from the interfaces above, not from `Object.keys(input)`. Check independent pairs for activeGroups, queuedGroups, inFlightFetches, queuedFetches, unsettledAfterCancel. Bound both maximum queued-group/fetch gauges and `maximumUnsettledAfterCancel` at two. Keep the existing queue-delay nullable semantics; do not derive maxima from current gauges.
- [ ] **Step 7: Add RED admission tests.** Require `registeredWorkers <= 1`, pendingWorkers<=registeredWorkers and maximumPendingWorkers<=1, pendingClassifierGroups<=maximumPendingClassifierGroups<=2, `unboundReservations + activeGroups <= maximumAdmitted <= 2`. Copy the five exact V1 role properties into new frozen role objects and preserve the existing role invariants: oldestWaitMs iff pending>0, last/maximum paired, no completed-wait fields before a grant/cancellation, last<=maximum; an ongoing oldest wait may exceed the completed maximum.

```ts
void test('V2 admission counts reservations and groups together', () => {
  const value = twoGroupHydrationEvidenceFixture().blockHydrationAdmission;
  value.activeGroups = 1; value.unboundReservations = 1; value.maximumAdmitted = 2;
  assert.doesNotThrow(() => snapshotRuntimeBlockHydrationAdmissionMetricsV2(value));
  assert.throws(() => snapshotRuntimeBlockHydrationAdmissionMetricsV2({
    ...value, activeGroups: 2 }), TypeError);
});
```

- [ ] **Step 8: Run RED, implement admission validation/copying, then run GREEN.** Do not import the V1 snapshot function to process a fake `version: 1` copy; its one-group bounds are deliberately different.
- [ ] **Step 9: Add hostile input tests for all four functions.** Use each valid fixture, a proxy with throwing traps, extra URL/signature/symbol fields, an own accessor for every top-level property, nested role/queue getters, array/null/class-instance input, missing field, explicit undefined, and non-enumerable field. Assert zero getter/trap calls and fixed redacted errors.
- [ ] **Step 10: Run `npx tsx --test tests/two-group-hydration-evidence.test.ts tests/block-hydration-admission.test.ts` and `npx tsc -p tsconfig.json --noEmit`.** Expect GREEN and unchanged V1 rejects at two groups. No runtime concurrency test is claimed by this task.

### Task 2: Bundle and lifecycle invariants without false equality

**Files:** Domain/helper/test files from Task 1 only.

- [ ] **Step 1: Add RED bundle tests.** Missing any one sidecar, explicit undefined, a V1 sidecar among V2 peers, or extra bundle fields must throw. Independent cache/admission observations must be accepted:

```ts
void test('cache pacing and admission counts remain independent', () => {
  const value = twoGroupHydrationEvidenceFixture();
  value.blockHydration.queuedGroups = 1;
  value.blockHydration.maximumQueuedGroups = 1;
  value.blockHydration.queuedFetches = 1;
  value.blockHydration.maximumQueuedFetches = 1;
  value.blockHydrationAdmission.activeGroups = 1;
  value.blockHydrationAdmission.maximumAdmitted = 1;
  const snapshot = snapshotRuntimeTwoGroupHydrationEvidenceV2(value);
  assert.equal(snapshot.blockHydrationAdmission.pendingClassifierGroups, 0);
  assert.equal(snapshot.blockHydration.queuedGroups, 1);
});
```

- [ ] **Step 2: Run RED and implement the bundle snapshot.** Exact bundle fields are only `blockHydration`, `blockHydrationAdmission`, `ordinaryRpcBudget`, `blockResponseMemory`; call the four V2 snapshots and freeze the result. Do not add equality or inequality between different sidecars' live gauges.
- [ ] **Step 3: Add RED state tests.** RUNNING requires exactly one registered worker. STOPPED requires hydration `activeGroups`, `queuedGroups`, `inFlightFetches`, `queuedFetches`, `unsettledAfterCancel`, retainedEntries/retainedBytes zero; admission pendingWorkers/pendingClassifierGroups/unboundReservations/activeGroups zero; budget queuedWaiters zero and closed true; memory activeBodies/inFlightBytes zero. Registered workers may be zero or one at STOPPED. Historical maxima and completed counters remain unchanged.

```ts
void test('stopped evidence preserves recent rolling starts and historical maxima', () => {
  const value = stoppedTwoGroupHydrationEvidenceFixture();
  value.ordinaryRpcBudget.startsInWindow = 8;
  value.ordinaryRpcBudget.maximumStartsInWindow = 8;
  value.blockHydration.maximumActiveGroups = 2;
  value.blockResponseMemory.maximumInFlightBytes = 67_108_864;
  const snapshot = snapshotRuntimeTwoGroupHydrationEvidenceV2(value);
  assert.doesNotThrow(() => assertTwoGroupHydrationEvidenceForState(snapshot, 'STOPPED'));
  assert.throws(() => assertTwoGroupHydrationEvidenceForState(
    snapshotRuntimeTwoGroupHydrationEvidenceV2({ ...value,
      ordinaryRpcBudget: { ...value.ordinaryRpcBudget, closed: false } }), 'STOPPED'), TypeError);
});
```

- [ ] **Step 4: Run RED; implement state assertions with the enumerated current fields; run GREEN.** Use `OTHER` for STARTING/STOPPING/DEGRADED, where shape/bounds still apply but RUNNING's worker registration and STOPPED drain do not. Never clear evidence to make the assertions pass.

### Task 3: Durable heartbeat validation and JSONB round-trip

**Files:** `src/domain/transaction-ingestion.ts`, `src/storage/transaction-inbox.repository.ts`, `tests/transaction-ingestion-contracts.test.ts`, `tests/transaction-inbox.repository.test.ts`.

- [ ] **Step 1: Write RED heartbeat tests using the existing `rpcEvidenceHeartbeat()` helper.** Preserve its exact V1 fixture. Snapshot/freeze the complete V2 fixture before spreading it into a frozen heartbeat and expect acceptance; the existing heartbeat contract requires deeply frozen nested metrics. Remove any V2 peer and expect rejection. Add state/drain cases, mixed identities, malformed counts, and accessor/proxy detection before generic durable normalization.

```ts
void test('heartbeat accepts only a complete original V2 evidence bundle', () => {
  const base = rpcEvidenceHeartbeat();
  const evidence = snapshotRuntimeTwoGroupHydrationEvidenceV2(twoGroupHydrationEvidenceFixture());
  assert.doesNotThrow(() => assertValidRuntimeHeartbeat(Object.freeze({ ...base, ...evidence })));
  const { blockResponseMemory, ...partial } = evidence;
  assert.ok(blockResponseMemory);
  assert.throws(() => assertValidRuntimeHeartbeat(Object.freeze({ ...base, ...partial })), TypeError);
  assert.throws(() => assertValidRuntimeHeartbeat(Object.freeze({ ...base, ...evidence,
    ordinaryRpcBudget: undefined })), TypeError);
});
```

- [ ] **Step 2: Run RED.** `npx tsx --test tests/transaction-ingestion-contracts.test.ts`; expect rejection of the complete valid V2 heartbeat before implementing the union path.
- [ ] **Step 3: Add type unions, retaining every V1 declaration unchanged.** The new heartbeat property declarations are:

```ts
readonly blockHydration?: RuntimeBlockHydrationMetricsV1 | RuntimeBlockHydrationMetricsV2;
readonly blockHydrationAdmission?: RuntimeBlockHydrationAdmissionMetricsV1 | RuntimeBlockHydrationAdmissionMetricsV2;
readonly ordinaryRpcBudget?: RuntimeOrdinaryRpcBudgetMetricsV2;
readonly blockResponseMemory?: RuntimeBlockResponseMemoryMetricsV2;
```

Before `frozenRecord` can normalize a graph, inspect the original four own descriptors. A present budget/memory descriptor or exact numeric version-two descriptor selects the V2 branch. Reject accessors/non-enumerable descriptors immediately. Validate the full original bundle and its state. Existing V1 branches continue to call their existing validators; do not loosen V1 exact keys. A claimed V2 with invalid/missing peers must never fall through to V1.

- [ ] **Step 4: Run heartbeat GREEN, then add RED JSONB tests.** Use the existing repository fake-pool tests to capture query arguments, not a live database. A complete V2 write must persist the four exact detached sidecars, preserve nonzero local rejection/oversize observations, and reject malformed evidence before the first query. Assert captured sidecar identity differs from the original frozen nested queue/role data; mutating heartbeat-owned evidence is intentionally disallowed before the write. Add an optional disposable-PostgreSQL round-trip under the existing `TEST_DATABASE_URL` guard; do not provision or access production DB.

```ts
void test('V2 heartbeat JSONB is detached before query awaits', async () => {
  let queries = 0;
  let persisted: unknown;
  const repository = new PostgresTransactionInboxRepository({
    async query(_text, values) {
      queries += 1;
      persisted = values?.[14];
      return { rows: [], rowCount: 1 };
    },
    async connect() { throw new Error('not used'); },
  });
  const original = snapshotRuntimeTwoGroupHydrationEvidenceV2(twoGroupHydrationEvidenceFixture());
  await repository.writeHeartbeat(Object.freeze({ ...rpcEvidenceHeartbeat(), ...original }));
  const payload = persisted as Record<string, unknown>;
  for (const field of ['blockHydration', 'blockHydrationAdmission',
    'ordinaryRpcBudget', 'blockResponseMemory'] as const) {
    assert.deepEqual(payload[field], original[field]);
    assert.notEqual(payload[field], original[field]);
  }
  assert.equal(queries, 1);
});
```

The repository class and `rpcEvidenceHeartbeat()` already exist in `tests/transaction-inbox.repository.test.ts`. Import the new complete fixture. The fake pool follows that file's existing `snapshots admission before query awaits` test; assert only its four selected V2 properties, not unrelated heartbeat fields.

- [ ] **Step 5: Run RED; snapshot the original complete bundle before `pool.query`; write all four copied fields into the existing `toJsonValue` payload.** Keep SQL text, service key, timestamps, update ordering, durable counts, and the V1 path unchanged. Do not add migrations or start a producer.
- [ ] **Step 6: Run GREEN.** `npx tsx --test tests/transaction-ingestion-contracts.test.ts tests/transaction-inbox.repository.test.ts tests/production-listener-factory.test.ts`. Expect contract/fake-pool tests passing; PostgreSQL-only tests may be explicitly skipped without the disposable URL. Existing production factory tests must prove it still emits V1 only.

### Task 4: Public health projection is versioned and atomic

**Files:** `src/api/contracts.ts`, `src/storage/api-projection.repository.ts`, `tests/api-contracts.test.ts`, `tests/api-projection.repository.test.ts`.

- [ ] **Step 1: Add RED contract/projection cases.** Use the existing health row/fake query fixture. Test exact V1 unchanged, complete V2 round-trip, missing historical fields, explicit null, invalid V2 count, missing V2 peer, cross-version combination, V2 accessor, and unknown identifying data. Assert the whole V2 projection is null on malformed V2, with no V1 identity or zero-filled metrics.

```ts
void test('health projects complete V2 and rejects the whole malformed V2 bundle', async () => {
  const v2 = twoGroupHydrationEvidenceFixture();
  const valid = await projectWorkerAdmission(v2);
  assert.equal(valid.heartbeat.blockHydration?.version, 2);
  assert.equal(Object.hasOwn(valid.heartbeat.blockHydration ?? {}, 'callerConcurrency'), false);
  for (const field of ['blockHydration', 'blockHydrationAdmission',
    'ordinaryRpcBudget', 'blockResponseMemory'] as const) {
    assert.deepEqual(valid.heartbeat[field], v2[field]);
    assert.notEqual(valid.heartbeat[field], v2[field]);
  }
  const incomplete = await projectWorkerAdmission({ ...v2, blockResponseMemory: undefined });
  for (const field of ['blockHydration', 'blockHydrationAdmission',
    'ordinaryRpcBudget', 'blockResponseMemory'] as const) {
    assert.equal(incomplete.heartbeat[field], null);
  }
  assert.deepEqual(incomplete.heartbeat.websocket, valid.heartbeat.websocket);
});
```

`projectWorkerAdmission(payload)` is the existing helper in `tests/api-projection.repository.test.ts`, implemented using `healthyRepository(new CausalHealthQueryable(healthSnapshotRow(websocketRow(), false, healthyHeartbeatRow({ payload }))))`. It provides the RUNNING health-row boundary; no new live dependency is required.

- [ ] **Step 2: Run RED.** `npx tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts`; expect current V1-only projection to return null for valid V2.
- [ ] **Step 3: Add API aliases and unions.** Import the four V2 domain types as types. `ApiBlockHydrationMetricsV1` and `ApiBlockHydrationAdmissionMetricsV1` stay unchanged; add corresponding V2 aliases plus `ApiOrdinaryRpcBudgetMetricsV2`/`ApiBlockResponseMemoryMetricsV2`. Heartbeat hydration/admission fields become their V1|V2|null unions; new budget/memory fields are optional V2|null.
- [ ] **Step 4: Replace independent V2 projections with one aggregate read.** Inspect raw own descriptors on `heartbeat_payload`; if it claims V2, snapshot all four as a bundle, validate its persisted runtimeState, and return detached V2 fields together. On any malformed/missing V2 peer return four nulls. For no V2 claim, preserve the existing independent V1 readers, their exact keys and their null semantics. Do not add budget/memory null properties to V1 or the existing empty health projection: the new properties remain omitted there, preserving V1 golden shapes.

The aggregate failure result is exactly:

```ts
return Object.freeze({ blockHydration: null, blockHydrationAdmission: null,
  ordinaryRpcBudget: null, blockResponseMemory: null });
```

- [ ] **Step 5: Run GREEN and type-check.** Run the two API test files, `tests/api-router.test.ts`, `tests/api-safety.test.ts`, and `npx tsc -p tsconfig.json --noEmit`. Verify public API redaction and route behavior are unchanged. No diagnostic-HTML contract work is necessary.

### Task 5: Frontend-owned schema and version-aware rendering

**Files:** `frontend/src/data/api-schemas.ts`, `frontend/src/data/api-schemas.test.ts`, `frontend/src/features/health/health-page.tsx`, `frontend/src/features/health/health-page.test.tsx`.

- [ ] **Step 1: Add RED Zod tests inside the existing frontend schema tests.** Build a complete local V2 fixture using the exact seed in this plan; do not import backend runtime code into the frontend bundle. Parse the existing `success({ ...health, heartbeat: { ...health.heartbeat, ...v2 } })` envelope. Assert complete V2 retained, V1 unchanged, malformed/mixed/incomplete V2 rejected, legacy missing/null accepted, and numeric bounds/negative zero/extra keys rejected.

```ts
const parsed = apiHealthEnvelopeSchema.parse(success({ ...health,
  heartbeat: { ...health.heartbeat, ...v2 } })).data;
expect(parsed.heartbeat.blockHydration?.version).toBe(2);
expect(() => apiHealthEnvelopeSchema.parse(success({ ...health,
  heartbeat: { ...health.heartbeat, ...v2,
    ordinaryRpcBudget: { ...v2.ordinaryRpcBudget, maximumStartsInWindow: 9 } } }))).toThrow();
```

- [ ] **Step 2: Run RED.** `npm test --workspace frontend -- src/data/api-schemas.test.ts`; expect the V1-only hydration literal to reject the valid V2 sample.
- [ ] **Step 3: Add strict schemas for each exact V2 interface.** Use literal identities and `z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).refine(value => !Object.is(value, -0))` for V2 counters. Apply the domain's within-sidecar invariants in `.superRefine`. Leave `blockHydrationSchema` V1 validation unchanged, expose an explicit `z.union([blockHydrationV1Schema, blockHydrationV2Schema])`, and start validating `blockHydrationAdmission` rather than allowing it through the existing loose heartbeat object. Add budget/memory `.nullish()` fields and heartbeat all-four V2 pairing/state refinement. Do not change unrelated API envelope compatibility.
- [ ] **Step 4: Run schema GREEN, then add RED health-page tests.** V1 still shows its one-caller diagnostic; V2 shows configured two groups, current/max groups and fetches, budget current/max/queue/rejections/closed, and memory body/byte/RSS high-water/oversize observations. Null displays unavailable, not zero. Rendering positive rejection/oversize observations must not label capacity safe or ready.
- [ ] **Step 5: Implement discriminated rendering and run GREEN.** Narrow before accessing V1-only `callerConcurrency`:

```tsx
const identity = value.version === 1
  ? `concurrence appelante : ${value.callerConcurrency}`
  : `groupes configurés : ${value.configuredGroups}`;
return <p>{value.enabled ? 'Activée' : 'Désactivée'} ; {identity}</p>;
```

Keep the existing common hit/miss/cache diagnostics; add compact version-aware lines for the other V2 sidecars. Do not call configured groups a worker count and do not display H2e/readiness claims.

- [ ] **Step 6: Run `npm test --workspace frontend -- src/data/api-schemas.test.ts src/features/health/health-page.test.tsx`, `npm run check --workspace frontend`, and `npm run lint --workspace frontend`.** Expect GREEN with no backend import in the frontend build.

### Task 6: Explicit V2 parser and result, with no V1-shaped adapter

**Files:** `scripts/lib/mainnet-observe-canary-v2.ts`, `scripts/lib/mainnet-observe-canary-verdict.ts`, `tests/mainnet-observe-canary-v2-verdict.test.ts`, `tests/mainnet-observe-canary-verdict.test.ts`.

- [ ] **Step 1: Freeze the V1 regression oracle in tests.** Load `tests/fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json` without changing its bytes and assert `evaluateMainnetObserveCanary` result deep-equals the existing expected golden verdict. Keep `MAINNET_OBSERVE_CANARY_GATE_NAMES` length/order exactly nineteen. Add rejection of a two-group object placed in a V1 input; it cannot become PASS.
- [ ] **Step 2: Add RED V2 module tests with synthetic evidence.** The V2 test helper clones the existing failed V1 fixture, sets only `schemaVersion: 'mainnet-observe-canary-input.v2'`, and replaces the four sidecars at T0/T_PLUS_5/T_PLUS_15/FINAL_PRESTOP and stoppedHeartbeat using the complete fixture. Set monotonically increasing common hydration fetch counters so the hydration gate has actual synthetic delta evidence. Leave decoder/terminal failure data unchanged; assert capacity may PASS while overall remains FAIL.

```ts
const input = JSON.parse(JSON.stringify(legacyFixture)) as Record<string, unknown>;
input.schemaVersion = 'mainnet-observe-canary-input.v2';
const snapshots = input.snapshots as Record<string, Record<string, unknown>>;
let maximumRssBytes = 0;
for (const [index, name] of ['T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP'].entries()) {
  const sample = snapshots[name] as Record<string, unknown>;
  assert.equal(typeof sample.rssBytes, 'number');
  maximumRssBytes = Math.max(maximumRssBytes, sample.rssBytes as number);
  const evidence = twoGroupHydrationEvidenceFixture();
  evidence.blockHydration.fetches = 100 + index * 100;
  evidence.blockHydration.locates = 100 + index * 100;
  evidence.blockHydration.misses = 100 + index * 100;
  evidence.blockResponseMemory.maximumRssBytes = maximumRssBytes;
  Object.assign(sample, evidence);
}
const stopped = stoppedTwoGroupHydrationEvidenceFixture();
stopped.blockHydration.fetches = 400;
stopped.blockHydration.locates = 400;
stopped.blockHydration.misses = 400;
stopped.blockResponseMemory.maximumRssBytes = maximumRssBytes;
Object.assign(input.stoppedHeartbeat as Record<string, unknown>, stopped);
```

`legacyFixture` is loaded with `readFile(new URL('./fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json', import.meta.url), 'utf8')`; it is a test graph, not a forged V1 input sent to an evaluator.

- [ ] **Step 3: Run RED.** `npx tsx --test tests/mainnet-observe-canary-v2-verdict.test.ts`; expect the new V2 evaluator module/export to be absent.
- [ ] **Step 4: Define the new module's result and closed manifest.** Reuse only the existing verdict/gate-result types and nineteen gate names:

```ts
export const MAINNET_OBSERVE_CANARY_V2_GATE_NAMES = [
  ...MAINNET_OBSERVE_CANARY_GATE_NAMES, 'capacityEnvelope',
] as const;
export type MainnetObserveCanaryV2GateName =
  (typeof MAINNET_OBSERVE_CANARY_V2_GATE_NAMES)[number];
export interface MainnetObserveCanaryResultV2 {
  readonly schemaVersion: 'mainnet-observe-canary-result.v2';
  readonly commit: string | null;
  readonly overallVerdict: MainnetObserveCanaryVerdict;
  readonly gates: Readonly<Record<MainnetObserveCanaryV2GateName, MainnetObserveCanaryGateResultV1>>;
}
```

The public new evaluator is `evaluateMainnetObserveCanaryV2(input: unknown, terminalAttribution?: unknown): MainnetObserveCanaryResultV2`. Keep the existing V1 export's return type and behavior unchanged.

- [ ] **Step 5: Split shared parsing/safety code by structural requirements, not by version coercion.** Extract the common non-hydration snapshot/input parsing into named helpers in the existing verdict module; export a narrowly scoped `parseMainnetObserveCanaryCore` with an explicit schema selector (`'mainnet-observe-canary-input.v1' | 'mainnet-observe-canary-input.v2'`) and a sidecar parser callback. Its V1 call continues to use the old exact hydration subset and optional V1 admission parser. Its V2 call uses full exact domain V2 snapshots. Preserve all current array caps, exact root keys, integer/redaction checks, terminal-attribution parsing, and V1 failure reasons. Do not accept extra V2 keys in the V1 root/snapshot parser.

Shared safety gates operate on a common structural core containing their actual consumed fields, not a nominal V1 Hydration interface requiring `version: 1`/`callerConcurrency`. Code inspection establishes a precise extraction boundary: fifteen gates do not read hydration/admission at all; `providerAffinity` reads hydration epochInvalidations, and `shutdown` reads hydration current fetch/cache gauges. Therefore do not claim all seventeen are immediately reusable against missing V2 cells.

Expose `evaluateMainnetObserveCanarySafetyGates` for exactly these fifteen gates: runtime, http429, backlog, terminalFailures, idempotence, retention, decoderQuarantine, firstProcessing, catchUpAdmission, workerAdmission, rss, pumpswap, finality, versionsAndFreshReplay, cleanup. Define the common types as follows inside the existing verdict module, where Snapshot/StoppedHeartbeat/CanaryInput already exist:

```ts
export type MainnetObserveCanaryCoreSnapshot =
  Omit<Snapshot, 'blockHydration' | 'blockHydrationAdmission'>;
export type MainnetObserveCanaryCoreStopped =
  Omit<StoppedHeartbeat, 'blockHydration' | 'blockHydrationAdmission'>;
export type MainnetObserveCanaryCoreInput =
  Omit<CanaryInput, 'snapshots' | 'stoppedHeartbeat'> & Readonly<{
    snapshots: Readonly<Record<SnapshotName, MainnetObserveCanaryCoreSnapshot>>;
    stoppedHeartbeat: MainnetObserveCanaryCoreStopped;
  }>;
export type MainnetObserveCanaryCoreGateName = Exclude<MainnetObserveCanaryGateName,
  'blockHydration' | 'blockHydrationAdmission' | 'providerAffinity' | 'shutdown'>;
```

The shared evaluator accepts `(input: MainnetObserveCanaryCoreInput, terminalAttribution?: unknown)` and returns `Readonly<Record<MainnetObserveCanaryCoreGateName, MainnetObserveCanaryGateResultV1>>`; parse attribution with the existing private parser before passing it to evaluateTerminal/evaluateDecoder. Broaden only the fifteen leaf functions' input annotations to the common type; adapt `isAuthenticatedPeriodicPause` to the common snapshot type and introduce a common-snapshot ordering helper. Their expressions, ordering, thresholds and reason codes stay untouched. V1 inputs structurally satisfy the common type; the V1 wrapper assembles the same nineteen gates with its original four hydration-dependent evaluators.

V2 has four version-aware gates: blockHydration, blockHydrationAdmission, providerAffinity, shutdown. Preserve the original non-hydration checks/reasons in its affinity/shutdown implementations, but guard missing/malformed hydration evidence explicitly. A proven `providerMixingEvidenceCount>0` or stopped component/lease residual remains FAIL even if the hydration sidecar is missing; otherwise missing required hydration is INCONCLUSIVE. Never construct dummy hydration to satisfy a type. V2 extends the shared RSS result with high-water evidence in Task 7. Every extraction checkpoint reruns all original V1 tests, including malformed evidence and authenticated periodic pauses.

- [ ] **Step 6: Keep sidecar parse failures local to evidence cells.** V2 sidecar parser maps absent own descriptor to MISSING, accessor/non-enumerable/proxy/invalid snapshot to MALFORMED, and a successful domain snapshot to VALID. It must not invoke getters or replace missing evidence with zero. A V1 sidecar inside an explicit V2 input is MALFORMED, never VALID through a downgrade.

```ts
type V2Evidence<T> =
  | Readonly<{ state: 'MISSING' | 'MALFORMED'; value: null }>
  | Readonly<{ state: 'VALID'; value: T }>;

function parseV2Sidecar<T>(
  input: object, name: string, snapshot: (value: unknown) => T,
): V2Evidence<T> {
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (descriptor === undefined) return Object.freeze({ state: 'MISSING', value: null });
  if (!descriptor.enumerable || !('value' in descriptor)) {
    return Object.freeze({ state: 'MALFORMED', value: null });
  }
  try {
    return Object.freeze({ state: 'VALID', value: snapshot(descriptor.value) });
  } catch {
    return Object.freeze({ state: 'MALFORMED', value: null });
  }
}
```

Validate the outer snapshot as non-proxy with an exact allowed key set before passing it to this helper. Require own enumerable data descriptors for core fields, but leave the four known sidecar descriptors opaque until `parseV2Sidecar` classifies them: a sidecar accessor must yield MALFORMED without executing it or invalidating unrelated readable core evidence. Do not run a generic all-fields data-record validator first, which would erase this local evidence-state distinction. Root/core-malformed V2 returns a V2 result with nineteen INCONCLUSIVE core gates and `capacityEnvelope: FAIL/CAPACITY_EVIDENCE_MALFORMED`; never return result.v1 for an explicitly selected V2 evaluator. Missing sidecars still permit independently provable core failures to be evaluated.

- [ ] **Step 7: Run parser/result GREEN and the complete V1 evaluator tests.** `npx tsx --test tests/mainnet-observe-canary-verdict.test.ts tests/mainnet-observe-canary-v2-verdict.test.ts`. Verify V1 golden bytes/result/order unchanged and V2 manifest/result exactly twenty gates/version two. If extraction changes any V1 result, stop and correct it before continuing.

### Task 7: Capacity, hydration, admission, and high-water verdicts

**Files:** New V2 evaluator/test and shared safety helper from Task 6 only.

- [ ] **Step 1: Add RED gate policy tests.** For every boundary and every sidecar: delete it (capacity INCONCLUSIVE), replace version with one or add a private key (capacity FAIL), change a current/max pair beyond bounds (FAIL), regress a cumulative/max field across boundaries (FAIL), or leave STOPPED work (FAIL). Test both missing+failure and oversized+failure precedence. Current gauges can fall between snapshots and independent sidecars can disagree without failure.

```ts
const result = evaluateMainnetObserveCanaryV2(input);
assert.equal(result.schemaVersion, 'mainnet-observe-canary-result.v2');
assert.equal(Object.keys(result.gates).length, 20);
assert.equal(result.gates.capacityEnvelope.verdict, 'PASS');
const rejected = structuredClone(input);
const rejectedSnapshots = rejected.snapshots as Record<string, Record<string, unknown>>;
const rejectedBudget = rejectedSnapshots.T_PLUS_5?.ordinaryRpcBudget as Record<string, unknown>;
rejectedBudget.localRejections = 1;
assert.equal(evaluateMainnetObserveCanaryV2(rejected).gates.capacityEnvelope.verdict, 'FAIL');
const oversized = structuredClone(input);
const oversizedSnapshots = oversized.snapshots as Record<string, Record<string, unknown>>;
for (const name of ['T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP']) {
  (oversizedSnapshots[name]?.blockResponseMemory as Record<string, unknown>).oversizedResponses = 1;
}
(oversized.stoppedHeartbeat as Record<string, unknown>).blockResponseMemory = {
  ...(oversized.stoppedHeartbeat as Record<string, unknown>).blockResponseMemory as object,
  oversizedResponses: 1,
};
assert.equal(evaluateMainnetObserveCanaryV2(oversized).gates.capacityEnvelope.verdict, 'INCONCLUSIVE');
```

- [ ] **Step 2: Run RED and implement the independent capacity checks in this order:** malformed cells; invalid configured bounds/current-max constraints; monotonic counters/maxima; provider membership; STOPPED drain and closed budget; positive local rejections; missing evidence; positive oversized bodies; otherwise PASS. Failure precedence is not short-circuited by an earlier missing cell.

Use these fixed capacity reason codes:

- `CAPACITY_EVIDENCE_MALFORMED` — malformed, mixed version, contradiction, counter/max regression, or exceeded policy.
- `CAPACITY_PROVIDER_MEMBERSHIP_CHANGED` — any boundary's existing RPC evidence changes its canonical provider ID/configured membership set from T0; compare a copied, sorted representation, not array ordering or counters.
- `CAPACITY_NOT_DRAINED` — present valid evidence proves a STOPPED current-work/closed condition failed.
- `CAPACITY_LOCAL_ADMISSION_REJECTED` — any valid budget sample has localRejections>0.
- `CAPACITY_EVIDENCE_MISSING` — missing required sidecar, unless another failure was proved.
- `CAPACITY_RESPONSE_SIZE_UNPROVEN` — any valid memory sample has oversizedResponses>0, unless another failure was proved.
- `CAPACITY_ENVELOPE_BOUNDED` — all required evidence passes.

Monotonic lists are exact: hydration locates/hits/misses/inFlightJoins/fetches/forcedRefreshes/evictions/oversizeBypasses/fetchFailures/epochInvalidations/sameGroupJoins and its five maximum fields; admission maximumPendingWorkers/maximumPendingClassifierGroups/maximumAdmitted and each role grants/cancellations/maximumWaitMs; budget maximumStartsInWindow/maximumQueuedWaiters/localRejections; memory maximumInFlightBytes/oversizedResponses/maximumRssBytes. Nullable completed-wait maxima may transition null→count, not count→null. Do not trend current groups, rolling starts, pending queues, retained gauges, current bytes/bodies, last wait, or oldest wait. Once closed=true, the budget must not reopen in the same run.

- [ ] **Step 3: Add RED RSS high-water cases and preserve the existing threshold.** Existing rss gate still compares FINAL_PRESTOP RSS against T_PLUS_5 baseline plus `max(ceil(baseline/4), 134_217_728)`. V2 must additionally apply that same limit to observed memory maximumRssBytes, including STOPPED; do not introduce a new absolute RSS threshold or compare live gauges from unrelated sidecars. Use BigInt arithmetic and retain overflow INCONCLUSIVE behavior. A high-water violation is FAIL even if final boundary RSS fell again.
- [ ] **Step 4: Run RED, implement V2 high-water evaluation, and run GREEN.** The V1 rss gate and its threshold/return behavior remain unchanged. V2's rss gate can use the shared threshold helper and both boundary and high-water evidence; missing/malformed high-water evidence cannot be treated as zero. Capacity owns malformed/bounds/drain policy, so a proven capacity failure still dominates a missing RSS sample.
- [ ] **Step 5: Add RED V2 hydration/admission gates.** Hydration keeps V1 common thresholds: positive fetch delta, no fetch failure delta, at most one retained-entry oversize bypass delta, and no more than four physical block fetches/sec over the same observed interval. Only the one-group identity/concurrency assertions are replaced by exact V2 bounds. Admission requires the exact V2 shape and one worker while RUNNING, independent of cache queues; all current admission work must drain at STOPPED. Missing evidence yields INCONCLUSIVE, malformed/drain failure yields FAIL.
- [ ] **Step 6: Run RED; implement V2 gates against genuine domain V2 snapshots; run GREEN.** Do not reuse V1 evaluator by replacing version/callerConcurrency. Keep legacy shutdown durable-backlog/finality/idempotence/cleanup checks and add the V2 current-work drain requirements. Do not add counters for provider/finality mixing absent from the approved sidecar manifest: existing source/terminal/finality evidence continues to govern those gates, and runtime race tests belong to the follow-up.
- [ ] **Step 7: Add twenty-gate aggregate precedence and negative safety regressions.** A missing capacity field plus a proven terminal/decoder/shutdown failure still produces overall FAIL. A synthetic capacity PASS does not clear decoder failures or grant readiness. Check provider mixing, HTTP429, backlog, terminal, idempotence, decoder, p95 first-processing, finality, fresh replay, RSS, stopped leases, and cleanup using their existing mutation fixtures/thresholds. Assert no signatures/URLs/secrets appear in reason codes or result JSON.
- [ ] **Step 8: Run GREEN.** `npx tsx --test tests/mainnet-observe-canary-verdict.test.ts tests/mainnet-observe-canary-v2-verdict.test.ts`; all V1 cases remain unchanged and V2 cases prove explicit missing/malformed states and precedence.

### Task 8: Bounded CLI dispatch and complete offline verification

**Files:** `scripts/evaluate-mainnet-observe-canary.ts`, `tests/mainnet-observe-canary-cli.test.ts`, existing safety/contract tests as listed above.

- [ ] **Step 1: Add RED CLI tests using injected `readInput`/stdout/stderr dependencies only.** Version-one input returns result.v1/nineteen gates and existing exit codes; version-two returns result.v2/twenty gates. Unknown/missing versions retain the existing invalid-V1-evidence INCONCLUSIVE result/exit 2, never V2 or PASS. Preserve two bounded regular-file inputs, no symlink following, stable file identity, 1 MiB caps, terminal-attribution handling and redacted errors. Invocation/read/oversize/JSON failures still take the existing fixed-error/exit 1 path. No test calls live health, wallet, or RPC.
- [ ] **Step 2: Run RED.** `npx tsx --test tests/mainnet-observe-canary-cli.test.ts`; valid explicit V2 currently goes through the V1 parser, so assert result.v2 fails before dispatch is implemented.
- [ ] **Step 3: Add safe explicit dispatch without changing either parser.** After JSON.parse, inspect a plain non-proxy object's enumerable own data schemaVersion descriptor; pass the untouched graph to the chosen evaluator. Keep file-reading and exit-code logic unchanged. The selection logic is:

```ts
const descriptor = typeof parsed === 'object' && parsed !== null
  ? Object.getOwnPropertyDescriptor(parsed, 'schemaVersion') : undefined;
const explicitlyV2 = descriptor !== undefined && descriptor.enumerable
  && 'value' in descriptor && descriptor.value === 'mainnet-observe-canary-input.v2';
const result = explicitlyV2
  ? evaluateMainnetObserveCanaryV2(parsed, parsedTerminalAttribution)
  : evaluateMainnetObserveCanary(parsed, parsedTerminalAttribution);
```

JSON.parse already prevents accessors/proxies on the actual CLI path; injected programmatic helpers must still avoid evaluating untrusted schema accessors. The V1 parser rejects unsupported/missing schemas as invalid evidence, so the fallback preserves historic failure semantics rather than treating an unsupported graph as valid V1. Existing exit codes remain 0 for PASS, 2 for evaluated FAIL/INCONCLUSIVE, 1 for command/file/JSON failure. Do not execute the CLI against observed/live files as part of this plan.

- [ ] **Step 4: Run the focused offline groups and capture counts.**

```sh
npx tsx --test tests/two-group-hydration-evidence.test.ts tests/block-hydration-admission.test.ts tests/transaction-ingestion-contracts.test.ts tests/transaction-inbox.repository.test.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts tests/mainnet-observe-canary-verdict.test.ts tests/mainnet-observe-canary-v2-verdict.test.ts tests/mainnet-observe-canary-cli.test.ts tests/production-listener-factory.test.ts
npm test --workspace frontend -- src/data/api-schemas.test.ts src/features/health/health-page.test.tsx
git diff --check
df -Pk .
```

Expected: all configured unit/fake-boundary tests GREEN; disposable PostgreSQL tests either run against the existing explicitly disposable URL or are reported skipped. No live RPC, DB, wallet, probe, readiness or fifteen-minute run occurs.

- [ ] **Step 5: Coordinate memory-heavy checks with the main agent and run sequentially.** Verify disk before/after each batch, not just before the first. Use commands below individually; pause if available bytes fall to/below 5e9.

```sh
npm run lint
npm run build
npm run check
npm test
npm run docs:check
git diff --check
git status --short
df -Pk .
```

Expected: exit 0 for every check, unchanged V1 golden results and no V2 activation. Record exact pass/skip counts and fixed failure reason coverage. Do not claim disposable PostgreSQL coverage if skipped. Main agent owns commits/push, the single external review cycle, CI, and integration; this plan does not authorize additional review requests or merges.

## Self-review and handoff checklist

- [ ] All spec v1.1.2 field names/literals appear in the domain declarations; exact own-data, safe-count, current/max, role and STOPPED constraints have concrete negative tests.
- [ ] No cross-sidecar equality has been introduced, and current gauges are not incorrectly monotonic.
- [ ] Nonzero rejection/oversize observations survive JSONB/API; verdict policy is not used to discard stored evidence.
- [ ] V1 fields, validation, nineteen-gate order, private input/result shapes, fixture bytes and golden outcomes are unchanged.
- [ ] V2 selects a distinct exact parser/result/twenty-gate manifest and never fabricates V1 measurements.
- [ ] Missing V2 canary sidecars remain explicit evidence states; valid failures outrank missing/oversized evidence.
- [ ] Frontend validates admission/budget/memory fields rather than relying on heartbeat `.loose()`, and no field is mislabelled as worker count or readiness.
- [ ] Production factories, flags, scheduler, caches, decoders, migrations and all RPC/wallet paths are untouched.
- [ ] Full canary execution and readiness remain outside current authorization. The only later operational measurement in scope is the main agent's separately controlled short observe-only gain probe after runtime delivery.

## Concerns to retain in the delivery report

The contract can validate that reported evidence is exact and bounded, but cannot prove scheduler fairness, actual physical starts, streaming enforcement, cross-finality cache isolation, ordered persistence or a truthful RSS recorder. Those require the follow-up runtime tests and controlled gain measurement; do not infer them from synthetic fixtures or a V2 capacity gate PASS.

The approved manifest exposes `queuedFetches`, not a dedicated joined-caller count. The 1,024 caller-wait cap must therefore be enforced/tested directly in the follow-up scheduler; this contract must not relabel queued fetches as callers or claim it observes the full caller population.

RSS high-water is process-monotonic evidence, whereas heartbeat time is wall-clock and queue waits use monotonic durations. Do not compare performance.now-style times to epoch timestamps or claim a monotonic producer exists in this contract-only PR. Test only fixed observations/trends here.

Canary safety extraction is the highest compatibility risk in this PR. The implementable boundary is fifteen hydration-independent shared gates plus four V2-aware gates (RSS additionally extends a shared result), not seventeen blind V1 gate calls. Missing V2 cells must not force synthetic V1 hydration, suppress an independently proved failure, or change any V1 parse-failure result. Keep extraction checkpoints small and run the entire V1 evaluator test file after each one.

The spec's long-term fifteen-minute-canary paragraph is a future prerequisite, not an action in this plan. No live canary or readiness execution is permitted by the current task. Decoder #215 remains an independent blocker and is never waived by throughput evidence.
