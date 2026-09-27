# Funding Observation Terminal Attribution Plan

**Goal:** replace unattributed funding-observation terminal evidence with an
exact trusted boundary diagnostic while preserving the current retryable
pipeline failure and every business outcome.

**Design authority:**
`docs/superpowers/specs/2026-09-27-funding-observation-terminal-attribution-design.md`
revision 1.0.0.

**Plan revision:** 1.0.0

## Task 1: Lock the exact-identity contract RED

**Files:**

- Modify: `tests/terminal-attribution.test.ts`
- Modify: `tests/wallet-evidence-observation.service.test.ts`

- [ ] Add the exact three diagnostic codes to the closed-vocabulary tests.
- [ ] Prove `validate`, `extract`, and `record` produce their own trusted code.
- [ ] Prove the exact original cause is retained without being inspected.
- [ ] Reject authority from the public constructor, clones, subclasses,
  lookalike properties, proxies, revoked proxies, and cause-chain lookups.
- [ ] Prove empty/success/normal unavailable results remain unattributed.

## Task 2: Add the minimal trusted boundary factory

**Files:**

- Modify: `src/domain/terminal-attribution.ts`
- Modify: `src/application/wallet-evidence-observation.service.ts`

- [ ] Add only the three stable diagnostic values.
- [ ] Map the closed service stage union exhaustively to those values.
- [ ] Register on the exact internally-created wrapper identity only.
- [ ] Replace the three direct wrapper constructions with the private factory.
- [ ] Do not inspect or classify the underlying cause.

## Task 3: Prove pipeline and worker equivalence

**Files:**

- Modify: `tests/observed-pipeline-failure.test.ts` or add one focused test file
- Modify: `tests/transaction-inbox-worker.test.ts`

- [ ] Run the real service through each failing boundary.
- [ ] Assert the durable failure still ends in `.funding_observation.UNKNOWN`
  with `retryable=true` and the same code.
- [ ] Assert the trusted diagnostic reaches the exact frozen failure and the
  worker locator context remains unchanged.
- [ ] Prove a directly-thrown hostile lookalike remains unattributed.
- [ ] Make no production change to pipeline or worker unless a test exposes a
  generic propagation defect.

## Task 4: Extend the PostgreSQL vocabulary forward-only

**Files:**

- Create: `migrations/058_transaction_inbox_funding_attribution.sql`
- Create: `tests/transaction-inbox-funding-attribution-migration.test.ts`
- Modify: migration catalog and deployment-head assertions located from the
  exact 057 references
- Adjust: the 057 replay test so it executes against a database stopped at 057

- [ ] Test empty install, exact 057-to-058 upgrade, immediate replay, migration
  runner replay, and exact migration checksum.
- [ ] Test fail-closed drift, absent/duplicate constraint, typo codes, and
  adjacent unapproved codes.
- [ ] Prove rows, columns, indexes, privileges, and retention are unchanged.
- [ ] Update every runtime/deployment migration head to 058.

## Task 5: Prove journal, capture, and canary behavior

**Files:**

- Modify: `tests/transaction-inbox-terminal-attribution.repository.test.ts`
- Modify: `tests/mainnet-terminal-attribution.test.ts`
- Modify: `tests/mainnet-observe-canary-verdict.test.ts`

- [ ] Persist each diagnostic with `stage=funding_observation`, `origin=NULL`,
  `completeness=COMPLETE`, and retryable worker evidence.
- [ ] Preserve retry-pending and fifth-attempt exhaustion behavior.
- [ ] Parse, group, order, and serialize the new values deterministically.
- [ ] Keep absent/malformed/incomplete evidence fail-closed.
- [ ] Keep decoder gates and unrelated diagnostics unchanged.

## Task 6: Verify and deliver

- [ ] Run all focused attribution, service, pipeline, worker, repository,
  migration, capture, and canary tests with the dedicated PostgreSQL role.
- [ ] Run build, check, lint, docs, and diff checks.
- [ ] Inspect for zero wallet, signer, executor, RPC, retry, or scheduler change.
- [ ] Complete at most two review cycles and merge only after green CI.
- [ ] After post-merge CI, run only a short observe-only Mainnet probe; create a
  separate causal change only from reproduced evidence.
