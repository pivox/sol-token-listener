# First-Processing Canary Evidence Design

Version: 1.1.2 — 2026-09-24 — issues #143 and #153

Status: approved for implementation under the standing operator instruction

Issue: #153, correction post-canary de #143, part 2 of #140

## Goal

Make the 15-minute Mainnet observe-only canary able to prove the latency from
durable worker-eligible transaction detection to the first successful business processing.
The proof must be immutable, bounded, aggregate-only, durable through the
listener heartbeat, and backward-compatible with historical data.

This change measures the observation pipeline only. It does not change
admission, RPC pacing, qualification, paper decisions, wallet handling,
transaction construction, signing, arming, or submission.

## Problem

`chain_transaction_inbox.processed_at` records the latest successful processing
cycle. Finality replay, orphan reconciliation, retry, and manual recovery may
clear or replace it deliberately. Consequently, `processed_at - observed_at`
cannot prove first-processing latency.

Historical rows also cannot be reconstructed truthfully: no existing timestamp
proves when their first successful business-processing transaction committed.
A migration must therefore leave them unavailable instead of backfilling a
reassuring but invented value.

## Considered approaches

### Reuse `processed_at`

Rejected. Its mutable replay semantics are correct for finality scheduling but
wrong for first-success evidence.

### Backfill from `processed_at` or `updated_at`

Rejected. Either timestamp may describe a later replay or administrative
operation. A backfill would create false evidence.

### Store every latency sample in heartbeat JSON

Rejected. It is unbounded, high-cardinality, and would expose transaction-level
timing. The public contract needs aggregates only.

### Persist one immutable timestamp and aggregate a fixed canary cohort

Selected. PostgreSQL owns the timestamp and its immutability. A fixed-duration,
fixed-capacity cohort produces one versioned aggregate with no signature, mint,
or arbitrary label.

## Durable first-success timestamp

Migration `050_transaction_inbox_first_processing.sql` adds nullable
`first_detected_at TIMESTAMPTZ`, nullable `first_processed_at TIMESTAMPTZ`, and
`first_processing_evidence_unavailable BOOLEAN NOT NULL DEFAULT FALSE` to
`chain_transaction_inbox`. It does not invent a timestamp. Rows that can be
already present when the migration starts are all marked unavailable, because
any one of them may have completed and then been reopened before migration.
Their two new timestamps remain `NULL`.

After that one-time classification, `first_detected_at` receives a
millisecond-precision PostgreSQL default for new inserts. The first successful
`INSERT` therefore captures durable detection using the same database clock as
processing. Duplicate enqueue/upsert paths never replace it. This avoids a
false PASS caused by comparing the process clock used by `observed_at` with the
database clock used by processing.

`markProcessed` obtains one millisecond PostgreSQL timestamp inside the same
statement that commits successful processing:

```sql
WITH completed AS MATERIALIZED (
  SELECT date_trunc('milliseconds', clock_timestamp()) AS completed_at
)
...
first_processed_at = CASE
  WHEN first_processing_evidence_unavailable THEN NULL
  ELSE COALESCE(first_processed_at, completed.completed_at)
END
```

Because another update in the same millisecond may already have retained
microsecond precision in `updated_at`, completion uses
`updated_at = GREATEST(updated_at, completed_at)`. The evidence timestamps stay
millisecond-precise while the general row clock never regresses.

The first successful call therefore records the database time atomically. A
lease failure records nothing. Later success, retry, replay, finality,
orphaning, and manual recovery preserve the original timestamp.

PostgreSQL enforces:

- finite millisecond precision for both evidence timestamps;
- no replacement or clearing of `first_detected_at` after insert;
- `NULL -> timestamp` at most once;
- no replacement and no clearing of an existing value.

A `BEFORE UPDATE ON chain_transaction_inbox` trigger raises a stable
check-violation error when an update would change or erase either evidence
timestamp or clear the unavailable marker. It permits the processing timestamp only
during the leased `PROCESSING -> PROCESSED` transition, with the old lease
present, the new lease cleared, and
`first_processed_at = processed_at`, and never when the historical-unavailable
marker is set. If an older rolling-deployment binary performs that success
transition without supplying the timestamp, the trigger atomically sets the
unavailable marker instead of fabricating evidence. The marker is monotonic and
cannot be cleared. The trigger raises SQLSTATE `23514`. The migration is
replayable and fails closed when an existing column, constraint, function,
trigger, or index has an incompatible definition. Historical rows remain
`NULL` through retry, replay, finality, orphaning, and manual recovery.
The canonical timestamp column definition is unbounded `TIMESTAMPTZ`
(`pg_attribute.atttypmod = -1`); a replay rejects precision-bearing variants
such as `TIMESTAMPTZ(0)` even though they share the same type OID.

`observed_at` remains the original notification time for compatibility and
ordering semantics. Canary membership and latency use only
`first_detected_at` and `first_processed_at`. Both timestamps are immutable,
finite, millisecond-precision PostgreSQL values. Any impossible negative or
non-integer aggregate duration is still classified as invalid and cannot pass.

The two timestamps and unavailable marker are part of the inbox row and follow
its existing four-hour deletion. No separate identifying evidence table or
retention path is introduced.
The shared inbox purge still selects through the existing `purge_after` index,
then applies a residual safety bound: a post-migration row with a non-null
`first_detected_at` is not deleted before `first_detected_at + 4 hours`.
This prevents a caller-supplied classification time earlier than durable
detection from shortening canary evidence. Legacy rows whose
`first_detected_at` is `NULL` keep their prior `purge_after` behavior.

## Bounded cohort

The domain contract is `RuntimeFirstProcessingCanaryEvidenceV1`. The heartbeat
obtains a database-clock cohort start once during startup. The cohort accepts
durable detections for at most 15 minutes and each aggregate query obtains its
sample time from that same database clock. Rows are ordered by
`first_detected_at, signature` and capped at 50,000 plus one overflow probe.
The signature is used only inside PostgreSQL and is never returned. An
overflowed cohort is incomplete and cannot pass.

The half-open inclusion interval is:

```text
[cohortStartedAt, min(sampledAt, cohortStartedAt + 15 minutes))
```

This excludes historical rows and makes all heartbeat snapshots for one
process converge on the same final cohort. The query returns one aggregate row;
it never returns per-transaction evidence to the application.

The cohort measures worker processing, not successful catch-up classification
that deliberately decides no worker admission is required. Before ordering and
applying the capacity bound, it therefore excludes only exact, coherent,
version-1 classification-only rows that remain non-admitted:

- `IGNORED / SOLANA_TRANSACTION_FAILED` with `catch_up_enqueued=false`;
- `IGNORED / NO_SUPPORTED_PUMP_ACTION` with `catch_up_enqueued=false`;
- `DEFERRED / PUMP_TRADE_UNTRACKED` with `catch_up_enqueued=false`.

The stored processing status, disposition and reason must all match the listed
combination. The receipt must come exclusively from `CATCH_UP`; any row also
observed through `WEBSOCKET` remains eligible because its prior worker
admission cannot be disproved. All version-1 receipt fields must form the exact
coherent shape already enforced for catch-up classification: action key, mints,
ingestion hint and optional mint, evidence fingerprint, classification time,
terminal time and purge deadline. Exclusion also requires positive proof that
the row has never been worker-admitted or processed: zero lifetime and cycle
attempts, no current or historical lease, snapshot, immutable fingerprint,
processing timestamp, first-processing timestamp, recovery, retry, error or
finality evidence, `first_processing_evidence_unavailable=false`, and no
catch-up admission priority. These conditions mirror and strengthen the
repository's pristine-row invariant. Any partial, unknown or contradictory
combination remains eligible and fail-closed. `QUARANTINED` always remains
eligible and terminal. A deferred row promoted through `syncTrackedMint()` to
`PENDING`, `PROCESSING` or `PROCESSED` becomes eligible even though its
immutable historical `catch_up_enqueued=false` receipt remains, so its original
immutable detection timestamp continues to measure the full wait before worker
processing.

The SQL exclusion predicate is total under PostgreSQL three-valued logic:
`NULL` or any unknown value never satisfies an exclusion. The query must use a
null-safe exact predicate (for example `NOT COALESCE(exact_match, FALSE)`) so a
legacy or malformed partial classification remains inside the fail-closed
cohort.

This is a correction to the intended V1 population, not a JSON schema change:
the aggregate keys, `version: 1`, arithmetic invariants and public projection
remain unchanged.

The version-1 aggregate contains only fixed fields:

```ts
interface RuntimeFirstProcessingCanaryEvidenceV1 {
  version: 1;
  thresholdMs: 45_000;
  cohortCapacity: 50_000;
  cohortStartedAtMs: number;
  cohortEndsAtMs: number;
  sampledAtMs: number;
  overflowed: boolean;
  eligibleCount: number;
  completedCount: number;
  underThresholdCount: number;
  atOrAboveThresholdCount: number;
  pendingCount: number;
  rightCensoredCount: number;
  tailCensoredCount: number;
  terminalCount: number;
  unavailableCount: number;
  invalidDurationCount: number;
  p95Ms: number | null;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
}
```

All counts and durations are non-negative safe integers. The percentile is the
nearest-rank p95 of completed, valid integer-millisecond durations. A duration
of 44,999 ms belongs to `underThresholdCount`; 45,000 ms belongs to
`atOrAboveThresholdCount`.

After the exact non-admitted classification-only exclusions above, categories
use this ordered, mutually exclusive decision table:

1. invalid: a present timestamp yields a negative or non-integer duration;
2. completed: a present timestamp yields a valid integer duration;
3. unavailable: the historical-unavailable marker is set and the timestamp is
   `NULL`;
4. terminal: no timestamp and `terminal_at` is present, or the status is
   `IGNORED`/`QUARANTINED`, or it is a non-retryable/exhausted `FAILED` row;
5. right-censored: no timestamp, no terminal condition, and less than 45
   seconds of observation;
6. tail-censored: no timestamp, no terminal condition, and at least 45 seconds
   of observation, but the row may still complete.

`pendingCount` is exactly the sum of right- and tail-censored counts.
`completedCount` is exactly the sum of the two threshold buckets. The fixed
capacity, interval, these equalities, and the exhaustive equality
`eligibleCount = completedCount + pendingCount + terminalCount +
unavailableCount + invalidDurationCount` are validated at every boundary.

## Verdict semantics

The latency proof is fail closed:

- `FAIL` when valid completed samples produce `p95Ms >= 45_000`, or when an
  invalid duration is detected;
- `INCONCLUSIVE` while the cohort window is open, until the 45-second drain has
  elapsed, when the cohort is empty or overflowed, or when any censored,
  terminal, or unavailable row remains, and from
  `cohortStartedAtMs + 14_400_000` inclusive because this is the first instant
  at which four-hour inbox retention can have partially removed the cohort;
- `PASS` only after `cohortEndsAtMs + 45_000`, with at least one completed
  sample, no incomplete category, no overflow, and `p95Ms < 45_000`.

All deadline additions are checked as safe integers. `FAIL` evidence takes
precedence over incompleteness, including after the retention deadline. Missing or malformed
evidence is projected as unavailable and never synthesized as a passing zero.

## Runtime, persistence, and public projection

`TransactionInboxRepository` gains a startup method that returns a
millisecond-precision database time and a read method that returns the
aggregate for that fixed cohort start while obtaining `sampledAtMs` inside the
same PostgreSQL statement. `PersistentListenerHeartbeat` initializes the
cohort before its first write, reads it beside the existing inbox counts and
RPC slots, snapshots it into `RuntimeHeartbeat`, and persists it in
`listener_heartbeats.payload` as `firstProcessingCanary`.

The metric is optional inside the runtime heartbeat for rolling compatibility.
The production listener supplies it on every `RUNNING` and final `STOPPED`
heartbeat. Any production aggregate error or malformed result aborts that
heartbeat write; omission is reserved for an older binary or historical
payload. A legacy heartbeat without the field remains valid.

`GET /api/v1/health` exposes the same fixed aggregate as
`heartbeat.firstProcessingCanary`. Historical or legacy absence becomes
`null`; it never becomes an object filled with zeros. Strict decoders reject
extra fields, inconsistent totals, unsafe integers, invalid time ordering, or
an impossible verdict.

The diagnostic frontend displays the verdict, p95, cohort counts, overflow,
and drain state. It does not display or receive signatures, mints, URLs, wallet
addresses, or any other high-cardinality value.

## Canary operation

The operator restarts one `launchpad-only`, `observe` replica and captures T0,
T+5, and T+15 health snapshots with the same `startedAt` and
`cohortStartedAtMs`. At T+15, new
admission is stopped or the fixed cohort naturally closes. The operator waits
at least 45 seconds before bounded application shutdown, then extracts the
persisted `STOPPED` heartbeat from PostgreSQL.

The final latency gate requires `firstProcessingCanary.verdict=PASS`. A restart,
missing final heartbeat, absent or malformed evidence, overflow, empty cohort,
or any censored category is `INCONCLUSIVE`. A changed `startedAt` or cohort
start between any two samples proves a restart and makes the whole window
`INCONCLUSIVE`, even if the replacement process later emits an internally
passing cohort. The final stopped heartbeat must be newer than T+15 and carry
the same cohort. `FAIL` remains blocking. The HTTP 429 evidence from #142 and
all other backlog, RSS, finality, idempotence, and retention gates remain
independent requirements.

The fixed cohort interval means traffic after minute 15 cannot move the final
p95. The 45-second drain gives every included row the full threshold window
without requiring wallet access or transaction submission.

## Migration and rollout

Migration 050 is forward-only and must pass on an empty schema and replay
cleanly. It updates the migration head used by execution startup validators and
their tests, but grants no new live-execution authority. During rolling deploy,
old code ignores the new column and new code treats old heartbeat payloads as
unavailable.

Rollback is application-only: deploy the prior binary, which ignores the
nullable column. The column and its immutable evidence remain until a later
planned migration; they are not destructively removed to hide a failed canary.

## Tests

Tests must prove:

- migration 050 applies on empty and populated schemas and replays cleanly;
- historical rows remain `NULL`;
- first success writes once with the same database timestamp as that cycle;
- lease loss writes no timestamp;
- retry, replay, finality, orphaning, and manual recovery preserve it;
- direct replacement or clearing is rejected by PostgreSQL;
- normal four-hour inbox retention still deletes the whole row;
- post-migration deletion waits four hours from durable `first_detected_at`,
  while legacy `NULL` evidence retains its prior deletion behavior;
- a partially purged cohort is `INCONCLUSIVE` from its first possible purge
  instant and cannot recover a misleading `PASS`;
- the cohort excludes pre-start and post-window rows and caps at 50,000;
- exact non-admitted `IGNORED/SOLANA_TRANSACTION_FAILED`,
  `IGNORED/NO_SUPPORTED_PUMP_ACTION` and
  `DEFERRED/PUMP_TRADE_UNTRACKED` classifications do not enter the cohort;
- quarantine, malformed classification combinations and genuine worker
  terminal failures remain eligible and blocking;
- a deferred classification promoted through the real `syncTrackedMint()` and
  claim/processing path becomes eligible with its original `first_detected_at`,
  while contradictory rows with any worker-history trace remain fail-closed;
- 44,999 and 45,000 ms fall into different buckets;
- nearest-rank p95 works for one-row and other small samples;
- right-censored, tail-censored, terminal, unavailable, invalid, empty, and
  overflowed cohorts cannot pass;
- runtime persistence snapshots caller data and legacy payloads remain valid;
- API and frontend reject inconsistent or high-cardinality fields;
- the final stopped heartbeat retains the aggregate without a wallet or live
  executor dependency;
- the runbook requires the 45-second drain and classifies all three verdicts.

## Acceptance

- first-success evidence is atomic, immutable, and never backfilled;
- the public cohort is time-bounded, capacity-bounded, aggregate-only, and
  retained only through existing four-hour evidence paths;
- p95 is an integer millisecond value and the 45-second boundary is exact;
- censored, absent, historical, malformed, or overflowed evidence cannot pass;
- heartbeat, API, and frontend changes are additive and rolling-compatible;
- no secret or transaction identifier is exposed;
- no signing, submission, wallet, execution-mode, or trading behavior changes.
