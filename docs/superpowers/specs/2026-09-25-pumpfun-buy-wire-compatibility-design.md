# Pump.fun BUY wire compatibility design

## Status and scope

Specification version: `pumpfun-buy-wire-compatibility.v1`.

This change is observe-side only. It adds no wallet, signer, transaction
submission, paper-entry, or live-execution capability. Its only purpose is to
decode bounded historical BUY payloads that the Pump program still accepts on
Mainnet, while keeping unknown encodings fail-closed.

## Authorities and evidence

The canonical schema remains the official `pump-fun/pump-public-docs` IDL.
The current upstream revision checked for this change is
`81091419e4457566469d4e2a27f64ed84d42419c`. The repository-pinned generated
IDL and discriminator provenance remain unchanged.

The compatibility cases come from finalized public Mainnet transactions
captured by the exact `main@e12d301` observe-only canary. They are evidence of
wire forms accepted by the program, not a substitute for the official IDL.
Fixtures must use the existing `solana-mainnet-fixture.v1` contract, contain
only public chain data, and record immutable signature, slot and transaction
index provenance.

## Exact accepted layouts

The eight-byte official discriminator is always decoded first. No new or
third-party discriminator is introduced.

For legacy `buy` and `buy_exact_sol_in`, the two required `u64` arguments are
followed by exactly one of these suffixes:

| Suffix bytes | Meaning |
| ---: | --- |
| 0 | historical omission; normalize `track_volume` to `[false]` |
| 1 | current official `OptionBool` struct; byte must be `0` or `1` |
| 2 | historical Borsh option; bytes must be `[1, 0]` or `[1, 1]` |

The two-byte form normalizes its second byte to `track_volume`. A two-byte
`None` or any non-boolean byte is rejected: the one-byte omission already
provides the only supported absent/default representation.

For `buy_exact_quote_in_v2`, the two official `u64` arguments are followed by
either no suffix, as in the current IDL, or one historical boolean byte `0` or
`1`. When present, the compatibility flag is retained as
`track_volume: [boolean]`; when absent, no synthetic field is added.

`buy_v2`, all SELL instructions, CREATE instructions and migration
instructions retain their existing exact-EOF behavior. Every unlisted length
or value fails with stable code `PUMP_BORSH_INVALID`.

## Decoding boundary

Compatibility is selected by the already matched official instruction name,
never by account heuristics or log text. Required IDL fields are decoded first
with integer-safe readers. A dedicated BUY suffix decoder then consumes and
validates the entire bounded suffix. The common final EOF assertion remains in
place as defense in depth.

External and inner instructions use the same decoder. Transaction decoding
and catch-up classification must therefore obtain the same result for the same
wire payload.

## Tests and operational proof

TDD starts with RED unit cases for the exact observed layouts, plus rejection
of unknown lengths, invalid booleans and malformed two-byte options. Public
Mainnet fixtures cover at least one inner `buy_exact_quote_in_v2` and one
legacy BUY form. Transaction and catch-up classifier tests prove that the
payloads no longer become `PUMP_BORSH_INVALID` or
`PUMP_SCHEMA_UNSUPPORTED`.

The local and CI gates remain build, TypeScript check, lint, docs check,
backend/frontend tests and diff check. A later fresh observe-only Mainnet run
must report the decoder-quarantine effect separately from backlog, worker
capacity, first-processing eligibility and oversize-cache debt.

