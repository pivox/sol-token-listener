# PostgreSQL Live-Recovery Teardown Design

Version: 3 — 2026-09-19

## Scope

Issue #128 fixes only the PostgreSQL test teardown race observed first in CI run
35433576604, subsequently in the listener-authority test in run 35435493030,
and finally in the migration 040 test in main run 35436837234. Production
source, database migrations and executor behavior remain unchanged.

## Design

The existing bounded backend-drain barrier introduced by #118 becomes a shared
test helper. After every relevant pool has completed `end()` or `close()`, every
test cleanup that targets all backends by database name polls
`pg_stat_activity` for its isolated database until no backend remains. Polling
uses a 100 ms interval, a strict five-second deadline and a per-query timeout
bounded by the remaining deadline.

Only after the barrier reaches zero may destructive cleanup call
`pg_terminate_backend` and drop the isolated database. The termination query is
asserted to affect zero rows, proving cleanup did not kill a client that was
still closing. A timeout remains a visible test failure; no `pool.error` handler
may suppress the symptom. An audit scans every TypeScript test for a
database-name-scoped termination query and requires the complete order:
pool close, drain, captured termination, zero-row assertion, then database drop.
The executor-main scenario that intentionally terminates one known PID remains
outside this cleanup contract.

## Verification

Pure tests cover successful draining, the bounded timeout and repository-wide
teardown ordering. PostgreSQL 16 verification covers live recovery, listener
authority, migration 040, role provisioning, worker authority and executor-main
cleanup paths, with targeted stress runs for the failures observed in CI.
Static verification includes build, check, lint, docs and whitespace validation.
