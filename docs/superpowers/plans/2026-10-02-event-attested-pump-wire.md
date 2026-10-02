# Event-attested Pump wire compatibility implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Decode two captured Pump.fun instruction forms only when their transaction supplies a unique, coherent CPI event.

**Architecture:** Preserve `decodePumpInstruction()` as the strict IDL reader. A transaction-only candidate reader recognizes exactly two opaque suffix profiles after decoding required fields. The transaction decoder validates their event and authority before returning business actions.

**Tech Stack:** TypeScript strict ESM, `@solana/web3.js`, existing normalized Solana fixtures, `node:test`/`tsx`, PostgreSQL16 for full regression gate.

---

Spec: [v1.0.0](../specs/2026-10-02-event-attested-pump-wire-design.md), commit `8202ee9`. Issue [#213](https://github.com/pivox/sol-token-listener/issues/213). Task 1 copies public captured fixtures and records RED tests while #212 post-merge CI runs; no production decoder edit begins before that CI is green. User authorizes one combined review cycle; do not start one review per task. Preserve root `main` and excluded private harness.

## Files and boundaries

- `tests/fixtures/pumpfun/create-v2-opaque-holder-mainnet.json` and `sell-opaque-volume-mainnet.json`: byte-for-byte normalized copies of `/tmp/sol-listener-wire-evidence-1bbf839/create_v2.json` and `sell.json`, with existing `solana-mainnet-fixture.v1` provenance. The names identify observed forms, not invented layouts.
- `tests/pumpfun-mainnet-fixtures.test.ts`: real fixture acceptance, strict standalone rejection, provenance, original bytes and multi-quote observation.
- `tests/pumpfun-transaction-decoder.test.ts`: in-memory negative cases for pairing, event authority, semantic contradictions and suffix exactness.
- `tests/pumpfun-instruction-decoder.test.ts`: standalone strict rejection and candidate prefix/provenance contract.
- `src/launchpads/pumpfun/instruction-decoder.ts`: existing official reader unchanged; adjacent transaction-only candidate reader shares discriminator/account mapping and required-field decoder.
- `src/launchpads/pumpfun/transaction-decoder.ts`: candidate lifecycle, event authority and profile-specific checks, then existing business projections.
- `src/launchpads/pumpfun/types.ts`: explicit internal profile/provenance types without fabricated optional arguments.
- `tests/pumpfun-catch-up-block-classifier.test.ts` and adapter tests when appropriate: validated output reaches both consumers, paper SOL allowlist unaffected.
- `docs/operations/block-hydration-canary.md`: bounded compatibility and a fresh canary requirement, if the decoder coverage section warrants it.

## Task 1 — Captured fixtures and failing end-to-end regressions

- [ ] Check `df -k .` before writes; stop and clean only task-owned disposable artifacts if available bytes fall to or below 5,000,000,000.
- [ ] Verify both source JSON objects with `parsePumpFixture`, matching provenance and `transaction.error === null`. Record SHA-256 digests of source files and check the committed fixtures retain those digests. Copy them with `apply_patch`; do not regenerate or rewrite on-chain data.
- [ ] Add fixture tests that load each committed file, assert `FINALIZED`, expected slot and transaction index, and call `decodePumpTransaction`. The creation test expects exactly one creation plus one initial BUY; the sell test expects one SELL. Assert original raw data suffixes `0001` and `0100`, custom quote `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`, TOKEN_2022/6 decimals on create, and that standalone `decodePumpInstruction` still rejects each.
- [ ] Run `npx tsx --test tests/pumpfun-mainnet-fixtures.test.ts`; record the two expected `PUMP_BORSH_INVALID` RED failures and unrelated tests' status. Do not modify the fixture to make it pass.
- [ ] Commit only copied fixtures and their RED tests, documenting that this intermediate commit is not mergeable.

## Task 2 — Candidate reader with exact profile recognition

- [ ] Add RED unit cases in `tests/pumpfun-instruction-decoder.test.ts`: the two raw instructions remain rejected by `decodePumpInstruction`; the new `decodePumpInstructionForTransaction` returns a candidate carrying exact `CREATE_V2_OPAQUE_0001_V1` or `SELL_OPAQUE_0100_V1`; required prefix args and original instruction reference are preserved; optional cashback/fee/holder/volume args are absent. Extra/truncated/changed suffix, wrong discriminator, bad account count and malformed required fields still reject with typed errors.
- [ ] In `types.ts`, define `PumpObservedWireProfile` as the two exact string literals and a candidate union with `{readonly action: DecodedPumpInstruction; readonly profile: PumpObservedWireProfile | null}`. `null` means strict IDL decoding. Do not add made-up optional args to `action.args`.
- [ ] In `instruction-decoder.ts`, export `decodePumpInstructionForTransaction(instruction)` returning that candidate or `null`. First call strict `decodePumpInstruction`. Only on a trusted `PUMP_BORSH_INVALID` from the two known names, decode the same required prefix again with `decodeIdlFields` (`create_v2`: first five fields, `sell`: both u64s), require exactly the captured two trailing bytes, then call existing `mapAccounts` and `familyOf`. Return a frozen candidate. Preserve the original strict error for any nonmatching bytes; do not convert unrelated errors or read/ignore unknown suffixes. Keep `decodePumpInstruction` unchanged.
- [ ] Run `npx tsx --test tests/pumpfun-instruction-decoder.test.ts` RED then GREEN. Commit scoped type/reader/tests.

## Task 3 — Authenticate and pair candidates before business output

- [ ] Add RED transaction tests covering: both fixtures; candidate with missing/duplicate/ambiguous/out-of-scope event; wrong Pump program/discriminator; wrong single CPI event authority, wrong candidate event_authority, wrong stack or cursor; incorrect create name/symbol/URI/mint/user/mayhem/cashback/holder/fee/effective creator/quote/control; incorrect sell side/ix_name/user/mint/token amount/trackVolume. Mutation should change only the field under test. Keep the original strict cases as controls.
- [ ] In `transaction-decoder.ts`, store candidate entries during instruction traversal, while collecting CPI events exactly as before. Keep `validateStackHeights`, `isEventInsideActionScope`, `requireOnlyEvent`, consumed-event tracking, orphan detection and migration path intact. Resolve the candidate only after its unique event is selected. The existing `DecodedPumpInstruction` returned to callers must contain the unmodified raw instruction and required prefix args; attach optional immutable wire evidence with profile and paired event cursor only after validation.
- [ ] Derive the canonical Pump event authority PDA with the IDL seed `__event_authority`; for these two profiles require the action `event_authority` account and the CPI instruction's sole authority account to equal it. Do not claim this is an existing global check or a signer flag proof.
- [ ] In `validateCreation`, use existing prefix/event comparisons, but for `CREATE_V2_OPAQUE_0001_V1` require event cashback `false`, holder reward `true` and event creator fee `0n`. Preserve the existing holder reward creator PDA check and all quote checks. Skip optional `action.args` comparisons only for this profile; never populate those fields from the event.
- [ ] In `validateTrade`, for `SELL_OPAQUE_0100_V1` require event `ixName === 'sell'`, `trackVolume === false`, and `tokenAmount === action.args.amount` with bigint. Retain existing direction, account, quote and token-program checks; do not infer net SOL output or sellability.
- [ ] Run `npx tsx --test tests/pumpfun-transaction-decoder.test.ts tests/pumpfun-mainnet-fixtures.test.ts` RED then GREEN, plus existing Pump instruction, event and attribution suites. Commit scoped decoder/types/tests.

## Task 4 — Consumer integration and safety regressions

- [ ] Add targeted classifier and launchpad adapter tests using the committed fixtures. Assert `CREATE`+`BUY` and `SELL` semantic action counts and stable instruction cursors. Verify the custom quote remains observable and ineligible for SOL-only paper entry under existing allowlist.
- [ ] Assert official/historical instruction variants, inner instructions, multiple actions, existing discriminator handling, all confirmation statuses and orphan reconciliation behavior are unchanged. Assert unsupported suffix failures still carry trusted `PUMP_BORSH_INVALID` attribution and quarantine identity.
- [ ] Run all Pump tests via `npx tsx --test tests/pumpfun-*.test.ts tests/pumpswap-*.test.ts` or narrower actual file set if the glob includes irrelevant suites. Check `npm run check:backend`, scoped lint, `git diff --check` and documentation. Commit only the integration tests/doc change.

## Task 5 — Full validation, single review and PR

- [ ] Recheck disk before each expensive gate; stop producers at 5,000,000,000 bytes free, clean only verified disposable task artifacts, remeasure and resume above the threshold.
- [ ] Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`, `git diff --check`, and `npm test` with both `TEST_DATABASE_URL` and `TEST_EXECUTOR_ROLE_DATABASE_URL` against one disposable PostgreSQL test instance. Record pass/fail/skip counts; a skipped DB test is not green evidence.
- [ ] Conduct ONE combined independent code/spec review of the complete diff. Fix every actionable finding and rerun affected checks. No additional review cycle unless a critical unreviewed change demands it.
- [ ] Create PR referencing #213 and #120; merge only with green CI on the reviewed commit and no blocking review threads. Fetch `origin/main` and verify post-merge CI. Preserve the dirty root `main` and the historical canary artifacts.
- [ ] Update the excluded local tracking. The previous Mainnet canary remains FAIL; a new bounded 15-minute observe-only canary, H2e/readiness, H2c and the operator checkpoint remain required before any trade.
