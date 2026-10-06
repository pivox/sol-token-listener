import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import pg from 'pg';
import { bondingCurvePda } from '../src/launchpads/pumpfun/official-sdk.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresTrackedCurveRepository, selectTrackedCurves } from '../src/storage/tracked-curve.repository.js';
import { MAX_TRACKED_POOLS } from '../src/storage/tracked-pool.repository.js';

type TestPool = InstanceType<typeof pg.Pool>;

async function withTemporarySchema(
  context: TestContext,
  callback: (pool: TestPool) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: tracked curve repository tests skipped');
    return;
  }
  const schema = `tracked_curve_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateDatabase({ pool });
    await callback(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function seedLaunch(pool: TestPool, slot: number): Promise<string> {
  const mint = Keypair.generate().publicKey.toBase58();
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,created_instruction_index,
    created_inner_instruction_index,detected_at,updated_at
  ) VALUES ($1,'pumpfun','pump','creator','SPL_TOKEN','[]','ACTIVE',$2,$3,0,0,NULL,now(),now())`,
  [mint, `create-${slot}`, slot]);
  return mint;
}

async function seedActivePool(pool: TestPool, mint: string): Promise<void> {
  await pool.query(`INSERT INTO domain_events (
    event_id,type,mint,source,program,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) VALUES
    ('migration-event','MigrationObserved',$1,'pumpfun','pump','migration-signature',
      3,0,0,'confirmed',now(),1,'{}'),
    ('activation-event','PumpSwapPoolActivated',$1,'pumpswap','pumpswap','activation-signature',
      4,0,0,'confirmed',now(),1,'{}')`, [mint]);
  await pool.query(`INSERT INTO migrations (
    migration_id,event_id,mint,bonding_curve,announced_pool,instruction_kind,
    quote_mint,quote_decimals,base_token_program,quote_token_program,
    confirmation_status,payload_version,payload
  ) VALUES ('migration','migration-event',$1,'CURVE','POOL','MIGRATE','SOL',9,
    'SPL_TOKEN','SPL_TOKEN','confirmed',1,'{}')`, [mint]);
  await pool.query(`INSERT INTO market_pools (
    pool_address,market,program_id,pool_index,creator,base_mint,quote_mint,
    quote_decimals,base_token_program,quote_token_program,base_vault,quote_vault,
    lp_mint,migration_id,activation_event_id,pool_state,confirmation_status,slot,
    transaction_index,instruction_index,payload_version,payload
  ) VALUES ('POOL','pumpswap','pumpswap',0,'creator',$1,'SOL',9,'SPL_TOKEN',
    'SPL_TOKEN','BASE_VAULT','QUOTE_VAULT','LP','migration','activation-event','active',
    'confirmed',4,0,0,1,'{}')`, [mint]);
}

void test('tracked curves are the newest unmigrated launches among the tracked mints', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    const a = await seedLaunch(pool, 10);
    const b = await seedLaunch(pool, 20);
    const c = await seedLaunch(pool, 30);
    const absent = Keypair.generate().publicKey.toBase58();

    const all = await selectTrackedCurves(pool, [a, b, c, absent]);
    assert.deepEqual(all.map((entry) => entry.baseMint), [c, b, a]);
    assert.deepEqual(all.map((entry) => entry.poolAddress),
      [c, b, a].map((mint) => bondingCurvePda(new PublicKey(mint)).toBase58()));
    assert.deepEqual(all.map((entry) => [entry.activationSignature, entry.activationSlot]),
      [['create-30', 30n], ['create-20', 20n], ['create-10', 10n]]);

    await seedActivePool(pool, b);
    assert.deepEqual((await selectTrackedCurves(pool, [a, b, c])).map((entry) => entry.baseMint), [c, a]);
  });
});

void test('tracked curves are capped', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    const mints: string[] = [];
    for (let slot = 1; slot <= 25; slot += 1) mints.push(await seedLaunch(pool, slot));
    assert.equal((await selectTrackedCurves(pool, mints)).length, MAX_TRACKED_POOLS);
  });
});

void test('curve checkpoints seed once and only move forward', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    const repository = new PostgresTrackedCurveRepository(pool);
    const mint = await seedLaunch(pool, 10);
    const [target] = await selectTrackedCurves(pool, [mint]);
    assert.ok(target !== undefined);
    assert.equal(await repository.readCheckpoint(target.poolAddress), null);
    await repository.seedCheckpoint(target, { slot: 100n, signature: 'a' }, 1_000);
    await repository.seedCheckpoint(target, { slot: 200n, signature: 'b' }, 2_000);
    assert.deepEqual(await repository.readCheckpoint(target.poolAddress), { slot: 100n, signature: 'a' });
    await repository.storeCheckpoint(target.poolAddress, { slot: 150n, signature: 'c' }, 3_000);
    assert.deepEqual(await repository.readCheckpoint(target.poolAddress), { slot: 150n, signature: 'c' });
    await assert.rejects(repository.storeCheckpoint(target.poolAddress, { slot: 149n, signature: 'd' }, 4_000));
  });
});
