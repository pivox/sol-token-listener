# Canonical Qualification Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild and persist one canonical, explainable qualification projection for every mint affected by the durable observation pipeline before any paper decision is enqueued.

**Architecture:** A synchronous `QualificationProjectionService` runs after PumpSwap projection and owns all `qualification_reports`/`QualificationUpdated` writes through a mint-locked PostgreSQL repository. The paper worker consumes the current canonical report and keeps quote validation in candidate/paper services; it no longer rebuilds or writes qualification. Health exposes the synchronous stage and bounded report metrics.

**Tech Stack:** TypeScript strict ESM, Node.js test runner through `tsx`, PostgreSQL 14+, bigint-safe domain models, deterministic SHA-256 identities, existing API V1/SSE contracts.

---

## File map

Create:

- `src/ports/qualification-projection-repository.ts` — canonical snapshot and mint-transaction port.
- `src/application/qualification-projection.service.ts` — orchestration of canonical load, pure evaluation, replacement and dissolution.
- `src/storage/qualification-projection.repository.ts` — PostgreSQL lock, canonical reads and unique projection writes.
- `tests/qualification-projection.service.test.ts` — service behavior and missing-launch policy.
- `tests/qualification-projection.repository.test.ts` — SQL contract, idempotence, reactivation and optional live PostgreSQL coverage.

Modify:

- `src/application/qualification-rebuild.service.ts` — accept the generic snapshot and emit source `qualification`.
- `src/ports/paper-decision-repository.ts` — reference a canonical qualification instead of treating it as worker output.
- `src/application/paper-decision-worker.ts` — consume the persisted qualification and keep quotes at candidate level.
- `src/storage/paper-decision.repository.ts` — load/validate the canonical report and stop writing it.
- `src/application/observed-transaction-pipeline.ts` — add the explicit lexical `qualification` stage before paper enqueue.
- `src/application/production-listener-factory.ts` — compose the repository/service once with the effective engine.
- `src/application/listener-runtime.ts` — expose qualification state as the synchronous inbox-worker state.
- `src/api/contracts.ts` — add bounded qualification health fields.
- `src/storage/api-projection.repository.ts` — query current active reports and isolate metric failure.
- relevant existing tests named in the tasks below.

No migration is planned: `migrations/013_paper_e2e.sql` already permits a report without a candidate, one current report per mint/profile, supersession/reactivation through nullable `superseded_at`, and four-hour retention.

### Task 1: Generic canonical qualification contract

**Files:**

- Create: `src/ports/qualification-projection-repository.ts`
- Modify: `src/application/qualification-rebuild.service.ts`
- Test: `tests/qualification-rebuild.service.test.ts`

- [x] **Step 1: Write failing tests for the generic snapshot and stable event source**

Update the fixture in `tests/qualification-rebuild.service.test.ts` to import
`QualificationCanonicalSnapshot` instead of `PaperDecisionSnapshot`, then add:

```ts
void test('builds canonical qualification independently from paper state', () => {
  const rebuilt = new QualificationRebuildService(engine()).rebuild({
    snapshot: canonicalSnapshot(),
    buyQuote: undefined,
    reverseSellQuote: undefined,
  });

  assert.equal(rebuilt.event.source, 'qualification');
  assert.equal(rebuilt.event.payload.reportId, rebuilt.reportId);
  assert.equal(condition(rebuilt, 'SELL_QUOTE_UNAVAILABLE').status, 'UNKNOWN');
});
```

- [x] **Step 2: Run the focused test and confirm RED**

Run: `npx tsx --test tests/qualification-rebuild.service.test.ts`

Expected: compilation fails because `QualificationCanonicalSnapshot` does not
exist or the event source is still `paper-decision`.

- [x] **Step 3: Add the canonical port types**

Create `src/ports/qualification-projection-repository.ts` with the exact public
shape:

```ts
import type { DomainEvent } from '../domain/events.js';
import type { TokenMetadataSnapshot } from '../domain/pumpfun-observation.js';
import type { CreatorProfile, HolderDistribution } from '../domain/participant-analytics.js';
import type {
  QualificationEvaluationInput,
  QualificationReport,
} from '../domain/qualification.js';
import type { SocialEvidenceCollectionV1 } from '../domain/social-evidence.js';
import type { TokenLaunch } from '../domain/types.js';
import type { WalletGraphAnalysis } from '../domain/wallet-graph.js';

export interface QualificationEvidenceSnapshot {
  readonly mint: string;
  readonly asOfEvent: DomainEvent;
  readonly launch: TokenLaunch;
  readonly metadata: TokenMetadataSnapshot | null;
  readonly social: SocialEvidenceCollectionV1 | null;
  readonly creatorProfile: CreatorProfile | null;
  readonly holderSnapshot: HolderDistribution | null;
  readonly walletGraph: WalletGraphAnalysis | null;
}

export interface QualificationCanonicalSnapshot extends QualificationEvidenceSnapshot {
  readonly asOfRawEventId: string;
}

export interface CanonicalQualificationProjection {
  readonly reportId: string;
  readonly sourceEventId: string;
  readonly sourceRawEventId: string;
  readonly evidenceFingerprint: string;
  readonly evaluation: QualificationEvaluationInput;
  readonly report: QualificationReport;
  readonly qualificationEvent: DomainEvent;
}

export interface QualificationProjectionTransaction {
  loadCanonicalInput(mint: string): Promise<QualificationCanonicalSnapshot | null>;
  replaceProjection(projection: CanonicalQualificationProjection): Promise<'UPDATED' | 'UNCHANGED'>;
  dissolveCurrent(mint: string): Promise<void>;
}

export interface QualificationProjectionRepository {
  transact<TResult>(
    mint: string,
    operation: (transaction: QualificationProjectionTransaction) => Promise<TResult>,
  ): Promise<TResult>;
}
```

Change `QualificationRebuildInput.snapshot` to
`QualificationEvidenceSnapshot` and use
`source:'qualification'` in both deterministic event identity and event body.
Persist `evaluation` in the `QualificationUpdated` payload. Add a
`reauthorize(projection)` method that reruns
`QualificationEngine.evaluateAuthorized` with the persisted evaluation and
subject `(projection.qualificationEvent.mint, projection.qualificationEvent.id)`,
recomputes `reportId` from `sourceEventId`, profile, evidence and finality, and
returns the newly authorized in-memory report only after `isDeepStrictEqual`
confirms the stored projection exactly.
Do not modify `PaperDecisionSnapshot` yet and do not add candidate/session
fields to the canonical snapshot.

- [x] **Step 4: Run contract tests and type checking**

Run:

```bash
npx tsx --test tests/qualification-rebuild.service.test.ts
npm run check
```

Expected: qualification rebuild tests and the full type check pass because the
existing paper snapshot structurally satisfies `QualificationEvidenceSnapshot`.

- [x] **Step 5: Commit the contract**

```bash
git add src/ports/qualification-projection-repository.ts \
  src/application/qualification-rebuild.service.ts \
  tests/qualification-rebuild.service.test.ts
git commit -m "refactor: extract canonical qualification contract (#15)"
```

### Task 2: Mint-locked PostgreSQL projection repository

**Files:**

- Create: `src/storage/qualification-projection.repository.ts`
- Create: `tests/qualification-projection.repository.test.ts`
- Test: `tests/paper-e2e-migration.test.ts`

- [x] **Step 1: Write failing repository tests**

Use the scripted-client pattern from
`tests/participant-analytics.repository.test.ts`. Cover BEGIN, advisory lock,
canonical reads excluding orphaned rows, raw-backed `asOf`, replacement,
reactivation, dissolution, rollback and release. The core assertion must be:

```ts
assert.deepEqual(queries.slice(0, 2), [
  'BEGIN ISOLATION LEVEL REPEATABLE READ',
  "SELECT pg_advisory_xact_lock(hashtextextended('qualification-projection:' || $1, 0))",
]);
assert.match(canonicalSql, /raw_event_id IS NOT NULL/u);
assert.match(canonicalSql, /confirmation_status <> 'orphaned'/u);
```

Add a live test guarded by `TEST_DATABASE_URL` that creates a launch and report,
replays it, replaces it, orphan-reconciles to the older report, and verifies:

```ts
assert.equal(currentReports, 1);
assert.equal(qualificationEventsForOriginalReport, 1);
assert.equal(activeOrphanEvidence, 0);
```

- [x] **Step 2: Run the test and confirm RED**

Run: `npx tsx --test tests/qualification-projection.repository.test.ts`

Expected: module-not-found failure for the new repository.

- [x] **Step 3: Implement transaction and canonical reads**

Implement `PostgresQualificationProjectionRepository` with:

```ts
await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
await client.query(
  "SELECT pg_advisory_xact_lock(hashtextextended('qualification-projection:' || $1, 0))",
  [mint],
);
```

`loadCanonicalInput` must:

- load the active `TokenLaunchDetected` event and return `null` if absent;
- reconstruct the active social collection from
  `social_evidence_collections`, `social_links`, `social_http_observations` and
  `social_verification_evidence`, guarded by active launch/social events;
- load metadata through that collection's `metadata_snapshot_id`, never from
  an unguarded latest-by-date snapshot;
- load creator/holder projections only through active domain events;
- load the current complete wallet graph only through its active event;
- select `asOfEvent` only from active raw-backed launch/trade/curve/migration/
  pool events, excluding qualification and paper event types, ordered by the
  complete cursor and `event_id`;
- return its non-null raw identity as `asOfRawEventId`;
- decode all payloads through existing bounded JSON helpers and freeze the
  returned snapshot.

No query may join on a derived event's null `raw_event_id` as report source.

- [x] **Step 4: Implement deterministic replacement and reactivation**

Within the same transaction, implement this order:

```sql
SELECT report_id, qualification_event_id
FROM qualification_reports
WHERE mint=$1 AND profile_id=$2 AND profile_version=$3
  AND superseded_at IS NULL
FOR UPDATE;

UPDATE qualification_reports
SET superseded_at=GREATEST(evaluated_at,$4)
WHERE mint=$1 AND profile_id=$2 AND profile_version=$3
  AND superseded_at IS NULL AND report_id<>$5;

INSERT INTO domain_events (...) VALUES (...)
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO qualification_reports (...) VALUES (...)
ON CONFLICT (report_id) DO UPDATE SET superseded_at=NULL;
```

Before reactivating, validate that the historical row's immutable profile,
fingerprint, source, finality and payload exactly match the rebuilt projection.
Return `UNCHANGED` only when the same report is already current. Use the source
domain event's non-null `raw_event_id` for `source_raw_event_id`.

`dissolveCurrent` sets a bounded `superseded_at` on the current row; it does not
delete report or event history.

- [x] **Step 5: Run repository and migration contracts**

Run:

```bash
npx tsx --test tests/qualification-projection.repository.test.ts
npx tsx --test tests/paper-e2e-migration.test.ts tests/migration-contract.test.ts
```

Expected: all non-live tests pass; the live test reports skipped only when
`TEST_DATABASE_URL` is absent.

- [x] **Step 6: Commit the repository**

```bash
git add src/storage/qualification-projection.repository.ts \
  tests/qualification-projection.repository.test.ts \
  tests/paper-e2e-migration.test.ts
git commit -m "feat: persist canonical qualification projections (#15)"
```

### Task 3: Canonical projection service

**Files:**

- Create: `src/application/qualification-projection.service.ts`
- Create: `tests/qualification-projection.service.test.ts`

- [x] **Step 1: Write failing service tests**

Cover `UPDATED`, `UNCHANGED`, active missing launch and orphan dissolution:

```ts
void test('rebuilds from canonical persisted evidence', async () => {
  const result = await service(repositoryWith(canonicalSnapshot())).rebuild('MINT', 'ERROR');
  assert.equal(result.kind, 'UPDATED');
  assert.equal(result.projection.qualificationEvent.type, 'QualificationUpdated');
});

void test('dissolves only under the explicit orphan policy', async () => {
  const repository = repositoryWith(null);
  assert.equal((await service(repository).rebuild('MINT', 'DISSOLVE_CURRENT')).kind, 'DISSOLVED');
  assert.equal(repository.dissolveCalls, 1);
});
```

Also test empty mint, missing launch under `ERROR`, repository error propagation
an exact replay returning `UNCHANGED`, and `UNSUPPORTED_QUOTE_MINT` triggered
only when none of the launch quote assets belongs to the configured V1
allowlist.

- [x] **Step 2: Run the test and confirm RED**

Run: `npx tsx --test tests/qualification-projection.service.test.ts`

Expected: module-not-found failure.

- [x] **Step 3: Implement the minimal orchestration**

Create a typed `QualificationProjectionLaunchNotFoundError` and implement:

```ts
public rebuild(
  mint: string,
  missingLaunchPolicy: MissingCanonicalLaunchPolicy = 'ERROR',
): Promise<QualificationProjectionRebuildResult> {
  if (mint.length === 0) throw new TypeError('Qualification mint is required.');
  return this.repository.transact(mint, async (transaction) => {
    const snapshot = await transaction.loadCanonicalInput(mint);
    if (snapshot === null) {
      if (missingLaunchPolicy === 'ERROR') {
        throw new QualificationProjectionLaunchNotFoundError(mint);
      }
      await transaction.dissolveCurrent(mint);
      return Object.freeze({ kind: 'DISSOLVED' as const, projection: null });
    }
    const rebuilt = this.rebuilder.rebuild({
      snapshot,
      buyQuote: undefined,
      reverseSellQuote: undefined,
      upstreamConditions: Object.freeze([Object.freeze({
        code: 'UNSUPPORTED_QUOTE_MINT' as const,
        triggered: !snapshot.launch.quoteAssets.some((asset) =>
          this.quoteMintAllowlist.includes(asset.mint)),
      })]),
    });
    const projection = Object.freeze({
      reportId: rebuilt.reportId,
      sourceEventId: snapshot.asOfEvent.id,
      sourceRawEventId: snapshot.asOfRawEventId,
      evidenceFingerprint: rebuilt.evidenceFingerprint,
      evaluation: rebuilt.evaluation,
      report: rebuilt.report,
      qualificationEvent: rebuilt.event,
    });
    const kind = await transaction.replaceProjection(projection);
    return Object.freeze({ kind, projection });
  });
}
```

The constructor receives a validated, non-empty, duplicate-free frozen
`quoteMintAllowlist`; it snapshots the array and never treats SOL as a global
assumption. Remove the equivalent upstream-condition construction from the
paper worker in Task 5 so there remains one canonical reason-code producer.

- [x] **Step 4: Run focused tests and check**

Run:

```bash
npx tsx --test tests/qualification-projection.service.test.ts \
  tests/qualification-rebuild.service.test.ts
npm run check
```

Expected: all pass.

- [x] **Step 5: Commit the service**

```bash
git add src/application/qualification-projection.service.ts \
  tests/qualification-projection.service.test.ts
git commit -m "feat: rebuild canonical qualification by mint (#15)"
```

### Task 4: Explicit observation-pipeline stage

**Files:**

- Modify: `src/application/observed-transaction-pipeline.ts`
- Modify: `tests/observed-transaction-pipeline.test.ts`
- Modify: `tests/transaction-ingestion-recovery.test.ts`

- [x] **Step 1: Write failing ordering, union and error tests**

Extend the pipeline harness with a qualification rebuilder. Assert the exact
order for lexically sorted mints:

```ts
assert.deepEqual(calls, [
  'participants:A', 'participants:B',
  'graph:A', 'graph:B',
  'market',
  'qualification:A', 'qualification:B', 'qualification:C',
  'paper:A', 'paper:B', 'paper:C',
]);
assert.equal(result.qualificationRebuildCount, 3);
```

Add a rejection test:

```ts
await assert.rejects(
  pipeline.process(transaction),
  (error: unknown) => error instanceof ObservedPipelineError
    && error.stage === 'qualification'
    && error.mint === 'B',
);
assert.equal(calls.includes('paper:B'), false);
```

Add recovery coverage showing the inbox replays a failed qualification stage
and reaches `markProcessed` once the dependency succeeds.

- [x] **Step 2: Run the tests and confirm RED**

Run:

```bash
npx tsx --test tests/observed-transaction-pipeline.test.ts \
  tests/transaction-ingestion-recovery.test.ts
```

Expected: missing constructor dependency/stage/result field failures.

- [x] **Step 3: Implement the lexical qualification stage**

Add to `ObservedPipelineStage` and result:

```ts
| 'qualification'

readonly qualificationRebuildCount: number;
```

Add a `MintProjectionRebuilder` constructor dependency named `qualification`.
After PumpSwap, build the existing sorted union of affected and market mints,
then run:

```ts
let qualificationRebuildCount = 0;
for (const mint of qualificationMints) {
  await this.stage('qualification', mint, () =>
    this.qualification.rebuild(mint, missingLaunchPolicy));
  qualificationRebuildCount += 1;
}
```

Use `qualificationMints` for paper enqueue. Do not make any RPC or quote call in
this stage.

- [x] **Step 4: Run pipeline/recovery tests and static checks**

Run:

```bash
npx tsx --test tests/observed-transaction-pipeline.test.ts \
  tests/transaction-ingestion-recovery.test.ts
npm run check
```

Expected: all pass.

- [x] **Step 5: Commit the pipeline stage**

```bash
git add src/application/observed-transaction-pipeline.ts \
  tests/observed-transaction-pipeline.test.ts \
  tests/transaction-ingestion-recovery.test.ts
git commit -m "feat: qualify affected mints in observation pipeline (#15)"
```

### Task 5: Make paper trading a qualification consumer

**Files:**

- Modify: `src/ports/paper-decision-repository.ts`
- Modify: `src/application/paper-decision-worker.ts`
- Modify: `src/storage/paper-decision.repository.ts`
- Modify: `tests/paper-decision-worker.test.ts`
- Modify: `tests/paper-decision.repository.test.ts`

- [x] **Step 1: Write failing single-writer tests**

Add this field to `PaperDecisionSnapshot` before updating worker fixtures:

```ts
readonly currentQualification: CanonicalQualificationProjection | null;
```

Then make `loadSnapshot` return `currentQualification` and add:

```ts
void test('uses the persisted qualification without rebuilding it', async () => {
  const qualification = persistedQualification();
  const result = await worker({ currentQualification: qualification }).runOnce();
  assert.equal(result.kind, 'completed');
  assert.equal(candidateInputs[0]?.reportId, qualification.reportId);
  assert.equal(projectionRebuildCalls, 0);
  assert.equal(qualificationReauthorizeCalls, 1);
});
```

In repository tests, reject a missing, superseded, orphaned, foreign-mint or
payload-incoherent qualification before candidate writes. Assert the SQL no
longer contains:

```ts
assert.equal(writeSql.some((sql) => /INSERT INTO qualification_reports/u.test(sql)), false);
assert.equal(writeSql.some((sql) => /QualificationUpdated/u.test(sql)), false);
```

Add restart coverage that JSON-deserializes evaluation and report, succeeds
only after deterministic reauthorization, and rejects changes to evaluation,
report, profile, report ID, event ID or evidence fingerprint before paper
writes. Add one separate case proving an existing candidate can reconcile its
exact historical report after supersession, without opening a new position.

- [x] **Step 2: Run focused tests and confirm RED**

Run:

```bash
npx tsx --test tests/paper-decision-worker.test.ts \
  tests/paper-decision.repository.test.ts
```

Expected: worker still calls the rebuild dependency and repository still writes
the report.

- [x] **Step 3: Refactor the worker**

Keep `QualificationRebuildService` in the worker only as a persisted projection
verifier. Before quotes and candidate creation, require
`snapshot.currentQualification`; a missing report fails as retryable
`RPC_TRANSIENT`. Reauthorize the stored evaluation/report and build the context:

```ts
const persisted = snapshot.currentQualification;
if (persisted === null) return this.fail(job, lease, 'RPC_TRANSIENT', true, null);
const authorized = this.qualification.reauthorize(persisted);

const candidateResult = await this.candidates.create({
  snapshot,
  report: authorized.report,
  reportId: persisted.reportId,
  qualificationEvent: persisted.qualificationEvent,
  evidenceFingerprint: persisted.evidenceFingerprint,
  quoteAsset,
  buyQuote: buyQuote ?? null,
  reverseSellQuote: reverseSellQuote ?? null,
  nowMs: this.readNow(),
});
```

Keep quote allowlist/freshness/round-trip enforcement unchanged. Use the same
reauthorized qualification for new candidate work. In `reconcileExisting`,
reauthorize only the exact report already linked to candidate/session; never use
a superseded historical report to create a new candidate or paper position.

- [x] **Step 4: Refactor PostgreSQL paper persistence**

`loadSnapshot` loads the current active qualification independently of a
candidate. Before candidate/session writes, verify it under the mint lock:

```sql
SELECT report.*, event.*
FROM qualification_reports report
JOIN domain_events event ON event.event_id=report.qualification_event_id
WHERE report.report_id=$1 AND report.mint=$2
  AND event.confirmation_status<>'orphaned'
FOR SHARE;
```

Compare immutable stored profile, fingerprint, source and payload against the
result. Require `superseded_at IS NULL` for new candidate work. For replay or
reconciliation, require the exact existing candidate/report/event lineage
instead. Remove qualification event insertion, report supersession and report
insert from `writeDecision`; begin writes with the candidate event/row.

- [x] **Step 5: Run paper and end-to-end tests**

Run:

```bash
npx tsx --test tests/paper-decision-worker.test.ts \
  tests/paper-decision.repository.test.ts \
  tests/paper-e2e-migration.test.ts \
  tests/paper-dry-run.test.ts
npm run check
```

Expected: all pass; live PostgreSQL tests skip only without
`TEST_DATABASE_URL`.

- [x] **Step 6: Commit the single-writer refactor**

```bash
git add src/ports/paper-decision-repository.ts \
  src/application/paper-decision-worker.ts \
  src/storage/paper-decision.repository.ts \
  tests/paper-decision-worker.test.ts \
  tests/paper-decision.repository.test.ts
git commit -m "refactor: consume canonical qualification in paper worker (#15)"
```

### Task 6: Production composition and observe-mode vertical slice

**Files:**

- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `tests/bootstrap-safety.test.ts`
- Modify: `tests/paper-decision-worker.test.ts`
- Modify: `tests/transaction-ingestion-recovery.test.ts`

- [x] **Step 1: Write failing composition and observe-mode tests**

Assert the factory imports and composes
`PostgresQualificationProjectionRepository` and
`QualificationProjectionService`. Add a vertical test whose observed creation,
buy, creator sell, cluster revision and PumpSwap activation each produce a
qualification call before paper enqueue.

Le mode `observe` conserve volontairement les jobs de décision et peut
persister des candidats explicables comme projections diagnostiques. Il doit en
revanche couper toute quote et action de stratégie et conserver zéro session
d’exécution, position, trade ou fill paper.

The security assertion remains:

```ts
assert.doesNotMatch(importGraph, /Keypair|sendTransaction|signTransaction|simulateTransaction/u);
assert.equal(paperDecisionJobsInObserveMode, 1);
assert.equal(explainableCandidateWritesInObserveMode, 1);
assert.equal(paperPositionWritesInObserveMode, 0);
assert.equal(paperTradeOrFillWritesInObserveMode, 0);
assert.equal(quoteCallsInObserveMode, 0);
assert.equal(strategyOpenCallsInObserveMode, 0);
```

- [x] **Step 2: Run tests and confirm RED**

Run:

```bash
npx tsx --test tests/production-listener-factory.test.ts \
  tests/bootstrap-safety.test.ts tests/transaction-ingestion-recovery.test.ts
```

Expected: factory lacks the qualification projection composition.

- [x] **Step 3: Compose one engine and one canonical service**

In `createProductionListenerRuntime`, reuse the already loaded effective
profile and engine:

```ts
const qualificationRebuilder = new QualificationRebuildService(qualificationEngine);
const qualification = new QualificationProjectionService(
  new PostgresQualificationProjectionRepository(pool),
  qualificationRebuilder,
  { quoteMintAllowlist: config.paperQuoteMintAllowlist },
);
```

Pass `qualification` to `ObservedTransactionPipeline`. Keep the shared
rebuilder in `PaperDecisionWorker` only for deterministic persisted-report
reauthorization; it must never write a qualification projection there. Do not
change execution mode, RPC clients, quote providers or Raydium paths.

- [x] **Step 4: Run runtime tests and static checks**

Run:

```bash
npx tsx --test tests/production-listener-factory.test.ts \
  tests/bootstrap-safety.test.ts tests/transaction-ingestion-recovery.test.ts
npm run check
npm run lint
```

Expected: all pass.

- [x] **Step 5: Commit runtime composition**

```bash
git add src/application/production-listener-factory.ts \
  tests/production-listener-factory.test.ts tests/bootstrap-safety.test.ts \
  tests/transaction-ingestion-recovery.test.ts
git commit -m "feat: compose qualification projection in production (#15)"
```

### Task 7: Qualification health and bounded metrics

**Files:**

- Modify: `src/api/contracts.ts`
- Modify: `src/application/listener-runtime.ts`
- Modify: `src/app.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `tests/api-router.test.ts`
- Modify: `tests/api-safety.test.ts`
- Modify: `tests/listener-runtime.test.ts`

- [x] **Step 1: Write failing API and isolation tests**

Extend expected health with:

```ts
pipeline: {
  pumpfun: 'RUNNING',
  pumpswap: 'RUNNING',
  qualification: 'RUNNING',
  paperDecision: 'RUNNING',
  social: 'RUNNING',
},
qualification: {
  currentCount: 2,
  lastSuccessAt: '2026-08-11T08:00:00.000Z',
},
```

Add a query-failure test asserting PostgreSQL remains available, only
`pipeline.qualification` becomes `DEGRADED`, qualification metrics return safe
zero/null values and global health becomes `DEGRADED`.

- [x] **Step 2: Run focused tests and confirm RED**

Run:

```bash
npx tsx --test tests/api-contracts.test.ts \
  tests/api-projection.repository.test.ts tests/listener-runtime.test.ts
```

Expected: missing contract fields.

- [x] **Step 3: Add the bounded health contract**

Add:

```ts
export interface ApiQualificationHealth {
  readonly currentCount: number;
  readonly lastSuccessAt: string | null;
}
```

Add `qualification` to `ApiPipelineHealth` and `ApiHealth`. In
`listener-runtime.ts`, map it from the synchronous transaction worker state
using the same closed runtime-state conversion as Pump.fun/PumpSwap.
Update the disabled provider in `src/app.ts`, the degraded fallback and the
exact-key validator in `api-projection.repository.ts` to require the sixth
pipeline field.

- [x] **Step 4: Add isolated metrics projection**

Query only bounded aggregates:

```sql
SELECT COUNT(*)::int AS current_count,
  MAX(report.evaluated_at) AS last_success_at
FROM qualification_reports report
JOIN domain_events event ON event.event_id=report.qualification_event_id
WHERE report.superseded_at IS NULL
  AND event.confirmation_status<>'orphaned'
```

Catch this query separately. On failure, set qualification metrics to
`{ currentCount:0, lastSuccessAt:null }`, mark only qualification pipeline
state degraded, and preserve safe redaction.

- [x] **Step 5: Run health tests and public API checks**

Run:

```bash
npx tsx --test tests/api-contracts.test.ts \
  tests/api-projection.repository.test.ts tests/listener-runtime.test.ts \
  tests/api-router.test.ts tests/api-safety.test.ts
npm run check
```

Expected: all pass.

- [x] **Step 6: Commit health support**

```bash
git add src/api/contracts.ts src/application/listener-runtime.ts src/app.ts \
  src/storage/api-projection.repository.ts tests/api-contracts.test.ts \
  tests/api-projection.repository.test.ts tests/api-router.test.ts \
  tests/api-safety.test.ts tests/listener-runtime.test.ts
git commit -m "feat: expose canonical qualification health (#15)"
```

### Task 8: Operator frontend health alignment

**Files:**

- Modify: `frontend/src/data/api-schemas.ts`
- Modify: `frontend/src/data/api-schemas.test.ts`
- Modify: `frontend/src/features/health/health-page.tsx`
- Modify: `frontend/src/features/health/health-page.test.tsx`
- Modify: `frontend/tests/fixtures/api.ts`
- Modify: `frontend/tests/e2e/mock-api.mjs`
- Modify: `frontend/tests/e2e/operator-console.spec.ts`

- [x] **Step 1: Write failing schema and rendering tests**

Extend the health fixture with `pipeline.qualification` and
`qualification:{currentCount,lastSuccessAt}`. Assert schema rejection when
either required field is absent and render assertions:

```ts
expect(screen.getByLabelText('Qualification : RUNNING')).toBeVisible();
expect(screen.getByText(/rapports courants : 2/iu)).toBeVisible();
expect(screen.getByText(/dernier succès/iu)).toBeVisible();
```

- [x] **Step 2: Run frontend tests and confirm RED**

Run:

```bash
npm test --workspace frontend -- --run api-schemas health-page
```

Expected: schema/fixture or rendering assertions fail because qualification
health is not yet modeled.

- [x] **Step 3: Extend the schema and diagnostic page**

Add to the loose internal health schema:

```ts
qualification: z.enum(['IDLE', 'RUNNING', 'DEGRADED', 'STOPPED']),
```

and to the health root:

```ts
qualification: z.object({
  currentCount: countSchema,
  lastSuccessAt: timestampSchema.nullable(),
}).loose(),
```

Add one qualification row to `PipelineRows` and one Bootstrap diagnostic card
showing current report count and last success. Update mock API and E2E fixture
with bounded public values; do not expose mint or report payload.

- [x] **Step 4: Run frontend unit and E2E tests**

Run:

```bash
npm run check --workspace frontend
npm run lint --workspace frontend
npm test --workspace frontend
npm run e2e --workspace frontend
```

Expected: all frontend tests and operator-console E2E pass.

- [x] **Step 5: Commit frontend alignment**

```bash
git add frontend/src/data/api-schemas.ts frontend/src/data/api-schemas.test.ts \
  frontend/src/features/health/health-page.tsx \
  frontend/src/features/health/health-page.test.tsx \
  frontend/tests/fixtures/api.ts frontend/tests/e2e/mock-api.mjs \
  frontend/tests/e2e/operator-console.spec.ts
git commit -m "feat: show qualification health in operator console (#15)"
```

### Task 9: Acceptance, documentation alignment and final verification

**Files:**

- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/api/v1.md`
- Modify: `docs/superpowers/plans/2026-08-11-qualification-pipeline.md`
- Test: all suites

- [x] **Step 1: Add the final regression matrix**

Ensure named tests prove all issue cases:

```text
creation -> qualification UPDATED
buy -> holder/graph then qualification UPDATED
creator sell -> CREATOR_EARLY_SELL and REJECTED
cluster change -> new evidence fingerprint
migration/activation -> qualification before paper enqueue
exact replay -> UNCHANGED and no duplicate event/outbox row
confirmed -> finalized -> deterministic new report
orphaned launch -> DISSOLVED
orphaned recent proof -> older active report reactivated
```

Place creation/replay/finality/reorg cases in
`tests/qualification-projection.repository.test.ts`, targeted buy progression
and creator-sell evidence in `tests/qualification-projection.service.test.ts`,
ordering/migration in `tests/observed-transaction-pipeline.test.ts`, observe
safety in `tests/paper-decision-worker.test.ts` and durable retry in
`tests/transaction-ingestion-recovery.test.ts`. Do not create a second broad
end-to-end fixture.

- [x] **Step 2: Run all acceptance commands**

Run:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
npm test
```

Expected: exit code 0 for every command. Record the exact pass/skip totals in
the PR description. PostgreSQL skips are acceptable locally only when
`TEST_DATABASE_URL` is absent.

- [x] **Step 3: Run live PostgreSQL acceptance**

When `TEST_DATABASE_URL` is available, run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test
```

Expected: repository concurrency, replay, reactivation, empty-schema migration
and purge tests pass with no PostgreSQL skips. Do not print the URL.

- [x] **Step 4: Verify safety and diff scope**

Run:

```bash
git diff --check origin/main...HEAD
git grep -nE 'Keypair|sendTransaction|signTransaction|simulateTransaction' \
  -- src/application/qualification-projection.service.ts \
  src/storage/qualification-projection.repository.ts \
  src/application/observed-transaction-pipeline.ts || true
git status --short
```

Expected: no whitespace errors, no forbidden execution capability in the new
path, and only issue #15 files changed.

- [x] **Step 5: Mark this plan complete and commit documentation if changed**

Document the stage order, single-writer authority, persisted reauthorization,
health fields and four-hour retention in the architecture/API documents. Check
completed boxes in this file and commit them together:

```bash
git add docs/superpowers/plans/2026-08-11-qualification-pipeline.md \
  docs/architecture/pumpfun-v1.md docs/api/v1.md
git commit -m "docs: document canonical qualification runtime (#15)"
```

## PR delivery checklist

- Create one PR for issue #15 only.
- Request GitHub Codex review at most three times, sequentially.
- For each cycle: inspect thread-level state, fix valid findings, reply and
  resolve only after verification.
- Do not merge while a blocking thread or required check remains unresolved.
- Merge only after the user-authorized workflow and then synchronize `main`.
- Remove the feature worktree/branches only after the merged commit is verified.
