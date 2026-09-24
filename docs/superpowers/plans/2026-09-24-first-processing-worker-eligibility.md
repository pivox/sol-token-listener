# First-Processing Worker Eligibility Implementation Plan

Version: 1.0.1 — 2026-09-24 — issue #153

> **For agentic workers:** use test-driven development, request independent
> review, and verify evidence before completion.

## Goal

Remove expected catch-up classification-only outcomes from the fixed
first-processing worker cohort without weakening any real terminal,
quarantine, malformed-state, latency, overflow or retention gate.

Design authority:
`docs/superpowers/specs/2026-09-20-first-processing-canary-evidence-design.md`
version 1.1.1.

## Scope constraints

- No migration or data rewrite.
- No heartbeat/API shape or version change.
- No RPC, finality, admission, worker scheduling or retention behavior change.
- No wallet, signer, executor, arming or submission path.
- The exclusion is expressed entirely in the bounded PostgreSQL aggregate.

## Task 1 — RED contract tests

Modify `tests/transaction-inbox.repository.test.ts`.

1. Prove the three exact classification-only combinations are excluded from
   `eligibleCount`, not merely moved to another category.
2. Prove `QUARANTINED/PUMP_SCHEMA_UNSUPPORTED` remains eligible and terminal.
3. Prove unrelated `DEFERRED`, `IGNORED`, terminal `FAILED`, incomplete and
   contradictory classification rows remain eligible and fail closed.
4. Start from a catch-up-only `DEFERRED/PUMP_TRADE_UNTRACKED` row with
   `catch_up_enqueued=false`, create the active launch, call the real
   `syncTrackedMint()` path, verify `PENDING`, then claim it through
   `PROCESSING` and `markProcessed()` through `PROCESSED`. Prove it is included
   with its immutable original `first_detected_at` and that the historical
   `catch_up_enqueued=false` receipt is unchanged.
5. Prove exclusion occurs before the 50,000-row capacity and overflow probe.
6. Inject rows with each individual worker-history/pristine contradiction and
   prove none is excluded.

Run the focused PostgreSQL tests fail-fast and capture the expected failures
before production changes. The gate must require a real PostgreSQL URL and zero
skips:

```bash
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL must target task-owned PostgreSQL 16}"
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-concurrency=1 \
  tests/transaction-inbox.repository.test.ts
```

The RED failure must be attributable to the new cohort assertions.

## Task 2 — Minimal aggregate correction

Modify `src/storage/transaction-inbox.repository.ts` only.

Add an explicit SQL eligibility predicate to the `ordered` cohort query before
ordering and `LIMIT`. Exclude only rows where classification version,
`catch_up_enqueued=false`, processing status, disposition and reason form one
of the three exact combinations in design v1.1.1 and the row satisfies the
complete never-worker-touched/pristine proof. Do not use a broad
`status IN ('IGNORED','DEFERRED')` exclusion. Make the predicate total under
SQL three-valued logic: `NULL`, unknown and partial legacy state must remain
eligible, using a null-safe exact match such as
`NOT COALESCE(exact_match, FALSE)`.

Run the RED tests to GREEN, then the complete repository test file, backend
type-check and targeted lint.

## Task 3 — Operator documentation

Modify `docs/operations/block-hydration-canary.md` and bump its version.

Document the worker-eligible population, exact exclusions and fail-closed
states. State that the correction does not waive backlog, finality, oversize,
retention or HTTP 429 gates and that the failed 2026-09-24 canary must be
replayed.

Add an explicit contract to `tests/deployment-artifacts.test.ts` that requires
the runbook version, all three exclusions, `QUARANTINED` and malformed state as
blocking evidence, and a mandatory canary replay. Run `npm run docs:check` and
the deployment-artifact tests.

## Task 4 — Verification and delivery

1. Independent local review against issue #153 and design v1.1.1.
2. Run build, check, lint, docs, focused PostgreSQL tests and the full test gate
   with one task-owned PostgreSQL 16 instance. Every PostgreSQL command must
   fail before execution when `TEST_DATABASE_URL` is missing and report zero
   skips.
3. Confirm no wallet/executor/RPC/finality/admission diff.
4. Push, open a PR linked to #153 and request at most two review cycles.
5. Merge only with all CI checks green and no unresolved blocking thread.
6. Verify post-merge `main` CI, then rerun the independent Mainnet canary gates.
