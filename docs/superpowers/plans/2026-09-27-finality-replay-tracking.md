# Finality replay tracking implementation plan

Issue: #191

Spec: `docs/superpowers/specs/2026-09-27-finality-replay-tracking-design.md`

## Task 1 — Make the projection read signature-aware

Files:

- `src/ports/launchpad-projection-reader.ts`
- `src/storage/launchpad-event.repository.ts`
- `tests/launchpad-event.repository.test.ts`

Steps:

1. Add a PostgreSQL test that persists a confirmed trade, expires its launch
   beyond the worker tracking window, and proves the ordinary global set is
   empty while the exact transaction signature still yields the mint.
2. Run the focused test and record the RED failure.
3. Require a transaction signature on `listTrackedMints` and return an immutable
   lexical union of global authority plus active launchpad mints for that exact
   signature only.
4. Prove a foreign signature does not extend tracking and orphaned/terminal
   events do not become replay authority.
5. Run the repository tests, typecheck and lint.

## Task 2 — Reconcile finalized replay through the existing decoder

Files:

- `src/application/observed-transaction-pipeline.ts`
- `tests/observed-transaction-pipeline.test.ts`

Steps:

1. Add a RED pipeline test whose reader returns the persisted mint only when
   called with the finalized transaction signature. The launchpad mock promotes
   the stored trade only when that mint is supplied; the strict funding boundary
   must fail before the production change.
2. Pass the durable observed signature to the projection reader inside the
   existing `load_tracked_mints` stage.
3. Assert the adapter receives the local replay authority, the post-write reload
   is finalized, funding succeeds, and no unrelated mint is admitted.
4. Run the pipeline and terminal-attribution suites.

## Task 3 — Prove PostgreSQL confirmed-to-finalized convergence

Files:

- `tests/transaction-ingestion-recovery.test.ts`

Steps:

1. Persist the production-shaped confirmed Pump.fun fixture with bounded worker
   admission enabled.
2. Age the launch past 45 seconds and prove it is absent for an unrelated
   signature.
3. Enqueue/replay the durable transaction as finalized through the real worker
   and pipeline.
4. Assert `raw_chain_events`, `domain_events`, `launch_trades` and funding
   observations converge without duplicate rows or retryable failure.
5. Run the focused PostgreSQL 16 suite.

## Task 4 — Verify and deliver

1. Run focused suites, `npm run build`, `npm run check`, `npm run lint`,
   `npm run docs:check`, and `git diff --check`.
2. Run the relevant PostgreSQL integration tests on a task-owned PostgreSQL 16
   container and remove it afterward.
3. Perform at most two review cycles. Correct only demonstrated findings.
4. Push, open the PR linked to #191, wait for green CI, merge, then verify the
   post-merge CI.
5. Repin the canary worktree, rerun the short observe-only funding probe, and
   proceed to the 15 minute canary only if the mismatch population is gone.

## Safety boundary

This plan does not read a wallet, private key or signer, does not create an
execution intent, and cannot submit a transaction. Mainnet use is observe-only.
