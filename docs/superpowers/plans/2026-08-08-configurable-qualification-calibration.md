# Configurable Pump.fun Qualification Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load one strict versioned Pump.fun calibration profile and produce explainable score, blocker, holder-cluster, and round-trip decisions without enabling live execution.

**Architecture:** A bounded local JSON loader validates and fingerprints an immutable effective profile. A pure policy evaluator converts integer calibration facts and trusted upstream reason assessments into condition evidence; `QualificationEngine` combines those conditions with score evidence while keeping enforced blockers independent. Startup loads the profile before any database or network resource, and the public API adds backward-compatible profile and condition fields.

**Tech Stack:** TypeScript 5 strict ESM, Node.js 22+ `node:crypto`/`node:fs`, canonical JSON utilities, Node test runner, PostgreSQL JSONB projections, Bootstrap diagnostic documentation.

---

## File map

- `config/qualification/pumpfun-v1-unvalidated.json` — single bundled calibration source.
- `src/domain/qualification.ts` — profile, policy, facts, condition, and report contracts.
- `src/qualification/qualification-profile.ts` — exact JSON validation, override, immutable snapshot, fingerprint, and local loading.
- `src/qualification/qualification-policy-evaluator.ts` — pure integer condition evaluation.
- `src/qualification/qualification-engine.ts` — score and verdict composition.
- `scripts/copy-qualification-profiles.ts` — deterministic build artifact copy.
- `src/config/env.ts` and `src/app.ts` — safe selection and startup wiring.
- `src/api/contracts.ts` and `src/storage/api-projection.repository.ts` — additive V1 output and legacy payload compatibility.
- `tests/qualification-profile.test.ts` — parser, fingerprint, and loader tests.
- `tests/qualification-policy-evaluator.test.ts` — numeric and enforcement boundary tests.
- Existing qualification, config, bootstrap, API, packaging, and safety tests — integration regression coverage.

## Task 1: Define calibration contracts

**Files:**
- Modify: `src/domain/qualification.ts`
- Test: `tests/qualification-profile.test.ts`

- [ ] **Step 1: Write the failing contract test**

Create `tests/qualification-profile.test.ts` with assertions for the complete stable registries and a deeply frozen canonical profile fixture:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QUALIFICATION_CONDITION_MODES,
  QUALIFICATION_CONDITION_STATUSES,
  assertValidQualificationFacts,
  type QualificationCalibrationFacts,
} from '../src/domain/qualification.js';

void test('publishes stable calibration modes and validates bigint facts', () => {
  assert.deepEqual(QUALIFICATION_CONDITION_MODES, [
    'DISABLED', 'REPORT_ONLY', 'ENFORCED',
  ]);
  assert.deepEqual(QUALIFICATION_CONDITION_STATUSES, [
    'PASSED', 'TRIGGERED', 'UNKNOWN', 'NOT_CONFIGURED', 'DISABLED',
  ]);
  const facts: QualificationCalibrationFacts = Object.freeze({
    top1HolderBps: 2_000n,
    top5HoldersBps: 5_000n,
    top10HoldersBps: 7_000n,
    maximumRelatedClusterBps: 3_000n,
    maximumSharedFunderCount: 1,
    buySimulationSucceeded: true,
    sellQuoteAvailable: true,
    roundTripLossBps: 3_000n,
    upstreamConditions: Object.freeze([]),
  });
  assert.doesNotThrow(() => assertValidQualificationFacts(facts));
  assert.throws(() => assertValidQualificationFacts(Object.freeze({
    ...facts, roundTripLossBps: -1n,
  })));
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx tsx --test tests/qualification-profile.test.ts
```

Expected: TypeScript import failure because the calibration constants and facts validator do not exist.

- [ ] **Step 3: Add the exact domain contracts and validators**

Add these public shapes to `src/domain/qualification.ts`:

```typescript
export const QUALIFICATION_CONDITION_MODES = [
  'DISABLED', 'REPORT_ONLY', 'ENFORCED',
] as const;
export type QualificationConditionMode =
  (typeof QUALIFICATION_CONDITION_MODES)[number];

export const QUALIFICATION_CONDITION_STATUSES = [
  'PASSED', 'TRIGGERED', 'UNKNOWN', 'NOT_CONFIGURED', 'DISABLED',
] as const;
export type QualificationConditionStatus =
  (typeof QUALIFICATION_CONDITION_STATUSES)[number];

export interface QualificationUpstreamCondition {
  readonly code: QualificationReasonCode;
  readonly triggered: boolean;
}

export interface QualificationCalibrationFacts {
  readonly top1HolderBps: bigint | null;
  readonly top5HoldersBps: bigint | null;
  readonly top10HoldersBps: bigint | null;
  readonly maximumRelatedClusterBps: bigint | null;
  readonly maximumSharedFunderCount: number | null;
  readonly buySimulationSucceeded: boolean | null;
  readonly sellQuoteAvailable: boolean | null;
  readonly roundTripLossBps: bigint | null;
  readonly upstreamConditions: readonly QualificationUpstreamCondition[];
}

export interface QualificationConditionPolicy {
  readonly code: QualificationReasonCode;
  readonly mode: QualificationConditionMode;
  readonly maximumTop1Bps: number | null;
  readonly maximumTop5Bps: number | null;
  readonly maximumTop10Bps: number | null;
  readonly maximumClusterBps: number | null;
  readonly minimumSharedFunders: number | null;
  readonly maximumRoundTripLossBps: number | null;
}

export interface EffectiveQualificationProfile extends QualificationRuleSet {
  readonly schemaVersion: 1;
  readonly fingerprint: string;
  readonly dimensionMaximums: Readonly<Record<QualificationDimension, number>>;
  readonly conditionPolicies: readonly QualificationConditionPolicy[];
}

export interface QualificationConditionEvidence {
  readonly code: QualificationReasonCode;
  readonly mode: QualificationConditionMode;
  readonly status: QualificationConditionStatus;
  readonly observed: Readonly<Record<string, bigint | number | boolean | null>>;
  readonly thresholds: Readonly<Record<string, bigint | number | null>>;
  readonly message: string;
}
```

Implement `assertValidQualificationFacts` without numeric coercion. Require a deeply frozen plain object, every field exactly once, non-negative bps no greater than `10_000n`, a non-negative safe shared-funder count, unique stable upstream codes, and primitive booleans. Reject accessors, symbols, sparse arrays, unknown keys, negative zero, and mutable nested data.

- [ ] **Step 4: Run the focused test and existing qualification tests**

Run:

```bash
npx tsx --test tests/qualification-profile.test.ts tests/qualification.test.ts
```

Expected: both files pass.

- [ ] **Step 5: Commit contracts**

```bash
git add src/domain/qualification.ts tests/qualification-profile.test.ts
git commit -m "feat: define qualification calibration contracts (#35)"
```

## Task 2: Validate and fingerprint the bundled profile

**Files:**
- Create: `config/qualification/pumpfun-v1-unvalidated.json`
- Create: `src/qualification/qualification-profile.ts`
- Modify: `tests/qualification-profile.test.ts`
- Modify: `src/config/env.ts`
- Modify: `tests/config-safety.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add failing parser and environment tests**

Extend `tests/qualification-profile.test.ts` to assert:

```typescript
void test('normalizes a complete profile and fingerprints canonical effective values', () => {
  const first = parseQualificationProfile(validRawProfile(), null);
  const reordered = parseQualificationProfile(reorderedRawProfile(), null);
  const overridden = parseQualificationProfile(validRawProfile(), 61);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(reordered.fingerprint, first.fingerprint);
  assert.notEqual(overridden.fingerprint, first.fingerprint);
  assert.equal(overridden.minimumTotalScore, 61);
  assert.equal(Object.isFrozen(first.conditionPolicies), true);
});
```

Add table-driven invalid cases: bytes above 65,536; invalid JSON; extra top-level key; wrong schema/status; unsafe integers; duplicate score signals; incorrect dimension total; missing, duplicate, or unknown reason policy; bad modes; thresholds outside `0..10000`; a threshold on the wrong reason code; an empty message; and a mutable direct-object input.

Extend `tests/config-safety.test.ts`:

```typescript
void test('selects one local profile and validates the fixed status', () => {
  assert.equal(parseConfig(base).qualificationProfilePath, null);
  assert.equal(
    parseConfig({ ...base, QUALIFICATION_PROFILE_PATH: './profile.json' })
      .qualificationProfilePath,
    './profile.json',
  );
  assert.throws(() => parseConfig({
    ...base, QUALIFICATION_RULE_SET_STATUS: 'VALIDATED',
  }), /QUALIFICATION_RULE_SET_STATUS/u);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test tests/qualification-profile.test.ts tests/config-safety.test.ts
```

Expected: failures for missing parser, profile path, and status validation.

- [ ] **Step 3: Add the default JSON profile**

Create the profile with `schemaVersion: 1`, id `pumpfun-v1-initial`, version `1`, status `UNVALIDATED_RULE_SET`, minimum score `60`, exact maxima `15/25/60`, the five behavior-compatible score rules, and one policy for each entry in `QUALIFICATION_REASON_CODES`.

Use these default modes:

```json
{
  "CREATOR_EARLY_SELL": "ENFORCED",
  "CREATOR_REPEAT_DUMPER": "DISABLED",
  "MINT_SOCIAL_MISMATCH": "REPORT_ONLY",
  "IMPERSONATION_SUSPECTED": "REPORT_ONLY",
  "HOLDER_CONCENTRATION_EXCEEDED": "REPORT_ONLY",
  "RELATED_WALLET_CLUSTER_EXCEEDED": "REPORT_ONLY",
  "SHARED_FUNDER_CLUSTER": "REPORT_ONLY",
  "BUY_SIMULATION_FAILED": "ENFORCED",
  "SELL_QUOTE_UNAVAILABLE": "ENFORCED",
  "ROUND_TRIP_LOSS_EXCEEDED": "ENFORCED",
  "STALE_DATA": "ENFORCED",
  "UNSUPPORTED_TOKEN_EXTENSION": "ENFORCED",
  "METADATA_FETCH_FAILED": "REPORT_ONLY",
  "UNSUPPORTED_QUOTE_MINT": "ENFORCED"
}
```

Holder and related-cluster maxima are null, shared-funder minimum is `1`, and round-trip maximum is `3000`.

- [ ] **Step 4: Implement the bounded parser and loader**

Create `QualificationProfileError` with stable codes:

```typescript
export type QualificationProfileErrorCode =
  | 'PROFILE_READ_FAILED'
  | 'PROFILE_TOO_LARGE'
  | 'PROFILE_JSON_INVALID'
  | 'PROFILE_SCHEMA_INVALID';
```

`parseQualificationProfile(raw: unknown, minimumScoreOverride: number | null)` validates exact own enumerable data descriptors, snapshots into null-prototype/plain frozen values, converts no strings to numbers, validates complete reason coverage, and computes:

```typescript
const fingerprint = createHash('sha256')
  .update(canonicalStringifyJson(effectiveWithoutFingerprint))
  .digest('hex');
```

Export the exact loader boundary:

```typescript
export interface LoadQualificationProfileOptions {
  readonly profilePath: string | null;
  readonly minimumScoreOverride: number | null;
  readonly workingDirectory?: string;
  readonly readFile?: (path: string | URL) => Buffer;
}

export function loadQualificationProfile(
  options: LoadQualificationProfileOptions,
): EffectiveQualificationProfile;
```

`loadQualificationProfile` resolves the default with
`new URL('../../config/qualification/pumpfun-v1-unvalidated.json', import.meta.url)` or resolves the configured local path from `process.cwd()`. Read at most `65_537` bytes so oversize detection is bounded. Map all filesystem/JSON/schema failures to the stable typed codes without retaining their causes or paths.

- [ ] **Step 5: Wire profile selection into `AppConfig`**

Add:

```typescript
readonly qualificationProfilePath: string | null;
```

Parse `QUALIFICATION_PROFILE_PATH` as either null or a non-empty canonical string of at most 4,096 UTF-8 bytes. Validate `QUALIFICATION_RULE_SET_STATUS` through the existing enum parser with the only allowed value `UNVALIDATED_RULE_SET`. Preserve the existing bounded `QUALIFICATION_MIN_SCORE` override.

Add these safe lines to `.env.example`:

```dotenv
QUALIFICATION_PROFILE_PATH=
QUALIFICATION_MIN_SCORE=60
QUALIFICATION_RULE_SET_STATUS=UNVALIDATED_RULE_SET
```

- [ ] **Step 6: Verify parser and config GREEN**

Run:

```bash
npx tsx --test tests/qualification-profile.test.ts tests/config-safety.test.ts
npm run check
```

Expected: all pass with no TypeScript errors.

- [ ] **Step 7: Commit profile loading**

```bash
git add config/qualification/pumpfun-v1-unvalidated.json src/qualification/qualification-profile.ts src/config/env.ts tests/qualification-profile.test.ts tests/config-safety.test.ts .env.example
git commit -m "feat: load versioned qualification profiles (#35)"
```

## Task 3: Package the profile deterministically

**Files:**
- Create: `scripts/copy-qualification-profiles.ts`
- Create: `tests/copy-qualification-profiles.test.ts`
- Modify: `package.json`
- Modify: `tests/copy-migrations.test.ts`

- [ ] **Step 1: Write the failing packaging tests**

Create a temporary source/target test that requires only the exact canonical filename, byte-for-byte output, stale target cleanup, and source validation through `parseQualificationProfile`. Add an assertion that the build command is exactly:

```text
tsc -p tsconfig.json && tsx scripts/copy-migrations.ts && tsx scripts/copy-qualification-profiles.ts
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test tests/copy-qualification-profiles.test.ts tests/copy-migrations.test.ts
```

Expected: missing module and old build-script assertion failures.

- [ ] **Step 3: Implement deterministic copy**

Export:

```typescript
export interface CopyQualificationProfilesOptions {
  readonly sourceDirectory: string;
  readonly targetDirectory: string;
}

export async function copyQualificationProfiles(
  options: CopyQualificationProfilesOptions,
): Promise<readonly ['pumpfun-v1-unvalidated.json']>;
```

Read the source with a bounded buffer, validate it with the same profile parser,
remove only the explicit target directory, recreate it, and copy exact bytes.
The CLI source is `config/qualification`; the target is
`dist/config/qualification`.

- [ ] **Step 4: Verify GREEN and built-source parity**

Run:

```bash
npx tsx --test tests/copy-qualification-profiles.test.ts tests/copy-migrations.test.ts
npm run build
cmp config/qualification/pumpfun-v1-unvalidated.json dist/config/qualification/pumpfun-v1-unvalidated.json
```

Expected: tests pass, one profile is packaged, and `cmp` exits zero.

- [ ] **Step 5: Commit packaging**

```bash
git add scripts/copy-qualification-profiles.ts tests/copy-qualification-profiles.test.ts tests/copy-migrations.test.ts package.json
git commit -m "build: package qualification profiles (#35)"
```

## Task 4: Evaluate holder, cluster, quote, and round-trip conditions

**Files:**
- Create: `src/qualification/qualification-policy-evaluator.ts`
- Create: `tests/qualification-policy-evaluator.test.ts`
- Modify: `src/domain/qualification.ts`

- [ ] **Step 1: Write boundary-first failing tests**

Cover exact threshold equality and one-bps exceedance:

```typescript
void test('reports holder and cluster dry-run triggers without enforcing them', () => {
  const profile = profileWithDryRunThresholds({
    maximumTop1Bps: 2_000,
    maximumClusterBps: 3_000,
  });
  const result = evaluateQualificationConditions(profile, facts({
    top1HolderBps: 2_001n,
    maximumRelatedClusterBps: 3_001n,
    maximumSharedFunderCount: 1,
  }), []);
  assert.deepEqual(result.blockers, []);
  assert.equal(condition(result, 'HOLDER_CONCENTRATION_EXCEEDED').status, 'TRIGGERED');
  assert.equal(condition(result, 'HOLDER_CONCENTRATION_EXCEEDED').mode, 'REPORT_ONLY');
});

void test('enforces unavailable sell quote and loss strictly above 3000 bps', () => {
  const atLimit = evaluateQualificationConditions(profile, facts({
    sellQuoteAvailable: true, roundTripLossBps: 3_000n,
  }), []);
  assert.equal(atLimit.blockers.length, 0);
  const exceeded = evaluateQualificationConditions(profile, facts({
    sellQuoteAvailable: false, roundTripLossBps: 3_001n,
  }), []);
  assert.deepEqual(exceeded.blockers, [
    'SELL_QUOTE_UNAVAILABLE', 'ROUND_TRIP_LOSS_EXCEEDED',
  ]);
});
```

Also test disabled creator history, report-only metadata/social codes, enforced upstream codes, unknown evidence, null thresholds as `NOT_CONFIGURED`, stable reason-code order, frozen output, duplicate upstream rejection, and no cross-condition inference.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test tests/qualification-policy-evaluator.test.ts
```

Expected: missing evaluator module.

- [ ] **Step 3: Implement the pure evaluator**

Export:

```typescript
export interface QualificationConditionResult {
  readonly conditions: readonly QualificationConditionEvidence[];
  readonly blockers: readonly QualificationReasonCode[];
}

export function evaluateQualificationConditions(
  profile: EffectiveQualificationProfile,
  facts: QualificationCalibrationFacts,
  legacyTriggeredCodes: readonly QualificationReasonCode[],
): QualificationConditionResult;
```

Validate profile/facts before reading them. Iterate policies in
`QUALIFICATION_REASON_CODES` order. Numeric comparisons convert configured
safe integers with `BigInt(threshold)` and never convert observations to
`number`. A condition is added to `blockers` only when status is `TRIGGERED`
and mode is `ENFORCED`. Deduplicate legacy codes and reject codes outside the
stable registry.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx tsx --test tests/qualification-policy-evaluator.test.ts tests/qualification-profile.test.ts
```

Expected: all policy and contract tests pass.

- [ ] **Step 5: Commit policy evaluation**

```bash
git add src/domain/qualification.ts src/qualification/qualification-policy-evaluator.ts tests/qualification-policy-evaluator.test.ts
git commit -m "feat: evaluate calibrated qualification conditions (#35)"
```

## Task 5: Integrate the effective profile into scoring and startup

**Files:**
- Modify: `src/qualification/qualification-engine.ts`
- Modify: `src/domain/qualification.ts`
- Modify: `tests/qualification.test.ts`
- Modify: `src/app.ts`
- Modify: `tests/bootstrap-safety.test.ts`

- [ ] **Step 1: Write failing engine and startup tests**

Update qualification tests to construct the engine from the effective profile and assert:

```typescript
assert.equal(report.ruleSet.fingerprint, profile.fingerprint);
assert.equal(report.conditions.length, QUALIFICATION_REASON_CODES.length);
assert.equal(report.verdict, 'REJECTED');
assert.equal(report.scores.total.score, 100);
```

The rejection case supplies a triggered `STALE_DATA`, proving the score cannot compensate. Add a report-only cluster trigger that leaves an otherwise qualified report `QUALIFIED`. Preserve the tests for a missing required signal and the minimum-score override.

In `tests/bootstrap-safety.test.ts`, inject a profile-aware engine summary and assert startup ordering and safe logging:

```typescript
assert.deepEqual(foundationLog, {
  event: 'listener.foundation_ready',
  executionMode: 'observe',
  cluster: 'mainnet-beta',
  paperQuoteMintAllowlist: [config.wsolMint],
  qualificationProfileId: 'pumpfun-v1-initial',
  qualificationProfileVersion: 1,
  qualificationRuleSetStatus: 'UNVALIDATED_RULE_SET',
  qualificationProfileFingerprint: 'a'.repeat(64),
  qualificationMinimumScore: 60,
  pumpFunListenerActive: true,
  pumpSwapPipelineAvailable: true,
  transactionSubmissionEnabled: false,
});
```

Add a loader failure test where `getDatabasePool`, listener, and API are never called and the public terminal log contains only the typed error name.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test tests/qualification.test.ts tests/bootstrap-safety.test.ts
```

Expected: missing profile fields/conditions and old foundation log shape.

- [ ] **Step 3: Compose policy and score evaluation**

Change `QualificationEngine` to snapshot an `EffectiveQualificationProfile`.
Extend `QualificationEvaluationInput` with:

```typescript
readonly calibrationFacts: QualificationCalibrationFacts | null;
```

For compatibility, `null` creates all-null facts and treats the existing
`blockers` array as trusted triggered upstream codes. Calculate score evidence,
evaluate conditions, turn only enforced triggered codes into human blockers,
then select `REJECTED`, `WATCHLISTED`, or `QUALIFIED` in that order. Include
fingerprint in `report.ruleSet` and the frozen conditions array.

- [ ] **Step 4: Load before external resources and log only safe identity**

`createQualificationEngine(config)` calls `loadQualificationProfile` using
`config.qualificationProfilePath` and `config.qualificationMinimumScore`, then
constructs the engine. Expose a frozen getter:

```typescript
public get profileSummary(): Readonly<{
  id: string;
  version: number;
  status: 'UNVALIDATED_RULE_SET';
  fingerprint: string;
  minimumTotalScore: number;
}>;
```

Update `ApplicationDependencies` and `logFoundation` to consume this summary.
Do not log the profile path or raw content. Keep profile construction before
the database-opening branch.

- [ ] **Step 5: Verify GREEN and safety**

Run:

```bash
npx tsx --test tests/qualification.test.ts tests/bootstrap-safety.test.ts tests/paper-trading-engine.test.ts tests/transaction-ingestion-recovery.test.ts
npm run check
```

Expected: all pass; paper and recovery fixtures use the effective default profile without behavior regression.

- [ ] **Step 6: Commit engine and startup**

```bash
git add src/qualification/qualification-engine.ts src/domain/qualification.ts tests/qualification.test.ts src/app.ts tests/bootstrap-safety.test.ts tests/paper-trading-engine.test.ts tests/transaction-ingestion-recovery.test.ts
git commit -m "feat: apply effective qualification calibration (#35)"
```

## Task 6: Expose additive profile and condition evidence through API V1

**Files:**
- Modify: `src/api/contracts.ts`
- Modify: `src/storage/api-projection.repository.ts`
- Modify: `tests/api-contracts.test.ts`
- Modify: `tests/api-projection.repository.test.ts`

- [ ] **Step 1: Write failing new-payload and legacy-payload tests**

The new payload must project a lowercase fingerprint and decimal strings:

```typescript
assert.equal(risk.ruleSet.fingerprint, 'a'.repeat(64));
assert.deepEqual(risk.conditions[0], {
  code: 'ROUND_TRIP_LOSS_EXCEEDED',
  mode: 'ENFORCED',
  status: 'TRIGGERED',
  observed: { roundTripLossBps: '3001' },
  thresholds: { maximumRoundTripLossBps: '3000' },
  message: 'Perte aller-retour supérieure au seuil configuré.',
});
```

An old retained payload without either field must return
`ruleSet.fingerprint: null` and `conditions: []`. Add corrupt cases for malformed
fingerprints, modes/statuses, unknown codes, non-decimal numeric evidence,
oversized arrays, and unexpected nested values.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts
```

Expected: missing API fields and old projector shape.

- [ ] **Step 3: Add stable API contracts and conservative projection**

Add:

```typescript
export interface ApiQualificationCondition {
  readonly code: QualificationReasonCode;
  readonly mode: QualificationConditionMode;
  readonly status: QualificationConditionStatus;
  readonly observed: Readonly<Record<string, string | number | boolean | null>>;
  readonly thresholds: Readonly<Record<string, string | number | null>>;
  readonly message: string;
}
```

`ApiQualificationRuleset` gains `fingerprint: string | null` and
`ApiQualification` gains `conditions`. The projector accepts both fields absent
together for a legacy payload. For a new payload it requires both, validates a
64-character lowercase hexadecimal fingerprint, bounds conditions to the reason
registry length, validates exact own keys, and converts trusted bigint JSON
markers/decimal values to canonical decimal strings without floating-point
coercion.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx tsx --test tests/api-contracts.test.ts tests/api-projection.repository.test.ts
npm run check
```

Expected: old and new payload projections pass.

- [ ] **Step 5: Commit API additions**

```bash
git add src/api/contracts.ts src/storage/api-projection.repository.ts tests/api-contracts.test.ts tests/api-projection.repository.test.ts
git commit -m "feat: expose calibration evidence in API V1 (#35)"
```

## Task 7: Document calibration and lock safety boundaries

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/api/v1.md`
- Modify: `docs/system-overview.html`
- Modify: `tests/bootstrap-safety.test.ts`
- Modify: `tests/config-safety.test.ts`

- [ ] **Step 1: Add failing documentation and source-boundary assertions**

Assert documentation contains the profile path, fingerprint, three modes,
15/25/60 maxima, 3,000-bps nonvalidated round-trip default, report-only
holder/cluster defaults, and the warning that metadata/social signals do not
establish seriousness. Add a source scan proving the loader, evaluator, profile
JSON, and public API import no signing, keypair, transaction-builder, or
submission modules.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test tests/config-safety.test.ts tests/bootstrap-safety.test.ts
npm run docs:check
```

Expected: new documentation assertions fail while the existing HTML structural check remains valid.

- [ ] **Step 3: Update operational and architecture documentation**

Document:

- how the default profile is selected and overridden;
- fail-closed startup and redacted errors;
- effective fingerprint semantics, including the minimum-score override;
- `DISABLED`, `REPORT_ONLY`, and `ENFORCED` behavior;
- exact holder/cluster/round-trip unknown and boundary semantics;
- Raydium `RISK_*` isolation;
- old/new API compatibility;
- observe/paper-only safety and absence of profit/sellability guarantees.

Update the Bootstrap HTML diagnostic document using its existing components and
SVG style; do not introduce a product UI or a remote asset.

- [ ] **Step 4: Verify documentation GREEN**

Run:

```bash
npx tsx --test tests/config-safety.test.ts tests/bootstrap-safety.test.ts
npm run docs:check
```

Expected: all pass with the existing 16-section/7-SVG minimum preserved or increased.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/architecture/pumpfun-v1.md docs/api/v1.md docs/system-overview.html tests/config-safety.test.ts tests/bootstrap-safety.test.ts
git commit -m "docs: explain Pump.fun calibration profiles (#35)"
```

## Task 8: Full verification, review, and PR delivery

**Files:**
- Review all files changed since `main`

- [ ] **Step 1: Run focused static review**

Run:

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short --branch
rg -n "any|Number\(|parseFloat|private.?key|keypair|sendTransaction|signTransaction" src/qualification src/domain/qualification.ts config/qualification scripts/copy-qualification-profiles.ts
```

Inspect every match. Financial `bigint` values must not pass through `Number`,
and no signing/submission capability may enter the new path.

- [ ] **Step 2: Run complete acceptance validation**

Run:

```bash
npm run build
npm run check
npm run lint
npm run docs:check
TEST_DATABASE_URL='postgresql://haythem.mabrouk@127.0.0.1:5432/postgres' npm test
```

Expected: build packages 11 migrations and one profile; check/lint/docs pass;
all tests pass with zero failures and zero skips.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feature/configurable-calibration-35
gh pr create --base main --head feature/configurable-calibration-35 --title "Add versioned Pump.fun qualification calibration" --body $'## Summary\n- load and fingerprint one strict Pump.fun V1 calibration profile\n- keep score separate from configurable enforced/report-only conditions\n- expose backward-compatible calibration evidence through API V1\n\n## Validation\n- npm run build\n- npm run check\n- npm run lint\n- npm run docs:check\n- PostgreSQL-backed npm test with zero skips\n\nNo signing, submission, private key, or live execution path is added.\n\nCloses #35'
```

The PR body must include the profile authority, dry-run defaults, API
compatibility, test totals, safety boundary, and `Closes #35`.

- [ ] **Step 4: Run at most three GitHub review/fix cycles**

Request review with:

```bash
CALIBRATION_PR_NUMBER=$(gh pr view --json number --jq .number)
gh pr comment "$CALIBRATION_PR_NUMBER" --body '@codex please review this PR and post review threads/comments. Focus on strict profile validation, fingerprint determinism, integer threshold boundaries, blocker/score separation, API backward compatibility, startup redaction, build packaging, safety imports, and missing tests. This is review cycle 1 of at most 3.'
```

For each actionable thread: reproduce with a failing test, implement the minimal
fix, run focused then complete validation, reply inline with the commit and
evidence, resolve the thread, push, and request the next review. Do not request
more than three actual reviews.

- [ ] **Step 5: Merge only when clean**

Before merging, verify the HEAD, all review threads, merge state, and complete
test evidence. Merge without bypassing protection, update local `main`, remove
only this worktree and its temporary resources, then mark PR 4 complete and
start PR 5 design.
