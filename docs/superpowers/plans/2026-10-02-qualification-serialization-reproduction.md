# Qualification Serialization Reproduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch additional reviewers: the user authorized one later code-review cycle for this PR.

**Goal:** Establish two deterministic PostgreSQL serialization-conflict mechanisms with real writers, without modifying production behavior or claiming the canary failures are resolved.

**Architecture:** Add two integration cases to the existing qualification repository test file, reusing its authority, canonical projection builder, counts, migration and schema helpers. A real qualification transaction pauses after loading its snapshot while a second session commits either a cross-mint launch or an unchanged source replay. A test-only driver adapter records closed failure labels and forwards the original error unchanged.

**Tech Stack:** TypeScript, node:test, pg, existing PostgreSQL migrations and repository writers.

---

## Scope and execution gate

Specification: `docs/superpowers/specs/2026-10-02-qualification-serialization-reproduction-design.md` at commit `27431d1`.

Tracking issue: **#207**, covering reproduction and the subsequently approved correction on this same branch. Do not open a test-only PR or close #207 based solely on successful reproduction.

Worktree: `/Users/haythem.mabrouk/workspace/perso/sol-token-listener/.worktrees/qualification-terminal-attribution`; branch `fix/qualification-serialization`.

Only implementation file: `tests/qualification-projection.repository.test.ts`. Update the specification's evidence section after observing results, preserving its distinction between a possible mechanism and historical attribution. No `src/`, migration, settings, retry, isolation, worker, cache or RPC change belongs to this reproduction revision.

Do not execute any database command while the Mainnet canary is active. After its shutdown and cleanup are independently confirmed, reuse the single approved bounded, disk-backed disposable PostgreSQL container. Obtain its actual `TEST_DATABASE_URL` from the main agent; do not invent a target, connect to the canary database, create a second container or change resource limits. The commands below deliberately do not provision or destroy a container.

The cross-mint trigger mechanism has priority. `migrations/006_api_event_stream.sql` takes a global sequencing lock before updating `api_event_stream_state(id=1)` in the domain-event trigger. This preserves committed publication order and resumable SSE semantics; replacing the lock with a sequence is not within scope. The qualification mint lock precedes its Repeatable Read transaction and must remain there.

Existing contrast, not a proposed correction: wallet graph retries its whole transaction at most three times using trusted serialization/deadlock attribution and delays 10/20 ms; participant analytics uses plain `BEGIN` without such retry; launchpad retries up to three attempts more broadly. No existing policy is automatically appropriate for qualification.

## Task 1: Add isolated test fixtures and the closed driver probe

**Files:** Modify `tests/qualification-projection.repository.test.ts`, next to its existing live PostgreSQL tests/helpers.

- [ ] Add these imports; preserve all existing imports.

```ts
import { createTokenLaunchDetectedEvent } from '../src/domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import { trustedTerminalAttribution } from '../src/domain/terminal-attribution.js';
import type { LaunchpadEventBatch } from '../src/ports/launchpad-event-sink.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import type { QualificationProjectionPool } from '../src/storage/qualification-projection.repository.js';
```

- [ ] Add a launch-only batch builder. Seed **both scenarios** through `PostgresLaunchpadEventRepository.record`; do not replay `insertLiveLaunch` fixtures through this writer because their synthetic IDs/raw payloads are not its canonical fingerprints. Reuse existing `qualificationService`, `canonicalProjectionFromSnapshot`, `liveCounts` and `quoteIdentifier` unchanged.

```ts
function serializationLaunchBatch(
  mint: string,
  signature: string,
  observedAtMs: number,
): LaunchpadEventBatch {
  const transaction = {
    signature,
    confirmationStatus: 'confirmed' as const,
    blockTimeMs: observedAtMs - 100,
    observedAtMs,
    cursor: { slot: 10n, transactionIndex: 0 },
    raw: null,
  };
  const launch = createTokenLaunchDetectedEvent({
    source: 'pumpfun', program: 'pump', transaction,
    launch: {
      mint, creator: 'creator', tokenProgram: 'SPL_TOKEN',
      quoteAssets: [{ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' }],
      launchpad: 'pumpfun',
      createdAt: { ...transaction.cursor, instructionIndex: 1, innerInstructionIndex: null },
      parameters: {},
    },
  });
  return {
    source: 'pumpfun', program: 'pump', signature,
    confirmationStatus: 'confirmed', stateTransitionAction: 'apply',
    events: [launch], transitions: [createInitialDetectedTransition(launch)],
  };
}

type SerializationQueryLabel = 'SOURCE_MAPPING' | 'DOMAIN_EVENT_INSERT' | 'OTHER';
type SerializationDriverFailure = Readonly<{
  operation: SerializationQueryLabel;
  sqlstate: '40001' | '40P01' | 'OTHER';
}>;

function serializationQueryLabel(sql: string): SerializationQueryLabel {
  if (sql.includes('/* qualification_source_mapping */')) return 'SOURCE_MAPPING';
  if (/^INSERT INTO domain_events\s*\(/u.test(sql.trim())) return 'DOMAIN_EVENT_INSERT';
  return 'OTHER';
}

function serializationProbe(
  pool: pg.Pool,
  failures: SerializationDriverFailure[],
): QualificationProjectionPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: readonly unknown[]) {
          try {
            return await client.query(sql, values === undefined ? undefined : [...values]);
          } catch (error: unknown) {
            const descriptor = typeof error === 'object' && error !== null
              ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
            const code: unknown = descriptor !== undefined && 'value' in descriptor
              ? descriptor.value : undefined;
            failures.push({
              operation: serializationQueryLabel(sql),
              sqlstate: code === '40001' || code === '40P01' ? code : 'OTHER',
            });
            throw error;
          }
        },
        release(error?: Error | boolean) { client.release(error); },
      };
    },
  };
}

function serializationGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function serializationSourceVersions(pool: pg.Pool, mint: string) {
  const result = await pool.query<{
    event_id: string; raw_event_id: string; domain_xmin: string; raw_xmin: string;
    domain_status: string; raw_status: string;
  }>(`SELECT d.event_id,d.raw_event_id,d.xmin::text AS domain_xmin,
      r.xmin::text AS raw_xmin,d.confirmation_status AS domain_status,
      r.confirmation_status AS raw_status
    FROM domain_events d JOIN raw_chain_events r ON r.event_id=d.raw_event_id
    WHERE d.mint=$1 AND d.type='TokenLaunchDetected'`, [mint]);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function serializationStreamState(pool: pg.Pool) {
  const result = await pool.query<{ last_sequence: string; state_xmin: string }>(
    'SELECT last_sequence::text,state.xmin::text AS state_xmin FROM api_event_stream_state state WHERE id=1',
  );
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function assertSerializationMintUnlocked(pool: pg.Pool, mint: string) {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('qualification-projection:' || $1,0)) AS acquired",
      [mint],
    );
    locked = result.rows[0]?.acquired === true;
    assert.equal(locked, true);
  } finally {
    try {
      if (locked) {
        const result = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended('qualification-projection:' || $1,0)) AS released",
          [mint],
        );
        assert.equal(result.rows[0]?.released, true);
      }
    } finally { client.release(); }
  }
}
```

The adapter is applied only to the real qualification repository. It retains no SQL, parameters, error text or provider data. It does not synthesize an error or change its identity. The separate writer pool used below ensures lock verification cannot accidentally reacquire a leaked lock reentrantly on qualification's own session.

## Task 2: Add the two barrier-driven integration cases

**Files:** Modify `tests/qualification-projection.repository.test.ts`.

- [ ] Add these cases after the current live qualification concurrency test. The two cases share setup but have independent generated schemas and complete independent assertions. Node test execution is sequential; no nested concurrency option is enabled.

```ts
for (const scenario of ['CROSS_MINT_OUTBOX', 'UNCHANGED_SOURCE_REPLAY'] as const) {
  void test(`live PostgreSQL qualification serialization ${scenario}`, { timeout: 30_000 }, async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: serialization reproduction skipped');
      return;
    }
    const schema = `qualification_serialization_${randomUUID().replaceAll('-', '')}`;
    assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const options = `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=5000`;
    const qualificationPool = new pg.Pool({ connectionString: databaseUrl, max: 1, options });
    const writerPool = new pg.Pool({ connectionString: databaseUrl, max: 1, options });
    const ready = serializationGate();
    const resume = serializationGate();
    type Attempt = { ok: true; value: 'UPDATED' | 'UNCHANGED' } | { ok: false; error: unknown };
    let attempt: Promise<Attempt> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await migrateDatabase({ pool: writerPool });
      const mintA = '11111111111111111111111111111111';
      const mintB = 'So11111111111111111111111111111111111111112';
      const observedAtMs = Date.now();
      const batchA = serializationLaunchBatch(mintA, 'serialization-a', observedAtMs);
      const batchB = serializationLaunchBatch(mintB, 'serialization-b', observedAtMs);
      const writer = new PostgresLaunchpadEventRepository(writerPool);
      assert.deepEqual((await writer.record(batchA)).events.map((event) => event.outcome), ['created']);
      const sourceBefore = await serializationSourceVersions(writerPool, mintA);
      const streamBefore = await serializationStreamState(writerPool);
      const rebuilder = qualificationService();
      const failures: SerializationDriverFailure[] = [];
      const repository = new PostgresQualificationProjectionRepository(
        serializationProbe(qualificationPool, failures), rebuilder,
      );
      const rawAttempt = repository.transact(mintA, async (transaction) => {
        const snapshot = await transaction.loadCanonicalInput(mintA);
        assert.ok(snapshot);
        ready.release();
        await resume.promise;
        return transaction.replaceProjection(canonicalProjectionFromSnapshot(rebuilder, snapshot));
      });
      // Handle rejection immediately, including a failure before reaching the barrier.
      attempt = rawAttempt.then(
        (value): Attempt => ({ ok: true, value }),
        (error: unknown): Attempt => ({ ok: false, error }),
      );
      await Promise.race([
        ready.promise,
        attempt.then((outcome) => {
          if (!outcome.ok) throw outcome.error;
          throw new Error('Qualification completed before the snapshot barrier');
        }),
      ]);
      let committedSource: Awaited<ReturnType<typeof serializationSourceVersions>>;
      let committedStream: Awaited<ReturnType<typeof serializationStreamState>>;
      try {
        if (scenario === 'CROSS_MINT_OUTBOX') {
          assert.deepEqual((await writer.record(batchB)).events.map((event) => event.outcome), ['created']);
          committedSource = await serializationSourceVersions(writerPool, mintB);
          assert.deepEqual(await serializationSourceVersions(writerPool, mintA), sourceBefore);
          committedStream = await serializationStreamState(writerPool);
          assert.ok(BigInt(committedStream.last_sequence) > BigInt(streamBefore.last_sequence));
          assert.notEqual(committedStream.state_xmin, streamBefore.state_xmin);
        } else {
          assert.deepEqual((await writer.record(batchA)).events.map((event) => event.outcome), ['duplicate']);
          committedSource = await serializationSourceVersions(writerPool, mintA);
          assert.notEqual(committedSource.domain_xmin, sourceBefore.domain_xmin);
          assert.deepEqual({ ...committedSource, domain_xmin: sourceBefore.domain_xmin }, sourceBefore);
          committedStream = await serializationStreamState(writerPool);
          assert.deepEqual(committedStream, streamBefore);
        }
      } finally { resume.release(); }

      const outcome = await attempt;
      assert.equal(outcome.ok, false, 'Counterexample: expected serialization rejection did not occur');
      if (outcome.ok) throw new Error('Unexpected successful qualification transaction');
      assert.ok(outcome.error instanceof QualificationProjectionRepositoryError);
      assert.equal(trustedTerminalAttribution(outcome.error)?.diagnosticCode,
        'QUALIFICATION_POSTGRES_SERIALIZATION');
      assert.deepEqual(failures, [{
        operation: scenario === 'CROSS_MINT_OUTBOX' ? 'DOMAIN_EVENT_INSERT' : 'SOURCE_MAPPING',
        sqlstate: '40001',
      }]);
      assert.deepEqual(await liveCounts(writerPool), ['0', '0', '0', '0']);
      assert.deepEqual(await serializationStreamState(writerPool), committedStream);
      assert.deepEqual(await serializationSourceVersions(writerPool,
        scenario === 'CROSS_MINT_OUTBOX' ? mintB : mintA), committedSource);
      const committedEvent = await writerPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM api_event_stream WHERE domain_event_id=$1',
        [committedSource.event_id],
      );
      assert.equal(committedEvent.rows[0]?.count, '1');
      await assertSerializationMintUnlocked(writerPool, mintA);

      // Re-read all evidence in each fresh transaction; never reuse failed snapshot/projection.
      const rebuildFresh = () => repository.transact(mintA, async (transaction) => {
        const snapshot = await transaction.loadCanonicalInput(mintA);
        assert.ok(snapshot);
        const projection = canonicalProjectionFromSnapshot(rebuilder, snapshot);
        const kind = await transaction.replaceProjection(projection);
        return { kind, reportId: projection.reportId, eventId: projection.qualificationEvent.id };
      });
      const rebuilt = await rebuildFresh();
      assert.equal(rebuilt.kind, 'UPDATED');
      const afterRebuild = await serializationStreamState(writerPool);
      assert.deepEqual(await liveCounts(writerPool), ['1', '1', '1', '1']);
      const replayed = await rebuildFresh();
      assert.deepEqual(replayed, { ...rebuilt, kind: 'UNCHANGED' });
      assert.deepEqual(await liveCounts(writerPool), ['1', '1', '1', '1']);
      assert.deepEqual(await serializationStreamState(writerPool), afterRebuild);
      const linked = await writerPool.query<{ count: string }>(`SELECT COUNT(*)::text AS count
        FROM qualification_reports report
        JOIN domain_events event ON event.event_id=report.qualification_event_id
        JOIN api_event_stream stream ON stream.domain_event_id=event.event_id
        WHERE report.report_id=$1 AND event.event_id=$2 AND report.mint=$3
          AND report.superseded_at IS NULL AND report.confirmation_status='confirmed'
          AND event.confirmation_status='confirmed' AND stream.confirmation_status='confirmed'`,
      [rebuilt.reportId, rebuilt.eventId, mintA]);
      assert.equal(linked.rows[0]?.count, '1');
      assert.equal(failures.length, 1);
      await assertSerializationMintUnlocked(writerPool, mintA);
    } finally {
      // Release the application barrier before draining sessions or dropping the schema.
      resume.release();
      try {
        if (attempt !== undefined) await attempt;
      } finally {
        const drained = await Promise.allSettled([qualificationPool.end(), writerPool.end()]);
        try {
          // If a pool cannot drain, retain its isolated schema for investigation.
          assert.ok(drained.every((result) => result.status === 'fulfilled'), 'Workload pools did not drain');
          await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
        } finally { await admin.end(); }
      }
    }
  });
}
```

- [ ] Check TypeScript/lint without a database. These are proposed execution commands, not commands already run while drafting this plan.

```sh
env -u TEST_DATABASE_URL npm run check:backend
env -u TEST_DATABASE_URL npx eslint tests/qualification-projection.repository.test.ts --max-warnings=0
env -u TEST_DATABASE_URL node --import tsx --test --test-concurrency=1 tests/qualification-projection.repository.test.ts tests/qualification-terminal-diagnostics.test.ts
```

Expected: compile/lint pass, existing non-DB cases pass, live tests explicitly skip. A skipped integration case is not evidence for either mechanism.

## Task 3: Run after canary cleanup, interpret without forcing the result

**Files:** Test `tests/qualification-projection.repository.test.ts`; record observed evidence in the specification.

- [ ] Confirm the canary has finished and all canary sessions/containers have been cleaned up before accepting the approved disposable database URL. Ensure it is not a production/canary URL. Check the existing one-container resource/disk policy with the main agent; this plan authorizes no provisioning command.

- [ ] Execute each reproduction independently, then together. The environment guard prevents silently succeeding through skips when the URL is absent.

```sh
test -n "$TEST_DATABASE_URL"
node --import tsx --test --test-concurrency=1 --test-name-pattern='qualification serialization CROSS_MINT_OUTBOX' tests/qualification-projection.repository.test.ts
node --import tsx --test --test-concurrency=1 --test-name-pattern='qualification serialization UNCHANGED_SOURCE_REPLAY' tests/qualification-projection.repository.test.ts
node --import tsx --test --test-concurrency=1 --test-name-pattern='qualification serialization' tests/qualification-projection.repository.test.ts
```

Expected hypothesis-confirming result: A observes one `DOMAIN_EVENT_INSERT/40001`; B observes one `SOURCE_MAPPING/40001`. Both then independently prove successful fresh reconstruction, lock release and unchanged exact replay. These are characterization tests: a passing test asserts an expected rejection, not a production fix. Do not make a production change merely to create a conventional red/green sequence.

If a test fails before the barrier or before the conflicting writer commits, correct only fixture/harness defects after diagnosing them. If the intended interleaving is established and the boundary differs or succeeds, retain that counterexample, describe the exact observed closed label and invariants, and revise/version the causal design before adding a correction. Do not relax assertions to count an unrelated 40001 as proof.

- [ ] Run adjacent database suites serially against that same disposable instance, then static validation and the complete project/CI suites before merge.

```sh
node --import tsx --test --test-concurrency=1 tests/qualification-projection.repository.test.ts tests/qualification-terminal-diagnostics.test.ts tests/qualification-projection.service.test.ts tests/launchpad-event.repository.test.ts tests/api-event-stream-migration.test.ts
npm run check
npm run lint
npm run build
node --import tsx --test --test-concurrency=1 tests/*.test.ts
npm test --workspace frontend
npm run docs:check
git diff --check
```

Expected: all selected integration tests execute rather than skip; no duplicate publication or failed cleanup; full CI passes. Stop and diagnose infrastructure/resource errors rather than raising workers or starting another database. Backend tests are intentionally serialized locally to keep the disposable database bounded.

- [ ] Record the actual PostgreSQL version used, test commands, pass/fail/skip counts, each observed failure label, rollback/lock/replay results and any counterexample in the specification. State explicitly that successful reproduction establishes possible mechanisms, not attribution of every historical canary failure or capacity success.

- [ ] Main agent self-review: compare specification requirements to the assertions, inspect failure paths and barrier drainage, check no production/migration diff and no new runtime logging. Preserve the one later code-review cycle; no new reviewers or premature PR is required by this plan.

- [ ] Version a corrective design only after these observations; obtain its approval before implementation. Retain this investigation and the resulting approved correction on the focused branch. Commit/push/PR/merge remain the main workflow's responsibility, not an action authorized for the plan-writing subtask.

## Self-review checklist

Main-agent pre-implementation self-review completed: existing helper signatures,
global qualification-only counts and the real launchpad writer contract were
checked against the proposed fixtures. This is plan validation, not execution
evidence; tests must still establish each hypothesized failure independently.

- [ ] Cross-mint source revisions unchanged; stream singleton physically updated.
- [ ] Unchanged-source replay uses the original real batch; domain xmin changes but raw identity/status and outbox state remain unchanged.
- [ ] Query labels closed and test-only; diagnostic error is the actual driver's error propagated through the repository.
- [ ] Complete rollback means report, qualification event and qualification SSE counts all zero, while writer B's committed publication remains.
- [ ] Lock release checked from a distinct writer session, not the qualification connection.
- [ ] Every failure path releases `resume` before awaiting the qualification attempt and ending pools; all workload sessions finish before generated-schema deletion.
- [ ] Fresh reconstruction and exact replay load new snapshots and compare deterministic IDs, finality and one linked publication.
- [ ] Current lock order, coherent snapshots, global commit-ordered SSE allocator, finality, retention and idempotence remain unchanged.
- [ ] No canary-overlapping database execution; no production correction or historical-causality claim hidden in this plan.
