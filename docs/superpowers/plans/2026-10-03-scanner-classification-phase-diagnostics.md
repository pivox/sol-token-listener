# Scanner/classification phase diagnostics — implementation plan v1.0.0

Base: `main@ced66e7086911265012897a34239a59371204878`.
Issue: #216. Design: `../specs/2026-10-03-scanner-classification-phase-diagnostics-design.md` v1.0.1.
This is diagnostics only; old Mainnet canary remains FAIL.

## Task 1 — immutable bounded contract

Add a finite-enum `scannerPhaseDiagnostics.v1` value and a process-local
collector. Reject malformed inputs, bound provider/program/phase keys,
saturate counters, and surface overflow. Never store identity-bearing strings
or raw errors. Test RED then GREEN for dimensions, timings, unknown cause,
overflow, immutability and snapshot/replay. No RPC or SQL in these tests.

## Task 2 — scanner and classifier instrumentation

Inject an optional observer into the existing scanner and Pump.fun page
classifier. Measure source page, coverage read, block hydration, classification
write, page admission and durable-front operations at their awaited boundaries.
Preserve typed errors before `operation()` normalizes them; do not modify what
the scanner throws, retries, enqueues or checkpoints. Distinguish pause,
refresh and abort from failures. RED/GREEN unit tests in the existing scanner,
classifier and supervisor suites; explicit test that errors in the observer do
not alter the pipeline.

## Task 3 — heartbeat and public projection

Wire the collector once per production listener. Add an optional heartbeat
field validated before persistence; project it read-only in `/api/v1/health`
with backward-compatible omission for old rows. Include a same-sample clock
relationship to the existing worker-admission debt metrics. RED/GREEN domain,
PostgreSQL repository, factory and API projection tests. No migration unless a
schema inspection proves one necessary; the heartbeat payload is JSON.

## Task 4 — protected canary sidecar

Provide a versioned, pure builder for
`mainnet-scanner-attribution.v1.json` with `VALID|MISSING|MALFORMED|OVERFLOW`
per sample. Keep the exact-keyed v1 canary snapshot/verdict contract and all
19 gates unchanged. The local private harness may bind this builder and write
the owner-only sidecar at T0/T+5/T+15/FINAL_PRESTOP/STOPPED, before cleanup.
RED/GREEN builder and CLI tests cover old fixtures, malformed/missing data and
no identifiers. Do not run a 15-minute canary in this task.

## Task 5 — verification and delivery

`npm ci` only after disk check >5,000,000,000 bytes. Run focused tests, build,
check, lint, docs, PostgreSQL/integration tests, then one combined independent
review. Correct real findings and rerun relevant gates, push PR, wait for green
CI, merge only without blocking threads and verify post-merge CI. Run a short
observe-only causal probe on an exact clean merge commit; choose the next
smallest corrective PR from its evidence. A full canary PASS is still required
before H2e/H2c/wallet/operator checkpoint/trade.
