# PR J1 Transaction Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Démarrer par défaut un listener Pump.fun/PumpSwap observation-only qui persiste chaque signature avant traitement, reprend sans perte et alimente les projections existantes.

**Architecture:** WebSocket et rattrapage HTTP alimentent une inbox PostgreSQL. Un worker séquentiel localise l'index canonique puis exécute launchpad → funding → I1 → I2 → PumpSwap ; un reconciler rejoue la finalité. `ListenerRuntime` orchestre le cycle de vie et expose son état réel.

**Tech Stack:** TypeScript strict ESM, Node.js 22, `@solana/web3.js`, PostgreSQL, `pg`, `node:test`, bigint.

---

### Task 1: Contrats et configuration sûre

**Files:**
- Create: `src/domain/transaction-ingestion.ts`
- Modify: `src/config/env.ts`, `.env.example`
- Test: `tests/transaction-ingestion-contracts.test.ts`, `tests/config-safety.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
assert.deepEqual(TRANSACTION_INBOX_STATUSES,
  ['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED']);
assert.deepEqual(LISTENER_RUNTIME_STATES,
  ['STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED']);
const config = parseConfig(validEnvironment());
assert.equal(config.listenerEnabled, true);
assert.equal(config.listenerWorkerLeaseSeconds, 120);
assert.equal(config.listenerCatchUpMaxPages, 20);
assert.equal(config.listenerCatchUpPageSize, 100);
assert.equal(config.listenerFinalityMissingPolls, 3);
assert.equal(config.listenerShutdownTimeoutMs, 30_000);
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test tests/transaction-ingestion-contracts.test.ts tests/config-safety.test.ts
```

- [ ] **Step 3: Implement contracts and validators**

```ts
export const TRANSACTION_INBOX_STATUSES =
  Object.freeze(['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'] as const);
export const LISTENER_RUNTIME_STATES =
  Object.freeze(['STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED'] as const);
export type TransactionDiscoverySource = 'WEBSOCKET' | 'CATCH_UP';
export type TransactionIngestionErrorCode =
  | 'RPC_TRANSIENT' | 'TRANSACTION_NOT_AVAILABLE'
  | 'BLOCK_NOT_AVAILABLE' | 'TRANSACTION_INDEX_NOT_FOUND'
  | 'NORMALIZATION_FAILED' | 'PIPELINE_STAGE_FAILED'
  | 'FINALITY_INCONSISTENT' | 'CATCH_UP_WINDOW_EXCEEDED';
```

Add frozen validated contracts for notification, claim, failure, checkpoint,
finality candidate and heartbeat. Slots are bigint; times are canonical integer
milliseconds; counts are non-negative safe integers.

- [ ] **Step 4: Add config defaults and bounds**

`LISTENER_ENABLED=true`; lease 30–900 seconds, default 120; catch-up pages
1–100, default 20; page size 1–1000, default 100; missing polls 2–20, default
3; shutdown 1000–120000 ms, default 30000. Reuse existing retry/reconcile
settings.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npx tsx --test tests/transaction-ingestion-contracts.test.ts tests/config-safety.test.ts
npm run check
npm run lint
git add .env.example src/config/env.ts src/domain/transaction-ingestion.ts tests/config-safety.test.ts tests/transaction-ingestion-contracts.test.ts
git commit -m "feat: define durable transaction ingestion contracts"
```

### Task 2: Migration 009 et port inbox

**Files:**
- Create: `migrations/009_transaction_ingestion.sql`
- Create: `src/ports/transaction-inbox-repository.ts`
- Modify: `src/storage/database.ts`
- Test: `tests/transaction-ingestion-migration.test.ts`

- [ ] **Step 1: Write failing schema tests**

```ts
assert.match(sql, /chain_transaction_inbox/u);
assert.match(sql, /signature TEXT PRIMARY KEY/u);
assert.match(sql, /normalized_transaction JSONB/u);
assert.match(sql, /immutable_fingerprint TEXT/u);
assert.match(sql, /missing_finality_polls/u);
```

The live test applies migrations 001–009 twice on an empty schema.

- [ ] **Step 2: Verify RED**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/transaction-ingestion-migration.test.ts
```

- [ ] **Step 3: Implement schema**

Create signature PK; observed slot; discovery sources; target confirmation;
processing status; attempts; missing polls; lease token/expiry; next attempt;
normalized JSONB/fingerprint pair; safe error code/name; observed, processed,
terminal and purge times. Add claim/finality/purge indexes and strict checks.
Extend `listener_heartbeats` with runtime and component states plus leased
count. Seed no checkpoint.

- [ ] **Step 4: Define repository port**

```ts
export interface TransactionInboxRepository {
  enqueue(value: TransactionNotification): Promise<void>;
  claim(nowMs: number, leaseSeconds: number): Promise<ClaimedTransaction | null>;
  renewLease(signature: string, token: string, untilMs: number): Promise<void>;
  saveSnapshot(signature: string, token: string, tx: NormalizedTransaction): Promise<void>;
  markProcessed(signature: string, token: string, status: ChainConfirmationStatus): Promise<void>;
  markFailed(signature: string, token: string, failure: IngestionFailure): Promise<void>;
  listForFinality(limit: number): Promise<readonly FinalityCandidate[]>;
  enqueueRevision(value: FinalityRevision): Promise<void>;
  readCheckpoint(key: 'launchpad' | 'market'): Promise<ProcessingCheckpoint | null>;
  storeCheckpoint(value: ProcessingCheckpoint): Promise<void>;
  writeHeartbeat(value: RuntimeHeartbeat): Promise<void>;
  counts(): Promise<InboxCounts>;
}
```

- [ ] **Step 5: Add purge, verify and commit**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/transaction-ingestion-migration.test.ts tests/api-event-stream-migration.test.ts
npm run check
git add migrations/009_transaction_ingestion.sql src/ports/transaction-inbox-repository.ts src/storage/database.ts tests/transaction-ingestion-migration.test.ts tests/api-event-stream-migration.test.ts
git commit -m "feat: add durable Solana transaction inbox schema"
```

### Task 3: PostgreSQL inbox repository

**Files:**
- Create: `src/storage/transaction-inbox.repository.ts`
- Test: `tests/transaction-inbox.repository.test.ts`

- [ ] **Step 1: Write RED tests**

```ts
await repository.enqueue(notification('sig', 10n, 'WEBSOCKET'));
await repository.enqueue(notification('sig', 10n, 'CATCH_UP'));
assert.deepEqual((await readInbox(pool, 'sig')).discovery_sources.sort(),
  ['CATCH_UP', 'WEBSOCKET']);
const first = await repository.claim(now, 120);
assert.equal(await repository.claim(now + 1_000, 120), null);
assert.notEqual((await repository.claim(now + 121_000, 120))?.leaseToken,
  first?.leaseToken);
```

Also test concurrent claims, stale tokens, snapshot conflict, finality replay,
retry, checkpoint and heartbeat.

- [ ] **Step 2: Verify RED**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/transaction-inbox.repository.test.ts
```

- [ ] **Step 3: Implement**

Claim one ordered eligible row with `FOR UPDATE SKIP LOCKED`; persist an opaque
lease token. Guard every mutation by signature, token and PROCESSING, requiring
rowCount 1. Encode snapshot with shared JSON codec, hash immutable content, use
`reconcileConfirmationStatus`, and never persist RPC error messages.

- [ ] **Step 4: Verify GREEN and commit**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/transaction-inbox.repository.test.ts
npm run check
npm run lint
git add migrations/009_transaction_ingestion.sql src/storage/transaction-inbox.repository.ts tests/transaction-inbox.repository.test.ts
git commit -m "feat: persist and lease Solana transaction work"
```

### Task 4: Canonical transaction locator

**Files:**
- Create: `src/solana/rpc/transaction-locator.ts`
- Modify: `src/solana/rpc/transaction-fetcher.ts`
- Test: `tests/transaction-locator.test.ts`

- [ ] **Step 1: Write RED tests**

```ts
assert.equal((await locator.locate(target('pump', 42n))).transactionIndex, 1);
assert.equal((await locator.locate(target('swap', 42n))).transactionIndex, 2);
await assert.rejects(locator.locate(target('missing', 42n)),
  TransactionIndexNotFoundError);
```

Cover null block/transaction, mismatched slot, duplicate signature, v0, inner
instructions and Token-2022 balances.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test tests/transaction-locator.test.ts
```

- [ ] **Step 3: Implement**

Use a narrow read-only RPC port exposing transaction and block signatures.
Require matching slot and exactly one signature occurrence before calling
`normalizeTransaction` with its array position. Map every absence to typed
ingestion errors; never invent index zero.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test tests/transaction-locator.test.ts
npm run check
npm run lint
git add src/solana/rpc/transaction-fetcher.ts src/solana/rpc/transaction-locator.ts tests/transaction-locator.test.ts
git commit -m "feat: locate canonical Solana transaction indexes"
```

### Task 5: Atomic launchpad sink and reader

**Files:**
- Create: `src/ports/launchpad-projection-reader.ts`
- Create: `src/storage/launchpad-event.repository.ts`
- Test: `tests/launchpad-event.repository.test.ts`

- [ ] **Step 1: Write RED tests**

```ts
const result = await repository.record(batchWithCreationAndBuy('confirmed'));
assert.deepEqual(result.events.map((item) => item.outcome),
  ['created', 'created']);
assert.equal(await count(pool, 'token_launches'), 1);
assert.equal(await count(pool, 'launch_trades'), 1);
assert.equal(await count(pool, 'state_transitions'), 1);
```

Test replay, promotion, first orphan, confirmed orphan retraction, finalized
conflict, payload contradiction, rollback and concurrent writes.

- [ ] **Step 2: Verify RED**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/launchpad-event.repository.test.ts
```

- [ ] **Step 3: Implement sink**

Use REPEATABLE READ and advisory lock by signature. Validate batch, persist raw
and domain payloads separately, launch, trades and transitions, reconcile
confirmation, enforce fingerprints and exact row counts.

- [ ] **Step 4: Implement durable reader**

```ts
export interface LaunchpadProjectionReader {
  listTrackedMints(): Promise<ReadonlySet<string>>;
  listActiveEventsBySignature(
    signature: string,
  ): Promise<readonly LaunchpadObservationEventV1[]>;
}
```

Strictly restore JSONB, exclude orphaned events and sort by full cursor plus ID.

- [ ] **Step 5: Verify and commit**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/launchpad-event.repository.test.ts tests/launchpad-observation.service.test.ts
npm run check
npm run lint
git add src/ports/launchpad-projection-reader.ts src/storage/launchpad-event.repository.ts tests/launchpad-event.repository.test.ts
git commit -m "feat: persist launchpad event batches atomically"
```

### Task 6: Observed transaction pipeline

**Files:**
- Create: `src/application/observed-transaction-pipeline.ts`
- Test: `tests/observed-transaction-pipeline.test.ts`

- [ ] **Step 1: Write RED order tests**

```ts
const result = await pipeline(calls).process(normalizedPumpTransaction());
assert.deepEqual(calls, ['tracked', 'launchpad', 'events', 'funding',
  'i1:mint-a', 'i2:mint-a', 'pumpswap']);
assert.equal(result.affectedMintCount, 1);
await assert.rejects(pipeline(failingCalls, 'i1').process(tx),
  ObservedPipelineError);
```

Cover lexical mints, irrelevant transaction, duplicates, orphaning, create+buy
and migration+pool in one transaction.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test tests/observed-transaction-pipeline.test.ts
```

- [ ] **Step 3: Implement**

Create one observed envelope, load tracked mints, persist launchpad, reload
active events, run funding, derive sorted affected mints, run I1 then I2, then
PumpSwap. Wrap failures with exact stage and cause. Return bounded counters.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test tests/observed-transaction-pipeline.test.ts tests/wallet-evidence-observation.service.test.ts tests/wallet-graph-rebuild.service.test.ts tests/pumpswap-observation-pipeline.test.ts
npm run check
npm run lint
git add src/application/observed-transaction-pipeline.ts tests/observed-transaction-pipeline.test.ts
git commit -m "feat: pair observed transaction projections"
```

### Task 7: Bounded catch-up scanner

**Files:**
- Create: `src/solana/rpc/catch-up-source.ts`
- Create: `src/application/catch-up-scanner.ts`
- Test: `tests/catch-up-scanner.test.ts`

- [ ] **Step 1: Write RED tests**

```ts
await scanner.scan();
assert.deepEqual(inbox.signatures, ['pump-a', 'shared', 'swap-a']);
assert.deepEqual(repository.checkpointWrites.map((item) => item.key),
  ['launchpad', 'market']);
await assert.rejects(scannerWithFullPages().scan(),
  CatchUpWindowExceededError);
```

Prove no checkpoint after enqueue failure and reject pagination cycles.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test tests/catch-up-scanner.test.ts
```

- [ ] **Step 3: Implement**

Paginate `getSignaturesForAddress` for both official programs. Stop only at
checkpoint or exhausted page. Merge by signature, order deterministically,
persist all notifications, then write both checkpoints.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test tests/catch-up-scanner.test.ts
npm run check
npm run lint
git add src/solana/rpc/catch-up-source.ts src/application/catch-up-scanner.ts tests/catch-up-scanner.test.ts
git commit -m "feat: catch up missed program signatures safely"
```

### Task 8: WebSocket subscriber

**Files:**
- Create: `src/solana/rpc/program-subscriber.ts`
- Test: `tests/program-subscriber.test.ts`

- [ ] **Step 1: Write RED lifecycle tests**

```ts
await subscriber.start();
connection.emit(PUMP_PROGRAM_ID, 'shared', 42);
connection.emit(PUMPSWAP_PROGRAM_ID, 'shared', 42);
assert.deepEqual(inbox.notifications.map((item) => item.signature),
  ['shared', 'shared']);
await Promise.all([subscriber.close(), subscriber.close()]);
assert.deepEqual(connection.removed.sort(), [1, 2]);
```

Cover invalid callback, callback after close and partial setup cleanup.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test tests/program-subscriber.test.ts
```

- [ ] **Step 3: Implement**

Use `onLogs`/removal for both programs. Callback validates and enqueues only;
no fetch or decoding. Track in-flight enqueue promises for shutdown.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test tests/program-subscriber.test.ts
npm run check
npm run lint
git add src/solana/rpc/program-subscriber.ts tests/program-subscriber.test.ts
git commit -m "feat: subscribe durably to Pump program logs"
```

### Task 9: Sequential inbox worker

**Files:**
- Create: `src/application/transaction-inbox-worker.ts`
- Test: `tests/transaction-inbox-worker.test.ts`

- [ ] **Step 1: Write RED tests**

```ts
await worker.runOnce();
assert.deepEqual(calls,
  ['claim', 'locate', 'snapshot', 'pipeline', 'processed']);
await workerWithFailure(new Error('https://rpc/key')).runOnce();
assert.deepEqual(repository.failure,
  { code: 'RPC_TRANSIENT', errorName: 'Error', retryable: true });
```

Cover saved snapshot replay, lease loss, attempts, idle and in-flight close.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test tests/transaction-inbox-worker.test.ts
```

- [ ] **Step 3: Implement**

Claim one item; restore or locate/save snapshot; renew lease; run pipeline;
mark processed. Persist typed failure with exponential backoff capped at 60s.
Expose `start`, `runOnce`, `close`, `state`.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test tests/transaction-inbox-worker.test.ts
npm run check
npm run lint
git add src/application/transaction-inbox-worker.ts tests/transaction-inbox-worker.test.ts
git commit -m "feat: process durable transaction work with retries"
```

### Task 10: Conservative finality reconciler

**Files:**
- Create: `src/application/finality-reconciler.ts`
- Test: `tests/finality-reconciler.test.ts`

- [ ] **Step 1: Write RED tests**

```ts
await reconciler.runOnce();
assert.equal(repository.revisions[0]?.confirmationStatus, 'finalized');
await missingReconciler.runOnce();
await missingReconciler.runOnce();
assert.equal(repository.revisions.length, 0);
await missingReconciler.runOnce();
assert.equal(repository.revisions[0]?.confirmationStatus, 'orphaned');
```

Cover null then confirmed, regression, finalized contradiction and count reset.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test tests/finality-reconciler.test.ts
```

- [ ] **Step 3: Implement**

Batch history-status reads and one finalized root. Orphan only when root is
strictly higher and consecutive-null threshold is met. Finalized contradiction
throws without retraction.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test tests/finality-reconciler.test.ts
npm run check
npm run lint
git add src/application/finality-reconciler.ts tests/finality-reconciler.test.ts
git commit -m "feat: reconcile Solana transaction finality"
```

### Task 11: Runtime and passive production factory

**Files:**
- Create: `src/ports/listener-runtime.ts`
- Create: `src/application/listener-runtime.ts`
- Create: `src/application/production-listener-factory.ts`
- Modify: `src/solana/rpc/rpc-client.ts`
- Test: `tests/listener-runtime.test.ts`
- Test: `tests/production-listener-factory.test.ts`

- [ ] **Step 1: Write RED lifecycle tests**

```ts
await runtime.start();
assert.deepEqual(calls, ['rpc.health', 'scanner.scan', 'subscriber.start',
  'worker.start', 'reconciler.start', 'heartbeat.start']);
assert.equal(runtime.state(), 'RUNNING');
await assert.rejects(runtimeFailingAtWorker().start());
assert.deepEqual(closeCalls, ['subscriber.close']);
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test tests/listener-runtime.test.ts tests/production-listener-factory.test.ts
```

- [ ] **Step 3: Implement runtime**

```ts
export interface ListenerRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
  state(): ListenerRuntimeState;
  pipelineState(): ApiProjectionPipelineState;
}
```

Use tested start order and reverse cleanup. Shutdown stops new claims, closes
subscriber/scanner/reconciler, awaits worker against timeout, writes STOPPED
heartbeat and aggregates errors.

- [ ] **Step 4: Compose passive production dependencies**

Build RPC, inbox, locator, catch-up, subscriber, launchpad sink/adapter/service,
funding, I1/I2, PumpSwap reader/validator/reserves/fees/quotes/adapter/service,
pipeline, worker, reconciler and runtime. The unused generic Pump curve reader
throws named `BondingCurveReadUnavailableError`. Import no execution, wallet,
submission or Raydium builder module.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx --test tests/listener-runtime.test.ts tests/production-listener-factory.test.ts tests/bootstrap-safety.test.ts
npm run check
npm run lint
git add src/ports/listener-runtime.ts src/application/listener-runtime.ts src/application/production-listener-factory.ts src/solana/rpc/rpc-client.ts tests/listener-runtime.test.ts tests/production-listener-factory.test.ts tests/bootstrap-safety.test.ts
git commit -m "feat: compose the passive Pump listener runtime"
```

### Task 12: Bootstrap activation and health

**Files:**
- Modify: `src/app.ts`, `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Test: `tests/bootstrap-safety.test.ts`
- Test: `tests/api-contracts.test.ts`, `tests/api-projection.repository.test.ts`

- [ ] **Step 1: Write RED bootstrap tests**

```ts
await runApplication(dependencies);
assert.deepEqual(calls, ['pool', 'listener.create', 'listener.start',
  'server.create', 'server.listen', 'signal.wait', 'listener.close',
  'server.close', 'database.close']);
```

Cover listener startup failure, API disabled, diagnostic disablement, migration
ordering, API bind failure and cleanup aggregation.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test tests/bootstrap-safety.test.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts
```

- [ ] **Step 3: Implement**

Open PostgreSQL when listener/API/migration is enabled. Start listener before
API and derive API pipeline state from runtime. Close runtime before API and
database. Default listener failure fails process. Explicit disable logs
`listener.disabled` and exposes STOPPED. Validate heartbeat runtime fields and
remove the constant inactive production state.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test tests/bootstrap-safety.test.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts
npm run build
npm run check
npm run lint
git add src/app.ts src/api/contracts.ts src/storage/api-projection.repository.ts tests/bootstrap-safety.test.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts
git commit -m "feat: activate observation at application startup"
```

### Task 13: Recovery integration, retention and docs

**Files:**
- Create: `tests/transaction-ingestion-recovery.test.ts`
- Modify: `src/storage/database.ts`
- Modify: `.env.example`, `README.md`, `docs/api/v1.md`,
  `docs/architecture/pumpfun-v1.md`

- [ ] **Step 1: Write RED recovery tests**

```ts
for (const boundary of ['launchpad', 'funding', 'i1', 'i2', 'pumpswap'] as const) {
  await testRecovery(boundary);
}
assert.deepEqual(await counts(), {
  launches: 1, trades: 1, fundingAssessments: 1,
  creatorProfiles: 1, walletGraphProfiles: 1,
});
```

Assert observe writes no paper position and paper writes none for WATCHLISTED.

- [ ] **Step 2: Verify RED**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/transaction-ingestion-recovery.test.ts
```

- [ ] **Step 3: Close verified gaps**

Keep full replay, no stage-skip flags. Finalized/orphaned inbox rows receive
terminal/purge times from retention; pending finality work is never purged.

- [ ] **Step 4: Update operator docs**

Document active startup, dependency failures, catch-up bounds, health states,
retention, quota behavior, strict paper and absence of signing/submission.

- [ ] **Step 5: Verify and commit**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/transaction-ingestion-recovery.test.ts tests/bootstrap-safety.test.ts tests/api-projection.repository.test.ts
npm run check
npm run lint
git diff --check
git add README.md docs/api/v1.md docs/architecture/pumpfun-v1.md .env.example src/storage/database.ts tests/transaction-ingestion-recovery.test.ts
git commit -m "docs: operate the durable Pump listener"
```

### Task 14: Acceptance, review and delivery

**Files:** Modify only files required by verified findings.

- [ ] **Step 1: Full acceptance**

```bash
npm install
npm run build
npm run check
npm run lint
TEST_DATABASE_URL=postgresql:///postgres npm test
git diff --check main...HEAD
git status --short
```

- [ ] **Step 2: Safety scan**

```bash
rg -n "sendRawTransaction|sendTransaction|Keypair|secretKey|privateKey" src/app.ts src/application/listener-runtime.ts src/application/production-listener-factory.ts src/solana/rpc/program-subscriber.ts
```

Expected: no signing, key or submission path.

- [ ] **Step 3: Independent review**

Review main...HEAD for catch-up holes, checkpoint advancement, lease races,
finality/orphaning, transaction indexes, startup/shutdown cleanup, health
honesty and live-execution isolation.

- [ ] **Step 4: Fix Critical/Important findings with TDD**

For each finding: regression test RED, minimal fix, focused GREEN, fix commit.
Repeat full acceptance after the last fix.

- [ ] **Step 5: Publish**

Push `codex/pr-j1-transaction-ingestion`, open a ready PR to `main`, wait
for checks and merge only with no blocking review.
