# Pump.fun Catch-up Block Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inactive Pump.fun catch-up block classifier that hydrates each slot group before writing deterministic B1 classifications, and make semantic replay preserve the first four-hour retention window.

**Architecture:** One application service groups `MergedCatchUpDiscovery` values by slot and effective commitment, uses an injected serialized transaction locator, decodes with `decodePumpTransaction`, then records closed `CatchUpClassification` values through the existing repository port. No production composition is added. The B1 PostgreSQL repository accepts a newer replay clock only when semantic evidence is unchanged and retains the first classification/terminal/purge timestamps.

**Tech Stack:** TypeScript strict ESM, Node.js test runner, official Pump.fun IDL-derived decoder, SHA-256, PostgreSQL 16, existing block cache and transaction inbox repository.

---

## File map

- Create `src/application/pumpfun-catch-up-block-classifier.ts`: inactive orchestration service, closed classification policy and deterministic fingerprint.
- Create `tests/pumpfun-catch-up-block-classifier.test.ts`: offline tests with in-memory dependencies and sanitized normalized fixtures.
- Modify `src/storage/transaction-inbox.repository.ts`: accept semantic replay with a newer clock and preserve the first retention timestamps.
- Modify `tests/transaction-inbox.repository.test.ts`: PostgreSQL 16 regression for replay clock and non-extendable retention.
- Keep `src/app.ts`, scanner/factory/config/checkpoint code, migrations, wallet and executor code unchanged.
- Keep the versioned specs in `docs/superpowers/specs/2026-09-19-pumpfun-catch-up-block-classifier-design.md` and `docs/superpowers/specs/2026-09-12-catch-up-classification-ledger-design.md` aligned with the implementation.

### Task 1: Specify the inactive classifier contract in RED tests

**Files:**
- Create: `tests/pumpfun-catch-up-block-classifier.test.ts`
- Reference: `tests/helpers/pumpfun-fixture.ts`
- Reference: `tests/fixtures/pumpfun/create-v2-current-initial-buy-mainnet.json`
- Reference: `tests/fixtures/pumpfun/buy-exact-quote-v2-cpi-mainnet.json`
- Reference: `tests/fixtures/pumpfun/sell-cpi-mainnet.json`

- [ ] **Step 1: Add the test harness and the create-with-initial-buy case**

Import the absent service, trusted locator errors, B1 repository port,
normalized transaction type and fixture loader. Define a locator that records
targets and returns transactions by signature, plus a repository that records
classifications in call order:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PumpFunCatchUpBlockClassifier,
} from '../src/application/pumpfun-catch-up-block-classifier.js';
import type { MergedCatchUpDiscovery } from '../src/application/catch-up-discovery.js';
import type { CatchUpClassification } from '../src/domain/catch-up-classification.js';
import type { CatchUpClassificationRepository } from '../src/ports/catch-up-classification-repository.js';
import {
  internalLocatorError,
  RpcTransientError,
  TransactionIndexNotFoundError,
  TransactionNormalizationError,
  type TransactionLocationTarget,
} from '../src/solana/rpc/transaction-locator.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { loadPumpFixture } from './helpers/pumpfun-fixture.js';

class RecordingLocator {
  public readonly targets: TransactionLocationTarget[] = [];
  public constructor(
    private readonly results: ReadonlyMap<string, NormalizedTransaction | Error>,
  ) {}
  public async locate(target: TransactionLocationTarget): Promise<NormalizedTransaction> {
    this.targets.push(Object.freeze({ ...target }));
    const result = this.results.get(target.signature);
    if (result instanceof Error) throw result;
    assert.ok(result);
    return result;
  }
}

class RecordingRepository implements CatchUpClassificationRepository {
  public readonly values: CatchUpClassification[] = [];
  public async recordCatchUpClassification(value: CatchUpClassification): Promise<void> {
    this.values.push(value);
  }
}

function discovery(
  transaction: NormalizedTransaction,
  confirmationStatus: MergedCatchUpDiscovery['confirmationStatus'] = 'finalized',
): MergedCatchUpDiscovery {
  return Object.freeze({
    signature: transaction.signature,
    slot: transaction.slot,
    confirmationStatus,
    blockTimeMs: transaction.blockTimeMs,
    programIds: Object.freeze([PUMP_PROGRAM_ID]),
  });
}

void test('classifies a Pump.fun creation and its initial buy as one actionable launch', async () => {
  const transaction = (await loadPumpFixture(
    'create-v2-current-initial-buy-mainnet.json',
  )).transaction;
  const locator = new RecordingLocator(new Map([[transaction.signature, transaction]]));
  const repository = new RecordingRepository();
  const classifier = new PumpFunCatchUpBlockClassifier(locator, repository, () => 10_000);

  await classifier.classify(Object.freeze([discovery(transaction)]));

  const value = repository.values[0];
  assert.ok(value);
  assert.equal(value.disposition, 'ACTIONABLE');
  assert.equal(value.reasonCode, 'PUMP_ACTION_SUPPORTED');
  assert.equal(value.ingestionHint, 'PUMPFUN_CREATE');
  assert.equal(value.ingestionHintMint, null);
  assert.equal(value.classifiedAtMs, 10_000);
  assert.equal(value.observedAtMs, 10_000);
  assert.equal(value.mints.length, 1);
  assert.match(value.evidenceFingerprint, /^[0-9a-f]{64}$/u);
});
```

- [ ] **Step 2: Add the closed decision-table cases**

Add focused tests that assert:

```text
buy-exact-quote-v2-cpi-mainnet.json -> DEFERRED/PUMP_TRADE_UNTRACKED
transaction clone with error != null -> IGNORED/SOLANA_TRANSACTION_FAILED
transaction clone with instructions=[] -> IGNORED/NO_SUPPORTED_PUMP_ACTION
combined buy/sell with distinct mints -> QUARANTINED/PUMP_SCHEMA_UNSUPPORTED
more than 16 decoded create/trade mints -> QUARANTINED/PUMP_SCHEMA_UNSUPPORTED
```

For the multi-mint transaction, copy both fixture instruction arrays. Offset
every `instructionIndex` and non-null `parentInstructionIndex` in the second
array by `firstMaxInstructionIndex + 1`; retain inner indexes and stack heights.
Assert sorted unique mints, null hint and null hint mint so the real decoder is
exercised instead of a fabricated decoded result.

Exercise the ledger bound through the exported pure decoded-evidence projector:
provide seventeen canonical unique trade mints, assert persisted `mints` is the
empty array, and assert the fingerprint changes when the overflow count changes
from seventeen to eighteen. This projector is also called by the service after
`decodePumpTransaction`; it is not an alternate decoder dependency.

- [ ] **Step 3: Add trusted and untrusted failure cases**

Use one discovery per case and construct authority-bearing errors with the
existing factory:

```ts
const missing = internalLocatorError(new TransactionIndexNotFoundError());
const malformed = internalLocatorError(new TransactionNormalizationError());
const retryable = internalLocatorError(new RpcTransientError());
```

Assert missing signature becomes
`QUARANTINED/PROVIDER_SIGNATURE_MISSING`, normalization becomes
`QUARANTINED/PUMP_SCHEMA_UNSUPPORTED`, and retryable failure rejects with zero
repository calls. Return a transaction clone whose `transactionIndex` is null
and assert its trusted decoder failure becomes
`QUARANTINED/PUMP_SCHEMA_UNSUPPORTED`. A plain `new Error('untrusted')` must
reject the group and persist nothing.

- [ ] **Step 4: Add slot barrier, commitment and deterministic-order tests**

First add invalid-input cases for a top-level proxy, sparse array, accessor,
extra key, more than 100,000 entries, an accessor/proxy/extra or missing row
field, malformed slot/finality/block time, missing Pump.fun provenance,
unsorted or duplicate program IDs and a duplicate signature. Assert each
rejects before a clock read, locator call or repository call. Return a
transaction whose signature or slot differs from its discovery and assert the
entire slot rejects with zero writes.

Use deferred locator promises for two signatures in one slot. Assert both
location calls start before either promise settles. Resolve the lexically first
hydration and assert no repository call occurs until the second settles; then
assert lexical write order. Provide processed and confirmed rows in one slot
and finalized in the same slot. Assert the locator receives
`CONFIRMED`, `CONFIRMED`, `FINALIZED`, while the three persisted classifications
retain lowercase `processed`, `confirmed`, `finalized` from their discoveries.
Resolve both confirmed-bucket hydrations first and assert there is still no
write until finalized hydration and decoding complete. Writes then follow
effective `CONFIRMED`, `FINALIZED`, and lexical signature order.

Place a retryable failure last in one slot and assert zero slot writes. Add
two slot groups and assert ascending slot order.

- [ ] **Step 5: Add fingerprint and partial-write replay tests**

Run identical semantic discovery twice with clocks `10_000` and `20_000` and
confirmed/finalized status. Assert equal fingerprints and different timestamps.
Change the decoded action set and assert a different fingerprint.

Assert exact markers distinguish `TRANSACTION_INDEX_NOT_FOUND`,
`NORMALIZATION_FAILED`, each trusted Pump decoder origin, and mint overflow.
Assert action segments contain cursor, family, mint and action count, including
`MIGRATE` evidence even though migration-only classification is ignored.

Make a repository fake fail on its second write during the first call. Assert
the first signature was committed, retry with a newer clock, and assert the
same semantic fingerprints and order. This proves replayability without
claiming cross-signature atomicity.

- [ ] **Step 6: Run the new test and verify RED**

```bash
npx tsx --test tests/pumpfun-catch-up-block-classifier.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`src/application/pumpfun-catch-up-block-classifier.js`.

### Task 2: Implement the minimal classifier and make the offline suite GREEN

**Files:**
- Create: `src/application/pumpfun-catch-up-block-classifier.ts`
- Test: `tests/pumpfun-catch-up-block-classifier.test.ts`

- [ ] **Step 1: Define the narrow inactive boundary**

```ts
export interface PumpFunCatchUpTransactionLocator {
  locate(target: TransactionLocationTarget): Promise<NormalizedTransaction>;
}

export class PumpFunCatchUpBlockClassifier {
  public constructor(
    private readonly locator: PumpFunCatchUpTransactionLocator,
    private readonly repository: CatchUpClassificationRepository,
    private readonly now: () => number = Date.now,
  ) {}

  public async classify(discoveries: readonly MergedCatchUpDiscovery[]): Promise<void> {
    const slots = snapshotAndGroupDiscoveries(discoveries);
    const classifiedAtMs = this.now();
    assertSafeMilliseconds(classifiedAtMs);
    for (const slot of slots) {
      const outcomes = await hydrateEntireSlot(this.locator, slot);
      const classifications = outcomes.map((outcome) =>
        classificationFor(outcome, classifiedAtMs));
      for (const classification of classifications) {
        await this.repository.recordCatchUpClassification(classification);
      }
    }
  }
}
```

`snapshotAndGroupDiscoveries` copies rather than sorts the caller array, maps
processed and confirmed to effective `CONFIRMED`, keeps finalized as
`FINALIZED`, orders slots numerically, then orders rows by commitment and
signature. Reject duplicate input signatures before locator or repository
calls.

Pass only effective uppercase `CONFIRMED`/`FINALIZED` to the locator, but populate
`CatchUpClassification.confirmationStatus` explicitly from the corresponding
discovery. Do not derive business finality from the normalized transaction,
which contains the effective locator status.

- [ ] **Step 2: Validate and snapshot the complete input before effects**

Before reading `now`, validate the top-level input as a non-proxy, dense,
data-only array with no extra keys and at most 100,000 entries. Validate every
discovery as an exact plain data record: no proxies/accessors/extra keys;
bounded non-empty signature; safe non-negative bigint slot; lowercase
`processed|confirmed|finalized`; valid nullable safe `blockTimeMs`; and one to
sixteen canonical sorted unique program IDs including `PUMP_PROGRAM_ID`. Copy
and freeze every record and nested array. Reject duplicate signatures globally.

The RED tests from Task 1 prove malicious input has zero clock reads, locator
calls and repository calls.

- [ ] **Step 3: Hydrate and classify a complete slot before writes**

Use a closed internal result:

```ts
type HydrationOutcome =
  | Readonly<{ kind: 'TRANSACTION'; discovery: MergedCatchUpDiscovery;
      transaction: NormalizedTransaction }>
  | Readonly<{ kind: 'QUARANTINE'; discovery: MergedCatchUpDiscovery;
      reasonCode: 'PUMP_SCHEMA_UNSUPPORTED' | 'PROVIDER_SIGNATURE_MISSING' }>;
```

For each ascending slot, start all `hydrate(row)` calls from both effective
commitment buckets, wait for every result through `Promise.allSettled`, and
select any rejection deterministically only after the full slot has settled.
Reconstruct fulfilled outcomes in input order and build every classification
before returning. This concurrency is required so calls sharing a cache key
join one single-flight even when the first target cannot retain the block.
Verify the located
transaction signature and slot exactly equal its discovery before inspecting
or decoding it; mismatch rejects the slot as an untrusted dependency failure.
Map only trusted terminal locator
failures: `TRANSACTION_INDEX_NOT_FOUND` to `PROVIDER_SIGNATURE_MISSING` and
`NORMALIZATION_FAILED` to `PUMP_SCHEMA_UNSUPPORTED`. A trusted retryable failure
or untrusted exception rejects before persistence.

- [ ] **Step 4: Apply the ordered Pump.fun policy through the real decoder**

Check `transaction.error !== null` before decoding. Otherwise call
`decodePumpTransaction(transaction)` and accept only exact trusted decoder
identity from `trustedObservedPipelineOrigin(error)` whose code is also in
`PUMP_DECODING_ERROR_CODES`; a trusted origin from another adapter is rejected.
The service passes the
decoded value to an exported pure decoded-evidence projector used by focused
policy tests. Apply:

```ts
export function createPumpFunCatchUpClassificationFromDecoded(
  discovery: MergedCatchUpDiscovery,
  decoded: DecodedPumpTransaction,
  classifiedAtMs: number,
): CatchUpClassification;
```

```ts
if (transaction.error !== null) return ignored('SOLANA_TRANSACTION_FAILED');
const evidenceMints = allCreateAndTradeMints(decoded);
if (evidenceMints.length > 16) return quarantinedMintOverflow(evidenceMints.length);
if (decoded.creations.length > 0) return actionableCreate(allCreateAndTradeMints(decoded));
const tradeMints = canonicalTradeMints(decoded);
if (tradeMints.length === 1) return deferredTrade(tradeMints[0]);
if (tradeMints.length > 1) return quarantined('PUMP_SCHEMA_UNSUPPORTED', tradeMints);
return ignored('NO_SUPPORTED_PUMP_ACTION');
```

Every branch calls `createCatchUpClassification`, retains discovery identity,
programs and finality, uses the call clock for both timestamps, and freezes
canonical arrays.

`quarantinedMintOverflow` persists an empty mint array and adds the stable
`MINT_LIMIT_EXCEEDED:<count>` marker to the fingerprint. Ordered semantic action
segments remain in that fingerprint, preventing two different overflow action
sets with the same count from becoming identical.

- [ ] **Step 5: Implement semantic fingerprinting**

Sort actions by instruction index, null-first inner index, family and mint. Hash
length-prefixed UTF-8 segments:

```ts
function fingerprint(segments: readonly string[]): string {
  const digest = createHash('sha256');
  for (const segment of segments) {
    const bytes = Buffer.from(segment, 'utf8');
    digest.update(String(bytes.length));
    digest.update(':');
    digest.update(bytes);
  }
  return digest.digest('hex');
}
```

Include the V1 tag, signature, decimal slot, disposition/reason/hint/hint mint,
canonical mints, `ACTION_COUNT:<count>`, and ordered
`ACTION:<instructionIndex>:<inner-or-NONE>:<family>:<mint>` evidence. Families
include `CREATE`, `BUY`, `SELL` and `MIGRATE`; migrations affect evidence even
when the result is `NO_SUPPORTED_PUMP_ACTION`.

Use one precise closed marker per outcome: stable failed/no-action markers,
`LOCATOR:<trusted-code>`, `DECODER:<trusted-origin>` or
`MINT_LIMIT_EXCEEDED:<count>`. Exclude program IDs, all time, finality, provider
text and raw payload.

- [ ] **Step 6: Run focused suites GREEN**

Before the command below, add one offline integration case using the real
`CachedSolanaBlockTransactionLocator`: classify at least two absent signatures
from the same cold slot and effective commitment, then assert
`locator.metrics.fetches === 1`, zero repository writes and no pending work.

```bash
npx tsx --test tests/pumpfun-catch-up-block-classifier.test.ts
npx tsx --test tests/pumpfun-transaction-decoder.test.ts \
  tests/block-transaction-cache.test.ts tests/catch-up-classification.test.ts
```

Expected: all PASS with no network access.

- [ ] **Step 7: Commit the classifier slice**

```bash
git add src/application/pumpfun-catch-up-block-classifier.ts \
  tests/pumpfun-catch-up-block-classifier.test.ts
git commit -m "feat(listener): classify Pump.fun catch-up blocks"
```

### Task 3: Reproduce the B1 replay-clock defect with PostgreSQL 16

**Files:**
- Modify: `tests/transaction-inbox.repository.test.ts`

- [ ] **Step 1: Replace timestamp-conflict coverage with semantic replay**

Keep changed fingerprint and decision in the immutable contradiction table, but
remove `{ classifiedAtMs: 1_002 }`. Add a table-driven regression covering
`ACTIONABLE`, `DEFERRED`, `IGNORED` and `QUARANTINED`. Each case persists an
initial classification, replays identical semantic evidence with newer
`observedAtMs`/`classifiedAtMs` and finalized status, then asserts the first
`catch_up_classified_at` remains unchanged. Actionable terminal timestamps stay
null; deferred, ignored and quarantined terminal/purge timestamps remain
exactly unchanged. The ignored case has this core shape:

```ts
void test('semantic classification replay preserves its first retention window', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const initial = createCatchUpClassification({
      ...catchUpClassificationInput('classified-new-clock-replay'),
      disposition: 'IGNORED', reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
      ingestionHint: null, ingestionHintMint: null, mints: Object.freeze([]),
    });
    await repository.recordCatchUpClassification(initial);
    const before = await row(pool, initial.signature);
    const replay = createCatchUpClassification({
      ...initial, confirmationStatus: 'finalized',
      observedAtMs: 2_000, classifiedAtMs: 2_001,
    });

    await repository.recordCatchUpClassification(replay);

    const after = await row(pool, initial.signature);
    assert.equal(after.catch_up_classified_at.getTime(),
      before.catch_up_classified_at.getTime());
    assert.equal(after.terminal_at.getTime(), before.terminal_at.getTime());
    assert.equal(after.purge_after.getTime(), before.purge_after.getTime());
    assert.equal(after.target_confirmation_status, 'finalized');
  });
});
```

Add a separate test that stores an untracked `DEFERRED` trade, captures its
terminal/purge timestamps, calls the existing `insertTrackedLaunch(pool)`, and
replays with a newer clock. Assert promotion to `PENDING/TRACKED_TRADE` clears
both `terminal_at` and `purge_after`. This is the intended tracked-mint lifecycle,
not retention extension.

- [ ] **Step 2: Run the new PG16 test and verify RED**

```bash
: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to the dedicated PostgreSQL 16 test database}"
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  --test-name-pattern="semantic classification replay|deferred classification promotion" \
  tests/transaction-inbox.repository.test.ts
```

Expected: FAIL with `TransactionInboxConflictError` conflict
`classification`, proving `classifiedAtMs` is still compared.

### Task 4: Preserve first timestamps on semantic replay

**Files:**
- Modify: `src/storage/transaction-inbox.repository.ts`
- Test: `tests/transaction-inbox.repository.test.ts`

- [ ] **Step 1: Remove wall-clock time from semantic identity**

In `storedClassificationMatches`, retain slot, version, disposition, reason,
action key, fingerprint, source and canonical mints. Remove only:

```ts
dateMs(row.catch_up_classified_at, 'catch-up classified at') !== value.classifiedAtMs
```

- [ ] **Step 2: Anchor terminal replay to stored time**

```ts
const firstClassifiedAt = dateFromMs(
  dateMs(row.catch_up_classified_at, 'catch-up classified at'),
);
const storedTerminalAt = nullableDateFromMs(
  nullableDateMs(row.terminal_at, 'classification replay terminal at'),
);
const replayTerminalAt = shouldReplay ? null : pristine
  ? (replayDecision.status === 'PENDING'
      ? null
      : storedTerminalAt ?? firstClassifiedAt)
  : storedTerminalAt;
```

Preserve an existing purge deadline, creating one only for a pristine
previously pending row that becomes terminal:

```sql
purge_after=CASE WHEN $9::TIMESTAMPTZ IS NULL THEN NULL
  ELSE COALESCE(purge_after,$9::TIMESTAMPTZ+INTERVAL '4 hours') END
```

Never assign `catch_up_classified_at` on replay. Keep the existing actionable
processed-confirmed to finalized reprocessing behavior.

- [ ] **Step 3: Run replay regressions GREEN**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  --test-name-pattern="classification replay|semantic classification replay" \
  tests/transaction-inbox.repository.test.ts
```

Expected: new-clock replay, contradictions, finality replay and program
convergence all PASS.

- [ ] **Step 4: Run repository and migration targets**

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/transaction-inbox.repository.test.ts \
  tests/transaction-inbox-catch-up-classification-migration.test.ts
```

Expected: all PostgreSQL 16 tests PASS; migration 048 remains unchanged.

- [ ] **Step 5: Commit the replay correction**

```bash
git add src/storage/transaction-inbox.repository.ts \
  tests/transaction-inbox.repository.test.ts
git commit -m "fix(listener): preserve catch-up classification retention"
```

### Task 5: Audit scope and run the complete verification set

**Files:**
- Verify: `src/application/pumpfun-catch-up-block-classifier.ts`
- Verify: `src/storage/transaction-inbox.repository.ts`
- Verify: `tests/pumpfun-catch-up-block-classifier.test.ts`
- Verify: `tests/transaction-inbox.repository.test.ts`
- Verify: `docs/superpowers/specs/2026-09-19-pumpfun-catch-up-block-classifier-design.md`
- Verify: `docs/superpowers/specs/2026-09-12-catch-up-classification-ledger-design.md`

- [ ] **Step 1: Prove the classifier remains inactive**

```bash
rg -n "PumpFunCatchUpBlockClassifier" src \
  --glob '!application/pumpfun-catch-up-block-classifier.ts'
git diff origin/main...HEAD -- src/app.ts src/config src/cli migrations
```

Expected: the first command has no matches and the second has no diff. Confirm
the classifier has no import from executor, wallet, signing or submission code.

- [ ] **Step 2: Repeat the offline targets**

```bash
for run in 1 2 3 4 5; do
  npx tsx --test --test-concurrency=1 \
    tests/pumpfun-catch-up-block-classifier.test.ts \
    tests/block-transaction-cache.test.ts || exit 1
done
```

Expected: five consecutive PASS runs with deterministic order and no network.

- [ ] **Step 3: Repeat repository verification sequentially**

```bash
for run in 1 2; do
  TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
    tests/transaction-inbox.repository.test.ts \
    tests/transaction-inbox-catch-up-classification-migration.test.ts || exit 1
done
```

Expected: two consecutive PostgreSQL 16 PASS runs without retention extension.

- [ ] **Step 4: Run project gates**

```bash
npm run build
npm run check
npm run lint
npm run docs:check
npm test
git diff --check origin/main...HEAD
```

Expected: every command exits zero and generated Pump.fun/PumpSwap artifacts
remain unchanged.

- [ ] **Step 5: Review the complete diff against exclusions**

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
git status --short
```

Expected implementation changes are limited to the classifier, transaction
inbox repository, their tests and versioned documentation. The worktree is
clean after commits. There is no scanner, factory, configuration, checkpoint,
migration, wallet, executor or live RPC change.

### Task 6: Push and open the isolated B2b pull request

**Files:**
- No additional file changes.

- [ ] **Step 1: Push only after all gates pass**

```bash
git push -u origin feat/133-pumpfun-catch-up-classifier
```

Expected: remote feature branch created without modifying local `main`.

- [ ] **Step 2: Open one PR linked to #133 and dependent on #126/#129**

```bash
gh pr create \
  --base main \
  --head feat/133-pumpfun-catch-up-classifier \
  --title "feat(listener): classify Pump.fun catch-up blocks" \
  --body-file /tmp/issue-133-pr-body.md
```

Before this command, create `/tmp/issue-133-pr-body.md` outside the repository
with this exact body:

```markdown
## Summary
- add an inactive Pump.fun catch-up block classifier over the serialized block locator
- persist deterministic B1 classifications only after each slot group is fully hydrated
- preserve the first classification and four-hour retention timestamps on semantic replay

## Safety
- no scanner/factory/config/checkpoint/runtime wiring
- no migration, wallet, signing, submission or live RPC
- depends on #126 and #129

Closes #133
```

Expected: one mergeable PR whose diff contains no production activation. Do not
request review or merge until the parent delivery loop starts its configured
review cycles.
