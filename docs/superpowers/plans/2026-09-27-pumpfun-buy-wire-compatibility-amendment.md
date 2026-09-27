# Pump.fun BUY Wire Compatibility Amendment Plan

**Goal:** accept only the two additional successful Mainnet BUY layouts proven
by #170 while preserving fail-closed decoding for every unproven suffix.

**Design authority:**
`docs/superpowers/specs/2026-09-27-pumpfun-buy-wire-compatibility-amendment.md`
revision 1.1.0.

**Plan revision:** 1.1.0

## Task 1: Lock the wire contract RED

**Files:**

- Modify: `tests/pumpfun-instruction-decoder.test.ts`

- [ ] Add RED success for empty `buy_exact_sol_in` without a synthetic field.
- [ ] Add RED success for `buy` suffix `01 01` normalized to `[true]`.
- [ ] Cover both booleans for one- and two-byte accepted forms.
- [ ] Keep `00 xx`, `01 02`, `00 00` and lengths above two RED-invalid.

## Task 2: Implement the bounded decoder table

**Files:**

- Modify: `src/launchpads/pumpfun/instruction-decoder.ts`

- [ ] Share a small exact suffix decoder between the two legacy BUY names.
- [ ] Preserve the common EOF check and stable typed error.
- [ ] Do not change generated IDL/discriminators or other instruction families.
- [ ] Run instruction and transaction decoder tests.

## Task 3: Capture and prove finalized transactions

**Files:**

- Create: two `tests/fixtures/pumpfun/*-mainnet.json` fixtures
- Modify: `tests/pumpfun-mainnet-fixtures.test.ts`
- Modify: focused catch-up classifier tests if needed

- [ ] Capture the two already identified finalized representatives using the
  existing `fixture:capture` command and an owner-only local Mainnet RPC URL.
- [ ] Verify provenance and exact instruction bytes without publishing the
  signatures in issue comments.
- [ ] Prove each fixture yields one coherent BUY and no decoder quarantine.

## Task 4: Verify and deliver

- [ ] Run generated-IDL checks and all focused Pump/catch-up tests.
- [ ] Run build, check, lint, docs and diff checks.
- [ ] Inspect for zero wallet/signer/quote/execution changes.
- [ ] Complete at most two review cycles; merge only after green CI.
