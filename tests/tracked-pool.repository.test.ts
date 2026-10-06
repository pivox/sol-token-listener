import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';
import {
  MAX_TRACKED_POOLS,
  PostgresTrackedPoolRepository,
} from '../src/storage/tracked-pool.repository.js';

type TestPool = InstanceType<typeof pg.Pool>;

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: TestPool) => Promise<void>,
): Promise<void> {
  const schema = `tracked_pool_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await callback(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

function base58(index: number): string {
  const letters = 'abcdefghijkmnopqrstuvwxyz';
  return `${letters[index % letters.length]}${letters[Math.floor(index / letters.length)]}${'2'.repeat(40)}`;
}

// The session row is minimal: foreign keys are bypassed because only `mint` and `state` matter here.
async function insertPaperSession(pool: TestPool, sessionId: string, mint: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await client.query(`INSERT INTO paper_strategy_sessions (
      session_id,mint,candidate_id,report_id,source_event_id,session_event_id,strategy_id,
      strategy_version,actor_kind,state,reason_code,quote_mint,quote_decimals,
      quote_token_program,position_id,open_command_id,entry_slot,entry_transaction_index,
      entry_instruction_index,external_buy_target,external_buy_count,minimum_confirmation,
      created_at,updated_at,payload_version,payload
    ) VALUES ($1,$2,'candidate','report','source-open','source-open','other-strategy',1,
      'PAPER_SIMULATION','PAPER_HOLDING','EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED','SOL',9,
      'SPL_TOKEN',$3,$4,9,0,0,3,0,'confirmed',to_timestamp(1),to_timestamp(1),2,'{}')`,
    [sessionId, mint, `position-${sessionId}`, `paper_open_${'a'.repeat(64)}`]);
  } finally {
    await client.query('SET session_replication_role = DEFAULT');
    client.release();
  }
}

async function seedPool(
  pool: TestPool,
  index: number,
  options: { readonly slot: number; readonly tracked: boolean; readonly status?: string },
): Promise<{ readonly mint: string; readonly poolAddress: string; readonly signature: string }> {
  const mint = `M${base58(index)}`;
  const poolAddress = `P${base58(index)}`;
  const signature = `sig${index}`;
  const status = options.status ?? 'confirmed';
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,current_state,created_signature,
    created_slot,created_transaction_index,created_instruction_index,detected_at,updated_at
  ) VALUES ($1,'pumpfun','pump','creator','SPL_TOKEN','PUMPSWAP_ACTIVE',$2,1,0,1,
    to_timestamp(1),to_timestamp(1))`, [mint, `create${index}`]);
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,blockchain_time,observed_at,
    payload_version,payload,processing_status
  ) VALUES ($1,'pumpfun','pump',$2,$3,$4,0,0,NULL,'confirmed',to_timestamp(1),
    to_timestamp(1),1,'{}','processed')`, [`raw${index}`, mint, signature, options.slot]);
  for (const [eventId, type] of [
    [`migration-event${index}`, 'MigrationObserved'],
    [`activation${index}`, 'PumpSwapPoolActivated'],
  ] as const) {
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
      instruction_index,inner_instruction_index,confirmation_status,blockchain_time,
      observed_at,payload_version,payload
    ) VALUES ($1,$2,$3,$4,'pumpfun','pump',$5,$6,0,${type === 'MigrationObserved' ? 1 : 2},
      NULL,$7,to_timestamp(1),to_timestamp(1),1,'{}')`,
    [eventId, `raw${index}`, type, mint, signature, options.slot, status]);
  }
  await pool.query(`INSERT INTO migrations (
    migration_id,event_id,mint,bonding_curve,announced_pool,instruction_kind,quote_mint,
    quote_decimals,base_token_program,quote_token_program,confirmation_status,
    payload_version,payload
  ) VALUES ($1,$2,$3,'curve',$4,'MIGRATE','quote',9,'tp','tp',$5,1,'{}')`,
  [`migration${index}`, `migration-event${index}`, mint, poolAddress, status]);
  await pool.query(`INSERT INTO market_pools (
    pool_address,market,program_id,pool_index,creator,base_mint,quote_mint,quote_decimals,
    base_token_program,quote_token_program,base_vault,quote_vault,lp_mint,migration_id,
    activation_event_id,pool_state,confirmation_status,slot,transaction_index,
    instruction_index,payload_version,payload
  ) VALUES ($1,'market','amm',0,'creator',$2,'quote',9,'tp','tp','bv','qv','lp',$3,$4,
    'active',$5,$6,0,2,1,'{}')`,
  [poolAddress, mint, `migration${index}`, `activation${index}`, status, options.slot]);
  if (options.tracked) {
    await insertPaperSession(pool, `paper_session_${String(index).padStart(64, '0')}`, mint);
  }
  return { mint, poolAddress, signature };
}

void test('tracked pool repository selects tracked pools and keeps monotonic checkpoints',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL is not configured');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      await migrateDatabase({ pool });
      const repository = new PostgresTrackedPoolRepository(pool);
      const tracked = await seedPool(pool, 1, { slot: 100, tracked: true });
      await seedPool(pool, 2, { slot: 101, tracked: false });
      const orphaned = await seedPool(pool, 3, { slot: 102, tracked: true, status: 'orphaned' });
      await pool.query("UPDATE market_pools SET pool_state='retracted' WHERE pool_address=$1",
        [orphaned.poolAddress]);
      const retracted = await seedPool(pool, 4, { slot: 103, tracked: true });
      await pool.query("UPDATE market_pools SET pool_state='retracted' WHERE pool_address=$1",
        [retracted.poolAddress]);

      assert.deepEqual(await repository.listTrackedPools(45), [{
        poolAddress: tracked.poolAddress,
        baseMint: tracked.mint,
        activationSignature: tracked.signature,
        activationSlot: 100n,
      }]);

      assert.equal(await repository.readCheckpoint(tracked.poolAddress), null);
      await repository.seedCheckpoint(tracked.poolAddress, { slot: 100n, signature: 'a' }, 1_000);
      await repository.seedCheckpoint(tracked.poolAddress, { slot: 200n, signature: 'b' }, 2_000);
      assert.deepEqual(await repository.readCheckpoint(tracked.poolAddress), { slot: 100n, signature: 'a' });
      await repository.storeCheckpoint(tracked.poolAddress, { slot: 150n, signature: 'c' }, 3_000);
      assert.deepEqual(await repository.readCheckpoint(tracked.poolAddress), { slot: 150n, signature: 'c' });
      await assert.rejects(
        repository.storeCheckpoint(tracked.poolAddress, { slot: 149n, signature: 'd' }, 4_000),
      );
    });
  });

void test('tracked pool repository excludes orphaned pools and caps the list newest first',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL is not configured');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      await migrateDatabase({ pool });
      const repository = new PostgresTrackedPoolRepository(pool);
      await seedPool(pool, 90, { slot: 9_999, tracked: true, status: 'orphaned' });
      for (let index = 1; index <= 25; index += 1) {
        await seedPool(pool, index, { slot: 100 + index, tracked: true });
      }
      const listed = await repository.listTrackedPools(45);
      assert.equal(listed.length, MAX_TRACKED_POOLS);
      assert.equal(listed[0]?.activationSlot, 125n);
      assert.equal(listed[MAX_TRACKED_POOLS - 1]?.activationSlot, 106n);
    });
  });
