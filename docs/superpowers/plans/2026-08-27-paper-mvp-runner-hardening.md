# Paper MVP Runner Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fence every Paper MVP mutation by continuous runner ownership and persist canonical non-PASS reports for timeout and signal completion.

**Architecture:** A lifecycle guard stops bootstrap at every asynchronous boundary, while an opaque lease owner token fences repository writes after replacement. An additive migration persists ownership and completion reason; the report domain treats non-target completion as degraded validation output and preserves legacy reports during backfill.

**Tech Stack:** TypeScript, Node.js, PostgreSQL migrations and advisory locks, `node:test`, npm verification scripts.

---

## File map

- `src/domain/paper-mvp.ts`: completion-reason type, report field, gates, and non-target verdict semantics.
- `src/ports/paper-mvp-repository.ts`: owner-fenced commands and durable completion fields.
- `src/storage/paper-mvp.repository.ts`: claim ownership, reject stale writes, persist/recompute completion reason.
- `src/application/paper-mvp-collector.ts`: carry owner identity through progress collection.
- `src/app.ts`: reusable lifecycle guard and startup checkpoints.
- `src/cli/paper-mvp-runtime.ts`: lease owner generation and bootstrap lifecycle guard.
- `src/cli/paper-mvp.ts`: operation checkpoints and canonical timeout/signal completion.
- `migrations/021_paper_mvp_runner_hardening.sql`: additive ownership and completion schema/backfill.
- `tests/paper-mvp*.test.ts`, `tests/listener-runtime.test.ts`, `tests/bootstrap-safety.test.ts`: focused domain, storage, CLI, and lifecycle coverage.
- `tests/copy-migrations.test.ts`, `tests/migration-contract.test.ts`, `tests/deployment-artifacts.test.ts`, `scripts/deployment-smoke.mjs`: compiled/deployment migration inventory.
- `docs/operations/paper-mvp-validation.md`, `docs/operations/deployment.md`: operator-facing exit and schema semantics.

### Task 1: Completion-reason domain contract

**Files:**
- Modify: `src/domain/paper-mvp.ts`
- Test: `tests/paper-mvp.test.ts`

- [ ] **Step 1: Write failing report tests**

Add a table test that calls `createPaperMvpReport` with `TIMEOUT`, `SIGINT`, and `SIGTERM` and asserts the exact completion field, gate, degraded status, and failed verdict:

```ts
assert.equal(report.completionReason, reason);
assert.equal(report.technicalStatus, 'DEGRADED');
assert.equal(report.verdict, 'FAIL');
assert.ok(report.failedGateCodes.includes(
  reason === 'TIMEOUT' ? 'RUN_TIMED_OUT' : 'RUN_INTERRUPTED',
));
```

Add a legacy regression assertion that `LEGACY` does not add an interruption gate and leaves the prior verdict/status algorithm unchanged.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- --run tests/paper-mvp.test.ts`

Expected: TypeScript/test failure because `completionReason`, `RUN_TIMED_OUT`, and `RUN_INTERRUPTED` do not exist.

- [ ] **Step 3: Implement the minimal report semantics**

Add the exported union, require it on `CreatePaperMvpReportInput`, expose it on `PaperMvpReportV1`, extend `PaperMvpGateCode`, and apply the reason after existing gates:

```ts
if (input.completionReason === 'TIMEOUT') failed.push('RUN_TIMED_OUT');
if (input.completionReason === 'SIGINT' || input.completionReason === 'SIGTERM') {
  failed.push('RUN_INTERRUPTED');
}
const nonTarget = input.completionReason !== 'TARGET_REACHED'
  && input.completionReason !== 'LEGACY';
```

Return `completionReason`, force `DEGRADED` when `nonTarget`, and derive `FAIL` from the resulting gates. Update existing report fixtures to use `TARGET_REACHED`.

- [ ] **Step 4: Run the focused domain tests and confirm GREEN**

Run: `npm test -- --run tests/paper-mvp.test.ts`

Expected: all paper MVP domain tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/paper-mvp.ts tests/paper-mvp.test.ts
git commit -m "feat: classify paper MVP completion reasons (#49)"
```

### Task 2: Additive ownership/completion migration

**Files:**
- Create: `migrations/021_paper_mvp_runner_hardening.sql`
- Modify: `tests/paper-mvp-migration.test.ts`
- Modify: `tests/copy-migrations.test.ts`
- Modify: `tests/migration-contract.test.ts`
- Modify: `tests/deployment-artifacts.test.ts`
- Modify: `scripts/deployment-smoke.mjs`

- [ ] **Step 1: Write failing migration inventory and upgrade tests**

Expect migration 021 in source, compiled output, and deployment smoke inventory. Add PostgreSQL assertions for the new columns and constraints. Seed a `RUNNING`, `COMPLETED`, and `FAILED` row before applying 021, then assert:

```ts
assert.match(running.runner_owner_id, /^legacy:/u);
assert.equal(completed.completion_reason, 'LEGACY');
assert.equal(completed.report_payload.completionReason, 'LEGACY');
assert.deepEqual(completed.report_payload.failedGateCodes, historical.failedGateCodes);
assert.equal(completed.report_payload.verdict, historical.verdict);
assert.equal(completed.report_payload.technicalStatus, historical.technicalStatus);
assert.equal(failed.completion_reason, null);
```

Also assert replay succeeds and invalid state/owner/reason combinations fail.

- [ ] **Step 2: Run migration tests and confirm RED**

Run: `npm test -- --run tests/paper-mvp-migration.test.ts tests/copy-migrations.test.ts tests/migration-contract.test.ts tests/deployment-artifacts.test.ts`

Expected: failures because migration 021 and its schema are absent.

- [ ] **Step 3: Implement migration 021**

Create the two nullable columns, temporarily drop the terminal immutability trigger, backfill only the new compatibility fields, restore the trigger, and add constraints equivalent to:

```sql
CHECK (completion_reason IS NULL OR completion_reason IN
  ('TARGET_REACHED','TIMEOUT','SIGINT','SIGTERM','LEGACY'));
CHECK ((state='RUNNING' AND runner_owner_id IS NOT NULL AND completion_reason IS NULL)
  OR (state='COMPLETED' AND runner_owner_id IS NULL AND completion_reason IS NOT NULL
      AND report_payload->>'completionReason'=completion_reason)
  OR (state='FAILED' AND runner_owner_id IS NULL AND completion_reason IS NULL));
```

Use `jsonb_set(report_payload, '{completionReason}', '"LEGACY"'::jsonb, true)` so every prior report property is byte-semantically preserved. Add 021 to compiled/deployment inventories. Do not edit migration 020.

- [ ] **Step 4: Verify migration tests and migration 020 checksum**

Run: `npm test -- --run tests/paper-mvp-migration.test.ts tests/copy-migrations.test.ts tests/migration-contract.test.ts tests/deployment-artifacts.test.ts`

Expected: all selected tests pass.

Run: `shasum -a 256 migrations/020_paper_mvp_derived_pnl.sql`

Expected: `2456b5352ea45912ca1e5c53c27c82898261d5b0736ba0f9f9a85a83abdb976c`.

- [ ] **Step 5: Commit**

```bash
git add migrations/021_paper_mvp_runner_hardening.sql scripts/deployment-smoke.mjs tests/paper-mvp-migration.test.ts tests/copy-migrations.test.ts tests/migration-contract.test.ts tests/deployment-artifacts.test.ts
git commit -m "feat: persist paper MVP runner ownership (#49)"
```

### Task 3: Fence repository mutations

**Files:**
- Modify: `src/ports/paper-mvp-repository.ts`
- Modify: `src/storage/paper-mvp.repository.ts`
- Modify: `src/application/paper-mvp-collector.ts`
- Test: `tests/paper-mvp.repository.test.ts`
- Test: `tests/paper-mvp-collector.test.ts`

- [ ] **Step 1: Write failing owner replacement and completion tests**

Use owners `owner-a` and `owner-b`. Assert `startOrResume(configuration, 'owner-b', now)` claims the active row, then stale progress and terminalization from `owner-a` fail with `RUN_OWNERSHIP_LOST`. Assert owner-b succeeds, completed rows expose the durable reason, and canonical report recomputation rejects a mismatched reason.

- [ ] **Step 2: Run focused repository/collector tests and confirm RED**

Run: `npm test -- --run tests/paper-mvp.repository.test.ts tests/paper-mvp-collector.test.ts`

Expected: compile/test failures because repository commands have no owner identity.

- [ ] **Step 3: Implement owner-fenced ports and SQL**

Add `runnerOwnerId` and `completionReason` to `PaperMvpRun`. Change commands to:

```ts
startOrResume(configuration, runnerOwnerId, nowMs): Promise<PaperMvpRun>;
recordProgress({ ...progress, runnerOwnerId }): Promise<PaperMvpRun>;
terminalize({ ...terminalization, runnerOwnerId, completionReason }): Promise<PaperMvpRun>;
```

Under the existing row/advisory transaction locks, claim `runner_owner_id` in `startOrResume`, require exact ownership before progress/terminal writes, clear it on terminalization, and persist the completion reason. Pass the owner through `PaperMvpCollector.collect({ runId, runnerOwnerId, limit })`. Add `RUN_OWNERSHIP_LOST` to the stable conflict codes.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -- --run tests/paper-mvp.repository.test.ts tests/paper-mvp-collector.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ports/paper-mvp-repository.ts src/storage/paper-mvp.repository.ts src/application/paper-mvp-collector.ts tests/paper-mvp.repository.test.ts tests/paper-mvp-collector.test.ts
git commit -m "feat: fence paper MVP durable writes (#49)"
```

### Task 4: Guard bootstrap lifecycle continuously

**Files:**
- Modify: `src/app.ts`
- Modify: `src/cli/paper-mvp-runtime.ts`
- Test: `tests/listener-runtime.test.ts`
- Test: `tests/bootstrap-safety.test.ts`
- Test: `tests/paper-mvp-cli.test.ts`

- [ ] **Step 1: Write deterministic startup-loss tests**

Inject a guard whose `checkpoint()` throws `PaperMvpCliError('RUNNER_LOCK_LOST')`. Resolve the loss during migration and listener startup and assert no later startup stage runs, while any started listener closes. Add a runtime assertion that an acquired lease exposes a bounded unique `ownerId`.

- [ ] **Step 2: Run lifecycle tests and confirm RED**

Run: `npm test -- --run tests/listener-runtime.test.ts tests/bootstrap-safety.test.ts tests/paper-mvp-cli.test.ts`

Expected: failures because the lifecycle guard and lease owner do not exist.

- [ ] **Step 3: Implement lifecycle checkpoints and lease owner**

Add this dependency with a default no-op implementation:

```ts
readonly lifecycleGuard: Readonly<{ checkpoint(): Promise<void> }>;
```

Call it at every boundary specified in the design. Generate `ownerId` in `acquirePostgresRunner` with `randomUUID()`, expose it on `PaperMvpRunnerLease`, and have the Paper MVP bootstrap guard throw `RUNNER_LOCK_LOST` whenever `preparedLease.isLost()` is true.

- [ ] **Step 4: Run lifecycle tests and confirm GREEN**

Run: `npm test -- --run tests/listener-runtime.test.ts tests/bootstrap-safety.test.ts tests/paper-mvp-cli.test.ts`

Expected: all selected lifecycle tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/cli/paper-mvp-runtime.ts tests/listener-runtime.test.ts tests/bootstrap-safety.test.ts tests/paper-mvp-cli.test.ts
git commit -m "feat: guard paper MVP bootstrap ownership (#49)"
```

### Task 5: Canonicalize CLI stop completion

**Files:**
- Modify: `src/cli/paper-mvp.ts`
- Test: `tests/paper-mvp-cli.test.ts`

- [ ] **Step 1: Write failing boundary and late-target tests**

Add deterministic cases for loss before `startOrResume`, during the final collection, and immediately before terminalization. Assert the old owner never terminalizes or exports. Add timeout, SIGINT, and SIGTERM cases where final collection reaches the target and assert state `COMPLETED`, reason-specific non-PASS report, exported JSON, and exit 2.

- [ ] **Step 2: Run CLI tests and confirm RED**

Run: `npm test -- --run tests/paper-mvp-cli.test.ts`

Expected: current late-target stop cases produce failed/no report, and boundary loss is not continuously checked.

- [ ] **Step 3: Implement one guarded completion path**

Introduce a small ownership checkpoint:

```ts
function assertRunnerOwnership(lease: PaperMvpRunnerLease): void {
  if (lease.isLost()) throw new PaperMvpCliError('RUNNER_LOCK_LOST');
}
```

Call it before and after start/resume, collection, terminalization, durable reload, and report export. Pass `lease.ownerId` through every repository/collector command. Replace the stop-specific failed terminalization branch with `completeAndExport(snapshot, reason, ...)`; normal target completion passes `TARGET_REACHED`. On lock loss, skip catch-path terminalization so a stale process cannot abort the replacement owner.

- [ ] **Step 4: Run all Paper MVP tests and confirm GREEN**

Run: `npm test -- --run tests/paper-mvp.test.ts tests/paper-mvp-migration.test.ts tests/paper-mvp.repository.test.ts tests/paper-mvp-collector.test.ts tests/paper-mvp-cli.test.ts`

Expected: all selected tests pass with zero skips.

- [ ] **Step 5: Commit**

```bash
git add src/cli/paper-mvp.ts tests/paper-mvp-cli.test.ts
git commit -m "fix: preserve paper MVP interruption reports (#49)"
```

### Task 6: Operations documentation and full verification

**Files:**
- Modify: `docs/operations/paper-mvp-validation.md`
- Modify: `docs/operations/deployment.md`
- Modify as required by checks: Paper MVP fixtures that implement the changed typed ports

- [ ] **Step 1: Document operator-visible semantics**

Document the completion reason values, state/exit matrix, `LEGACY` compatibility-only meaning, resumability after ownership loss, and the 021 rollout requirement. Explicitly state that timeout/signals export degraded failing reports even when final collection reaches the sample target.

- [ ] **Step 2: Run focused and static gates**

Run: `npm run check && npm run lint && npm run build`

Expected: all commands exit 0.

- [ ] **Step 3: Run the complete suite with zero skips**

Run: `npm test`

Expected: every test passes and the summary reports `skipped 0`.

- [ ] **Step 4: Verify artifacts and immutable migration**

Run: `npm run docs:check && git diff --check && shasum -a 256 migrations/020_paper_mvp_derived_pnl.sql`

Expected: documentation and diff checks exit 0; checksum is `2456b5352ea45912ca1e5c53c27c82898261d5b0736ba0f9f9a85a83abdb976c`.

- [ ] **Step 5: Request independent review and address only verified findings**

Review the entire range `c8e74c42373427996d04c2156afc7cb84c45906e..HEAD` for Critical/Important correctness, safety, regression, and scope issues. Re-run affected focused tests after any fix.

- [ ] **Step 6: Commit final documentation/fixes**

```bash
git add docs/operations/paper-mvp-validation.md docs/operations/deployment.md
git commit -m "docs: explain paper MVP runner completion (#49)"
```

### Review cycle 1 hardening

- [x] Claim the durable owner after migrations and before listener/API startup.
- [x] Serialize replacement claims behind in-flight shared mutation fences.
- [x] Bound collection on deadline, signals, second signal, and lease loss.
- [x] Retain active-run launch and rejected-candidate coverage inputs.
- [x] Add migration 022 coverage indexes and bounded materialized sets.
- [x] Validate provider credits as hostile-safe unsigned `NUMERIC(78,0)` values.
- [ ] Run the complete PostgreSQL-backed and frontend verification matrix.
