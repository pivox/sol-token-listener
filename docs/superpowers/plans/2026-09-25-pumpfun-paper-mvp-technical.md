# Pump.fun Paper MVP Technical Implementation Plan

> Implements issues #149 and #28 in one paper-only PR. Maximum two review cycles.

## Task 1 — Version and package the explicit technical profile

1. Add failing loader, engine, and copy-script tests.
2. Add `pumpfun-mvp-technical-v1.json` without modifying the historical profile.
3. Change the copy script to atomically validate and copy the fixed two-file
   allowlist.
4. Prove no-social technical evidence qualifies, while creator sale and each
   enforced technical blocker reject.
5. Run targeted tests, build, check, and commit.

## Task 2 — Persist quote-backed qualification

1. Add failing projection and real worker-integration tests.
2. Add a locked projection operation that accepts the exact BUY/reverse-SELL pair,
   reloads canonical evidence, rebuilds, persists, and returns the current report.
3. Wire only the paper worker to quote, persist, then admit that exact report.
4. Preserve observe mode and fail closed on stale/incoherent/superseded evidence.
5. Run targeted PostgreSQL tests and commit.

## Task 3 — Establish the causal paper-entry cursor

1. Add failing tests for a trade between qualification and BUY, strict post-entry
   inclusion, and crash/recovery stability.
2. Add the next replay-safe migration and repository/domain contract for an entry
   boundary recorded with the successful paper BUY.
3. Make `creation-entry-v1` switch to and recover that boundary.
4. Run migration, strategy, repository, and replay tests; commit.

## Task 4 — Enforce one active MVP position globally

1. Add failing PostgreSQL concurrency tests using two connections and two mints.
2. Add a transactional singleton admission with a fail-closed migration preflight.
3. Release it only on terminal close/retract and verify retry for a later mint.
4. Prove duplicate opens and concurrent closes still create one logical trade.
5. Run repository and engine tests; commit.

## Task 5 — Make N and one-shot reporting honest

1. Add failing domain/CLI/report compatibility tests for N values other than 10.
2. Remove hardcoded N/label checks while preserving safe configuration bounds.
3. Add an additive report schema for the causal one-shot cycle; keep historical
   report decoders compatible and separate functional completion from profitability.
4. Add a compiled production CLI script and explicit bounded-run configuration.
5. Run CLI, report, config, and production-image contract tests; commit.

## Task 6 — Runbook and complete verification

1. Document the explicit profile, amount, N, minimum external buy, duration, one
   target close, incomplete outcomes, and paper-only boundary.
2. Update safe examples without changing observe defaults.
3. Run build, check, lint, docs, full PostgreSQL backend, frontend, E2E, migration
   replay, and deployment smoke gates.
4. Perform review cycle 1, fix verified findings, rerun affected and full gates.
5. Perform review cycle 2 only if needed; no third cycle.
6. Push, open the PR, obtain green CI/review, merge, verify post-merge CI, and update
   the local tracking file.
