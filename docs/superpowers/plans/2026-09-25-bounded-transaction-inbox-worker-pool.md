# Bounded transaction-inbox worker pool implementation plan

Issue: #166  
Design: `docs/superpowers/specs/2026-09-25-bounded-transaction-inbox-worker-pool-design.md`

## Task 1 — lock configuration and lifecycle in RED tests

1. Add configuration tests for a default count of one, valid bounds one and
   four, and fail-closed zero, five, fractional and malformed values. Require
   block hydration and `launchpad-only` ingestion when the count exceeds one.
2. Add `TransactionInboxWorkerPool` tests proving bounded construction,
   exactly-once member start, aggregate state, parallel progress and idempotent
   close.
3. Add a close-failure test proving every member settles before the pool emits
   one typed, redacted error.
4. Change the production factory lifecycle test to require all worker members
   to settle before provider-affine hydration closes.
5. Add production-factory tests proving the configured member count shares one
   repository, pipeline and provider-affine locator.
6. Add RED gate tests proving worker locator and PumpSwap account reads cannot
   overlap and that failures release the next queued operation.

Run only the new and modified suites and retain the expected RED evidence.

## Task 2 — implement the bounded pool

1. Add `listenerWorkerCount` to `AppConfig` and parse
   `LISTENER_WORKER_COUNT` in `[1,4]`, defaulting to one.
2. Implement a small `TransactionInboxWorkerPool` lifecycle component over the
   existing worker class. Do not move claim, lease, retry or pipeline logic
   into the pool.
3. Implement a capacity-one FIFO `ListenerRpcWorkGate` and use it at the
   physical block-fetch boundary below cache single-flight, plus the shared
   `MarketRpcReader`.
4. Construct the configured number of members in
   `production-listener-factory.ts`, sharing the inbox, locator and pipeline.
5. Aggregate worker health through the pool and close provider-affine
   hydration only after all member closes settle.
6. Keep block-hydration caller concurrency at one and update only stale
   explanatory comments if needed.
7. Expose the effective count in the structured foundation-ready log.

Run the pool, worker, hydration, production-factory, listener-runtime and app
tests.

## Task 3 — deployment and documentation contracts

1. Add the safe default to `.env.example` and forward it through production
   Compose only to the application service.
2. Extend deployment smoke tests and API/runbook configuration documentation.
3. Document that values above one increase internal DB/pipeline concurrency but
   never provider-affine HTTP fetch concurrency.
4. Run configuration, deployment smoke and documentation contract tests.

## Task 4 — integration and delivery

1. Run PostgreSQL 16 tests for concurrent claim uniqueness, durable scheduler
   fairness, deferred Pump.fun trade activation and creation/trade projection
   coherence.
2. Run build, TypeScript check, lint, documentation checks, diff checks,
   backend tests and frontend tests.
3. Perform at most two review cycles, address findings and rerun proportional
   verification.
4. Open one PR linked to #166/#120, request Codex review, merge only after a
   green CI and no blocking thread, then verify post-merge CI.
5. Repeat the external 15-minute Mainnet observe-only canary before H2e/H2c.
