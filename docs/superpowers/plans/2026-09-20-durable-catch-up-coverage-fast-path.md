# Durable catch-up coverage fast path implementation plan

Issue: #146
Design: `docs/superpowers/specs/2026-09-20-durable-catch-up-coverage-fast-path-design.md`
Review budget: two GitHub cycles maximum

## Task 1 — Freeze source and merge contracts in RED

- Extend catch-up source fixtures with the official `err` field.
- Add RED tests for missing/accessor `err`, null success, non-null failure and
  hostile non-traversal.
- Add RED merge tests for the immutable `transactionFailed` boolean and
  contradictory duplicate observations.
- Implement only enough source/domain code to make these tests green.

## Task 2 — Add the inactive durable coverage port in RED

- Define the bounded batch port and exact receipt validation.
- Add PostgreSQL RED tests for WebSocket coverage, classified replay coverage,
  terminal receipt coverage, absence, slot/finality contradiction,
  finalized-upgrade fallback, cancellation and preservation of
  status/priority/hint/lease/snapshot/finality evidence, plus failed-first versus
  success-second and success-first versus failed-second contradictions.
- Implement one bounded read-only batch query with no advisory, mint or row
  locks; add a concurrency regression against `syncTrackedMint`.
- Keep the port uncomposed in production.

## Task 3 — Add the classifier fast path in RED

- Add RED unit tests for flag-off compatibility.
- Add RED unit tests for direct failed classification, existing coverage,
  mixed pages, missing-only hydration, exact ordering/cardinality, cancellation
  and hostile coverage results.
- Implement the optional coverage dependency and deterministic partition/rejoin.
- Add the failed/source-success contradiction guard in repository tests.

## Task 4 — Compose behind a safe restart-only flag

- Add the strict false-default configuration key and prerequisite validation.
- Wire the coverage repository only when the flag and existing page admission
  path are active.
- Update `.env.example`, architecture, API/deployment configuration contracts
  and the canary runbook.
- Prove no wallet/executor/signer/submission dependency is introduced.

## Task 5 — Verify, review and deliver

- Run targeted tests after every task.
- Run build, check, lint, docs and diff checks.
- Run the complete backend and frontend suites with one task-owned PostgreSQL 16
  container, then remove it immediately.
- Perform two independent local reviews and address P1/P2 findings.
- Commit the versioned spec separately from implementation.
- Push, open a PR linked to #146/#120, request one GitHub Codex review and use a
  second cycle only if blocking feedback is returned.
- Merge only with green CI and no blocking thread, then verify post-merge CI.
- Do not run the Mainnet canary, H2e, H2c, wallet validation or any trade in this
  PR; the canary is the next separate roadmap step.
