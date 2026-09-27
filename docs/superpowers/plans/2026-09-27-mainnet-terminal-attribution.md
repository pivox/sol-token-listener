# Mainnet Terminal Attribution Implementation Plan

> **For agentic workers:** use `subagent-driven-development` or
> `executing-plans`; implement every behavioral change test-first and preserve
> retry/terminal decisions exactly.

**Goal:** Deliver #170 as one independently mergeable PR that captures a
bounded, deterministic and sanitized explanation of every current terminal
inbox row and every newly observed diagnostic occurrence before the next
Mainnet canary.

**Architecture:** A separate exact-identity attribution sidecar follows trusted
errors without extending decision-bearing objects. Migration 057 stores
bounded occurrence evidence transactionally beside existing worker/catch-up
writes. A read-only snapshot exporter reconciles current inbox populations and
occurrences into `mainnet-terminal-attribution.v1`; the canary evaluator uses
aggregate-only evidence and fails closed.

**Tech stack:** TypeScript strict ESM, Node.js `node:test`, PostgreSQL 16,
existing Pump.fun IDL generator/checksum, existing canary evaluator and French
operator runbook.

**Design authority:**
`docs/superpowers/specs/2026-09-27-mainnet-terminal-attribution-design.md`
revision 1.0.1.

**Plan revision:** 1.0.1

---

## Task 1: Define the trusted attribution contract

**Files:**

- Create: `src/domain/terminal-attribution.ts`
- Create: `tests/terminal-attribution.test.ts`
- Modify: `src/domain/observed-pipeline-failure.ts`
- Modify: `src/launchpads/pumpfun/errors.ts`
- Modify: `src/application/launchpad-observation-errors.ts`
- Modify: `src/markets/pumpswap/errors.ts`
- Modify: focused exact-identity tests

- [ ] Write RED tests for exact closed keys, diagnostic enums, safe integer and
  byte-length bounds, immutability, hostile/revoked proxies and forged public
  error fields.
- [ ] Prove diagnostic registration, inheritance and failure/classification
  attachment work only through exact trusted identities.
- [ ] Prove existing observed origin, three-field `IngestionFailure`, decoder
  quarantine and `UNKNOWN` retryability are byte/behavior equivalent.
- [ ] Implement the minimal private WeakMap sidecar and immutable snapshotters;
  never traverse a message, `cause`, prototype or arbitrary property.
- [ ] Run focused tests, backend check and backend lint.
- [ ] Commit as `feat(reliability): define trusted terminal attribution`.

## Task 2: Capture Pump.fun wire and catch-up provenance

**Files:**

- Modify: `src/launchpads/pumpfun/instruction-decoder.ts`
- Modify: `src/launchpads/pumpfun/event-decoder.ts`
- Modify: `src/launchpads/pumpfun/transaction-decoder.ts`
- Modify: `src/application/pumpfun-catch-up-block-classifier.ts`
- Modify: `src/application/observed-transaction-pipeline.ts`
- Modify: `src/application/transaction-inbox-worker.ts`
- Modify: Pump instruction/event/transaction, catch-up, pipeline and worker tests

- [ ] Add RED tests for instruction/CPI crossed with outer/inner, correct
  discriminator/header/payload lengths and suffix-known versus unavailable.
- [ ] Cover malformed required fields, invalid booleans/UTF-8/lengths, invalid
  suffixes and several Pump instructions where only the throwing instruction is
  attributed.
- [ ] Preserve unknown-discriminator null behavior and every existing decoder
  result/error code.
- [ ] Add RED catch-up tests distinguishing authenticated decoder, locator,
  normalization, mint-limit and multi-mint causes despite shared durable reason.
- [ ] Transfer trusted evidence to the exact frozen worker failure or catch-up
  classification without altering either public shape or decision.
- [ ] Prove logger/observer failures and hostile thrown values cannot alter the
  pipeline result.
- [ ] Run all focused Pump/catch-up/worker tests, check and lint.
- [ ] Commit as `feat(pumpfun): preserve terminal wire attribution`.

## Task 3: Add migration 057 and durable occurrence writes

**Files:**

- Create: `migrations/057_transaction_inbox_terminal_attribution.sql`
- Create: `tests/transaction-inbox-terminal-attribution-migration.test.ts`
- Modify: migration head/catalog/checksum/startup/deployment fixtures discovered
  with `rg "056_transaction_inbox_bounded_tracking"`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`
- Modify: retention, role and recovery tests

- [ ] Write RED migration tests for empty install, 056 upgrade, immediate replay,
  migration-runner replay, exact schema/check/index/FK/privilege definitions,
  named-object drift and four-hour cascade retention.
- [ ] Add an append-only occurrence journal with deterministic replay identity,
  closed columns, bounded wire values, the full immutable public-chain locator,
  one database clock and least privilege; add a bounded incomplete-attribution
  counter to the parent inbox and revoke `PUBLIC`.
- [ ] Write RED repository tests for each worker attempt, retry clearing,
  eventual success, terminal exhaustion, catch-up replay, concurrent duplicate,
  rollback, purge and explicit unavailable evidence.
- [ ] Persist a trusted occurrence in the same transaction as `markFailed` or
  catch-up classification behind a fixed savepoint. On an attribution-only SQL
  rejection, roll back to the savepoint, increment the parent incomplete
  counter and preserve the terminal write/decision. Treat loss of the whole
  PostgreSQL transaction as the existing repository failure.
- [ ] Inject a real PostgreSQL journal rejection and prove the inbox terminal
  result still commits, the incompleteness marker survives later retry/success,
  and capture cannot PASS. Prove catch-up locator export after all runtime
  classifier objects have been discarded.
- [ ] Prove no arbitrary error name/text or forged sidecar reaches durable
  diagnostic columns.
- [ ] Update live migration catalog checksum only after final SQL bytes settle.
- [ ] Run migration/repository/retention/role/recovery tests, check and lint.
- [ ] Commit as `feat(storage): persist terminal attribution occurrences`.

## Task 4: Close UNKNOWN diagnostics and reproduce wallet concurrency

**Files:**

- Modify: `src/storage/wallet-graph.repository.ts`
- Modify: `src/application/wallet-graph-rebuild.service.ts`
- Modify: `src/solana/rpc/market-rpc-reader.ts`
- Modify: `src/markets/pumpswap/errors.ts`
- Modify: `src/markets/pumpswap/pumpswap-reserve-reader.ts`
- Modify: `src/markets/pumpswap/pool-validator.ts`
- Modify: `src/storage/market-observation.repository.ts`
- Modify: focused wallet graph/PumpSwap/pipeline tests

- [ ] Add RED exact-identity tests for every closed wallet graph and PumpSwap
  diagnostic plus `UNAVAILABLE` fallback; prove public names/messages/codes and
  mutable-RPC decoder causes cannot forge terminal authority.
- [ ] Translate SQLSTATE `40001`/`40P01` only at the trusted PostgreSQL query
  rejection boundary, not around arbitrary operation callbacks.
- [ ] Implement the deterministic two-worker same-mint test with promise
  barriers around RR begin, advisory-lock wait and concurrent commit. Prove the
  wait through `pg_locks`/`pg_blocking_pids` with bounded query polling and no
  sleep.
- [ ] Assert real `40001`, trusted serialization diagnostic, unchanged
  `wallet_graph.UNKNOWN` retryability, rollback/release and intact committed A
  state.
- [ ] Attach the other diagnostics at their narrow trusted boundaries without
  changing behavior, retries, wrappers, isolation or locking.
- [ ] Run focused unit/PostgreSQL tests, check and lint.
- [ ] Commit as `feat(reliability): classify unknown pipeline diagnostics`.

## Task 5: Build deterministic local capture

**Files:**

- Create: `scripts/lib/mainnet-terminal-attribution.ts`
- Create: `scripts/capture-mainnet-terminal-attribution.ts`
- Create: `tests/mainnet-terminal-attribution.test.ts`
- Create: `tests/capture-mainnet-terminal-attribution-cli.test.ts`
- Modify: `package.json`

- [ ] Write RED parser/builder tests for all current `FAILED` and
  `QUARANTINED`, terminal versus retry-pending failures, occurrence separation,
  legacy names, absent evidence, parent incomplete counters after later
  success, exact totals and reconciliation.
- [ ] Prove canonical bytewise group/representative order, input-shuffle byte
  determinism, 128-group limits, 1-MiB cap, safe integers, explicit overflow
  and no secret/prohibited fields.
- [ ] Write RED filesystem tests for exclusive `wx`, `0600`, owner, regular
  file, no symlink, byte cap, cleanup on partial failure and silent stderr/stdout
  with respect to artifact/provenance/database errors.
- [ ] Query inside one read-only RR snapshot after listener STOPPED. Normalize
  only recognized durable error names; map all other text to a closed legacy or
  unavailable value.
- [ ] Serialize without random values or a fresh clock so one snapshot yields
  byte-identical output.
- [ ] Add a compiled package command and production-image allowlist only if the
  runbook executes it inside the shipped image.
- [ ] Run focused CLI tests, build, check and lint.
- [ ] Commit as `feat(operations): capture terminal attribution evidence`.

## Task 6: Make canary gates consume aggregate evidence

**Files:**

- Modify: `scripts/lib/mainnet-observe-canary-verdict.ts`
- Modify: `tests/mainnet-observe-canary-verdict.test.ts`
- Modify: `scripts/evaluate-mainnet-observe-canary.ts`
- Modify: `docs/operations/block-hydration-canary.md`
- Modify: `tests/deployment-artifacts.test.ts`

- [ ] Add RED cases where any proven new terminal `FAILED` or exhaustion is
  `FAIL` even with incomplete grouping; keep retry-pending failure distinct.
- [ ] Add RED decoder cases for worker `PUMP_BORSH_INVALID` and authenticated
  catch-up decoder quarantine; neither may PASS.
- [ ] Reject missing/malformed/unreconciled/overflowed required attribution
  fail-closed. Accept null reason on worker and null error code on catch-up.
- [ ] Keep provenance out of evaluator output, logs, API and frontend; consume
  only the validated aggregate projection.
- [ ] Version the runbook command order: stop listener, capture in the still-live
  database, evaluate, then retain/copy owner-only artifacts and teardown.
- [ ] Document that attribution authorizes no decoder/retry change and no live
  transaction.
- [ ] Run evaluator, CLI, deployment docs, build/check/lint/docs.
- [ ] Commit as `docs(operations): enforce terminal attribution canary gates`.

## Task 7: Verify and deliver #170

- [ ] Install dependencies in this isolated worktree and use one task-owned
  PostgreSQL 16 container/volume only; remove them after verification.
- [ ] Run migration empty/upgrade/replay/drift, focused PostgreSQL suites and
  the no-sleep concurrency reproducer with zero unexplained skips.
- [ ] Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`,
  full backend PostgreSQL tests, frontend tests/E2E and deployment smoke/signal.
- [ ] Inspect the branch diff for prohibited wallet/signer/executor/armament,
  submission, RPC-capacity, retry, worker and decoder-layout changes.
- [ ] Review cycle 1/2: trust boundary, decision equivalence, durability,
  deterministic bounds, redaction, retention, migration drift and gate logic.
- [ ] Correct confirmed findings test-first. Use GitHub review as cycle 2/2 only
  if needed; never request a third cycle.
- [ ] Push, open a PR closing #170, request review, merge only with green CI and
  no unresolved blocking thread, then verify post-merge CI.
- [ ] Update the uncommitted local work tracking file. Do not commit it.
- [ ] Only after green post-merge CI, prepare a fresh exact-main 15-minute
  observe-only canary. Do not load a wallet or signer.

## Required non-regression evidence

- existing pipeline failure names, retryability and first-attempt terminality
  are unchanged;
- existing catch-up disposition/reason/action/fingerprint are unchanged;
- unknown Pump discriminators remain ignored, not reclassified;
- no decoder layout is accepted without official IDL plus sanitized fixture;
- observe mode needs no private key and cannot submit transactions;
- duplicate, orphaned, finality, restart and four-hour retention behavior stay
  covered;
- local provenance remains owner-only and never appears in API/log/frontend;
- only one task-owned PostgreSQL container runs during tests.
