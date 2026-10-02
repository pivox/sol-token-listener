# Comparable canary clock evidence implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make startup and stopped worker evidence comparable without weakening any canary gate.

**Architecture:** Reuse the durable PostgreSQL cohort anchor. Pair existing worker
metrics with an additive clock from the same SQL snapshot; independent stopped
SQL binds that clock. Preserve exact v1 metrics and legacy parsing, but missing
new proof cannot PASS.

**Tech Stack:** TypeScript strict ESM, node:test/tsx, PostgreSQL16, existing JSON API.

Spec: [v1.0.0](../specs/2026-10-02-canary-clock-evidence-design.md), commit4b469f4.
Base8fb1b10 has the same tree as the fully tested #211 head654428f. Post-merge CI
36956089302 is still running; do not duplicate it. No runtime or wallet execution.

## Task 1 — Canonical startup regression

Files: src/application/production-listener-factory.ts;
tests/production-listener-factory.test.ts.

- [ ] Extend the existing durable-cohort test with the following assertion before
  production edits. Its fake database already returns1000:

```ts
assert.ok(writes.every((write) => write.startedAtMs === 1_000));
```

- [ ] Run `npx tsx --test tests/production-listener-factory.test.ts`; record RED
  from startup equality, not infrastructure failure. Add a separate mocked-clock
  case (local1001/database1000) and assert updatedAtMs remains1001.
- [ ] Remove both ensureStartedAtMs calls and the helper. Set the field only
  inside the existing validated cached promise:

```ts
if (!Number.isSafeInteger(value) || value <= 0) {
  throw new TypeError('First processing canary cohort start is invalid.');
}
this.startedAtMs = value;
return value;
```

- [ ] Add future-anchor publication rejection and rerun existing stop-before-start,
  initialization rejection, stop race, dependency and timeout cases. Ensure real
  heartbeat validation runs even when optional catch-up metrics are absent; no
  Date.now clamp or successful write after invalid chronology.
- [ ] Run the full factory test file to GREEN, then commit scoped source/tests.

## Task 2 — Strict additive clock and paired repository sample

Files: src/domain/worker-admission-metrics.ts;
src/domain/transaction-ingestion.ts;
src/storage/transaction-inbox.repository.ts;
tests/worker-admission-metrics.test.ts;
tests/transaction-ingestion-contracts.test.ts;
tests/inbox-heartbeat-snapshot.test.ts;
tests/transaction-inbox.repository.test.ts.

- [ ] Add RED contract tests for exact frozen clock shape, detached output,
  version2, extra keys, accessors/proxies, negative zero, unsafe integers and
  nonrepresentable dates. Leave existing metrics' nine-field tests unchanged.
  Proposed public type/helper names:

```ts
export interface RuntimeWorkerAdmissionClockV1 {
  readonly version: 1;
  readonly sampledAtMs: number;
}
// Implement beside the existing strict metrics snapshot helper:
// snapshotRuntimeWorkerAdmissionClock(value: unknown): RuntimeWorkerAdmissionClockV1
```

- [ ] Implement the clock snapshot helper with the same frozen plain/null-prototype
  record and descriptor checks as metrics, fixed redacted TypeError, integer>0
  and finite Date representation. Add optional RuntimeHeartbeat.workerAdmissionClock;
  when present require metrics and sampledAtMs<=updatedAtMs.
- [ ] Add RED paired-snapshot tests: existing single client/read-only transaction,
  shared materialized clock, empty inbox, invalid clock, rollback/release, frozen
  detached pair. Run the three non-DB files with `npx tsx --test`.
- [ ] Rename the private reader to readWorkerAdmissionSample, returning
  `{workerAdmission, workerAdmissionClock}`; keep public workerAdmissionMetrics()
  returning only `.workerAdmission`. heartbeatSnapshot() spreads the paired result.
  In BOTH enabled and disabled aggregate SELECTs add:

```sql
(SELECT (EXTRACT(EPOCH FROM at)*1000)::BIGINT
 FROM database_clock) AS sampled_at_ms
```

- [ ] Validate the returned timestamp, freeze the sidecar and pair, preserve
  predicates/query count/isolation. Persist optional clock next to metrics in JSON.
- [ ] Run PostgreSQL-backed repository tests with a single disposable scoped DB,
  both TEST_DATABASE_URL and TEST_EXECUTOR_ROLE_DATABASE_URL configured. Empty
  inbox must return the clock; a skipped DB test does not prove this requirement.
- [ ] Commit only domain/repository changes and associated passing tests.

## Task 3 — Factory and API propagation

Files: src/application/production-listener-factory.ts; src/api/contracts.ts;
src/storage/api-projection.repository.ts; tests/production-listener-factory.test.ts;
tests/api-projection.repository.test.ts; docs/api/v1.md.

- [ ] Add RED tests for a paired provider propagating a detached frozen clock,
  legacy provider omitting it, malformed/present evidence rejected and no clock
  reconstructed from Date.now. Extend provider type additively:

```ts
readonly inboxSnapshot?: () => Promise<Readonly<{
  counts: InboxCounts;
  workerAdmission: RuntimeWorkerAdmissionMetricsV1;
  workerAdmissionClock?: RuntimeWorkerAdmissionClockV1;
}>>;
```

- [ ] Snapshot optional clock through the strict helper before publishing it;
  keep standalone workerAdmissionMetrics compatible with absent clock.
- [ ] Add optional API clock contract and projection validation using existing
  descriptor-based patterns, preserving exact metrics v1. API fixtures exercise
  absent, valid, extra-key, malformed-version and timestamp chronology cases.
- [ ] Run factory and DB projection tests to GREEN, `npm run check:backend` and
  scoped eslint. Document additive reader/writer rollout; commit scoped changes.

## Task 4 — Independent stopped comparison and runbook

Files: scripts/lib/mainnet-observe-canary-verdict.ts;
tests/mainnet-observe-canary-verdict.test.ts;
tests/mainnet-observe-canary-cli.test.ts;
tests/transaction-inbox.repository.test.ts;
docs/operations/block-hydration-canary.md.

- [ ] Extend passingWorkerAdmissionFixture with matched snapshot clocks and proof:

```ts
{
  version: 1,
  sampledAtMs: stoppedClock.sampledAtMs,
  claimableBacklogCount: stoppedMetrics.claimableBacklogCount,
}
```

  Here stoppedClock/stoppedMetrics are the fixture's existing stopped fields,
  not constants copied from observation time. Add RED variants deleting proof or
  clock, timestamp+1 with equal counts, mismatched third count, malformed fields,
  chronological violations, and legacy input with matching old scalar only.
- [ ] Add optional snapshot/stopped/root keys and strict nested parsers. Preserve
  existing input/result v1 and scalar parser. Missing proof/clock produces
  WORKER_ADMISSION_POST_STOP_EVIDENCE_MISSING; malformed proof produces
  WORKER_ADMISSION_POST_STOP_EVIDENCE_MALFORMED; unequal valid timestamps produce
  WORKER_ADMISSION_POST_STOP_CLOCK_INCOHERENT; unequal counts retain existing
  WORKER_ADMISSION_POST_STOP_COUNT_INCOHERENT. No malformed field is ignored.
- [ ] Require exact paired times and all three counts before successful worker
  verdict. Keep existing growth, partitions, age, startup equality and p95 tests.
- [ ] Parameterize independent runbook SQL with the recorded clock:

```sql
WITH database_clock AS MATERIALIZED (
  SELECT to_timestamp($1::NUMERIC / 1000) AS at
)
```

  Return that same sampledAtMs and the independently calculated claimable count;
  retain existing eligibility SQL exactly. Capture only after writers stop and
  before teardown. No claim of historical MVCC snapshot or row-identity proof.
- [ ] Add deterministic DB boundary tests using repository fixture helpers:
  retry/lease t and t+1, launch44999/45000ms, eligible_until=t. Repeat independent
  query at bound t after time advances. Mutate a relevant row and assert mismatch.
- [ ] Run verdict/CLI tests and DB boundary cases to GREEN. Preserve historical
  fixtures without rewriting their evidence or FAIL results. Commit scoped work.

## Task 5 — Private harness, full validation and one delivery review

- [ ] In the excluded historical .codex-mainnet-canary.mjs, update explicit key
  lists/projections and manifest construction for both sidecars. Bind independent
  SQL to the recorded stopped clock. Validate syntax with `node --check`; never
  execute the capture or read its environment in this task. Keep it uncommitted.
- [ ] Recheck disk before and during expensive work. At<=5,000,000,000 bytes pause
  producers, clean only verified disposable task artifacts, resume above threshold.
- [ ] Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`,
  `git diff --check`, and `npm test` with BOTH disposable PostgreSQL URLs. Record
  all pass/fail/skip totals; do not present missing DB coverage as success.
- [ ] Perform ONE combined independent code/spec review, fix actionable findings,
  rerun affected gates, then create PR linked to #140. No extra review cycle.
- [ ] Merge only exact reviewed head with green CI and no blocking threads;
  fetch origin and monitor post-merge CI. Preserve dirty root main and worktree.
- [ ] Update local excluded tracking. Decoder compatibility and fresh bounded
  canary remain separate outstanding work; no capacity or trading claim follows.
