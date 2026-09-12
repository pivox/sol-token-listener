# Durable Inbox Observed-At Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the original inbox observation time through every transaction replay.

**Architecture:** PostgreSQL returns `observed_at` in the claim; the worker forwards it to the observed pipeline, which has no runtime-clock fallback.

**Tech Stack:** TypeScript strict ESM, Node test runner, PostgreSQL.

---

### Task 1: Propagate the durable timestamp

**Files:** `src/domain/transaction-ingestion.ts`,
`src/storage/transaction-inbox.repository.ts`,
`src/application/transaction-inbox-worker.ts`,
`src/application/observed-transaction-pipeline.ts`.

- [ ] Write contract, worker and pipeline regression tests; run them RED.
- [ ] Add `ClaimedTransaction.observedAtMs`, select `observed_at` in `claim`,
  and require `process(transaction, observedAtMs)`.
- [ ] Construct the observed transaction from that supplied timestamp; run the
  focused suite GREEN.

### Task 2: Record the invariant

**Files:** this spec, this plan, `docs/architecture/pumpfun-v1.md`.

- [ ] Document that finality upgrades and retries retain inbox `observed_at`.
- [ ] Run backend type-check, targeted tests, build, check, lint and docs check.
