# PR I2 Wallet Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture explicit wallet-funding evidence from newly observed Pump.fun transactions, build deterministic strong-evidence wallet clusters, and expose bounded cluster analytics without activating qualification rules.

**Architecture:** A generic extraction port receives normalized transactions and already-decoded Pump.fun BUY events. A Solana adapter emits one durable assessment per buy plus explicit strong or medium evidence; separate pure graph analysis and PostgreSQL reconstruction build current relations, clusters, coverage, snapshots, and one bounded derived event. All processing remains passive and uncomposed in `src/app.ts`.

**Tech Stack:** TypeScript 5.8 strict ESM, Node.js 22 test runner, PostgreSQL 15+, `pg`, `@solana/web3.js` 1.98.4, `@solana/spl-token` 0.4.15, bigint-only financial arithmetic.

---

## File map

Create:

- `src/domain/wallet-funding.ts` — immutable assessments, evidence and extraction results.
- `src/ports/wallet-funding-evidence-extractor.ts` — generic extraction port.
- `src/solana/wallet-funding-evidence-extractor.ts` — official System/SPL decoder adapter.
- `src/application/wallet-evidence-observation.service.ts` — observation orchestration.
- `src/ports/wallet-evidence-repository.ts` — atomic evidence-batch persistence port.
- `src/storage/wallet-evidence.repository.ts` — PostgreSQL assessment/evidence persistence.
- `src/domain/wallet-graph.ts` — graph input, relations, clusters, coverage and projection.
- `src/analytics/wallet-graph-analyzer.ts` — deterministic connected-component calculation.
- `src/domain/wallet-graph-events.ts` — bounded `WalletClusterDetected` event.
- `src/application/wallet-graph-rebuild.service.ts` — transactional reconstruction orchestration.
- `src/ports/wallet-graph-repository.ts` — graph unit-of-work port.
- `src/storage/wallet-graph.repository.ts` — canonical input loader and atomic projections.
- `migrations/008_wallet_graph.sql` — evidence ledger and graph projections.
- `tests/wallet-funding-contracts.test.ts`.
- `tests/solana-wallet-funding-evidence-extractor.test.ts`.
- `tests/wallet-evidence-observation.service.test.ts`.
- `tests/wallet-graph-contracts.test.ts`.
- `tests/wallet-graph-analyzer.test.ts`.
- `tests/wallet-graph-events.test.ts`.
- `tests/wallet-graph-rebuild.service.test.ts`.
- `tests/wallet-graph-migration.test.ts`.
- `tests/wallet-evidence.repository.test.ts`.
- `tests/wallet-graph.repository.test.ts`.

Modify:

- `src/api/contracts.ts` — discriminated available/unavailable cluster contracts.
- `src/config/env.ts` — three bounded cluster response limits.
- `src/storage/api-projection.repository.ts` — current graph and bounded members.
- `src/storage/database.ts` — graph purge order and counters.
- `src/app.ts` — pass API limits only; do not compose I2 processing.
- `.env.example` — safe cluster response defaults.
- `README.md`, `docs/api/v1.md`, `docs/architecture/pumpfun-v1.md` — observed-only semantics.
- `tests/api-contracts.test.ts`, `tests/api-projection.repository.test.ts`,
  `tests/api-router.test.ts`, `tests/config-safety.test.ts`,
  `tests/bootstrap-safety.test.ts`, and `tests/api-event-stream-migration.test.ts`.

## Task 1: Define immutable wallet-funding contracts

**Files:**

- Create: `src/domain/wallet-funding.ts`
- Create: `src/ports/wallet-funding-evidence-extractor.ts`
- Create: `tests/wallet-funding-contracts.test.ts`

- [ ] **Step 1: Write failing contract tests**

Assert the exact stable constants and a frozen assessment/evidence batch:

```ts
assert.deepEqual(WALLET_FUNDING_ASSESSMENT_STATUSES, [
  'STRONG', 'MEDIUM_ONLY', 'NO_EVIDENCE', 'UNAVAILABLE',
]);
assert.deepEqual(WALLET_FUNDING_EVIDENCE_TYPES, [
  'DIRECT_QUOTE_TRANSFER', 'FEE_PAYER_FOR_BUYER',
]);
assert.deepEqual(WALLET_FUNDING_CONFIDENCES, ['STRONG', 'MEDIUM']);
assert.equal(WALLET_FUNDING_PAYLOAD_VERSION, 1);
assertValidWalletFundingExtractionResult(result);
```

Cover rejection of mutable nested values, duplicate evidence IDs, duplicate
trade assessments, evidence for an unassessed trade, `funder === buyer`,
negative amounts, mismatched mints/signatures, non-canonical cursors, bad
quote decimals, invalid timestamps and contradictory status/evidence counts.

- [ ] **Step 2: Run the test and verify RED**

```bash
npx tsx --test tests/wallet-funding-contracts.test.ts
```

Expected: module-not-found failure for `src/domain/wallet-funding.ts`.

- [ ] **Step 3: Implement the domain contracts and generic port**

Define the exact public shapes:

```ts
export type WalletFundingAssessmentStatus =
  | 'STRONG' | 'MEDIUM_ONLY' | 'NO_EVIDENCE' | 'UNAVAILABLE';
export type WalletFundingEvidenceType =
  | 'DIRECT_QUOTE_TRANSFER' | 'FEE_PAYER_FOR_BUYER';
export type WalletFundingConfidence = 'STRONG' | 'MEDIUM';
export type WalletFundingDiagnosticCode =
  | 'OWNER_AMBIGUOUS'
  | 'TOKEN_BALANCE_UNAVAILABLE'
  | 'KNOWN_TRANSFER_INVALID'
  | 'SELF_TRANSFER_IGNORED';

export interface WalletFundingBuy {
  readonly eventId: string;
  readonly tradeId: string;
  readonly mint: string;
  readonly buyer: string;
  readonly source: string;
  readonly program: string;
  readonly quoteAsset: QuoteAsset;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTimeMs: number | null;
  readonly observedAtMs: number;
}

export interface WalletFundingAssessment {
  readonly id: string;
  readonly buy: WalletFundingBuy;
  readonly status: WalletFundingAssessmentStatus;
  readonly inspectedTransferCount: number;
  readonly acceptedTransferCount: number;
  readonly ignoredTransferCount: number;
  readonly diagnosticCodes: readonly WalletFundingDiagnosticCode[];
  readonly payloadVersion: 1;
}

interface WalletFundingEvidenceBase {
  readonly id: string;
  readonly mint: string;
  readonly buyer: string;
  readonly funder: string;
  readonly quoteAsset: QuoteAsset;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly buyEventId: string;
  readonly buyTradeId: string;
  readonly buyCursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTimeMs: number | null;
  readonly observedAtMs: number;
  readonly payloadVersion: 1;
}

export interface DirectQuoteTransferEvidence extends WalletFundingEvidenceBase {
  readonly type: 'DIRECT_QUOTE_TRANSFER';
  readonly confidence: 'STRONG';
  readonly amountRaw: bigint;
  readonly transferCursor: ChainCursor;
}

export interface FeePayerEvidence extends WalletFundingEvidenceBase {
  readonly type: 'FEE_PAYER_FOR_BUYER';
  readonly confidence: 'MEDIUM';
  readonly amountRaw: null;
  readonly transferCursor: null;
}

export type WalletFundingEvidence =
  | DirectQuoteTransferEvidence
  | FeePayerEvidence;

export interface WalletFundingExtractionResult {
  readonly assessments: readonly WalletFundingAssessment[];
  readonly evidence: readonly WalletFundingEvidence[];
}
```

The generic port must be independent from Solana:

```ts
export interface WalletFundingEvidenceExtractor<TTransaction> {
  extract(
    transaction: TTransaction,
    buys: readonly WalletFundingBuy[],
  ): WalletFundingExtractionResult;
}
```

Implement `createWalletFundingAssessmentId` and
`createWalletFundingEvidenceId` with SHA-256 over unambiguous JSON arrays.
Validators must reject `funder === buyer` for direct-transfer evidence and
freeze copied inputs without using `any`. Evidence IDs include source,
program, signature, mint, buyer, funder and quote asset. A direct proof uses
its transfer cursor; a fee-payer proof uses the associated buy cursor.

- [ ] **Step 4: Run contracts and checker**

```bash
npx tsx --test tests/wallet-funding-contracts.test.ts
npm run check
```

Expected: contract tests pass and TypeScript reports no error.

- [ ] **Step 5: Commit**

```bash
git add src/domain/wallet-funding.ts src/ports/wallet-funding-evidence-extractor.ts tests/wallet-funding-contracts.test.ts
git commit -m "feat: define wallet funding evidence contracts"
```

## Task 2: Decode Solana funding evidence with official SDKs

**Files:**

- Create: `src/solana/wallet-funding-evidence-extractor.ts`
- Create: `tests/solana-wallet-funding-evidence-extractor.test.ts`

- [ ] **Step 1: Write failing extractor tests**

Build immutable `NormalizedTransaction` fixtures and BUY inputs. Cover:

```ts
assert.equal(result.assessments[0]?.status, 'STRONG');
assert.equal(result.evidence[0]?.type, 'DIRECT_QUOTE_TRANSFER');
assert.equal(result.evidence[0]?.amountRaw, 1_000_000n);
assert.equal(result.evidence[0]?.funder, FUNDER);
assert.equal(result.evidence[0]?.buyer, BUYER);
```

Add separate cases for:

- outer and inner System Program `Transfer` before a SOL/WSOL buy;
- transfer after the buy, wrong receiver and wrong quote mint ignored;
- SPL `Transfer` and `TransferChecked`;
- Token-2022 `Transfer` and `TransferChecked`;
- ambiguous/absent source or destination owner gives `UNAVAILABLE`;
- source and destination both owned by buyer records
  `SELF_TRANSFER_IGNORED` and no strong evidence;
- fee payer different from buyer yields only `MEDIUM`;
- fee payer equal to buyer yields `NO_EVIDENCE`;
- two buys consume each transfer at most once, assigning it to the first
  compatible later buy;
- program, mint, vault, bonding curve and token-account addresses are excluded;
- failed or orphaned input does not invent active strong evidence.

- [ ] **Step 2: Run the test and verify RED**

```bash
npx tsx --test tests/solana-wallet-funding-evidence-extractor.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement instruction conversion and official decoding**

Convert each normalized instruction without mutation:

```ts
function toTransactionInstruction(
  instruction: NormalizedInstruction,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account),
      isSigner: false,
      isWritable: false,
    })),
    data: Buffer.from(instruction.data),
  });
}
```

Use only:

```ts
SystemInstruction.decodeTransfer(instruction);
decodeTransferInstruction(instruction, tokenProgramId);
decodeTransferCheckedInstruction(instruction, tokenProgramId);
```

Recognize `TOKEN_PROGRAM_ID` and `TOKEN_2022_PROGRAM_ID` explicitly. Resolve
token-account mint/owner from the union of normalized pre/post balances; any
conflict returns an unavailable diagnostic instead of guessing. The SPL
funder is the canonical source-token-account owner, never the transfer
authority in isolation, because that authority can be a delegate.

Reuse `decodePumpInstruction` and its generated official-IDL account map for
the BUY at the target cursor. Require its `user` account to equal the buyer,
then treat every mapped action account except `user` as technical. This
automatically covers V1/V2 vault, mint, fee, accumulator, token-program and
associated-account roles without maintaining a second hard-coded role list.
An absent or malformed recognized Pump BUY makes the assessment `UNAVAILABLE`;
do not infer technical roles from off-curve status.

- [ ] **Step 4: Implement deterministic matching**

Sort buys and transfers with `compareCursors`. For each transfer:

```ts
const target = buys.find((buy) =>
  compareCursors(transfer.cursor, buy.cursor) < 0
  && quoteAssetsEqual(transfer.quoteAsset, buy.quoteAsset)
  && transfer.destinationOwner === buy.buyer
  && !consumedTransferIds.has(transfer.id)
);
```

Exclude explicit technical accounts and require
`transfer.sourceOwner !== target.buyer`. Emit medium fee-payer evidence
separately. Derive each assessment status with:

```ts
const status = strongCount > 0
  ? 'STRONG'
  : mediumCount > 0
    ? 'MEDIUM_ONLY'
    : unavailable
      ? 'UNAVAILABLE'
      : 'NO_EVIDENCE';
```

Return frozen snapshots and never use pre/post global lamport deltas.

- [ ] **Step 5: Run focused tests**

```bash
npx tsx --test tests/wallet-funding-contracts.test.ts tests/solana-wallet-funding-evidence-extractor.test.ts
npm run check
npm run lint
```

Expected: all focused tests pass; checker and lint are clean.

- [ ] **Step 6: Commit**

```bash
git add src/solana/wallet-funding-evidence-extractor.ts tests/solana-wallet-funding-evidence-extractor.test.ts
git commit -m "feat: extract observed Solana funding evidence"
```

## Task 3: Add the passive evidence observation service

**Files:**

- Create: `src/application/wallet-evidence-observation.service.ts`
- Create: `src/ports/wallet-evidence-repository.ts`
- Create: `tests/wallet-evidence-observation.service.test.ts`

- [ ] **Step 1: Write failing service tests**

Use spies to assert:

```ts
const result = await service.observe(transaction, events);
assert.equal(extractorCalls, 1);
assert.equal(repositoryCalls, 1);
assert.equal(result.assessments.length, 2);
```

Cover filtering to known BUY events with non-null traders, canonical sorting,
empty batches, duplicate trade/event IDs rejected before extraction, foreign
signatures/cursors rejected, extractor errors wrapped as
`WalletEvidenceObservationError('extract', cause)`, repository errors wrapped
as `WalletEvidenceObservationError('record', cause)`, and orphaned batches
passed for finality reconciliation.

- [ ] **Step 2: Run the test and verify RED**

```bash
npx tsx --test tests/wallet-evidence-observation.service.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the repository port and service**

Define:

```ts
export interface WalletEvidenceBatch {
  readonly signature: string;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly assessments: readonly WalletFundingAssessment[];
  readonly evidence: readonly WalletFundingEvidence[];
}

export interface WalletEvidenceRepository {
  record(batch: WalletEvidenceBatch): Promise<void>;
}
```

Expose:

```ts
export class WalletEvidenceObservationService {
  public async observe(
    transaction: SolanaObservedTransaction,
    events: readonly BondingCurveTradeObservedEventV1[],
  ): Promise<WalletFundingExtractionResult>;
}
```

Convert only `BUY` events with a non-null trader to `WalletFundingBuy`. Validate
their transaction signature and slot/index against the observed transaction,
call the extractor exactly once, validate its result, then persist one atomic
batch. Add:

```ts
export class WalletEvidenceObservationError extends Error {
  public constructor(
    public readonly stage: 'validate' | 'extract' | 'record',
    options: ErrorOptions,
  ) {
    super(`Wallet evidence observation failed during ${stage}.`, options);
    this.name = 'WalletEvidenceObservationError';
  }
}
```

Do not import this service from `src/app.ts`.

- [ ] **Step 4: Run focused tests and static safety check**

```bash
npx tsx --test tests/wallet-evidence-observation.service.test.ts
rg -n "WalletEvidenceObservationService|wallet-funding" src/app.ts
npm run check
```

Expected: service tests pass, `rg` returns no match in `src/app.ts`, and check
passes.

- [ ] **Step 5: Commit**

```bash
git add src/application/wallet-evidence-observation.service.ts src/ports/wallet-evidence-repository.ts tests/wallet-evidence-observation.service.test.ts
git commit -m "feat: add passive wallet evidence observation"
```

## Task 4: Persist the assessment ledger and evidence

**Files:**

- Create: `migrations/008_wallet_graph.sql`
- Create: `src/storage/wallet-evidence.repository.ts`
- Create: `tests/wallet-graph-migration.test.ts`
- Create: `tests/wallet-evidence.repository.test.ts`

- [ ] **Step 1: Write failing migration tests**

Assert the migration creates `wallet_funding_observations` and
`wallet_funding_evidence` with:

```text
NUMERIC(78,0)
processed | confirmed | finalized | orphaned
STRONG | MEDIUM_ONLY | NO_EVIDENCE | UNAVAILABLE
DIRECT_QUOTE_TRANSFER | FEE_PAYER_FOR_BUYER
STRONG | MEDIUM
ON DELETE CASCADE
purge_after
```

Run migrations 001–008 on an empty live PostgreSQL database, run the migrator
again, and assert only the first pass applies 008.

- [ ] **Step 2: Run migration tests and verify RED**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/wallet-graph-migration.test.ts
```

Expected: failure because migration 008 does not exist.

- [ ] **Step 3: Add evidence tables and indexes**

Create:

```sql
CREATE TABLE IF NOT EXISTS wallet_funding_observations (
  assessment_id TEXT PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  trade_event_id TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  buyer TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot NUMERIC(78,0) NOT NULL,
  transaction_index INTEGER NOT NULL,
  instruction_index INTEGER NOT NULL,
  inner_instruction_index INTEGER,
  confirmation_status TEXT NOT NULL,
  assessment_status TEXT NOT NULL,
  inspected_transfer_count INTEGER NOT NULL CHECK (inspected_transfer_count >= 0),
  accepted_transfer_count INTEGER NOT NULL CHECK (accepted_transfer_count >= 0),
  ignored_transfer_count INTEGER NOT NULL CHECK (ignored_transfer_count >= 0),
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ,
  UNIQUE (mint, trade_event_id)
);
```

Add `wallet_funding_evidence` with deterministic primary key, nullable
transfer cursor/amount for fee-payer evidence, required buy cursor, quote
mint/decimals/token program, `amount_raw NUMERIC(78,0)`, payload and finality.
Add a constraint requiring amount/transfer cursor only for
`DIRECT_QUOTE_TRANSFER`. Index by mint/trade and mint/canonical buy cursor.

- [ ] **Step 4: Write failing repository tests**

With a scripted query client and live PostgreSQL, cover:

- assessment and all evidence write inside one transaction;
- duplicate replay changes no immutable field;
- `processed -> confirmed -> finalized` advances finality;
- `processed/confirmed -> orphaned` is retained for audit;
- contradictory immutable payload rolls back;
- finalized-to-orphaned uses the existing confirmation reconciliation policy
  and fails;
- assessment with zero evidence persists `NO_EVIDENCE`;
- failed statement leaves no partial evidence.

- [ ] **Step 5: Implement `PostgresWalletEvidenceRepository`**

Use:

```ts
export class PostgresWalletEvidenceRepository implements WalletEvidenceRepository {
  public async record(batch: WalletEvidenceBatch): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const assessment of batch.assessments) {
        await this.upsertAssessment(client, assessment);
      }
      for (const evidence of batch.evidence) {
        await this.upsertEvidence(client, evidence);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new WalletEvidencePersistenceError(error);
    } finally {
      client.release();
    }
  }
}
```

Reuse the repository confirmation merge semantics; verify immutable columns
with `IS NOT DISTINCT FROM` before permitting status/time enrichment. Batch
inserts below PostgreSQL's parameter limit rather than constructing an
unbounded statement.

- [ ] **Step 6: Run focused database tests**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/wallet-graph-migration.test.ts tests/wallet-evidence.repository.test.ts
npm run check
npm run lint
```

Expected: focused tests, check and lint pass.

- [ ] **Step 7: Commit**

```bash
git add migrations/008_wallet_graph.sql src/storage/wallet-evidence.repository.ts tests/wallet-graph-migration.test.ts tests/wallet-evidence.repository.test.ts
git commit -m "feat: persist wallet funding observations"
```

## Task 5: Define and calculate the deterministic graph

**Files:**

- Create: `src/domain/wallet-graph.ts`
- Create: `src/analytics/wallet-graph-analyzer.ts`
- Create: `tests/wallet-graph-contracts.test.ts`
- Create: `tests/wallet-graph-analyzer.test.ts`

- [ ] **Step 1: Write failing domain and analyzer tests**

Define fixtures with two buyers funded by one auxiliary wallet and assert:

```ts
assert.equal(result.relationships.length, 2);
assert.equal(result.clusters.length, 1);
assert.equal(result.clusters[0]?.participantWalletCount, 2);
assert.equal(result.clusters[0]?.auxiliaryWalletCount, 1);
assert.equal(result.clusters[0]?.concentrationBps, 7_500n);
```

Cover:

- medium-only fee-payer relations excluded from components;
- transitive strong components;
- one participant plus one funder not exposed as a cluster;
- creator membership;
- an auxiliary funder contributes zero concentration;
- zero/negative observed positions excluded;
- grouped quote totals never sum different assets;
- deterministic wallet ordering and cluster IDs under shuffled input;
- active BUYs absent from the ledger count `NOT_PROCESSED`;
- wallet category precedence
  `STRONG > MEDIUM_ONLY > NOT_PROCESSED > UNAVAILABLE > NO_EVIDENCE`;
- successful zero-cluster analysis is available;
- validators reject duplicated edges, invalid basis points and mutable input.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx tsx --test tests/wallet-graph-contracts.test.ts tests/wallet-graph-analyzer.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 3: Implement graph contracts**

Define:

```ts
export interface WalletGraphInput {
  readonly launch: ParticipantAnalyticsLaunch;
  readonly participantInputFingerprint: string;
  readonly positions: readonly ObservedWalletPosition[];
  readonly buys: readonly ParticipantAnalyticsTrade[];
  readonly assessments: readonly WalletFundingAssessment[];
  readonly evidence: readonly WalletFundingEvidence[];
  readonly inputFingerprint: string;
}

export interface WalletRelationship {
  readonly id: string;
  readonly mint: string;
  readonly leftWallet: string;
  readonly rightWallet: string;
  readonly type: WalletFundingEvidenceType;
  readonly confidence: WalletFundingConfidence;
  readonly evidenceCount: number;
  readonly quoteTotals: readonly WalletGraphQuoteTotal[];
}

export interface WalletGraphQuoteTotal {
  readonly quoteAsset: QuoteAsset;
  readonly amountRaw: bigint;
}

export interface WalletClusterMember {
  readonly wallet: string;
  readonly role: 'PARTICIPANT' | 'AUXILIARY_FUNDER';
  readonly isCreator: boolean;
  readonly observedNetBaseRaw: bigint;
}

export interface WalletCluster {
  readonly id: string;
  readonly mint: string;
  readonly members: readonly WalletClusterMember[];
  readonly participantWalletCount: number;
  readonly auxiliaryWalletCount: number;
  readonly positiveHolderCount: number;
  readonly observedPositiveBaseRaw: bigint;
  readonly concentrationBps: bigint;
  readonly containsCreator: boolean;
  readonly sharedFunderCount: number;
  readonly strongRelationshipCount: number;
  readonly strongEvidenceCount: number;
}

export interface WalletGraphCoverage {
  readonly knownBuyCount: number;
  readonly knownBuyerCount: number;
  readonly strongEvidenceBuyCount: number;
  readonly strongEvidenceBuyerCount: number;
  readonly mediumOnlyBuyCount: number;
  readonly mediumOnlyBuyerCount: number;
  readonly noEvidenceBuyCount: number;
  readonly noEvidenceBuyerCount: number;
  readonly unavailableBuyCount: number;
  readonly unavailableBuyerCount: number;
  readonly notProcessedBuyCount: number;
  readonly notProcessedBuyerCount: number;
  readonly analyzedTransactionCount: number;
  readonly evidenceCount: number;
}

export interface WalletGraphAsOf {
  readonly eventId: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly observedAtMs: number;
}

export interface WalletGraphConfirmationCounts {
  readonly processed: number;
  readonly confirmed: number;
  readonly finalized: number;
}

export interface WalletGraphProjection {
  readonly launch: ParticipantAnalyticsLaunch;
  readonly inputFingerprint: string;
  readonly methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS';
  readonly asOf: WalletGraphAsOf;
  readonly confirmationStatus: ActiveParticipantConfirmationStatus;
  readonly confirmationCounts: WalletGraphConfirmationCounts;
  readonly coverage: WalletGraphCoverage;
  readonly relationships: readonly WalletRelationship[];
  readonly clusters: readonly WalletCluster[];
}
```

Add validators and deterministic relationship/cluster ID helpers for these
exact contracts.

- [ ] **Step 4: Implement `WalletGraphAnalyzer`**

Aggregate each unordered edge with sorted wallet addresses. Build adjacency
only for `STRONG` relations, then calculate connected components in sorted
node order:

```ts
for (const start of [...adjacency.keys()].sort()) {
  if (visited.has(start)) continue;
  const members = visitComponent(start, adjacency, visited).sort();
  const participantCount = members.filter((wallet) => participants.has(wallet)).length;
  if (participantCount >= 2) clusters.push(buildCluster(members));
}
```

Use only positive I1 positions:

```ts
const positive = position.observedNetBaseRaw > 0n
  ? position.observedNetBaseRaw
  : 0n;
const concentrationBps = totalPositiveBaseRaw === 0n
  ? 0n
  : clusterPositiveBaseRaw * 10_000n / totalPositiveBaseRaw;
```

Compute buy-level coverage first, then mutually exclusive buyer coverage with
the specified conservative precedence. Medium fee-payer relations retain their
quote asset but have an empty `quoteTotals`; only direct transfers contribute
amounts.

- [ ] **Step 5: Run focused tests**

```bash
npx tsx --test tests/wallet-graph-contracts.test.ts tests/wallet-graph-analyzer.test.ts
npm run check
npm run lint
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/domain/wallet-graph.ts src/analytics/wallet-graph-analyzer.ts tests/wallet-graph-contracts.test.ts tests/wallet-graph-analyzer.test.ts
git commit -m "feat: analyze observed wallet clusters"
```

## Task 6: Create bounded graph events and reconstruction service

**Files:**

- Create: `src/domain/wallet-graph-events.ts`
- Create: `src/application/wallet-graph-rebuild.service.ts`
- Create: `src/ports/wallet-graph-repository.ts`
- Create: `tests/wallet-graph-events.test.ts`
- Create: `tests/wallet-graph-rebuild.service.test.ts`

- [ ] **Step 1: Write failing event tests**

Assert `WalletClusterDetected` contains only aggregates:

```ts
assert.equal(event.type, 'WalletClusterDetected');
assert.equal(event.cursor, projection.asOf.cursor);
assert.equal(event.payload.inputFingerprint, projection.inputFingerprint);
assert.equal(event.payload.clusterCount, projection.clusters.length);
assert.equal('clusters' in event.payload, false);
assert.equal('members' in event.payload, false);
assert.equal('relationships' in event.payload, false);
```

Assert identical `asOf` produces the same ID, a moved cursor changes the ID,
and changed fingerprint/finality at the same cursor keeps the ID so the
existing outbox trigger can emit a revision.

- [ ] **Step 2: Write failing service tests**

Verify the service:

```ts
return repository.transact(mint, async (transaction) => {
  const input = await transaction.loadCanonicalInput(mint);
  const analysis = analyzer.analyze(input);
  await transaction.replaceProjection(projection, event);
  return projection;
});
```

Cover launch absent, input validation before analysis, deterministic `asOf`,
minimum active finality, zero-cluster persistence, analyzer failure rollback
and repository failure propagation.

- [ ] **Step 3: Run tests and verify RED**

```bash
npx tsx --test tests/wallet-graph-events.test.ts tests/wallet-graph-rebuild.service.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 4: Implement event factory and repository port**

Define a bounded payload:

```ts
export interface WalletClusterDetectedPayloadV1 {
  readonly inputFingerprint: string;
  readonly methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS';
  readonly coverage: WalletGraphCoverage;
  readonly strongRelationshipCount: number;
  readonly mediumRelationshipCount: number;
  readonly clusterCount: number;
  readonly maximumClusterBps: bigint;
  readonly creatorClusterCount: number;
  readonly confirmationCounts: WalletGraphConfirmationCounts;
}

export type WalletClusterDetectedEventV1 = TypedDomainEvent<
  'WalletClusterDetected',
  WalletClusterDetectedPayloadV1,
  1
>;
```

Build its ID with `createDeterministicChainEventId` using launch
source/program and `projection.asOf` signature/cursor.

Define:

```ts
export interface WalletGraphTransaction {
  loadCanonicalInput(mint: string): Promise<WalletGraphInput | null>;
  replaceProjection(
    projection: WalletGraphProjection,
    event: WalletClusterDetectedEventV1,
  ): Promise<void>;
}
```

- [ ] **Step 5: Implement reconstruction**

Sort canonical sources, compute `asOf` as the greatest active cursor with
fallback to I1 and launch, derive the minimum finality, call the analyzer and
persist the projection/event inside one repository transaction.

- [ ] **Step 6: Run focused tests and commit**

```bash
npx tsx --test tests/wallet-graph-events.test.ts tests/wallet-graph-rebuild.service.test.ts
npm run check
npm run lint
git add src/domain/wallet-graph-events.ts src/application/wallet-graph-rebuild.service.ts src/ports/wallet-graph-repository.ts tests/wallet-graph-events.test.ts tests/wallet-graph-rebuild.service.test.ts
git commit -m "feat: rebuild wallet graph projections"
```

Expected: tests/check/lint pass before the commit.

## Task 7: Persist graph projections, snapshots and derived events

**Files:**

- Modify: `migrations/008_wallet_graph.sql`
- Create: `src/storage/wallet-graph.repository.ts`
- Create: `tests/wallet-graph.repository.test.ts`
- Modify: `tests/wallet-graph-migration.test.ts`
- Modify: `tests/api-event-stream-migration.test.ts`

- [ ] **Step 1: Extend failing migration and repository tests**

Require:

- `wallet_relationships`;
- `wallet_graph_profiles`;
- `wallet_clusters`;
- `wallet_cluster_members`;
- `wallet_graph_snapshots`;
- current-projection indexes;
- unique `(mint, input_fingerprint)` snapshot;
- `NUMERIC(78,0)` for amounts and basis points;
- cascade and purge indexes.

Repository tests must cover advisory locking, canonical I1 positions/BUYs,
assessment ledger including missing `NOT_PROCESSED` rows, orphaned evidence
exclusion, stable fingerprint, replacement of current rows, member batches
under 65,535 PostgreSQL parameters, identical replay, finality update,
orphan-dissolved cluster, same-`asOf` outbox revision, rollback and release.

- [ ] **Step 2: Run tests and verify RED**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/wallet-graph-migration.test.ts tests/wallet-graph.repository.test.ts tests/api-event-stream-migration.test.ts
```

Expected: missing tables/repository failures.

- [ ] **Step 3: Complete migration 008**

Use normalized current projections:

```sql
CREATE TABLE IF NOT EXISTS wallet_cluster_members (
  mint TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  member_role TEXT NOT NULL CHECK (member_role IN ('PARTICIPANT', 'AUXILIARY_FUNDER')),
  is_creator BOOLEAN NOT NULL,
  observed_net_base_raw NUMERIC(78,0) NOT NULL,
  input_fingerprint TEXT NOT NULL,
  purge_after TIMESTAMPTZ,
  PRIMARY KEY (mint, cluster_id, wallet),
  FOREIGN KEY (mint, cluster_id)
    REFERENCES wallet_clusters(mint, cluster_id) ON DELETE CASCADE
);
```

Store the active aggregate/fingerprint in one `wallet_graph_profiles` row per
mint, including the event ID and complete `asOf`. Store history separately in
`wallet_graph_snapshots` with unique `(mint, input_fingerprint)`. Keep
`WalletClusterDetected` in the existing SSE type check.

- [ ] **Step 4: Implement canonical loader**

Inside `transact`, acquire:

```sql
SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
```

Load the launch, current `creator_profiles.input_fingerprint`,
`observed_wallet_positions`, active BUY `launch_trades`, all ledger rows for
those trade IDs, and non-orphaned evidence. Hash canonical sorted immutable
values plus finality and methodology version. Do not trust caller aggregates.

- [ ] **Step 5: Implement atomic replacement**

Delete and reinsert current relationships, clusters and members only for the
locked mint. Insert member rows in batches of at most 3,000. Insert the
fingerprinted snapshot idempotently, then upsert the bounded domain event
using the same immutable-field and mutable-payload rules as I1.

- [ ] **Step 6: Run repository integration tests**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/wallet-graph-migration.test.ts tests/wallet-graph.repository.test.ts tests/api-event-stream-migration.test.ts
npm run check
npm run lint
```

Expected: focused tests, check and lint pass.

- [ ] **Step 7: Commit**

```bash
git add migrations/008_wallet_graph.sql src/storage/wallet-graph.repository.ts tests/wallet-graph-migration.test.ts tests/wallet-graph.repository.test.ts tests/api-event-stream-migration.test.ts
git commit -m "feat: persist deterministic wallet graphs"
```

## Task 8: Expose bounded cluster analytics through API V1

**Files:**

- Modify: `src/api/contracts.ts`
- Modify: `src/config/env.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `src/app.ts`
- Modify: `.env.example`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`
- Modify: `tests/api-router.test.ts`
- Modify: `tests/config-safety.test.ts`
- Modify: `tests/bootstrap-safety.test.ts`

- [ ] **Step 1: Write failing contract/config tests**

Require:

```ts
clusterAnalysisStatus: 'AVAILABLE';
clusterMethodology: 'OBSERVED_PUMPFUN_TRANSACTIONS';
clusterCount: number;
clustersTruncated: boolean;
clusterCoverage: ApiWalletGraphCoverage;
clusters: readonly ApiWalletCluster[];
```

Test defaults `50`, `50`, `500`; reject cluster >100, per-cluster member >100
and total member >1,000. Verify `src/app.ts` passes the limits to the existing
read-only projection repository without constructing either I2 processing
service.

- [ ] **Step 2: Write failing projection tests**

Cover:

- no graph snapshot gives `clusterAnalysisStatus: 'NOT_AVAILABLE'`;
- successful zero-cluster snapshot gives `AVAILABLE` with `[]`;
- current fingerprint selects current clusters after orphan rewind;
- clusters order by concentration descending then ID;
- members order by positive position descending then wallet;
- 101 configured clusters are rejected;
- per-cluster truncation is explicit;
- the total member budget is shared deterministically and never exceeded;
- relations are represented only by counts;
- corrupt bigint, status, role, count or fingerprint throws
  `ApiProjectionDataError`.

- [ ] **Step 3: Run tests and verify RED**

```bash
npx tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts tests/api-router.test.ts tests/config-safety.test.ts tests/bootstrap-safety.test.ts
```

Expected: missing available cluster contracts/config fields.

- [ ] **Step 4: Implement contracts and limits**

Extend `ApiHolderProjectionLimits`:

```ts
export interface ApiHolderProjectionLimits {
  readonly positions: number;
  readonly snapshots: number;
  readonly clusters: number;
  readonly clusterMembers: number;
  readonly totalClusterMembers: number;
}
```

Add `apiWalletClusterLimit`, `apiWalletClusterMemberLimit` and
`apiWalletClusterTotalMemberLimit` to `AppConfig`, parsing exact design
bounds. Keep `ApiHolders` discriminated so graph fields only exist when graph
analysis is available.

- [ ] **Step 5: Implement bounded SQL projection**

Read `wallet_graph_profiles` first, then select the graph snapshot and current
clusters by that exact current input fingerprint. Query at most `clusters + 1`
rows, then query members only for emitted cluster IDs with a SQL per-cluster
rank and an overall total cap. Return:

```ts
{
  clusterCount,
  clustersTruncated: storedClusterCount > clusters.length,
  clusters: clusters.map((cluster) => ({
    ...cluster,
    memberCount: storedMemberCount,
    membersTruncated: storedMemberCount > members.length,
    members,
  })),
}
```

Never return relationship rows. Preserve the existing repeatable-read snapshot
and bounded query-count guarantees.

- [ ] **Step 6: Run API tests and commit**

```bash
npx tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts tests/api-router.test.ts tests/config-safety.test.ts tests/bootstrap-safety.test.ts
npm run check
npm run lint
git add src/api/contracts.ts src/config/env.ts src/storage/api-projection.repository.ts src/app.ts .env.example tests/api-contracts.test.ts tests/api-projection.repository.test.ts tests/api-router.test.ts tests/config-safety.test.ts tests/bootstrap-safety.test.ts
git commit -m "feat: expose bounded wallet clusters"
```

Expected: tests/check/lint pass before commit.

## Task 9: Integrate four-hour purge without orphaning retained rows

**Files:**

- Modify: `src/storage/database.ts`
- Modify: `tests/wallet-graph.repository.test.ts`
- Modify: `tests/api-event-stream-migration.test.ts`

- [ ] **Step 1: Write failing purge tests**

Insert an expired launch with assessments, evidence, relationships, cluster
members, clusters, graph snapshot and `WalletClusterDetected`. Assert one purge
removes all I2 rows and the derived event before the parent launch, while an
unexpired launch remains intact. Assert returned counters are exact.

- [ ] **Step 2: Run test and verify RED**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/wallet-graph.repository.test.ts tests/api-event-stream-migration.test.ts
```

Expected: I2 rows/counters remain.

- [ ] **Step 3: Implement dependency-ordered purge**

Add counters for:

```ts
walletFundingObservations
walletFundingEvidence
walletRelationships
walletGraphProfiles
walletClusterMembers
walletClusters
walletGraphSnapshots
```

Delete child projections before clusters, delete I2 evidence/projections by
expired parent mint, and include `WalletClusterDetected` in the derived-event
delete before the generic `domain_events` and `token_launches` deletes.

- [ ] **Step 4: Run purge and database tests**

```bash
TEST_DATABASE_URL=postgresql:///postgres npx tsx --test tests/wallet-graph.repository.test.ts tests/api-event-stream-migration.test.ts tests/wallet-graph-migration.test.ts
npm run check
```

Expected: focused tests and check pass.

- [ ] **Step 5: Commit**

```bash
git add src/storage/database.ts tests/wallet-graph.repository.test.ts tests/api-event-stream-migration.test.ts
git commit -m "feat: purge retained wallet graph data"
```

## Task 10: Document passive semantics and validate the PR

**Files:**

- Modify: `README.md`
- Modify: `docs/api/v1.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `tests/bootstrap-safety.test.ts`

- [ ] **Step 1: Write the failing safety assertion**

Assert the production bootstrap imports neither evidence/rebuild service and
that Pump.fun remains stopped:

```ts
assert.doesNotMatch(appSource, /WalletEvidenceObservationService/u);
assert.doesNotMatch(appSource, /WalletGraphRebuildService/u);
assert.equal(PRODUCTION_API_PIPELINE_STATE.pumpfun, 'STOPPED');
```

- [ ] **Step 2: Update documentation**

Document:

- observed transactions only, no history;
- strong direct quote transfer versus medium fee payer;
- self-transfers ignored;
- `NOT_PROCESSED`, `UNAVAILABLE` and `NO_EVIDENCE` distinction;
- SOL, SPL Token and Token-2022 multi-quote without cross-asset sums;
- connected components use strong edges only;
- cluster concentration uses positive I1 observed flows, not certified SPL
  balances;
- response limits and truncation flags;
- four-hour post-terminal retention;
- both cluster reason codes remain disabled until dry-run calibration;
- no listener composition, key, signing, submission or live execution.

- [ ] **Step 3: Run focused safety checks**

```bash
npx tsx --test tests/bootstrap-safety.test.ts tests/api-contracts.test.ts tests/config-safety.test.ts
rg -n "SHARED_FUNDER_CLUSTER|RELATED_WALLET_CLUSTER_EXCEEDED" src/qualification src/app.ts
rg -n "sendTransaction|signTransaction|Keypair|secretKey" src/application/wallet-* src/analytics/wallet-* src/storage/wallet-* src/solana/wallet-* || true
```

Expected: tests pass; no I2 qualification activation and no signing/submission
capability in I2 sources.

- [ ] **Step 4: Run the complete acceptance suite**

```bash
npm install
npm run build
npm run check
npm run lint
TEST_DATABASE_URL=postgresql:///postgres npm test
git diff --check main...HEAD
git status --short
```

Expected:

- install exits zero;
- build/check/lint exit zero;
- every existing and new test passes;
- no whitespace errors;
- only intentional committed I2 changes remain.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/api/v1.md docs/architecture/pumpfun-v1.md tests/bootstrap-safety.test.ts
git commit -m "docs: explain observed wallet graph limits"
```

- [ ] **Step 6: Request final review before push**

Use `superpowers:requesting-code-review` against `main...HEAD`. Resolve every
Critical or Important finding with focused regression tests, rerun the full
acceptance suite, then push and open the PR. Do not merge until GitHub checks
and review threads are clear.
