# PR I1 Participant Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce deterministic creator profiles and observed holder distributions from Pump.fun trades seen after token creation, persist them safely, and expose them through the public API and SSE contracts.

**Architecture:** Pure analyzers calculate immutable projections from one canonical, ordered input. An application service executes those analyzers inside a mint-scoped PostgreSQL unit of work; the repository replaces current projections, appends fingerprinted snapshots, and upserts derived domain events atomically. The implementation performs no RPC reads and remains uncomposed in the production bootstrap.

**Tech Stack:** TypeScript 5.8 strict ESM, Node.js 22 test runner, PostgreSQL 15+, `pg`, bigint-only financial arithmetic.

---

## File map

Create:

- `src/domain/participant-analytics.ts` — immutable analytics contracts.
- `src/domain/participant-analytics-events.ts` — derived event payloads and factories.
- `src/analytics/creator-profiler.ts` — pure creator calculation.
- `src/analytics/observed-holder-analyzer.ts` — pure wallet and concentration calculation.
- `src/application/launch-participant-analytics.service.ts` — reconstruction orchestration.
- `src/ports/participant-analytics-repository.ts` — transactional unit-of-work port.
- `src/storage/participant-analytics.repository.ts` — PostgreSQL implementation.
- `migrations/007_participant_analytics.sql` — projections and SSE type migration.
- `tests/participant-analytics-contracts.test.ts`.
- `tests/creator-profiler.test.ts`.
- `tests/observed-holder-analyzer.test.ts`.
- `tests/participant-analytics-events.test.ts`.
- `tests/launch-participant-analytics.service.test.ts`.
- `tests/participant-analytics-migration.test.ts`.
- `tests/participant-analytics.repository.test.ts`.

Modify:

- `src/domain/events.ts` — add `HolderDistributionUpdated`.
- `src/api/contracts.ts` — available holder projection union.
- `src/config/env.ts` — bounded holder response limits.
- `src/storage/api-projection.repository.ts` — read I1 projections.
- `src/storage/database.ts` — purge counters and dependency order.
- `src/app.ts` — pass response limits only; do not compose analytics processing.
- `.env.example`, `README.md`, `docs/api/v1.md`, `docs/architecture/pumpfun-v1.md`.
- `tests/api-contracts.test.ts`, `tests/api-projection.repository.test.ts`,
  `tests/api-event-stream-migration.test.ts`, `tests/config-safety.test.ts`,
  `tests/bootstrap-safety.test.ts`, and the existing purge integration test.

## Task 1: Define immutable participant analytics contracts

**Files:**

- Create: `src/domain/participant-analytics.ts`
- Create: `tests/participant-analytics-contracts.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Create fixtures using canonical cursors and assert that the exported validators:

```ts
assertValidParticipantAnalyticsInput(input);
assertValidCreatorProfile(profile);
assertValidHolderDistribution(distribution);
```

accept:

```ts
const launch = Object.freeze({
  eventId: 'launch-event',
  mint: 'mint',
  creator: 'creator',
  source: 'pumpfun',
  program: 'pump-program',
  signature: 'create-signature',
  cursor: Object.freeze({
    slot: 10n,
    transactionIndex: 0,
    instructionIndex: 1,
    innerInstructionIndex: null,
  }),
  confirmationStatus: 'confirmed' as const,
  observedAtMs: 1_720_000_000_000,
});
```

and reject negative amounts, mismatched mints, unsafe timestamps, invalid
confirmation statuses, duplicate trade IDs, duplicate cursors, mutable nested
objects, and quote decimals outside `0..255`.

Assert the exact public constants:

```ts
assert.equal(PARTICIPANT_ANALYTICS_PAYLOAD_VERSION, 1);
assert.equal(HOLDER_CONCENTRATION_SCALE_BPS, 10_000n);
assert.deepEqual(PARTICIPANT_ANALYTICS_CONFIRMATION_ORDER, [
  'processed', 'confirmed', 'finalized',
]);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx tsx --test tests/participant-analytics-contracts.test.ts
```

Expected: failure because `src/domain/participant-analytics.ts` does not exist.

- [ ] **Step 3: Implement the domain contracts**

Define these exact top-level contracts:

```ts
export interface ParticipantAnalyticsLaunch {
  readonly eventId: string;
  readonly mint: string;
  readonly creator: string;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ActiveParticipantConfirmationStatus;
  readonly observedAtMs: number;
}

export interface ParticipantAnalyticsTrade {
  readonly eventId: string;
  readonly tradeId: string;
  readonly launchMint: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ActiveParticipantConfirmationStatus;
  readonly observedAtMs: number;
  readonly kind: 'BUY' | 'SELL';
  readonly trader: string | null;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
  readonly quoteAsset: QuoteAsset;
}

export interface ParticipantAnalyticsInput {
  readonly launch: ParticipantAnalyticsLaunch;
  readonly trades: readonly ParticipantAnalyticsTrade[];
  readonly inputFingerprint: string;
}
```

Add immutable contracts for:

- `ParticipantQuoteFlow`;
- `CreatorInitialBuy`;
- `CreatorProfile`;
- `ObservedWalletPosition`;
- `HolderDistribution`;
- `ParticipantAnalyticsProjection`.

Use signed `bigint` only for `observedNetBaseRaw`; raw bought/sold values and
concentration values must be non-negative. Implement validators without
`any`, getters, JSON coercion, or mutation. Freeze every returned snapshot.

- [ ] **Step 4: Run contract tests and the TypeScript checker**

Run:

```bash
npx tsx --test tests/participant-analytics-contracts.test.ts
npm run check
```

Expected: all contract tests pass and TypeScript reports no error.

- [ ] **Step 5: Commit**

```bash
git add src/domain/participant-analytics.ts tests/participant-analytics-contracts.test.ts
git commit -m "feat: define participant analytics contracts"
```

## Task 2: Implement the creator profiler

**Files:**

- Create: `src/analytics/creator-profiler.ts`
- Create: `tests/creator-profiler.test.ts`

- [ ] **Step 1: Write failing creator-profile tests**

Build an input containing:

- two creator buys in the creation signature;
- one creator buy in a later signature;
- one creator sell;
- two external buyers;
- one unknown trader;
- SOL and a second quote asset.

Assert:

```ts
assert.equal(profile.buyCount, 3);
assert.equal(profile.sellCount, 1);
assert.equal(profile.totalBoughtBaseRaw, 90n);
assert.equal(profile.totalSoldBaseRaw, 20n);
assert.equal(profile.observedNetBaseRaw, 70n);
assert.equal(profile.hasSold, true);
assert.equal(profile.initialBuys.length, 2);
assert.equal(profile.uniqueExternalBuyers, 2);
assert.equal(profile.unknownTraderTradeCount, 1);
assert.equal(profile.firstSell?.signature, 'creator-sell');
assert.equal(profile.quoteFlows.length, 2);
```

Add separate tests proving:

- an external buy in the creation transaction is not a creator initial buy;
- quote amounts from different quote assets are never summed;
- the first sell is chosen by canonical cursor, not input array order;
- a creator can have a negative observed net flow;
- input arrays and outputs are not mutated.

- [ ] **Step 2: Run the test and verify RED**

```bash
npx tsx --test tests/creator-profiler.test.ts
```

Expected: module-not-found failure for `creator-profiler.ts`.

- [ ] **Step 3: Implement `CreatorProfiler`**

Expose:

```ts
export class CreatorProfiler {
  public profile(input: ParticipantAnalyticsInput): CreatorProfile;
}
```

Use one pass over canonically sorted trades. Key quote flows with:

```ts
function quoteAssetKey(asset: QuoteAsset): string {
  return `${asset.mint}\u001f${asset.decimals}\u001f${asset.tokenProgram}`;
}
```

For creator trades:

```ts
if (trade.kind === 'BUY') {
  totalBoughtBaseRaw += trade.baseAmountRaw;
  buyCount += 1;
} else {
  totalSoldBaseRaw += trade.baseAmountRaw;
  sellCount += 1;
  firstSell = firstSell === null ? snapshotCreatorSell(trade) : firstSell;
}
```

Count unique external buyers with a `Set<string>` containing known BUY traders
different from the creator. Initial buys require both creator equality and
creation-signature equality.

- [ ] **Step 4: Run focused and contract tests**

```bash
npx tsx --test tests/creator-profiler.test.ts tests/participant-analytics-contracts.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/creator-profiler.ts tests/creator-profiler.test.ts
git commit -m "feat: profile observed creator behavior"
```

## Task 3: Implement observed wallet positions and concentration

**Files:**

- Create: `src/analytics/observed-holder-analyzer.ts`
- Create: `tests/observed-holder-analyzer.test.ts`

- [ ] **Step 1: Write failing distribution tests**

Use positive positions of `400n`, `300n`, `200n`, `100n` and assert:

```ts
assert.equal(distribution.totalPositiveNetBaseRaw, 1_000n);
assert.equal(distribution.top1Bps, 4_000n);
assert.equal(distribution.top5Bps, 10_000n);
assert.equal(distribution.top10Bps, 10_000n);
```

Add tests for:

- one creator with a `250n` positive flow out of `1_000n` total gives
  `creatorBps === 2_500n`;
- negative and zero positions remain present but do not enter the denominator;
- all non-positive positions produce zero concentration;
- unknown traders increment `unknownTraderTradeCount`;
- unique known buyers and unique external buyers count wallets, not trades;
- equal net flows sort by wallet address;
- quote flows remain separated by mint, decimals, and token program;
- inner instruction ordering is deterministic.

- [ ] **Step 2: Run the test and verify RED**

```bash
npx tsx --test tests/observed-holder-analyzer.test.ts
```

Expected: module-not-found failure for `observed-holder-analyzer.ts`.

- [ ] **Step 3: Implement `ObservedHolderAnalyzer`**

Expose:

```ts
export class ObservedHolderAnalyzer {
  public analyze(input: ParticipantAnalyticsInput): HolderDistribution;
}
```

Accumulate mutable internal records in a `Map<string, MutableWalletPosition>`,
then return newly allocated frozen domain snapshots. Calculate shares with:

```ts
function shareBps(amount: bigint, total: bigint): bigint {
  if (amount <= 0n || total === 0n) return 0n;
  return (amount * HOLDER_CONCENTRATION_SCALE_BPS) / total;
}
```

Calculate top-N concentration from the sum of the first N positive net flows,
then divide once by the total. This avoids compounding per-wallet truncation.

- [ ] **Step 4: Run focused tests**

```bash
npx tsx --test tests/observed-holder-analyzer.test.ts tests/creator-profiler.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/observed-holder-analyzer.ts tests/observed-holder-analyzer.test.ts
git commit -m "feat: analyze observed holder concentration"
```

## Task 4: Add derived events and the reconstruction service

**Files:**

- Create: `src/domain/participant-analytics-events.ts`
- Create: `src/ports/participant-analytics-repository.ts`
- Create: `src/application/launch-participant-analytics.service.ts`
- Create: `tests/participant-analytics-events.test.ts`
- Create: `tests/launch-participant-analytics.service.test.ts`
- Modify: `src/domain/events.ts`

- [ ] **Step 1: Write failing event tests**

Assert `DOMAIN_EVENT_TYPES` includes `HolderDistributionUpdated` exactly once.
Create a projection and assert:

```ts
assert.equal(profileEvent.type, 'CreatorProfileUpdated');
assert.equal(holderEvent.type, 'HolderDistributionUpdated');
assert.equal(profileEvent.id, repeatedProfileEvent.id);
assert.notEqual(profileEvent.id, holderEvent.id);
assert.equal(profileEvent.cursor, projection.asOf.cursor);
assert.equal(profileEvent.confirmationStatus, projection.confirmationStatus);
assert.equal(profileEvent.payload.inputFingerprint, input.inputFingerprint);
```

Verify IDs change when the `asOf` cursor changes, but payload-only changes keep
the same ID so the SSE outbox can emit a revision.

- [ ] **Step 2: Run event tests and verify RED**

```bash
npx tsx --test tests/participant-analytics-events.test.ts
```

Expected: missing exports and missing domain event type.

- [ ] **Step 3: Implement derived event factories**

Extend the constant:

```ts
export const DOMAIN_EVENT_TYPES = [
  'TokenLaunchDetected',
  'TokenMetadataResolved',
  'TokenMetadataFailed',
  'SocialEvidenceCollected',
  'CreatorProfileUpdated',
  'HolderDistributionUpdated',
  'WalletClusterDetected',
  'BondingCurveTradeObserved',
  'BondingCurveStateUpdated',
  'BondingCurveCompleted',
  'QualificationUpdated',
  'PaperPositionOpened',
  'PaperPositionUpdated',
  'PaperPositionClosed',
  'MigrationObserved',
  'PumpSwapPoolActivated',
] as const;
```

Create exact event aliases:

```ts
export type CreatorProfileUpdatedEventV1 = TypedDomainEvent<
  'CreatorProfileUpdated',
  CreatorProfileUpdatedPayloadV1,
  1
>;

export type HolderDistributionUpdatedEventV1 = TypedDomainEvent<
  'HolderDistributionUpdated',
  HolderDistributionUpdatedPayloadV1,
  1
>;
```

Factories must call `createDeterministicChainEventId` with the derived type and
the projection `asOf` signature/cursor.

- [ ] **Step 4: Write failing service tests**

Define a fake `ParticipantAnalyticsRepository` that executes a supplied
transaction callback. Assert that `rebuild(mint)`:

- validates and freezes loaded input;
- runs both pure analyzers once;
- chooses the last canonical active trade as `asOf`;
- chooses the minimum active confirmation;
- uses the launch as `asOf` for zero trades;
- creates both events;
- calls `replaceProjection` once;
- propagates a missing-launch typed error;
- writes nothing if analysis throws.

- [ ] **Step 5: Run service tests and verify RED**

```bash
npx tsx --test tests/launch-participant-analytics.service.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 6: Implement the transactional port and service**

The port is:

```ts
export interface ParticipantAnalyticsTransaction {
  loadCanonicalInput(mint: string): Promise<ParticipantAnalyticsInput | null>;
  replaceProjection(
    projection: ParticipantAnalyticsProjection,
    events: readonly ParticipantAnalyticsDerivedEventV1[],
  ): Promise<void>;
}

export interface ParticipantAnalyticsRepository {
  transact<TResult>(
    mint: string,
    operation: (transaction: ParticipantAnalyticsTransaction) => Promise<TResult>,
  ): Promise<TResult>;
}
```

The service constructor receives the repository and both analyzers. Its only
public method is:

```ts
public async rebuild(mint: string): Promise<ParticipantAnalyticsProjection>
```

Use the minimum status order `processed`, `confirmed`, `finalized`; never
construct an orphaned derived projection.

- [ ] **Step 7: Run Tasks 1–4 tests**

```bash
npx tsx --test \
  tests/participant-analytics-contracts.test.ts \
  tests/creator-profiler.test.ts \
  tests/observed-holder-analyzer.test.ts \
  tests/participant-analytics-events.test.ts \
  tests/launch-participant-analytics.service.test.ts
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/domain/events.ts src/domain/participant-analytics-events.ts \
  src/ports/participant-analytics-repository.ts \
  src/application/launch-participant-analytics.service.ts \
  tests/participant-analytics-events.test.ts \
  tests/launch-participant-analytics.service.test.ts
git commit -m "feat: orchestrate participant analytics rebuilds"
```

## Task 5: Add the PostgreSQL schema and SSE event type

**Files:**

- Create: `migrations/007_participant_analytics.sql`
- Create: `tests/participant-analytics-migration.test.ts`
- Modify: `tests/api-event-stream-migration.test.ts`

- [ ] **Step 1: Write failing migration contract tests**

Assert the SQL creates all three tables, uses `NUMERIC(78,0)`, includes FK
cascades, uses `(mint, input_fingerprint)` uniqueness, permits signed net flow,
checks all basis points in `0..10000`, and includes
`HolderDistributionUpdated` in the `api_event_stream.event_type` constraint.

Assert the SQL contains no wallet secret, transaction submission, float,
`REAL`, `DOUBLE PRECISION`, or destructive table drop.

- [ ] **Step 2: Run migration tests and verify RED**

```bash
npx tsx --test tests/participant-analytics-migration.test.ts tests/api-event-stream-migration.test.ts
```

Expected: missing migration failure.

- [ ] **Step 3: Implement migration 007**

Create:

```sql
CREATE TABLE IF NOT EXISTS creator_profiles (
  mint TEXT PRIMARY KEY REFERENCES token_launches(mint) ON DELETE CASCADE,
  creator TEXT NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  input_fingerprint TEXT NOT NULL,
  profile_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  as_of_slot NUMERIC(78,0) NOT NULL,
  as_of_transaction_index INTEGER NOT NULL,
  as_of_instruction_index INTEGER NOT NULL,
  as_of_inner_instruction_index INTEGER,
  confirmation_status TEXT NOT NULL
    CHECK (confirmation_status IN ('processed', 'confirmed', 'finalized')),
  total_bought_base_raw NUMERIC(78,0) NOT NULL CHECK (total_bought_base_raw >= 0),
  total_sold_base_raw NUMERIC(78,0) NOT NULL CHECK (total_sold_base_raw >= 0),
  observed_net_base_raw NUMERIC(78,0) NOT NULL,
  has_sold BOOLEAN NOT NULL,
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ
);
```

Create `observed_wallet_positions` with primary key `(mint, wallet)`, and
`token_holders_snapshots` with unique `(mint, input_fingerprint)`. Include
indexes for current position sorting, snapshot history, and purge dates.

Replace the generated `api_event_stream_event_type_check` safely inside a
`DO $$` block that discovers the current check constraint by table, schema,
and column dependency before adding a named constraint containing all
`DOMAIN_EVENT_TYPES`.

- [ ] **Step 4: Run migration against an empty temporary schema**

Extend the PostgreSQL integration test to:

1. create a random schema;
2. set `search_path`;
3. run migrations 001–007;
4. run `migrateDatabase` again and assert no migration is reapplied;
5. inspect `information_schema` and `pg_constraint`;
6. drop only the random schema in test cleanup.

Run:

```bash
TEST_DATABASE_URL=postgresql:///postgres \
  npx tsx --test tests/participant-analytics-migration.test.ts
```

Expected: pass when PostgreSQL is available; a deliberate skip only when
`TEST_DATABASE_URL` is absent.

- [ ] **Step 5: Commit**

```bash
git add migrations/007_participant_analytics.sql \
  tests/participant-analytics-migration.test.ts \
  tests/api-event-stream-migration.test.ts
git commit -m "feat: persist participant analytics projections"
```

## Task 6: Implement the PostgreSQL participant analytics repository

**Files:**

- Create: `src/storage/participant-analytics.repository.ts`
- Create: `tests/participant-analytics.repository.test.ts`

- [ ] **Step 1: Write failing repository unit tests**

Use a recording transactional fake and assert:

- `BEGIN`, mint advisory lock, reads, writes, and `COMMIT` occur in order;
- errors issue `ROLLBACK` and release the client;
- the launch query requires a non-orphaned `TokenLaunchDetected`;
- the trade query joins `launch_trades` to
  `BondingCurveTradeObserved` by mint and full cursor;
- both queries order by the canonical cursor;
- raw decimals become `bigint` only after strict canonical validation;
- a duplicate active event cursor is rejected.

- [ ] **Step 2: Run the repository test and verify RED**

```bash
npx tsx --test tests/participant-analytics.repository.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement `PostgresParticipantAnalyticsRepository`**

Expose:

```ts
export class PostgresParticipantAnalyticsRepository
implements ParticipantAnalyticsRepository {
  public constructor(private readonly database: ParticipantAnalyticsPool);

  public async transact<TResult>(
    mint: string,
    operation: (
      transaction: ParticipantAnalyticsTransaction,
    ) => Promise<TResult>,
  ): Promise<TResult>;
}
```

Inside the transaction:

```sql
SELECT pg_advisory_xact_lock(
  hashtextextended('participant-analytics:' || $1, 0)
)
```

Cover this exact single-bigint advisory-lock query in the unit test.

Build the input fingerprint in TypeScript with SHA-256 over length-prefixed
canonical fields. Do not use JSON numeric serialization for bigint.

`replaceProjection` must:

1. upsert both derived `domain_events`;
2. upsert `creator_profiles`;
3. delete current positions for the mint;
4. bulk insert current positions with parameterized values;
5. insert the holder snapshot with `ON CONFLICT (mint, input_fingerprint) DO NOTHING`.

Use `toJsonValue` only after producing validated immutable payloads.
Derived events use `raw_event_id = NULL`, copy source/program from the launch,
and copy `terminal_at` and `purge_after` from `token_launches`. The
`ON CONFLICT (event_id) DO UPDATE` clause must update only when at least one
public domain-event field is distinct, so an identical replay does not invoke
a new effective SSE revision.

- [ ] **Step 4: Add PostgreSQL integration cases**

Seed a launch and canonical events/trades in a temporary schema, call the real
service and repository, then assert:

- first rebuild writes one profile, N positions, one snapshot and two events;
- identical replay leaves counts unchanged;
- confirmation update changes event/outbox revision without changing amounts;
- orphaning a confirmed trade and rebuilding removes its amount;
- a forced check violation rolls back profile, positions, snapshot, and events;
- two concurrent rebuilds for the same mint serialize and converge.

- [ ] **Step 5: Run focused unit and integration tests**

```bash
TEST_DATABASE_URL=postgresql:///postgres \
  npx tsx --test \
  tests/participant-analytics.repository.test.ts \
  tests/launch-participant-analytics.service.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/storage/participant-analytics.repository.ts \
  tests/participant-analytics.repository.test.ts
git commit -m "feat: rebuild participant analytics atomically"
```

## Task 7: Expose holder analytics through API V1

**Files:**

- Modify: `src/api/contracts.ts`
- Modify: `src/config/env.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `src/app.ts`
- Modify: `.env.example`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/config-safety.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `tests/api-router.test.ts`
- Modify: `tests/bootstrap-safety.test.ts`

- [ ] **Step 1: Write failing API contract and config tests**

Change the unavailable fixture to:

```ts
const holders: ApiHolders = {
  status: 'NOT_AVAILABLE',
  snapshots: [],
  positions: [],
  clusters: [],
  clusterAnalysisStatus: 'NOT_AVAILABLE',
};
```

Add an `AVAILABLE` fixture with methodology, creator profile, latest snapshot,
snapshot history, signed position strings, empty clusters, and unavailable
cluster analysis.

Assert defaults and bounds:

```ts
assert.equal(config.apiHolderPositionLimit, 100);
assert.equal(config.apiHolderSnapshotLimit, 100);
assert.throws(() => parseConfig({
  SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
  API_HOLDER_POSITION_LIMIT: '501',
}));
```

- [ ] **Step 2: Run API tests and verify RED**

```bash
npx tsx --test \
  tests/api-contracts.test.ts \
  tests/config-safety.test.ts \
  tests/api-projection.repository.test.ts \
  tests/api-router.test.ts
```

Expected: type and assertion failures because only the unavailable legacy
shape exists.

- [ ] **Step 3: Implement the discriminated API contracts**

Define:

```ts
export type ApiHolders = ApiHoldersUnavailable | ApiHoldersAvailable;

export interface ApiHoldersUnavailable {
  readonly status: 'NOT_AVAILABLE';
  readonly snapshots: readonly [];
  readonly positions: readonly [];
  readonly clusters: readonly [];
  readonly clusterAnalysisStatus: 'NOT_AVAILABLE';
}

export interface ApiHoldersAvailable {
  readonly status: 'AVAILABLE';
  readonly methodology: 'OBSERVED_BONDING_CURVE_TRADES';
  readonly creatorProfile: ApiCreatorProfile;
  readonly latestSnapshot: ApiHolderSnapshot;
  readonly snapshots: readonly ApiHolderSnapshot[];
  readonly positions: readonly ApiObservedWalletPosition[];
  readonly clusters: readonly [];
  readonly clusterAnalysisStatus: 'NOT_AVAILABLE';
}
```

Every financial and cursor integer in these nested contracts is a decimal
string. Structural counts remain safe JSON numbers.

Extend `API_DOMAIN_NUMBER_KEYS` only with these structural analytics keys:

```ts
'buyCount',
'sellCount',
'uniqueKnownBuyers',
'uniqueExternalBuyers',
'positivePositionCount',
'unknownTraderTradeCount',
```

Do not add amount, reserve, basis-point, slot, or quote-flow keys to that
allowlist.

- [ ] **Step 4: Add bounded configuration**

Add to `AppConfig`:

```ts
readonly apiHolderPositionLimit: number;
readonly apiHolderSnapshotLimit: number;
```

Parse each with default `100`, minimum `1`, maximum `500`. Add exact safe lines
to `.env.example`.

Change `ApplicationDependencies.createProjectionRepository` to receive the
holder limit object:

```ts
{
  readonly positions: number;
  readonly snapshots: number;
}
```

Pass the values to `PostgresApiProjectionRepository`; do not create or compose
`LaunchParticipantAnalyticsService` in `src/app.ts`.

- [ ] **Step 5: Implement repository reads and strict conversion**

`getLaunchHolders` must:

1. return `null` for an unknown launch;
2. query `creator_profiles`;
3. return the exact unavailable shape when no profile exists;
4. query the latest snapshots with a parameterized limit;
5. query positions ordered by signed net descending and wallet ascending;
6. validate every stored decimal, count, cursor, payload version, and enum;
7. return frozen API values.

Use a signed decimal validator for net flow and unsigned validators for bought,
sold, total, and basis points. Reject basis points above `10000`.
`getLaunch` must reuse the same holder loader inside its existing repeatable
read snapshot and place the resulting union in `ApiLaunchDetail.holders`;
list summaries remain unchanged.

- [ ] **Step 6: Run API and bootstrap tests**

```bash
npx tsx --test \
  tests/api-contracts.test.ts \
  tests/config-safety.test.ts \
  tests/api-projection.repository.test.ts \
  tests/api-router.test.ts \
  tests/bootstrap-safety.test.ts
```

Expected: all tests pass. The bootstrap test must still assert
`pumpFunListenerActive: false` and `transactionSubmissionEnabled: false`.

- [ ] **Step 7: Commit**

```bash
git add src/api/contracts.ts src/config/env.ts \
  src/storage/api-projection.repository.ts src/app.ts .env.example \
  tests/api-contracts.test.ts tests/config-safety.test.ts \
  tests/api-projection.repository.test.ts tests/api-router.test.ts \
  tests/bootstrap-safety.test.ts
git commit -m "feat: expose observed holder analytics"
```

## Task 8: Complete retention and documentation

**Files:**

- Modify: `src/storage/database.ts`
- Modify: the existing purge integration test selected by `rg -l "purgeExpiredFoundationData" tests`
- Modify: `README.md`
- Modify: `docs/api/v1.md`
- Modify: `docs/architecture/pumpfun-v1.md`

- [ ] **Step 1: Write the failing purge test**

Seed an expired launch with a creator profile, current positions, and holder
snapshots. Assert one purge call removes them before deleting their referenced
domain events and launch, returns exact counters:

```ts
{
  creatorProfiles: 1,
  observedWalletPositions: 2,
  holderSnapshots: 1,
}
```

and leaves a non-expired launch untouched.

- [ ] **Step 2: Run the purge test and verify RED**

Run the exact file returned by:

```bash
TEST_DATABASE_URL=postgresql:///postgres \
  npx tsx --test tests/api-event-stream-migration.test.ts
```

Expected: counter/property failure before the purge implementation changes.

- [ ] **Step 3: Extend purge ordering**

Before deleting `domain_events`, delete expired I1 rows in this order:

```text
observed_wallet_positions
token_holders_snapshots
creator_profiles
```

Each deletion joins `token_launches` and tests
`token_launches.purge_after <= NOW()` rather than trusting a child timestamp.
Return the three row counts from `purgeExpiredFoundationData`. Preserve the
existing transaction and rollback behavior.

- [ ] **Step 4: Update public documentation**

Document:

- I1 analyzes only observed bonding-curve flows;
- negative net flow is valid evidence;
- `/holders` returns available projections after reconstruction;
- cluster analysis remains unavailable until I2;
- limits and environment variables;
- four-hour retention;
- passive, uncomposed service and inactive RPC listener;
- no wallet, key, signing, submission, or sellability claim.

- [ ] **Step 5: Run documentation and purge tests**

```bash
TEST_DATABASE_URL=postgresql:///postgres \
  npx tsx --test \
  tests/api-event-stream-migration.test.ts \
  tests/participant-analytics-migration.test.ts \
  tests/participant-analytics.repository.test.ts \
  tests/api-contracts.test.ts \
  tests/api-projection.repository.test.ts \
  tests/api-router.test.ts
npm run check
```

Expected: all selected tests pass and TypeScript is clean.

- [ ] **Step 6: Commit**

```bash
git add src/storage/database.ts README.md docs/api/v1.md \
  docs/architecture/pumpfun-v1.md tests
git commit -m "docs: document observed participant analytics"
```

Before committing, inspect `git diff --cached --name-only` and unstage any
test file unrelated to PR I1.

## Task 9: Perform complete verification and local review

**Files:**

- Review all PR I1 files.

- [ ] **Step 1: Install exactly from the lockfile state**

```bash
npm install
```

Expected: exit 0 and no lockfile change.

- [ ] **Step 2: Run all acceptance commands**

```bash
npm run build
npm run check
npm run lint
TEST_DATABASE_URL=postgresql:///postgres npm test
```

Expected: every command exits 0, all PostgreSQL tests execute, and no existing
test regresses.

- [ ] **Step 3: Verify security and scope invariants**

```bash
rg -n "sendTransaction|sendRawTransaction|private.?key|keypair" \
  src/analytics src/application/launch-participant-analytics.service.ts \
  src/storage/participant-analytics.repository.ts \
  migrations/007_participant_analytics.sql
git diff --check main...HEAD
git status --short
```

Expected: the security search returns no match, diff check succeeds, and the
worktree is clean.

- [ ] **Step 4: Review the complete branch diff**

```bash
git diff --stat main...HEAD
git diff main...HEAD -- \
  src/domain src/analytics src/application src/ports src/storage \
  src/api src/config migrations tests README.md docs .env.example
```

Check line by line:

- every financial value is bigint or PostgreSQL numeric;
- no quote mints are summed together;
- no `any` was added;
- every SQL value is parameterized;
- replay and orphaning behavior matches the spec;
- no listener, wallet, or execution path is composed;
- Raydium files are untouched.

- [ ] **Step 5: Run final verification after review fixes**

After any review correction, repeat:

```bash
npm run build
npm run check
npm run lint
TEST_DATABASE_URL=postgresql:///postgres npm test
git diff --check main...HEAD
git status --short
```

Expected: all commands pass and the worktree is clean before push.
