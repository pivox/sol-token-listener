# Terminal classification provenance implementation plan

> **For agentic workers:** Use executing-plans to implement task-by-task.

**Goal:** Preserve legitimate classification metadata in FAILED terminal evidence.

**Architecture:** Retain the existing v1 bounded artifact and normalizer. Remove
only its false null-reason invariant for FAILED groups; no persistence change.

**Tech Stack:** TypeScript ESM, node:test, tsx.

## Task 1 — reproduce the contract mismatch

- [ ] In `tests/mainnet-terminal-attribution.test.ts`, build FAILED rows using
  `currentRow({catch_up_reason_code:'PUMP_ACTION_SUPPORTED'})` for retryable and
  terminal outcomes. Assert reason preservation, totals, and serialize/parse equality.
- [ ] Add capture regression to `tests/capture-mainnet-terminal-attribution-cli.test.ts`
  using the existing STOPPED fake connection, one classified FAILED row and zero
  occurrences/incomplete counts. Assert final query COMMIT and preserved reason.
- [ ] Run `node --import tsx --test tests/mainnet-terminal-attribution.test.ts tests/capture-mainnet-terminal-attribution-cli.test.ts`;
  the new tests must fail with TypeError before production edits.

## Task 2 — minimal correction and negative evidence

- [ ] In `scripts/lib/mainnet-terminal-attribution.ts`, change the FAILED guard
  from `typeof retryable !== 'boolean' || catchUpReasonCode !== null` to
  `typeof retryable !== 'boolean'`. Keep all other guards and parsing intact.
- [ ] Add unknown raw reason normalization and invalid serialized reason tests;
  retain existing malformed state/retry/quarantine tests.
- [ ] Run the command above plus `tests/mainnet-canary.test.ts` if present, and
  `npm run check`, `npm run lint`, `npm run docs:check`; inspect actual scripts first.
- [ ] Commit only spec/plan, source and regression files; update completion boxes.

## Task 3 — delivery

- [ ] Local review cycle 1; address confirmed findings and rerun targeted tests.
- [ ] Open PR linked to #201, request GitHub review cycle 2, run full CI.
- [ ] Resolve findings, merge exact tested head only after all checks pass.
- [ ] Update excluded tracking and verify post-merge CI. No Mainnet rerun here.
