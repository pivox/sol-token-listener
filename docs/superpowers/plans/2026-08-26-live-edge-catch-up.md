# Live-edge Catch-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the V1 listener resume at the current chain edge after a long interruption without RPC pagination storms or silent event loss.

**Architecture:** `CatchUpScanner` applies a configured `live-edge` or `strict` policy. A new repository operation atomically records a deterministic four-hour catch-up gap and advances the program checkpoint; production emits a redacted structured warning after persistence.

**Tech Stack:** TypeScript strict ESM, Node test runner, PostgreSQL migrations, `@solana/web3.js`, Pino structured logs.

---

### Task 1: Define policy and gap contracts

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `src/domain/transaction-ingestion.ts`
- Modify: `src/ports/transaction-inbox-repository.ts`
- Test: `tests/config-safety.test.ts`
- Test: `tests/transaction-ingestion-contracts.test.ts`

- [ ] Add failing tests for the `live-edge` default, exact `strict` parsing, invalid values, and frozen deterministic gap contracts.
- [ ] Run the focused tests and verify they fail because the policy and contract do not exist.
- [ ] Add `ListenerCatchUpPolicy`, `CatchUpGap`, validation, and the repository method with no optional unsafe fallback.
- [ ] Run the focused tests and verify they pass.

### Task 2: Persist gaps atomically

**Files:**
- Create: `migrations/015_listener_catch_up_gaps.sql`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `src/storage/database.ts`
- Test: `tests/transaction-ingestion-migration.test.ts`
- Test: `tests/transaction-inbox.repository.test.ts`

- [ ] Add failing contract and repository tests for schema bounds, idempotent insert, checkpoint advancement, rollback, and four-hour purge.
- [ ] Run the focused tests and verify the missing table/method failures.
- [ ] Implement the replayable migration and single-transaction repository operation.
- [ ] Run the focused tests and verify they pass.

### Task 3: Apply live-edge scanning

**Files:**
- Modify: `src/application/catch-up-scanner.ts`
- Test: `tests/catch-up-scanner.test.ts`

- [ ] Add failing tests proving a stale checkpoint consumes one page, enqueues no abandoned rows, persists one deterministic gap, advances to the newest row, and keeps strict failure unchanged.
- [ ] Run the scanner test and verify the stale live-edge case fails.
- [ ] Implement the minimal policy branch and immutable result notice.
- [ ] Run the scanner test and verify all existing recovery behavior remains green.

### Task 4: Wire production and observability

**Files:**
- Modify: `src/application/production-listener-factory.ts`
- Modify: `README.md`
- Modify: `docs/api/v1.md`
- Test: `tests/production-listener-factory.test.ts`

- [ ] Add a failing production wiring test for the configured policy and redacted gap warning.
- [ ] Pass the policy to the scanner and emit `listener.catch_up_gap_recorded` with only program, previous slot, baseline slot, and policy.
- [ ] Document both policies, the default, the four-hour evidence, and provider impact.
- [ ] Run focused production and documentation contract tests.

### Task 5: Acceptance

**Files:** Modify only files required by verified findings.

- [ ] Run `npm run build`, `npm run check`, `npm run lint`, and `npm test`.
- [ ] Source the existing local environment without printing it, migrate PostgreSQL, and reproduce startup with `LISTENER_ENABLED=true`.
- [ ] Verify the runtime reaches `RUNNING`, the gap is durable, and the first live-edge scan stays within one page per program.
- [ ] Review the full diff for secrets, financial floats, live execution paths, and unrelated changes.
- [ ] Commit, push, open the PR linked to #52, request Codex review, address no more than three review cycles, and merge only when checks and blocking threads are clear.
