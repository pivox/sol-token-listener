# Pump.fun BUY wire compatibility implementation plan

Plan version: `pumpfun-buy-wire-compatibility-plan.v1`.

## Goal

Accept only the bounded historical BUY encodings proven on finalized Mainnet,
without weakening the official-IDL decoder or changing execution behavior.

## Task 1 — RED contracts

Files:

- Modify `tests/pumpfun-instruction-decoder.test.ts`.
- Modify `tests/pumpfun-mainnet-fixtures.test.ts`.
- Add public fixtures under `tests/fixtures/pumpfun/` only when the existing
  fixtures do not already contain the required wire forms.
- Modify the focused catch-up classifier test that owns
  `PUMP_SCHEMA_UNSUPPORTED` behavior.

Steps:

1. Add exact accepted cases for legacy zero-byte, official one-byte and
   historical two-byte `track_volume` suffixes.
2. Add `buy_exact_quote_in_v2` current and one-byte historical cases.
3. Add exact rejection cases for unknown lengths, invalid booleans and invalid
   two-byte option tags.
4. Prove at least one full inner-instruction fixture and catch-up classifier
   case are RED for the compatibility gap.
5. Run only the focused tests and record the expected failures.

## Task 2 — Minimal decoder implementation

Files:

- Modify `src/launchpads/pumpfun/instruction-decoder.ts`.

Steps:

1. Decode the two required `u64` fields before compatibility suffixes for
   `buy` and `buy_exact_sol_in`.
2. Decode and normalize only the suffix table in the versioned design.
3. Decode the official `buy_exact_quote_in_v2` fields and its optional
   historical boolean byte.
4. Preserve the common EOF assertion and stable typed error.
5. Run the focused instruction, transaction, fixture and classifier tests.

## Task 3 — Documentation and gates

Files:

- Modify `docs/architecture/pumpfun-v1.md` if the decoder contract needs an
  operator-visible note.
- Modify/add documentary contract tests when required by repository policy.

Steps:

1. Document the official authority, bounded compatibility and fail-closed
   behavior.
2. Run generated-IDL checks to prove no discriminator/schema drift.
3. Run build, check, lint, docs check, backend/frontend tests and diff check.
4. Complete at most two review cycles, fix blocking findings, open the PR,
   wait for green CI and merge only when review is clear.

## Deferred separate work

- First-processing cohort eligibility for intentionally deferred WebSocket
  trades.
- Priority separation and bounded worker/RPC capacity.
- Oversize hydration cache policy, already deferred until after the first
  microtrade by the tracked product decision.

