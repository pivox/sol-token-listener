# Deployment Smoke Safe Diagnostics Implementation Plan

> **For agentic workers:** Execute inline with the executing-plans skill; preserve the parent agent's independent worktree and validation jobs.

**Goal:** Localize smoke failures without revealing untrusted diagnostics.

**Architecture:** Private WeakMap annotations preserve original error identity; fixed phase and operation values augment the existing bounded formatter. Allowlisted transport codes and error names prevent raw diagnostic disclosure.

**Tech Stack:** Node.js ESM script, Node test runner, TypeScript VM tests.

## Task 1: RED diagnostics contract

- [x] Add `tests/deployment-smoke-diagnostics.test.ts`, loading declarations from
  the actual smoke script into a VM, excluding executable startup.
- [x] Inject `TypeError('fetch failed', {cause: {code: 'ECONNRESET'}})` into
  `requestWithDeadline`; expect `phase=PUBLIC_HEALTH operation=HTTP_HEADERS transport=ECONNRESET`.
- [x] Inject rejected body reads into `readBoundedBody` and `readSseToEof`;
  expect `HTTP_BODY` and `SSE_BODY` operations respectively.
- [x] Exercise unknown thrown values, secret-bearing names/messages/codes,
  aggregate bounds, original error identity and distinct cleanup attribution.
- [x] Run `node ../../node_modules/tsx/dist/cli.mjs --test tests/deployment-smoke-diagnostics.test.ts`; confirm expected missing-diagnostic assertions fail.

## Task 2: GREEN and focused verification

- [x] In `scripts/deployment-smoke.mjs`, implement WeakMap annotations and fixed
  allowlists; wrap phases with `await smokePhase('PUBLIC_HEALTH', assertPublicHealth)`
  and equivalent literals for the other sequential steps and cleanup operations.
- [x] Add `catch` annotations before existing HTTP/body `finally` blocks, then
  rethrow the original error. Extend only the bounded summary formatter.
- [x] Run the new test file; then existing artifacts with `--test-name-pattern='deployment smoke'`
  to exclude Docker Compose probes.
- [x] Run `node --check scripts/deployment-smoke.mjs`, focused ESLint, TypeScript
  no-emit and `git diff --check`. Inspect the diff for changed assertions/retries.
- [x] Report evidence and leave changes uncommitted for parent review.
- [x] Parent review cycle 1 and independent diagnostics execution (10/10).
- [ ] Coordinator: PR, final GitHub review cycle 2 and CI smoke verification.
