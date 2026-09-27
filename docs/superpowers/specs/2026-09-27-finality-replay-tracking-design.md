# Finality replay tracking design

Status: approved by the observed Mainnet evidence and issue #191

Revision: 1.0.0

## Problem

The bounded worker tracking window is intentionally short. A Pump.fun trade can
be observed and persisted as `confirmed`, leave the 45 second tracking window,
and only then be replayed as `finalized`.

The transaction pipeline currently loads the globally tracked mints before it
loads the active events already attached to the transaction signature. The
Pump.fun adapter therefore filters out an expired mint during the finalized
replay. No launchpad batch is recorded, the persisted trade stays `confirmed`,
and the funding boundary correctly rejects the `confirmed` event paired with a
`finalized` transaction. Every retry follows the same path.

Three observe-only probes on `main@fd09601` isolated the failure. In the final
anonymized sample, all eight affected transactions succeeded on-chain, had one
unique trade, matched their slot, transaction index, timestamps and cursor, and
were outside the tracking window. The only mismatch was persisted `confirmed`
versus inbox target `finalized`.

## Decision

Before launchpad observation, the pipeline loads the active launchpad events
already persisted for the exact transaction signature. Their mints are united
with the globally tracked mints in a request-local immutable set. This union is
used only for decoding that transaction. The pipeline then keeps the existing
post-write reload as the authoritative context for funding and downstream
projections.

The pre-read and the global tracking read remain inside the existing
`load_tracked_mints` failure boundary. Both results cross the same bounded,
immutable validation boundary already used by the pipeline.

## Invariants

- The 45 second global tracking policy and its database authority are unchanged.
- A persisted mint is admitted only for replay of the exact same signature.
- No mint is added to global tracking and no worker admission row is mutated.
- The Pump.fun adapter must redetect the trade from the durable transaction
  snapshot. A database row is never promoted without decoder validation.
- The post-write reload remains mandatory and supplies funding, participant,
  wallet graph and qualification inputs.
- Funding keeps strict equality between transaction and event confirmation.
- Existing deterministic event IDs, finality reconciliation and orphan handling
  remain unchanged.
- No RPC, cache, wallet, signer, executor or transaction-submission code changes.

## Rejected alternatives

### Relax funding confirmation validation

Accepting `confirmed` evidence for a `finalized` transaction would let the
pipeline progress while leaving the source event and downstream projections at
the wrong finality. This hides the inconsistency instead of repairing it.

### Promote omitted events directly in PostgreSQL

Bulk promotion by signature would manufacture finality for events the adapter
did not redetect from the durable transaction snapshot. It also bypasses the
existing event fingerprint and payload conflict checks.

### Extend the global tracking window

A longer timeout only moves the race and increases the bounded workload. It
does not establish the exact-signature reconciliation invariant.

## Test strategy

1. Pipeline regression: global tracking is empty, the pre-read returns a frozen
   `confirmed` trade for the same signature, and the transaction is `finalized`.
   The launchpad observer must receive the persisted mint, the post-read must
   return `finalized`, and funding must succeed.
2. Scope regression: a mint absent from the exact signature is not added.
3. PostgreSQL integration: persist a confirmed launch/trade, age the launch past
   the tracking window, replay the durable transaction as finalized, and assert
   convergence of `raw_chain_events`, `domain_events`, `launch_trades` and the
   funding projection without duplicates.
4. Existing pipeline, ingestion recovery and launchpad repository suites remain
   green.

## Operational acceptance

After merge and green post-merge CI, rerun a short Mainnet observe-only probe.
The replay population must no longer produce this confirmation-mismatch
`FUNDING_OBSERVATION_VALIDATE` pattern. Only then may the exact 15 minute canary
resume.
