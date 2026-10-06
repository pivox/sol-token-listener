import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';
import { LIVE_POSITION_LEDGER_INSERT_SQL } from '../src/storage/execution-live.repository.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

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

    for (const role of [
      'sol_token_public_api', 'sol_token_listener_writer', 'sol_token_executor_worker',
      'sol_token_executor_operations', 'sol_token_executor_readiness',
      'sol_token_executor_live', 'sol_token_retention_worker',
    ]) assert.equal(
      await probe(pool, role, 'SELECT 1 FROM execution_live_position_ledger'), 'denied', role,
    );
  });
});

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
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      try { await release(); } finally { await maintenance.end(); }
    }
  }
}
