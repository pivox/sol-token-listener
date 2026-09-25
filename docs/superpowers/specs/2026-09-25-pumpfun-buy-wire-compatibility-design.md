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
`81091419e4457566469d4e2a27f64ed84d42419c`. The historical official revision
`df5013e0f9253aa8039300964f1e0076da90c83d` proves that legacy `buy` contained
only its two `u64` arguments. The repository-pinned generated IDL and
discriminator provenance remain unchanged.

The compatibility cases come from finalized public Mainnet transactions
captured by the exact `main@e12d301` observe-only canary. They are evidence of
wire forms accepted by the program, not a substitute for the official IDL.
Fixtures must use the existing `solana-mainnet-fixture.v1` contract, contain
only public chain data, and record immutable signature, slot and transaction
index provenance.

## Exact accepted layouts

The eight-byte official discriminator is always decoded first. No new or
third-party discriminator is introduced.

For legacy `buy`, the two required `u64` arguments are followed by exactly one
of these suffixes:

| Suffix bytes | Meaning |
| ---: | --- |
| 0 | historical official layout; do not synthesize `track_volume` |
| 1 | current official `OptionBool` struct; byte must be `0` or `1` |

For `buy_exact_sol_in`, the current one-byte official `OptionBool` remains
accepted. One additional finalized Mainnet layout is accepted: the exact
two-byte suffix `[1, 0]`. It is decoded as a historical `Some(false)` and
retained as `track_volume: [false]`. Zero bytes, `[1, 1]`, a `None` tag, and
all other lengths or values remain rejected until they have their own
versioned authority or finalized fixture. This does not call the current
one-byte `OptionBool` a Borsh `Option<bool>`: those are distinct layouts.

For `buy_exact_quote_in_v2`, the two official `u64` arguments are followed by
either no suffix, as in the current IDL, or the exact finalized Mainnet suffix
`[1]`. When present, the compatibility flag is retained as
`track_volume: [true]`; when absent, no synthetic field is added. A zero byte
or any other suffix remains rejected pending independent evidence.

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
of unknown lengths, invalid booleans and malformed two-byte options. Every
non-current layout has either an immutable official historical revision or a
dedicated finalized Mainnet fixture with signature, slot, transaction index
and exact instruction bytes. Full transaction tests cover both external and
inner compatibility paths. Transaction and catch-up classifier tests prove
that the payloads no longer become `PUMP_BORSH_INVALID` or
`PUMP_SCHEMA_UNSUPPORTED`.

The local and CI gates remain build, TypeScript check, lint, docs check,
backend/frontend tests and diff check. A later fresh observe-only Mainnet run
must report the decoder-quarantine effect separately from backlog, worker
capacity, first-processing eligibility and oversize-cache debt.
