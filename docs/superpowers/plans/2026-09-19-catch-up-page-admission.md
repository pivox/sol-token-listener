# Strict Catch-up Page Admission Implementation Plan

> **For agentic workers:** use subagent-driven development or execute each task
> in order. Every behavior change starts with a failing focused test.

**Goal:** Add an inactive, replay-safe page admission boundary between the
strict catch-up scanner and Pump.fun classifier, with durable exact accounting.

**Architecture:** An optional `StrictCatchUpPageAdmitter` receives only one
canonical Pump.fun launchpad page. The classifier returns repository-issued
receipts. Migration 049 persists the original catch-up enqueue decision so
replay reproduces exact counters. Scanner run/cursor/checkpoint mutations occur
only after the full receipt set is validated. Production factory composition
is intentionally deferred to B3b.

**Tech stack:** TypeScript strict ESM, Node test runner, PostgreSQL 16, existing
Pump.fun decoder, strict catch-up run and transaction inbox.

---

## Task 1: Define the receipt and migration contract

**Files:**
- Create `migrations/049_transaction_inbox_catch_up_admission_receipt.sql`
- Create `tests/catch-up-admission-migration.test.ts`
- Modify `src/domain/catch-up-classification.ts`
- Modify `src/ports/catch-up-classification-repository.ts`

- [ ] Add RED domain tests for exact immutable receipt shapes and invalid data.
- [ ] Add a PostgreSQL 16 RED migration test for empty install, upgrade,
  replay, backfill and constraint rejection.
- [ ] Implement the receipt domain and migration with
  `catch_up_enqueued BOOLEAN`.
- [ ] Run focused domain and migration tests GREEN.

## Task 2: Return replay-stable repository receipts

**Files:**
- Modify `src/storage/transaction-inbox.repository.ts`
- Modify `tests/transaction-inbox.repository.test.ts`

- [ ] Add RED tests for fresh actionable/deferred/terminal receipts, semantic
  replay and immutable historical admission.
- [ ] Add RED tests for pristine and non-pristine WebSocket convergence,
  including confirmed-to-finalized replay and terminal classifications.
- [ ] Implement atomic receipts, stored admission replay and the constrained
  WebSocket-existing path.
- [ ] Add optional abort checks before classification transaction commit.
- [ ] Run the full PostgreSQL transaction inbox suite GREEN.

## Task 3: Make the classifier cancellable and receipt-bearing

**Files:**
- Modify `src/application/pumpfun-catch-up-block-classifier.ts`
- Modify `tests/pumpfun-catch-up-block-classifier.test.ts`

- [ ] Add RED tests for returned order/receipts and cancellation before,
  during and after a slot hydration barrier and repository write.
- [ ] Require `AbortSignal`, forward it to locator/repository, validate each
  receipt against its classification and return a frozen deterministic array.
- [ ] Preserve all existing grouping, fingerprint and fail-closed behavior.
- [ ] Run classifier and block-cache integration tests GREEN.

## Task 4: Add the inactive Pump.fun page admitter

**Files:**
- Create `src/ports/strict-catch-up-page-admitter.ts`
- Create `src/application/pumpfun-strict-catch-up-page-admitter.ts`
- Create `tests/pumpfun-strict-catch-up-page-admitter.test.ts`

- [ ] Add RED tests for canonical launchpad input, one-to-one receipt
  validation, exact totals, replay and malformed dependency output.
- [ ] Implement the thin adapter using only the current page and canonical
  Pump.fun provenance.
- [ ] Prove PumpSwap or mixed input is rejected before classifier access.

## Task 5: Insert the page barrier in the scanner

**Files:**
- Modify `src/application/strict-catch-up-scanner.ts`
- Modify `src/domain/strict-catch-up-run.ts`
- Modify `src/ports/strict-catch-up-repository.ts`
- Modify `src/storage/transaction-inbox.repository.ts`
- Modify `tests/strict-catch-up-scanner.test.ts`
- Modify relevant strict-run and integration tests

- [ ] Add RED tests proving no run/cursor/checkpoint mutation precedes a full
  page receipt and no page-admitter call occurs for PumpSwap.
- [ ] Add RED tests for partial-write replay, already-admitted receipts,
  pause/restart, final page and cancellation at every boundary.
- [ ] Inject an optional fourth constructor dependency; keep the absent path
  observably identical.
- [ ] Use receipt totals only for the Pump.fun admitted path and legacy row
  totals everywhere else.
- [ ] Pass optional signals to run/checkpoint mutations and check before
  transaction commit.
- [ ] Run scanner, supervisor and repository integration suites GREEN.

## Task 6: Verify and deliver

- [ ] Run focused tests repeatedly, then PostgreSQL 16 suites.
- [ ] Run `npm run build`, `npm run check`, `npm run lint`,
  `npm run docs:check`, `npm test` and whitespace validation.
- [ ] Perform at most two local review/fix cycles.
- [ ] Push issue #135 branch and open one independent PR linked to #120.
- [ ] Request review, address blocking feedback within the allowed cycle cap,
  require green CI, then merge.
- [ ] Verify post-merge CI before starting B3b.

No step may compose the new admitter in `production-listener-factory.ts` or
touch wallet, signing, submission, executor or live RPC behavior.
