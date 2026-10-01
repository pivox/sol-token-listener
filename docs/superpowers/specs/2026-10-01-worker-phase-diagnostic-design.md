# Worker phase diagnostic — v1.0.1

Issue #203; supports capacity investigation #171. Approved-recommendation workflow.

## Problem and evidence

Canary 1ec88fa has first-processing p95 57,788 ms and 46,928 backlog rows at
15 minutes. An independent completed-row SQL diagnostic found LAUNCH_CANDIDATE
pre-admission p95 zero and post-admission p95 57,398 ms. These populations differ;
the numbers do not identify a cause. The run's final terminal report is missing.

## Decision and alternatives

Instrument all worker attempts with fixed phase counters and histograms, using
one recorder shared by the pool and one sanitized shutdown summary. This is a
narrow investigation tool, not a new gate or general telemetry system.

Extending claim metadata and SQL would permit candidate-specific queue analysis
but is deferred until needed. A heartbeat/API/UI expansion adds unnecessary scope.
Changing concurrency or cache before attribution would not establish causality.

## Contract

- Optional synchronous timing hook in TransactionInboxWorker. Independent monotonic
  diagnostic clock; never add calls to the business/lease clock.
- Fixed phases: claim_call, claim_setup, locator, snapshot_and_ownership, pipeline,
  completion. Total claimed-attempt duration is separate and overlaps phase times.
- claim_call includes null claims and errors with distinct fixed outcomes; it is
  repository-call latency, never admission-to-claim queue residence.
- Snapshot reuse skips locator rather than fabricating a zero sample. Keep reuse
  counts and attempt outcomes (processed, failed, lease-lost, exceptional).
- Count phase entries/exits and current active phases, including early returns
  and failures. Histograms describe exited phases; active work remains visible.
- Integer millisecond histogram bounds: 1, 5, 10, 50, 100, 250, 500, 1000, 2000,
  5000, 10000, 30000, 60000, 120000, then overflow bucket. Fixed count, sum, max,
  invalid count, saturating-counter overflow flag. Never unbounded sample arrays.
- Reject invalid/backward/nonfinite clock readings as unavailable diagnostic
  samples; do not change worker results, error identity, leases or cleanup.
- No signatures, mints, slots, lease tokens, URLs, arbitrary errors or identifiers
  reach the recorder or output. No async I/O in hooks.
- One immutable summary after worker drain, fixed event
  `listener_worker_phase_diagnostic_shutdown`, version 1, scope
  `ALL_WORKER_ATTEMPTS_PROCESS_LIFETIME`. Log/publication failures are isolated.
  Absent summary means unavailable, never zero. No API/heartbeat/schema change.
  `closeStatus` is COMPLETED only for a resolved close, STOPPED component and zero
  active attempt/phase counts; otherwise INCOMPLETE. Neither status is a capacity
  verdict. Original close failures must remain the same rejected error object.

## Interpretation limits

Attempts are not unique transactions or confirmed creates; retries/replays count
again. Process lifetime is not the official 15-minute cohort. Phase p95s must not
be added. Locator includes provider permits, cache, RPC and normalization, so a
slow locator does not prove FIFO dominance. Short phases with high post-admission
delay leave queue/retry/population effects unresolved. Existing canary gates and
durable first-processing evidence remain authoritative and unchanged.

## Files and acceptance

Target worker, focused recorder module, production-factory wiring, and their tests.
No migration, configuration surface, new RPC, worker/cache increase or scheduler
change. Tests cover deterministic timings and unchanged lease/call order; reuse;
each failure and lease-loss path; invalid/throwing clocks/hooks; bounded concurrent
aggregation; no identifier leakage; shutdown publication after drain. Existing
worker/factory tests and full CI must pass. Two review cycles maximum.

After #202 and this change pass, capture a bounded diagnostic observation before
choosing a throughput correction. No claim that instrumentation itself fixes
capacity, and no wallet/signing action.
