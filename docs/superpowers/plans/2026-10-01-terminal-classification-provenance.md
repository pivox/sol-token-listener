# Terminal classification provenance implementation plan

> **For agentic workers:** Use executing-plans to implement task-by-task.

**Goal:** Preserve legitimate classification metadata in FAILED terminal evidence.

**Architecture:** Retain the existing v1 bounded artifact and normalizer. Remove
only its false null-reason invariant for FAILED groups; no persistence change.

**Tech Stack:** TypeScript ESM, node:test, tsx.

## Task 1 — reproduce the contract mismatch

- [x] In `tests/mainnet-terminal-attribution.test.ts`, build FAILED rows using
  `currentRow({catch_up_reason_code:'PUMP_ACTION_SUPPORTED'})` for retryable and
  terminal outcomes. Assert reason preservation, totals, and serialize/parse equality.
- [x] Add capture regression to `tests/capture-mainnet-terminal-attribution-cli.test.ts`
  using the existing STOPPED fake connection, one classified FAILED row and zero
  occurrences/incomplete counts. Assert final query COMMIT and preserved reason.
- [x] Run `node --import tsx --test tests/mainnet-terminal-attribution.test.ts tests/capture-mainnet-terminal-attribution-cli.test.ts`;
  the new tests must fail with TypeError before production edits.

  RED: 21 tests, 18 passed, 3 failed. All three new classified-FAILED regressions
  failed with `TypeError: Invalid mainnet terminal attribution evidence.` from
  `createCurrentGroup` before the source change.

## Task 2 — minimal correction and negative evidence

- [x] In `scripts/lib/mainnet-terminal-attribution.ts`, change the FAILED guard
  from `typeof retryable !== 'boolean' || catchUpReasonCode !== null` to
  `typeof retryable !== 'boolean'`. Keep all other guards and parsing intact.
- [x] Add unknown raw reason normalization and invalid serialized reason tests;
  retain existing malformed state/retry/quarantine tests.
- [x] Run the command above plus `tests/mainnet-canary.test.ts` if present, and
  `npm run check`, `npm run lint`, `npm run docs:check`; inspect actual scripts first.
- [x] Commit only spec/plan, source and regression files; update completion boxes.

  GREEN: focused artifact/capture tests 23/23 passed. No
  `tests/mainnet-canary.test.ts` exists; discovered mainnet-observe canary CLI and
  verdict suites passed 57/57. The final combined four-file run passed 80/80.
  `npm run check`, `npm run lint`, `npm run docs:check` and `git diff --check`
  passed. An initial lint failure for a new test's non-null assertion was fixed
  with assertion-based narrowing before the final lint run.

  This validates the artifact contract mismatch, not the exact historical cause
  of the disposed canary capture failure. No runtime or persistence change and
  no Mainnet rerun were performed.

## Task 3 — delivery

- [ ] Local review cycle 1; address confirmed findings and rerun targeted tests.
- [ ] Open PR linked to #201, request GitHub review cycle 2, run full CI.
- [ ] Resolve findings, merge exact tested head only after all checks pass.
- [ ] Update excluded tracking and verify post-merge CI. No Mainnet rerun here.
