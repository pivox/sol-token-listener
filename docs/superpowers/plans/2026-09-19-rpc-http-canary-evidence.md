# RPC HTTP Canary Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist bounded and redacted evidence for every physical Solana RPC HTTP attempt and real HTTP 429 used by the observe-only listener.

**Architecture:** One process-local recorder owns fixed-cardinality counters for the four public provider IDs. The failover loop records dynamic physical attempts directly, while mono-provider SDK connections use a provider-bound fetch wrapper exactly once. Fresh detached snapshots flow through the existing listener heartbeat into PostgreSQL, API V1, and the diagnostic frontend.

**Tech Stack:** TypeScript strict ESM, Node fetch, `@solana/web3.js`, PostgreSQL heartbeat JSON, Zod, React/Vitest, Node test runner.

---

### Task 1: Fixed-cardinality evidence recorder

**Files:**
- Create: `src/domain/rpc-http-evidence.ts`
- Create: `src/solana/rpc/rpc-http-evidence.ts`
- Create: `tests/rpc-http-evidence.test.ts`

- [ ] **Step 1: Write failing domain tests**

Cover exact provider order, configured flags, one attempt, one 429, detached and frozen snapshots, invalid provider rejection, counter saturation, permanent overflow, and `http429Responses <= attempts`.

```ts
const recorder = createRpcHttpEvidenceRecorder();
recorder.recordAttempt('primary');
recorder.recordHttp429('primary');
const snapshot = recorder.snapshot(['primary']);
assert.deepEqual(snapshot.providers.map(({ providerId }) => providerId), RPC_PROVIDER_IDS);
assert.deepEqual(snapshot.providers[0], {
  providerId: 'primary', configured: true, attempts: 1, http429Responses: 1,
});
assert.equal(snapshot.overflowed, false);
assert.ok(Object.isFrozen(snapshot));
```

- [ ] **Step 2: Run the test and observe RED**

Run: `tsx --test tests/rpc-http-evidence.test.ts`

Expected: failure because `rpc-http-evidence.ts` does not exist.

- [ ] **Step 3: Implement the recorder and provider-bound wrapper**

Define the versioned evidence types and strict snapshot validator in
`src/domain/rpc-http-evidence.ts`. Define and export the mutable process-local
recorder and fetch wrapper from `src/solana/rpc/rpc-http-evidence.ts`:

```ts
export interface RpcHttpEvidenceRecorder {
  recordAttempt(providerId: RpcProviderId): void;
  recordHttp429(providerId: RpcProviderId): void;
  snapshot(configuredProviderIds: readonly RpcProviderId[]): RuntimeRpcHttpEvidenceV1;
}

export function createRpcHttpEvidenceRecorder(): RpcHttpEvidenceRecorder;

export function createObservedRpcFetch(
  providerId: RpcProviderId,
  recorder: RpcHttpEvidenceRecorder,
  fetchImplementation?: FetchFn,
): FetchFn;
```

`createObservedRpcFetch` must call `recordAttempt` immediately before fetch and
`recordHttp429` immediately after a returned `Response` with `status === 429`.
It must not inspect or retain input, URL, headers, method, or body.

Use safe integers. Increment until `Number.MAX_SAFE_INTEGER`; later increments
leave the saturated value and permanently set `overflowed=true`. Snapshot the
four `RPC_PROVIDER_IDS` in their canonical order and freeze every object/array.
An impossible `recordHttp429` without a preceding unmatched attempt must not
throw into the transport; preserve the counter invariant and set overflowed so
the evidence is unusable for PASS.

- [ ] **Step 4: Run focused verification**

Run:

```bash
tsx --test tests/rpc-http-evidence.test.ts
npm run check:backend
npm run lint:backend -- --no-warn-ignored src/domain/rpc-http-evidence.ts src/solana/rpc/rpc-http-evidence.ts tests/rpc-http-evidence.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/rpc-http-evidence.ts src/solana/rpc/rpc-http-evidence.ts tests/rpc-http-evidence.test.ts
git commit -m "feat(listener): collect bounded RPC HTTP evidence"
```

### Task 2: Main RPC client and failover attempts

**Files:**
- Modify: `src/solana/rpc/http-failover-transport.ts`
- Modify: `src/solana/rpc/rpc-client.ts`
- Modify: `tests/http-failover-transport.test.ts`
- Modify: `tests/rpc-client.test.ts`

- [ ] **Step 1: Add RED tests for physical-attempt semantics**

Add tests proving:

- no-fallback `SolanaRpcClient` records one attempt and one returned 429;
- primary 429 followed by fallback success records one attempt per provider and
  only one 429 for primary;
- a network throw still records the attempt;
- an already-aborted signal records nothing;
- a response-body or cancellation failure after headers preserves the 429;
- the failover fetch is not wrapped a second time.

- [ ] **Step 2: Run RED tests**

Run:

```bash
tsx --test tests/http-failover-transport.test.ts tests/rpc-client.test.ts
```

Expected: new metric assertions fail.

- [ ] **Step 3: Instrument exactly once**

Extend `RpcHttpFailoverFetchOptions` with an optional typed recorder. Inside the
loop, after abort checks and before `fetch(rewrittenInput, init)`, record the
selected endpoint attempt. Immediately after the response returns, record a
429 when `response.status === 429`, before `transientReason`, cooldown, or body
cancellation.

Extend `SolanaRpcClientDependencies` with the recorder. With fallbacks, pass it
only to `createRpcHttpFailoverFetch`. Without fallbacks, configure the SDK
connection with `createObservedRpcFetch('primary', recorder, dependencies.fetch)`.
If the recorder is absent, preserve current transport construction exactly.

- [ ] **Step 4: Run focused tests and strict checks**

Run:

```bash
tsx --test tests/rpc-http-evidence.test.ts tests/http-failover-transport.test.ts tests/rpc-client.test.ts
npm run check:backend
npm run lint:backend -- --no-warn-ignored src/solana/rpc/http-failover-transport.ts src/solana/rpc/rpc-client.ts tests/http-failover-transport.test.ts tests/rpc-client.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/solana/rpc/http-failover-transport.ts src/solana/rpc/rpc-client.ts tests/http-failover-transport.test.ts tests/rpc-client.test.ts
git commit -m "feat(listener): measure main RPC HTTP attempts"
```

### Task 3: Provider-pinned read transports

**Files:**
- Modify: `src/solana/rpc/provider-pinned-block-rpc.ts`
- Modify: `src/solana/rpc/provider-pinned-catch-up-source.ts`
- Modify: `src/solana/rpc/provider-pinned-finality-source.ts`
- Modify: `tests/provider-pinned-block-rpc.test.ts`
- Modify: `tests/provider-pinned-catch-up-source.test.ts`
- Modify: `tests/provider-pinned-finality-source.test.ts`

- [ ] **Step 1: Add RED tests for every pinned boundary**

For block, catch-up page, genesis, and finality, inject a recorder and assert
one attempt per physical fetch and one count for a returned HTTP 429. Include a
genesis/body failure case to prove the response is counted before parsing.

- [ ] **Step 2: Run RED tests**

Run:

```bash
tsx --test tests/provider-pinned-block-rpc.test.ts tests/provider-pinned-catch-up-source.test.ts tests/provider-pinned-finality-source.test.ts
```

Expected: factories do not yet accept or use the recorder.

- [ ] **Step 3: Add explicit instrumentation parameters**

Add an optional final `RpcHttpEvidenceRecorder` parameter to each factory. Do
not add arbitrary fields to strict dependency records.

Default SDK connections use:

```ts
new Connection(httpUrl, {
  commitment,
  disableRetryOnRateLimit: true,
  fetch: createObservedRpcFetch(providerId, recorder),
});
```

When the recorder is absent, keep the existing connection configuration.
Genesis must use the same provider-bound wrapper around its direct fetch. Do
not wrap test-provided RPC objects because they represent an already-defined
dependency boundary rather than a production physical transport.

- [ ] **Step 4: Verify pinned transports**

Run:

```bash
tsx --test tests/provider-pinned-block-rpc.test.ts tests/provider-pinned-catch-up-source.test.ts tests/provider-pinned-finality-source.test.ts
npm run check:backend
npm run lint:backend -- --no-warn-ignored src/solana/rpc/provider-pinned-block-rpc.ts src/solana/rpc/provider-pinned-catch-up-source.ts src/solana/rpc/provider-pinned-finality-source.ts
```

Expected: all pass, with unchanged redacted public errors.

- [ ] **Step 5: Commit**

```bash
git add src/solana/rpc/provider-pinned-block-rpc.ts src/solana/rpc/provider-pinned-catch-up-source.ts src/solana/rpc/provider-pinned-finality-source.ts tests/provider-pinned-block-rpc.test.ts tests/provider-pinned-catch-up-source.test.ts tests/provider-pinned-finality-source.test.ts
git commit -m "feat(listener): measure provider-pinned RPC reads"
```

### Task 4: Runtime heartbeat and production composition

**Files:**
- Modify: `src/domain/transaction-ingestion.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-ingestion-contracts.test.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`

- [ ] **Step 1: Write RED domain, composition, and persistence tests**

Tests must prove exact snapshot keys/order, rejection of proxies/accessors/extra
fields, `http429Responses <= attempts`, configured-provider consistency,
detachment from callback-owned objects, persistence on RUNNING and STOPPED
heartbeats, and omission compatibility for historical heartbeats.

- [ ] **Step 2: Run RED tests**

Run:

```bash
tsx --test tests/transaction-ingestion-contracts.test.ts tests/production-listener-factory.test.ts tests/transaction-inbox.repository.test.ts
```

Expected: new heartbeat evidence is absent.

- [ ] **Step 3: Extend the heartbeat contract**

Import `RuntimeRpcHttpEvidenceV1` and its strict snapshot validator from the
domain module created in Task 1, then add optional
`RuntimeHeartbeat.rpcHttpEvidence` to `transaction-ingestion.ts`. Validation
must accept old heartbeats with the field omitted and must retain only a newly
frozen detached value.

Extend `PersistentListenerHeartbeatOptions` with:

```ts
readonly rpcHttpEvidenceMetrics?: () => RuntimeRpcHttpEvidenceV1;
```

Snapshot it for every RUNNING and STOPPED write. Validation failures fail the
heartbeat write closed; they never silently project zero.

- [ ] **Step 4: Wire one shared recorder in production**

In `createProductionListenerRuntime`, create one recorder, inject it into the
main RPC client and every pinned factory, and provide this callback to the
heartbeat:

```ts
rpcHttpEvidenceMetrics: () => recorder.snapshot(providers.ids),
```

No second recorder may be created inside a transport.

- [ ] **Step 5: Verify heartbeat behavior**

Run the focused tests with the existing single PostgreSQL 16 container only
for repository cases. Stop it immediately afterward.

Expected: tests pass and the stored JSON contains only the fixed evidence
fields.

- [ ] **Step 6: Commit**

```bash
git add src/domain/transaction-ingestion.ts src/application/production-listener-factory.ts src/storage/transaction-inbox.repository.ts tests/transaction-ingestion-contracts.test.ts tests/production-listener-factory.test.ts tests/transaction-inbox.repository.test.ts
git commit -m "feat(listener): persist RPC HTTP evidence heartbeat"
```

### Task 5: API V1 and diagnostic frontend

**Files:**
- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `frontend/src/data/api-schemas.ts`
- Modify: `frontend/src/features/health/health-page.tsx`
- Modify: `frontend/src/features/health/health-page.test.tsx`

- [ ] **Step 1: Add RED API and frontend tests**

Cover a valid four-provider snapshot, omitted legacy field, explicit `null`,
counter inconsistency, overflow, provider order drift, extra fields, and UI
rendering without endpoint information.

- [ ] **Step 2: Run RED tests**

Run:

```bash
tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts
npm test --workspace frontend -- src/features/health/health-page.test.tsx
```

Expected: new contract assertions fail.

- [ ] **Step 3: Implement additive projection and schema**

Add `ApiRpcHttpEvidenceV1` to `ApiHeartbeat` as an optional nullable field.
Parse `heartbeat_payload.rpcHttpEvidence` using exact data descriptors, fixed
provider IDs/order, safe counts, and invariant checks. Missing historical data
returns `null`; malformed present data fails the projection rather than
becoming zero.

Add the equivalent strict Zod schema. The health card displays availability,
overflow state, and one row per fixed provider with configured/attempt/429
counts. No URL, method, body, signature, or mint field exists in the type.

- [ ] **Step 4: Verify API/frontend**

Run:

```bash
tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts
npm test --workspace frontend
npm run check
npm run lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/contracts.ts src/storage/api-projection.repository.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts frontend/src/data/api-schemas.ts frontend/src/features/health/health-page.tsx frontend/src/features/health/health-page.test.tsx
git commit -m "feat(api): expose RPC HTTP canary evidence"
```

### Task 6: Canary verdict and documentation

**Files:**
- Modify: `docs/operations/block-hydration-canary.md`
- Modify: `docs/superpowers/specs/2026-09-19-rpc-http-canary-evidence-design.md`
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Add RED documentation assertions**

Require the runbook to state the T0/T+5/T+15/final snapshots, positive attempt
delta, zero 429 delta, same `startedAt`, stable provider membership, overflow
rejection, and INCONCLUSIVE outcomes for restart/missing final/zero traffic.

- [ ] **Step 2: Run RED documentation tests**

Run: `tsx --test tests/deployment-artifacts.test.ts`

Expected: assertions for the new evidence fail.

- [ ] **Step 3: Update the runbook and bump the spec to 1.1.0 if behavior changed**

Document exact redacted `jq` fields and the verdict matrix. Explicitly state
that #142 proves only the HTTP-429 gate and that #143 is still required for the
latency gate. Keep URLs, keys, signatures, mints, and block bodies out of all
examples.

- [ ] **Step 4: Verify documentation**

Run:

```bash
tsx --test tests/deployment-artifacts.test.ts
npm run docs:check
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add docs/operations/block-hydration-canary.md docs/superpowers/specs/2026-09-19-rpc-http-canary-evidence-design.md tests/deployment-artifacts.test.ts
git commit -m "docs(listener): attest RPC HTTP canary evidence"
```

### Task 7: Final verification, review, and PR

**Files:**
- Verify all files changed since `origin/main`
- Update only the ignored `.codex-work-tracking.md` locally

- [ ] **Step 1: Run focused security and scope review**

Inspect the diff for URLs, headers, response bodies, arbitrary labels, wallet
code, signing, submission, double wrapping, and non-listener executor changes.

- [ ] **Step 2: Run the complete local gate**

With one synchronized PostgreSQL 16 container and a fresh named database, run:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
npm test
```

Stop PostgreSQL immediately afterward. Expected: zero failures and only the
repository's documented skips.

- [ ] **Step 3: Run two review cycles maximum**

First perform independent spec compliance and code-quality review. Push the
branch, open one PR closing #142, request GitHub Codex review, and address only
actionable findings. Do not exceed two GitHub review cycles.

- [ ] **Step 4: Merge only on green evidence**

Require all PR checks green, no unresolved blocking thread, and a clean merge
state. Merge without bypassing protection, then require post-merge `main` CI
green before starting #143.
