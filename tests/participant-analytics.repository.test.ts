import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { LaunchParticipantAnalyticsService } from '../src/application/launch-participant-analytics.service.js';
import { PostgresApiProjectionRepository } from '../src/storage/api-projection.repository.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { PostgresParticipantAnalyticsRepository } from '../src/storage/participant-analytics.repository.js';

void test('verrouille le mint et charge une entrée canonique bigint dans une transaction', async () => {
  const database = new RecordingPool();
  const repository = new PostgresParticipantAnalyticsRepository(database);

  const input = await repository.transact('mint', (transaction) => (
    transaction.loadCanonicalInput('mint')
  ));

  assert.equal(input?.launch.signature, 'create-signature');
  assert.equal(input?.trades[0]?.baseAmountRaw, 10n);
  assert.match(input?.inputFingerprint ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(input), true);
  assert.match(database.queries[1] ?? '', /pg_advisory_xact_lock/u);
  assert.match(database.queries[1] ?? '', /hashtextextended\('participant-analytics:' \|\| \$1, 0\)/u);
  assert.match(database.queries[2] ?? '', /FROM token_launches AS launch/u);
  assert.match(database.queries[3] ?? '', /FROM launch_trades AS trade/u);
  assert.deepEqual(database.queries.slice(0, 2), [
    'BEGIN',
    database.queries[1],
  ]);
  assert.deepEqual(database.queries.slice(-1), ['COMMIT']);
  assert.equal(database.released, true);
});

void test('rollback et libère le client lorsque l’opération échoue', async () => {
  const database = new RecordingPool();
  const repository = new PostgresParticipantAnalyticsRepository(database);
  const cause = new Error('operation failed');

  await assert.rejects(
    () => repository.transact('mint', async () => { throw cause; }),
    cause,
  );

  assert.deepEqual(database.queries.slice(-1), ['ROLLBACK']);
  assert.equal(database.released, true);
});

void test('remplace profil, positions, snapshot et événements avant le commit', async () => {
  const database = new RecordingPool();
  const repository = new PostgresParticipantAnalyticsRepository(database);

  await new LaunchParticipantAnalyticsService(repository).rebuild('mint');

  assert.equal(database.queries.some((query) => query.includes('INSERT INTO domain_events')), true);
  assert.equal(database.queries.some((query) => query.includes('INSERT INTO creator_profiles')), true);
  assert.equal(database.queries.some((query) => query.includes('DELETE FROM observed_wallet_positions')), true);
  assert.equal(database.queries.some((query) => query.includes('INSERT INTO observed_wallet_positions')), true);
  assert.equal(database.queries.some((query) => query.includes('INSERT INTO token_holders_snapshots')), true);
  assert.deepEqual(database.queries.slice(-1), ['COMMIT']);
});

void test('borne chaque lot de positions sous la limite de paramètres PostgreSQL', async () => {
  const database = new RecordingPool(3_641);
  const repository = new PostgresParticipantAnalyticsRepository(database);

  await new LaunchParticipantAnalyticsService(repository).rebuild('mint');

  assert.equal(
    database.queries.filter((query) =>
      query.includes('INSERT INTO observed_wallet_positions')).length,
    2,
  );
});

void test('rejoue, réconcilie la finalité et rollback atomiquement sur PostgreSQL', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `participant_repository_${randomUUID().replaceAll('-', '')}`;
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
      'create-signature', 10, 0, 1, 'confirmed', NOW(), 1, '{}'::jsonb
    )`);
    await insertTrade(pool, 'trade', 'trade-event', 2, 'processed');
    const repository = new PostgresParticipantAnalyticsRepository(pool);
    const service = new LaunchParticipantAnalyticsService(repository);

    await service.rebuild('mint');
    await service.rebuild('mint');
    assert.equal((await pool.query('SELECT 1 FROM creator_profiles')).rowCount, 1);
    assert.equal((await pool.query('SELECT 1 FROM observed_wallet_positions')).rowCount, 1);
    assert.equal((await pool.query('SELECT 1 FROM token_holders_snapshots')).rowCount, 1);
    assert.equal((await pool.query(
      "SELECT 1 FROM domain_events WHERE type IN ('CreatorProfileUpdated','HolderDistributionUpdated')",
    )).rowCount, 2);
    assert.equal((await pool.query(
      "SELECT 1 FROM api_event_stream WHERE event_type IN ('CreatorProfileUpdated','HolderDistributionUpdated')",
    )).rowCount, 2);

    await pool.query(
      "UPDATE launch_trades SET confirmation_status = 'confirmed' WHERE trade_id = 'trade'",
    );
    await pool.query(
      "UPDATE domain_events SET confirmation_status = 'confirmed' WHERE event_id = 'trade-event'",
    );
    await service.rebuild('mint');
    assert.equal((await pool.query('SELECT 1 FROM token_holders_snapshots')).rowCount, 2);
    assert.equal((await pool.query(
      "SELECT 1 FROM api_event_stream WHERE event_type IN ('CreatorProfileUpdated','HolderDistributionUpdated')",
    )).rowCount, 4);

    await pool.query(
      "UPDATE launch_trades SET confirmation_status = 'orphaned' WHERE trade_id = 'trade'",
    );
    await pool.query(
      "UPDATE domain_events SET confirmation_status = 'orphaned' WHERE event_id = 'trade-event'",
    );
    await service.rebuild('mint');
    assert.equal((await pool.query('SELECT 1 FROM observed_wallet_positions')).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM token_holders_snapshots')).rowCount, 3);
    const holdersAfterOrphan = await new PostgresApiProjectionRepository(pool)
      .getLaunchHolders('mint');
    assert.equal(holdersAfterOrphan?.status, 'AVAILABLE');
    if (holdersAfterOrphan?.status !== 'AVAILABLE') {
      throw new Error('Expected available holder analytics.');
    }
    assert.equal(holdersAfterOrphan.latestSnapshot.cursor.instructionIndex, '1');
    assert.equal(holdersAfterOrphan.latestSnapshot.totalPositiveNetBaseRaw, '0');
    assert.equal(holdersAfterOrphan.snapshots[0]?.cursor.instructionIndex, '2');

    await insertTrade(pool, 'rollback-trade', 'rollback-event', 3, 'processed');
    const beforeRollback = await analyticsCounts(pool);
    await pool.query(`CREATE FUNCTION reject_profile_update()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced analytics rollback';
      END
      $$`);
    await pool.query(`CREATE TRIGGER reject_profile_update_trigger
      BEFORE INSERT OR UPDATE ON creator_profiles
      FOR EACH ROW EXECUTE FUNCTION reject_profile_update()`);
    await assert.rejects(service.rebuild('mint'), /forced analytics rollback/u);
    assert.deepEqual(await analyticsCounts(pool), beforeRollback);
    await pool.query('DROP TRIGGER reject_profile_update_trigger ON creator_profiles');
    await pool.query('DROP FUNCTION reject_profile_update()');

    await Promise.all([service.rebuild('mint'), service.rebuild('mint')]);
    assert.equal((await pool.query(
      "SELECT 1 FROM observed_wallet_positions WHERE wallet = 'buyer'",
    )).rowCount, 1);
    assert.equal((await pool.query(
      "SELECT 1 FROM token_holders_snapshots WHERE input_fingerprint = (SELECT input_fingerprint FROM creator_profiles)",
    )).rowCount, 1);

    await pool.query(`UPDATE token_launches
      SET terminal_at = NOW() - INTERVAL '5 hours',
          purge_after = NOW() - INTERVAL '1 hour'
      WHERE mint = 'mint'`);
    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.websocketHealthEvidence, 0);
    assert.equal(purged.creatorProfiles, 1);
    assert.equal(purged.observedWalletPositions, 1);
    assert.ok(purged.holderSnapshots >= 1);
    assert.equal((await pool.query(
      "SELECT 1 FROM domain_events WHERE type IN ('CreatorProfileUpdated','HolderDistributionUpdated')",
    )).rowCount, 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

class RecordingPool {
  public readonly queries: string[] = [];
  public released = false;

  public constructor(private readonly tradeCount = 1) {}

  public async connect() {
    return {
      query: async (text: string) => {
        this.queries.push(text);
        if (text.includes('FROM token_launches AS launch')) {
          return {
            rows: [{
              event_id: 'launch-event',
              mint: 'mint',
              creator: 'creator',
              source: 'pumpfun',
              program: 'pump-program',
              signature: 'create-signature',
              slot: '10',
              transaction_index: 0,
              instruction_index: 1,
              inner_instruction_index: null,
              confirmation_status: 'confirmed',
              observed_at: new Date(1_720_000_000_000),
            }],
            rowCount: 1,
          };
        }
        if (text.includes('FROM launch_trades AS trade')) {
          return {
            rows: Array.from({ length: this.tradeCount }, (_, index) => ({
              event_id: `trade-event-${index}`,
              trade_id: `trade-${index}`,
              mint: 'mint',
              signature: `trade-signature-${index}`,
              slot: '10',
              transaction_index: 0,
              instruction_index: index + 2,
              inner_instruction_index: null,
              confirmation_status: 'confirmed',
              observed_at: new Date(1_720_000_000_001 + index),
              trade_kind: 'BUY',
              trader: `buyer-${index}`,
              base_amount_raw: '10',
              quote_amount_raw: '2',
              quote_mint: 'sol',
              quote_decimals: 9,
              quote_token_program: 'SPL_TOKEN',
            })),
            rowCount: this.tradeCount,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => { this.released = true; },
    };
  }
}

async function insertTrade(
  pool: InstanceType<typeof pg.Pool>,
  tradeId: string,
  eventId: string,
  instructionIndex: number,
  confirmationStatus: 'processed' | 'confirmed',
): Promise<void> {
  await pool.query(`INSERT INTO domain_events (
    event_id, type, mint, source, program, signature, slot,
    transaction_index, instruction_index, confirmation_status,
    observed_at, payload_version, payload
  ) VALUES (
    $1, 'BondingCurveTradeObserved', 'mint', 'pumpfun', 'pump-program',
    $2, 10, 0, $3, $4, NOW(), 1, '{}'::jsonb
  )`, [eventId, `${tradeId}-signature`, instructionIndex, confirmationStatus]);
  await pool.query(`INSERT INTO launch_trades (
    trade_id, mint, trade_kind, trader, base_amount_raw, quote_amount_raw,
    quote_mint, quote_decimals, quote_token_program, slot,
    transaction_index, instruction_index, confirmation_status
  ) VALUES (
    $1, 'mint', 'BUY', 'buyer', 10, 2, 'sol', 9, 'SPL_TOKEN',
    10, 0, $2, $3
  )`, [tradeId, instructionIndex, confirmationStatus]);
}

async function analyticsCounts(
  pool: InstanceType<typeof pg.Pool>,
): Promise<readonly string[]> {
  const result = await pool.query<{
    readonly profiles: string;
    readonly positions: string;
    readonly snapshots: string;
    readonly derived_events: string;
  }>(`SELECT
    (SELECT COUNT(*) FROM creator_profiles)::text AS profiles,
    (SELECT COUNT(*) FROM observed_wallet_positions)::text AS positions,
    (SELECT COUNT(*) FROM token_holders_snapshots)::text AS snapshots,
    (SELECT COUNT(*) FROM domain_events
      WHERE type IN ('CreatorProfileUpdated','HolderDistributionUpdated'))::text
      AS derived_events`);
  const row = result.rows[0];
  return [
    row?.profiles ?? '-1',
    row?.positions ?? '-1',
    row?.snapshots ?? '-1',
    row?.derived_events ?? '-1',
  ];
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error('Unsafe SQL identifier.');
  return `"${identifier}"`;
}
