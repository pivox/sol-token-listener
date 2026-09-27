# Wallet Graph Transaction Convergence Plan

**Goal:** make concurrent wallet-graph rebuilds converge by replaying the full
database transaction only after an authenticated PostgreSQL serialization or
deadlock failure.

**Design authority:**
`docs/superpowers/specs/2026-09-27-wallet-graph-transaction-convergence-design.md`
revision 1.0.0.

**Plan revision:** 1.0.0

## Task 1: Lock the bounded sequence RED

**Files:**

- Modify: `tests/wallet-graph-terminal-diagnostics.test.ts`

- [ ] Script authenticated `40001`, then `40P01`, then success.
- [ ] Require the exact sequence `BEGIN`, lock, `ROLLBACK`, wait 10, `BEGIN`,
  lock, `ROLLBACK`, wait 20, `BEGIN`, lock, callback, `COMMIT`.
- [ ] Require three fresh transaction objects when callback attempts conflict.
- [ ] Require one connection and exactly one release.
- [ ] Prove the third authenticated rejection is rethrown unchanged with no
  fourth attempt.

## Task 2: Lock every no-retry path RED

**Files:**

- Modify: `tests/wallet-graph-terminal-diagnostics.test.ts`

- [ ] Cover forged code/diagnostic objects, primitives, other SQLSTATEs,
  hostile and revoked proxies, public wrappers/causes, and other diagnostics.
- [ ] Require one begin/rollback, zero wait, zero second callback, same identity,
  and one release.
- [ ] Prove classification invokes no hostile proxy trap.
- [ ] Prove rollback failure prevents retry and propagates rollback failure.
- [ ] Prove wait failure prevents a new begin and releases once.
- [ ] Prove authenticated commit conflict replays the complete callback.

## Task 3: Implement the minimal repository loop

**Files:**

- Modify: `src/storage/wallet-graph.repository.ts`
- Modify: `src/ports/wallet-graph-repository.ts`

- [ ] Add fixed private delays `[10, 20]` and an injectable wait dependency.
- [ ] Start a fresh RR transaction, advisory lock, and transaction object on
  every attempt.
- [ ] Roll back before exact-identity classification and waiting.
- [ ] Retry only the two existing authenticated PostgreSQL diagnostics.
- [ ] Preserve exact error identity at exhaustion and release once in `finally`.
- [ ] Document the callback replay contract without changing the port shape.

## Task 4: Convert the PostgreSQL reproduction to convergence

**Files:**

- Modify: `tests/wallet-graph-terminal-diagnostics.test.ts`

- [ ] Keep deterministic barriers and `pg_blocking_pids`; add no timing sleep.
- [ ] Run both workers to success with an injected zero-time wait recorder.
- [ ] Require worker B to roll back once, wait `[10]`, create a new RR snapshot,
  reacquire the lock, and commit.
- [ ] Prove the retry observes worker A's committed canonical state.
- [ ] Require one canonical profile, snapshot and cluster event and no duplicate
  relationships, clusters, or members.

## Task 5: Verify and deliver

- [ ] Run the targeted diagnostic test without PostgreSQL and on PostgreSQL 16.
- [ ] Run wallet-graph repository/rebuild and observed-pipeline failure suites.
- [ ] Run build, check, lint, docs, and diff checks.
- [ ] Inspect the diff for zero worker, pipeline, RPC, cache, wallet, executor,
  migration, or environment change.
- [ ] Complete at most two review cycles and merge only after green CI.
