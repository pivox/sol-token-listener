# Paper Claim Election Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent concurrent paper finality-preflight claimers from rotating the same released sixteen-job batch.

**Architecture:** Serialize only the short claim election transaction with a PostgreSQL transaction-scoped advisory lock. Acquire it in a separate statement after `BEGIN`, scope its stable key with the resolved `paper_decision_jobs` relation OID, and run the existing bounded CTE only after the wait has produced a fresh `READ COMMITTED` statement snapshot.

**Tech Stack:** TypeScript strict ESM, Node test runner, PostgreSQL 16, `pg`.

---

### Task 1: Specify the election boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-08-27-provider-affine-finality-design.md`
- Create: `docs/superpowers/plans/2026-09-19-paper-claim-election-lock.md`

- [x] Record the stale-snapshot race and the relation-scoped transaction lock in spec version 1.0.10.
- [x] Keep the sixteen-row bound, durable generation order, leases and parallel post-claim processing unchanged.

### Task 2: Prove the missing transaction order

**Files:**
- Create: `tests/paper-decision-claim-election.test.ts`
- Modify: `tests/paper-decision.repository.test.ts`

- [ ] Add a repository contract test that records SQL calls and requires `BEGIN`, one relation-scoped `pg_advisory_xact_lock`, the claim CTE, then `COMMIT`.
- [ ] Run `npx tsx --test tests/paper-decision-claim-election.test.ts` and observe failure because the scheduler lock statement is absent.
- [ ] Preserve the PostgreSQL concurrent two-claimer regression and execute it repeatedly against PostgreSQL 16.

### Task 3: Serialize only claim election

**Files:**
- Modify: `src/storage/paper-decision.repository.ts`
- Test: `tests/paper-decision-claim-election.test.ts`
- Test: `tests/paper-decision.repository.test.ts`

- [ ] Add one constant SQL statement using `pg_advisory_xact_lock(hashtextextended(...))` with the resolved `paper_decision_jobs` relation OID in its key.
- [ ] Execute that statement immediately after `BEGIN` and before constructing the claim timestamp, lease token and CTE query.
- [ ] Re-run the contract test and observe the exact order pass.
- [ ] Run the concurrent PostgreSQL regression repeatedly and require 32 distinct rotations on every iteration.

### Task 4: Verify and deliver

**Files:**
- Verify all changed files above.

- [ ] Run the focused contract and PostgreSQL tests.
- [ ] Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check` and `git diff --check`.
- [ ] Run the backend suite without PostgreSQL and confirm no regression.
- [ ] Commit, push and open one pull request closing issue #131 without requesting review or merging.
