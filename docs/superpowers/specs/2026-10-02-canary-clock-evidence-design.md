# Comparable canary clock evidence — v1.0.0

## Scope and authority

Narrow correction for #140 after #211, using the existing durable first-processing
and worker-admission collectors. Standing user approval covers recommended
technical decisions; one review cycle per PR. Version this design before code.
No new service, migration, timer, RPC request, wallet access or execution change.

The stopped canary recorded heartbeat startup 1790894504592 and cohort startup
1790894504593. The factory samples Date.now independently of PostgreSQL's cohort
clock. Exact equality correctly rejects that evidence. The same run's durable
p95 of 403088 ms is a real FAIL and remains unchanged.

Stopped claimability was 576 versus 577 in later independent SQL, with legacy
backlog 14790 unchanged. Time-dependent retry, lease and mint-authority predicates
can change without writes. The particular row and cause are not proven. This
change makes future clock comparisons meaningful; it does not rewrite history.

## Alternatives

1. Recommended: one validated cohort anchor and additive clock sidecars. Preserve
   public metrics v1, exact comparisons and independent SQL verification.
2. Replace workerAdmission with v2: unnecessary breaking change against the API
   v1 additive contract, including consumers validating the exact nine fields.
3. Allow timestamp/count tolerances: hides genuine discrepancies and weakens
   gates; rejected. No observations reconstructed from unrelated timestamps.

## Canonical startup

In production-listener-factory.ts, assign startedAtMs exactly once from the
validated, cached beginFirstProcessingCanary promise. Both start() and write()
await that initialization. Remove the independent Date.now startup initializer.
Keep stop-before-start, concurrent start/stop fencing, dependency failures,
timeouts and rejection caching. Invalid initialization cannot publish a heartbeat.

updatedAtMs remains the actual Date.now observation. A future database anchor
must fail existing chronology validation, without clamping or tolerance.
The evaluator retains exact startup/cohort equality. First-processing latency
remains first_processed_at minus first_detected_at; no cohort or p95 change.

## Paired worker-admission sampling

Keep RuntimeWorkerAdmissionMetricsV1 and its exact nine-field shape unchanged.
Add optional heartbeat workerAdmissionClock with exact shape:

```ts
{ version: 1, sampledAtMs: number }
```

Produce metrics and this clock from the same SQL result and MATERIALIZED
database_clock, inside the existing REPEATABLE READ READ ONLY heartbeat snapshot.
A private paired helper may return both; public workerAdmissionMetrics() retains
its existing return type. No extra query to sample the clock separately.

For an empty inbox, return the timestamp through a scalar subquery from the clock
CTE, not MAX(clock.at) over an empty inbox cross join. Millisecond truncation and
all existing retry, lease, age and mint-authority predicates remain unchanged.

Standalone legacy metrics providers without a paired clock remain readable but
cannot fabricate a clock or attest the new comparison gate.

## Independent stopped proof

Add optional manifest postStopWorkerAdmissionClaimableProof:

```ts
{ version: 1, sampledAtMs: number, claimableBacklogCount: number }
```

Retain postStopWorkerAdmissionClaimableCount. For a conclusive successful worker
admission gate, require stopped metrics, historical scalar and proof counts to
agree exactly, and the proof timestamp to equal stopped workerAdmissionClock.
Independent SQL binds this recorded epoch as its clock and queries the actual
current database rows using unchanged durable eligibility predicates.

Capture after all scoped writers stop, before purge/teardown. The bound clock is
not time travel or a historical MVCC snapshot. Intervening relevant writes still
cause mismatches; equal counts alone do not prove row identity or absence of
offsetting mutations. Keep every other worker gate and contradiction check.

## Compatibility and validation

Retain mainnet-observe-canary-input.v1 and result v1. Extend optional named fields
in domain heartbeat, persistence, API contract/projection and manifest/snapshot
allowlists. Old absent sidecars/proofs parse, but worker evidence is INCONCLUSIVE,
never PASS. Present malformed evidence is invalid, not ignored or normalized.

Validate exact nested keys/version, safe integer representable dates, nonnegative
counts, chronology and paired evidence without invoking getters or proxy traps
unsafely. Reuse existing descriptor-based validation and frozen detached copies.
Errors stay redacted. Do not rebuild evidence from observation timestamps.

New readers accept old payloads; old strict binaries do not understand new
sidecars, so deploy compatible readers/writers together. Document this constraint.
No database schema migration is required for existing JSON heartbeat persistence.

## Implementation surfaces

- src/application/production-listener-factory.ts: startup and paired snapshots.
- src/domain/transaction-ingestion.ts: heartbeat contract and validation.
- src/domain/worker-admission-metrics.ts: preserve metrics; adjacent clock helper
  only if it keeps strict validation reusable without enlarging unrelated units.
- src/storage/transaction-inbox.repository.ts: paired query and heartbeat snapshot.
- src/api/contracts.ts and src/storage/api-projection.repository.ts: additive API.
- scripts/lib/mainnet-observe-canary-verdict.ts: parsing and exact paired proof.
- docs/api/v1.md and docs/operations/block-hydration-canary.md: contracts and SQL.
- Private .codex-mainnet-canary.mjs in the historical canary worktree: update
  explicit key lists, projection and parameterized capture before any future run;
  keep excluded from Git and do not execute it as part of this correction.

## Acceptance and TDD coverage

1. One-millisecond local/DB startup split: all RUNNING/STOPPED anchors equal DB;
   observation timestamps remain real. Invalid/future anchors fail closed.
2. Stop-before-start, unresolved initialization, repeated stop, timeout, rejected
   dependency and failed final evidence retain lifecycle guarantees.
3. Paired metrics/clock share one SQL sample and existing transaction; empty inbox
   yields a valid timestamp, rollback/release and detached values are tested.
4. PostgreSQL fixtures show retry/lease at t included, t+1 excluded; fresh launch
   authority valid at 44999 ms but not 45000; eligible_until=t is excluded.
   Later independent SQL bound to t reproduces counts without predicate changes.
5. Missing, malformed, unequal-clock or inconsistent-count evidence cannot PASS.
   Relevant writes after stopped capture remain detectable as mismatches.
6. Existing p95 failure, cohort censoring, backlog growth, partition, finality,
   idempotence, retention, RSS and RPC gates remain intact. Archived FAIL stays FAIL.
7. API accepts absent and valid optional evidence and rejects malformed evidence.
   Full build/check/lint/docs and PostgreSQL-backed tests pass before delivery.

This correction establishes comparable evidence, not capacity or sellability.
A new bounded observe-only canary and all later readiness gates remain necessary.
