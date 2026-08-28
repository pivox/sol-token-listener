import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

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

void test('websocket health migration enforces every durable lifecycle invariant', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: websocket health migration test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'websocket_health_checks', async (pool) => {
    await migrateDatabase({ pool });

    const invalidUpdates = [
      "provider_id = 'fallback-4', active_session_generation = 1, supervision = 'ACTIVE', owner_generation = 1, phase = 'DEGRADED'",
      "supervision = 'ACTIVE', owner_generation = 1, phase = 'DEGRADED', provider_id = 'primary'",
      "supervision = 'ACTIVE', owner_generation = 1, phase = 'DEGRADED', candidate_session_generation = 1",
      "supervision = 'ACTIVE', owner_generation = 1, phase = 'DEGRADED', provider_id = 'primary', active_session_generation = 1, candidate_provider_id = 'fallback-1', candidate_session_generation = 1",
      "last_observation_at = clock_timestamp(), last_observation_slot = NULL",
      "last_observation_at = NULL, last_observation_slot = 1",
      "last_observation_at = clock_timestamp(), last_observation_slot = 'NaN'::NUMERIC",
      "last_observation_at = clock_timestamp(), last_observation_slot = -1",
      "last_observation_at = clock_timestamp(), last_observation_slot = 1.5",
      "last_observation_at = clock_timestamp(), last_observation_slot = 1e78",
      "disconnect_occurred_at = clock_timestamp(), disconnect_reason_code = NULL",
      "disconnect_occurred_at = NULL, disconnect_reason_code = 'SOCKET_ERROR'",
      "recovery_status = 'RECOVERED', recovery_started_at = clock_timestamp(), recovery_completed_at = clock_timestamp() - INTERVAL '1 second', recovery_reason_code = 'STARTUP'",
      "supervision = 'ACTIVE', owner_generation = 1, phase = 'CONNECTING'",
      "supervision = 'ACTIVE', owner_generation = 1, phase = 'RUNNING', candidate_provider_id = 'primary', candidate_session_generation = 1, acknowledged_at = clock_timestamp()",
      "supervision = 'INACTIVE', owner_generation = 1",
      "revision = 1",
      "last_observation_at = clock_timestamp(), last_observation_slot = 1",
      "disconnect_occurred_at = clock_timestamp(), disconnect_reason_code = 'SOCKET_ERROR'",
      "heartbeat_at = clock_timestamp()",
      "evidence_purge_after = clock_timestamp()",
      "supervision = 'ACTIVE', owner_generation = 1, phase = 'DEGRADED', acknowledged_at = clock_timestamp()",
      "owner_generation = -1",
      "revision = -1",
      "payload_version = 2",
      "supervision = 'UNKNOWN'",
      "phase = 'UNKNOWN'",
      "recovery_status = 'UNKNOWN'",
      "recovery_status = 'REQUIRED', recovery_reason_code = 'UNKNOWN'",
      "disconnect_occurred_at = clock_timestamp(), disconnect_reason_code = 'UNKNOWN'",
      "acknowledged_at = 'infinity'::TIMESTAMPTZ",
      "updated_at = 'infinity'::TIMESTAMPTZ",
      "heartbeat_at = '-infinity'::TIMESTAMPTZ",
      "evidence_purge_after = 'infinity'::TIMESTAMPTZ",
    ] as const;
    for (const assignment of invalidUpdates) {
      await assert.rejects(
        pool.query(`UPDATE listener_websocket_health SET ${assignment} WHERE service_key = 'transaction-listener'`),
        /listener_websocket_health_/u,
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
      (await pool.query("SELECT phase FROM listener_websocket_health WHERE service_key LIKE 'valid-%' ORDER BY service_key")).rows.map((row) => row.phase).sort(),
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
