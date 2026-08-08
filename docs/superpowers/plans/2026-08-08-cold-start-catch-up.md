# Cold-start Catch-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh Pump.fun listener start from a bounded recent baseline and close the scan-to-subscription event gap.

**Architecture:** The scanner distinguishes absent checkpoints from restart checkpoints. Runtime performs a second idempotent scan after WebSocket subscription and before worker startup.

**Tech Stack:** TypeScript strict, Node test runner, PostgreSQL inbox, Solana HTTP/WebSocket RPC.

---

### Task 1: Cold-start baseline

**Files:**
- Modify: `tests/catch-up-scanner.test.ts`
- Modify: `src/application/catch-up-scanner.ts`

- [ ] Add a failing test proving a full first page with no checkpoint succeeds without requesting an older page.
- [ ] Keep the existing full-window failure test for a non-null checkpoint.
- [ ] Implement the one-page baseline rule and run the focused scanner tests.

### Task 2: Gap-closing scan

**Files:**
- Modify: `tests/listener-runtime.test.ts`
- Modify: `src/application/listener-runtime.ts`

- [ ] Add failing lifecycle tests for the second scan order and rollback after its failure.
- [ ] Call `scanner.scan()` after subscriber startup and before worker startup.
- [ ] Run focused runtime, subscriber, inbox, and scanner tests.

### Task 3: Acceptance and dry run

**Files:** Modify only files required by verified findings.

- [ ] Run build, check, lint, focused tests, full PostgreSQL tests and diff check.
- [ ] Start with public read-only RPC, observe mode, local PostgreSQL and bounded catch-up.
- [ ] Verify `/api/v1/health`, then stop cleanly.
- [ ] Commit and push the fix to `main` after review.
