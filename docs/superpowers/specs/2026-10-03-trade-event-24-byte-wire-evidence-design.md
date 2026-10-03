# Pump.fun TradeEvent CPI 24-byte suffix — evidence gate v1.4.1

## Recheck and fail-closed regression (2026-10-03)

The official `pump-public-docs` main still points to `cb188ce08b5069196eef1f3e4a0c43b70099793b`.
Its `TradeEvent` ends with the two documented `u64` holder-reward fields;
official SDK 2.0.0 embeds the same IDL. Upstream issue #54 remains open and
has no maintainer serialization answer. Consequently the observed 24-byte
suffix is still **not** an accepted decoding variant. Synthetic unit tests
assert that both zero and nonzero extra eight-byte tails fail with
`PUMP_BORSH_INVALID`, and that terminal attribution records `suffixBytes: 24`
without exposing payload bytes. These tests protect the existing quarantine;
they do not constitute a finalized 24-byte fixture or a parser acceptance
test. Canary verdict stays FAIL/INCONCLUSIVE and #215 remains open pending
authoritative wire evidence.

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

The finalized Mainnet legacy Anchor IDL account derived from the Pump.fun
program ID is present and owned by that program. A read-only fetch using the
Anchor IDL client also ends `TradeEvent` at the same two documented `u64`
fields. This on-chain IDL does **not** describe the extra eight bytes or prove
that its published schema matches every currently emitted runtime event.

## Independent wire observation (2026-10-03)

An owner-only, observe-only collector selected nine distinct finalized slots
from the protected attribution in bounded windows of at most four. Standard
Solana `getTransaction` with
`commitment=finalized` and `encoding=base64` returned the same transaction
bytes, slot and selected inner CPI data from the configured Helius Mainnet RPC
and the [Solana public Mainnet RPC](https://solana.com/docs/references/clusters).
The latter is rate-limited and was used only for this bounded diagnostic.
All nine CPI payloads had the official event tag and discriminator, decoded
the pinned IDL-known prefix, left exactly 24 bytes, consumed the documented
two trailing `u64` values and left exactly eight opaque bytes. Six paired
to BUY and three to SELL actions in their own instruction/stack scopes, with
matching side, instruction name, mint, user and normalized quote mint; the
SELL action amount also matched the event token amount. Four basic offline
collector tests passed; only bounded aggregate counts were emitted. This
diagnostic did not complete the plan's exact per-instruction account-movement
attribution or its full adversarial collector test matrix.

The result is a narrow observed wire-shape and action-pairing match, but the
**compatibility-evidence verdict is `INCONCLUSIVE`**: the final eight bytes,
exact balance-movement attribution and safe downstream business use remain
unproved. It does not change the decoder go/no-go below. The protected source
signatures and raw RPC responses were not published or persisted by this check.

## Movement evidence is field-specific

The event's `tokenAmount`/`quoteAmount`, independently decoded transfer legs,
and transaction-wide pre/post balance deltas are different kinds of evidence.
The current decoder pairs an event to a Pump instruction, but does not prove
every fee endpoint or movement amount. A movement verifier must retain whether
RPC metadata, account indexes, stack heights and balance snapshots were
actually available; an absent form must not silently become an empty set or a
zero. Amounts must remain lossless integers.

For an action with complete invocation ancestry, a scoped SPL Token or System
transfer can be attributed to that action once, subject to supported account,
mint, token-program, fee-extension and lifecycle checks. An unrelated inner
instruction with missing stack height can hide a boundary and therefore makes
the relevant attribution `INCONCLUSIVE`. A transaction-wide delta is only a
conservation check, never an amount to reuse for several Pump actions. A
creation plus initial buy must separate minting and account-creation deposits
from the buy's transfer legs.

Native SOL can also be moved by a program directly changing lamports in an
account it owns, without a System transfer CPI. The
[Solana account-modification rules](https://solana.com/docs/core/accounts/modification-rules)
permit this, while [finalized RPC transaction metadata](https://solana.com/docs/rpc/json-structures)
provides transaction endpoints, not intermediate per-instruction balances.
Consequently, repeated actions sharing those accounts may be underdetermined
even when the event totals reconcile with the transaction net. This is a
capability limit, not a claim that every Pump.fun sell uses direct mutation.
Report `UNAVAILABLE` or `AMBIGUOUS` for the affected field; never infer a
partition from event values. A verified transaction success does not require
inventing a special catchable-CPI failure case: ordinary CPI execution errors
propagate under [Agave's CPI implementation](https://github.com/anza-xyz/agave/blob/v3.1.8/program-runtime/src/cpi.rs).

## Decision and alternatives

Keep the current strict 0/16 parser and quarantine 24 until the evidence gate
below is satisfied. Do not make a generic trailing-byte tolerance, infer a
third `u64`, copy a third-party layout, or weaken canary gates.

Three approaches were considered:

1. Reject 24 indefinitely: safe but leaves the observed Mainnet population
   quarantined.
2. Validate a narrowly attested 24-byte variant and then specify its decoder:
   preferred only if an authoritative full-suffix schema establishes every
   field and constraint, or a separately specified, explicitly value-bounded
   opaque profile proves each accepted value and all consumed business facts.
   Merely proving that earlier fields remain valid is insufficient.
3. Accept whatever an SDK coder returns despite trailing bytes: rejected,
   because partial Borsh consumption does not authenticate the residual data.

This document is an evidence-stage design, not approval to activate option 2.

## Evidence collection boundary

An owner-only, observe-only collector may select at most 12 finalized
representatives from the canary attribution in memory, in at most three
windows of four. It may make at most 24 standard `getTransaction` calls (one
per sample per provider), with no retries, an 8-second timeout per call and
a 240-second total wall-clock limit. It must never open a
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
- mint, participant and direction independently consistent with the action;
  distinguish event amount, independently verified scoped transfer legs and
  transaction-net reconciliation per field. Unavailable or ambiguous movement
  attribution is not a match and cannot be filled from the event amount;
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
byte equality across RPCs. A follow-up revision must identify an authoritative
schema decoding the **entire** suffix with validated type/range constraints,
or define an explicitly value-bounded opaque profile backed by independently
verifiable on-chain invariants for **every** business field consumed by
qualification or paper trading. The authoritative-schema path must still
state which financial fields are event-attributed versus independently
transfer-verified; it cannot claim transfer proof where the chain metadata
does not provide it. The opaque path cannot accept a field whose exact
movements are ambiguous or unavailable. A length check plus an
eight-byte skip, unrestricted opaque value, or historical sample frequency is
not sufficient. If this cannot be established, maintain quarantine and report
#215 as externally blocked on protocol evidence.

If established, add a RED fixture with sanitized finalized data first. The
GREEN parser must accept exactly the newly proven variant, preserve 0/16,
reject all other lengths and malformed prefixes, and test worker and catch-up
pairing, idempotence, finality and orphan reconciliation. Financial rules,
wallets, execution and the 19 canary gates remain unchanged. One review cycle,
full CI, then a new 15-minute observe-only canary are required before any
readiness or live-trade gate can advance.
