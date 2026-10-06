import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import bs58 from 'bs58';
import pg from 'pg';
import { CatchUpScanner } from '../src/application/catch-up-scanner.js';
import { CheckpointRebaseOperator, type CheckpointProgram } from '../src/application/checkpoint-rebase-operator.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { PostgresCheckpointRebaseRepository } from '../src/storage/checkpoint-rebase.repository.js';

const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;
const genesis = 'temporary-mainnet-genesis';

void test('PostgreSQL checkpoint rebase preserves the gap atomically, is idempotent, and lets catch-up start', async (context) => {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('LIVE_TEST_DATABASE_URL must point to a disposable PostgreSQL database.');
    return;
  }
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ''));
  assert.notEqual(databaseName, 'solanabot', 'checkpoint operator tests must never use the target database');
  const schema = `checkpoint_rebase_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE processing_checkpoints (
      checkpoint_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      program TEXT NOT NULL,
      slot NUMERIC(78,0) NOT NULL,
      signature TEXT,
      transaction_index INTEGER,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(source, program)
    )`);
    await pool.query(await readFile(new URL('../migrations/021_processing_checkpoint_rebase_gaps.sql', import.meta.url), 'utf8'));

    const oldLaunchSignature = 'old-launchpad-checkpoint';
    const oldMarketSignature = 'old-market-checkpoint';
    const launchSignature = bs58.encode(Buffer.alloc(64, 11));
    const marketSignature = bs58.encode(Buffer.alloc(64, 12));
    await seedCheckpoint(pool, 'launchpad', 488_462_493n, oldLaunchSignature, { sourceFixture: 'old' });
    await seedCheckpoint(pool, 'market', 488_472_270n, oldMarketSignature, { sourceFixture: 'old-market' });

    const repository = new PostgresCheckpointRebaseRepository(pool);
    const operator = new CheckpointRebaseOperator(repository, {
      getGenesisHash: async () => genesis,
      getFinalizedHead: async () => 500n,
      getLatestFinalizedSignature: async (program) => Object.freeze({
        signature: program === 'launchpad' ? launchSignature : marketSignature,
        slot: program === 'launchpad' ? 499n : 498n,
        confirmationStatus: 'finalized',
      }),
    }, () => 1_800_000_000_000);

    const dryRun = await operator.execute('launchpad', 'invalid-future-checkpoint', false, genesis);
    assert.equal(dryRun.status, 'DRY_RUN');
    assert.equal((await countRows(pool, 'processing_checkpoint_rebase_gaps')), 0);
    assert.equal((await storedSlot(pool, 'launchpad')), '488462493');

    const applied = await operator.execute('launchpad', 'invalid-future-checkpoint', true, genesis);
    assert.equal(applied.status, 'APPLIED');
    assert.equal((await storedSlot(pool, 'launchpad')), '499');
    const evidence = await pool.query(
      `SELECT previous_slot::text, previous_signature, previous_payload, new_slot::text,
              new_signature, finalized_head_slot::text, reason, genesis_hash
       FROM processing_checkpoint_rebase_gaps WHERE checkpoint_key = 'launchpad'`,
    );
    assert.deepEqual(evidence.rows, [{
      previous_slot: '488462493', previous_signature: oldLaunchSignature,
      previous_payload: { sourceFixture: 'old' }, new_slot: '499', new_signature: launchSignature,
      finalized_head_slot: '500', reason: 'invalid-future-checkpoint', genesis_hash: genesis,
    }]);

    const repeated = await operator.execute('launchpad', 'invalid-future-checkpoint', true, genesis);
    assert.equal(repeated.status, 'ALREADY_APPLIED');
    assert.equal(await countRows(pool, 'processing_checkpoint_rebase_gaps'), 1);

    await seedCheckpoint(pool, 'market', 450n, 'normal-market-signature', { sourceFixture: 'normal' }, true);
    await assert.rejects(
      operator.execute('market', 'invalid-future-checkpoint', false, genesis),
      /Checkpoint rebase refused/u,
    );
    assert.equal(await countRows(pool, 'processing_checkpoint_rebase_gaps'), 1);
    assert.equal(await storedSlot(pool, 'market'), '450');

    const scannerRepository = {
      readCheckpoint: async (key: CheckpointProgram) => {
        const state = await repository.inspect(key);
        const checkpoint = state.checkpoint;
        assert.ok(checkpoint?.signature);
        return Object.freeze({ key, slot: checkpoint.slot, signature: checkpoint.signature, updatedAtMs: checkpoint.updatedAtMs });
      },
      enqueue: async () => assert.fail('checkpoint boundary fixture should not enqueue a transaction'),
      storeCheckpoint: async () => assert.fail('checkpoint boundary fixture should not move the durable checkpoint'),
    };
    const programSignatures = new Map<string, { signature: string; slot: bigint }>([
      [PUMP_PROGRAM_ID, { signature: launchSignature, slot: 499n }],
      [PUMPSWAP_PROGRAM_ID, { signature: 'normal-market-signature', slot: 450n }],
    ]);
    const scanner = new CatchUpScanner({
      list: async (programId) => {
        const boundary = programSignatures.get(programId);
        assert.ok(boundary);
        return [{ ...boundary, confirmationStatus: 'finalized', blockTimeMs: null }];
      },
    }, scannerRepository, { pageSize: 100, maxPages: 20 });
    const scan = await scanner.scan();
    assert.equal(scan.pageCount, 2);
    assert.equal(scan.discoveredCount, 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

async function seedCheckpoint(
  pool: pg.Pool,
  key: CheckpointProgram,
  slot: bigint,
  signature: string,
  payload: Record<string, string>,
  replace = false,
): Promise<void> {
  if (replace) {
    await pool.query(
      `UPDATE processing_checkpoints SET slot=$2, signature=$3, payload=$4::jsonb,
        updated_at='2026-10-05T10:00:00.000Z' WHERE checkpoint_key=$1`,
      [key, slot.toString(), signature, JSON.stringify(payload)],
    );
    return;
  }
  await pool.query(
    `INSERT INTO processing_checkpoints (checkpoint_key,source,program,slot,signature,transaction_index,payload,updated_at)
     VALUES ($1,'transaction-inbox',$1,$2,$3,NULL,$4::jsonb,'2026-08-26T19:02:00.838Z')`,
    [key, slot.toString(), signature, JSON.stringify(payload)],
  );
}

async function storedSlot(pool: pg.Pool, key: CheckpointProgram): Promise<string | undefined> {
  const result = await pool.query<{ slot: string }>(
    'SELECT slot::text FROM processing_checkpoints WHERE checkpoint_key=$1', [key],
  );
  return result.rows[0]?.slot;
}

async function countRows(pool: pg.Pool, table: string): Promise<number> {
  const result = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
  return result.rows[0]?.count ?? -1;
}
