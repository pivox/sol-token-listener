# Periodic strict-scan worker progress implementation plan

Issue: #159  
Design: `docs/superpowers/specs/2026-09-25-periodic-scan-worker-progress-design.md`

## Task 1 — lock the missing behavior in tests

Modify `tests/provider-affine-catch-up-hydration.test.ts`.

1. Add a RED test where an active scan and promoted selection use the same
   provider. Assert `canWorkerClaim()` and `workerClaimReady` are true, the
   worker settles before scan persistence is released, a shared slot joins one
   fetch, and maximum RPC concurrency remains one.
2. Keep the existing different-provider exclusion test and make its intent
   explicit.
3. Add a RED test that changes the promoted revision while shared worker work
   is in flight. Assert a retryable rejection and no stale retained result.
4. Change the periodic-pause supervisor test to require the verified incumbent
   and promoted provider to remain available while state is `DEGRADED`; retain
   the existing initial-candidate pause behavior.
5. Add backend and frontend contract cases for
   `scanActive=true, workerClaimReady=true, providerId!=null`.

Run only the targeted test file and retain the expected RED evidence.

## Task 2 — implement the narrow shared route

Modify `src/application/provider-affine-catch-up-hydration.ts`.

1. Centralize the fail-closed predicate for worker readiness.
2. When a matching accepting scan permit exists, register the worker lookup in
   that permit instead of waiting behind the exclusive scan permit.
3. Recheck the immutable promoted selection and active permit after lookup.
4. Preserve the existing normal worker route when there is no scan.
5. Keep a different-provider, unavailable or closing scan exclusive.

Modify `src/application/websocket-failover-supervisor.ts`.

6. On a direct authentic periodic page-budget pause, set local state to
   `DEGRADED`, retain the incumbent and promotion, persist the degraded
   active-provider snapshot, and schedule the existing single jittered recovery.
7. Keep cleanup/promotion behavior unchanged for initial candidates, real
   session failures, provider mismatch, persistence failure, a second failure
   after inline refresh and terminal recovery failures.

Modify the backend and frontend heartbeat validators to accept the newly
honest same-provider scan/worker-ready combination without changing V1 shape.

Run the targeted hydration, pinned-cancellation, supervisor and production
factory suites.

## Task 3 — verify and deliver

1. Run build, TypeScript check, lint, documentation checks and diff checks.
2. Run backend unit tests, PostgreSQL integration tests and frontend tests.
3. Commit the versioned spec, plan, tests and implementation.
4. Open one PR linked to #159/#120 and request review.
5. Perform at most two review cycles, merge only with green CI and no blocking
   thread, then verify post-merge CI.
6. Repeat the external 15-minute Mainnet observe-only canary before H2e/H2c.
