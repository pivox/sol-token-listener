# Production Catch-up Admission Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate strict Pump.fun page classification in the production listener behind a restart-only, default-off, observe-only flag while preserving provider affinity and the global block-fetch limits.

**Architecture:** A new provider-affine coordinator owns one block cache and routes it to pinned HTTP providers under a serialized scan/worker permit. The production factory injects a provider-bound classifier/admitter into both catch-up scanners only when the flag is enabled; the inbox worker receives the same coordinator locator and a fail-closed claim gate. Existing heartbeat storage carries additive bounded metrics without another inbox table scan.

**Tech Stack:** TypeScript strict ESM, Node test runner through `tsx`, PostgreSQL 16, `@solana/web3.js`, Zod/Vitest/React for the diagnostic frontend.

---

### Task 1: Add the restart-only safety flag

**Files:**
- Modify: `src/config/env.ts`
- Modify: `tests/config-safety.test.ts`
- Modify: `.env.example`
- Modify: `deploy/env.example`
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Add cases that assert the absent flag is `false`, exact `true` succeeds only with
the complete safe combination, and each incompatible combination fails:

```ts
const safeCatchUpAdmission = Object.freeze({
  ...baseEnvironment(),
  LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED: 'true',
  LISTENER_ENABLED: 'true',
  EXECUTION_MODE: 'observe',
  LISTENER_INGESTION_SCOPE: 'launchpad-only',
  LISTENER_CATCH_UP_POLICY: 'live-edge',
  LISTENER_BLOCK_HYDRATION_ENABLED: 'true',
});

assert.equal(parseConfig(baseEnvironment()).listenerPumpFunCatchUpPageAdmissionEnabled, false);
assert.equal(parseConfig(safeCatchUpAdmission).listenerPumpFunCatchUpPageAdmissionEnabled, true);
for (const patch of [
  { LISTENER_ENABLED: 'false' },
  { EXECUTION_MODE: 'paper' },
  { LISTENER_INGESTION_SCOPE: 'launchpad-and-market' },
  { LISTENER_CATCH_UP_POLICY: 'strict' },
  { LISTENER_BLOCK_HYDRATION_ENABLED: 'false' },
]) {
  assert.throws(() => parseConfig({ ...safeCatchUpAdmission, ...patch }), /catch-up page admission/iu);
}
```

Also reject `TRUE`, `1`, whitespace and empty text using the existing canonical
boolean test pattern.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='catch-up page admission' tests/config-safety.test.ts tests/deployment-artifacts.test.ts
```

Expected: failures because `AppConfig` and environment examples do not contain
the new flag.

- [ ] **Step 3: Implement the minimal config contract**

Add to `AppConfig`:

```ts
readonly listenerPumpFunCatchUpPageAdmissionEnabled: boolean;
```

Parse it with the existing `parseBoolean`, then validate after all dependent
values have been parsed and before returning the config:

```ts
const listenerPumpFunCatchUpPageAdmissionEnabled = parseBoolean(
  environment.LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED,
  false,
  'LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED',
);

if (listenerPumpFunCatchUpPageAdmissionEnabled
  && (!listenerEnabled
    || executionMode !== 'observe'
    || listenerIngestionScope !== 'launchpad-only'
    || listenerCatchUpPolicy !== 'live-edge'
    || !blockHydration.listenerBlockHydrationEnabled
    || expectedGenesisHash === null)) {
  throw new Error('Pump.fun catch-up page admission requires the safe observe-only listener profile.');
}
```

Use local variables for `listenerIngestionScope` and `listenerCatchUpPolicy` so
the exact validated values are returned. Add the flag with value `false` and a
restart-only comment to both environment examples.

- [ ] **Step 4: Verify GREEN**

Run the command from Step 2 and `npm run check:backend`.

Expected: all selected tests pass and TypeScript exits zero.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts tests/config-safety.test.ts .env.example deploy/env.example tests/deployment-artifacts.test.ts
git commit -m "feat(config): gate Pump.fun catch-up admission"
```

### Task 2: Add a fail-closed worker claim gate

**Files:**
- Modify: `src/application/transaction-inbox-worker.ts`
- Modify: `tests/transaction-inbox-worker.test.ts`

- [ ] **Step 1: Write failing worker tests**

Add isolated cases proving:

```ts
let claims = 0;
let ready = false;
const worker = new TransactionInboxWorker(repositoryWith({
  async claim() { claims += 1; return null; },
}), locator(), pipeline(), options({ canClaim: () => ready }));

assert.deepEqual(await worker.runOnce(), { kind: 'idle' });
assert.equal(claims, 0);
ready = true;
assert.deepEqual(await worker.runOnce(), { kind: 'idle' });
assert.equal(claims, 1);
```

Add separate tests for a throwing gate, a runtime non-boolean result, an
accessor/proxy option and the unchanged no-gate path. Throwing and corrupt gates
must produce `TransactionInboxWorkerError` with stage `claim-gate`, set state to
`DEGRADED`, and call neither the clock nor repository.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='claim gate|without a claim gate' tests/transaction-inbox-worker.test.ts
```

Expected: type/test failures because the option and error stage do not exist.

- [ ] **Step 3: Implement the minimal gate**

Extend the public types:

```ts
export type TransactionInboxWorkerErrorStage =
  | 'claim-gate'
  | 'claim'
  | 'save-snapshot'
  | 'mark-failed'
  | 'mark-processed'
  | 'clock';

export interface TransactionInboxWorkerOptions {
  readonly leaseSeconds: number;
  readonly renewalIntervalMs: number;
  readonly idlePollMs: number;
  readonly canClaim?: () => boolean;
  readonly now?: () => number;
  readonly scheduler?: TransactionInboxWorkerScheduler;
}
```

Snapshot and validate the optional function in the constructor. At the start of
`performRunOnce`, after the closed check and before `readNow`, invoke it once:

```ts
if (this.canClaim !== null) {
  let allowed: unknown;
  try { allowed = this.canClaim(); } catch {
    this.reportDegraded();
    throw new TransactionInboxWorkerError('claim-gate');
  }
  if (typeof allowed !== 'boolean') {
    this.reportDegraded();
    throw new TransactionInboxWorkerError('claim-gate');
  }
  if (!allowed) return frozenResult({ kind: 'idle' });
}
```

- [ ] **Step 4: Verify GREEN and regression scope**

Run:

```bash
npx tsx --test tests/transaction-inbox-worker.test.ts tests/transaction-ingestion-recovery.test.ts tests/tracked-trade-ingestion.integration.test.ts
npm run check:backend
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/application/transaction-inbox-worker.ts tests/transaction-inbox-worker.test.ts
git commit -m "feat(listener): gate inbox claims before hydration"
```

### Task 3: Create a pinned block RPC

**Files:**
- Create: `src/solana/rpc/provider-pinned-block-rpc.ts`
- Create: `tests/provider-pinned-block-rpc.test.ts`

- [ ] **Step 1: Write failing provider RPC tests**

Drive this public contract:

```ts
export interface ProviderPinnedBlockRpc extends TransactionBlockRpc {
  readonly providerId: RpcProviderId;
}

export function createProviderPinnedBlockRpc(
  catalog: RpcProviderCatalog,
  providerId: RpcProviderId,
  commitment: Commitment,
  dependencies?: Readonly<{
    createConnection?: (httpUrl: string, commitment: Commitment) => unknown;
  }>,
): ProviderPinnedBlockRpc;
```

Tests must prove the resolved HTTP URL belongs to the requested provider, no
fallback URL is accepted or retained, confirmed/finalized commitments map
exactly, invalid slot/provider/dependency shapes fail redacted, and returned
objects are frozen.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test tests/provider-pinned-block-rpc.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the pinned adapter**

Use `catalog.resolve(providerId).httpUrl` and construct a `Connection` with:

```ts
new Connection(httpUrl, { commitment, disableRetryOnRateLimit: true })
```

Expose only `providerId` and `getBlockTransactions`. The method validates the
bigint slot and calls:

```ts
connection.getBlock(Number(slot), {
  commitment: confirmationStatus === 'FINALIZED' ? 'finalized' : 'confirmed',
  transactionDetails: 'full',
  maxSupportedTransactionVersion: 0,
  rewards: false,
});
```

Follow the descriptor/proxy validation pattern already used by
`provider-pinned-catch-up-source.ts`; never expose the URL in an error.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command plus:

```bash
npx tsx --test tests/provider-pinned-catch-up-source.test.ts tests/rpc-provider-catalog.test.ts
npm run check:backend
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/solana/rpc/provider-pinned-block-rpc.ts tests/provider-pinned-block-rpc.test.ts
git commit -m "feat(rpc): add provider-pinned block source"
```

### Task 4: Build the provider-affine hydration coordinator

**Files:**
- Create: `src/application/provider-affine-catch-up-hydration.ts`
- Create: `tests/provider-affine-catch-up-hydration.test.ts`

- [ ] **Step 1: Write failing coordinator identity and routing tests**

Specify the public surface:

```ts
export interface ProviderAffineCatchUpHydrationOptions extends BlockTransactionCacheOptions {
  readonly currentSelection: () => PromotedProviderSelection;
}

export class ProviderAffineCatchUpHydration {
  public constructor(
    providers: ReadonlyMap<RpcProviderId, TransactionBlockRpc>,
    options: ProviderAffineCatchUpHydrationOptions,
  );
  public workerLocator(): TransactionInboxWorkerLocator;
  public classifierLocator(providerId: RpcProviderId): PumpFunCatchUpTransactionLocator;
  public runStrictScan(
    providerId: RpcProviderId,
    scan: (signal: AbortSignal) => Promise<StrictCatchUpScanResult>,
    signal: AbortSignal,
  ): Promise<StrictCatchUpScanResult>;
  public canWorkerClaim(): boolean;
  public metrics(): RuntimeBlockHydrationMetricsV1;
  public state(): Readonly<{
    providerId: RpcProviderId | null;
    scanActive: boolean;
    workerClaimReady: boolean;
  }>;
  public close(): void;
}
```

Tests prove exactly one underlying cache, one active fetch, same-slot sharing,
global 250 ms pacing, provider-bound classifier routing and worker routing to
the snapshotted promoted provider.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test tests/provider-affine-catch-up-hydration.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement routing epochs and frozen locators**

Inside the coordinator, create a routing RPC implementing
`EpochTransactionBlockRpc`. It stores a local context key and increments a safe
integer epoch whenever the key changes:

```ts
type RouteContext = Readonly<{
  providerId: RpcProviderId;
  token: string;
}>;

const bind = (context: RouteContext): void => {
  if (active?.providerId === context.providerId && active.token === context.token) return;
  active = context;
  epoch = epoch === Number.MAX_SAFE_INTEGER ? 0 : epoch + 1;
};
```

Worker tokens include the exact promotion revision; scan tokens use an internal
monotonic scan generation. `getBlockTransactions` delegates only to the active
provider RPC. The shared cache therefore invalidates itself through
`httpTransportEpoch` before using a different context.

- [ ] **Step 4: Write RED tests for exclusion, ABA and shutdown**

Add tests proving:

- a queued scan runs after the current worker locate and before later workers;
- classifier locates succeed only inside the matching scan permit;
- no worker fetch starts during an active scan;
- promotion A → B and A → null → A both reject the old worker result retryably;
- an old-provider result is never retained after a context change;
- abort before/while queued starts no fetch;
- close rejects queued operations, clears the cache once and makes the claim
  gate false;
- thrown selection providers and hostile provider maps expose fixed errors only.

- [ ] **Step 5: Verify RED for the new cases**

Run the Step 2 command.

Expected: the new lifecycle tests fail before queue/exclusion logic exists.

- [ ] **Step 6: Implement the permit queue and lifecycle**

Use an explicit FIFO array of frozen `WORKER` and `SCAN` waiters. Once a scan is
queued, enqueue later workers after it. A scan holds the permit for the complete
callback; its provider-bound locators bypass the outer queue only while the
matching scan generation is active. Always release in `finally`, observe abort
before and after awaited boundaries, and map unknown failures to trusted
retryable locator failures or one fixed coordinator error.

`canWorkerClaim()` returns true only when open, the current selection contains a
provider, no scan is active and no scan waits in the queue.

- [ ] **Step 7: Verify GREEN and existing cache behavior**

Run:

```bash
npx tsx --test tests/provider-affine-catch-up-hydration.test.ts tests/block-transaction-cache.test.ts tests/transaction-locator.test.ts
npm run check:backend
npx eslint src/application/provider-affine-catch-up-hydration.ts tests/provider-affine-catch-up-hydration.test.ts --max-warnings=0
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/application/provider-affine-catch-up-hydration.ts tests/provider-affine-catch-up-hydration.test.ts
git commit -m "feat(listener): coordinate provider-affine catch-up hydration"
```

### Task 5: Wire the classifier into the production factory

**Files:**
- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `tests/bootstrap-safety.test.ts`
- Modify: `tests/websocket-failover-supervisor.integration.test.ts`

- [ ] **Step 1: Write failing factory tests with the flag off**

Assert that `false` constructs no `ProviderAffineCatchUpHydration`, classifier
or admitter, uses the current worker locator and passes no page admitter to either
scanner. Verify existing launchpad-and-market composition remains valid.

- [ ] **Step 2: Write failing factory tests with the flag on**

Assert one coordinator/cache, one pinned block RPC per catalog provider, one
classifier/admitter per provider, and the same provider admitter in both the
live-edge and recovery scanner. Assert the scanner program list remains
launchpad-only and PumpSwap never reaches the Pump.fun classifier.

The supervisor callback must call:

```ts
hydration.runStrictScan(providerId, (scanSignal) => coordinator.run(scanSignal), signal)
```

The worker must receive:

```ts
hydration.workerLocator()
canClaim: (): boolean => hydration.canWorkerClaim()
```

- [ ] **Step 3: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='catch-up admission|provider-affine' tests/production-listener-factory.test.ts tests/bootstrap-safety.test.ts tests/websocket-failover-supervisor.integration.test.ts
```

Expected: failures because the flag has no composition effect.

- [ ] **Step 4: Implement conditional composition**

Move promoted-selector construction before block hydration. When the flag is
off, retain `createProductionBlockHydration(config, rpc)`. When on:

1. create the provider-pinned block RPC map;
2. create one provider-affine coordinator with the existing cache bounds;
3. for each provider, create `PumpFunCatchUpBlockClassifier`,
   `PumpFunStrictCatchUpPageAdmitter`, strict scanner and baseline scanner;
4. give scanner constructors their provider admitter as the fourth argument;
5. wrap strict scanning through the coordinator permit;
6. give the worker the coordinator locator and claim gate;
7. ensure shutdown closes the coordinator only after worker close.

Do not modify the PumpSwap pipeline, finality reconciler or any execution
component.

- [ ] **Step 5: Add offline end-to-end recovery cases**

Extend the existing failover integration fixture to prove fresh live-edge
baseline, a restart gap, create plus initial buy, tracked trade priority,
untracked trade deferral, ignore/quarantine, WebSocket overlap, exact checkpoint
advance, replay, provider failover, finality and orphan behavior without network
access.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npx tsx --test tests/production-listener-factory.test.ts tests/bootstrap-safety.test.ts tests/websocket-failover-supervisor.integration.test.ts tests/pumpfun-catch-up-block-classifier.test.ts tests/pumpfun-strict-catch-up-page-admitter.test.ts tests/strict-catch-up-scanner.test.ts
npm run check:backend
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/application/production-listener-factory.ts tests/production-listener-factory.test.ts tests/bootstrap-safety.test.ts tests/websocket-failover-supervisor.integration.test.ts
git commit -m "feat(listener): activate strict Pump.fun page admission"
```

### Task 6: Persist exact catch-up admission metrics

**Files:**
- Modify: `src/domain/transaction-ingestion.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/transaction-ingestion-contracts.test.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `tests/production-listener-factory.test.ts`

- [ ] **Step 1: Write failing domain and PostgreSQL tests**

Add `CatchUpAdmissionCounts` to `InboxCounts` with exact nested source and
priority categories plus deferred/ignored/quarantined counts. Seed rows for each
source combination, priority and disposition and assert:

```ts
assert.equal(
  counts.catchUpAdmission.actionableBacklogBySource.websocketOnly
    + counts.catchUpAdmission.actionableBacklogBySource.catchUpOnly
    + counts.catchUpAdmission.actionableBacklogBySource.websocketAndCatchUp,
  counts.pending + counts.processing + counts.retryableFailed,
);
assert.equal(
  counts.catchUpAdmission.actionableBacklogByPriority.normal
    + counts.catchUpAdmission.actionableBacklogByPriority.launchCandidate
    + counts.catchUpAdmission.actionableBacklogByPriority.trackedTrade,
  counts.pending + counts.processing + counts.retryableFailed,
);
```

Use the repository's actual actionability predicate for both dimensions so
terminal and non-retryable rows are excluded identically.

- [ ] **Step 2: Verify RED**

Start the disposable PostgreSQL 16 service used by Tasks 6 and 9:

```bash
docker rm -f sol-listener-137-pg16 2>/dev/null || true
docker run -d --name sol-listener-137-pg16 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=sol_listener_test \
  -p 127.0.0.1:55440:5432 \
  --tmpfs /var/lib/postgresql/data:rw,size=5368709120 postgres:16
until docker exec sol-listener-137-pg16 pg_isready -U postgres -d sol_listener_test; do sleep 1; done
```

Run:

```bash
TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55440/sol_listener_test \
  npx tsx --test --test-name-pattern='catch-up admission counts|InboxCounts' \
  tests/transaction-inbox.repository.test.ts tests/transaction-ingestion-contracts.test.ts
```

Expected: failures because the count contract is absent.

- [ ] **Step 3: Extend the existing aggregate query**

Add all metrics as `COUNT(*) FILTER (...)` expressions to the current single
`counts()` SELECT. Return a deeply frozen `catchUpAdmission` value, validate each
count as a safe non-negative integer and validate both actionable sums. Do not
issue another query.

Update exact count fixtures and repository stubs throughout affected tests.

- [ ] **Step 4: Add heartbeat metric composition tests**

Extend `RuntimeHeartbeat` with optional
`RuntimeCatchUpAdmissionMetricsV1`. Add a heartbeat option:

```ts
readonly catchUpAdmissionMetrics?: (
  counts: InboxCounts,
) => RuntimeCatchUpAdmissionMetricsV1;
```

With the flag off, omit the payload field. With the flag on, combine the
repository counts with coordinator state and write one frozen V1 object. Invalid
provider state or count sums must reject the heartbeat write.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55440/sol_listener_test \
  npx tsx --test tests/transaction-inbox.repository.test.ts \
  tests/transaction-ingestion-contracts.test.ts tests/production-listener-factory.test.ts
npm run check:backend
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/domain/transaction-ingestion.ts src/storage/transaction-inbox.repository.ts src/application/production-listener-factory.ts tests/transaction-ingestion-contracts.test.ts tests/transaction-inbox.repository.test.ts tests/production-listener-factory.test.ts
git commit -m "feat(listener): persist catch-up admission diagnostics"
```

### Task 7: Expose additive health contracts and diagnostics

**Files:**
- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `frontend/src/data/api-schemas.ts`
- Modify: `frontend/src/data/api-schemas.test.ts`
- Modify: `frontend/src/features/health/health-page.tsx`
- Modify: `frontend/src/features/health/health-page.test.tsx`

- [ ] **Step 1: Write failing API projection tests**

Assert absent payload stays `null`, a canonical V1 payload is projected exactly,
and unknown provider IDs, extra fields, negative/unsafe counts, inconsistent
sums, URLs, signatures and mints fail with the existing redacted projection
error.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='catch-up admission' tests/api-contracts.test.ts tests/api-projection.repository.test.ts
npm test --workspace frontend -- --run api-schemas.test.ts health-page.test.tsx
```

Expected: failures because the public contract is absent.

- [ ] **Step 3: Implement backend and frontend contracts**

Add the exact optional `catchUpAdmission` health field and parse it with exact
keys. Use `RpcProviderId | null` and decimal JSON numbers only for bounded
diagnostic counts. In the health page render enabled/provider/scan/claim state,
the three source counts, three priority counts and disposition counts. Render
`Non activé` when the field is absent; do not infer enabled state from block
hydration.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 commands plus `npm run check`.

Expected: backend and frontend contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/contracts.ts src/storage/api-projection.repository.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts frontend/src/data/api-schemas.ts frontend/src/data/api-schemas.test.ts frontend/src/features/health/health-page.tsx frontend/src/features/health/health-page.test.tsx
git commit -m "feat(api): expose catch-up admission health"
```

### Task 8: Document activation, rollback and the canary gate

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/api/v1.md`
- Modify: `docs/operations/block-hydration-canary.md`
- Modify: `scripts/deployment-smoke.mjs` only if its exact environment allowlist requires the new variable
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] **Step 1: Write failing documentation assertions**

Assert the docs state the exact flag/default, all activation preconditions,
restart-only semantics, provider affinity, rollback, no wallet/executor, metric
field names and the separate post-merge 15-minute Mainnet canary.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='catch-up admission' tests/deployment-artifacts.test.ts
npm run docs:check
```

Expected: the new assertions fail.

- [ ] **Step 3: Update the operator and API documentation**

Document the exact safe activation profile:

```dotenv
EXECUTION_MODE=observe
LISTENER_ENABLED=true
LISTENER_INGESTION_SCOPE=launchpad-only
LISTENER_CATCH_UP_POLICY=live-edge
LISTENER_BLOCK_HYDRATION_ENABLED=true
LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=true
```

State that activation requires a restart, rollback sets the final flag to
`false`, no private key is read, and the canary must verify zero 429, bounded
backlog/RSS, finality/idempotence/retention, provider affinity and clean
shutdown. Do not claim Mainnet readiness before that run.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 commands and `npm run deployment:smoke` after a build.

Expected: documentation and deployment contracts pass.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture/pumpfun-v1.md docs/api/v1.md docs/operations/block-hydration-canary.md scripts/deployment-smoke.mjs tests/deployment-artifacts.test.ts
git commit -m "docs(listener): document catch-up admission canary"
```

If `scripts/deployment-smoke.mjs` is unchanged, omit it from `git add`.

### Task 9: Final integration and pull request

**Files:**
- Review all files changed since `origin/main`

- [ ] **Step 1: Recreate a clean disposable PostgreSQL 16 instance**

Recreate only the task-owned container so the full suite starts with an empty
5 GiB tmpfs. Never reuse or modify the Mainnet preflight database:

```bash
docker rm -f sol-listener-137-pg16
docker run -d --name sol-listener-137-pg16 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=sol_listener_test \
  -p 127.0.0.1:55440:5432 \
  --tmpfs /var/lib/postgresql/data:rw,size=5368709120 postgres:16
until docker exec sol-listener-137-pg16 pg_isready -U postgres -d sol_listener_test; do sleep 1; done
```

- [ ] **Step 2: Run focused PostgreSQL integration tests**

```bash
TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55440/sol_listener_test \
  npx tsx --test tests/transaction-inbox.repository.test.ts \
  tests/websocket-failover-supervisor.integration.test.ts
```

Expected: zero failures.

- [ ] **Step 3: Run the complete acceptance gate**

```bash
npm run build
npm run check
npm run lint
npm run docs:check
TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55440/sol_listener_test npm test
git diff --check
```

Expected: every command exits zero; PostgreSQL-only skips are limited to tests
that require separately provisioned restricted roles.

- [ ] **Step 4: Review safety and scope**

Confirm the diff contains no private key, wallet path, live executor import,
transaction submission, production environment value, unbounded queue, second
inbox count query or PumpSwap classification. Confirm flag-off tests prove the
old composition.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/137-production-catch-up-admission
gh pr create --base main --head feat/137-production-catch-up-admission \
  --title "feat(listener): activate provider-affine catch-up admission" \
  --body "Closes #137. Advances #120. Activation remains restart-only, observe-only and OFF by default. No wallet or transaction execution is introduced."
pr_number=$(gh pr view --json number --jq .number)
gh pr comment "$pr_number" --body '@codex please review this PR. Focus on provider affinity, scanner/worker exclusion, restart safety, RPC pacing, checkpoint idempotence, metrics integrity, shutdown, and flag-off regressions. Please post concrete review threads.'
```

Expected: CI starts on the exact pushed head. Apply at most two total review
cycles, merge only with all checks green and no unresolved blocking threads,
then verify post-merge CI before the separate Mainnet canary.
