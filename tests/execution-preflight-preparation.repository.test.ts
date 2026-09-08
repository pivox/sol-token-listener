import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { ClaimedExecutionPreflightPreparation } from '../src/domain/execution-preflight-preparation.js';
import { createExecutionPreflightPreparationIdentity } from '../src/domain/execution-preflight-preparation.js';
import {
  ExecutionPreflightPreparationPostgresRepository,
  ExecutionPreflightPreparationRepositoryError,
  type ExecutionPreflightPreparationPool,
} from '../src/storage/execution-preflight-preparation.repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import { insertExecutionDecisionEvent } from './helpers/execution-decision-event.js';

const NOW_MS = 1_789_000_000_000;
const DEADLINE_MS = NOW_MS + 45_000;
const LEASE_EXPIRES_AT_MS = NOW_MS + 30_000;
const LEASE_TOKEN = '00000000-0000-4000-8000-000000000001';
const IDENTITY = createExecutionPreflightPreparationIdentity(LEASE_TOKEN);
const RUN_ID = IDENTITY.runId;

void test('starts one database-watermarked preparation under a global selector fence', async () => {
  const client = new ScriptedClient([
    result([], null),
    result([], 1),
    result([], 0),
    result([claimRow()], 1),
    result([], null),
  ]);
  const repository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(client),
    () => LEASE_TOKEN,
  );

  const claim = await repository.startOrResume(Object.freeze({
    ownerId: 'h2j-test', selectionWindowMs: 45_000, leaseMs: 30_000,
  }));

  assert.equal(claim.preparation.state, 'WAITING');
  assert.equal(claim.preparation.watermarkAtMs, NOW_MS);
  assert.equal(claim.preparation.deadlineAtMs, DEADLINE_MS);
  assert.equal(claim.leaseExpiresAtMs, LEASE_EXPIRES_AT_MS);
  assert.equal(client.calls[0]?.text, 'BEGIN');
  assert.match(client.calls[1]?.text ?? '', /pg_advisory_xact_lock/u);
  assert.match(client.calls[2]?.text ?? '', /WHERE state IN \('WAITING','PREPARING'\)/u);
  assert.match(client.calls[3]?.text ?? '', /statement_timestamp\(\)/u);
  assert.deepEqual(
    client.calls[3]?.values?.slice(-4),
    [45_000, 'h2j-test', LEASE_TOKEN, 30_000],
  );
  assert.equal(client.calls[4]?.text, 'COMMIT');
});

void test('selects only the first exact post-watermark pair without SKIP LOCKED', async () => {
  const claim = preparationClaim();
  const client = new ScriptedClient([
    result([], null),
    result([{ ...claimRow(), operation_at_ms: String(NOW_MS) }], 1),
    result([pairRow()], 1),
    result([parentLockRow()], 1),
    result([pairRow()], 1),
    result([claimRow({ state: 'PREPARING', stateRevision: 1n, pairId: 'pair-1' })], 1),
    result([], null),
  ]);
  const repository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(client),
    () => LEASE_TOKEN,
  );

  const selected = await repository.selectFirstPair(claim);

  assert.equal(selected?.pairId, 'pair-1');
  assert.equal(selected?.targetIntentId, 'target-1');
  assert.equal(selected?.simulationIntentId, 'probe-1');
  const selectionSql = client.calls[2]?.text ?? '';
  assert.match(selectionSql, /pair\.created_at > preparation\.watermark_at/u);
  assert.match(selectionSql, /ORDER BY pair\.created_at,pair\.pair_id/u);
  assert.match(selectionSql, /LIMIT 1/u);
  assert.match(selectionSql, /FOR UPDATE OF pair/u);
  assert.doesNotMatch(selectionSql, /SKIP LOCKED/u);
  assert.match(client.calls[3]?.text ?? '', /FOR UPDATE OF target,simulation/u);
  assert.doesNotMatch(client.calls[3]?.text ?? '', /execution_dry_run_assessments/u);
  assert.match(client.calls[4]?.text ?? '', /NOT EXISTS \(SELECT 1 FROM execution_dry_run_assessments/u);
  assert.doesNotMatch(client.calls[4]?.text ?? '', /FOR UPDATE/u);
  assert.match(client.calls[5]?.text ?? '', /WHERE preparation\.run_id=\$1/u);
});

void test('returns idle without selecting a replacement and rejects hostile options', async () => {
  const claim = preparationClaim();
  const client = new ScriptedClient([
    result([], null),
    result([{ ...claimRow(), operation_at_ms: String(NOW_MS) }], 1),
    result([], 0),
    result([], null),
  ]);
  const repository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(client),
    () => LEASE_TOKEN,
  );
  assert.equal(await repository.selectFirstPair(claim), null);
  assert.equal(client.calls.length, 4);

  const never = new NeverPool();
  const hostileRepository = new ExecutionPreflightPreparationPostgresRepository(
    never,
    () => LEASE_TOKEN,
  );
  await assert.rejects(
    hostileRepository.startOrResume({
      ownerId: 'h2j-test', selectionWindowMs: 45_000, leaseMs: 30_000,
    }),
    (error: unknown) => error instanceof ExecutionPreflightPreparationRepositoryError
      && error.code === 'INVALID_INPUT',
  );
  assert.equal(never.connections, 0);
});

void test('expires only the exact unpaired WAITING run at the DB handoff deadline', async () => {
  const waiting = preparationClaim();
  const beforeDeadlineClient = new ScriptedClient([
    result([], null),
    result([{ ...claimRow(), operation_at_ms: String(NOW_MS) }], 1),
    result([], null),
  ]);
  const beforeDeadline = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(beforeDeadlineClient),
    () => LEASE_TOKEN,
  );

  assert.equal(await beforeDeadline.expireWaitingWithoutPair(waiting), null);
  assert.equal(beforeDeadlineClient.calls[0]?.text, 'BEGIN');
  assert.match(beforeDeadlineClient.calls[1]?.text ?? '', /FOR UPDATE/u);
  assert.match(beforeDeadlineClient.calls[1]?.text ?? '', /preparation\.pair_id IS NULL/u);
  assert.match(beforeDeadlineClient.calls[1]?.text ?? '', /lease_expires_at=TIMESTAMPTZ 'epoch'/u);
  assert.doesNotMatch(beforeDeadlineClient.calls[1]?.text ?? '', /lease_expires_at>statement_timestamp/u);
  assert.equal(beforeDeadlineClient.calls[2]?.text, 'COMMIT');

  const expiredLease = Object.freeze({
    ...waiting,
    leaseExpiresAtMs: DEADLINE_MS - 5_000,
  });
  const deadlineClient = new ScriptedClient([
    result([], null),
    result([{
      ...claimRow(),
      lease_expires_at_ms: String(expiredLease.leaseExpiresAtMs),
      operation_at_ms: String(DEADLINE_MS - 5_000),
    }], 1),
    result([{
      ...preparationRow(),
      state: 'FAILED',
      state_revision: '1',
      failure_code: 'PREFLIGHT_PAIR_NOT_FOUND',
      updated_at_ms: String(DEADLINE_MS - 5_000),
      completed_at_ms: String(DEADLINE_MS - 5_000),
      purge_after_ms: String(DEADLINE_MS - 5_000 + 14_400_000),
    }], 1),
    result([], null),
  ]);
  const atDeadline = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(deadlineClient),
    () => LEASE_TOKEN,
  );

  const failed = await atDeadline.expireWaitingWithoutPair(expiredLease);

  assert.equal(failed?.state, 'FAILED');
  assert.equal(failed?.failureCode, 'PREFLIGHT_PAIR_NOT_FOUND');
  assert.match(deadlineClient.calls[2]?.text ?? '', /SET state='FAILED'/u);
  assert.match(deadlineClient.calls[2]?.text ?? '', /failure_code='PREFLIGHT_PAIR_NOT_FOUND'/u);
  assert.match(deadlineClient.calls[2]?.text ?? '', /state_revision=preparation\.state_revision\+1/u);
  assert.doesNotMatch(deadlineClient.calls[2]?.text ?? '', /lease_expires_at>statement_timestamp/u);
  assert.equal(deadlineClient.calls[3]?.text, 'COMMIT');
});

void test('PostgreSQL expires the same WAITING run after its lease at the handoff deadline',
  { timeout: 20_000 }, async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: waiting expiry integration skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, 'preflight_waiting_expiry', async (pool) => {
      await migrateDatabase({ pool });
      const repository = new ExecutionPreflightPreparationPostgresRepository(pool);
      const started = await repository.startOrResume(Object.freeze({
        ownerId: 'waiting-expiry-integration',
        selectionWindowMs: 10_001,
        leaseMs: 5_001,
      }));
      await new Promise<void>((resolve) => { setTimeout(resolve, 5_100); });

      const terminal = await repository.expireWaitingWithoutPair(started);

      assert.equal(terminal?.runId, started.preparation.runId);
      assert.equal(terminal?.pairId, null);
      assert.equal(terminal?.state, 'FAILED');
      assert.equal(terminal?.failureCode, 'PREFLIGHT_PAIR_NOT_FOUND');
      const stored = await repository.read(started.preparation.runId);
      assert.equal(stored?.state, 'FAILED');
      assert.equal(stored?.failureCode, 'PREFLIGHT_PAIR_NOT_FOUND');
    });
  });

void test('locks the first chronological pair before validating it and never substitutes another', async () => {
  const claim = preparationClaim();
  const client = new ScriptedClient([
    result([], null),
    result([{ ...claimRow(), operation_at_ms: String(NOW_MS) }], 1),
    result([pairRow()], 1),
    result([parentLockRow()], 1),
    result([], 0),
    result([{ run_id: RUN_ID }], 1),
    result([], null),
  ]);
  const repository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(client),
    () => LEASE_TOKEN,
  );

  await assert.rejects(
    repository.selectFirstPair(claim),
    (error: unknown) => error instanceof ExecutionPreflightPreparationRepositoryError
      && error.code === 'PREFLIGHT_PAIR_CONFLICT',
  );

  const firstPairSql = client.calls[2]?.text ?? '';
  assert.match(firstPairSql, /ORDER BY pair\.created_at,pair\.pair_id/u);
  assert.match(firstPairSql, /LIMIT 1/u);
  assert.match(firstPairSql, /FOR UPDATE OF pair/u);
  assert.doesNotMatch(firstPairSql, /JOIN execution_intents/u);
  assert.doesNotMatch(firstPairSql, /pair\.expires_at>statement_timestamp/u);
  assert.doesNotMatch(firstPairSql, /status='PENDING'/u);

  const parentLockSql = client.calls[3]?.text ?? '';
  assert.match(parentLockSql, /FOR UPDATE OF target,simulation/u);
  assert.doesNotMatch(parentLockSql, /execution_dry_run_assessments/u);

  const validationSql = client.calls[4]?.text ?? '';
  assert.match(validationSql, /WHERE pair\.pair_id=\$1/u);
  assert.doesNotMatch(validationSql, /FOR UPDATE/u);
  assert.match(validationSql, /pair\.expires_at>statement_timestamp\(\)\+INTERVAL '5 seconds'/u);
  assert.match(validationSql, /NOT EXISTS \(SELECT 1 FROM execution_dry_run_assessments/u);
  assert.match(client.calls[5]?.text ?? '', /SET state='FAILED'/u);
  assert.match(client.calls[5]?.text ?? '', /failure_code='PREFLIGHT_PAIR_CONFLICT'/u);
  assert.equal(client.calls[6]?.text, 'COMMIT');
});

void test('renews and fails only the exact preparation lease with monotone revisions', async () => {
  const waiting = preparationClaim();
  const renewedRow = claimRow();
  const renewedClient = new ScriptedClient([result([{
    ...renewedRow,
    state_revision: '1',
    updated_at_ms: String(NOW_MS + 1),
    lease_expires_at_ms: String(NOW_MS + 35_000),
  }], 1)]);
  const renewedRepository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(renewedClient),
    () => LEASE_TOKEN,
  );
  const renewed = await renewedRepository.renew(waiting, 20_000);
  assert.equal(renewed.preparation.stateRevision, 1n);
  assert.match(renewedClient.calls[0]?.text ?? '', /state_revision=preparation\.state_revision\+1/u);
  assert.deepEqual(renewedClient.calls[0]?.values?.slice(-1), [20_000]);

  const failedClient = new ScriptedClient([result([{
    ...preparationRow(),
    state: 'FAILED',
    state_revision: '1',
    failure_code: 'PREFLIGHT_RPC_CAPACITY_UNVERIFIED',
    completed_at_ms: String(NOW_MS + 1),
    purge_after_ms: String(NOW_MS + 1 + 14_400_000),
    updated_at_ms: String(NOW_MS + 1),
  }], 1)]);
  const failedRepository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(failedClient),
    () => LEASE_TOKEN,
  );
  const failed = await failedRepository.fail(waiting, 'PREFLIGHT_RPC_CAPACITY_UNVERIFIED');
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.failureCode, 'PREFLIGHT_RPC_CAPACITY_UNVERIFIED');
  assert.match(failedClient.calls[0]?.text ?? '', /lease_token=\$5::UUID/u);
});

void test('binds the unique exact target assessment with a fenced monotone CAS', async () => {
  const preparing = preparingClaim();
  const client = new ScriptedClient([result([claimRow({
    state: 'PREPARING', stateRevision: 2n, pairId: 'pair-1',
    assessmentId: `execution_dry_run_assessment_${'a'.repeat(64)}`,
    assessmentFingerprint: 'b'.repeat(64),
  })], 1)]);
  const repository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(client),
    () => LEASE_TOKEN,
  );

  const bound = await repository.bindTargetAssessment(preparing);

  assert.equal(bound.preparation.stateRevision, 2n);
  assert.equal(bound.preparation.assessmentFingerprint, 'b'.repeat(64));
  const sql = client.calls[0]?.text ?? '';
  assert.match(sql, /statement_timestamp\(\)/u);
  assert.match(sql, /FOR UPDATE OF preparation,pair,target/u);
  assert.match(sql, /member\.lane='TARGET'/u);
  assert.match(sql, /assessment\.specification_version='1\.4\.0'/u);
  assert.match(sql, /assessment\.outcome='FOUNDATION_VALIDATED'/u);
  assert.match(sql, /assessment\.coverage='INTENT_AND_LEASE_ONLY'/u);
  assert.match(sql, /target\.status='PENDING'/u);
  assert.match(sql, /target\.attempt_count=0 AND target\.state_revision=0/u);
  assert.match(sql, /target\.live_reserved=FALSE/u);
  assert.match(sql, /preparation\.state_revision IN \(\$2::BIGINT,\$2::BIGINT\+1\)/u);
  assert.match(sql, /assessment_id IS NULL/u);
  assert.match(sql, /assessment_id=proof\.assessment_id/u);
  assert.deepEqual(client.calls[0]?.values, claimValuesForTest(preparing));
});

void test('binds only a fresh successful attempt-one simulation artifact for the exact sibling', async () => {
  const preparing = preparingClaim({
    stateRevision: 2n,
    assessmentId: `execution_dry_run_assessment_${'a'.repeat(64)}`,
    assessmentFingerprint: 'b'.repeat(64),
  });
  const client = new ScriptedClient([result([claimRow({
    state: 'PREPARING', stateRevision: 3n, pairId: 'pair-1',
    assessmentId: preparing.preparation.assessmentId,
    assessmentFingerprint: preparing.preparation.assessmentFingerprint,
    artifactId: `execution_simulation_artifact_${'c'.repeat(64)}`,
    artifactFingerprint: 'd'.repeat(64),
  })], 1)]);
  const repository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(client),
    () => LEASE_TOKEN,
  );

  const bound = await repository.bindSimulationArtifact(preparing);

  assert.equal(bound.preparation.stateRevision, 3n);
  assert.equal(bound.preparation.artifactFingerprint, 'd'.repeat(64));
  const sql = client.calls[0]?.text ?? '';
  assert.match(sql, /FOR UPDATE OF preparation,pair,target,simulation/u);
  assert.match(sql, /simulation_member\.lane='SIMULATION'/u);
  assert.match(sql, /simulation\.status='SUCCEEDED'/u);
  assert.match(sql, /simulation\.attempt_count=1/u);
  assert.match(sql, /attempt\.attempt_number=1/u);
  assert.match(sql, /attempt\.status='COMPLETED'/u);
  assert.match(sql, /attempt\.reason_code='ATTEMPT_COMPLETED'/u);
  assert.match(sql, /artifact\.specification_version='1\.5\.0'/u);
  assert.match(sql, /artifact\.result_kind='SUCCESS'/u);
  assert.match(sql, /artifact\.effective_venue='PUMP_FUN'/u);
  assert.match(sql, /artifact\.terminal_reason_code='INTENT_SUCCEEDED'/u);
  assert.match(sql, /artifact\.amount_in_raw=simulation\.quote_amount_raw/u);
  assert.match(sql, /artifact\.protected_amount_out_raw>=simulation\.minimum_amount_out_raw/u);
  assert.match(sql, /artifact\.recorded_at>=operation\.at-INTERVAL '30 seconds'/u);
  assert.match(sql, /artifact\.recorded_at<preparation\.deadline_at/u);
  assert.match(sql, /artifact_id=proof\.artifact_id/u);
});

void test('marks the fully evidenced exact pair prepared with a closed frozen manifest input', async () => {
  const preparing = preparingClaim({
    stateRevision: 3n,
    assessmentId: `execution_dry_run_assessment_${'a'.repeat(64)}`,
    assessmentFingerprint: 'b'.repeat(64),
    artifactId: `execution_simulation_artifact_${'c'.repeat(64)}`,
    artifactFingerprint: 'd'.repeat(64),
  });
  const manifestFingerprint = 'e'.repeat(64);
  const client = new ScriptedClient([result([{
    ...preparationRowFromClaim(preparing),
    state: 'PREPARED',
    state_revision: '4',
    manifest_fingerprint: manifestFingerprint,
    updated_at_ms: String(NOW_MS + 2),
    completed_at_ms: String(NOW_MS + 2),
    purge_after_ms: String(NOW_MS + 2 + 14_400_000),
  }], 1)]);
  const repository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(client),
    () => LEASE_TOKEN,
  );

  const prepared = await repository.markPrepared(
    preparing,
    Object.freeze({ manifestFingerprint }),
  );

  assert.equal(prepared.state, 'PREPARED');
  assert.equal(prepared.stateRevision, 4n);
  assert.equal(prepared.manifestFingerprint, manifestFingerprint);
  const sql = client.calls[0]?.text ?? '';
  assert.match(sql, /FOR UPDATE OF preparation,pair,target,simulation/u);
  assert.match(sql, /preparation\.assessment_id IS NOT NULL/u);
  assert.match(sql, /preparation\.artifact_id IS NOT NULL/u);
  assert.match(sql, /SET state='PREPARED'/u);
  assert.match(sql, /manifest_fingerprint=\$6/u);
  assert.match(sql, /preparation\.state_revision IN \(\$2::BIGINT,\$2::BIGINT\+1\)/u);
  assert.doesNotMatch(sql, /SET[\s\S]*completed_at=/u);
  assert.doesNotMatch(sql, /SET[\s\S]*purge_after=/u);
  assert.doesNotMatch(sql, /SET[\s\S]*lease_owner=/u);

  const never = new NeverPool();
  const strictRepository = new ExecutionPreflightPreparationPostgresRepository(never);
  await assert.rejects(
    strictRepository.markPrepared(preparing, { manifestFingerprint }),
    (error: unknown) => error instanceof ExecutionPreflightPreparationRepositoryError
      && error.code === 'INVALID_INPUT',
  );
  assert.equal(never.connections, 0);
});

void test('PostgreSQL selects and crash-resumes the same exact pair', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: preparation repository integration skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'preflight_preparation_repo', async (pool) => {
    await migrateDatabase({ pool });
    const firstFactory = uuidSequence([
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000011',
    ]);
    const repository = new ExecutionPreflightPreparationPostgresRepository(pool, firstFactory);
    const targetId = `execution_intent_${'a'.repeat(64)}`;
    const simulationId = `execution_intent_${'b'.repeat(64)}`;
    const started = await repository.startOrResume(Object.freeze({
      ownerId: 'h2j-first', selectionWindowMs: 45_000, leaseMs: 30_000,
    }));

    await pool.query('SELECT pg_sleep(0.003)');
    await insertPairWithParents(pool, 'pair-after-watermark', targetId, simulationId);
    const selected = await repository.selectFirstPair(started);
    assert.equal(selected?.pairId, 'pair-after-watermark');
    assert.equal(selected?.preparation.preparation.state, 'PREPARING');

    const busyRepository = new ExecutionPreflightPreparationPostgresRepository(pool, uuidSequence([
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000013',
    ]));
    await assert.rejects(
      busyRepository.startOrResume(Object.freeze({
        ownerId: 'h2j-other', selectionWindowMs: 45_000, leaseMs: 30_000,
      })),
      (error: unknown) => error instanceof ExecutionPreflightPreparationRepositoryError
        && error.code === 'PREPARATION_BUSY',
    );

    await pool.query(`UPDATE execution_preflight_intent_preparation_runs
      SET lease_expires_at=date_trunc('milliseconds',statement_timestamp()),
        state_revision=state_revision+1
      WHERE run_id=$1`, [started.preparation.runId]);
    const resumed = await busyRepository.startOrResume(Object.freeze({
      ownerId: 'h2j-other', selectionWindowMs: 45_000, leaseMs: 20_000,
    }));
    assert.equal(resumed.preparation.runId, started.preparation.runId);
    assert.equal(resumed.preparation.pairId, 'pair-after-watermark');
    assert.equal(resumed.preparation.state, 'PREPARING');

    const recoveredSelection = await busyRepository.selectFirstPair(resumed);
    assert.equal(recoveredSelection?.pairId, 'pair-after-watermark');
    assert.equal(recoveredSelection?.targetIntentId, targetId);
    assert.equal(recoveredSelection?.simulationIntentId, simulationId);

    const selectedClaim = requiredValue(recoveredSelection).preparation;
    await insertTargetAssessment(pool, targetId);
    const assessed = await busyRepository.bindTargetAssessment(selectedClaim);
    const assessedReplay = await busyRepository.bindTargetAssessment(selectedClaim);
    assert.deepEqual(assessedReplay, assessed);

    await completeSimulationProbe(pool, simulationId);
    const simulated = await busyRepository.bindSimulationArtifact(assessed);
    const simulatedReplay = await busyRepository.bindSimulationArtifact(assessed);
    assert.deepEqual(simulatedReplay, simulated);

    const manifestFingerprint = '9'.repeat(64);
    const prepared = await busyRepository.markPrepared(
      simulated,
      Object.freeze({ manifestFingerprint }),
    );
    const preparedReplay = await busyRepository.markPrepared(
      simulated,
      Object.freeze({ manifestFingerprint }),
    );
    assert.deepEqual(preparedReplay, prepared);
    assert.equal(prepared.state, 'PREPARED');
    assert.equal(prepared.manifestFingerprint, manifestFingerprint);
    assert.equal(prepared.purgeAfterMs, requiredValue(prepared.completedAtMs) + 14_400_000);
    await assert.rejects(
      busyRepository.markPrepared(simulated, Object.freeze({ manifestFingerprint: '0'.repeat(64) })),
      (error: unknown) => error instanceof ExecutionPreflightPreparationRepositoryError
        && error.code === 'PREFLIGHT_PAIR_LINEAGE_INVALID',
    );
  });
});

void test('PostgreSQL refuses an invalid first pair instead of selecting a valid second', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: preparation repository integration skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'preflight_no_pair_substitution', async (pool) => {
    await migrateDatabase({ pool });
    const repository = new ExecutionPreflightPreparationPostgresRepository(pool, uuidSequence([
      '00000000-0000-4000-8000-000000000020',
      '00000000-0000-4000-8000-000000000021',
    ]));
    const started = await repository.startOrResume(Object.freeze({
      ownerId: 'h2j-first-only', selectionWindowMs: 45_000, leaseMs: 30_000,
    }));

    await pool.query('SELECT pg_sleep(0.003)');
    await insertPairWithParents(pool, 'pair-first-invalid', 'target-first', 'probe-first');
    await pool.query('SELECT pg_sleep(0.003)');
    await insertPairWithParents(pool, 'pair-second-valid', 'target-second', 'probe-second');
    await pool.query(`UPDATE execution_intents
      SET status='PROCESSING',last_reason_code='EXECUTION_STARTED',state_revision=1
      WHERE id='target-first'`);

    await assert.rejects(
      repository.selectFirstPair(started),
      (error: unknown) => error instanceof ExecutionPreflightPreparationRepositoryError
        && error.code === 'PREFLIGHT_PAIR_CONFLICT',
    );
    const stored = await repository.read(started.preparation.runId);
    assert.equal(stored?.state, 'FAILED');
    assert.equal(stored?.pairId, null);
    assert.equal(stored?.failureCode, 'PREFLIGHT_PAIR_CONFLICT');
  });
});

void test('PostgreSQL rechecks proofs after waiting on the exact parent locks', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: preparation repository integration skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'preflight_parent_lock_snapshot', async (pool) => {
    await migrateDatabase({ pool });
    const repository = new ExecutionPreflightPreparationPostgresRepository(pool, uuidSequence([
      '00000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000031',
    ]));
    const targetId = `execution_intent_${'3'.repeat(64)}`;
    const simulationId = `execution_intent_${'4'.repeat(64)}`;
    const started = await repository.startOrResume(Object.freeze({
      ownerId: 'h2j-parent-lock', selectionWindowMs: 45_000, leaseMs: 30_000,
    }));
    await pool.query('SELECT pg_sleep(0.003)');
    await insertPairWithParents(pool, 'pair-parent-lock', targetId, simulationId);

    const writer = await pool.connect();
    let selection: Promise<unknown> | null = null;
    let writerCommitted = false;
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM execution_intents WHERE id=$1 FOR UPDATE', [targetId]);
      selection = repository.selectFirstPair(started);
      await waitForBlockedParentLock(pool);
      await insertTargetAssessment(writer, targetId);
      await writer.query('COMMIT');
      writerCommitted = true;

      await assert.rejects(
        selection,
        (error: unknown) => error instanceof ExecutionPreflightPreparationRepositoryError
          && error.code === 'PREFLIGHT_PAIR_CONFLICT',
      );
      const stored = await repository.read(started.preparation.runId);
      assert.equal(stored?.state, 'FAILED');
      assert.equal(stored?.failureCode, 'PREFLIGHT_PAIR_CONFLICT');
    } catch (error) {
      if (!writerCommitted) {
        try { await writer.query('ROLLBACK'); } catch { /* preserve primary failure */ }
      }
      if (selection !== null) await selection.catch(() => undefined);
      throw error;
    } finally {
      writer.release();
    }
  });
});

function preparationClaim(): ClaimedExecutionPreflightPreparation {
  return Object.freeze({
    preparation: Object.freeze({
      payloadVersion: 1,
      runId: RUN_ID,
      runFingerprint: IDENTITY.runFingerprint,
      state: 'WAITING',
      stateRevision: 0n,
      watermarkAtMs: NOW_MS,
      deadlineAtMs: DEADLINE_MS,
      pairId: null,
      assessmentId: null,
      assessmentFingerprint: null,
      artifactId: null,
      artifactFingerprint: null,
      manifestFingerprint: null,
      failureCode: null,
      createdAtMs: NOW_MS,
      updatedAtMs: NOW_MS,
      selectedAtMs: null,
      completedAtMs: null,
      purgeAfterMs: null,
    }),
    leaseOwner: 'h2j-test',
    leaseToken: LEASE_TOKEN,
    leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
  });
}

function claimRow(overrides: Readonly<{
  state?: 'WAITING' | 'PREPARING';
  stateRevision?: bigint;
  pairId?: string | null;
  assessmentId?: string | null;
  assessmentFingerprint?: string | null;
  artifactId?: string | null;
  artifactFingerprint?: string | null;
}> = {}): Readonly<Record<string, unknown>> {
  return {
    run_id: RUN_ID,
    payload_version: 1,
    run_fingerprint: IDENTITY.runFingerprint,
    state: overrides.state ?? 'WAITING',
    state_revision: String(overrides.stateRevision ?? 0n),
    watermark_at_ms: String(NOW_MS),
    deadline_at_ms: String(DEADLINE_MS),
    pair_id: overrides.pairId ?? null,
    assessment_id: overrides.assessmentId ?? null,
    assessment_fingerprint: overrides.assessmentFingerprint ?? null,
    artifact_id: overrides.artifactId ?? null,
    artifact_fingerprint: overrides.artifactFingerprint ?? null,
    manifest_fingerprint: null,
    failure_code: null,
    created_at_ms: String(NOW_MS),
    updated_at_ms: String(NOW_MS),
    selected_at_ms: overrides.state === 'PREPARING' ? String(NOW_MS + 1) : null,
    completed_at_ms: null,
    purge_after_ms: null,
    lease_owner: 'h2j-test',
    lease_token: LEASE_TOKEN,
    lease_expires_at_ms: String(LEASE_EXPIRES_AT_MS),
  };
}

function preparingClaim(overrides: Readonly<{
  stateRevision?: bigint;
  assessmentId?: string | null;
  assessmentFingerprint?: string | null;
  artifactId?: string | null;
  artifactFingerprint?: string | null;
}> = {}): ClaimedExecutionPreflightPreparation {
  const waiting = preparationClaim();
  return Object.freeze({
    ...waiting,
    preparation: Object.freeze({
      ...waiting.preparation,
      state: 'PREPARING',
      stateRevision: overrides.stateRevision ?? 1n,
      pairId: 'pair-1',
      assessmentId: overrides.assessmentId ?? null,
      assessmentFingerprint: overrides.assessmentFingerprint ?? null,
      artifactId: overrides.artifactId ?? null,
      artifactFingerprint: overrides.artifactFingerprint ?? null,
      selectedAtMs: NOW_MS + 1,
      updatedAtMs: NOW_MS + 1,
    }),
  });
}

function claimValuesForTest(claim: ClaimedExecutionPreflightPreparation): readonly unknown[] {
  return [
    claim.preparation.runId,
    claim.preparation.stateRevision.toString(),
    claim.leaseOwner,
    claim.leaseToken,
    claim.leaseExpiresAtMs,
  ];
}

function preparationRowFromClaim(
  claim: ClaimedExecutionPreflightPreparation,
): Readonly<Record<string, unknown>> {
  return {
    run_id: claim.preparation.runId,
    payload_version: claim.preparation.payloadVersion,
    run_fingerprint: claim.preparation.runFingerprint,
    state: claim.preparation.state,
    state_revision: claim.preparation.stateRevision.toString(),
    watermark_at_ms: String(claim.preparation.watermarkAtMs),
    deadline_at_ms: String(claim.preparation.deadlineAtMs),
    pair_id: claim.preparation.pairId,
    assessment_id: claim.preparation.assessmentId,
    assessment_fingerprint: claim.preparation.assessmentFingerprint,
    artifact_id: claim.preparation.artifactId,
    artifact_fingerprint: claim.preparation.artifactFingerprint,
    manifest_fingerprint: claim.preparation.manifestFingerprint,
    failure_code: claim.preparation.failureCode,
    created_at_ms: String(claim.preparation.createdAtMs),
    updated_at_ms: String(claim.preparation.updatedAtMs),
    selected_at_ms: String(claim.preparation.selectedAtMs),
    completed_at_ms: claim.preparation.completedAtMs,
    purge_after_ms: claim.preparation.purgeAfterMs,
  };
}

function pairRow(): Readonly<Record<string, unknown>> {
  return {
    pair_id: 'pair-1',
    pair_fingerprint: 'b'.repeat(64),
    target_intent_id: 'target-1',
    simulation_intent_id: 'probe-1',
    decision_event_id: 'decision-1',
    decision_fingerprint: 'c'.repeat(64),
    pair_created_at_ms: String(NOW_MS + 1),
    pair_expires_at_ms: String(DEADLINE_MS + 15_000),
  };
}

function parentLockRow(): Readonly<Record<string, unknown>> {
  return { target_intent_id: 'target-1', simulation_intent_id: 'probe-1' };
}

function preparationRow(): Readonly<Record<string, unknown>> {
  const row = { ...claimRow() };
  delete row.lease_owner;
  delete row.lease_token;
  delete row.lease_expires_at_ms;
  return row;
}

interface QueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}

interface Call { readonly text: string; readonly values?: readonly unknown[] }

class ScriptedClient {
  public readonly calls: Call[] = [];
  public constructor(private readonly results: readonly QueryResult[]) {}
  public async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.calls.push(values === undefined ? { text } : { text, values });
    const next = this.results[this.calls.length - 1];
    if (next === undefined) throw new Error('Unexpected query.');
    return next;
  }
  public release(): void {}
}

class ScriptedPool implements ExecutionPreflightPreparationPool {
  public constructor(private readonly client: ScriptedClient) {}
  public async connect(): Promise<ScriptedClient> { return this.client; }
}

class NeverPool implements ExecutionPreflightPreparationPool {
  public connections = 0;
  public async connect(): Promise<never> {
    this.connections += 1;
    throw new Error('must not connect');
  }
}

function result(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount: number | null,
): QueryResult {
  return { rows, rowCount };
}

interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<Readonly<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number | null;
  }>>;
}

async function insertPairWithParents(
  pool: InstanceType<typeof pg.Pool>,
  pairId: string,
  targetId: string,
  simulationId: string,
): Promise<void> {
  const client = await pool.connect();
  const requestedAtMs = Date.now();
  const expiresAtMs = requestedAtMs + 60_000;
  try {
    await client.query('BEGIN');
    await insertIntent(client, targetId, 'TARGET', requestedAtMs, expiresAtMs);
    await insertIntent(client, simulationId, 'SIMULATION', requestedAtMs, expiresAtMs);
    await client.query(`INSERT INTO execution_preflight_intent_pairs (
      pair_id,payload_version,pair_fingerprint,target_intent_id,simulation_intent_id,
      decision_event_id,decision_fingerprint,expires_at
    ) VALUES ($1,1,$2,$3,$4,'decision-event',repeat('d',64),
      TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond'))`, [
      pairId,
      createHash('sha256').update(pairId).digest('hex'),
      targetId,
      simulationId,
      expiresAtMs,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve primary failure */ }
    throw error;
  } finally {
    client.release();
  }
}

async function insertIntent(
  client: Queryable,
  id: string,
  lane: 'TARGET' | 'SIMULATION',
  requestedAtMs: number,
  expiresAtMs: number,
): Promise<void> {
  const suffix = createHash('sha256').update(id).digest('hex');
  const command = lane === 'TARGET'
    ? `paper_open_${suffix}`
    : `execution_preflight_probe_${suffix}`;
  await insertExecutionDecisionEvent(
    client,
    'decision-event',
    '11111111111111111111111111111111',
  );
  await client.query(`INSERT INTO execution_intents (
    id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
    logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
    quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,
    decision_event_id,decision_fingerprint,requested_at,expires_at,status
  ) VALUES ($1,1,$2,'creation-entry-v1',1,'position',$2,
    '11111111111111111111111111111111','BUY','PUMP_FUN_ONLY',
    'So11111111111111111111111111111111111111112','SPL_TOKEN',9,500000,NULL,1,
    'decision-event',repeat('d',64),
    TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($4::BIGINT*INTERVAL '1 millisecond'),'PENDING')`, [
    id, command, requestedAtMs, expiresAtMs,
  ]);
}

async function insertTargetAssessment(pool: Queryable, intentId: string): Promise<void> {
  await pool.query(`INSERT INTO execution_dry_run_assessments (
    assessment_id,payload_version,specification_version,evaluator_version,intent_id,
    strategy_id,strategy_version,decision_fingerprint,intent_state_revision,intent_status,
    input_fingerprint,result_fingerprint,outcome,coverage,quote_status,build_status,
    simulation_status,signature_status,submission_status
  ) VALUES ($1,1,'1.4.0',1,$2,'creation-entry-v1',1,repeat('d',64),0,'PENDING',
    repeat('e',64),repeat('f',64),'FOUNDATION_VALIDATED','INTENT_AND_LEASE_ONLY',
    'NOT_RUN','NOT_RUN','NOT_RUN','NOT_RUN','NOT_RUN')`, [
    `execution_dry_run_assessment_${'c'.repeat(64)}`,
    intentId,
  ]);
}

async function completeSimulationProbe(pool: Queryable, intentId: string): Promise<void> {
  const publicKey = '11111111111111111111111111111111';
  await pool.query(`WITH operation AS MATERIALIZED (
    SELECT date_trunc('milliseconds',statement_timestamp()) AS at
  ), attempt AS MATERIALIZED (
    INSERT INTO execution_attempts (
      intent_id,attempt_number,status,effective_venue,provider_id,
      started_at,completed_at,reason_code
    ) SELECT $1,1,'COMPLETED','PUMP_FUN','integration-provider',
      operation.at-INTERVAL '1 millisecond',operation.at,'ATTEMPT_COMPLETED'
    FROM operation
    RETURNING intent_id
  ), artifact AS MATERIALIZED (
    INSERT INTO execution_simulation_artifacts (
      artifact_id,payload_version,specification_version,evaluator_version,intent_id,
      attempt_number,intent_state_revision,strategy_id,strategy_version,decision_fingerprint,
      result_kind,effective_venue,provider_id,executor_public_key,expected_genesis_hash,
      observed_genesis_hash,configuration_fingerprint,quote_fingerprint,snapshot_fingerprint,
      build_fingerprint,message_hash,blockhash,last_valid_block_height,blockhash_context_slot,
      snapshot_slot,fee_context_slot,simulation_slot,amount_in_raw,expected_amount_out_raw,
      protected_amount_out_raw,fees_raw,estimated_fee_lamports,
      simulated_fee_payer_lamport_debit,units_consumed,simulated_base_delta_raw,
      simulated_quote_delta_raw,rpc_calls_used,rpc_calls_limit,quote_status,build_status,
      simulation_status,failure_stage,failure_code,terminal_reason_code,logs_fingerprint,
      logs_line_count,result_fingerprint,recorded_at
    ) SELECT $2,1,'1.5.0',1,$1,1,1,'creation-entry-v1',1,repeat('d',64),
      'SUCCESS','PUMP_FUN','integration-provider',$3,$3,$3,repeat('1',64),repeat('2',64),
      repeat('3',64),repeat('4',64),repeat('5',64),$3,1000,900,899,900,901,
      500000,1000,900,10,5000,5000,200000,1000,-500000,5,8,
      'SUCCEEDED','SUCCEEDED','SUCCEEDED',NULL,NULL,'INTENT_SUCCEEDED',repeat('6',64),
      1,repeat('7',64),operation.at
    FROM operation JOIN attempt ON attempt.intent_id=$1
    RETURNING intent_id
  )
  UPDATE execution_intents AS intent
  SET status='SUCCEEDED',attempt_count=1,state_revision=3,
    last_reason_code='INTENT_SUCCEEDED',terminal_at=operation.at,
    reconciliation_completed_at=operation.at,purge_after=operation.at+INTERVAL '4 hours',
    updated_at=operation.at
  FROM operation JOIN artifact ON artifact.intent_id=$1
  WHERE intent.id=$1`, [
    intentId,
    `execution_simulation_artifact_${'8'.repeat(64)}`,
    publicKey,
  ]);
}

async function waitForBlockedParentLock(pool: Queryable): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const resultValue = await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM pg_catalog.pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
        AND cardinality(pg_catalog.pg_blocking_pids(pid))>0`);
    if (resultValue.rows.some((row) => row.count === 1)) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
  assert.fail('Preparation validation did not wait on the parent lock.');
}

function requiredValue<T>(value: T | null | undefined): T {
  assert.notEqual(value, null);
  assert.notEqual(value, undefined);
  return value as T;
}

function uuidSequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) return randomUUID();
    return value;
  };
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try {
      await pool.end();
    } finally {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}
