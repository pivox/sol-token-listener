# Scanner/classification phase diagnostics — design v1.0.2

## Evidence and decision

The observe-only Mainnet canary on `main@ced66e7` failed with 5,994
classification-pending WebSocket-only rows at T+15 (6,489 after STOPPED),
zero worker-claimable rows, and no HTTP 429. The same oldest pending row remains
unresolved from T+5 through shutdown. Workers ran and had idle claims. The
supervisor's `RPC_UNAVAILABLE` is an umbrella reason and does not prove a
network outage. Protected source artifacts:
`/tmp/sol-token-listener-canary-ced66e7-2026-10-02T23-09-17-678Z/`.

This PR adds bounded attribution only. It must not alter classification,
admission, RPC capacity, page size, retries, checkpoints, gates, or execution.

## Contract

Introduce a versioned `scannerPhaseDiagnostics.v1` runtime heartbeat field.
The field is an aggregate for the listener lifetime, not a transaction log:

- finite phase enum: `SOURCE_PAGE`, `COVERAGE_READ`, `BLOCK_HYDRATE`,
  `CLASSIFICATION_WRITE`, `PAGE_ADMIT`, `RUN_PROGRESS`, `CHECKPOINT`,
  `SUPERVISOR`;
- finite outcome enum: `OK`, `ERROR`, `PAUSED`, `REFRESH_REQUIRED`,
  `ABORTED`;
- finite, trusted error-code enum preserving the original stage where possible,
  with `UNKNOWN` for untrusted/unclassified exceptions;
- by exact finite provider (`primary`, `fallback-1`, `fallback-2`,
  `fallback-3`), ingestion family and phase: bounded
  count, total duration and maximum duration, plus last outcome/code;
- a compact durable-front summary per program: count of progress operations,
  count of completed operations, last progress age, and whether a checkpoint
  advanced during the current observation window. Never include a cursor;
- same-sample classification-pending count and oldest age already supplied by
  `workerAdmissionClock`; correlate via `sampledAtMs`, not independent clocks.

No signature, mint, slot, URL, RPC token, run ID, error message, raw exception,
or wallet data may enter this contract or logs derived from it. Bound all
dimension cardinalities and saturate counters at safe integers. Snapshot
construction must be immutable and strict; malformed data is unavailable,
never silently interpreted as zero. Older persisted heartbeats may omit the
field and remain readable as historical data.

## Observation boundaries

Instrument scanner source-page read, page admission and durable run/checkpoint
operations at their existing awaited boundaries. Instrument Pump.fun page
classification at coverage read, block hydration and classification write.
Observe the trusted original phase/error before scanner `operation()` or the
supervisor maps it to `RPC_UNAVAILABLE`. Page-budget pause and head-refresh are
normal bounded outcomes, not network failures. Aborts and shutdown are
distinguished from errors. A failed diagnostic sink must not change ingestion
outcome; the heartbeat marks diagnostics unavailable so the proof is not
mistaken for healthy zeros.

Persist snapshots through the existing heartbeat JSON path and expose an
optional read-only field in `/api/v1/health`. The canary capture writes a
separate owner-only `mainnet-scanner-attribution.v1.json` sidecar containing
the diagnostic sampled at T0, T+5, T+15, FINAL_PRESTOP and STOPPED. Do not
add keys to the existing exact-keyed canary snapshot/verdict v1 schema.
Each sidecar sample has an explicit `VALID`, `MISSING`, `MALFORMED` or
`OVERFLOW` evidence status. The evaluator continues using the existing 19
gates unchanged; a missing diagnostic is not a new PASS or a relaxed gate.

## Causal probe after merge

Run a short observe-only Mainnet probe with T0, T+2, T+5 and STOPPED samples,
using only a pinned clean commit and no wallet. Compare source-page,
hydration, admission and durable-front deltas with classification-pending age.
If phases advance but pending age grows, investigate throughput; if the same
front/phase repeats without progress, investigate a stalled frontier or a
coverage hole. The probe is diagnostic, not a substitute for a 15-minute
canary PASS. Keep the existing FAIL verdict and all downstream gates blocked.

## Acceptance

TDD fixtures cover every finite phase/outcome, original-code preservation,
unknown exceptions, pause/refresh/abort, saturation/cardinality, legacy
heartbeat omission, durable replay, API projection, and canary artifact
capture. Build, check, lint, docs and relevant PostgreSQL/integration tests
must pass. One combined review cycle and green PR/post-merge CI are required.
