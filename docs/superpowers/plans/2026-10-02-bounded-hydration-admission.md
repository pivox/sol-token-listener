# Bounded Hydration Admission Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans, with test-driven-development. One final independent code-review cycle only, per user override.

**Goal:** Bound shared hydration demand without leasing transactions that cannot yet hydrate or hiding upstream wait.

**Architecture:** A small admission controller owns a single group/reservation budget; provider routing remains in the existing coordinator. Each worker gets a cancellable pre-claim handle. Classifier fan-out is retained within a group but later groups are produced lazily. A separate optional heartbeat contract exposes admission pressure.

**Tech Stack:** Strict TypeScript ESM, node:test, existing PostgreSQL repositories unchanged.

Specification: `docs/superpowers/specs/2026-10-02-bounded-hydration-admission-design.md`, v1.0.1 (initial design `a00e696`, route-order clarification before integration).
Baseline `c9aadef`: hydration/cache/classifier 96 PASS, zero skips. No implementation exists yet.

## Task 1 — Controller contract and deterministic state tests

Create `src/application/hydration-group-admission.ts` and
`tests/hydration-group-admission.test.ts`. Keep provider selection, SQL and RPC out
of this file. The group key is opaque text built only by the trusted coordinator.

- [ ] Start with this public shape; all returned tickets are frozen capabilities,
  validated by private identity, not structurally trusted caller objects:

```ts
export interface HydrationAdmissionPermit {
  bindGroup(key: string): void;
  release(): void;
}
export interface HydrationWorkerAdmissionHandle {
  acquire(signal: AbortSignal): Promise<HydrationAdmissionPermit | null>;
  close(): void;
}
export interface HydrationGroupAdmissionOptions {
  readonly now: () => number;
}
```

The controller exposes `registerWorker()`, `acquireClassifier(key, signal)`,
`metrics()` and `close()`. `registerWorker` creates the finite worker identity;
only one outstanding request/reservation per handle is allowed. A permit starts
unbound for a worker; a classifier permit starts bound. `bindGroup` is a one-time
exchange, rejects empty keys or stale/reused permits, and does not add capacity.

- [ ] Write a fake-clock test using an unresolved classifier permit, two registered
  worker acquires, and an explicit microtask flush. Assert zero worker grants until
  release, then exactly one grant, one remaining waiter and combined admitted=1.
  Release the first worker, assert the second grants, then close all handles.
- [ ] Assert first contested dispatch worker, then alternating roles while both
  remain waiting. A classifier same-key join shares the current group without a
  second budget unit. Different keys wait; a second distinct pending classifier
  group is rejected as contract misuse, not silently queued.
- [ ] Add cancellation-before-grant, grant/abort race, release twice, handle close,
  controller close, invalid clock and monotonic-duration tests. Last/maximum wait
  survives cancellation; current oldest wait clears when its queue becomes empty.
- [ ] Run `node --import tsx --test tests/hydration-group-admission.test.ts` and
  record RED. Missing API is acceptable initially, but establish behavioral RED
  with the minimal compiled shell before completing the scheduling logic.
- [ ] Implement one synchronous state transition function: remove cancelled
  requests, preserve live group references, grant only when budget permits, select
  the fair role, assign ownership before resolving its promise, update metrics.
  Promise callbacks must never race to increment capacity after resolution.
  Release drops one reference; the group survives until the final real operation
  releases. No polling timers, detached promises or raw provider errors.
- [ ] Re-run GREEN and commit only these files.

## Task 2 — Pre-claim worker integration

Create `src/application/transaction-inbox-claim-admission.ts`:

```ts
import type { TransactionLocationTarget } from '../solana/rpc/transaction-locator.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';

export interface TransactionInboxClaimReservation {
  locate(target: TransactionLocationTarget): Promise<NormalizedTransaction>;
  release(): void;
}
export interface TransactionInboxClaimAdmission {
  acquire(signal: AbortSignal): Promise<TransactionInboxClaimReservation | null>;
  close(): void;
}
```

Modify `src/application/transaction-inbox-worker.ts` and
`tests/transaction-inbox-worker.test.ts`. Add optional `claimAdmission` to worker
options with the same defensive option-access style used by `canClaim`; retain
the old option and path for compatibility.

- [ ] Test two workers with a shared one-slot fake admission. Hold the first claim
  promise: the second repository's claim count stays zero. Abort its worker and
  assert close settles without `markFailed`, degraded state or a claim attempt.
- [ ] Add cleanup cases: null/throwing claim, invalid clock/claim, corrupt snapshot,
  initial lease loss, orphan without snapshot and locator rejection. Observe
  release events, not only the final counter.
- [ ] Test snapshot release before lease/pipeline work and locator release before
  `saveSnapshot`. Keep worker A's pipeline unresolved; B must reach its locator.
- [ ] Run the worker test file for RED; implement a worker-owned AbortController,
  acquire before claim, route `reservation.locate(target)` when present, and an
  idempotent release in the outer run finally plus the early snapshot/hydration
  paths. Close aborts acquisition before awaiting `runTail` and closes its handle.
  A null acquisition returns idle (or closed if already closing), not an error.
- [ ] Re-run GREEN, including all existing legacy worker tests; commit.

## Task 3 — Provider coordinator and lazy classifier groups

Modify `src/application/provider-affine-catch-up-hydration.ts`,
`src/application/pumpfun-catch-up-block-classifier.ts`, and their matching tests.
The controller remains separate from provider route permits.

- [ ] Add `workerAdmission(): TransactionInboxClaimAdmission` to the coordinator.
  Each call registers one handle. Before/after acquisition validate current route
  eligibility; release and return idle when no compatible route exists. Bind a
  ticket to the selection revision and scan generation; revalidate before cache
  use and before returning. A route invalidated after a real claim remains a
  genuine locator failure, not a capacity failure.
- [ ] Preserve the old `workerLocator` for legacy/direct callers, but route all
  coordinator cache entries through the same controller budget. The ticket path
  must not reacquire its own budget. Map the bound group with an unambiguous key:

  Acquire the route permit before the group slot to avoid holding capacity while
  an incompatible scan needs it to finish. A shared worker accepted by a scan
  adds a settlement pin covering acquisition/claim/hydration, not business work,
  to the scan's pending drain. Release it on every null/error/cancellation path.
  Test natural scan completion during a delayed claim: it cannot unbind the route
  before this reservation is consumed/released or create an artificial retry.

```ts
JSON.stringify([context.token, context.providerId, target.slot.toString(),
  target.confirmationStatus === 'FINALIZED' ? 'FINALIZED' : 'CONFIRMED']);
```

- [ ] Port both `/tmp/hydration-queue-repro.yVfFPY/` fake-provider scenarios into
  repository tests. Observe each enqueue, pacing wait, RPC start/finish and
  admission change, not a single final metric. Expect queue≤1 and RPC≤1 at every
  sample; retain all requested results and visible upstream wait.
- [ ] Change classifier slot hydration to sequential effective-commitment groups,
  with `Promise.allSettled` inside each group. Store outcomes by original row
  index, then produce classifications in original order. Preserve the existing
  next-slot/persistence pipeline, errors, receipts and abort semantics.
- [ ] Add same-group oversize fan-out, mixed-commitment ordering, forced refresh,
  worker arrival during pacing/persistence, selection changes, scan abort, close
  and partial consumer cancellation. Underlying work must settle before final
  group release, including callers whose own signal has already been cancelled.
- [ ] Run the three baseline suites for RED then GREEN. Update old assertions
  requiring simultaneous distinct groups only where explicitly superseded by the
  new spec; retain their result, error and persistence assertions. Commit.

## Task 4 — Visible admission evidence and production wiring

Modify `src/domain/transaction-ingestion.ts`,
`src/application/production-listener-factory.ts`,
`src/storage/transaction-inbox.repository.ts`,
`src/storage/api-projection.repository.ts`, `src/api/contracts.ts`,
and `scripts/lib/mainnet-observe-canary-verdict.ts`.
Test files: `tests/transaction-ingestion-contracts.test.ts`,
`tests/production-listener-factory.test.ts`,
`tests/transaction-inbox.repository.test.ts`,
`tests/api-projection.repository.test.ts`, `tests/api-contracts.test.ts`,
`tests/mainnet-observe-canary-verdict.test.ts`.

- [ ] Define a separate optional heartbeat field `blockHydrationAdmission`, version
  1. Concrete fields: `enabled`, `registeredWorkers`, `pendingWorkers`,
  `maximumPendingWorkers`, `pendingClassifierGroups`,
  `maximumPendingClassifierGroups`, `unboundReservations`, `activeGroups`,
  `maximumAdmitted`, and `worker`/`classifier` role objects. Each role has
  `grants`, `cancellations`, `oldestWaitMs`, `lastWaitMs`, `maximumWaitMs`.
  The three wait fields are nullable nonnegative safe integers; counts are
  nonnegative safe integers. Require current≤maximum, pendingWorkers≤registered,
  pendingClassifierGroups≤1, unbound+active≤1 and maximumAdmitted≤1.
- [ ] Test strict field/shape/count validation, immutable round-trip, omission in
  old heartbeats and no accidental rewrite of legacy `blockHydration` semantics.
  Runtime metrics must compute oldest from current demand and use monotonic time.
- [ ] Wire a unique handle per worker in the existing provider-affine branch,
  replacing its bool-only gate with actual admission. Preserve `idlePollMs: 1000`
  for genuinely idle/no-row polling; capacity release uses notification instead.
  Include admission metrics in heartbeat capture and DTO mapping without migration.
- [ ] Add a separate canary admission-evidence gate. Parse older missing evidence
  without throwing but report INCONCLUSIVE for the new contract; never infer PASS
  from absence. For evidence present, validate all sampled bounds and zero live
  waiters/reservations/groups after stop. Keep every existing queue/oversize/p95/
  backlog gate unchanged. Add both old-evidence and violating-bounds tests.
- [ ] Update `docs/api/v1.md` and `docs/operations/block-hydration-canary.md` with
  JSON fields, upstream-wait meaning and old-evidence limitations. Run RED/GREEN
  contracts and mock suites; run repository tests on one isolated test database.
  No live RPC or wallet. Commit this integration.

## Task 5 — Full validation and delivery

- [ ] Re-run all new admission/worker/coordinator/classifier/contract suites. Assert
  sustained mixed workload fairness and immediate capacity notification, not only
  the queue bound. Document that snapshot-only claims may conservatively wait.
- [ ] Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`
  and `git diff --check`. Run `npm test` with both `TEST_DATABASE_URL` and
  `TEST_EXECUTOR_ROLE_DATABASE_URL` on the same disposable PostgreSQL instance;
  inspect final counts and skips. Stop/remove only this test instance afterward.
- [ ] Request one independent code-review cycle for the whole diff; address its
  concrete findings and repeat impacted checks, not a second review cycle.
- [ ] Push, open a PR closing #209, wait for green CI and no blocking threads,
  merge the exact reviewed head, then verify the post-merge CI. Preserve root main.
- [ ] Update the excluded tracking with actual evidence and remaining blockers.
  Do not claim capacity PASS: oversize, decoder and measurement-contract issues
  remain, and the full Mainnet observe-only canary still has to pass.

## Self-review

The one-slot rule includes generic reservations and pacing; no SQL claim happens
while a worker waits. Classifier single-flight and original ordering are explicit.
Worker stop cancels pre-claim waits independently of hydration shutdown. Metric
omission is parse-compatible, not proof-compatible. Fairness, stale-route rejection,
all cleanup exits and the unchanged legacy path have named tests above. Tasks are
sequential at shared coordinator boundaries; independent test-writing may be
delegated only with disjoint file ownership.
