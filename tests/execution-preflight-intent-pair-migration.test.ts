import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { LIVE_EXECUTION_MIGRATION_CATALOG } from '../src/execution-migrations/live-catalog.js';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '041_execution_preflight_intent_pairs.sql';
const migrationHeadName = '043_execution_intent_causal_lineage.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const wsolMint = 'So11111111111111111111111111111111111111112';
const fingerprint = 'a'.repeat(64);
const requestedAt = '2020-01-01T00:00:00.000Z';
const expiresAt = '2020-01-01T00:01:00.000Z';

void test('migration 041 declares the immutable cross-lane pair contract', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.equal(LIVE_EXECUTION_MIGRATION_CATALOG.at(-1)?.name, migrationHeadName);
  assert.ok(LIVE_EXECUTION_MIGRATION_CATALOG.some((migration) => migration.name === migrationName));
  assert.match(sql, /CREATE TABLE IF NOT EXISTS execution_preflight_intent_pairs/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS execution_preflight_intent_pair_memberships/u);
  assert.match(sql, /UNIQUE\s*\(intent_id\)/u);
  assert.match(sql, /CHECK \(lane IN \('TARGET', 'SIMULATION'\)\)/u);
  assert.match(sql, /ON DELETE RESTRICT/u);
  assert.match(sql, /expires_at \+ INTERVAL '4 hours'/u);
  assert.doesNotMatch(sql, /private_key|keypair|signed_transaction|rpc_url/iu);
});

void test('PostgreSQL 16 migration 041 creates and guards pristine intent pairs', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution preflight pair migration test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_preflight_pair', async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationHeadName);
    assert.deepEqual(await migrateDatabase({ pool }), []);

    await pool.query(`SET search_path TO ${quoteIdentifier(await currentSchema(pool))}, pg_temp, public`);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    await pool.query(`INSERT INTO domain_events (
      event_id,type,mint,source,program,signature,slot,transaction_index,instruction_index,
      confirmation_status,observed_at,payload_version,payload
    ) VALUES ('decision-event','PaperStrategySessionUpdated','mint','paper-decision','pumpfun',
      'signature',1,0,0,'finalized',statement_timestamp(),1,'{}')`);

    await inTransaction(pool, async (client) => {
      await insertIntent(client, 'target');
      await insertIntent(client, 'probe', { lane: 'SIMULATION' });
      await insertPair(client, 'pair', 'target', 'probe');
    });

    await inTransaction(pool, async (client) => {
      await insertIntent(client, 'forged-time-target');
      await insertIntent(client, 'forged-time-probe', { lane: 'SIMULATION' });
      await client.query(`INSERT INTO execution_preflight_intent_pairs (
        pair_id,payload_version,pair_fingerprint,target_intent_id,simulation_intent_id,
        decision_event_id,decision_fingerprint,created_at,expires_at
      ) VALUES ('forged-time-pair',1,$1,'forged-time-target','forged-time-probe',
        'decision-event',$2,$3::TIMESTAMPTZ,$4::TIMESTAMPTZ)`, [
        createHash('sha256').update('forged-time-pair').digest('hex'),
        fingerprint,
        requestedAt,
        expiresAt,
      ]);
    });
    assert.deepEqual((await pool.query(`SELECT created_at > TIMESTAMPTZ '2025-01-01' AS db_owned
      FROM execution_preflight_intent_pairs WHERE pair_id='forged-time-pair'`)).rows,
    [{ db_owned: true }]);

    await assert.rejects(
      pool.query(`UPDATE execution_intents SET live_reserved=TRUE WHERE id='probe'`),
      /simulation intent cannot be live reserved/u,
    );
    assert.deepEqual((await pool.query(`SELECT live_reserved FROM execution_intents
      WHERE id='probe'`)).rows, [{ live_reserved: false }]);

    await pool.query(await readFile(migrationUrl, 'utf8'));
    await assert.rejects(
      pool.query(`UPDATE execution_intents SET live_reserved=TRUE WHERE id='probe'`),
      /simulation intent cannot be live reserved/u,
    );

    const pair = await pool.query(`SELECT payload_version,pair_id,target_intent_id,
      simulation_intent_id,decision_event_id,decision_fingerprint,
      expires_at + INTERVAL '4 hours' = purge_after AS retention_exact
      FROM execution_preflight_intent_pairs WHERE pair_id='pair'`);
    assert.deepEqual(pair.rows, [{
      payload_version: 1,
      pair_id: 'pair',
      target_intent_id: 'target',
      simulation_intent_id: 'probe',
      decision_event_id: 'decision-event',
      decision_fingerprint: fingerprint,
      retention_exact: true,
    }]);
    assert.deepEqual((await pool.query(`SELECT intent_id,lane
      FROM execution_preflight_intent_pair_memberships WHERE pair_id='pair'
      ORDER BY lane`)).rows, [
      { intent_id: 'probe', lane: 'SIMULATION' },
      { intent_id: 'target', lane: 'TARGET' },
    ]);

    await insertIntent(pool, 'retro-target');
    await insertIntent(pool, 'retro-probe', { lane: 'SIMULATION' });
    await assert.rejects(
      insertPair(pool, 'retro-pair', 'retro-target', 'retro-probe'),
      /created in the current transaction/u,
    );

    await assert.rejects(inTransaction(pool, async (client) => {
      await insertIntent(client, 'missing-parent-target');
      await insertPair(client, 'missing-parent', 'missing-parent-target', 'absent');
    }));
    await assert.rejects(inTransaction(pool, async (client) => {
      await insertIntent(client, 'same-parent-target');
      await insertPair(client, 'same-parent', 'same-parent-target', 'same-parent-target');
    }));

    await assert.rejects(
      inTransaction(pool, async (client) => {
        await insertIntent(client, 'different-target');
        await insertIntent(client, 'different-probe', {
          quoteAmountRaw: '2', lane: 'SIMULATION',
        });
        await insertPair(client, 'different-economics', 'different-target', 'different-probe');
      }),
      /economic or causal tuple/u,
    );

    await assert.rejects(
      inTransaction(pool, async (client) => {
        await insertIntent(client, 'wrong-strategy-target', { strategyId: 'another-strategy' });
        await insertIntent(client, 'probe-for-wrong-strategy', { lane: 'SIMULATION' });
        await insertPair(client, 'wrong-strategy-pair', 'wrong-strategy-target',
          'probe-for-wrong-strategy');
      }),
      /canonical target and probe lanes/u,
    );

    await assert.rejects(
      inTransaction(pool, async (client) => {
        await insertIntent(client, 'wrong-command-target', {
          logicalCommandId: `paper_sell_${'c'.repeat(64)}`,
        });
        await insertIntent(client, 'probe-for-wrong-command', { lane: 'SIMULATION' });
        await insertPair(client, 'wrong-command-pair', 'wrong-command-target',
          'probe-for-wrong-command');
      }),
      /canonical target and probe lanes/u,
    );

    await assert.rejects(
      inTransaction(pool, async (client) => {
        await insertIntent(client, 'dirty-target', { status: 'PROCESSING', attemptCount: 1,
          stateRevision: 1, lastReasonCode: 'EXECUTION_STARTED' });
        await insertIntent(client, 'clean-probe-for-dirty', { lane: 'SIMULATION' });
        await insertPair(client, 'dirty-target-pair', 'dirty-target', 'clean-probe-for-dirty');
      }),
      /pristine/u,
    );

    await assert.rejects(
      inTransaction(pool, async (client) => {
        await insertIntent(client, 'live-target', { liveReserved: true });
        await insertIntent(client, 'clean-probe-for-live', { lane: 'SIMULATION' });
        await insertPair(client, 'live-target-pair', 'live-target', 'clean-probe-for-live');
      }),
      /pristine/u,
    );

    await assert.rejects(
      inTransaction(pool, async (client) => {
        await insertIntent(client, 'clean-target-for-live-probe');
        await insertIntent(client, 'live-probe', { liveReserved: true, lane: 'SIMULATION' });
        await insertPair(client, 'live-probe-pair', 'clean-target-for-live-probe', 'live-probe');
      }),
      /pristine/u,
    );

    await insertIntent(pool, 'cross-lane-target');
    await insertIntent(pool, 'cross-lane-probe', { lane: 'SIMULATION' });
    await assert.rejects(
      insertPair(pool, 'cross-lane-pair', 'cross-lane-target', 'target'),
      /canonical target and probe lanes|created in the current transaction|execution_preflight_intent_pair_memberships_intent_id_key/u,
    );
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_preflight_intent_pairs WHERE pair_id='cross-lane-pair'`)).rows[0]?.count, 0);

    await assert.rejects(
      pool.query(`UPDATE execution_preflight_intent_pairs SET pair_fingerprint=$1
        WHERE pair_id='pair'`, ['b'.repeat(64)]),
      /append-only/u,
    );
    await assert.rejects(
      pool.query(`DELETE FROM execution_preflight_intent_pair_memberships WHERE pair_id='pair'`),
      /retention is not eligible/u,
    );
    await assert.rejects(
      pool.query(`DELETE FROM execution_preflight_intent_pairs WHERE pair_id='pair'`),
      /retention is not eligible or memberships remain/u,
    );

    await pool.query(`UPDATE execution_intents SET
      status='SUCCEEDED',attempt_count=1,state_revision=1,last_reason_code='INTENT_SUCCEEDED',
      terminal_at=$2::TIMESTAMPTZ,reconciliation_completed_at=$2::TIMESTAMPTZ,
      purge_after=$2::TIMESTAMPTZ + INTERVAL '4 hours'
      WHERE id=$1`, ['probe', expiresAt]);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    const replay = await pool.query(`SELECT pair_id,pair_fingerprint FROM
      execution_preflight_intent_pairs WHERE pair_id='pair' FOR UPDATE`);
    assert.deepEqual(replay.rows, [{ pair_id: 'pair', pair_fingerprint: fingerprint }]);

    await pool.query(`UPDATE execution_intents SET
      status='SUCCEEDED',attempt_count=1,state_revision=1,last_reason_code='INTENT_SUCCEEDED',
      terminal_at=$2::TIMESTAMPTZ,reconciliation_completed_at=$2::TIMESTAMPTZ,
      purge_after=$2::TIMESTAMPTZ + INTERVAL '4 hours'
      WHERE id=$1`, ['target', expiresAt]);
    await pool.query('BEGIN');
    try {
      await pool.query(`DELETE FROM execution_preflight_intent_pair_memberships
        WHERE pair_id='pair'`);
      await pool.query(`DELETE FROM execution_preflight_intent_pairs WHERE pair_id='pair'`);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_preflight_intent_pairs WHERE pair_id='pair'`)).rows[0]?.count, 0);

    await pool.query(`ALTER TABLE execution_preflight_intent_pairs
      ALTER COLUMN payload_version DROP NOT NULL`);
    await assert.rejects(
      pool.query(await readFile(migrationUrl, 'utf8')),
      /execution_preflight_intent_pairs has a malformed schema/u,
    );
  });
});

interface IntentOverrides {
  readonly quoteAmountRaw?: string;
  readonly status?: 'PENDING' | 'PROCESSING';
  readonly attemptCount?: number;
  readonly stateRevision?: number;
  readonly lastReasonCode?: string | null;
  readonly liveReserved?: boolean;
  readonly strategyId?: string;
  readonly logicalCommandId?: string;
  readonly lane?: 'TARGET' | 'SIMULATION';
}

interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<Readonly<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number | null;
  }>>;
}

async function insertIntent(
  pool: Queryable,
  id: string,
  overrides: IntentOverrides = {},
): Promise<void> {
  const commandHash = createHash('sha256').update(id).digest('hex');
  const logicalCommandId = overrides.logicalCommandId ?? (overrides.lane === 'SIMULATION'
    ? `execution_preflight_probe_${commandHash}`
    : `paper_open_${commandHash}`);
  await pool.query(`INSERT INTO execution_intents (
    id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
    logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
    quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,
    decision_event_id,decision_fingerprint,requested_at,expires_at,status,
    attempt_count,state_revision,last_reason_code,live_reserved
  ) VALUES ($1,1,$2,$14,1,'position',$3,'mint','BUY','PUMP_FUN_ONLY',$4,
    'SPL_TOKEN',9,$5,NULL,1,'decision-event',$6,$7::TIMESTAMPTZ,$8::TIMESTAMPTZ,
    $9,$10,$11,$12,$13)`, [
    id,
    logicalCommandId,
    logicalCommandId,
    wsolMint,
    overrides.quoteAmountRaw ?? '1',
    fingerprint,
    requestedAt,
    expiresAt,
    overrides.status ?? 'PENDING',
    overrides.attemptCount ?? 0,
    overrides.stateRevision ?? 0,
    overrides.lastReasonCode ?? null,
    overrides.liveReserved ?? false,
    overrides.strategyId ?? 'creation-entry-v1',
  ]);
}

async function insertPair(
  pool: Queryable,
  pairId: string,
  targetIntentId: string,
  simulationIntentId: string,
): Promise<void> {
  const pairFingerprint = pairId === 'pair'
    ? fingerprint
    : createHash('sha256').update(pairId).digest('hex');
  await pool.query(`INSERT INTO execution_preflight_intent_pairs (
    pair_id,payload_version,pair_fingerprint,target_intent_id,simulation_intent_id,
    decision_event_id,decision_fingerprint,expires_at
  ) VALUES ($1,1,$2,$3,$4,'decision-event',$6,$5::TIMESTAMPTZ)`, [
    pairId, pairFingerprint, targetIntentId, simulationIntentId, expiresAt, fingerprint,
  ]);
}

async function inTransaction(
  pool: InstanceType<typeof pg.Pool>,
  run: (client: Queryable) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await run(client);
    await client.query('COMMIT');
    committed = true;
  } finally {
    if (!committed) {
      try { await client.query('ROLLBACK'); } catch { /* retain the primary failure */ }
    }
    client.release();
  }
}

async function currentSchema(pool: InstanceType<typeof pg.Pool>): Promise<string> {
  const result = await pool.query<{ readonly schema: string }>('SELECT current_schema() AS schema');
  const schema = result.rows[0]?.schema;
  if (schema === undefined) throw new Error('Current schema unavailable.');
  return schema;
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
    max: 1,
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
