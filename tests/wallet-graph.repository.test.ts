import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { LaunchParticipantAnalyticsService } from '../src/application/launch-participant-analytics.service.js';
import { WalletGraphRebuildService } from '../src/application/wallet-graph-rebuild.service.js';
import { PostgresParticipantAnalyticsRepository } from '../src/storage/participant-analytics.repository.js';
import {
  migrateDatabase,
  purgeExpiredFoundationData,
} from '../src/storage/database.js';
import { PostgresWalletEvidenceRepository } from '../src/storage/wallet-evidence.repository.js';
import {
  PostgresWalletGraphRepository,
} from '../src/storage/wallet-graph.repository.js';
import {
  assessment,
  buy,
  directEvidence,
} from './helpers/wallet-graph-fixture.js';

void test('locks, rolls back and releases the PostgreSQL client', async () => {
  const queries: string[] = [];
  let released = false;
  const pool = {
    connect: async () => ({
      query: async (text: string) => {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      },
      release: () => { released = true; },
    }),
  };
  const repository = new PostgresWalletGraphRepository(pool);
  const cause = new Error('operation failed');

  await assert.rejects(
    () => repository.transact('mint', async () => { throw cause; }),
    cause,
  );

  assert.deepEqual(queries.slice(0, 2), [
    'BEGIN ISOLATION LEVEL REPEATABLE READ',
    queries[1],
  ]);
  assert.match(queries[1] ?? '', /pg_advisory_xact_lock/u);
  assert.match(queries[1] ?? '', /hashtextextended\('wallet-graph:' \|\| \$1, 0\)/u);
  assert.deepEqual(queries.slice(-1), ['ROLLBACK']);
  assert.equal(released, true);
});

void test('keeps wallet member batches below PostgreSQL parameter limits', async () => {
  const source = await readFile(
    new URL('../src/storage/wallet-graph.repository.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /const MEMBER_INSERT_BATCH_SIZE = 3_000/u);
  assert.match(source, /rowIndex \* 7/u);
  assert.ok(3_000 * 7 < 65_535);
});

void test('replays, revises and dissolves an orphaned cluster atomically', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live wallet graph test skipped');
    return;
  }
  const schema = `wallet_graph_repository_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 3,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    await insertLaunch(pool);
    const tradeA = buy('trade-a', 'buyer-a', 2);
    const tradeB = buy('trade-b', 'buyer-b', 3);
    await insertTrade(pool, tradeA);
    await insertTrade(pool, tradeB);
    await new LaunchParticipantAnalyticsService(
      new PostgresParticipantAnalyticsRepository(pool),
    ).rebuild('mint');

    const evidenceA = directEvidence(tradeA, 'shared-funder', 100n);
    const evidenceB = directEvidence(tradeB, 'shared-funder', 200n);
    const assessmentA = assessment(tradeA, 'STRONG', [evidenceA]);
    const assessmentB = assessment(tradeB, 'STRONG', [evidenceB]);
    const evidenceRepository = new PostgresWalletEvidenceRepository(pool);
    await evidenceRepository.record(Object.freeze({
      signature: tradeA.signature,
      confirmationStatus: 'confirmed',
      assessments: Object.freeze([assessmentA]),
      evidence: Object.freeze([evidenceA]),
    }));
    await evidenceRepository.record(Object.freeze({
      signature: tradeB.signature,
      confirmationStatus: 'confirmed',
      assessments: Object.freeze([assessmentB]),
      evidence: Object.freeze([evidenceB]),
    }));

    const service = new WalletGraphRebuildService(
      new PostgresWalletGraphRepository(pool),
    );
    const first = await service.rebuild('mint');
    assert.equal(first.relationships.length, 2);
    assert.equal(first.clusters.length, 1);
    assert.equal((await pool.query('SELECT 1 FROM wallet_graph_profiles')).rowCount, 1);
    assert.equal((await pool.query('SELECT 1 FROM wallet_relationships')).rowCount, 2);
    assert.equal((await pool.query('SELECT 1 FROM wallet_clusters')).rowCount, 1);
    assert.equal((await pool.query('SELECT 1 FROM wallet_cluster_members')).rowCount, 3);
    assert.equal((await pool.query('SELECT 1 FROM wallet_graph_snapshots')).rowCount, 1);
    assert.equal((await pool.query(
      "SELECT 1 FROM api_event_stream WHERE event_type = 'WalletClusterDetected'",
    )).rowCount, 1);

    const replay = await service.rebuild('mint');
    assert.equal(replay.inputFingerprint, first.inputFingerprint);
    assert.equal((await pool.query('SELECT 1 FROM wallet_graph_snapshots')).rowCount, 1);
    assert.equal((await pool.query(
      "SELECT 1 FROM api_event_stream WHERE event_type = 'WalletClusterDetected'",
    )).rowCount, 1);

    await evidenceRepository.record(orphanedBatch(assessmentA, evidenceA));
    await evidenceRepository.record(orphanedBatch(assessmentB, evidenceB));
    const dissolved = await service.rebuild('mint');
    assert.notEqual(dissolved.inputFingerprint, first.inputFingerprint);
    assert.equal(dissolved.clusters.length, 0);
    assert.equal(dissolved.coverage.notProcessedBuyCount, 2);
    assert.equal((await pool.query('SELECT 1 FROM wallet_relationships')).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM wallet_clusters')).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM wallet_cluster_members')).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM wallet_graph_snapshots')).rowCount, 2);
    assert.equal((await pool.query(
      "SELECT 1 FROM api_event_stream WHERE event_type = 'WalletClusterDetected'",
    )).rowCount, 2);

    const beforeRollback = await graphCounts(pool);
    await pool.query(`CREATE FUNCTION reject_wallet_graph_profile()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced wallet graph rollback';
      END
      $$`);
    await pool.query(`CREATE TRIGGER reject_wallet_graph_profile_trigger
      BEFORE INSERT OR UPDATE ON wallet_graph_profiles
      FOR EACH ROW EXECUTE FUNCTION reject_wallet_graph_profile()`);
    await assert.rejects(service.rebuild('mint'), /forced wallet graph rollback/u);
    assert.deepEqual(await graphCounts(pool), beforeRollback);
    await pool.query(
      'DROP TRIGGER reject_wallet_graph_profile_trigger ON wallet_graph_profiles',
    );
    await pool.query('DROP FUNCTION reject_wallet_graph_profile()');

    await pool.query(`UPDATE token_launches
      SET terminal_at = NOW() - INTERVAL '5 hours',
          purge_after = NOW() - INTERVAL '1 hour'
      WHERE mint = 'mint'`);
    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.walletFundingObservations, 2);
    assert.equal(purged.walletFundingEvidence, 2);
    assert.equal(purged.walletRelationships, 0);
    assert.equal(purged.walletGraphProfiles, 1);
    assert.equal(purged.walletClusterMembers, 0);
    assert.equal(purged.walletClusters, 0);
    assert.equal(purged.walletGraphSnapshots, 2);
    assert.equal(purged.tokenLaunches, 1);
    assert.equal((await pool.query('SELECT 1 FROM wallet_graph_profiles')).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM wallet_graph_snapshots')).rowCount, 0);
    assert.equal((await pool.query(
      "SELECT 1 FROM domain_events WHERE type = 'WalletClusterDetected'",
    )).rowCount, 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

function orphanedBatch(
  originalAssessment: ReturnType<typeof assessment>,
  originalEvidence: ReturnType<typeof directEvidence>,
) {
  const buyValue = Object.freeze({
    ...originalAssessment.buy,
    confirmationStatus: 'orphaned' as const,
  });
  return Object.freeze({
    signature: originalAssessment.buy.signature,
    confirmationStatus: 'orphaned' as const,
    assessments: Object.freeze([Object.freeze({
      ...originalAssessment,
      buy: buyValue,
    })]),
    evidence: Object.freeze([Object.freeze({
      ...originalEvidence,
      confirmationStatus: 'orphaned' as const,
    })]),
  });
}

async function insertLaunch(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  await pool.query(`INSERT INTO token_launches (
    mint, launchpad, program_id, creator, token_program, current_state,
    created_signature, created_slot, created_transaction_index,
    created_instruction_index, detected_at, updated_at
  ) VALUES (
    'mint', 'pumpfun', 'pump-program', 'creator', 'SPL_TOKEN', 'DETECTED',
    'create-signature', 10, 0, 1, NOW(), NOW()
  )`);
  await pool.query(`INSERT INTO domain_events (
    event_id, type, mint, source, program, signature, slot,
    transaction_index, instruction_index, confirmation_status,
    observed_at, payload_version, payload
  ) VALUES (
    'launch-event', 'TokenLaunchDetected', 'mint', 'pumpfun', 'pump-program',
    'create-signature', 10, 0, 1, 'confirmed',
    to_timestamp(1720000000), 1, '{}'::jsonb
  )`);
}

async function insertTrade(
  pool: InstanceType<typeof pg.Pool>,
  trade: ReturnType<typeof buy>,
): Promise<void> {
  await pool.query(`INSERT INTO domain_events (
    event_id, type, mint, source, program, signature, slot,
    transaction_index, instruction_index, confirmation_status,
    observed_at, payload_version, payload
  ) VALUES ($1, 'BondingCurveTradeObserved', 'mint', 'pumpfun', 'pump-program',
    $2, $3, $4, $5, 'confirmed', $6, 1, '{}'::jsonb)`, [
    trade.eventId,
    trade.signature,
    trade.cursor.slot.toString(),
    trade.cursor.transactionIndex,
    trade.cursor.instructionIndex,
    new Date(trade.observedAtMs),
  ]);
  await pool.query(`INSERT INTO launch_trades (
    trade_id, mint, trade_kind, trader,
    base_amount_raw, quote_amount_raw, quote_mint, quote_decimals,
    quote_token_program, slot, transaction_index,
    instruction_index, confirmation_status
  ) VALUES (
    $1,'mint','BUY',$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed'
  )`, [
    trade.tradeId,
    trade.trader,
    trade.baseAmountRaw.toString(),
    trade.quoteAmountRaw.toString(),
    trade.quoteAsset.mint,
    trade.quoteAsset.decimals,
    trade.quoteAsset.tokenProgram,
    trade.cursor.slot.toString(),
    trade.cursor.transactionIndex,
    trade.cursor.instructionIndex,
  ]);
}

async function graphCounts(pool: InstanceType<typeof pg.Pool>) {
  const result = await pool.query<{
    readonly profiles: string;
    readonly relationships: string;
    readonly clusters: string;
    readonly members: string;
    readonly snapshots: string;
    readonly events: string;
    readonly outbox: string;
  }>(`SELECT
    (SELECT COUNT(*) FROM wallet_graph_profiles)::text AS profiles,
    (SELECT COUNT(*) FROM wallet_relationships)::text AS relationships,
    (SELECT COUNT(*) FROM wallet_clusters)::text AS clusters,
    (SELECT COUNT(*) FROM wallet_cluster_members)::text AS members,
    (SELECT COUNT(*) FROM wallet_graph_snapshots)::text AS snapshots,
    (SELECT COUNT(*) FROM domain_events
      WHERE type = 'WalletClusterDetected')::text AS events,
    (SELECT COUNT(*) FROM api_event_stream
      WHERE event_type = 'WalletClusterDetected')::text AS outbox`);
  return result.rows[0];
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error('Unsafe SQL identifier.');
  }
  return `"${identifier}"`;
}
