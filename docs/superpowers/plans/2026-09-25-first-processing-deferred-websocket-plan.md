# Pristine Deferred WebSocket First-Processing Plan

Version: 1.0.0 — 2026-09-25 — issue #163

## Goal

Exclude only canonical, pristine, intentionally deferred Pump.fun trade
notifications from the first-processing cohort. Preserve fail-closed evidence,
the public V1 schema, and every independent canary gate.

## Task 1 — Lock the contract with PostgreSQL tests

Update `tests/transaction-inbox.repository.test.ts` so the real repository path
proves:

1. a WebSocket-only untracked trade is excluded;
2. coherent WebSocket plus catch-up enrichment remains excluded;
3. promotion and successful processing make it eligible and completed while
   preserving `first_detected_at`;
4. each worker-history or receipt contradiction remains eligible;
5. more than 50,000 pristine deferred rows are excluded before overflow is
   computed.

Run the focused PostgreSQL test first and retain the expected RED result.

## Task 2 — Implement the smallest null-safe SQL correction

Change only the exclusion predicate in
`src/storage/transaction-inbox.repository.ts`. Keep the two catch-up-only
ignored outcomes unchanged. Add exact WebSocket-only and mixed-source shapes
for `DEFERRED / PUMP_TRADE_UNTRACKED`, share the complete pristine-worker
predicate, and retain `NOT COALESCE(..., FALSE)`.

Do not change schemas, migrations, admission, claims, RPC, heartbeat JSON,
wallet handling, signing or submission.

## Task 3 — Version operator documentation

Update the first-processing design and Mainnet canary runbook. Update deployment
contract assertions so they require the new exact provenance rules and keep the
independent backlog, finality, oversize, retention and HTTP 429 gates.

## Task 4 — Verify and deliver

Run the focused PostgreSQL suite without skips, then build, check, lint, docs,
backend and frontend tests. Perform no more than two review cycles, open one PR,
request one GitHub Codex review, and merge only after all required checks pass.

The Mainnet observe-only canary is rerun only after the separate scheduling and
bounded worker-capacity PRs are merged.
