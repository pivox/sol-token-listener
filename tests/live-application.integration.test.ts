import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { integrationPool } from './helpers/live-application-process.js';

void test('listener worker BUY survives a process crash and a new process restores then SELLs exactly once', async (context) => {
  const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;
  if (databaseUrl === undefined) {
    context.skip('LIVE_TEST_DATABASE_URL must point to a disposable local PostgreSQL instance.');
    return;
  }
  const admin = new pg.Client({ connectionString: databaseUrl });
  const schema = `live_it_${randomUUID().replaceAll('-', '')}`;
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    for (const migration of ['016_live_order_journal.sql', '017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql']) {
      await pool.query(await readFile(resolve('migrations', migration), 'utf8'));
    }
    const processA = runStage(databaseUrl, schema, 'buy-crash');
    assert.equal(processA.status, 77, `${processA.stderr} ${processA.stdout}`);
    const submitted = await pool.query<{ side: string; status: string; signature: string }>(
      'SELECT side,status,signature FROM live_orders ORDER BY created_at',
    );
    assert.equal(submitted.rows.length, 1);
    assert.equal(submitted.rows[0]?.side, 'BUY');
    assert.equal(submitted.rows[0]?.status, 'SUBMITTED', 'the simulated process exit happened after send and before confirmation persistence');
    assert.ok(submitted.rows[0]?.signature);
    const admission = await pool.query<{ admission: { profileId: string; characteristics: { cashback: boolean }; evidence: { slot: string; source: string } } }>(
      "SELECT intent->'admission' AS admission FROM live_orders WHERE side='BUY'",
    );
    assert.equal(admission.rows[0]?.admission.profileId, 'pumpfun-v2-to-pumpswap-sol-spl-or-token2022-metadata-only-v1');
    assert.equal(admission.rows[0]?.admission.characteristics.cashback, false);
    assert.equal(admission.rows[0]?.admission.evidence.source, 'validated_getMultipleAccounts_same_slot');
    assert.equal(admission.rows[0]?.admission.evidence.slot, '123');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM live_positions')).rows[0]?.count, 0,
      'submission without confirmation did not fabricate a position');

    const buySignature = submitted.rows[0]?.signature;
    assert.ok(buySignature);
    const processB = runStage(databaseUrl, schema, 'recover-sell', buySignature);
    assert.equal(processB.status, 0, processB.stderr);
    assert.match(processB.stdout, /LIVE_TEST_NEW_SENDS=1/u,
      'process B confirms the persisted BUY signature without resending it and sends only the SELL');
    const orders = await pool.query<{ side: string; status: string }>(
      'SELECT side,status FROM live_orders ORDER BY side',
    );
    assert.deepEqual(orders.rows, [
      { side: 'BUY', status: 'CONFIRMED' },
      { side: 'SELL', status: 'CONFIRMED' },
    ]);
    const positions = await pool.query<{ status: string; acquired_raw: string; remaining_raw: string; buy_signature: string; sell_signature: string }>(
      'SELECT status,acquired_raw::text,remaining_raw::text,buy_signature,sell_signature FROM live_positions',
    );
    assert.equal(positions.rows.length, 1);
    assert.equal(positions.rows[0]?.status, 'CLOSED');
    assert.equal(positions.rows[0]?.acquired_raw, '12345');
    assert.equal(positions.rows[0]?.remaining_raw, '0');
    assert.ok(positions.rows[0]?.buy_signature);
    assert.ok(positions.rows[0]?.sell_signature);
    const fills = await pool.query<{ side: string; applied: boolean; delta_raw: string }>(
      'SELECT side,applied,delta_raw::text FROM live_position_fills ORDER BY side',
    );
    assert.deepEqual(fills.rows, [
      { side: 'BUY', applied: true, delta_raw: '12345' },
      { side: 'SELL', applied: true, delta_raw: '-12345' },
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

void test('cashback and unknown bonding-curve layouts reject listener candidates before durable order or signing', async (context) => {
  const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;
  if (databaseUrl === undefined) { context.skip('LIVE_TEST_DATABASE_URL must point to a disposable local PostgreSQL instance.'); return; }
  const admin = new pg.Client({ connectionString: databaseUrl });
  const schema = `live_cashback_${randomUUID().replaceAll('-', '')}`;
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    for (const migration of ['016_live_order_journal.sql','017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql']) {
      await pool.query(await readFile(resolve('migrations',migration),'utf8'));
    }
    for (const stage of ['cashback-reject','unknown-layout-reject','unsupported-extension-reject'] as const) {
      const processResult=runStage(databaseUrl,schema,stage);
      assert.equal(processResult.status,0,processResult.stderr);
      assert.match(processResult.stdout,/LIVE_TEST_NEW_SENDS=0\n/u,stage);
      assert.match(processResult.stderr,/LIVE_BUY_REJECTED/u,stage);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM live_orders')).rows[0]?.count,0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM live_positions')).rows[0]?.count,0);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

void test('live:run --stop-entries processes a real listener candidate without creating a BUY', async (context) => {
  const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;
  if (databaseUrl === undefined) { context.skip('LIVE_TEST_DATABASE_URL must point to a disposable local PostgreSQL instance.'); return; }
  const admin = new pg.Client({ connectionString: databaseUrl });
  const schema = `live_it_${randomUUID().replaceAll('-', '')}`;
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    for (const migration of ['016_live_order_journal.sql', '017_live_positions.sql', '018_live_position_market_route.sql', '019_live_position_market_route_recovery.sql', '020_live_position_market_resolution.sql']) {
      await pool.query(await readFile(resolve('migrations', migration), 'utf8'));
    }
    const result = runStage(databaseUrl, schema, 'stop-entries');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LIVE_TEST_NEW_SENDS=0\n/u);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM live_orders')).rows[0]?.count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM live_positions')).rows[0]?.count, 0);
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
});

void test('a tracked cashback bonding-curve position sells through the current Pump.fun V2 state', async (context) => {
  const databaseUrl=process.env.LIVE_TEST_DATABASE_URL;
  if(databaseUrl===undefined){context.skip('LIVE_TEST_DATABASE_URL must point to a disposable local PostgreSQL instance.');return;}
  const admin=new pg.Client({connectionString:databaseUrl});const schema=`live_cashback_${randomUUID().replaceAll('-','')}`;
  await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});
  try{
    for(const migration of ['016_live_order_journal.sql','017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql'])
      await pool.query(await readFile(resolve('migrations',migration),'utf8'));
    const open=runStage(databaseUrl,schema,'cashback-bonding-open');
    assert.equal(open.status,0,open.stderr);
    const signature=(await pool.query<{signature:string}>("SELECT signature FROM live_orders WHERE side='BUY'")).rows[0]?.signature;
    assert.ok(signature);
    const exit=runStage(databaseUrl,schema,'cashback-bonding-sell',signature);
    assert.equal(exit.status,0,exit.stderr);
    assert.match(exit.stdout,/LIVE_TEST_NEW_SENDS=1\n/u);
    assert.deepEqual((await pool.query('SELECT side,status FROM live_orders ORDER BY side')).rows,
      [{side:'BUY',status:'CONFIRMED'},{side:'SELL',status:'CONFIRMED'}]);
    assert.deepEqual((await pool.query('SELECT status,remaining_raw::text FROM live_positions')).rows,
      [{status:'CLOSED',remaining_raw:'0'}]);
  }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});

void test('a tracked cashback position resumes PumpSwap SELL after restart without a duplicate', async (context) => {
  const databaseUrl=process.env.LIVE_TEST_DATABASE_URL;
  if(databaseUrl===undefined){context.skip('LIVE_TEST_DATABASE_URL must point to a disposable local PostgreSQL instance.');return;}
  const admin=new pg.Client({connectionString:databaseUrl});const schema=`live_cashback_${randomUUID().replaceAll('-','')}`;
  await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});
  try{
    for(const migration of ['016_live_order_journal.sql','017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql'])
      await pool.query(await readFile(resolve('migrations',migration),'utf8'));
    const wait=runStage(databaseUrl,schema,'migration-wait');
    assert.equal(wait.status,0,wait.stderr);
    const signature=(await pool.query<{signature:string}>("SELECT signature FROM live_orders WHERE side='BUY'")).rows[0]?.signature;
    assert.ok(signature);
    const exit=runStage(databaseUrl,schema,'cashback-migrated-sell',signature);
    assert.equal(exit.status,0,exit.stderr);
    assert.match(exit.stdout,/LIVE_TEST_PUMPSWAP_SELLS=1\n/u);
    assert.match(exit.stdout,/LIVE_TEST_CASHBACK_ACCOUNTS=2\n/u);
    assert.deepEqual((await pool.query('SELECT side,status FROM live_orders ORDER BY side')).rows,
      [{side:'BUY',status:'CONFIRMED'},{side:'SELL',status:'CONFIRMED'}]);
    assert.deepEqual((await pool.query('SELECT status,remaining_raw::text FROM live_positions')).rows,
      [{status:'CLOSED',remaining_raw:'0'}]);
  }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});

void test('operator recheck resolves an unindexed canonical pool after restart, then controller quotes and sells once', async (context) => {
  const databaseUrl=process.env.LIVE_TEST_DATABASE_URL;
  if(databaseUrl===undefined){context.skip('LIVE_TEST_DATABASE_URL must point to a disposable local PostgreSQL instance.');return;}
  const admin=new pg.Client({connectionString:databaseUrl});const schema=`live_mig_${randomUUID().replaceAll('-','')}`;
  await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});
  try{
    for(const migration of ['016_live_order_journal.sql','017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql'])
      await pool.query(await readFile(resolve('migrations',migration),'utf8'));
    await pool.query('CREATE TABLE migration_history(version TEXT PRIMARY KEY)');
    await pool.query("INSERT INTO migration_history(version) VALUES ('016_live_order_journal.sql'),('017_live_positions.sql'),('018_live_position_market_route.sql'),('019_live_position_market_route_recovery.sql'),('020_live_position_market_resolution.sql')");
    assert.equal((await pool.query("SELECT to_regclass('market_pools') AS local_pool_index")).rows[0]?.local_pool_index,null,
      'the isolated test schema has no ingested PumpSwap pool index');
    const processA=runStage(databaseUrl,schema,'direct-pool-exhausted');
    assert.equal(processA.status,0,`${processA.stderr} ${processA.stdout}`);
    assert.deepEqual((await pool.query('SELECT side,status FROM live_orders')).rows,[{side:'BUY',status:'CONFIRMED'}]);
    assert.deepEqual((await pool.query('SELECT state,attempts,resolution_source FROM live_position_market_routes')).rows,
      [{state:'RETRY_EXHAUSTED',attempts:1,resolution_source:'RPC_CANONICAL_PDA'}]);
    const buySignature=(await pool.query<{signature:string}>("SELECT signature FROM live_orders WHERE side='BUY'")).rows[0]?.signature;
    assert.ok(buySignature);
    const processB=runStage(databaseUrl,schema,'direct-pool-operator-sell',buySignature);
    assert.equal(processB.status,0,`${processB.stderr} ${processB.stdout}`);
    assert.match(processB.stdout,/"state":"PUMPSWAP"/u,'the read-only operator recheck resolved the canonical PDA directly');
    assert.match(processB.stdout,/LIVE_TEST_PUMPSWAP_SELLS=1\n/u);
    assert.match(processB.stdout,/LIVE_TEST_PUMPFUN_EXIT_QUOTES=0\n/u);
    assert.deepEqual((await pool.query('SELECT side,status FROM live_orders ORDER BY side')).rows,
      [{side:'BUY',status:'CONFIRMED'},{side:'SELL',status:'CONFIRMED'}]);
    assert.deepEqual((await pool.query('SELECT state,attempts,retry_generation,resolution_source,pool_address FROM live_position_market_routes')).rows,
      [{state:'PUMPSWAP',attempts:0,retry_generation:1,resolution_source:'RPC_CANONICAL_PDA',pool_address:integrationPool().address}]);
    assert.deepEqual((await pool.query('SELECT status,remaining_raw::text FROM live_positions')).rows,
      [{status:'CLOSED',remaining_raw:'0'}]);
  }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});

void test('incoherent direct PumpSwap vault keeps the tracked position open and submits no SELL', async (context) => {
  const databaseUrl=process.env.LIVE_TEST_DATABASE_URL;
  if(databaseUrl===undefined){context.skip('LIVE_TEST_DATABASE_URL must point to a disposable local PostgreSQL instance.');return;}
  const admin=new pg.Client({connectionString:databaseUrl});const schema=`live_mig_${randomUUID().replaceAll('-','')}`;
  await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});
  try{
    for(const migration of ['016_live_order_journal.sql','017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql'])
      await pool.query(await readFile(resolve('migrations',migration),'utf8'));
    const processResult=runStage(databaseUrl,schema,'direct-pool-invalid');
    assert.equal(processResult.status,0,`${processResult.stderr} ${processResult.stdout}`);
    assert.deepEqual((await pool.query('SELECT side,status FROM live_orders')).rows,[{side:'BUY',status:'CONFIRMED'}]);
    assert.deepEqual((await pool.query('SELECT status,remaining_raw::text FROM live_positions')).rows,[{status:'OPEN',remaining_raw:'12345'}]);
    assert.deepEqual((await pool.query('SELECT state,resolution_source,last_error FROM live_position_market_routes')).rows,
      [{state:'UNKNOWN',resolution_source:'RPC_CANONICAL_PDA',last_error:'direct market resolution failed: Direct PumpSwap vault Token Program or layout is invalid.'}]);
  }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});

void test('Token-2022 create_v2 position completes BUY→migration→PumpSwap SELL across two processes', async (context) => {
  const databaseUrl=process.env.LIVE_TEST_DATABASE_URL;
  if(databaseUrl===undefined){context.skip('LIVE_TEST_DATABASE_URL must point to a disposable local PostgreSQL instance.');return;}
  const admin=new pg.Client({connectionString:databaseUrl});const schema=`live_mig_${randomUUID().replaceAll('-','')}`;
  await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});
  try{
    for(const migration of ['016_live_order_journal.sql','017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql'])
      await pool.query(await readFile(resolve('migrations',migration),'utf8'));
    const processA=runStage(databaseUrl,schema,'token2022-migration-wait');
    assert.equal(processA.status,0,processA.stderr);
    assert.deepEqual((await pool.query('SELECT token_program,status FROM live_positions')).rows,
      [{token_program:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',status:'OPEN'}]);
    const evidence=await pool.query<{admission:{evidence:{mintExtensions:string[]};characteristics:{holderReward:boolean}}}>(
      "SELECT intent->'admission' AS admission FROM live_orders WHERE side='BUY'");
    assert.deepEqual(evidence.rows[0]?.admission.evidence.mintExtensions,['MetadataPointer']);
    assert.equal(evidence.rows[0]?.admission.characteristics.holderReward,false);
    const buySignature=(await pool.query<{signature:string}>("SELECT signature FROM live_orders WHERE side='BUY'")).rows[0]?.signature;
    assert.ok(buySignature);
    const processB=runStage(databaseUrl,schema,'token2022-migrated-sell',buySignature);
    assert.equal(processB.status,0,processB.stderr);
    assert.match(processB.stdout,/LIVE_TEST_PUMPSWAP_SELLS=1\n/u);
    assert.match(processB.stdout,/LIVE_TEST_PUMPSWAP_AMOUNT=12345\n/u);
    assert.match(processB.stdout,/LIVE_TEST_PUMPFUN_EXIT_QUOTES=0\n/u);
    assert.deepEqual((await pool.query('SELECT side,status FROM live_orders ORDER BY side')).rows,
      [{side:'BUY',status:'CONFIRMED'},{side:'SELL',status:'CONFIRMED'}]);
    assert.deepEqual((await pool.query('SELECT status,remaining_raw::text FROM live_positions')).rows,
      [{status:'CLOSED',remaining_raw:'0'}]);
  }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});

void test('position waits after completed curve, then resumed process resolves and sells through PumpSwap exactly once', async (context) => {
  const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;
  if (databaseUrl === undefined) { context.skip('LIVE_TEST_DATABASE_URL must point to a disposable local PostgreSQL instance.'); return; }
  const admin = new pg.Client({ connectionString: databaseUrl });
  const schema = `live_mig_${randomUUID().replaceAll('-', '')}`;
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    for (const migration of ['016_live_order_journal.sql','017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql']) {
      await pool.query(await readFile(resolve('migrations',migration),'utf8'));
    }
    const processA=runStage(databaseUrl,schema,'migration-wait');
    assert.equal(processA.status,0,`${processA.stderr} ${processA.stdout}`);
    assert.deepEqual((await pool.query('SELECT side,status FROM live_orders')).rows,[{side:'BUY',status:'CONFIRMED'}]);
    assert.deepEqual((await pool.query('SELECT status,remaining_raw::text FROM live_positions')).rows,[{status:'OPEN',remaining_raw:'12345'}]);
    assert.deepEqual((await pool.query('SELECT state,attempts FROM live_position_market_routes')).rows,[{state:'WAITING_FOR_POOL',attempts:1}]);

    const buySignature=(await pool.query<{signature:string}>('SELECT signature FROM live_orders WHERE side=\'BUY\'')).rows[0]?.signature;
    assert.ok(buySignature);
    const processB=runStage(databaseUrl,schema,'migrated-sell',buySignature);
    assert.equal(processB.status,0,processB.stderr);
    const strategyState=await pool.query<{status:string;counted_external_buy_ids:string;state:string}>('SELECT status,counted_external_buy_ids::text,(SELECT state FROM live_position_market_routes) AS state FROM live_positions');
    assert.match(processB.stdout,/LIVE_TEST_NEW_SENDS=1/u,`${processB.stdout}; ${JSON.stringify(strategyState.rows)}`);
    assert.match(processB.stdout,/LIVE_TEST_PUMPSWAP_SELLS=1/u);
    assert.match(processB.stdout,/LIVE_TEST_PUMPSWAP_AMOUNT=12345\n/u);
    assert.match(processB.stdout,/LIVE_TEST_PUMPSWAP_MIN=[1-9]\d*\n/u);
    assert.match(processB.stdout,/LIVE_TEST_PUMPFUN_EXIT_QUOTES=0\n/u,'the post-migration exit did not reuse a bonding-curve quote');
    assert.deepEqual((await pool.query('SELECT side,status FROM live_orders ORDER BY side')).rows,
      [{side:'BUY',status:'CONFIRMED'},{side:'SELL',status:'CONFIRMED'}]);
    assert.deepEqual((await pool.query('SELECT status,remaining_raw::text FROM live_positions')).rows,
      [{status:'CLOSED',remaining_raw:'0'}]);
    assert.deepEqual((await pool.query('SELECT side,delta_raw::text,applied FROM live_position_fills ORDER BY side')).rows,
      [{side:'BUY',delta_raw:'12345',applied:true},{side:'SELL',delta_raw:'-12345',applied:true}]);
    assert.deepEqual((await pool.query('SELECT state,pool_address FROM live_position_market_routes')).rows,
      [{state:'PUMPSWAP',pool_address:integrationPool().address}]);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

void test('PumpSwap SELL submitted before crash is reconciled after restart without a second SELL', async (context) => {
  const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;
  if (databaseUrl === undefined) { context.skip('LIVE_TEST_DATABASE_URL must point to a disposable local PostgreSQL instance.'); return; }
  const admin = new pg.Client({ connectionString: databaseUrl });
  const schema = `live_mig_${randomUUID().replaceAll('-', '')}`;
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    for (const migration of ['016_live_order_journal.sql','017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql']) {
      await pool.query(await readFile(resolve('migrations',migration),'utf8'));
    }
    const processA=runStage(databaseUrl,schema,'migration-wait');
    assert.equal(processA.status,0,`${processA.stderr} ${processA.stdout}`);
    const buySignature=(await pool.query<{signature:string}>('SELECT signature FROM live_orders WHERE side=\'BUY\'')).rows[0]?.signature;
    assert.ok(buySignature);

    const processB=runStage(databaseUrl,schema,'migrated-sell-crash',buySignature);
    assert.equal(processB.status,77,`${processB.stderr} ${processB.stdout}`);
    assert.deepEqual((await pool.query('SELECT side,status FROM live_orders ORDER BY side')).rows,
      [{side:'BUY',status:'CONFIRMED'},{side:'SELL',status:'SUBMITTED'}]);
    assert.deepEqual((await pool.query('SELECT status,remaining_raw::text FROM live_positions')).rows,
      [{status:'OPEN',remaining_raw:'12345'}],'a submitted SELL without persisted confirmation leaves the position open');
    const sellSignature=(await pool.query<{signature:string}>('SELECT signature FROM live_orders WHERE side=\'SELL\'')).rows[0]?.signature;
    assert.ok(sellSignature);

    const processC=runStage(databaseUrl,schema,'recover-migrated-sell',buySignature,sellSignature);
    assert.equal(processC.status,0,processC.stderr);
    assert.match(processC.stdout,/LIVE_TEST_NEW_SENDS=0\n/u,'restart reconciles the same confirmed signature and sends no duplicate SELL');
    assert.deepEqual((await pool.query('SELECT side,status FROM live_orders ORDER BY side')).rows,
      [{side:'BUY',status:'CONFIRMED'},{side:'SELL',status:'CONFIRMED'}]);
    assert.deepEqual((await pool.query('SELECT status,remaining_raw::text FROM live_positions')).rows,
      [{status:'CLOSED',remaining_raw:'0'}]);
    assert.deepEqual((await pool.query('SELECT side,delta_raw::text,applied FROM live_position_fills ORDER BY side')).rows,
      [{side:'BUY',delta_raw:'12345',applied:true},{side:'SELL',delta_raw:'-12345',applied:true}]);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

function runStage(databaseUrl: string, schema: string,
  stage: 'buy-crash' | 'recover-sell' | 'migration-wait' | 'migrated-sell' | 'migrated-sell-crash' | 'recover-migrated-sell' | 'cashback-reject' | 'unknown-layout-reject' | 'token2022-migration-wait' | 'token2022-migrated-sell' | 'unsupported-extension-reject' | 'cashback-bonding-open' | 'cashback-bonding-sell' | 'cashback-migrated-sell' | 'direct-pool-exhausted' | 'direct-pool-operator-sell' | 'direct-pool-invalid' | 'stop-entries',
  priorBuySignature?: string, priorSellSignature?: string) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LIVE_TEST_DATABASE_URL: databaseUrl,
    LIVE_TEST_SCHEMA: schema,
    LIVE_TEST_STAGE: stage,
  };
  if (priorBuySignature !== undefined) env.LIVE_TEST_CONFIRMED_BUY_SIGNATURE = priorBuySignature;
  if (priorSellSignature !== undefined) env.LIVE_TEST_CONFIRMED_SELL_SIGNATURE = priorSellSignature;
  return spawnSync(process.execPath, ['--import', 'tsx', 'tests/helpers/live-application-process.ts'], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
}
