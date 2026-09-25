# Transaction Inbox Urgent Fairness Design

Version: 1.0.0 — 2026-09-25 — issue #165

Status: approved under the standing operator instruction

## Goal

Bound launch and tracked-trade scheduling independently from the existing
urgent-to-normal fairness fence. Reduce launch detection latency without
starving tracked observations that may be needed for monitoring or exit.

This change does not add workers, increase HTTP or RPC concurrency, alter
admission, or touch wallet, signing, arming or submission.

## Durable policy

The existing urgent-to-normal ratio remains exactly 32:1. Inside the urgent
budget, `LAUNCH_CANDIDATE` and `TRACKED_TRADE` use a durable 3:1 ratio. With all
three queues continuously ready, the exact cycle is:

```text
L L L T  L L L T  L L L T  L L L T
L L L T  L L L T  L L L T  L L L T  N
```

That is 24 launches, 8 tracked trades, then one normal claim. A ready,
unlocked tracked trade waits behind at most three launch claims.

The scheduler singleton gains `launch_claims_since_tracked SMALLINT NOT NULL
DEFAULT 0`, constrained to 0..3. Launch claims increment it with saturation;
tracked claims reset it to zero; normal claims leave it unchanged. Keeping the
value across a normal claim prevents normal fairness from gifting launches a
new internal burst.

## Claim algorithm

The scheduler row is locked before candidate selection, as today.

1. At 32 urgent claims, try one `NORMAL` candidate.
2. Otherwise, or if no normal candidate is claimable, choose an urgent order:
   - counter 0..2: try launch, then tracked;
   - counter 3: try tracked, then launch.
3. If neither urgent class is claimable, try normal.
4. Update the selected inbox row and both scheduler counters atomically.

Each class-specific selection is static SQL with the same actionable predicate,
`ORDER BY observed_slot, signature`, `FOR UPDATE SKIP LOCKED`, and `LIMIT 1`.
No priority value is interpolated into SQL. If a preferred row is locked, the
fallback class advances. A saturated counter remains saturated after a launch
fallback, so a tracked trade becomes preferred immediately when available.

## Migration 052

`052_transaction_inbox_urgent_fairness.sql` accepts only an exact 051 scheduler
or an exact fully installed 052 scheduler. Partial columns, altered defaults,
weakened checks, extra singleton rows or incompatible indexes fail closed.

The migration:

- locks inbox then scheduler in the historical order;
- preserves `consecutive_urgent_claims` and initializes the new counter to 0;
- installs the exact 0..3 check;
- preserves the historical global urgent index for rolling compatibility;
- adds `chain_transaction_inbox_priority_claim_order_idx` on
  `(ingestion_priority, observed_slot, signature)` using the existing actionable
  partial predicate;
- replays without changing data or index identity.

The listener writer role receives SELECT plus UPDATE authority for both counters
and `updated_at`. No executor role receives broader authority.

## Failure and concurrency semantics

The scheduler lock serializes elections across repository instances. Inbox
selection still uses `SKIP LOCKED`; the inbox update and counter update share
one transaction, so rollback restores both. Retry and expired-lease candidates
retain their stored priority. Exhausted candidates are terminalized before
selection and consume no fairness turn. `DEFERRED` remains non-claimable.

This policy bounds class access, not end-to-end throughput. A separate issue
#166 introduces a bounded worker pool while retaining one provider-affine HTTP
flow.

## Acceptance

- clean, upgrade and replay migration tests on PostgreSQL 16;
- exact catalog drift rejection and indexed query plans for all three classes;
- 24 launch, 8 tracked and 1 normal claims under saturated queues;
- fallback, return-after-saturation, restart, rollback and concurrency tests;
- unchanged finality, retry, retention, first-processing and deferred behavior;
- build, check, lint, docs, backend and frontend suites green;
- no wallet, signer, arming, submission or RPC-concurrency change.
