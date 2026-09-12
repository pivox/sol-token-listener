# Current Pump.fun `create_v2` Decoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode the current official Pump.fun creation layouts exactly while preserving legacy creation support and all observe-only safety boundaries.

**Architecture:** Re-pin only the Pump program IDL, decode its explicitly EOF-compatible creation suffix in a dedicated path, validate the quote-control PDA at the account boundary, then cross-check requested and effective creator identities according to holder-reward semantics. Keep the existing generic transaction and projection flow unchanged outside the additive creation fields.

**Tech Stack:** TypeScript strict ESM, Node test runner, `@solana/web3.js`, Borsh readers, sanitized finalized Solana fixtures.

---

### Task 1: Pin official schema and specify exact compatibility

**Files:**
- Modify: `vendor/pumpfun/idl/manifest.json`
- Create: `vendor/pumpfun/idl/pump-f216b672.json`
- Modify: `scripts/generate-pumpfun-idl.ts`
- Modify: `tests/pumpfun-idl-generation.test.ts`
- Modify: `docs/architecture/pumpfun-v1.md`

- [x] Add failing assertions for the immutable revision, checksum, `OptionU64`, and official appended fields.
- [x] Run `npx tsx --test tests/pumpfun-idl-generation.test.ts` and confirm the old revision fails.
- [x] Vendor the checksum-pinned official bytes and regenerate the TypeScript subset.
- [x] Re-run the focused test and confirm it passes.

### Task 2: Decode exact instruction suffixes and accounts

**Files:**
- Modify: `tests/pumpfun-instruction-decoder.test.ts`
- Modify: `src/launchpads/pumpfun/instruction-decoder.ts`

- [x] Add failing tests for suffix sizes 0, 1, 9, and 10, explicit defaults, exact 0/3/4 remaining accounts, and invalid sizes/accounts/PDAs.
- [x] Run the focused test and confirm failures come from the old generic decoder.
- [x] Add the minimal special `create_v2` argument decoder and quote-control PDA validation.
- [x] Re-run the focused test and keep all legacy instruction tests green.

### Task 3: Decode and reconcile exact creation evidence

**Files:**
- Modify: `tests/pumpfun-event-decoder.test.ts`
- Modify: `tests/pumpfun-transaction-decoder.test.ts`
- Modify: `tests/pumpfun-launchpad-adapter.test.ts`
- Modify: `src/launchpads/pumpfun/event-decoder.ts`
- Modify: `src/launchpads/pumpfun/transaction-decoder.ts`
- Modify: `src/launchpads/pumpfun/types.ts`
- Modify: `src/launchpads/pumpfun/pumpfun-launchpad.adapter.ts`

- [x] Add failing tests for historical/current CreateEvent suffixes and holder-reward creator divergence.
- [x] Run focused tests and confirm the missing fields/equality rule fail.
- [x] Add exact defaults, requested/effective creator fields, and additive launch parameters.
- [x] Re-run all focused decoder and adapter tests.

### Task 4: Add current finalized Mainnet evidence

**Files:**
- Create: `tests/fixtures/pumpfun/create-v2-current-initial-buy-mainnet.json`
- Create: `tests/fixtures/pumpfun/create-v2-quote-control-mainnet.json`
- Modify: `tests/pumpfun-mainnet-fixtures.test.ts`

- [x] Add failing offline fixture assertions for both current layouts.
- [x] Capture or serialize only finalized public normalized evidence under the existing sanitization contract.
- [x] Run the Mainnet fixture tests and confirm both transactions decode exactly.

### Task 5: Verify and publish without review

**Files:** all changed files above.

- [x] Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`, and `npm test`.
- [x] Inspect `git diff --check`, the complete diff, and repository status.
- [x] Commit, push the isolated branch, and open a PR linked to issue 121 without requesting review or merging.

### Task 6: Correct cycle-one protocol review findings

**Files:**
- Modify: `src/launchpads/pumpfun/transaction-decoder.ts`
- Modify: `tests/pumpfun-event-decoder.test.ts`
- Modify: `tests/pumpfun-transaction-decoder.test.ts`
- Modify: `tests/pumpfun-mainnet-fixtures.test.ts`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/superpowers/specs/2026-09-12-pumpfun-current-create-v2-decoder-design.md`

- [x] Demonstrate RED for a redundant QuoteControl account with an ignored nonzero requested fee.
- [x] Keep `CreateEvent.creatorFeeBps` authoritative without unavailable account-state inference.
- [x] Demonstrate RED for an arbitrary effective holder-reward creator.
- [x] Require the exact Pump `holder-rewards` PDA derived from the mint.
- [x] Re-run complete verification, publish the correction, and resolve both review threads.

### Task 7: Close the final local bonding-curve evidence gap

**Files:**
- Modify: `src/launchpads/pumpfun/transaction-decoder.ts`
- Modify: `tests/pumpfun-transaction-decoder.test.ts`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/superpowers/specs/2026-09-12-pumpfun-current-create-v2-decoder-design.md`

- [x] Demonstrate RED for a creation whose instruction and event disagree on the bonding curve.
- [x] Require the exact instruction/event bonding-curve match before projection.
- [x] Re-run complete verification and publish without requesting a third review cycle.
