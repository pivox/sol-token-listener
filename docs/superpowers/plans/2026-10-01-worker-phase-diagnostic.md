# Worker phase diagnostic implementation plan

> **For agentic workers:** Use subagent-driven-development, TDD, and two review cycles maximum.

**Goal:** Identify expensive worker phases without changing processing semantics.

**Architecture:** A failure-isolated synchronous observer in the worker feeds a
fixed-memory recorder shared by the pool. Publish one shutdown diagnostic, not a
new API or gate. All attempts, not a candidate or first-processing cohort.

**Tech Stack:** TypeScript ESM, node:test, injected monotonic clock.

## Task 1 — recorder

Files: create `src/application/worker-phase-diagnostic.ts` and
`tests/worker-phase-diagnostic.test.ts`.

- [ ] Write failing tests for exact duration buckets, invalid time, concurrent
  entry/exit, idempotent finish callbacks, snapshot reuse, outcome counts and
  immutable snapshots. The clock is injected independently from worker.now.
- [ ] Implement fixed phase tuple from spec and a minimal observer:

```ts
interface WorkerPhaseObserver {
  beginPhase(phase: WorkerPhase): () => void;
  beginAttempt(): (outcome: WorkerAttemptOutcome) => void;
  recordClaimOutcome(outcome: 'claimed' | 'idle' | 'exceptional'): void;
  recordSnapshotReuse(): void;
}
```

The recorder additionally exposes snapshot(). Start callbacks capture only the
diagnostic clock and counters, never claim objects. Finishing twice must not
decrement active twice. Round elapsed milliseconds upward to an integer; invalid
readings increment invalid samples, never a successful zero duration. Check sums
before incrementing; saturation must set overflow. No arrays of observed samples.

- [ ] Tests use an injected scalar clock, e.g. begin locator at0, end at11,
  assert count1/sum11/max11 and bucket50=1. A NaN/backward clock increments invalid
  while entered/exited remain consistent. Serialize the snapshot and assert fixed
  shape and bounded size with no user-provided values.
- [ ] Run `node --import tsx --test tests/worker-phase-diagnostic.test.ts` RED then
  GREEN. Commit only after verification.

## Task 2 — worker integration

Files: modify `src/application/transaction-inbox-worker.ts`, its existing tests,
and optionally a focused `tests/transaction-inbox-worker-phase.test.ts`.

- [ ] Add optional observer to worker options and guarded synchronous start/end
  helpers. Absence/throwing getters/methods/finish callbacks must preserve behavior.
  Do not pass a claim, signature, failure or transaction into the observer.
- [ ] Add tests before wiring: advance diagnostic clock in repository/locator/
  pipeline stubs; compare operation order and lease-clock call count with the
  observer absent. Assert no locator sample on restored snapshot.
- [ ] Instrument claim_call around the existing claim invocation; classify null,
  successful and rejected returns. Begin an attempt after a nonnull claim; finish
  with processed/failed/lease-lost/exceptional according to the actual outcome,
  including validation failures. Entire attempt includes cleanup.
- [ ] Use try/finally at existing phase boundaries: lease start=claim_setup;
  locate=locator; restore/normalize/save/ownership=snapshot_and_ownership;
  process=pipeline; finish lease and persist final outcome=completion. Do not move
  existing database or lease calls to make timing convenient. Early returns must
  finish their entered phase. Failed persistence records exceptional attempt.
- [ ] Exercise locator rejection, invalid snapshot, save rejection, pipeline
  failure, lease loss, markProcessed/markFailed rejection and throwing observer.
  Original errors/results and renewal behavior remain unchanged.
- [ ] Run all `tests/transaction-inbox-worker*.test.ts` and recorder tests.

## Task 3 — shared production wiring and delivery

Files: `src/application/production-listener-factory.ts`, existing factory tests,
and focused shutdown wrapper tests if isolation is needed.

- [ ] Create one recorder before building the worker pool, inject same observer
  into each worker. No clock/config/worker-count changes.
- [ ] Publish fixed event/version/scope after worker close/drain. Use an idempotent
  wrapper analogous to passiveMentionDiagnosticSupervisor, preserving original
  close result and before/after cleanup semantics. On failed close show incomplete
  counts/status rather than claiming a clean drain. Logging failures are swallowed.
- [ ] Tests assert one publication on repeated/concurrent close, publication only
  after close settles, shared counters, and original rejection identity preserved.
- [ ] Run focused tests, `npm run check`, `npm run lint`, `npm run docs:check`,
  `git diff --check`. Inspect architectural test constraints before adding modules.
- [ ] Review locally once, open PR and request GitHub review once, fix findings,
  wait full CI then merge tested head. Keep root checkout intact.
- [ ] Update excluded harness to capture the fixed shutdown summary separately,
  validating bounded shape and distinguishing absent/incomplete evidence. Test
  harness offline before any observation. Never change official canary manifest
  gates to accept phase diagnostics as first-processing proof.

## Sequencing

#202 must merge before the next real observation. Merge its main update into this
branch without rewriting history. No Mainnet/RPC/wallet actions in these tasks.
