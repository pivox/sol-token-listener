# Provider-affine Solana finality implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver issue #61 so every active finality decision uses one pinned
Solana provider, persists consecutive-miss provenance, and requires a
conditional finalized-block proof before orphaning.

**Architecture:** A neutral provider-pass port separates the application from
one pinned `Connection`. Migration 027 adds the last missing provider to the
durable inbox, repository CAS covers provider, count and a monotone evidence
version, and orphan revisions carry an exact transactional proof precondition.
Production uses a fixed primary pass until #63 supplies the promoted provider.

**Tech Stack:** TypeScript strict ESM, `@solana/web3.js` 1.98.4, PostgreSQL,
bigint, Node test runner, migration 027.

**Plan version:** 1.0.2. Revision 1.0.2 bounds the monotone evidence generation
to PostgreSQL `BIGINT` and requires exact +1 application-boundary validation.

---

### Task 1: Provider-aware domain contracts and replayable migration

**Files:**

- Modify: `src/domain/rpc-provider.ts`
- Modify: `src/domain/transaction-ingestion.ts`
- Create: `migrations/027_listener_provider_affine_finality.sql`
- Create: `tests/provider-affine-finality-migration.test.ts`
- Modify: `tests/transaction-ingestion-contracts.test.ts`

- [ ] **Step 1: Write failing domain and migration tests**

Add canonical positional provider constants and test the new frozen contracts:

```ts
export const RPC_PROVIDER_IDS = Object.freeze([
  'primary', 'fallback-1', 'fallback-2', 'fallback-3',
] as const);

export function isRpcProviderId(value: unknown): value is RpcProviderId {
  return typeof value === 'string'
    && (RPC_PROVIDER_IDS as readonly string[]).includes(value);
}
```

Require candidates with `lastMissingFinalityProviderId`, observations with
`providerId` and the exact expected provider, and a discriminated revision:

```ts
const candidate: FinalityCandidate = Object.freeze({
  signature: 'signature',
  slot: 42n,
  confirmationStatus: 'confirmed',
  missingFinalityPolls: 2,
  lastMissingFinalityProviderId: 'primary',
  finalityEvidenceVersion: 7n,
  processedAtMs: 1_720_000_000_000,
});

const orphaned: FinalityRevision = Object.freeze({
  signature: 'signature',
  confirmationStatus: 'orphaned',
  expectedConfirmationStatus: 'confirmed',
  expectedMissingFinalityPolls: 3,
  expectedLastMissingFinalityProviderId: 'primary',
  expectedFinalityEvidenceVersion: 8n,
  observedAtMs: 1_720_000_001_000,
});
```

Test both invalid correlations: count zero with a provider and positive count
without one. Test invalid provider IDs, mutable/accessor-backed inputs,
negative/unsafe counts, evidence versions outside
`0n..9_223_372_036_854_775_807n`, and extra proof fields on the finalized
branch.

The migration test must create the schema through 026, insert one legacy row
with `missing_finality_polls = 3`, apply 027, and assert `0/NULL`. It must then
accept all four positional IDs only with a positive count, reject impossible
count/provider combinations, apply 027 again directly, and verify a full
`migrateDatabase` replay returns no newly applied migration.

- [ ] **Step 2: Run focused tests and observe missing-field/migration failures**

```bash
node --import tsx --test \
  tests/transaction-ingestion-contracts.test.ts \
  tests/provider-affine-finality-migration.test.ts
```

Expected: FAIL because migration 027 and the new contract fields do not exist.

- [ ] **Step 3: Implement the domain union and migration**

Use these domain shapes:

```ts
export interface FinalizedFinalityRevision {
  readonly signature: string;
  readonly confirmationStatus: 'finalized';
  readonly observedAtMs: number;
}

export interface OrphanedFinalityRevision {
  readonly signature: string;
  readonly confirmationStatus: 'orphaned';
  readonly expectedConfirmationStatus: 'processed' | 'confirmed';
  readonly expectedMissingFinalityPolls: number;
  readonly expectedLastMissingFinalityProviderId: RpcProviderId;
  readonly expectedFinalityEvidenceVersion: bigint;
  readonly observedAtMs: number;
}

export type FinalityRevision = FinalizedFinalityRevision | OrphanedFinalityRevision;
```

Migration 027 must be replay-safe:

```sql
ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS last_missing_finality_provider_id TEXT,
  ADD COLUMN IF NOT EXISTS finality_evidence_version BIGINT NOT NULL DEFAULT 0;

UPDATE chain_transaction_inbox
SET missing_finality_polls = 0,
    last_missing_finality_provider_id = NULL
WHERE missing_finality_polls > 0
  AND last_missing_finality_provider_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chain_transaction_inbox_missing_finality_provider_check'
      AND conrelid = 'chain_transaction_inbox'::regclass
  ) THEN
    ALTER TABLE chain_transaction_inbox
      ADD CONSTRAINT chain_transaction_inbox_missing_finality_provider_check
      CHECK (
        (missing_finality_polls = 0
          AND last_missing_finality_provider_id IS NULL)
        OR
        (missing_finality_polls > 0
          AND last_missing_finality_provider_id IN (
            'primary', 'fallback-1', 'fallback-2', 'fallback-3'
          ))
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chain_transaction_inbox_finality_evidence_version_check'
      AND conrelid = 'chain_transaction_inbox'::regclass
  ) THEN
    ALTER TABLE chain_transaction_inbox
      ADD CONSTRAINT chain_transaction_inbox_finality_evidence_version_check
      CHECK (finality_evidence_version >= 0);
  END IF;
END;
$$;
```

Do not add an index or expose the column through an API projection.

- [ ] **Step 4: Run focused tests until green**

Run the Step 2 command and `npm run check:backend`.

- [ ] **Step 5: Commit the slice**

```bash
git add src/domain/rpc-provider.ts src/domain/transaction-ingestion.ts \
  migrations/027_listener_provider_affine_finality.sql \
  tests/provider-affine-finality-migration.test.ts \
  tests/transaction-ingestion-contracts.test.ts
git commit -m "feat: persist finality provider provenance (#61)"
```

### Task 2: Provider-aware inbox CAS and conditional orphan revision

**Files:**

- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: `tests/transaction-ingestion-recovery.test.ts`

- [ ] **Step 1: Write failing PostgreSQL repository tests**

Cover the exact transition matrix:

```text
0/null + primary miss       -> 1/primary
1/primary + primary miss    -> 2/primary
2/primary + fallback-1 miss -> 1/fallback-1
N/provider + present status -> 0/null
```

Add two concurrent observations with the same expected count but different
expected providers and require exactly one success. Test stale count, stale
provider, stale evidence version, stale confirmation status, reset after a new
confirmed notification, and all terminal revision paths.

Add a true ABA test: retain an orphan proof at `3/primary/version N`, switch to
fallback, then return to `3/primary/version N+k`; the retained proof must fail
despite identical visible provider/count/status values.

For orphaning, require an exact revision to succeed and each of these variants
to fail with `TransactionInboxConflictError('finality')`:

```ts
Object.freeze({ ...proof, expectedMissingFinalityPolls: proof.expectedMissingFinalityPolls - 1 });
Object.freeze({ ...proof, expectedLastMissingFinalityProviderId: 'fallback-1' });
Object.freeze({ ...proof, expectedConfirmationStatus: 'processed' });
Object.freeze({ ...proof, expectedFinalityEvidenceVersion: proof.expectedFinalityEvidenceVersion - 1n });
```

Simulate a response lost after commit by submitting the same orphan revision
again while the row is `PENDING/orphaned`; require an idempotent no-op. Complete
the worker replay, submit it once more, and require another no-op.

- [ ] **Step 2: Run the repository and recovery tests and observe failures**

```bash
node --import tsx --test \
  tests/transaction-inbox.repository.test.ts \
  tests/transaction-ingestion-recovery.test.ts
```

Expected with PostgreSQL: FAIL because repository queries do not read or write
the new provider and orphan revisions have no proof guard. Without
`TEST_DATABASE_URL`, live cases may report explicit skips during this red step.

- [ ] **Step 3: Implement exact provider/count CAS**

Extend every finality candidate `SELECT` and `RETURNING` list with
`last_missing_finality_provider_id` and `finality_evidence_version`. Under the
existing `FOR UPDATE`, validate the current tuple and compute:

```ts
const nextMissing = value.confirmationStatus !== null
  ? 0
  : currentProvider === value.providerId
    ? missing + 1
    : 1;
const nextProvider = value.confirmationStatus === null ? value.providerId : null;
```

The update guard must include:

```sql
AND missing_finality_polls = $expected_count
AND last_missing_finality_provider_id IS NOT DISTINCT FROM $expected_provider
AND finality_evidence_version = $expected_version
```

Every existing SQL path that resets `missing_finality_polls` must set
`last_missing_finality_provider_id = NULL`. Every poll, existing-row durable
notification and terminal revision enqueue must increment
`finality_evidence_version` in the same statement. An existing-row notification
must clear the missing sequence even when its target status is unchanged, so
an old proof cannot survive fresh existence evidence.

- [ ] **Step 4: Implement conditional orphan enqueue**

Keep finalized handling unchanged. For a real transition to `orphaned`, after
the idempotent same-target returns and while the row is locked, compare the
current confirmation, provider and counter with the revision proof. Add the
same fields to the final `UPDATE` predicate. A stale proof must update zero
rows and become the existing redacted finality conflict.

The successful update must clear both missing fields and advance the version:

```sql
missing_finality_polls = 0,
last_missing_finality_provider_id = NULL,
finality_evidence_version = finality_evidence_version + 1
```

- [ ] **Step 5: Run focused tests with PostgreSQL until green**

Run the Step 2 command with `TEST_DATABASE_URL` set to the isolated test
database, then run `npm run check:backend`.

- [ ] **Step 6: Commit the slice**

```bash
git add src/storage/transaction-inbox.repository.ts \
  tests/transaction-inbox.repository.test.ts \
  tests/transaction-ingestion-recovery.test.ts
git commit -m "feat: guard orphan revisions with durable proof (#61)"
```

### Task 3: Provider-pinned finality pass adapter

**Files:**

- Create: `src/ports/finality-provider-pass.ts`
- Create: `src/solana/rpc/provider-pinned-finality-source.ts`
- Create: `tests/provider-pinned-finality-source.test.ts`
- Modify: `src/solana/rpc/rpc-client.ts`
- Modify: `tests/rpc-client.test.ts`

- [ ] **Step 1: Write failing adapter and RPC regression tests**

Specify this neutral port:

```ts
export interface FinalityProviderPass {
  readonly providerId: RpcProviderId;
  getHistoryStatuses(signatures: readonly string[]): Promise<unknown>;
  getFinalizedSlot(): Promise<unknown>;
  getFinalizedBlockSignatures(slot: bigint): Promise<unknown>;
}

export interface FinalityProviderPassSource {
  openPass(): unknown;
}
```

Inject a fake RPC factory into the adapter. Assert one catalog resolution and
one RPC construction. Invoke history, root and two block reads and prove all
four calls hit the same fake instance. Verify exact calls equivalent to:

```ts
rpc.getSignatureStatuses(signatures, { searchTransactionHistory: true });
rpc.getSlot('finalized');
rpc.getBlockSignatures(Number(slot), 'finalized');
```

Test 256 signatures accepted, 257 rejected, invalid slots, block arrays above
10,000 entries, sparse/duplicate/non-canonical signatures, hostile accessors,
RPC rejection and remote messages containing secret URLs. Fixed public errors
must contain no cause or remote data, and no fallback factory may be called.

Add an HTTP-level regression test proving `SolanaRpcClient.getBlockSignatures`
accepts the official `getBlock` response with top-level `signatures` and sends
`transactionDetails: 'signatures'`, `rewards: false`.

- [ ] **Step 2: Run focused tests and observe missing adapter/parser failure**

```bash
node --import tsx --test \
  tests/provider-pinned-finality-source.test.ts \
  tests/rpc-client.test.ts
```

- [ ] **Step 3: Implement the pinned adapter**

Expose a constructor boundary like:

```ts
export function createProviderPinnedFinalityPass(
  catalog: RpcProviderCatalog,
  providerId: RpcProviderId,
  dependencies?: ProviderPinnedFinalityDependencies,
): FinalityProviderPass;
```

Resolve the catalog once, construct a direct `Connection` for the exact HTTP
URL with `disableRetryOnRateLimit: true`, and never use
`createRpcHttpFailoverFetch`. Snapshot statuses as frozen `{ slot: bigint,
confirmationStatus } | null` values. Snapshot at most 10,000 unique canonical
64-byte base58 block signatures. Use fixed errors:

```ts
export type ProviderPinnedFinalityErrorReason =
  | 'CONFIG_INVALID'
  | 'HISTORY_UNAVAILABLE'
  | 'ROOT_UNAVAILABLE'
  | 'BLOCK_UNAVAILABLE';
```

- [ ] **Step 4: Fix the shared block-signature parser path**

Replace generic `Connection.getBlock(... transactionDetails: 'signatures')`
usage in `SolanaRpcClient.getBlockSignatures` with:

```ts
const block = await this.http.getBlockSignatures(
  numericSlot,
  rpcFinality(confirmationStatus),
);
return Object.freeze([...block.signatures]);
```

Let unavailable blocks reject into the locator's existing retryable RPC path;
do not translate them into signature absence.

- [ ] **Step 5: Run focused tests and type checking until green**

Run the Step 2 command and `npm run check:backend`.

- [ ] **Step 6: Commit the slice**

```bash
git add src/ports/finality-provider-pass.ts \
  src/solana/rpc/provider-pinned-finality-source.ts \
  src/solana/rpc/rpc-client.ts \
  tests/provider-pinned-finality-source.test.ts tests/rpc-client.test.ts
git commit -m "feat: add pinned Solana finality pass (#61)"
```

### Task 4: Same-provider canonical block proof algorithm

**Files:**

- Modify: `src/application/finality-reconciler.ts`
- Modify: `tests/finality-reconciler.test.ts`

- [ ] **Step 1: Rewrite the reconciler tests against pass capture**

Require one `openPass()` call per non-empty run and no call for an empty page.
Add tests for:

- same-provider missing sequence reaches the threshold and reads one block;
- primary count two followed by fallback miss returns count one and no block;
- a present status resets count/provider;
- root equal to candidate slot reads no block;
- signature absent enqueues an orphan revision with exact proof fields;
- signature present raises `finality-contradiction` and enqueues no orphan for
  that slot;
- block null, rejection or malformed data raises fixed `block`;
- candidates sharing a slot cause one block read;
- seventeen unique eligible slots read only the first sixteen and defer one;
- a repository race changing provider/count/version makes the revision fail at
  stage `revision`;
- forged poll results with an unchanged, regressive or skipped evidence
  version fail at stage `poll` before any block proof;
- 256 is the maximum constructor limit.

The memory repository must implement provider-aware transitions exactly like
PostgreSQL and reject stale orphan proof fields before recording a revision.

- [ ] **Step 2: Run the reconciler test and observe contract failures**

```bash
node --import tsx --test tests/finality-reconciler.test.ts
```

- [ ] **Step 3: Capture and validate one pass**

Change `MAX_FINALITY_RECONCILE_LIMIT` to `256`. Accept a
`FinalityProviderPassSource`, call `openPass` once after a non-empty page, and
snapshot `providerId` plus all three methods through own/prototype data
descriptors without invoking accessors.

Add fixed stages:

```ts
export type FinalityReconcilerErrorStage =
  | 'list' | 'pass' | 'history' | 'root' | 'block'
  | 'poll' | 'revision' | 'clock' | 'finality-contradiction';
```

Keep one history batch and one finalized root read on the captured pass.

Extend `assertPollTransition` to require:

```ts
if (before.finalityEvidenceVersion
  === 9_223_372_036_854_775_807n
  || after.finalityEvidenceVersion !== before.finalityEvidenceVersion + 1n) {
  throw new TypeError('Finality evidence version transition is invalid.');
}
```

Test unchanged, regressive, skipped and out-of-range repository versions. None
may reach `getFinalizedBlockSignatures` or `enqueueRevision`.

- [ ] **Step 4: Implement provider-aware polls and block proofs**

Pass these exact poll fields:

```ts
Object.freeze({
  signature: candidate.signature,
  confirmationStatus: status?.confirmationStatus ?? null,
  providerId: pass.providerId,
  expectedMissingFinalityPolls: candidate.missingFinalityPolls,
  expectedLastMissingFinalityProviderId: candidate.lastMissingFinalityProviderId,
  expectedFinalityEvidenceVersion: candidate.finalityEvidenceVersion,
  observedAtMs,
});
```

After polls, group threshold-eligible missing candidates by slot in candidate
order. For the first sixteen unique slots, read and snapshot one complete
block signature list. If any eligible signature for the slot is present,
throw `finality-contradiction` before enqueueing any orphan from that slot.
Otherwise enqueue:

```ts
Object.freeze({
  signature: candidate.signature,
  confirmationStatus: 'orphaned',
  expectedConfirmationStatus: polled.confirmationStatus,
  expectedMissingFinalityPolls: polled.missingFinalityPolls,
  expectedLastMissingFinalityProviderId: pass.providerId,
  expectedFinalityEvidenceVersion: polled.finalityEvidenceVersion,
  observedAtMs,
});
```

Read blocks sequentially. Treat null, rejection, sparse/duplicate/oversized
arrays and unsafe values as stage `block`, never as absence.

- [ ] **Step 5: Run focused tests and static checks until green**

```bash
node --import tsx --test tests/finality-reconciler.test.ts
npm run check:backend
npm run lint:backend
```

- [ ] **Step 6: Commit the slice**

```bash
git add src/application/finality-reconciler.ts tests/finality-reconciler.test.ts
git commit -m "feat: require canonical block proof for orphaning (#61)"
```

### Task 5: Primary-pinned production wiring and lifecycle regression

**Files:**

- Modify: `src/application/production-listener-factory.ts`
- Modify: `tests/production-listener-factory.test.ts`
- Modify: `tests/transaction-ingestion-recovery.test.ts`

- [ ] **Step 1: Write failing production-boundary tests**

Require the production source to be built from `createRpcProviderCatalog`,
`createProviderPinnedFinalityPass`, and positional ID `primary`. Add a source
scan that rejects passing the general `SolanaRpcClient` directly to
`FinalityReconciler` and rejects importing the HTTP failover transport from the
pinned adapter.

Exercise `RecurringFinalityReconciler` with a block-unavailable first pass:
startup or scheduled run becomes `DEGRADED`, no orphan revision is present,
and a later coherent pass returns it to `RUNNING` using a fresh proof.

Add a crash/restart integration scenario:

```text
primary poll commits at count two -> process stops
fallback pass starts -> first miss persists as count one/fallback
fallback reaches threshold -> fresh finalized block proof -> orphan revision
```

- [ ] **Step 2: Run focused production and recovery tests**

```bash
node --import tsx --test \
  tests/production-listener-factory.test.ts \
  tests/transaction-ingestion-recovery.test.ts
```

- [ ] **Step 3: Wire a fixed primary pass**

In `createProductionListenerRuntime`, construct the paired catalog once and a
dedicated primary pass once. Inject an immutable source whose `openPass`
returns that pass:

```ts
const providers = createRpcProviderCatalog(config);
const primaryFinality = createProviderPinnedFinalityPass(providers, 'primary');
const finalitySource: FinalityProviderPassSource = Object.freeze({
  openPass: () => primaryFinality,
});
```

Keep the general failover-enabled `SolanaRpcClient` for transaction lookup,
market reads, catch-up and heartbeat. Do not change the production WebSocket
subscriber or activate #63 behavior.

- [ ] **Step 4: Run focused lifecycle tests and static checks until green**

Run the Step 2 command, `npm run check:backend`, and `npm run lint:backend`.

- [ ] **Step 5: Commit the slice**

```bash
git add src/application/production-listener-factory.ts \
  tests/production-listener-factory.test.ts \
  tests/transaction-ingestion-recovery.test.ts
git commit -m "feat: pin production finality to primary RPC (#61)"
```

### Task 6: Migration manifests, documentation, full validation and PR

**Files:**

- Modify: `scripts/deployment-smoke.mjs`
- Modify: `tests/api-event-stream-migration.test.ts`
- Modify: `tests/creation-entry-migration.test.ts`
- Modify: `tests/participant-analytics-migration.test.ts`
- Modify: `tests/paper-mvp-migration.test.ts`
- Modify: `tests/social-persistence-retry-migration.test.ts`
- Modify: `tests/transaction-inbox-retry-migration.test.ts`
- Modify: `tests/transaction-inbox-timestamp-migration.test.ts`
- Modify: `tests/transaction-ingestion-migration.test.ts`
- Modify: `tests/wallet-graph-migration.test.ts`
- Modify: `docs/system-overview.html`
- Modify: `README.md`

- [ ] **Step 1: Update every migration manifest assertion**

Use a repository-wide search:

```bash
rg -n "026_listener_strict_catch_up_failures|001-026|last migration" \
  scripts tests docs README.md
```

Advance all authoritative last-migration lists and assertions to
`027_listener_provider_affine_finality.sql`. Do not mechanically change
historical statements that intentionally describe migration 026 itself.

- [ ] **Step 2: Document the operational behavior**

Add concise versioned documentation explaining:

```text
finality source in #61: primary-only pinned HTTP
provider unavailable: DEGRADED and retry next interval
orphan proof: same-provider misses + higher finalized root + available block
deployment: stop old replicas before applying migration 027
public data: positional provider IDs only; URLs remain secret
execution: observe/paper only, transaction submission disabled
```

Keep the Bootstrap diagnostic HTML consistent with the independent frontend
contract and do not present it as the product interface.

- [ ] **Step 3: Run focused migration and safety validation**

```bash
node --import tsx --test \
  tests/provider-affine-finality-migration.test.ts \
  tests/transaction-ingestion-migration.test.ts \
  tests/deployment-artifacts.test.ts \
  tests/production-listener-factory.test.ts
rg -n "sendTransaction|sendRawTransaction|Keypair|privateKey|secretKey" \
  src/application/finality-reconciler.ts \
  src/solana/rpc/provider-pinned-finality-source.ts \
  src/ports/finality-provider-pass.ts
```

Expected: tests pass and the safety search prints no match in the new finality
surface.

- [ ] **Step 4: Run every local gate with PostgreSQL**

```bash
npm install
npm run build
npm run check
npm run lint
npm run docs:check
npm test
git diff --check origin/main...HEAD
```

Expected: every command exits zero; backend PostgreSQL tests run rather than
skip, frontend tests remain green, migration 027 applies on an empty schema and
replays cleanly.

- [ ] **Step 5: Perform spec and quality review**

Review the diff against every requirement in
`docs/superpowers/specs/2026-08-27-provider-affine-finality-design.md`. Then run
a separate code-quality review focused on hostile inputs, redaction,
concurrency, crash recovery, PostgreSQL rollout and quota bounds. Fix every
blocking finding and rerun the affected focused tests plus all gates.

- [ ] **Step 6: Commit delivery documentation**

```bash
git add scripts/deployment-smoke.mjs tests docs/system-overview.html README.md
git commit -m "docs: describe provider-affine finality operations (#61)"
```

- [ ] **Step 7: Push, open PR and complete at most three review cycles**

```bash
git push -u origin feature/issue-61-provider-finality
gh pr create --repo pivox/sol-token-listener \
  --base main --head feature/issue-61-provider-finality \
  --title "feat: guarantee provider-affine Solana finality" \
  --body-file /tmp/issue-61-pr-body.md
```

The PR body must link #61 and #57, summarize migration 027 and primary-pinned
production behavior, list exact test/gate evidence, state that #49 was not run,
and state that no signing/submission capability was added. Request Codex review
in a PR comment. Use no more than three correction/re-review cycles. Merge only
after CI is green and no blocking thread remains.

- [ ] **Step 8: Merge and synchronize the umbrella**

After merge, verify #61 is closed, check #61 in issue #57, fetch/pull `main`,
and create the isolated branch/worktree for #62. Keep #49 explicitly separate
and unexecuted.
