# Pump.fun BUY Wire Compatibility Amendment

Date: 2026-09-27

Issue: #184

Status: approved for implementation

Contract revision: 1.1.0

Supersedes the accepted-layout table in
`2026-09-25-pumpfun-buy-wire-compatibility-design.md` revision 1.0.0. All
other scope and security constraints remain in force.

## Evidence

The exact observe-only Mainnet probe on `main@ca65ffb` captured two successful,
finalized Pump instructions currently rejected as `PUMP_BORSH_INVALID`:

- `buy_exact_sol_in`: two required `u64`, no suffix;
- `buy`: two required `u64`, suffix bytes `01 01`.

The official Pump.fun IDL at revision `e0687ae9b7e0` defines both instructions
with two required `u64` followed by the one-byte `OptionBool` compatibility
struct. Official revisions through `d1b721d7bf8a` prove that legacy `buy` had
only the two required `u64`. The finalized `01 01` representative is a bounded
historical Borsh `Some(true)` encoding observed as accepted by the program. No
third-party discriminator or schema is used.

Official authority:
`https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json`.

## Revised accepted layouts

After decoding the official discriminator and exactly two required `u64`:

| Instruction | Suffix | Normalized result |
| --- | --- | --- |
| `buy` | empty | omit `track_volume` |
| `buy` | `00` or `01` | current `OptionBool`, false or true |
| `buy` | `01 00` or `01 01` | historical `Some(false/true)` |
| `buy_exact_sol_in` | empty | omit `track_volume` |
| `buy_exact_sol_in` | `00` or `01` | current `OptionBool`, false or true |
| `buy_exact_sol_in` | `01 00` or `01 01` | historical `Some(false/true)` |

Every other length, tag or boolean byte remains a typed
`PUMP_BORSH_INVALID`. In particular `00 xx`, `01 02`, two zero bytes and any
suffix longer than two bytes remain invalid. `buy_exact_quote_in_v2`, V2,
SELL, CREATE and migration layouts are unchanged.

## Fixture contract

Each newly accepted form requires an immutable finalized
`solana-mainnet-fixture.v1` fixture captured with the existing official
provider-independent capture path. Fixtures contain public normalized chain
data, exact provenance and no RPC URL, credential, header or private data.

Transaction decoding must pair the action with its authenticated Pump trade
event and prove the same mint, side, cursor and amounts. The compatibility
field reflects only the exact suffix; no field is synthesized for an omitted
suffix.

## Acceptance

- RED unit tests precede the decoder change for empty exact-SOL and `01 01`
  legacy buy;
- invalid two-byte combinations remain rejected;
- both finalized fixtures decode into one coherent BUY trade;
- catch-up classification becomes supported trade evidence instead of decoder
  quarantine;
- generated IDL checksum, focused Pump tests, build, check, lint and docs pass;
- at most two review cycles and no wallet, signer, quote or execution change.
