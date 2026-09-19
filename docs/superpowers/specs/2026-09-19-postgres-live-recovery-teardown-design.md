# PostgreSQL Live-Recovery Teardown Design

Version: 1 — 2026-09-19

## Scope

Issue #128 fixes only the PostgreSQL test teardown race observed in CI run
35433576604. Production source, database migrations and executor behavior remain
unchanged.

## Design

The existing bounded backend-drain barrier introduced by #118 becomes a shared
test helper. After every relevant pool has completed `end()`, the live-recovery
integration test polls `pg_stat_activity` for its isolated database until no
backend remains. Polling uses a 100 ms interval, a strict five-second deadline
and a per-query timeout bounded by the remaining deadline.

Only after the barrier reaches zero may destructive cleanup call
`pg_terminate_backend` and drop the isolated database. The termination query is
asserted to affect zero rows, proving cleanup did not kill a client that was
still closing. A timeout remains a visible test failure; no `pool.error` handler
may suppress the symptom.

## Verification

Pure tests cover successful draining and the bounded timeout. PostgreSQL 16
verification covers the complete recovery-authority scenario, followed by a
repeated targeted stress run. Static verification includes build, check, lint
and whitespace validation.
