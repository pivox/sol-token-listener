# Pump.fun TradeEvent CPI 24-byte suffix — evidence gate v1.0.0

## Scope and current evidence

The observe-only Mainnet canary on `main@ced66e7` retained 8,108 complete
`PUMP_BORSH_INVALID` diagnostic occurrences for inner `TradeEvent` CPI payloads
with 24 bytes after the known prefix. These are occurrences, not necessarily
unique transactions. Its aggregate artifact is owner-only at
`/tmp/sol-token-listener-canary-ced66e7-2026-10-02T23-09-17-678Z/`.
No representative signature or raw transaction belongs in Git, a PR comment,
or an ordinary log.

The [official Pump.fun IDL at `cb188ce0`](https://github.com/pump-fun/pump-public-docs/blob/cb188ce08b5069196eef1f3e4a0c43b70099793b/idl/pump.json)
defines the `TradeEvent` discriminator and ends with `holder_rewards_bps: u64`
and `holder_rewards: u64` (16 bytes). The
[official Holder Rewards documentation](https://github.com/pump-fun/pump-public-docs/blob/cb188ce08b5069196eef1f3e4a0c43b70099793b/docs/HOLDER_REWARDS_README.md)
and the official `@pump-fun/pump-sdk@2.0.0` package corroborate only the 0/16
historical variants. An SDK decode that tolerates extra bytes is not evidence
that the full payload was consumed. The third 8-byte segment is presently
unexplained. Its type, meaning, activation conditions and effect on known
fields are not asserted here.

## Decision and alternatives

Keep the current strict 0/16 parser and quarantine 24 until the evidence gate
below is satisfied. Do not make a generic trailing-byte tolerance, infer a
third `u64`, copy a third-party layout, or weaken canary gates.

Three approaches were considered:

1. Reject 24 indefinitely: safe but leaves the observed Mainnet population
   quarantined.
2. Validate a narrowly attested 24-byte variant and then specify its decoder:
   preferred only if authoritative schema or sufficient on-chain invariants
   establish the field boundary and show that the unknown segment cannot alter
   the business facts consumed by the listener.
3. Accept whatever an SDK coder returns despite trailing bytes: rejected,
   because partial Borsh consumption does not authenticate the residual data.

This document is an evidence-stage design, not approval to activate option 2.

## Evidence collection boundary

An owner-only, observe-only collector may select a small set of finalized
representatives from the canary attribution in memory. It must never open a
wallet or invoke transaction submission. For each representative it checks:

- same finalized transaction bytes, slot and instruction location from two
  independent RPC paths; disagreement is `INCONCLUSIVE`;
- official Pump.fun program, inner/outer CPI location, Anchor event header,
  official `TradeEvent` discriminator and exact payload length;
- strict decoding of the known prefix and first 16 suffix bytes, with exactly
  8 unconsumed bytes; no silent skip or misaligned field;
- event-to-instruction pairing in a transaction that may contain several
  Pump.fun instructions/events; no transaction-global balance delta counted
  more than once;
- mint, participant, direction and amounts independently consistent with the
  associated instruction and account movements where attribution is exact;
- different finalized slots and both buy/sell forms when the evidence contains
  them. Missing forms remain unproven, not implicitly supported.

The collector emits only a versioned, bounded aggregate: variant length,
instruction family, confirmation, number of distinct finalized samples and
slots, and pass/fail/inconclusive counts.
It must not persist signatures, account addresses, raw payloads, RPC URLs,
request headers, fingerprints or free-form errors. Raw source data stays in
memory and is discarded after the check; owner-only diagnostic aggregates are
deleted once no longer needed, no later than four hours thereafter. Provider
disagreement, orphaning,
ambiguous pairing or unavailable movement attribution is fail-closed.

## Decoder go/no-go

No decoder change follows merely from observing many 24-byte payloads or from
byte equality across RPCs. A follow-up revision must identify an official
IDL/SDK release or another independently verifiable on-chain schema/invariant
that establishes the final 8-byte boundary and proves the known fields used by
qualification and paper trading remain valid. If this cannot be established,
maintain quarantine and report #215 as externally blocked on protocol evidence.

If established, add a RED fixture with sanitized finalized data first. The
GREEN parser must accept exactly the newly proven variant, preserve 0/16,
reject all other lengths and malformed prefixes, and test worker and catch-up
pairing, idempotence, finality and orphan reconciliation. Financial rules,
wallets, execution and the 19 canary gates remain unchanged. One review cycle,
full CI, then a new 15-minute observe-only canary are required before any
readiness or live-trade gate can advance.
