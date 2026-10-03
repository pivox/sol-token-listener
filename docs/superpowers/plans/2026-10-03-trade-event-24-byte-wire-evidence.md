# Pump.fun TradeEvent 24-byte suffix — evidence plan v1.2.1

Base: `main@ced66e7086911265012897a34239a59371204878`.
Issue: #215. Design: `../specs/2026-10-03-trade-event-24-byte-wire-evidence-design.md` v1.4.1.
This plan does not authorize accepting a new wire variant, weakening quarantine,
using a wallet, or submitting a transaction.

## Task 1 — pin authoritative sources

Record the Pump.fun public IDL commit and official SDK release used for the
comparison. Confirm the exact `TradeEvent` discriminator, field order, and
documented legacy suffix lengths from those sources. Keep source URLs and
versions in the spec, not copied third-party discriminators. A published IDL
that ends at 16 bytes leaves the additional 8 bytes unexplained; do not infer a
field from its length alone.

## Task 2 — build a bounded, owner-only evidence collector

Before implementation, add offline RED tests for selection of distinct
finalized representatives, two independent RPC responses, instruction/event
pairing, exact payload consumption, provider disagreement, orphaning, missing
forms, malformed payloads, and aggregate-only output. The collector reads only
owner-only canary attribution and finalized public chain transactions; it
must not accept wallet inputs or write raw transactions, signatures, addresses,
URLs, credentials, free-form errors, or payload bytes. Use integer quantities.
Bound it to 12 samples, three windows, 24 RPC calls, 8 seconds per call and
240 seconds total, with no retries; discard raw data after each check. The
output is a versioned aggregate with a four-hour maximum retention.

## Task 3 — run a controlled observe-only comparison

Require two genuinely independent RPC paths; an alias of the same endpoint is
not independent evidence. Validate slot, transaction bytes, program, CPI
location, event discriminator and known-prefix parse on both paths. Pair each
event with its own Pump.fun instruction and separately classify event amounts,
explicit scoped transfer legs and transaction-net reconciliation. Require
complete scope and metadata; mark each movement field `UNAVAILABLE` or
`AMBIGUOUS` when direct native-SOL mutation or repeated actions prevent exact
attribution. Never reuse a transaction-global delta for multiple instructions. Capture
distinct finalized slots and buy/sell forms where present. Record only
pass/fail/inconclusive counts by bounded instruction family and variant length.
If two paths or exact pairing are unavailable, report compatibility
`INCONCLUSIVE` and stop. Movement fields without exact attribution remain
inconclusive and cannot support an opaque suffix profile. Wire-shape matches
alone are not a PASS.

## Task 4 — decoder decision gate

Review an authoritative full-suffix schema or an explicitly value-bounded
opaque profile backed by independently verifiable on-chain invariants for
every consumed business field. State separately which amounts are only
event-attributed and which have independently verified movement legs. The
known-prefix parse plus eight-byte skip never suffices. If no proof establishes
the complete accepted-value boundary, consumed business fields and suffix
compatibility, keep 24-byte events in strict quarantine and mark #215
externally blocked. If proof exists, revise the
versioned design first, add sanitized finalized RED fixtures, then implement
only the exact proven variant. Preserve 0/16 behavior and reject other
lengths. Verify multi-instruction pairing, duplicate elimination, commitment
promotion and orphan reconciliation.

## Task 5 — delivery and rollout

Run build, check, lint, docs, focused tests and full CI. One independent code
review cycle, then merge only with green checks and no blocking findings.
Post-merge, run a new 15-minute observe-only Mainnet canary; the old FAIL
verdict remains FAIL and none of the H2e/H2c/wallet/trade gates are bypassed.
