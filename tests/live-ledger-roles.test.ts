import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import {
  ACTIVE_WALLET_SQL,
  createLiveOverviewReader,
  CURVE_RESERVES_SQL,
  HISTORY_SQL,
  OPEN_POSITIONS_SQL,
  POOL_RESERVES_SQL,
  REALIZED_TOTAL_SQL,
} from '../src/operator-api/repository.js';
import type { ExecutorDatabaseSource } from '../src/executor/database.js';
import { migrateDatabase } from '../src/storage/database.js';
import { LIVE_POSITION_LEDGER_INSERT_SQL } from '../src/storage/execution-live.repository.js';
import { waitForBackendDrain } from './helpers/postgres-backend-drain.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const scriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);
const databaseSourceUrl = new URL('../src/storage/database.ts', import.meta.url);

void test('only the recovery role inserts and only the operator reader selects the ledger', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  const executable = sql.replace(/--[^\r\n]*/gu, ' ');
  assert.match(executable, /GRANT INSERT \(\s*position_id,wallet_public_key,mint,opened_at,closed_at,base_amount_raw,\s*entry_wallet_lamport_delta,exit_wallet_lamport_delta,net_lamports,\s*entry_signature,exit_signature\s*\)\s*ON TABLE execution_live_position_ledger TO sol_token_executor_live_recovery;/u);
  assert.match(executable, /REVOKE ALL ON TABLE execution_live_position_ledger\s+FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,\s+sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api;/u);
  assert.match(executable, /execution_live_position_ledger,\s+bonding_curve_snapshots,\s+market_pools,\s+market_reserve_snapshots,\s+migration_history\s+TO sol_token_operator_reader/u);
  assert.match(executable, /GRANT SELECT \(\s*position_id,wallet_public_key,mint,quote_mint,quote_cost_raw,base_amount_raw,\s*remaining_base_raw,fee_lamports,opened_at,exit_deadline_at,state,closed_at\s*\)\s*ON TABLE execution_live_positions TO sol_token_operator_reader;/u);
  for (const statement of executable.split(';')) {
    if (!/\bGRANT\b/iu.test(statement) || !statement.includes('execution_live_position_ledger')) continue;
    assert.match(statement, /\bTO\s+sol_token_(?:executor_live_recovery|operator_reader)\s*$/u);
    assert.doesNotMatch(statement, /\b(?:DELETE|UPDATE|TRUNCATE|ALL)\b/iu);
  }
});

void test('retention never purges the ledger', async () => {
  assert.doesNotMatch(await readFile(databaseSourceUrl, 'utf8'), /execution_live_position_ledger/u);
});

void test('PostgreSQL 16 grants on the live position ledger are exact', async (context) => {
  await withProvisionedDatabase(context, async (pool) => {
    const recovery = 'sol_token_executor_live_recovery';
    const reader = 'sol_token_operator_reader';
    // Privileges are checked at execution time even when no row matches.
    assert.equal(await probe(pool, recovery, LIVE_POSITION_LEDGER_INSERT_SQL,
      ['1', '795', 'signature', 'execution_live_position_missing']), 'allowed');
    for (const statement of [
      'SELECT 1 FROM execution_live_position_ledger',
      'UPDATE execution_live_position_ledger SET net_lamports=0',
      'DELETE FROM execution_live_position_ledger',
    ]) assert.equal(await probe(pool, recovery, statement), 'denied', statement);

    for (const statement of [
      'SELECT position_id,net_lamports,entry_signature FROM execution_live_position_ledger',
      'SELECT position_id,state,opened_at,remaining_base_raw FROM execution_live_positions',
      'SELECT mint,virtual_quote_reserves_raw FROM bonding_curve_snapshots',
      'SELECT pool_address,base_mint FROM market_pools',
      'SELECT pool_address,effective_quote_reserves_raw FROM market_reserve_snapshots',
    ]) assert.equal(await probe(pool, reader, statement), 'allowed', statement);
    for (const statement of [
      'DELETE FROM execution_live_position_ledger',
      'UPDATE execution_live_position_ledger SET net_lamports=0',
      'SELECT exit_reconciliation_fingerprint FROM execution_live_positions',
      'SELECT signed_transaction_bytes FROM execution_signed_transactions',
    ]) assert.equal(await probe(pool, reader, statement), 'denied', statement);
    assert.equal(await probe(pool, reader, LIVE_POSITION_LEDGER_INSERT_SQL,
      ['1', '795', 'signature', 'execution_live_position_missing']), 'denied');

    const unrelatedRoles = [
      'sol_token_public_api', 'sol_token_listener_writer', 'sol_token_executor_worker',
      'sol_token_executor_operations', 'sol_token_executor_readiness',
      'sol_token_executor_live', 'sol_token_retention_worker',
    ];
    for (const role of unrelatedRoles) assert.equal(
      await probe(pool, role, 'SELECT 1 FROM execution_live_position_ledger'), 'denied', role,
    );
    // The ledger is append-only: nobody but recovery inserts, and nobody deletes or truncates.
    for (const role of unrelatedRoles) {
      assert.equal(await probe(pool, role, LIVE_POSITION_LEDGER_INSERT_SQL,
        ['1', '795', 'signature', 'execution_live_position_missing']), 'denied', `INSERT ${role}`);
    }
    for (const role of [...unrelatedRoles, recovery, reader]) {
      for (const statement of [
        'DELETE FROM execution_live_position_ledger',
        'TRUNCATE execution_live_position_ledger',
      ]) assert.equal(await probe(pool, role, statement), 'denied', `${statement} ${role}`);
    }
  });
});

void test('PostgreSQL 16 operator reader runs every overview query and pages the ledger by keyset', async (context) => {
  await withProvisionedDatabase(context, async (pool) => {
    const wallet = '11111111111111111111111111111111';
    const mint = 'So11111111111111111111111111111111111111112';
    for (const [letter, closedAt, net] of [
      ['a', '2026-10-06 10:30:00+00', '-9000'], ['b', '2026-10-06 11:00:00+00', '900'],
      ['c', '2026-10-06 11:00:00+00', '-4205'], ['d', '2026-10-06 11:30:00+00', '15'],
    ] as const) {
      await pool.query(`INSERT INTO execution_live_position_ledger (
        position_id,wallet_public_key,mint,opened_at,closed_at,base_amount_raw,
        entry_wallet_lamport_delta,exit_wallet_lamport_delta,net_lamports,
        entry_signature,exit_signature
      ) VALUES ('execution_live_position_'||repeat($1,64),$2,$3,TIMESTAMPTZ '2026-10-06 10:00:00+00',
        $4::TIMESTAMPTZ,95,-1000,$5::NUMERIC+1000,$5::NUMERIC,repeat('1',64),repeat('2',64))`,
      [letter, wallet, mint, closedAt, net]);
    }
    const reader = 'sol_token_operator_reader';
    // Page size 2 (the reader asks for 3 rows): the page boundary falls between c and b, which
    // share closed_at, so the position_id tiebreak decides which side of the cursor b lands on.
    const firstPage = await readAs(pool, reader, HISTORY_SQL, [wallet, null, null, 3]);
    assert.deepEqual(firstPage.map((row) => String(row.position_id).slice(-1)), ['d', 'c', 'b']);
    const cursor = firstPage[1];
    assert.ok(cursor?.closed_at instanceof Date);
    const secondPage = await readAs(pool, reader, HISTORY_SQL,
      [wallet, String(cursor.closed_at.getTime()), cursor.position_id, 3]);
    assert.deepEqual(secondPage.map((row) => String(row.position_id).slice(-1)), ['b', 'a']);
    assert.deepEqual(await readAs(pool, reader, REALIZED_TOTAL_SQL, [wallet]),
      [{ realized_lamports: '-12290' }]);
    assert.deepEqual(await readAs(pool, reader, ACTIVE_WALLET_SQL), []);
    assert.deepEqual(await readAs(pool, reader, OPEN_POSITIONS_SQL, [wallet]), []);
    assert.deepEqual(await readAs(pool, reader, POOL_RESERVES_SQL, [[mint], mint]), []);
    assert.deepEqual(await readAs(pool, reader, CURVE_RESERVES_SQL, [[mint], mint]), []);
  });
});

void test('PostgreSQL 16 operator reader values open positions from the latest non-orphaned active snapshot', async (context) => {
  await withProvisionedDatabase(context, async (pool) => {
    const wallet = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
    const poolMint = '4Nd1mYQzvgQ1NhVU9oKRf7qZsV4W1YqTf1m4eZxY2k5y';
    const curveMint = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const zeroMint = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
    const hex = (letter: string): string => letter.repeat(64);
    // Foreign keys and triggers are skipped so that only the rows the overview reads are seeded.
    await asSuperuser(pool, async (client) => {
      await client.query(`INSERT INTO execution_wallet_generations
        (generation_id,wallet_public_key,cluster,genesis_hash,generation)
        VALUES ('execution_wallet_generation_'||$1,$2,'mainnet-beta',$2,1)`, [hex('a'), wallet]);
      const pools: readonly (readonly [string, string, string, string])[] = [
        ['pool_active', 'market_a', 'active', poolMint],
        ['pool_retracted', 'market_b', 'retracted', poolMint],
        ['pool_zero', 'market_c', 'active', zeroMint],
      ];
      for (const [address, market, state, mint] of pools) {
        await client.query(`INSERT INTO market_pools (
          pool_address,market,program_id,pool_index,creator,base_mint,quote_mint,quote_decimals,
          base_token_program,quote_token_program,base_vault,quote_vault,lp_mint,migration_id,
          activation_event_id,pool_state,confirmation_status,slot,transaction_index,
          instruction_index,payload_version,payload
        ) VALUES ($1,$2,'program',0,'creator',$3,$4,9,'tp','tp','bv','qv','lp','migration','event',
          $5,'confirmed',1,0,0,1,'{}'::JSONB)`, [address, market, mint, WSOL, state]);
      }
      // [pool, slot, quote reserves, base reserves, confirmation status]
      const reserves: readonly (readonly [string, number, string, string, string])[] = [
        ['pool_active', 100, '10', '10', 'confirmed'],
        ['pool_active', 200, '60000000000', '1073000000000000', 'confirmed'],
        ['pool_active', 300, '1', '1', 'orphaned'],
        ['pool_retracted', 400, '7', '7', 'confirmed'],
        ['pool_zero', 100, '50', '50', 'confirmed'],
        ['pool_zero', 200, '50', '0', 'confirmed'],
      ];
      for (const [address, slot, quote, base, status] of reserves) {
        await client.query(`INSERT INTO market_reserve_snapshots (
          snapshot_id,pool_address,base_reserves_raw,quote_vault_amount_raw,
          virtual_quote_reserves_raw,effective_quote_reserves_raw,observed_slot,trigger_slot,
          transaction_index,instruction_index,confirmation_status,observed_at
        ) VALUES ($1||'_'||$2::TEXT,$1,$4::NUMERIC,0,0,$3::NUMERIC,$2::NUMERIC,$2::NUMERIC,0,0,$5,
          TIMESTAMPTZ '2026-10-06 11:00:00+00')`, [address, slot, quote, base, status]);
      }
      // [mint, slot, quote reserves, base reserves, confirmation status]
      const curves: readonly (readonly [string, number, string, string, string])[] = [
        [curveMint, 100, '5', '5', 'confirmed'],
        [curveMint, 200, '30000000000', '1073000000000000', 'confirmed'],
        [curveMint, 300, '1', '1', 'orphaned'],
        // A positive curve snapshot must not rescue a mint whose latest pool snapshot is empty.
        [zeroMint, 100, '30000000000', '1073000000000000', 'confirmed'],
      ];
      for (const [mint, slot, quote, base, status] of curves) {
        await client.query(`INSERT INTO bonding_curve_snapshots (
          snapshot_id,mint,quote_mint,quote_decimals,quote_token_program,real_base_reserves_raw,
          real_quote_reserves_raw,virtual_base_reserves_raw,virtual_quote_reserves_raw,
          progress_bps,complete,slot,transaction_index,instruction_index,confirmation_status
        ) VALUES ($1||'_'||$2::TEXT,$1,$5,9,'tp',0,0,$4::NUMERIC,$3::NUMERIC,0,false,$2::NUMERIC,0,0,$6)`,
        [mint, slot, quote, base, WSOL, status]);
      }
    });
    const source: ExecutorDatabaseSource = {
      connect: async () => {
        const client = await pool.connect();
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE sol_token_operator_reader');
        return {
          query: async (text, values) => {
            const result = await client.query<Record<string, unknown>>(text, [...(values ?? [])]);
            return { rows: result.rows, rowCount: result.rowCount };
          },
          release: () => {
            void client.query('ROLLBACK').catch(() => undefined).then(() => { client.release(); });
          },
        };
      },
    };
    const overview = createLiveOverviewReader({
      database: source, balances: { read: () => Promise.resolve(null) },
    });
    // One open position per generation: the same position is re-pointed at each mint in turn.
    const expectations: readonly (readonly [string, bigint | null, bigint | null])[] = [
      [poolMint, 1_957_129n, 952_129n],
      [curveMint, 978_564n, -26_436n],
      [zeroMint, null, null],
    ];
    for (const [index, [mint, spot, unrealized]] of expectations.entries()) {
      await asSuperuser(pool, async (client) => {
        await client.query('DELETE FROM execution_live_positions');
        await client.query(`INSERT INTO execution_live_positions (
          position_id,buy_intent_id,generation_id,armament_id,wallet_public_key,mint,quote_mint,
          entry_venue,quote_cost_raw,base_amount_raw,remaining_base_raw,fee_lamports,
          maximum_holding_ms,opened_at,exit_deadline_at,entry_reconciliation_fingerprint,state
        ) VALUES ('execution_live_position_'||$1,'execution_intent_'||$1,
          'execution_wallet_generation_'||$1,'execution_activation_armament_'||$1,$2,$3,$4,
          'PUMP_FUN',1000000,35000000000,35000000000,5000,300000,
          TIMESTAMPTZ '2026-10-06 11:55:00+00',TIMESTAMPTZ '2026-10-06 12:00:00+00',$1,'OPEN')`,
        [hex('a'), wallet, mint, WSOL]);
      });
      const { data } = await overview.read({ limit: 50, cursor: null });
      assert.equal(data.wallet, wallet, mint);
      assert.deepEqual(data.open.map((position) => [position.spotValueLamports, position.unrealizedLamports]),
        [[spot, unrealized]], `position ${String(index)} (${mint})`);
      assert.equal(data.totals.positionsWithoutPnl, spot === null ? 1 : 0, mint);
      assert.equal(data.totals.unrealizedLamports, unrealized ?? 0n, mint);
    }
  });
});

async function asSuperuser(
  pool: InstanceType<typeof pg.Pool>,
  callback: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await callback(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function readAs(
  pool: InstanceType<typeof pg.Pool>,
  role: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    return (await client.query<Record<string, unknown>>(text, [...values])).rows;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function probe(
  pool: InstanceType<typeof pg.Pool>,
  role: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<'allowed' | 'denied'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(text, [...values]);
    return 'allowed';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42501') {
      return 'denied';
    }
    throw error;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function withProvisionedDatabase(
  context: TestContext,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const configuredUrl = process.env.TEST_DATABASE_URL;
  if (configuredUrl === undefined || configuredUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured.');
    return;
  }
  const maintenance = new pg.Pool({ connectionString: configuredUrl });
  const capability = (await maintenance.query<{
    readonly rolsuper: boolean; readonly rolcreatedb: boolean; readonly version: number;
  }>(`SELECT rolsuper,rolcreatedb,current_setting('server_version_num')::INTEGER AS version
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (!capability?.rolsuper || !capability.rolcreatedb || capability.version < 160_000) {
    await maintenance.end();
    context.skip('PostgreSQL 16 superuser with CREATEDB is required.');
    return;
  }
  const release = await acquireExecutorRoleTestLock(maintenance);
  const databaseName = `live_ledger_roles_${randomUUID().replaceAll('-', '')}`;
  const isolatedUrl = new URL(configuredUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  let isolated: InstanceType<typeof pg.Pool> | undefined;
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    isolated = new pg.Pool({ connectionString: isolatedUrl.href });
    await migrateDatabase({ pool: isolated });
    const provisioningSql = await readFile(scriptUrl, 'utf8');
    await isolated.query(provisioningSql);
    await isolated.query(provisioningSql);
    await callback(isolated);
  } finally {
    try {
      await isolated?.end();
      await waitForBackendDrain(maintenance, databaseName);
      const terminated = await maintenance.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [databaseName],
      );
      assert.equal(terminated.rowCount, 0);
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      try { await release(); } finally { await maintenance.end(); }
    }
  }
}
