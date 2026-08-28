import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrationName = '030_listener_websocket_health.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);

void test('websocket health migration upgrades legacy state without trusting its websocket evidence', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: websocket health migration test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'websocket_health_upgrade', async (pool) => {
    const legacyNames = (await readdir(migrationsDirectory))
      .filter((name) => /^(?:00[1-9]|01[0-9]|02[0-9])_[a-z0-9_-]+\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right));
    assert.equal(legacyNames.at(-1), '029_paper_finality_claim_scheduler.sql');
    for (const name of legacyNames) {
      await pool.query(await readFile(new URL(name, migrationsDirectory), 'utf8'));
      await pool.query(
        'INSERT INTO migration_history(version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [name],
      );
    }
    await pool.query(`INSERT INTO listener_heartbeats (
      service_key, last_websocket_slot, last_signature, payload
    ) VALUES (
      'transaction-listener', 987654321, 'hostile-legacy-signature',
      '{"rpcUrl":"https://secret.invalid","remoteReason":"hostile"}'::jsonb
    )`);

    assert.deepEqual(await migrateDatabase({ pool }), [migrationName]);
    const beforeReplay = await canonicalRow(pool);
    assert.deepEqual(beforeReplay, {
      service_key: 'transaction-listener',
      payload_version: 1,
      supervision: 'INACTIVE',
      owner_generation: '0',
      revision: '0',
      phase: 'STOPPED',
      provider_id: null,
      candidate_provider_id: null,
      acknowledged_at: null,
      last_observation_at: null,
      last_observation_slot: null,
      recovery_status: 'NOT_REQUIRED',
    });

    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    assert.deepEqual(await canonicalRow(pool), beforeReplay);
    assert.equal((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM listener_websocket_health')).rows[0]?.count, 1);
    assert.deepEqual(await migrateDatabase({ pool }), []);
  });
});

void test('websocket health migration applies on an empty schema and records migration 030', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: websocket health migration test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'websocket_health_empty', async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(
      (await pool.query('SELECT version FROM migration_history ORDER BY version DESC LIMIT 1')).rows,
      [{ version: migrationName }],
    );
    assert.deepEqual(await canonicalRow(pool), {
      service_key: 'transaction-listener',
      payload_version: 1,
      supervision: 'INACTIVE',
      owner_generation: '0',
      revision: '0',
      phase: 'STOPPED',
      provider_id: null,
      candidate_provider_id: null,
      acknowledged_at: null,
      last_observation_at: null,
      last_observation_slot: null,
      recovery_status: 'NOT_REQUIRED',
    });
  });
});

void test('websocket health migration accepts scale-bearing mathematical integers', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: websocket health migration test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'websocket_health_integral_slots', async (pool) => {
    await migrateDatabase({ pool });
    await pool.query(activeSessionRow('integral-slot', 'RUNNING', recoveryNotRequired()));

    for (const slot of ['1.0', '0.00'] as const) {
      const result = await pool.query(`UPDATE listener_websocket_health
        SET last_observation_at = clock_timestamp(), last_observation_slot = $1::NUMERIC
        WHERE service_key = 'valid-integral-slot'
        RETURNING last_observation_slot::TEXT`, [slot]);
      assert.equal(result.rows[0]?.last_observation_slot, slot);
    }
  });
});

void test('websocket health retention keeps unresolved evidence and purges exact four-hour boundaries', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: websocket health retention test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'websocket_health_retention', async (pool) => {
    await migrateDatabase({ pool });
    await pool.query(`WITH instant AS (SELECT clock_timestamp() AS now)
      INSERT INTO listener_websocket_health (
        service_key, supervision, owner_generation, revision,
        active_session_generation, provider_id, phase, acknowledged_at,
        last_observation_at, last_observation_slot,
        disconnect_occurred_at, disconnect_reason_code,
        recovery_status, recovery_started_at, recovery_completed_at,
        recovery_reason_code, heartbeat_at, updated_at, evidence_purge_after
      ) SELECT
        'retention-running-boundary', 'ACTIVE', 1, 7,
        1, 'primary', 'RUNNING', now - INTERVAL '5 hours',
        now - INTERVAL '5 hours', 101,
        now - INTERVAL '4 hours', 'REMOTE_CLOSE',
        'RECOVERED', now - INTERVAL '5 hours', now - INTERVAL '4 hours',
        'SESSION_FAILURE', now - INTERVAL '6 hours', now - INTERVAL '4 hours', now
      FROM instant`);
    await pool.query(`WITH instant AS (SELECT clock_timestamp() AS now)
      INSERT INTO listener_websocket_health (
        service_key, supervision, owner_generation, revision, phase,
        last_observation_at, last_observation_slot,
        disconnect_occurred_at, disconnect_reason_code,
        recovery_status, recovery_started_at, recovery_completed_at,
        recovery_reason_code, heartbeat_at, updated_at, evidence_purge_after
      ) SELECT
        'retention-stopped-boundary', 'ACTIVE', 1, 8, 'STOPPED',
        now - INTERVAL '5 hours', 202,
        now - INTERVAL '4 hours', 'ABORTED',
        'RECOVERED', now - INTERVAL '5 hours', now - INTERVAL '4 hours',
        'STARTUP', now - INTERVAL '6 hours', now - INTERVAL '4 hours', now
      FROM instant`);
    await pool.query(`WITH instant AS (SELECT clock_timestamp() AS now)
      INSERT INTO listener_websocket_health (
        service_key, supervision, owner_generation, revision,
        active_session_generation, provider_id, phase, acknowledged_at,
        last_observation_at, last_observation_slot,
        disconnect_occurred_at, disconnect_reason_code,
        recovery_status, recovery_started_at, recovery_completed_at,
        recovery_reason_code, heartbeat_at, updated_at, evidence_purge_after
      ) SELECT
        'retention-running-before-boundary', 'ACTIVE', 1, 9,
        2, 'fallback-1', 'RUNNING', now - INTERVAL '2 hours',
        now - INTERVAL '1 hour', 303,
        now - INTERVAL '1 hour', 'SOCKET_ERROR',
        'RECOVERED', now - INTERVAL '2 hours', now - INTERVAL '1 hour',
        'RPC_UNAVAILABLE', now - INTERVAL '3 hours', now - INTERVAL '1 hour',
        now - INTERVAL '1 hour' + INTERVAL '4 hours'
      FROM instant`);
    await pool.query(`WITH instant AS (SELECT clock_timestamp() AS now)
      INSERT INTO listener_websocket_health (
        service_key, supervision, owner_generation, revision, phase,
        disconnect_occurred_at, disconnect_reason_code,
        recovery_status, recovery_started_at, recovery_completed_at,
        recovery_reason_code, heartbeat_at, updated_at, evidence_purge_after
      ) SELECT
        'retention-unresolved', 'ACTIVE', 1, 10, 'DEGRADED',
        now - INTERVAL '1 hour', 'CLEANUP_FAILED',
        'FAILED', now - INTERVAL '2 hours', now - INTERVAL '1 hour',
        'SESSION_FAILURE', now - INTERVAL '3 hours', now - INTERVAL '1 hour', NULL
      FROM instant`);

    const before = await retentionRows(pool);
    assert.equal(before.get('retention-running-boundary')?.exact_four_hour_deadline, true);
    assert.equal(before.get('retention-stopped-boundary')?.exact_four_hour_deadline, true);
    assert.equal(before.get('retention-running-before-boundary')?.exact_four_hour_deadline, true);
    assert.equal(before.get('retention-running-before-boundary')?.deadline_is_future, true);

    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.websocketHealthEvidence, 2);
    const after = await retentionRows(pool);

    const running = after.get('retention-running-boundary');
    assert.equal(running?.acknowledged_at?.getTime(), before.get('retention-running-boundary')?.acknowledged_at?.getTime());
    assert.equal(running?.last_observation_at?.getTime(), before.get('retention-running-boundary')?.last_observation_at?.getTime());
    assert.equal(running?.last_observation_slot, '101');
    assert.equal(running?.disconnect_occurred_at, null);
    assert.equal(running?.disconnect_reason_code, null);
    assert.equal(running?.recovery_status, 'NOT_REQUIRED');
    assert.equal(running?.recovery_started_at, null);
    assert.equal(running?.recovery_completed_at, null);
    assert.equal(running?.recovery_reason_code, null);
    assert.equal(running?.evidence_purge_after, null);
    assert.equal(running?.heartbeat_at?.getTime(), before.get('retention-running-boundary')?.heartbeat_at?.getTime());
    assert.equal(running?.updated_at.getTime(), before.get('retention-running-boundary')?.updated_at.getTime());
    assert.equal(running?.revision, '7');

    const stopped = after.get('retention-stopped-boundary');
    assert.equal(stopped?.acknowledged_at, null);
    assert.equal(stopped?.last_observation_at, null);
    assert.equal(stopped?.last_observation_slot, null);
    assert.equal(stopped?.disconnect_occurred_at, null);
    assert.equal(stopped?.disconnect_reason_code, null);
    assert.equal(stopped?.recovery_status, 'NOT_REQUIRED');
    assert.equal(stopped?.recovery_started_at, null);
    assert.equal(stopped?.recovery_completed_at, null);
    assert.equal(stopped?.recovery_reason_code, null);
    assert.equal(stopped?.evidence_purge_after, null);
    assert.equal(stopped?.heartbeat_at?.getTime(), before.get('retention-stopped-boundary')?.heartbeat_at?.getTime());
    assert.equal(stopped?.updated_at.getTime(), before.get('retention-stopped-boundary')?.updated_at.getTime());
    assert.equal(stopped?.revision, '8');

    assert.deepEqual(after.get('retention-running-before-boundary'), before.get('retention-running-before-boundary'));
    assert.deepEqual(after.get('retention-unresolved'), before.get('retention-unresolved'));

    const repeatedPurge = await purgeExpiredFoundationData(pool);
    assert.equal(repeatedPurge.websocketHealthEvidence, 0);
    assert.deepEqual(await retentionRows(pool), after);
  });
});

void test('websocket health migration enforces every durable lifecycle invariant', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: websocket health migration test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'websocket_health_checks', async (pool) => {
    await migrateDatabase({ pool });

    const invalidUpdates = [
      constraintCase('payload_version_check', 'payload_version = 2'),
      constraintCase('supervision_check', "supervision = 'UNKNOWN', phase = 'STOPPED'"),
      constraintCase('owner_generation_check', 'owner_generation = 0'),
      constraintCase('revision_check', 'revision = -1'),
      constraintCase('session_generation_check', "provider_id = 'primary', active_session_generation = 0"),
      constraintCase('provider_check', "provider_id = 'fallback-4', active_session_generation = 1"),
      constraintCase('session_pair_check', "provider_id = 'primary'"),
      constraintCase(
        'distinct_sessions_check',
        "provider_id = 'primary', active_session_generation = 1, candidate_provider_id = 'fallback-1', candidate_session_generation = 1",
      ),
      constraintCase('phase_check', "phase = 'UNKNOWN'"),
      constraintCase(
        'acknowledged_at_check',
        "provider_id = 'primary', active_session_generation = 1, acknowledged_at = 'infinity'::TIMESTAMPTZ",
      ),
      constraintCase('observation_check', 'last_observation_at = clock_timestamp(), last_observation_slot = NULL'),
      constraintCase('observation_check', 'last_observation_at = NULL, last_observation_slot = 1'),
      constraintCase('observation_check', "last_observation_at = clock_timestamp(), last_observation_slot = 'NaN'::NUMERIC"),
      constraintCase('observation_check', 'last_observation_at = clock_timestamp(), last_observation_slot = -1'),
      constraintCase('observation_check', 'last_observation_at = clock_timestamp(), last_observation_slot = 1.5'),
      constraintCase('observation_check', 'last_observation_at = clock_timestamp(), last_observation_slot = 1e78'),
      constraintCase('observation_check', "last_observation_at = 'infinity'::TIMESTAMPTZ, last_observation_slot = 1"),
      constraintCase('disconnect_check', 'disconnect_occurred_at = clock_timestamp(), disconnect_reason_code = NULL'),
      constraintCase('disconnect_check', "disconnect_occurred_at = NULL, disconnect_reason_code = 'SOCKET_ERROR'"),
      constraintCase('disconnect_check', "disconnect_occurred_at = clock_timestamp(), disconnect_reason_code = 'UNKNOWN'"),
      constraintCase('disconnect_check', "disconnect_occurred_at = 'infinity'::TIMESTAMPTZ, disconnect_reason_code = 'SOCKET_ERROR'"),
      constraintCase('recovery_status_check', "recovery_status = 'UNKNOWN'"),
      constraintCase('recovery_reason_check', "recovery_status = 'REQUIRED', recovery_reason_code = 'UNKNOWN'"),
      constraintCase(
        'recovery_timestamp_check',
        "recovery_status = 'RECOVERED', recovery_started_at = clock_timestamp(), recovery_completed_at = clock_timestamp() - INTERVAL '1 second', recovery_reason_code = 'STARTUP'",
      ),
      constraintCase(
        'recovery_lifecycle_check',
        "recovery_status = 'REQUIRED', recovery_started_at = clock_timestamp(), recovery_reason_code = 'STARTUP'",
      ),
      constraintCase('heartbeat_at_check', "heartbeat_at = '-infinity'::TIMESTAMPTZ"),
      constraintCase('updated_at_check', "updated_at = 'infinity'::TIMESTAMPTZ"),
      constraintCase('evidence_purge_after_check', "evidence_purge_after = 'infinity'::TIMESTAMPTZ"),
      constraintCase(
        'inactive_check',
        "supervision = 'INACTIVE', owner_generation = 0, phase = 'STOPPED', revision = 1",
      ),
      constraintCase('phase_session_check', "phase = 'CONNECTING'"),
    ] as const;
    for (const [index, { assignment, constraint }] of invalidUpdates.entries()) {
      const serviceKey = `valid-constraint-${index}`;
      await pool.query(activeRow(`constraint-${index}`, 'DEGRADED', recoveryNotRequired()));
      await assert.rejects(
        pool.query(`UPDATE listener_websocket_health SET ${assignment} WHERE service_key = $1`, [serviceKey]),
        (error: unknown) => {
          assert.ok(error instanceof pg.DatabaseError);
          assert.equal(error.code, '23514');
          assert.equal(error.constraint, constraint);
          return true;
        },
        assignment,
      );
    }

    const acceptedRows = [
      activeRow('stopped', 'STOPPED', recoveryNotRequired()),
      candidateRow('connecting', 'CONNECTING', false, recoveryOpen('REQUIRED', 'STARTUP')),
      candidateRow('waiting', 'WAITING_FOR_ACKS', false, recoveryOpen('IN_PROGRESS', 'STARTUP')),
      candidateRow('acknowledged', 'ACKNOWLEDGED', true, recoveryOpen('IN_PROGRESS', 'STARTUP')),
      candidateRow('recovering', 'RECOVERING', true, recoveryOpen('IN_PROGRESS', 'SESSION_FAILURE')),
      activeSessionRow('running', 'RUNNING', recoveryClosed('RECOVERED', 'STARTUP')),
      activeRow('degraded', 'DEGRADED', recoveryClosed('FAILED', 'RPC_UNAVAILABLE')),
      activeRow('unrecoverable', 'UNRECOVERABLE', recoveryClosed('FAILED', 'CATCH_UP_WINDOW_EXCEEDED')),
      activeRow('stopping', 'STOPPING', recoveryNotRequired()),
      sameProviderPairRow(),
    ] as const;
    for (const row of acceptedRows) await pool.query(row);
    await pool.query(`UPDATE listener_websocket_health
      SET last_observation_at = clock_timestamp(),
          last_observation_slot = 999999999999999999999999999999999999999999999999999999999999999999999999999999
      WHERE service_key = 'valid-running'`);
    assert.deepEqual(
      (await pool.query(`SELECT phase FROM listener_websocket_health
        WHERE service_key LIKE 'valid-%' AND service_key NOT LIKE 'valid-constraint-%'
        ORDER BY service_key`)).rows.map((row) => row.phase).sort(),
      ['ACKNOWLEDGED', 'CONNECTING', 'DEGRADED', 'DEGRADED', 'RECOVERING', 'RUNNING', 'STOPPED', 'STOPPING', 'UNRECOVERABLE', 'WAITING_FOR_ACKS'].sort(),
    );

    const columns = (await pool.query(`SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = CURRENT_SCHEMA() AND table_name = 'listener_websocket_health'
      ORDER BY ordinal_position`)).rows.map((row) => row.column_name);
    assert.deepEqual(columns, [
      'service_key', 'payload_version', 'supervision', 'owner_generation', 'revision',
      'active_session_generation', 'candidate_session_generation', 'provider_id',
      'candidate_provider_id', 'phase', 'acknowledged_at', 'last_observation_at',
      'last_observation_slot', 'disconnect_occurred_at', 'disconnect_reason_code',
      'recovery_status', 'recovery_started_at', 'recovery_completed_at',
      'recovery_reason_code', 'heartbeat_at', 'updated_at', 'evidence_purge_after',
    ]);
    assert.deepEqual(
      (await pool.query(`SELECT indexname FROM pg_indexes
        WHERE schemaname = CURRENT_SCHEMA() AND tablename = 'listener_websocket_health'
        ORDER BY indexname`)).rows,
      [{ indexname: 'listener_websocket_health_pkey' }],
    );
  });
});

function constraintCase(
  constraintSuffix: string,
  assignment: string,
): Readonly<{ assignment: string; constraint: string }> {
  return Object.freeze({
    assignment,
    constraint: `listener_websocket_health_${constraintSuffix}`,
  });
}

interface RetentionRow {
  readonly service_key: string;
  readonly revision: string;
  readonly acknowledged_at: Date | null;
  readonly last_observation_at: Date | null;
  readonly last_observation_slot: string | null;
  readonly disconnect_occurred_at: Date | null;
  readonly disconnect_reason_code: string | null;
  readonly recovery_status: string;
  readonly recovery_started_at: Date | null;
  readonly recovery_completed_at: Date | null;
  readonly recovery_reason_code: string | null;
  readonly heartbeat_at: Date | null;
  readonly updated_at: Date;
  readonly evidence_purge_after: Date | null;
  readonly exact_four_hour_deadline: boolean | null;
  readonly deadline_is_future: boolean | null;
}

async function retentionRows(
  pool: InstanceType<typeof pg.Pool>,
): Promise<ReadonlyMap<string, RetentionRow>> {
  const result = await pool.query<RetentionRow>(`SELECT
    service_key, revision::TEXT, acknowledged_at, last_observation_at,
    last_observation_slot::TEXT, disconnect_occurred_at, disconnect_reason_code,
    recovery_status, recovery_started_at, recovery_completed_at,
    recovery_reason_code, heartbeat_at, updated_at, evidence_purge_after,
    evidence_purge_after = recovery_completed_at + INTERVAL '4 hours'
      AS exact_four_hour_deadline,
    evidence_purge_after > clock_timestamp() AS deadline_is_future
    FROM listener_websocket_health WHERE service_key LIKE 'retention-%'
    ORDER BY service_key`);
  return new Map(result.rows.map((row) => [row.service_key, row]));
}

function activeRow(serviceKey: string, phase: string, recovery: string): string {
  return `INSERT INTO listener_websocket_health (
    service_key, supervision, owner_generation, revision, phase, recovery_status,
    recovery_started_at, recovery_completed_at, recovery_reason_code, updated_at
  ) SELECT 'valid-${serviceKey}', 'ACTIVE', 1, 0, '${phase}', recovery_status,
    recovery_started_at, recovery_completed_at, recovery_reason_code, clock_timestamp()
    FROM (SELECT ${recovery}) AS recovery`;
}

function candidateRow(serviceKey: string, phase: string, acknowledged: boolean, recovery: string): string {
  return `INSERT INTO listener_websocket_health (
    service_key, supervision, owner_generation, revision, phase,
    candidate_provider_id, candidate_session_generation, acknowledged_at,
    recovery_status, recovery_started_at, recovery_completed_at, recovery_reason_code, updated_at
  ) SELECT 'valid-${serviceKey}', 'ACTIVE', 1, 0, '${phase}', 'primary', 1,
    ${acknowledged ? 'clock_timestamp()' : 'NULL'}, recovery_status,
    recovery_started_at, recovery_completed_at, recovery_reason_code, clock_timestamp()
    FROM (SELECT ${recovery}) AS recovery`;
}

function activeSessionRow(serviceKey: string, phase: string, recovery: string): string {
  return `INSERT INTO listener_websocket_health (
    service_key, supervision, owner_generation, revision, phase,
    provider_id, active_session_generation, acknowledged_at,
    recovery_status, recovery_started_at, recovery_completed_at, recovery_reason_code, updated_at
  ) SELECT 'valid-${serviceKey}', 'ACTIVE', 1, 0, '${phase}', 'primary', 1,
    clock_timestamp(), recovery_status, recovery_started_at, recovery_completed_at,
    recovery_reason_code, clock_timestamp() FROM (SELECT ${recovery}) AS recovery`;
}

function recoveryNotRequired(): string {
  return `'NOT_REQUIRED'::TEXT AS recovery_status,
    NULL::TIMESTAMPTZ AS recovery_started_at,
    NULL::TIMESTAMPTZ AS recovery_completed_at,
    NULL::TEXT AS recovery_reason_code`;
}

function recoveryOpen(status: 'REQUIRED' | 'IN_PROGRESS', reason: string): string {
  return `'${status}'::TEXT AS recovery_status,
    ${status === 'REQUIRED' ? 'NULL::TIMESTAMPTZ' : 'clock_timestamp()'} AS recovery_started_at,
    NULL::TIMESTAMPTZ AS recovery_completed_at,
    '${reason}'::TEXT AS recovery_reason_code`;
}

function sameProviderPairRow(): string {
  return `INSERT INTO listener_websocket_health (
    service_key, supervision, owner_generation, revision, phase,
    provider_id, active_session_generation, candidate_provider_id,
    candidate_session_generation, recovery_status, updated_at
  ) VALUES (
    'valid-same-provider-pair', 'ACTIVE', 1, 0, 'DEGRADED',
    'primary', 1, 'primary', 2, 'NOT_REQUIRED', clock_timestamp()
  )`;
}

function recoveryClosed(status: 'RECOVERED' | 'FAILED', reason: string): string {
  return `'${status}'::TEXT AS recovery_status,
    clock_timestamp() - INTERVAL '1 second' AS recovery_started_at,
    clock_timestamp() AS recovery_completed_at,
    '${reason}'::TEXT AS recovery_reason_code`;
}

async function canonicalRow(pool: InstanceType<typeof pg.Pool>): Promise<Record<string, unknown>> {
  const result = await pool.query(`SELECT service_key, payload_version,
    supervision, owner_generation::TEXT, revision::TEXT, phase, provider_id,
    candidate_provider_id, acknowledged_at, last_observation_at,
    last_observation_slot::TEXT, recovery_status
    FROM listener_websocket_health WHERE service_key = 'transaction-listener'`);
  assert.equal(result.rows.length, 1);
  return result.rows[0] as Record<string, unknown>;
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  action: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await action(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error('Unsafe SQL identifier.');
  return `"${identifier}"`;
}
