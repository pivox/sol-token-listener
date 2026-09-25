# Bounded Pump.fun Worker Admission Foundation

Date: 2026-09-25

Issue: #173 (part A of #171)

Status: approved for implementation

Contract revision: 1.0.0

## Purpose

The `main@32c9bf4` observe-only canary received about 61 signatures per second
while two workers completed about 2.45 rows per second. Actionable backlog grew
from 209 to 26,658 even though RPC evidence reported zero HTTP 429 responses.
Most of that final backlog was `TRACKED_TRADE` or `NORMAL`; only one row was a
launch candidate. This is an admission problem, not evidence that cache size or
RPC concurrency should be increased.

Issue #171 splits the correction into three independently mergeable changes.
This first change establishes the configuration and durable database contract
only. It must not change which rows the current worker claims, their ordering,
RPC/cache concurrency, listener behavior, or any wallet/executor path.

## Selected approach

Add an optional immutable `worker_admitted_at` timestamp to the existing
transaction inbox and expose a restart-only policy contract. Historical rows
that were claimable before this migration receive their original
`observed_at`; rows that were never claimable remain null. New and promoted
legacy rows keep the same distinction while the feature flag is off.

The alternate approaches were rejected:

- changing the claim predicate in this PR would activate an incomplete policy;
- accepting an enabled flag with no effect would create a dangerous false
  safety signal;
- deriving admission later from mutable status would lose the original
  admission time and make first-processing evidence ambiguous;
- reusing the paper-entry window would couple ingestion safety to a trading
  strategy setting.

## Configuration contract

Two restart-only values are added:

```dotenv
LISTENER_PUMPFUN_BOUNDED_WORKER_ADMISSION_ENABLED=false
LISTENER_PUMPFUN_TRACKING_WINDOW_SECONDS=45
```

The enable flag is a strict boolean and defaults to `false`. In part A, setting
it to `true` always throws one stable configuration error explaining that the
activation is not delivered until #171-B. No process may start while believing
the bounded policy is active when the runtime still uses legacy claims.

The tracking window is a canonical base-10 integer in `1..3600`, defaults to
45, and is validated even while the flag is off. Leading zeros, signs,
fractions, exponent notation, whitespace, and unsafe integers are rejected.
Part A exposes the validated value but does not consume it in listener logic.

## Domain contract

`src/domain/worker-admission.ts` owns the stable constants and constructs an
immutable policy value:

- schema version `pumpfun-worker-admission-policy.v1`;
- `enabled`, fixed to `false` in this delivery;
- `trackingWindowSeconds`;
- minimum `1`, default `45`, maximum `3600`.

The module contains no clock, repository, RPC, scanner, worker, wallet, or
execution dependency and makes no per-transaction admission decision.

## Migration 053

`053_transaction_inbox_worker_admission_foundation.sql` adds:

```sql
worker_admitted_at TIMESTAMPTZ NULL
```

There is no column default. On first install the exact legacy backfill is:

- `PENDING`, `PROCESSING`, `PROCESSED`, and `FAILED` receive `observed_at`;
- pristine `DEFERRED`, `IGNORED`, and `QUARANTINED` remain null.

This records the historical truth: actionable rows were admitted immediately.
It does not invent a new latency timestamp at migration time.

### Constraints and monotonicity

The timestamp must be finite. A null admission cannot coexist with worker
evidence: `PROCESSING`, `PROCESSED`, or `FAILED` status; a lease; positive
attempt counters; normalized snapshot or immutable fingerprint; processing,
retry, finality, or manual-recovery evidence. `PENDING NULL` is deliberately
allowed for ambiguous classification in #171-B. Existing terminal pristine
rows remain allowed and keep their existing four-hour purge contract.

A `BEFORE UPDATE` trigger permits exactly one transition from null to a finite
timestamp. A non-null value is immutable and cannot be cleared. The migration
verifies the column, constraints, function, trigger, and indexes exactly on
install and replay; partial or incompatible drift raises an error.

### Prepared indexes

Part A does not replace or edit the migration-052 claim index. It adds:

- `chain_transaction_inbox_worker_admitted_claim_idx` on
  `(ingestion_priority, observed_slot, signature)` for the existing actionable
  statuses with `worker_admitted_at IS NOT NULL`;
- `chain_transaction_inbox_worker_classification_pending_idx` on
  `(observed_at, observed_slot, signature)` for `PENDING` rows with a null
  admission.

These indexes are preparatory. Part B will switch claim/classification queries
behind the enabled flag.

## Repository compatibility while disabled

With the flag absent or false, behavior must remain byte-for-byte equivalent at
the claim boundary:

- newly enqueued legacy `PENDING` rows set `worker_admitted_at=observed_at`;
- catch-up rows that are immediately actionable are admitted at the same
  durable decision clock used by the repository;
- `DEFERRED -> PENDING` promotion sets the timestamp once with `COALESCE`;
- replay never changes an existing non-null admission;
- pristine deferred, ignored, and quarantined rows remain null;
- claim predicates, 32:1 urgent fairness, 3:1 launch/tracked fairness, worker
  count, RPC concurrency, and block cache are unchanged.

Admission time is never substituted for `observed_at`. First-processing latency
continues to start at first observation.

## Migration and deployment safety

Migration 053 supports a new database, an exact upgrade from 052, and immediate
replay. It must preserve existing data and reject schema drift. It contains no
delete, truncate, cascade, wallet data, or execution data mutation.

Adding/backfilling the column and building two ordinary indexes run inside the
current transactional migration runner and require a drained listener. The
supported rollout for part A is:

1. stop and drain the listener;
2. measure the inbox and apply migration 053;
3. deploy the new binary with the flag false;
4. verify the same claim order and counters;
5. restart observation.

Rolling an old binary against schema 053 is not supported. Using
`CREATE INDEX CONCURRENTLY` is also not supported by the current transaction
runner and is outside this PR.

## Validation

Tests must prove:

- configuration defaults, strict boolean behavior, canonical integer bounds,
  validation while disabled, and fail-closed rejection of `true`;
- domain immutability and exact constants;
- PostgreSQL 16 install, 052 upgrade, per-status backfill, every null/evidence
  contradiction, finite timestamp, monotonic transition, replay with stable
  object identities, strict drift rejection, and both index definitions;
- repository enqueue, catch-up actionability, promotion, replay, terminal
  pristine behavior, and unchanged 052 claim order/fairness while off;
- migration head/count/checksum, deployment examples, Compose passthrough,
  build, TypeScript, lint, docs, PostgreSQL tests, frontend tests, and deployment
  smoke.

## Acceptance criteria

- flag absent or false claims the same rows in the same order with the same
  counters as `main@a828964`;
- flag true cannot start the listener in part A;
- migration head is 053, replayable and drift-strict on empty and upgraded DBs;
- no row without admission can contain worker processing evidence;
- current launch detection remains immediate;
- finality, idempotence, restart recovery, and four-hour retention are
  unchanged;
- no source under wallet, signer, executor, RPC transport, block cache, or
  transaction submission changes.

## Delivery boundary

Part B will implement actual WebSocket/catch-up admission and classification.
Part C will implement the 45-second tracking authority, business extensions,
bounded demotion, heartbeat/API diagnostics, and the canary runbook. Neither is
implicitly authorized by this foundation.
