# Qualification Serialization Recovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans, and test-driven-development. One final code-review cycle only.

**Goal:** Recover the two proven 40001 conflicts through explicit bounded fresh transactions, without changing the default repository contract or weakening cleanup.

**Architecture:** The port exposes an optional closed replay policy. The service opts in because its callback reloads and rebuilds canonical state. The PostgreSQL repository issues a private retry capability only after an actual 40001 in an established transaction and fully successful cleanup. A bounded outer loop consumes that capability.

**Tech Stack:** TypeScript strict ESM, node:test, pg/PostgreSQL 16.15.

Specification: v1.1.0 of `docs/superpowers/specs/2026-10-02-qualification-serialization-reproduction-design.md`, commits `ee6a81e` and `6266af1`. Reproductions at `6ddc6f8` must remain unchanged under default policy.

## Task 1 — Write tests and establish RED

Files:
- Create `tests/qualification-serialization-recovery.test.ts`.
- Modify `tests/qualification-projection.repository.test.ts` to run the existing two barrier scenarios both with default policy and with explicit recovery.
- Modify `tests/qualification-projection.service.test.ts` to record the transaction policy.

- [ ] Build a scripted pool that records connection, SQL and release ordering and can fail a selected query once or persistently. Return valid unlock rows and an empty canonical launch read for the minimal callback; no SQLSTATE is fabricated by the callback in positive recovery cases.
- [ ] Add a one-conflict recovery case using this call shape:

```ts
const result = await repository.transact('mint', async (transaction) => {
  await transaction.loadCanonicalInput('mint');
  return 'rebuilt';
}, 'bounded-serialization');
assert.equal(result, 'rebuilt');
assert.deepEqual(waits, [10]);
```

- [ ] Assert two connections and transaction objects, full rollback/unlock/release before wait, then a new lock-before-BEGIN and commit. Persistent conflicts require three connections, waits `[10,20]`, final redacted serialization error, and no fourth attempt.
- [ ] Table-test negative cases: default policy; invalid policy; callback code spoof; forged trusted diagnostic; query inherited/getter/proxy code; 40P01; connect, lock or BEGIN failure; unknown COMMIT failure; successful COMMIT plus cleanup failure; primary conflict plus rollback/unlock/release failure; unlock returning false; wait rejection. Assert no additional attempt, preserved redaction and primary diagnostic.
- [ ] In the real PostgreSQL tests, retain the existing default-policy rejection assertions. Add a policy variant: the callback barrier runs only on attempt one; each callback reloads canonical input. The explicit-policy result must be UPDATED after two attempts, with exactly one underlying driver conflict of the expected label, one report/event/publication, lock released and replay UNCHANGED. Do not manufacture success by bypassing the real conflicting writer.
- [ ] Verify the service passes `'bounded-serialization'` on its canonical rebuild path, including rebuildWithQuotes; existing freshness checks still run inside each callback.
- [ ] Run the new unit file and the explicit-policy PostgreSQL variants before implementation. Record expected behavioral failures (one attempt/no service policy), not TypeScript compilation alone as RED evidence.

## Task 2 — Implement the opt-in policy and safe eligibility

Files:
- `src/ports/qualification-projection-repository.ts`
- `src/storage/qualification-projection.repository.ts`
- `src/application/qualification-projection.service.ts`

- [ ] Add the closed policy to the port and document callback replay safety:

```ts
export type QualificationTransactionReplayPolicy = 'none' | 'bounded-serialization';
// Optional third transact argument; omitted means exactly one attempt.
```

- [ ] Add an injected wait function as the repository constructor's optional third argument, defaulting to `node:timers/promises` setTimeout. The delay list is the immutable `[10,20]`.
- [ ] Keep the existing transaction body as a private attempt method. Its connection, lock-before-BEGIN, callback, commit, rollback and cleanup order stay intact. Add a per-attempt WeakSet populated only by the actual query boundary on own data-property 40001; keep the proxy/accessor guards and diagnostic fallback behavior.
- [ ] Record whether the primary failure happened while a transaction was established. After all cleanup, issue the private capability for the sanitized final error only when that primary error is in the per-attempt query set, there is exactly one failure, and COMMIT never succeeded. Never issue it for connect/BEGIN/lock failures, cleanup-only or combined failures.
- [ ] Wrap attempts with this bounded control flow, adapting names to the existing types:

```ts
if (policy !== 'none' && policy !== 'bounded-serialization') {
  throw new TypeError('Qualification transaction replay policy is invalid.');
}
const retryableFailures = new WeakSet<object>();
for (let attempt = 0; ; attempt += 1) {
  try {
    return await this.transactOnce(mint, operation, retryableFailures);
  } catch (error: unknown) {
    const delayMs = policy === 'bounded-serialization' ? RETRY_DELAYS_MS[attempt] : undefined;
    if (delayMs === undefined || typeof error !== 'object' || error === null
      || !retryableFailures.has(error)) throw error;
    try { await this.waitFor(delayMs); } catch { throw error; }
  }
}
```

- [ ] The private capability must be based on the actual query rejection, not `trustedTerminalAttribution`: public diagnostic registration cannot authorize control flow. Never retain raw error/SQL/parameters in logs or persistence. Keep final error taxonomy and aggregation unchanged.
- [ ] Opt in at the service's existing call: close the callback with `}, 'bounded-serialization')`. Do not move snapshot loading, quote checks or rebuilding outside it.

## Task 3 — Verify recovery and invariants

- [ ] Run new unit tests, then the four real PostgreSQL default/recovery cases against the existing isolated test instance; no second database or Mainnet activity.
- [ ] Run adjacent suites:

```sh
node --import tsx --test --test-concurrency=1 tests/qualification-projection.repository.test.ts tests/qualification-terminal-diagnostics.test.ts tests/qualification-serialization-recovery.test.ts tests/qualification-projection.service.test.ts tests/observed-transaction-pipeline.test.ts tests/launchpad-event.repository.test.ts tests/api-event-stream-migration.test.ts
npm run check
npm run lint
npm run build
npm run docs:check
git diff --check
```

- [ ] Inspect that no migration, evaluator, execution, wallet, cache or worker-count file changed. Record RED/GREEN counts and actual PostgreSQL recovery outcomes in the spec/tracking.
- [ ] Complete one independent code-review cycle, address its findings, then full local/CI tests before merge. Do not close #207 from characterization tests alone. Do not claim capacity PASS without a new complete observation after relevant fixes.

## Plan self-review

The spec's actual-driver authority, default compatibility, fresh snapshot and cleanup requirements each map to explicit negative and positive tests. The outer retry loop cannot access raw SQLSTATE; the inner transaction body retains control of rollback and cleanup. This plan does not alter outbox ordering or quote freshness. Previously passing tests are evidence for the baseline only.
