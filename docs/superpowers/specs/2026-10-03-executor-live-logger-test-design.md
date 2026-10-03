# Executor live logger redaction assertion v1.0.0

## Scope and evidence

The post-merge CI of `main@dd9c4b9` failed one backend test:
`drops secrets, economic values and hostile error objects before serialization`.
It searched the entire Pino JSON line for the string `123`, intended to catch
an injected `amount: 123n`. The unrelated Pino `time` field can naturally
contain those digits. With `Date.now()` fixed to `1790994518123`, the original
assertion fails deterministically even though the emitted JSON has only the
closed, approved fields. The failure is in the test oracle, not evidence of a
secret leak or a change introduced by the documentation-only PR #220.

## Design

Keep the hostile input unchanged and fix time deterministically in the test.
Assert the **entire parsed emitted object** equals the expected allowlisted
Pino fields and their values. This checks that URL, database URL, wallet path,
signature, mint, bigint amount and Error object are absent without confusing
their bytes with the safe timestamp. Do not change the production logger,
redaction policy or any runtime behavior.

## Verification

The old assertion must fail under the fixed timestamp (RED), the exact-object
assertion must pass (GREEN), and build, check, lint, full local tests and CI
must pass before merge. This test-only fix does not affect the 19-gate Mainnet
canary, RPC capacity, wallet state or trading authority.
