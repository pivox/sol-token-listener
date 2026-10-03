# Block Hydration Phase Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and project bounded RPC-completion versus local-snapshot timing evidence for the existing single-lane block hydrator without changing ingestion, canary verdicts, or transaction behavior.

**Architecture:** A strict immutable V1 domain snapshot and a small monotonic recorder belong beside the existing RPC role evidence. The block cache records only its two existing physical phases. An optional sibling heartbeat field carries the aggregate through existing JSONB storage and `/api/v1/health`; no migration or RPC call is added.

**Tech Stack:** Strict TypeScript/ESM, `node:test` via `tsx`, PostgreSQL heartbeat JSONB, existing API V1 projection.

**Design:** [v1.0.0 spec](../specs/2026-10-03-block-hydration-phase-evidence-design.md). Base `main@1bc3f1e`. The plan Free screenshot establishes credits and a nominal tier only, not H2e readiness.

---

### Task 1: Strict fixed-cardinality domain snapshot and recorder

**Files:**
- Create: `src/domain/block-hydration-phase-evidence.ts`
- Create: `src/solana/rpc/block-hydration-phase-recorder.ts`
- Test: `tests/block-hydration-phase-evidence.test.ts`

- [ ] **Step 1: Write the RED domain tests.** Test an exact two-phase V1 object with ten buckets per phase, deep freezing after `createRuntimeBlockHydrationPhaseEvidence`, rejection of extra keys/accessors/proxies/sparse buckets/negative or fractional counters, and rejection of `started !== completed + failed + inFlight` or bucket sums when `overflowed=false`.

```ts
const evidence = createRuntimeBlockHydrationPhaseEvidence({
  version: 1, overflowed: false,
  rpc: { started: 1, completed: 1, failed: 0, inFlight: 0, maxInFlight: 1,
    settledLatencyBuckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], maxSettledLatencyMs: 50 },
  snapshot: { started: 0, completed: 0, failed: 0, inFlight: 0, maxInFlight: 0,
    settledLatencyBuckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], maxSettledLatencyMs: 0 },
});
assert.equal(Object.isFrozen(evidence.rpc.settledLatencyBuckets), true);
```

- [ ] **Step 2: Run `npx tsx --test tests/block-hydration-phase-evidence.test.ts` and confirm RED because the new module is absent.**
- [ ] **Step 3: Implement `RuntimeBlockHydrationPhaseEvidenceV1`, `assertValidRuntimeBlockHydrationPhaseEvidence`, and `createRuntimeBlockHydrationPhaseEvidence` with exact descriptors, safe integers, invariants, and frozen copies.** Mirror the bounded validation style in `src/domain/rpc-http-role-evidence.ts`; the only fields are those in the spec.
- [ ] **Step 4: Run the focused domain test and confirm GREEN.**
- [ ] **Step 5: Write RED recorder tests for `begin('rpc'|'snapshot')` returning an idempotent settle callback, histogram boundaries 50/100/250/500/1000/2500/5000/10000/30000/Infinity, success/failure/in-flight counts, invalid or throwing clock overflow, and no identifiers in the snapshot.** Use an injected `now` sequence, not sleeps.

```ts
let time = 0;
const recorder = createBlockHydrationPhaseRecorder({ now: () => time });
const settle = recorder.begin('rpc');
assert.equal(recorder.snapshot().rpc.inFlight, 1);
time = 50;
settle('completed');
settle('failed'); // idempotent
assert.equal(recorder.snapshot().rpc.settledLatencyBuckets[0], 1);
```

- [ ] **Step 6: Run the focused test and confirm RED for the missing recorder, then implement a two-cell saturating recorder with fixed buckets and `performance.now()` default.** A bad clock sets `overflowed` and must not throw into ingestion; a settled attempt still counts when duration is unavailable, with bucket-sum validation relaxed only under overflow.
- [ ] **Step 7: Run the focused test and confirm GREEN, then commit the two source files and test.**

### Task 2: Measure the two existing cache phases without changing their outcomes

**Files:**
- Modify: `src/solana/rpc/block-transaction-cache.ts`
- Test: `tests/block-transaction-cache.test.ts`

- [ ] **Step 1: Add RED cache tests with a deferred fake `getBlockTransactions`.** Assert `phaseEvidence === null` before a physical fetch, RPC `inFlight=1` while the fake is unresolved, `rpc.completed=1` and `snapshot.completed=1` on success, failures on RPC rejection or invalid block, and exactly one physical RPC for multiple same-key callers. Assert the existing `metrics` V1 keys and cache hit/retention behavior are unchanged.
- [ ] **Step 2: Run `npx tsx --test tests/block-transaction-cache.test.ts` and confirm RED on the missing `phaseEvidence`.**
- [ ] **Step 3: Add one private recorder to `CachedSolanaBlockTransactionLocator` and a nullable `phaseEvidence` getter.** Start/settle `rpc` immediately around the existing awaited RPC call, then start/settle `snapshot` around the existing snapshot function. Preserve both original exception mappings and original single-flight/admission code. Do not use the cache TTL `now` for measurement; inject `phaseNow?: () => number` only for deterministic tests.
- [ ] **Step 4: Run the focused cache test and confirm GREEN; run `tests/transaction-locator.test.ts` and `tests/provider-affine-catch-up-hydration.test.ts` to catch locator/admission regressions. Commit cache and tests.**

### Task 3: Carry an optional sibling through heartbeat and API

**Files:**
- Modify: `src/application/provider-affine-catch-up-hydration.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `src/domain/transaction-ingestion.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `src/api/contracts.ts`
- Test: `tests/transaction-ingestion-contracts.test.ts`
- Test: `tests/transaction-inbox.repository.test.ts`
- Test: `tests/api-projection.repository.test.ts`
- Test: `tests/api-contracts.test.ts`
- Test: `tests/production-listener-factory.test.ts`

- [ ] **Step 1: Add RED contract and PostgreSQL round-trip tests.** Accept the exact optional `blockHydrationPhaseEvidence` object in a frozen heartbeat and health response; reject accessors, proxies, extra keys, malformed counters and malformed stored JSONB. Missing/disabled evidence must project as `null`, never as zero. Follow the existing `rpcHttpRoleEvidence` tests, but keep this field outside the canary manifest. The database test inserts one valid heartbeat and reads its health projection using the existing test database conventions.
- [ ] **Step 2: Run the five focused test files and confirm the new assertions fail for missing behavior.**
- [ ] **Step 3: Add `blockHydrationPhaseEvidence?: RuntimeBlockHydrationPhaseEvidenceV1` to the heartbeat and `?: RuntimeBlockHydrationPhaseEvidenceV1 | null` to API health; validate before generic durable normalization.** In storage, snapshot the exact evidence before writing heartbeat JSONB, and validate/copy it on API projection. This is a sibling of `blockHydration`, not a V1 shape mutation.
- [ ] **Step 4: Expose `phaseEvidence()` through `ProviderAffineCatchUpHydration` and `ProductionBlockHydration`, returning `null` when disabled or no fetch has started.** Wire the runtime heartbeat callback without new timers or RPC calls; include the property only when non-null.
- [ ] **Step 5: Run focused tests including the PostgreSQL round-trip and confirm GREEN, then commit the plumbing and tests.**

### Task 4: Prove canary isolation, document evidence limits, and verify

**Files:**
- Modify: `tests/mainnet-observe-canary-verdict.test.ts`
- Modify: `docs/superpowers/specs/2026-10-03-block-hydration-phase-evidence-design.md` only if implementation reveals a documented correction
- Modify: `docs/operations/block-hydration-canary.md` only to describe this optional diagnostic projection, not the V1 canary input shape

- [ ] **Step 1: Add a characterization canary test: injecting `blockHydrationPhaseEvidence` into the exact V1 canary manifest yields `INVALID_EVIDENCE`; removing it leaves the pre-existing verdict byte-for-byte unchanged.** The parser is already closed, so this test is expected to pass immediately and guards against future accidental widening; it is not a RED feature test.
- [ ] **Step 2: Run the focused characterization test and update `docs/operations/block-hydration-canary.md` to capture the new sidecar separately from the V1 manifest. Do not alter the verdict parser.**
- [ ] **Step 3: Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`, `npm test`, focused PostgreSQL tests, and `git diff --check`; monitor free disk during heavy commands and stop/clean task-owned artifacts at <=5,000,000,000 bytes.**
- [ ] **Step 4: Check no `.env`, private profile, RPC URL/key, raw signature, wallet, or test database artifact is staged. Inspect the diff against the spec; commit final docs/tests if needed.**
- [ ] **Step 5: Push one PR referencing #218, request one external Codex review cycle, fix actionable feedback, require green PR CI, merge only after checks and threads are clear, then verify post-merge CI.**
- [ ] **Step 6: Only after merge, run one bounded exact-merge observe-only diagnostic with the original 19-gate manifest unchanged; retain aggregate evidence and delete raw task-owned artifacts under the four-hour rule. No H2d/H2c/wallet/order action follows from this diagnostic alone.**
