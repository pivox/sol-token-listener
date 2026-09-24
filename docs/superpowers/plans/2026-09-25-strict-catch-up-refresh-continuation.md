# Strict Catch-up Refresh Continuation Implementation Plan

Version: 1.0.0 — 2026-09-25 — issue #155

> **For agentic workers:** use test-driven development, request independent
> review, and verify evidence before completion.

## Goal

Treat the scanner's authenticated `CATCH_UP_REFRESH_REQUIRED` result as one
bounded fresh-head continuation on the same provider and WebSocket session.
Eliminate needless session churn without weakening strict recovery, provider
affinity, shutdown, idempotence or promotion gates.

Design authority:
`docs/superpowers/specs/2026-09-09-resumable-strict-catch-up-design.md`
version 4.

## Scope constraints

- No migration, public API shape, RPC rate/concurrency or checkpoint change.
- No wallet, signer, executor, armament or transaction submission path.
- Exactly one inline continuation; a second refresh fails closed.
- `StrictCatchUpPausedError` retains its existing cleanup and jitter behavior.
- Only a frozen native error with the exact local prototype, fixed control
  fields and the expected provider may trigger continuation.
- Candidate promotion remains forbidden until the continuation succeeds.

## Task 1 — RED supervisor contracts

Modify `tests/websocket-failover-supervisor.test.ts` first.

1. Candidate `[refresh, success]`: prove one session/genesis, two scans with the
   same provider and signal, no intermediate close/jitter/degradation, and
   promotion only after the second scan.
2. Periodic `[refresh, success]`: prove the incumbent stays open and RUNNING,
   two scans use the same provider/signal, and the periodic frontier rearms.
3. Candidate and periodic `[refresh, refresh]`: prove exactly two scans, then
   the existing cleanup/degradation/jitter path, with no loop or promotion.
4. Prove refresh followed by pause/window/transient failure preserves the
   existing typed outcome and cleanup semantics.
5. Prove wrong-provider, forged, proxy and malformed refresh values never
   trigger an inline retry.
6. Prove candidate completion, incumbent replacement, abort and shutdown fence
   the second pass or promotion and join cleanup exactly once.

Run the focused test and capture failures attributable to the new expectations:

```bash
npx tsx --test tests/websocket-failover-supervisor.test.ts
```

## Task 2 — Minimal bounded continuation

Modify `src/application/websocket-failover-supervisor.ts` only.

1. Add a private helper that invokes strict scan, recognizes only the canonical
   provider-matching refresh signal without invoking getters, rechecks a
   caller-provided lifecycle fence, and invokes one final scan with the same
   provider and abort signal.
2. Use it in candidate recovery with a fence requiring the same live candidate.
3. Use it in the periodic frontier with the existing incumbent fence.
4. Propagate every error from the second scan to the existing classification;
   never recurse and never translate refresh into scan success.
5. Preserve all current pause, window, abort, cleanup and backoff behavior.

Run focused tests, backend check and targeted lint.

## Task 3 — Integration and operator contract

1. Extend `tests/websocket-failover-supervisor.integration.test.ts` so a resumed
   H1 completion and H2 bridge succeed with one candidate session and the final
   checkpoint/inbox evidence remains complete.
2. Bump `docs/operations/block-hydration-canary.md` and document that a refresh
   continuation is bounded to one additional scan and that any second refresh
   or pause remains a failed canary condition.
3. Extend `tests/deployment-artifacts.test.ts` to pin the new runbook contract.

## Task 4 — Verification and delivery

1. Run build, check, lint, docs, focused supervisor tests, PostgreSQL integration
   tests and the full backend/frontend/deployment gates.
2. Perform at most two review cycles and verify that no RPC concurrency,
   wallet or executor diff exists.
3. Push, open the PR linked to #155, request review, address blocking findings,
   merge only on green CI, then verify post-merge `main` CI.
4. Keep the Mainnet 15-minute canary as a distinct post-merge gate.
