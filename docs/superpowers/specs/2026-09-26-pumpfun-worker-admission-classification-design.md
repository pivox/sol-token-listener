# Pump.fun Worker Admission and Classification

Date: 2026-09-26

Issue: #176 (part B of #171)

Status: approved for implementation

Contract revision: 1.0.0

## Purpose

The Mainnet observe-only canary showed that durable discovery outpaced worker
processing by an order of magnitude. Part A, delivered by #173/#174, added the
strict monotone `worker_admitted_at` evidence and preparatory indexes without
changing production behavior. This part B makes that admission boundary
executable for Pump.fun classification while keeping it disabled by default.

Part B does not introduce the 45-second business authority or demotion. Those
belong to #177. Consequently, enabling the flag in a Mainnet canary after B
alone is prohibited.

## Selected approach

Keep the legacy path and the bounded path explicit:

- flag absent or false uses the existing SQL and behavior;
- flag true classifies WebSocket evidence before admitting it, admits only
  canonical launches and trades already covered by the current tracked-mint
  authority, and makes claims conditional on durable admission;
- ambiguous Pump.fun notifications remain durable and visible but cannot be
  claimed until strict catch-up provides canonical classification;
- strict catch-up promotes a row at most once and reports the admission
  transition from `worker_admitted_at IS NULL` to non-null truthfully.

No new migration is required. Migration 053 already permits the intended
`PENDING`/null classification state and enforces the worker-evidence fence.

## Configuration contract

`LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED` remains a strict,
restart-only boolean and defaults to `false`. Part B removes the unconditional
activation rejection and constructs a frozen V1 policy with either boolean.

Enabled admission requires the existing strict classifier path:

```text
LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=true
EXECUTION_MODE=observe
LISTENER_INGESTION_SCOPE=launchpad-only
LISTENER_CATCH_UP_POLICY=live-edge
LISTENER_BLOCK_HYDRATION_ENABLED=true
SOLANA_EXPECTED_GENESIS_HASH=<canonical cluster hash>
```

The existing catch-up parser owns the detailed validation of those dependent
settings. Bounded admission adds one stable fail-closed dependency error when
the page classifier is not enabled. The tracking-window value stays parsed and
persisted in the policy but is not consumed until #177.

Deployment examples and Compose keep the bounded flag false. No environment
file may imply that B alone is canary-ready.

## Domain policy

`PumpFunWorkerAdmissionPolicyV1.enabled` becomes `boolean`. Construction still
requires an exact boolean, a safe integer window in `1..3600`, and returns a
plain frozen value. The domain module remains free of repository, clock, RPC,
wallet and executor dependencies.

The policy is injected into `PostgresTransactionInboxRepository` as an optional
third constructor argument. Omission constructs the disabled policy so existing
tests and non-production consumers preserve legacy behavior.

## WebSocket classification

Both WebSocket ingress implementations must produce the same immutable hints:

- Pump.fun logs containing one unambiguous canonical create instruction:
  `PUMPFUN_CREATE`, no mint hint;
- Pump.fun logs containing one unambiguous canonical trade event:
  `PUMPFUN_TRADE` and its canonical mint;
- truncated, conflicting, vetoed, malformed or otherwise ambiguous evidence:
  no trusted hint;
- PumpSwap notifications: no Pump.fun hint.

`openWsProgramSession` already uses `pumpFunWebSocketHintFromLogs`. The direct
`SolanaProgramSubscriber` path must reach parity by using the same helper and
the same veto program IDs rather than implementing another decoder.

Hints are preparation evidence, not a substitute for catch-up classification.
Contradictory reliable evidence must fail closed instead of silently replacing
a terminal durable classification.

## Admission table in enabled mode

| Source evidence | Durable status | Priority | Admission |
| --- | --- | --- | --- |
| canonical Pump.fun CREATE | `PENDING` | `LAUNCH_CANDIDATE` | immediate |
| canonical Pump.fun TRADE for currently tracked mint | `PENDING` | `TRACKED_TRADE` | immediate |
| canonical Pump.fun TRADE outside current tracked authority | `DEFERRED` | `NORMAL` | null |
| absent or ambiguous hint | `PENDING` | `NORMAL` | null |
| catch-up terminal ignored/quarantined/deferred | terminal decision | decision priority | null |

A CREATE remains immediately admitted even when the same transaction also
contains an initial buy. Classification is transaction-level and downstream
decoding remains responsible for emitting every external and inner instruction.

The current tracked-mint authority is deliberately reused in B. It is replaced
by the bounded multi-table authority only in #177.

## Claim boundary

When the policy is disabled, the existing three claim selections, fairness and
ordering remain byte-for-byte unchanged.

When enabled, each claim selection adds exactly:

```sql
worker_admitted_at IS NOT NULL
```

The 32:1 urgent scheduler, 3:1 launch/tracked scheduler, retry order and row
locking remain unchanged. A non-admitted row cannot acquire a lease, consume an
attempt, store a normalized snapshot, or become processed/failed; migration 053
continues to enforce this invariant at the database boundary.

## Catch-up promotion and receipts

Catch-up classification is monotone and replay-safe:

- a previously ambiguous WebSocket `PENDING/NORMAL/NULL` row may become
  actionable without changing from `PENDING`;
- `catchUpEnqueued` is therefore based on the durable admission transition
  `NULL -> non-null`, not only on `DEFERRED -> PENDING`;
- `catchUpAdmissionPriority` is set only for that first transition;
- replay preserves the original admission timestamp and receipt;
- an existing terminal ignored, quarantined or deferred decision cannot be
  promoted by contradictory evidence;
- finality reconciliation remains independent from admission and supports both
  WebSocket-first and catch-up-first ordering.

Admission uses the repository classification clock already persisted as
`catch_up_classified_at`; it never rewrites `observed_at` or
`first_detected_at`. Retention remains `terminal_at + 4 hours`.

## Composition boundary

The production factory creates one frozen policy and passes it to the one inbox
repository instance. It does not add a worker, timer, queue, RPC call, cache,
wallet authority, signer or submission path. PumpSwap remains on the legacy
path because enabled mode requires `launchpad-only` ingestion.

## Validation

Tests must prove:

- disabled domain/config/repository behavior is unchanged;
- enabled config requires the strict catch-up classifier and all its existing
  safe dependencies;
- direct and production WebSocket paths agree on CREATE, TRADE and ambiguity;
- enabled admission implements every row in the table above;
- ambiguous rows survive replay/restart but never become claimable early;
- the three claim branches filter admission without changing fairness/order;
- catch-up records exactly one null-to-non-null promotion and truthful receipt;
- conflicting terminal classifications fail closed;
- processed/confirmed/finalized/orphaned sequences work in both ingress orders;
- first detection, four-hour retention and idempotence remain unchanged;
- no wallet, executor, RPC budget, block-cache or transaction-submission source
  changes.

## Acceptance criteria

- flag absent or false preserves the exact legacy path;
- flag true is technically executable only with strict page classification;
- canonical CREATE is immediately claimable;
- a reliable tracked TRADE is claimable and an untracked TRADE is deferred;
- an ambiguous notification is durable and never claimable before catch-up;
- classification admission and receipt occur exactly once across replay and
  restart;
- all build, check, lint, docs, PostgreSQL, frontend and deployment gates pass;
- no Mainnet activation, wallet use, signature or order occurs in this PR.

## Delivery boundary

#177 adds the 45-second multi-table tracking authority, pristine demotion,
`workerAdmission.v1`, API/frontend diagnostics and canary contract. The bounded
flag must remain false in operational environments until #177 is merged and its
post-merge CI is green.
