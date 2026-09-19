# Catch-up Classification Ledger V1 Implementation Plan

Version: 4 — 2026-09-19

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inactive, durable and replay-safe catch-up classification contract to the existing transaction inbox.

**Architecture:** A pure domain value validates versioned dispositions, stable reasons, canonical multi-mint evidence and the existing notification identity. PostgreSQL migration 048 adds the immutable classification group, immutable action key and strict-run classified counter; the repository persists classification and admission atomically under one canonical lock order without any factory or RPC wiring.

**Tech Stack:** TypeScript strict ESM, Node test runner, PostgreSQL 16, SQL migrations.

---

### Task 1: Define the classified notification domain value

**Files:**
- Create: `src/domain/catch-up-classification.ts`
- Create: `tests/catch-up-classification.test.ts`

- [x] **Step 1: Write failing tests** for frozen exact inputs, disposition/reason compatibility, catch-up-only source, canonical sorted unique mint arrays, fingerprint and timestamp bounds.
- [x] **Step 2: Run `npx tsx --test tests/catch-up-classification.test.ts`** and verify RED because the domain module is absent.
- [x] **Step 3: Implement the minimal constants, types, factory and validator** with no launchpad or RPC imports.
- [x] **Step 4: Re-run the focused test** and verify GREEN.

### Task 2: Add migration 048

**Files:**
- Create: `migrations/048_transaction_inbox_catch_up_classification.sql`
- Create: `tests/transaction-inbox-catch-up-classification-migration.test.ts`
- Modify: migration-head assertions under `tests/`

- [x] **Step 1: Write failing PostgreSQL tests** for 047 upgrade, empty migration, replay, exact catalog definitions, lifecycle constraints, four-hour terminal retention and the classified/enqueued counter invariant.
- [x] **Step 2: Run the focused test against PostgreSQL 16** and verify RED because migration 048 is absent.
- [x] **Step 3: Implement migration 048** with seven all-or-none classification columns, closed disposition/reason checks, terminal ignored/quarantined states, canonical mints and strict-run accounting.
- [x] **Step 4: Re-run the focused PostgreSQL test** and verify GREEN.
- [x] **Step 5: Update exact migration-head assertions** from 047 to 048 without changing earlier migration semantics.

### Task 3: Persist classifications atomically

**Files:**
- Create: `src/ports/catch-up-classification-repository.ts`
- Modify: `src/storage/transaction-inbox.repository.ts`
- Modify: `tests/transaction-inbox.repository.test.ts`

- [x] **Step 1: Write failing repository tests** for actionable admission, terminal ignored/quarantined retention, exact replay, contradictory replay, sorted multi-mints and rollback after a forced database failure.
- [x] **Step 2: Run the focused repository test against PostgreSQL 16** and verify RED because the repository method is absent.
- [x] **Step 3: Add a dedicated `recordCatchUpClassification` port** and implement validation-before-I/O plus one signature-locked transaction.
- [x] **Step 4: Re-run repository and domain tests** and verify GREEN.

### Task 4: Add strict classified accounting without activating classification

**Files:**
- Modify: `src/domain/strict-catch-up-run.ts`
- Modify: `src/application/strict-catch-up-scanner.ts`
- Modify: strict catch-up tests and fixtures under `tests/`

- [x] **Step 1: Write failing tests** that require a classified counter and reject `signaturesClassified < signaturesEnqueued`.
- [x] **Step 2: Run focused strict-run tests** and verify RED.
- [x] **Step 3: Extend the strict-run value and repository mapping**; have the current scanner advance both counters equally.
- [x] **Step 4: Re-run focused scanner/repository tests** and verify GREEN with unchanged scan/admission outcomes.

### Task 5: Verify, document and deliver

**Files:**
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/system-overview.html`
- Create: `tests/catch-up-classification-documentation.test.ts`

- [x] **Step 1: Add documentation assertions** for inactive B1 scope, disposition semantics, replay and four-hour retention.
- [x] **Step 2: Update architecture and diagnostic HTML** with the versioned technical ledger contract.
- [x] **Step 3: Run build/check/lint/docs and the full non-PG suite, then run bounded B1 PostgreSQL 16 integration groups sequentially.**
- [ ] **Step 4: Commit, push and open one PR referencing #120** without requesting review or merging.

### Task 6: Reject weakened replay constraints

- [x] Demonstrate RED when a direct migration replay encounters an existing weakened named CHECK.
- [x] Capture the replay definitions before mutation and reject drift with SQLSTATE `23514`.
- [x] Re-run migration 048 on PostgreSQL 16 and verify all seven cases GREEN.

### Task 7: Address independent B1 review findings

- [x] Demonstrate RED for the DEFERRED classification versus tracked-mint synchronization race.
- [x] Standardize trade persistence on `mint -> signature -> row` and prove bounded concurrent classification/enqueue and classification/synchronization settlement.
- [x] Demonstrate RED for rejected program/finality replay, accepted CREATE/TRADE contradiction and trade-hint mutation after multi-program convergence.
- [x] Persist one immutable derived action key while keeping the current inbox hint mutable; union programs and reconcile finality on replay.
- [x] Demonstrate RED for alphabet-compatible non-keys (`z` × 44 and `2` × 32).
- [x] Decode base58 with built-in PostgreSQL arithmetic and require exactly 32 bytes without installing an extension.
- [x] Re-run all focused PostgreSQL, domain, check, lint, documentation and build gates.

### Task 8: Make finalized classification replay explicit and action prefixes literal

- [x] Demonstrate RED after `claim -> snapshot -> markProcessed(confirmed)` when an exact classification replay advances to `finalized`.
- [x] Reuse the safe inbox replay lifecycle: retain the snapshot, return to `PENDING`, clear terminal/cycle state and advance finality evidence before reclaim.
- [x] Demonstrate RED for the wildcard-compatible impostor `PUMPFUNXTRADE:<mint>`.
- [x] Replace SQL `LIKE` with an exact literal `PUMPFUN_TRADE:` prefix in the live and replay-drift constraint definitions.
- [x] Re-run focused PostgreSQL and all static gates, then refresh the immutable migration catalog hash.

### Task 9: Close cycle-one terminal replay and migration-helper gaps

- [x] Demonstrate RED when classification would recreate a purged finalized or orphaned inbox row despite a durable replay receipt.
- [x] Reuse the terminal receipt identity/finality checks and return without recreating actionable work.
- [x] Demonstrate RED when an ordinary discovery reaches a classified ignored or quarantined row.
- [x] Converge only sources, programs and finality while preserving terminal disposition, four-hour retention and finality evidence version zero.
- [x] Demonstrate RED for a non-key mint inserted while the SQL public-key helper is weakened.
- [x] Restore helpers and scan helper-dependent stored evidence before replacing any CHECK constraint on migration replay.
- [x] Restore omitted migration 047 entries in the three exact migration-history expectations reported by CI.
- [x] Re-run the targeted PostgreSQL 16 suites and all static gates, then refresh the immutable migration catalog hash.
