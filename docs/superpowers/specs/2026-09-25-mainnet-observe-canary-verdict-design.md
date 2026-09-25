# Mainnet Observe Canary Verdict V1

Date: 2026-09-25

Issue: #169

Status: approved for implementation

Contract revision: 1.1.0

## Purpose

The `main@32c9bf4` Mainnet observe-only run was a real failure: actionable
backlog grew from 209 to 26,658, first-processing p95 reached 739,483 ms, two
rows exhausted their retries, 190 rows were quarantined, and block hydration
reported two fetch failures plus 224 oversize bypasses. The run also exposed
four obsolete assertions in the local, unversioned harness. Those assertions
incorrectly rejected safe same-provider scan/worker sharing, ordinary cache
epoch fences, a finality incident recovered before T0, and a clean shutdown
that retained durable PostgreSQL backlog.

This change versions the verdict contract so future runs cannot silently drift
from the runtime semantics. It does not reclassify the `32c9bf4` run as a
success and does not change ingestion, RPC pacing, execution, signing, wallet
handling, or transaction submission.

## Considered approaches

### Patch the local harness only

This is the smallest edit, but the behavior would remain outside Git, untested,
and tied to one machine. A future run could regress without CI noticing.

### Commit the complete canary orchestrator

This would make Docker lifecycle and capture reproducible, but the current
orchestrator intentionally contains run-specific image identities, commit
identities, paths, and provider preparation. Generalizing all of that would
expand #169 into deployment automation.

### Version a pure evaluator and a redacted CLI

This is the selected approach. A pure module evaluates an exact, redacted V1
input. A CLI reads one JSON file and emits one JSON verdict. The machine-local
orchestrator remains outside Git and may create the redacted input for a future
run. The runbook defines the capture boundary and the evaluator is covered by
fixtures and unit tests.

## Components

### Pure evaluator

`scripts/lib/mainnet-observe-canary-verdict.ts` owns the closed V1 input and
output contracts and exports one evaluator. It accepts `unknown`, rejects
accessors, proxies, unexpected keys, unsafe integers, negative values,
inconsistent totals, missing snapshots, and non-monotone counters. Invalid or
incomplete evidence returns an `INCONCLUSIVE` gate; it never becomes an
implicit zero or `PASS`.

Every gate returns a versioned, detached JSON-safe object containing only its
verdict and bounded aggregate evidence. Overall precedence is:

1. any `FAIL` produces overall `FAIL`;
2. otherwise any `INCONCLUSIVE` produces overall `INCONCLUSIVE`;
3. only all `PASS` produces overall `PASS`.

The evaluator never reads the filesystem, environment, database, network,
wallet, or arbitrary callbacks.

### CLI

`scripts/evaluate-mainnet-observe-canary.ts` accepts exactly one input path,
reads bounded UTF-8 JSON, invokes the pure evaluator, and prints one canonical
JSON result. It exits `0` for overall `PASS`, `2` for overall `FAIL` or
`INCONCLUSIVE`, and `1` for malformed invocation or unreadable input. Errors
use fixed codes and never echo paths, JSON fragments, URLs, signatures, mints,
or exception messages.

The package exposes the development command
`npm run canary:evaluate -- <path>`. No compiled production listener command is
added because this evaluator is an operator diagnostic, not runtime authority.

### Redacted fixture

`tests/fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json` contains only the
aggregate evidence needed to reproduce the observed verdict. It contains no
RPC URL, host, key, signature, mint, full transaction, wallet address, or raw
log line.

## Gate contract

### Runtime

All required observation snapshots must belong to one process. Recovery status
and reason are related exactly: `NOT_REQUIRED` iff the reason is null. A final
snapshot with unresolved `RPC_UNAVAILABLE` or subscriber recovery is `FAIL`.
A periodic catch-up pause is `INCONCLUSIVE` only when a closed reason, provider,
timestamp, healthy transport, and exact degraded scanner state authenticate it;
generic degradation is `FAIL`. Malformed or missing state is `INCONCLUSIVE`;
it is never `PASS`.

### HTTP 429

Provider membership and configuration must remain stable, counters must be
monotone, evidence must not overflow, responses never exceed attempts, and an
unconfigured provider must remain at zero attempts and zero responses. A
positive 429 delta proved between adjacent observations of a common configured
provider is `FAIL` before zero-traffic or membership-drift classification.
Missing, malformed, reset, membership-changing, overflowed, or zero-traffic
evidence is otherwise `INCONCLUSIVE`; otherwise the gate is `PASS`.

### Backlog and first processing

Actionable backlog must be non-growing across T0, T+5, T+15, and final. The
first-processing evidence keeps the existing closed V1 semantics and the
45,000 ms failure boundary. Every snapshot plus `STOPPED` must carry the same
process start and cohort; sample times are strictly increasing through
`STOPPED`, after T+15/final and before the retention boundary. An internally
passing but old, restarted, or non-progressing cohort is `INCONCLUSIVE`.
Neither gate is weakened by #169.

### Terminal failures

The input includes baseline and final `failed`, `quarantined`, and `exhausted`
totals plus bounded groups by processing status and stable reason/error code.
Reason and error taxonomies are the exact enums persisted by classification
and ingestion. Groups reconcile `FAILED` and `QUARANTINED` deltas separately;
`exhausted` may never exceed `failed`. A positive exhausted delta is the
priority `FAIL`. Any other positive fully explained terminal delta is `FAIL`.
A positive terminal delta with absent, incomplete, null, unknown, or mismatched
grouping is `INCONCLUSIVE`. Counter resets and impossible totals are
`INCONCLUSIVE`.

### Block hydration

The existing bounds remain unchanged for this PR: active V1 metrics,
`callerConcurrency=1`, queue and in-flight at most one, positive fetch delta,
average fetch rate at most four per second, no fetch-failure delta, and at most
one oversize bypass. Fetch, oversize, failure, and epoch counters must be
monotone over all snapshots and `STOPPED`; a reset is `INCONCLUSIVE`. The known
oversize product debt in #149 is not hidden or silently relaxed here.

### Catch-up admission

`scanActive=true` and `workerClaimReady=true` is valid when the same non-null
provider owns the scan and worker sharing. Source partitions and priority
partitions must each equal the actionable backlog. A null provider while scan
or claim is active, malformed partitions, or inconsistent totals is
`INCONCLUSIVE`; a coherent snapshot is `PASS`.

### Provider affinity

Cache epoch invalidations are required to be safe, monotone integers but are
diagnostic rather than a failure by themselves. Stable provider identity and
zero provider-mixing evidence produce `PASS`. Proven mixed-provider reuse is
`FAIL`. An observed provider switch without enough evidence to prove or refute
mixing is `INCONCLUSIVE`.

### Finality

Structured degraded/recovered diagnostics are paired in order. An incident
recovered before or during the window does not fail the gate when every sampled
reconciler remains `RUNNING` and no contradiction exists. At least one
WebSocket/catch-up overlap must exist, and finality contradictions plus
replay-receipt violations must remain zero. An unresolved incident or explicit
contradiction is `FAIL`; malformed or unpairable evidence is `INCONCLUSIVE`.

### Shutdown

A clean shutdown requires runtime, subscriber, scanner, worker, and reconciler
to be `STOPPED`; zero leases; no active scan or claim admission; no queued or
in-flight block fetch; and an empty in-memory cache. Durable PostgreSQL backlog
may be non-zero. Its value must equal both catch-up admission partitions and a
fresh post-stop SQL actionable count. Residual in-memory work or leases are
`FAIL`; incomplete or inconsistent durable counts are `INCONCLUSIVE`.

### Independent unchanged gates

Idempotence, retention, decoder quarantine, RSS, PumpSwap isolation,
version/replay coverage, and cleanup remain independent. A high score or a
passing unrelated gate never overrides a failure.

## Failure handling and data safety

The evaluator is fail-closed but non-throwing for evidence content: malformed
content yields a bounded `INCONCLUSIVE` result. Only programmer misuse of the
typed internal helpers may throw. The CLI catches all failures and emits one
fixed error code.

Input and output schemas allow only fixed aggregate fields. The fixture and
tests assert the absence of secret-bearing or high-cardinality field names.
No arbitrary error message is copied into output.

## Test strategy

Tests first cover the exact `32c9bf4` fixture: admission, affinity, finality,
and shutdown become `PASS`, while runtime, backlog, terminal failures,
first-processing, and hydration keep overall `FAIL`.

Focused matrices then cover:

- safe `scanActive && workerClaimReady`, null provider, and partition mismatch;
- monotone epoch invalidations, provider switch, and mixed-provider evidence;
- recovered, unresolved, malformed, and contradictory finality diagnostics;
- non-zero coherent durable shutdown backlog, leases, residual cache/fetches,
  and SQL count mismatch;
- runtime final recovery and periodic pause;
- grouped terminal deltas and missing reason groups;
- exact-key, accessor, proxy, numeric-bound, and redaction rejection;
- CLI exit codes and fixed redacted errors;
- runbook and package command contracts.

The existing targeted baseline of deployment, first-processing, finality
diagnostics, and provider-affine hydration must remain green, followed by the
repository build, check, lint, docs check, backend tests, and frontend tests.

## Delivery boundary

This is one focused PR with at most two review cycles. A separate later PR will
address bounded pre-worker admission and tracking lifetime. Decoder drift and
retry exhaustion evidence also remain separate because the failed run did not
retain enough wire provenance to authorize a decoder expansion.
