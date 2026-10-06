import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import bs58 from 'bs58';
import pg from 'pg';
import type { CatchUpWindowDiagnostic } from '../src/application/catch-up-scanner.js';
import type { RecordedLiveEdgeCutoverPlan } from '../src/application/recorded-live-edge-cutover.js';
import { PostgresCheckpointRebaseRepository } from '../src/storage/checkpoint-rebase.repository.js';

const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;

void test('recorded live-edge evidence and checkpoint update are atomic, durable, and idempotent', async (context) => {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('LIVE_TEST_DATABASE_URL must point to a disposable PostgreSQL database.');
    return;
  }
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ''));
  assert.notEqual(databaseName, 'solanabot', 'live-edge cutover tests must never use the target database');
  const schema = `live_edge_cutover_${randomUUID().replaceAll('-', '')}`;
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
    const oldGapSignature = bs58.encode(Buffer.alloc(64, 7));
    const oldNextSignature = bs58.encode(Buffer.alloc(64, 8));
    await pool.query(
      `INSERT INTO processing_checkpoint_rebase_gaps (
        rebase_id, checkpoint_key, previous_source, previous_program, previous_slot,
        previous_signature, previous_transaction_index, previous_payload, previous_updated_at,
        new_slot, new_signature, finalized_head_slot, genesis_hash, reason, recorded_at
      ) VALUES ($1,'market','transaction-inbox','market',2000,$2,NULL,'{"legacy":true}',NOW(),
                999,$3,1000,'old-genesis','invalid-future-checkpoint',NOW())`,
      [randomUUID(), oldGapSignature, oldNextSignature],
    );
    await pool.query(await readFile(new URL('../migrations/022_recorded_live_edge_cutover.sql', import.meta.url), 'utf8'));

    const launchOld = signature(100);
    const launchBoundary = signature(999);
    await seedCheckpoint(pool, 'launchpad', 100, launchOld);
    await seedCheckpoint(pool, 'market', 100, signature(100));
    const repository = new PostgresCheckpointRebaseRepository(pool);
    const launchPlan = plan('launchpad', 100, launchOld, 999, launchBoundary);
    const applied = await repository.applyRecordedLiveEdgeCutover(launchPlan);
    assert.equal(applied.status, 'APPLIED');
    const afterCommit = await pool.query<{ slot: string; signature: string }>(
      `SELECT slot::text, signature FROM processing_checkpoints WHERE checkpoint_key='launchpad'`,
    );
    assert.deepEqual(afterCommit.rows, [{ slot: '999', signature: launchBoundary }]);
    const newEvidence = await pool.query<{ rebase_id: string; reason: string; evidence: Record<string, unknown>;
      previous_payload: Record<string, unknown>; previous_slot: string; new_slot: string; finalized_head_slot: string }>(
      `SELECT rebase_id, reason, evidence, previous_payload, previous_slot::text, new_slot::text,
              finalized_head_slot::text FROM processing_checkpoint_rebase_gaps WHERE checkpoint_key='launchpad'`,
    );
    assert.equal(newEvidence.rows.length, 1);
    assert.equal(newEvidence.rows[0]?.rebase_id, applied.evidenceId);
    assert.equal(newEvidence.rows[0]?.reason, 'operator-approved-live-edge-cutover');
    assert.deepEqual(newEvidence.rows[0]?.previous_payload, {});
    assert.deepEqual(newEvidence.rows[0]?.evidence, {
      schema: 'listener.live-edge-cutover.v2',
      reason: 'operator-approved-live-edge-cutover',
      operatorOption: '--allow-recorded-live-edge-cutover',
      frontier: { program: 'launchpad', signature: launchBoundary, slot: '999', confirmationStatus: 'finalized' },
      frontierSlot: '999',
      frontierSignature: launchBoundary,
      scan: {
        program: 'launchpad',
        checkpointSlot: '100',
        checkpointSignature: truncate(launchOld),
        frontierSlot: '999',
        frontierSignature: launchBoundary,
        pageSize: 2,
        maxPages: 2,
        exhaustion: 'page-budget-exhausted',
        pageCount: 2,
        signaturesRead: 4,
        checkpointSignatureFound: false,
        newestSlot: '998',
        oldestSlot: '200',
      },
    });
    assert.equal(newEvidence.rows[0]?.previous_slot, '100');
    assert.equal(newEvidence.rows[0]?.new_slot, '999');
    assert.equal(newEvidence.rows[0]?.finalized_head_slot, '999');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM processing_checkpoint_rebase_gaps WHERE reason='invalid-future-checkpoint'`)).rows[0]?.count, 1);

    const retried = await repository.applyRecordedLiveEdgeCutover(launchPlan);
    assert.deepEqual(retried, { status: 'ALREADY_APPLIED', evidenceId: applied.evidenceId });
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM processing_checkpoint_rebase_gaps WHERE checkpoint_key='launchpad'`)).rows[0]?.count, 1);

    await pool.query(`CREATE FUNCTION fail_live_edge_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.checkpoint_key = 'market' THEN RAISE EXCEPTION 'simulated pre-commit crash'; END IF; RETURN NEW; END; $$`);
    await pool.query('CREATE TRIGGER fail_market_checkpoint BEFORE UPDATE ON processing_checkpoints FOR EACH ROW EXECUTE FUNCTION fail_live_edge_update()');
    await assert.rejects(repository.applyRecordedLiveEdgeCutover(
      plan('market', 100, signature(100), 999, signature(999)),
    ));
    assert.equal((await pool.query(`SELECT slot::text FROM processing_checkpoints WHERE checkpoint_key='market'`)).rows[0]?.slot, '100');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM processing_checkpoint_rebase_gaps WHERE checkpoint_key='market' AND reason='operator-approved-live-edge-cutover'`)).rows[0]?.count, 0);

    const afterRestart = new PostgresCheckpointRebaseRepository(pool);
    const replayAfterRestart = await afterRestart.applyRecordedLiveEdgeCutover(launchPlan);
    assert.deepEqual(replayAfterRestart, { status: 'ALREADY_APPLIED', evidenceId: applied.evidenceId });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

function plan(
  program: 'launchpad' | 'market', previousSlot: number, previousSignature: string,
  nextSlot: number, nextSignature: string,
): RecordedLiveEdgeCutoverPlan {
  const scan: CatchUpWindowDiagnostic = Object.freeze({
    program,
    checkpointSlot: String(previousSlot),
    checkpointSignature: truncate(previousSignature),
    frontierSlot: String(nextSlot),
    frontierSignature: nextSignature,
    pageSize: 2,
    maxPages: 2,
    pageCount: 2,
    signaturesRead: 4,
    newestSlot: '998',
    oldestSlot: '200',
    checkpointSignatureFound: false,
    frontierSignatureFound: true,
    exhaustion: 'page-budget-exhausted',
  });
  return Object.freeze({
    program,
    previous: Object.freeze({
      key: program, source: 'transaction-inbox', program, slot: BigInt(previousSlot),
      signature: previousSignature, transactionIndex: null, payload: {}, updatedAtMs: 1_000,
    }),
    frontier: Object.freeze({
      program, signature: nextSignature, slot: BigInt(nextSlot), confirmationStatus: 'finalized',
    }),
    genesisHash: 'temporary-genesis',
    scan,
    recordedAtMs: 2_000,
  });
}

async function seedCheckpoint(pool: pg.Pool, program: 'launchpad' | 'market', slot: number, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO processing_checkpoints (
      checkpoint_key, source, program, slot, signature, transaction_index, payload, updated_at
    ) VALUES ($1,'transaction-inbox',$1,$2,$3,NULL,'{}',to_timestamp(1))`,
    [program, slot, value],
  );
}

function signature(value: number): string {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(value, 60);
  return bs58.encode(bytes);
}

function truncate(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}
