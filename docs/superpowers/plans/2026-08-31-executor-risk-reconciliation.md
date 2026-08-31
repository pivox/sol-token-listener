# Executor Risk and Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Do not exceed three GitHub review
> cycles.

**Goal:** Deliver #51-E as an inert, non-signing foundation for wallet risk,
transactional BUY admission, exposure reservation, provider quota, fault
classification and reconciliation evidence.

**Architecture:** Four pure strict domains calculate risk, quota,
reconciliation and retry decisions. PostgreSQL migration 034 stores immutable
snapshots, ledgers, reports and fenced reservations; one repository owns every
multi-row transaction. Thin services compose normalized snapshots with the
repository but are not wired into `src/executor/main.ts`.

**Tech Stack:** TypeScript strict ESM, Node.js 22, PostgreSQL 16, `node:test`,
`pg`, Pino-compatible fixed errors, SHA-256 and `bigint` financial arithmetic.

**Normative design:**
`docs/superpowers/specs/2026-08-31-executor-risk-reconciliation-design.md`
version 1.0.5 and parent specification version 1.6.4.

---

## File map

New focused production files:

- `migrations/034_execution_risk_reconciliation.sql` — all durable #51-E
  tables, constraints, indexes and replay-safe migration statements.
- `src/domain/execution-risk-policy.ts` — exact policy, wallet snapshot and
  deterministic sizing/exposure decision.
- `src/domain/execution-provider-quota.ts` — provider usage/counter DTOs and
  pessimistic protected-budget state.
- `src/domain/execution-reconciliation.ts` — normalized immutable evidence and
  MATCHED/NO_EFFECT/MISMATCH/UNKNOWN proof rules.
- `src/domain/execution-fault-policy.ts` — closed fault matrix and retry
  decision without executing a retry.
- `src/ports/execution-risk-repository.ts` — snapshot, admission, reservation,
  quota, fault and reconciliation transaction contracts.
- `src/ports/execution-reconciliation-gateway.ts` — read-only normalized chain
  evidence port without a transport or submission capability.
- `src/storage/execution-risk.repository.ts` — PostgreSQL implementation and
  all fencing/idempotence checks.
- `src/executor-risk/admission-service.ts` — validates gateway-independent
  snapshots and delegates one atomic admission.
- `src/executor-risk/reconciliation-service.ts` — evaluates normalized
  read-only evidence then commits it atomically.

Existing files modified:

- `src/storage/database.ts` — purge terminal #51-E cohorts child-first.
- `tests/helpers/execution-boundary.ts` — include #51-E files in the closed
  non-signing graph scan.
- `tests/executor-architecture.test.ts` — prove #51-E is not wired into main
  and cannot acquire signing/submission capabilities.
- `README.md` — document that #51-E is an inert foundation and #51-F/#51-G
  remain mandatory.

---

### Task 1: Exact risk policy and bigint sizing

**Files:**

- Create: `src/domain/execution-risk-policy.ts`
- Create: `tests/execution-risk-policy.test.ts`

- [x] **Step 1: Write failing contract and boundary tests**

Define tests that import the wished-for API and prove frozen exact values,
position sizing, total exposure, drawdown, WSOL policy and hostile input
rejection:

```ts
const policy = createExecutionRiskPolicy({
  quoteMintAllowlist: [WSOL_MINT],
  initialCapitalLamports: 1_000_000n,
  maximumCapitalLamports: 1_000_000n,
  positionSizeBps: 1_000n,
  maximumOpenPositions: 2,
  maximumTotalExposureBps: 2_000n,
  drawdownPauseBps: 2_500n,
  feeReserveLamports: 100_000n,
  walletSnapshotMaxAgeMs: 60_000,
  providerUsageMaxAgeMs: 300_000,
  providerEntryCostUnits: 8n,
  providerExitCostUnitsPerPosition: 4n,
  providerConfirmationCostUnitsPerPosition: 2n,
  providerReconciliationCostUnitsPerPosition: 3n,
  providerSafetyMarginUnits: 5n,
  maximumConsecutiveTechnicalFailures: 2,
});
const decision = evaluateBuyRisk({
  policy,
  quoteMint: WSOL_MINT,
  requestedQuoteAmountRaw: 90_000n,
  realizedNetPnlLamports: 0n,
  reservedExposureLamports: 0n,
  openPositions: [],
  consecutiveTechnicalFailures: 0,
});
assert.equal(decision.kind, 'ADMISSIBLE');
assert.equal(decision.positionLimitLamports, 90_000n);
```

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
node --import tsx --test tests/execution-risk-policy.test.ts
```

Expected: FAIL because `src/domain/execution-risk-policy.ts` does not exist.

- [x] **Step 3: Implement the minimal strict domain**

Export exact frozen types and functions:

```ts
export type ExecutionBuyRiskReason =
  | 'CAPITAL_LIMIT_EXCEEDED'
  | 'EXPOSURE_LIMIT_EXCEEDED'
  | 'DRAWDOWN_LIMIT_EXCEEDED'
  | 'QUOTE_MINT_NOT_ALLOWED'
  | 'RECONCILIATION_REQUIRED';

export function createExecutionRiskPolicy(input: unknown): ExecutionRiskPolicyV1;
export function evaluateBuyRisk(input: unknown): ExecutionBuyRiskDecisionV1;
```

Use multiplication before division with `bigint`, positive/zero-safe clamping,
exact-own-key validation, proxy/accessor rejection and SHA-256 canonical
fingerprinting. Never accept a JavaScript `number` for a financial value.

- [x] **Step 4: Run focused tests and refactor only after GREEN**

Run the Task 1 test command. Expected: all Task 1 tests PASS, 0 failures.

- [x] **Step 5: Commit Task 1**

```bash
git add src/domain/execution-risk-policy.ts tests/execution-risk-policy.test.ts
git commit -m "feat: add bigint executor risk policy (#51)"
```

### Task 2: Provider quota state and durable operation identities

**Files:**

- Create: `src/domain/execution-provider-quota.ts`
- Create: `tests/execution-provider-quota.test.ts`

- [x] **Step 1: Write failing quota tests**

Cover NORMAL, ENTRY_BLOCKED, EXIT_ONLY and UNKNOWN, exact TTL boundaries,
non-monotone measurements, billing-period changes, protected exit budgets and
three 429 events in 30 seconds:

```ts
const result = evaluateProviderQuota({
  policy,
  snapshot: createProviderUsageSnapshot({
    providerId: 'primary', planId: 'plan-v1', billingPeriodId: '2026-08',
    billingPeriodStartedAtMs: 0, billingPeriodEndsAtMs: 2_678_400_000,
    limitUnits: 1_000n, usedUnits: 800n, measuredAtMs: 1_000,
    expiresAtMs: 301_000, provenance: 'AUTHORITATIVE_PROBE',
  }),
  localUsedSinceMeasurement: 20n,
  openPositions: 2,
  consecutiveRateLimits: [],
  nowMs: 2_000,
});
assert.equal(result.state, 'NORMAL');
assert.equal(result.protectedUnits, 23n);
```

- [x] **Step 2: Verify RED**

Run:

```bash
node --import tsx --test tests/execution-provider-quota.test.ts
```

Expected: module-not-found failure for the new domain.

- [x] **Step 3: Implement quota DTOs and evaluator**

Export:

```ts
export type ExecutionProviderQuotaState =
  | 'NORMAL' | 'ENTRY_BLOCKED' | 'EXIT_ONLY' | 'UNKNOWN';
export type ExecutionProviderUsageCategory =
  | 'ENTRY' | 'EXIT' | 'CONFIRMATION' | 'RECONCILIATION' | 'TELEMETRY';
export function createProviderUsageSnapshot(input: unknown): ProviderUsageSnapshotV1;
export function createProviderUsageOperationId(input: unknown): string;
export function evaluateProviderQuota(input: unknown): ProviderQuotaDecisionV1;
```

Use `remaining = limit - measured - local` and the exact protected formula
from spec 1.0.0. Clamp no negative arithmetic silently: a negative remainder
is valid evidence for EXIT_ONLY, while malformed stored counts are invalid.

- [x] **Step 4: Verify GREEN and Task 1 regression**

Run:

```bash
node --import tsx --test tests/execution-provider-quota.test.ts tests/execution-risk-policy.test.ts
```

Expected: all tests PASS.

- [x] **Step 5: Commit Task 2**

```bash
git add src/domain/execution-provider-quota.ts tests/execution-provider-quota.test.ts
git commit -m "feat: model durable provider quota gates (#51)"
```

### Task 3: Reconciliation proofs and fault matrix

**Files:**

- Create: `src/domain/execution-reconciliation.ts`
- Create: `src/domain/execution-fault-policy.ts`
- Create: `tests/execution-reconciliation.test.ts`
- Create: `tests/execution-fault-policy.test.ts`

- [x] **Step 1: Write failing reconciliation tests**

Pin the full result matrix. In particular, NO_EFFECT must require all three
proofs and MATCHED must use actual signed deltas:

```ts
assert.equal(evaluateExecutionReconciliation({
  expected,
  observed: {
    signatureHistory: 'ABSENT',
    finalizedBlockHeight: expected.lastValidBlockHeight + 1n,
    transaction: null,
    walletLamportDelta: 0n,
    baseDeltaRaw: 0n,
    quoteDeltaRaw: 0n,
    finalizedAtMs: 2_000,
  },
}).result, 'NO_EFFECT');
```

Also prove absence without final block height, a current null signature, a
reorg, nonzero delta, fingerprint mismatch and residual token balance never
produce NO_EFFECT.

- [x] **Step 2: Write failing fault-policy tests**

Test every matrix row and the exact two-failure gate:

```ts
assert.equal(classifyExecutionFault({
  stage: 'SUBMISSION', side: 'BUY', timing: 'AFTER_SIGNATURE',
  classification: 'AMBIGUOUS', consecutiveTechnicalFailures: 1,
}), 'RECONCILE_ONLY');
```

- [x] **Step 3: Verify RED for both modules**

Run:

```bash
node --import tsx --test tests/execution-reconciliation.test.ts tests/execution-fault-policy.test.ts
```

Expected: both new modules are missing.

- [x] **Step 4: Implement immutable proofs and closed classification**

Export exact unions:

```ts
export type ExecutionReconciliationResult =
  | 'MATCHED' | 'NO_EFFECT' | 'MISMATCH' | 'UNKNOWN';
export type ExecutionRetryDecision =
  | 'DO_NOT_RETRY'
  | 'RETRY_PRE_SIGNATURE'
  | 'RECONCILE_ONLY'
  | 'RETRY_EXACT_BYTES';
```

Create deterministic evidence IDs/fingerprints, signed bigint bounds, fixed
typed errors and strict reason-code/result relationships.

- [x] **Step 5: Verify GREEN and commit**

Run the two Task 3 tests, then:

```bash
git add src/domain/execution-reconciliation.ts src/domain/execution-fault-policy.ts tests/execution-reconciliation.test.ts tests/execution-fault-policy.test.ts
git commit -m "feat: define execution reconciliation and fault proofs (#51)"
```

### Task 4: Replay-safe PostgreSQL schema

**Files:**

- Create: `migrations/034_execution_risk_reconciliation.sql`
- Create: `tests/execution-risk-migration.test.ts`
- Modify: `tests/api-event-stream-migration.test.ts`

- [x] **Step 1: Write failing migration contract tests**

Assert every table, FK, closed enum, canonical timestamp, NUMERIC financial
column, unique replay key, partial active index and absence of float/secret
columns. Extend the ordered migration manifest to end at 034.

- [x] **Step 2: Verify RED**

Run:

```bash
node --import tsx --test tests/execution-risk-migration.test.ts tests/api-event-stream-migration.test.ts
```

Expected: migration 034 missing and manifest expectation fails.

- [x] **Step 3: Implement migration 034**

Create the eleven tables named by spec 1.0.5, including
`execution_wallet_risk_state`. Use `CREATE TABLE IF NOT EXISTS`, named
constraints and `CREATE INDEX IF NOT EXISTS`. Store financial integers as
unscaled `NUMERIC` with explicit integer/u64 or integer/i128 checks. Every terminal
`purge_after` must equal its reconciliation/end timestamp plus four hours.

- [x] **Step 4: Verify base-empty and replay on real PostgreSQL**

Run:

```bash
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot node --import tsx --test tests/execution-risk-migration.test.ts tests/api-event-stream-migration.test.ts
```

Expected: migration applies twice in an isolated schema, all tests PASS.

- [x] **Step 5: Build migration packaging and commit**

Run `npm run build:backend`; expect `Packaged 34 PostgreSQL migrations.` Then:

```bash
git add migrations/034_execution_risk_reconciliation.sql tests/execution-risk-migration.test.ts tests/api-event-stream-migration.test.ts
git commit -m "feat: persist executor risk and reconciliation state (#51)"
```

### Task 5: Repository ports and immutable snapshot/counter writes

**Files:**

- Create: `src/ports/execution-risk-repository.ts`
- Create: `src/storage/execution-risk.repository.ts`
- Create: `tests/execution-risk.repository.test.ts`

- [x] **Step 1: Write failing repository tests**

Cover wallet generation creation/replay/conflict, append-only wallet snapshot,
provider measurement monotonicity, idempotent operation counters, 429 window,
strict row decoding and fixed redacted failures.

- [x] **Step 2: Verify RED**

Run:

```bash
node --import tsx --test tests/execution-risk.repository.test.ts
```

Expected: missing port/repository modules.

- [x] **Step 3: Define the exact repository interface**

The port must expose only bounded operations:

```ts
export interface ExecutionRiskRepository {
  registerWalletGeneration(input: WalletGenerationDraftV1): Promise<WalletGenerationV1>;
  appendWalletSnapshot(input: WalletSnapshotDraftV1): Promise<WalletSnapshotV1>;
  appendProviderUsage(input: ProviderUsageSnapshotV1): Promise<ProviderUsageSnapshotV1>;
  recordProviderOperation(input: ProviderUsageOperationV1): Promise<'RECORDED' | 'REPLAYED'>;
  recordRateLimit(input: ProviderRateLimitEventV1): Promise<'RECORDED' | 'REPLAYED'>;
  admitBuy(input: ExecutionBuyAdmissionInputV1): Promise<ExecutionBuyAdmissionResultV1>;
  reconcile(input: ExecutionReconciliationCommitV1): Promise<ExecutionReconciliationCommitResultV1>;
}
```

- [x] **Step 4: Implement strict PostgreSQL writes**

Use one private transaction helper with eviction on rollback/release failure,
fixed public error codes, canonical text NUMERIC decoding, exact row keys and
no exposure of SQL or credentials.

- [x] **Step 5: Verify unit and real-DB repository behavior, then commit**

Run the repository test with `TEST_DATABASE_URL`; expect all tests PASS. Then:

```bash
git add src/ports/execution-risk-repository.ts src/storage/execution-risk.repository.ts tests/execution-risk.repository.test.ts
git commit -m "feat: store executor risk snapshots and counters (#51)"
```

### Task 6: Transactional BUY admission and exposure reservations

**Files:**

- Modify: `src/storage/execution-risk.repository.ts`
- Create: `src/executor-risk/admission-service.ts`
- Create: `tests/execution-risk-admission.test.ts`
- Modify: `tests/execution-risk.repository.test.ts`

- [x] **Step 1: Write failing concurrent-admission tests**

Open two PostgreSQL pools and race two BUY admissions whose combined exposure
exceeds the limit. Assert exactly one ADMITTED reservation, one REJECTED
report, unchanged intent payloads and a monotone wallet risk revision.

- [x] **Step 2: Write failing replay, stale-snapshot and crash tests**

Prove exact replay returns the same report/reservation; changed fingerprints,
generation ABA, stale wallet/provider revision and injected failure before
commit leave no partial reservation.

- [x] **Step 3: Verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot node --import tsx --test tests/execution-risk-admission.test.ts tests/execution-risk.repository.test.ts
```

Expected: `admitBuy` is absent/incomplete.

- [x] **Step 4: Implement the nine-step admission transaction**

Use `pg_advisory_xact_lock`, `FOR UPDATE` on generation/state/intent, one
statement timestamp CTE, exact snapshot fingerprints, pure Task 1/2
evaluation, append-only report and unique reservation. Do no RPC or external
await while the transaction is open.

- [x] **Step 5: Implement the thin admission service**

Validate own fields, BUY side, WSOL, immutable intent and snapshot identities,
then call the repository once. It must never retry a database ambiguity by
itself.

- [x] **Step 6: Verify GREEN and commit**

Run the Task 6 test command. Expected: both concurrent directions pass. Then:

```bash
git add src/storage/execution-risk.repository.ts src/executor-risk/admission-service.ts tests/execution-risk-admission.test.ts tests/execution-risk.repository.test.ts
git commit -m "feat: reserve executor exposure transactionally (#51)"
```

### Task 7: Read-only reconciliation service and atomic commit

**Files:**

- Create: `src/ports/execution-reconciliation-gateway.ts`
- Create: `src/executor-risk/reconciliation-service.ts`
- Modify: `src/storage/execution-risk.repository.ts`
- Create: `tests/execution-reconciliation.service.test.ts`
- Modify: `tests/execution-risk.repository.test.ts`

- [x] **Step 1: Write failing service tests**

Provide a fake closed gateway returning normalized immutable evidence. Assert
the service performs only read methods, produces the Task 3 proof and sends one
atomic commit input to the repository.

- [x] **Step 2: Write failing PostgreSQL reconciliation tests**

Cover MATCHED→CONSUMED, NO_EFFECT→RELEASED, MISMATCH/UNKNOWN→UNKNOWN_HELD,
intent/generation/reservation fencing, exact replay and concurrent conflicting
proofs. NO_EFFECT must transition an unknown intent only with
`RECONCILIATION_PROVED_NO_EFFECT`.

- [x] **Step 3: Verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot node --import tsx --test tests/execution-reconciliation.service.test.ts tests/execution-risk.repository.test.ts
```

- [x] **Step 4: Implement closed gateway and service contracts**

The gateway interface exposes exactly:

```ts
readFinalizedBlockHeight(signal: AbortSignal): Promise<bigint>;
readSignatureHistory(signature: string, signal: AbortSignal): Promise<'PRESENT' | 'ABSENT' | 'UNKNOWN'>;
readNormalizedTransaction(signature: string, signal: AbortSignal): Promise<NormalizedExecutionTransactionV1 | null>;
readFinalizedWalletDeltas(request: WalletDeltaRequestV1, signal: AbortSignal): Promise<FinalizedWalletDeltasV1>;
```

No implementation may add a method whose name starts with `send`, `submit`,
`sign` or return a `Connection`.

- [x] **Step 5: Implement atomic fenced reconciliation**

Lock intent, reservation, generation and risk state; insert exact evidence;
mutate reservation and aggregate; perform only allowed future intent
transitions; write `reconciled_at`/`purge_after` together. Preserve UNKNOWN on
all inconclusive reads.

- [x] **Step 6: Verify GREEN and commit**

Run the Task 7 test command. Then:

```bash
git add src/ports/execution-reconciliation-gateway.ts src/executor-risk/reconciliation-service.ts src/storage/execution-risk.repository.ts tests/execution-reconciliation.service.test.ts tests/execution-risk.repository.test.ts
git commit -m "feat: reconcile executor effects without submission (#51)"
```

### Task 8: Fault ledger and two-failure durable gate

**Files:**

- Modify: `src/ports/execution-risk-repository.ts`
- Modify: `src/storage/execution-risk.repository.ts`
- Create: `tests/execution-fault-ledger.repository.test.ts`

- [x] **Step 1: Write failing ledger tests**

Persist BUILD, SIMULATION, PROVIDER, CONFIRMATION and RECONCILIATION faults by
wallet generation/phase. Prove validation failures do not increment, the
second technical failure blocks BUY, restart preserves the count, and only a
final MATCHED reconciled success resets it.

- [x] **Step 2: Verify RED**

Run the new test with `TEST_DATABASE_URL`; expected: missing ledger methods.

- [x] **Step 3: Implement append-only fault operations**

Add idempotent `recordFault` and fenced `recordReconciledSuccess`. Update the
wallet risk aggregate in the same transaction as the append-only ledger row.
Never reset from time, process startup, quote success or NO_EFFECT.

- [x] **Step 4: Verify GREEN and commit**

```bash
git add src/ports/execution-risk-repository.ts src/storage/execution-risk.repository.ts tests/execution-fault-ledger.repository.test.ts
git commit -m "feat: persist executor technical fault gates (#51)"
```

### Task 9: Four-hour terminal retention

**Files:**

- Modify: `src/storage/database.ts`
- Create: `tests/execution-risk-retention.test.ts`
- Modify: `tests/execution-intent-migration.test.ts`

- [ ] **Step 1: Write failing purge-order and boundary tests**

Build eligible, exact-boundary and one-millisecond-too-young cohorts. Assert
UNKNOWN_HELD, active generations and current provider periods survive. Assert
tombstones are inserted before child-first deletion and collision rolls back
the whole cohort.

- [ ] **Step 2: Verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot node --import tsx --test tests/execution-risk-retention.test.ts tests/execution-intent-migration.test.ts
```

- [ ] **Step 3: Extend the existing purge transaction**

Use the existing PostgreSQL cutoff and bounded cohort patterns. Purge
rate-limit events, evidence, fault rows, reports, terminal reservations and
superseded snapshots in dependency order; retain minimal risk tombstones and
return additive aggregate counters.

- [ ] **Step 4: Verify GREEN and commit**

```bash
git add src/storage/database.ts tests/execution-risk-retention.test.ts tests/execution-intent-migration.test.ts
git commit -m "feat: purge reconciled executor risk payloads (#51)"
```

### Task 10: Architecture boundary, operator docs and full verification

**Files:**

- Modify: `tests/helpers/execution-boundary.ts`
- Modify: `tests/executor-architecture.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-31-executor-risk-reconciliation.md`

- [ ] **Step 1: Write failing architecture assertions**

Add source/dist graph checks proving #51-E modules contain no keypair, signer,
secret loader, dynamic execution, send/submit method or import path into
listener/API/paper/Raydium. Assert `src/executor/main.ts`, package scripts and
`.env.example` have no #51-E runtime mode or live setting.

- [ ] **Step 2: Verify RED, then extend the closed graph guard**

Run `npm run build:backend` and the architecture test. It must first fail for
the new unlisted graph; minimally extend the allowlist, rebuild and require
GREEN for source and `dist`.

- [ ] **Step 3: Document the inert boundary**

README must state: #51-E provides database/domain foundations only; no current
command runs admission or reconciliation; #49 remains NON_EXECUTED and
NON_VALIDATED; #51-F and #51-G remain mandatory before any canary.

- [ ] **Step 4: Run focused validation**

```bash
npm run build:backend
npm run check:backend
npm run lint:backend
npm run docs:check
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot node --import tsx --test tests/execution-risk-policy.test.ts tests/execution-provider-quota.test.ts tests/execution-reconciliation.test.ts tests/execution-fault-policy.test.ts tests/execution-risk-migration.test.ts tests/execution-risk.repository.test.ts tests/execution-risk-admission.test.ts tests/execution-reconciliation.service.test.ts tests/execution-fault-ledger.repository.test.ts tests/execution-risk-retention.test.ts tests/executor-architecture.test.ts
```

Expected: every command exits 0, no skipped PostgreSQL #51-E test.

- [ ] **Step 5: Run full repository validation**

```bash
npm run build
npm run check
npm run lint
TEST_DATABASE_URL=postgresql://haythem.mabrouk@127.0.0.1:5432/solanabot npm test
npm run frontend:e2e
```

Expected: all backend/frontend tests and Chromium E2E pass.

- [ ] **Step 6: Perform bounded security scans**

Scan source, `dist`, diff and history range for private-key material,
send/submit capabilities, URLs/credentials in fixtures and JavaScript floats
in financial code. Inspect every match; expected: zero unexplained match.

- [ ] **Step 7: Commit documentation and final guard changes**

```bash
git add tests/helpers/execution-boundary.ts tests/executor-architecture.test.ts README.md docs/superpowers/plans/2026-08-31-executor-risk-reconciliation.md
git commit -m "docs: publish executor risk foundation contract (#51)"
```

- [ ] **Step 8: Push, open PR and run exactly three review cycles**

Push `feat/issue-51e-risk-gates`, open one PR linked to #51, request Codex
review, address/resolved threads for at most three cycles, and never request a
fourth cycle.

- [ ] **Step 9: Merge only after final gates**

Require clean worktree, green CI (`quality`, `frontend-e2e`,
`deployment-contract`), no unresolved thread, mergeable state and exact remote
head. Merge normally, fetch `origin/main`, verify ancestry and update #51 with
the explicit statement that no live execution is enabled.
