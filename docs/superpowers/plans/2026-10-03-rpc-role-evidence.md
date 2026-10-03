# #218 RPC role evidence Implementation Plan v1.0.1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, aggregate physical RPC HTTP traffic evidence by provider and honest coarse role, without changing request scheduling or the existing canary verdict.

**Architecture:** A separate strict V1 domain snapshot and in-memory recorder observe physical fetch attempts. Existing direct and failover fetch paths receive an optional recorder and fixed role. A sibling optional heartbeat JSONB field is projected in health; `rpcHttpEvidence` V1 and the 19-gate canary parser remain unchanged.

**Tech Stack:** TypeScript strict ESM, Node test runner, PostgreSQL JSONB heartbeat, Solana web3.js fetch hooks.

**Base:** `origin/main@dd9c4b908230ad7a69a57d27097412ee61711b4b`. **Design:** [capacity design v1.1.1](../specs/2026-10-03-classification-throughput-capacity-design.md). No wallet, signing, submission or wider admission.

---

### Task 1: Strict fixed-cardinality domain snapshot

**Files:** Create `src/domain/rpc-http-role-evidence.ts`; modify `src/domain/transaction-ingestion.ts`; test `tests/rpc-http-role-evidence.test.ts` and `tests/transaction-ingestion-contracts.test.ts`.

- [ ] Write RED tests for ordered providers `primary`, `fallback-1..3`, ordered roles `SOURCE`, `FINALITY`, `BLOCK_HYDRATION`, `SHARED_CLIENT`, exact own data properties, frozen clone, safe nonnegative integers, bounded histogram length, and invalid/proxy/getter rejection. A cell has `{providerId, role, attempts, responses, http429Responses, failures, inFlight, maxInFlight, headerLatencyBuckets, maxHeaderLatencyMs}`. Exactly sixteen cells, in provider-major order; ten latency buckets with upper bounds 50/100/250/500/1000/2500/5000/10000/30000/Infinity ms. For non-overflowed evidence, require `responses + failures + inFlight === attempts`, `sum(headerLatencyBuckets) === responses`, `http429Responses <= responses`, `maxInFlight >= inFlight`; do not read user-controlled getters.
- [ ] Run `npx tsx --test tests/rpc-http-role-evidence.test.ts tests/transaction-ingestion-contracts.test.ts`; expect a missing module/property failure.
- [ ] Implement `RuntimeRpcHttpRoleEvidenceV1`, `RPC_HTTP_ROLES`, `createRuntimeRpcHttpRoleEvidence(input: unknown)` and `assertValidRuntimeRpcHttpRoleEvidence(input: unknown)` with no URL/method/body/signature fields. Add optional `rpcHttpRoleEvidence?: RuntimeRpcHttpRoleEvidenceV1` to `RuntimeHeartbeat` and validate it before generic snapshot normalization, matching the existing `rpcHttpEvidence` pattern.
- [ ] Re-run focused tests and `npm run check`; expect PASS. Commit the domain/contract slice.

### Task 2: Physical-fetch recorder and transport attribution

**Files:** Create `src/solana/rpc/rpc-http-role-evidence.ts`; modify `src/solana/rpc/rpc-http-evidence.ts`, `src/solana/rpc/http-failover-transport.ts`, `src/solana/rpc/rpc-client.ts`, the three `provider-pinned-*.ts` factories; test `tests/rpc-http-evidence.test.ts`, `tests/http-failover-transport.test.ts`, pinned source tests and RPC client tests.

- [ ] Write RED tests using an injected monotonic clock and deferred fetch. Direct and failover physical attempts each increment only the actual provider/role cell; retry 429 counts on the failed provider; pending requests show in-flight/max-in-flight; response, rejection and abort all release in-flight exactly once; out-of-range/NaN durations set overflow without exposing raw values. `rpcHttpEvidence` V1 remains byte-for-byte shape-compatible.
- [ ] Run focused tests and confirm behavioral failures.
- [ ] Implement `createRpcHttpRoleEvidenceRecorder({ now?: () => number })` returning `begin(providerId, role): (status: number | null) => void` and `snapshot(): RuntimeRpcHttpRoleEvidenceV1`. Time from physical fetch start to HTTP headers with `performance.now`; failures have no header latency. Saturate counters at `Number.MAX_SAFE_INTEGER` and set `overflowed`. Make callbacks instrumentation-safe: exceptions never change fetch/failover outcomes.
- [ ] Extend `createObservedRpcFetch` with optional role recorder/role, and failover options with optional role recorder/role; invoke on each inner physical attempt, never on a cache join or logical retry. Assign `SOURCE` to pinned catch-up, `FINALITY` to pinned finality, `BLOCK_HYDRATION` to pinned block, and `SHARED_CLIENT` to `SolanaRpcClient` including its HTTP-only failover branch. Do not infer worker/health from shared transport.
- [ ] Re-run focused tests, `npm run build`, `npm run check`, `npm run lint`; expect PASS. Commit transport slice.

### Task 3: Durable optional heartbeat and health projection

**Files:** Modify `src/application/production-listener-factory.ts`, `src/storage/transaction-inbox.repository.ts`, `src/storage/api-projection.repository.ts`, `src/api/contracts.ts` and any health parser in the independent frontend; test `tests/production-listener-factory.test.ts`, `tests/transaction-inbox.repository.test.ts`, `tests/api-projection.repository.test.ts`, `tests/api-contracts.test.ts`, relevant frontend tests.

- [ ] Write RED tests for RUNNING and STOPPED heartbeat snapshots with the optional sibling `rpcHttpRoleEvidence`, immutable JSONB clone, absence projected as `null`, malformed stored evidence rejected as a data error, and no secret-bearing fields. An older heartbeat without the sidecar remains accepted. Assert the V1 `rpcHttpEvidence` projection is exactly unchanged.
- [ ] Run focused tests and confirm missing sidecar failures.
- [ ] Thread one process-owned recorder through the factory and heartbeat sampler. Clone/validate the sidecar in `writeHeartbeat`, project it from JSONB into `/api/v1/health`, and add a documented optional V1 API field. Do not introduce a SQL migration or a new endpoint.
- [ ] Re-run focused tests, `npm run check --workspace frontend`, `npm test --workspace frontend`, `npm run build:backend`, `npm run check:backend`, `npm run lint:backend`; expect PASS. Commit persistence/API slice.

### Task 4: Canary non-regression, documentation and full verification

**Files:** Modify `docs/operations/block-hydration-canary.md`, `docs/api/v1.md`, `tests/mainnet-observe-canary-verdict.test.ts`; do **not** relax `scripts/lib/mainnet-observe-canary-verdict.ts`.

- [ ] Write RED regression proving that a valid sibling role snapshot leaves the current 19-gate V1 verdict unchanged and that an absent/overflowed role snapshot cannot be treated as rate-capacity proof. The latter is a documentation/diagnostic requirement, not a new canary PASS gate.
- [ ] Run focused tests, then document exact histogram boundaries, coarse roles, header-only timing, gaps (SDK parse/RSS, other key-sharing processes, project RPS and exit reserve), and aggregate-only handling.
- [ ] Run `npm run build`, `npm run check`, `npm run lint`, `npm test`, `npm run docs:check` and frontend tests. Check host disk before/during heavy commands; pause and safely clean task-owned disposable artifacts at <=5,000,000,000 bytes available. Review diff for URLs, keys, signatures, fixture secrets, behavior changes and missing failure paths.
- [ ] Commit, push and open one focused PR against `main`. Run **one** independent Codex review cycle; address its findings, await green PR CI, merge, then verify exact post-merge CI. Do not run a new Mainnet canary or alter concurrency in this PR.

### Follow-up, not delivered by this plan

Obtain H2e monthly-credit evidence and a dated Helius project-specific RPS/concurrency limit; measure body/parse memory and other key-sharing traffic, reserve live-exit headroom, then choose an explicitly versioned, default-OFF bounded throughput remedy. The 15-minute canary remains FAIL until an exact merged runtime proves all gates.
