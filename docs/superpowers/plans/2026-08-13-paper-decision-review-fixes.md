# Paper Decision Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make candidate finality follow the selected canonical qualification and safely terminalize superseded orphan jobs without touching later paper lineage.

**Architecture:** `TradingCandidateService` will use `qualificationEvent` as the sole source of candidate identity, cursor, and finality. Paper snapshots will distinguish exact source-linked lineage from a mint-level existence flag; strict empty-mint no-ops remain separate from an atomic obsolete-job completion that permits unrelated lineage but rejects exact lineage races.

**Tech Stack:** TypeScript, Node test runner, PostgreSQL advisory locks and transactional predicates.

---

### Task 1: Canonical qualification finality

**Files:**
- Modify: `tests/trading-candidate.service.test.ts`
- Modify: `src/application/trading-candidate.service.ts`

- [ ] **Step 1: Write the failing cross-finality tests**

Add one case where a confirmed old job carries a processed canonical qualification and must be `NOT_ELIGIBLE`, and the inverse case where a processed old job carries a confirmed canonical qualification and must be `ELIGIBLE`. Assert that `candidate.asOf` remains the qualification event in both cases.

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `npx tsx --test tests/trading-candidate.service.test.ts`

Expected: both cross-finality assertions fail because eligibility currently reads `snapshot.asOfEvent.confirmationStatus`.

- [ ] **Step 3: Use qualification finality in candidate state evaluation**

Change both the orphan check and `confirmationReached` input in `TradingCandidateService.state` to `input.qualificationEvent.confirmationStatus`. Keep candidate/event identity and timestamps unchanged.

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run: `npx tsx --test tests/trading-candidate.service.test.ts`

Expected: all candidate service tests pass.

- [ ] **Step 5: Commit P1**

Commit only the P1 implementation, regressions, and this reviewed plan with message `fix: use canonical qualification finality for paper candidates (#15)`.

### Task 2: Source-scoped orphan reconciliation and obsolete completion

**Files:**
- Modify: `src/ports/paper-decision-repository.ts`
- Modify: `src/application/paper-decision-worker.ts`
- Modify: `src/storage/paper-decision.repository.ts`
- Modify: `tests/paper-decision-worker.test.ts`
- Modify: `tests/paper-decision.repository.test.ts`
- Modify: `tests/trading-candidate.service.test.ts`

- [ ] **Step 1: Write failing worker and PostgreSQL regressions**

Extend `PaperDecisionSnapshot` with `hasPaperLineage`. Add a fake repository `completeObsolete` recorder. Prove that an orphan snapshot with unrelated mint lineage chooses obsolete completion, while an empty mint still chooses strict no-op. In PostgreSQL, persist a later source candidate, orphan the older launch, remove the current qualification, and assert that the old job snapshot has no exact decision but reports mint lineage and completes without changing the later candidate.

- [ ] **Step 2: Run the targeted tests and verify RED**

Run: `npx tsx --test tests/paper-decision-worker.test.ts tests/paper-decision.repository.test.ts`

Expected: compilation or assertions fail because `hasPaperLineage` and `completeObsolete` do not exist and source loading still falls back to unrelated active sessions.

- [ ] **Step 3: Separate exact lineage from mint-level existence**

In `loadSnapshot`, compute `hasPaperLineage` with mint-wide `EXISTS` checks. Preserve exact candidate lookup for orphan jobs, remove the unrelated `activeSession` fallback in the orphan branch, and scope orphan position loading to the exact session or raw-backed trigger.

- [ ] **Step 4: Add atomic obsolete completion**

Add `completeObsolete(job)` to the port and PostgreSQL repository. Under the paper and qualification mint locks, use a fresh READ COMMITTED statement that requires the job and raw-backed source to be orphaned, requires no active canonical launch, rejects candidates/sessions/positions linked to the exact job source or raw event, and permits unrelated retained mint lineage. Keep `completeNoop` strict and change it to READ COMMITTED after lock acquisition so concurrent lineage commits are visible.

- [ ] **Step 5: Route the worker by lineage scope**

When no canonical qualification and no active launch exist and all exact decision fields are null, call `completeNoop` if `hasPaperLineage` is false and `completeObsolete` if it is true. Both paths must finish the lease first and surface repository failures as completion-stage errors.

- [ ] **Step 6: Verify GREEN and the live database race**

Run: `npx tsx --test tests/paper-decision-worker.test.ts tests/paper-decision.repository.test.ts`

Expected: all targeted tests pass when `TEST_DATABASE_URL` is available. The race test must hold the paper advisory lock, introduce exact lineage, release it, and prove obsolete completion is rejected rather than consuming the job from a stale snapshot.

- [ ] **Step 7: Commit P2**

Commit the P2 implementation and regressions with message `fix: terminalize superseded orphan paper jobs safely (#15)`.

### Task 3: Full verification and independent review

**Files:**
- Review: all files changed by Tasks 1 and 2

- [ ] **Step 1: Run full verification**

Run: `npm run lint:backend && npm run check:backend && npm run test:backend`

Expected: zero lint errors, zero TypeScript errors, and all backend tests pass (database tests may only skip when `TEST_DATABASE_URL` is absent).

- [ ] **Step 2: Review the final diff and history**

Run: `git diff HEAD~2..HEAD --check && git status --short && git log --oneline -4`

Expected: no whitespace errors, only intended files changed, and two focused `#15` commits above `6ef3b5e`.

- [ ] **Step 3: Request an independent code review**

Give a reviewer base `6ef3b5e`, final HEAD, the two Codex findings, and the required finality/lineage invariants. Resolve every critical or important issue locally; do not push or reply on GitHub.
