import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { DOMAIN_EVENT_TYPES } from '../src/domain/events.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/006_api_event_stream.sql', import.meta.url);

void test('la migration crée une outbox append-only publique, indexée et sans FK parent', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS api_event_stream/u);
  assert.match(sql, /sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY/u);
  assert.match(sql, /stream_event_id TEXT UNIQUE NOT NULL/u);
  assert.match(sql, /domain_event_id TEXT NOT NULL/u);
  assert.match(sql, /revision BIGINT NOT NULL CHECK \(revision > 0\)/u);
  assert.match(sql, /UNIQUE\(domain_event_id, revision\)/u);
  assert.doesNotMatch(sql, /domain_event_id TEXT[^,]*REFERENCES/iu);
  assert.match(sql, /confirmation_status TEXT NOT NULL[\s\S]*'processed'[\s\S]*'confirmed'[\s\S]*'finalized'[\s\S]*'orphaned'/u);
  assert.match(sql, /payload_version INTEGER NOT NULL CHECK \(payload_version > 0\)/u);
  assert.match(sql, /event JSONB NOT NULL/u);
  assert.match(sql, /emitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/u);
  assert.match(sql, /purge_after TIMESTAMPTZ NOT NULL/u);
  assert.match(sql, /event_type TEXT NOT NULL CHECK \(event_type IN \(/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS api_event_stream_state/u);
  assert.match(sql, /id SMALLINT PRIMARY KEY CHECK \(id = 1\)/u);
  assert.match(sql, /last_sequence BIGINT NOT NULL DEFAULT 0 CHECK \(last_sequence >= 0\)/u);
  assert.match(sql, /backfill_completed BOOLEAN NOT NULL DEFAULT FALSE/u);
  assert.match(sql, /expired_through_sequence BIGINT NOT NULL DEFAULT 0/u);
  assert.match(sql, /expired_through_sequence >= 0[\s\S]*expired_through_sequence <= last_sequence/u);
  assert.match(sql, /ALTER TABLE api_event_stream_state[\s\S]*ADD COLUMN IF NOT EXISTS backfill_completed/u);
  assert.match(sql, /ALTER TABLE api_event_stream_state[\s\S]*ADD COLUMN IF NOT EXISTS expired_through_sequence/u);
  assert.match(sql, /INSERT INTO api_event_stream_state \(id\) VALUES \(1\) ON CONFLICT \(id\) DO NOTHING/u);
  assert.deepEqual(
    sqlStringListAfter(sql, 'event_type TEXT NOT NULL CHECK (event_type IN ('),
    DOMAIN_EVENT_TYPES.filter((type) => type !== 'HolderDistributionUpdated'),
  );
  assert.deepEqual(
    sqlStringListAfter(sql, 'AND type IN ('),
    DOMAIN_EVENT_TYPES.filter((type) => type !== 'HolderDistributionUpdated'),
  );
  const backfill = sql.indexOf('INSERT INTO %1$I.api_event_stream');
  assert.ok(backfill >= 0);
  assert.ok(sql.indexOf('CREATE INDEX IF NOT EXISTS api_event_stream_mint_sequence_idx') > backfill);
  assert.ok(sql.indexOf('CREATE INDEX IF NOT EXISTS api_event_stream_purge_after_idx') > backfill);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL)\b/iu);
});

void test('la migration enfile les révisions publiques avec trigger rejouable et backfill idempotent', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION enqueue_api_domain_event_revision\(\)/u);
  assert.match(sql, /SECURITY INVOKER/u);
  assert.match(sql, /AFTER INSERT OR UPDATE ON domain_events/u);
  assert.match(sql, /DROP TRIGGER IF EXISTS enqueue_api_domain_event_revision_trigger ON domain_events/u);
  assert.match(sql, /CREATE TRIGGER enqueue_api_domain_event_revision_trigger/u);
  for (const key of [
    'eventId', 'type', 'mint', 'source', 'program', 'signature', 'slot',
    'transactionIndex', 'instructionIndex', 'innerInstructionIndex',
    'confirmationStatus', 'blockchainTime', 'observedAt', 'payloadVersion', 'payload',
  ]) assert.match(sql, new RegExp(`'${key}'`, 'u'));
  assert.match(sql, /md5\(public_event::text\)/u);
  assert.match(sql, /format\(\s*\$sql\$[\s\S]*%I\.api_event_stream/u);
  assert.match(sql, /TG_TABLE_SCHEMA/u);
  assert.match(sql, /COALESCE\(MAX\(revision\), 0\) \+ 1/u);
  assert.match(sql, /event_id \|\| ':' \|\| revision::text \|\| ':'/u);
  assert.match(sql, /ON CONFLICT \(domain_event_id, revision\) DO NOTHING/u);
  assert.match(sql, /NOT EXISTS \([\s\S]*existing\.domain_event_id = domain_events\.event_id/u);
  assert.match(sql, /%1\$I\.api_event_stream existing/u);
  assert.match(sql, /AND type IN \(/u);
  assert.match(sql, /clock_timestamp\(\) \+ INTERVAL '4 hours'/u);
  assert.ok(
    [...sql.matchAll(/clock_timestamp\(\) \+ INTERVAL '4 hours'/gu)].length >= 2,
  );
  assert.doesNotMatch(sql, /NOW\(\) \+ INTERVAL '4 hours'/u);
  assert.doesNotMatch(sql, /\$5,\s*NOW\(\) \+ INTERVAL '4 hours'/u);
  assert.match(sql, /WHERE \(?purge_after IS NULL OR purge_after > NOW\(\)\)?/u);
  assert.match(sql, /ORDER BY created_at, event_id/u);
  assert.match(sql, /to_char\(\s*NEW\.blockchain_time AT TIME ZONE 'UTC'/u);
  assert.match(sql, /to_char\(\s*NEW\.observed_at AT TIME ZONE 'UTC'/u);
  assert.match(sql, /to_char\(\s*blockchain_time AT TIME ZONE 'UTC'/u);
  assert.match(sql, /to_char\(\s*observed_at AT TIME ZONE 'UTC'/u);

  const locks = [...sql.matchAll(/PERFORM pg_advisory_xact_lock\(\d+, \d+\)/gu)];
  assert.ok(locks.length >= 2);
  const triggerLock = locks[0]?.index ?? -1;
  const revisionAllocation = sql.indexOf('COALESCE(MAX(revision), 0) + 1');
  const triggerInsert = sql.indexOf('INSERT INTO %I.api_event_stream');
  assert.ok(triggerLock >= 0 && triggerLock < revisionAllocation && revisionAllocation < triggerInsert);
  const backfillLock = locks[1]?.index ?? -1;
  const backfillInsert = sql.indexOf('INSERT INTO %1$I.api_event_stream');
  assert.ok(backfillLock >= 0 && backfillLock < backfillInsert);
  assert.match(sql, /RETURNING sequence[\s\S]*INTO allocated_sequence/u);
  assert.match(sql, /last_sequence = GREATEST\(last_sequence, \$1\)/u);
  assert.match(sql, /last_sequence = GREATEST\([\s\S]*MAX\(sequence\)/u);
  assert.match(sql, /SELECT backfill_completed[\s\S]*INTO backfill_done/u);
  assert.match(sql, /IF NOT backfill_done THEN/u);
  assert.match(sql, /backfill_completed = TRUE/u);
  assert.doesNotMatch(
    sql,
    /SET[\s\S]*expired_through_sequence\s*=(?!\s*GREATEST)/u,
  );
});

void test('la purge supprime l’outbox avant les événements de domaine et expose son compteur', async () => {
  const source = await readFile(new URL('../src/storage/database.ts', import.meta.url), 'utf8');

  const outboxDeletion = source.indexOf('DELETE FROM api_event_stream');
  const domainDeletion = source.indexOf("DELETE FROM domain_events WHERE purge_after <= NOW()");
  assert.ok(outboxDeletion >= 0);
  assert.ok(domainDeletion > outboxDeletion);
  assert.match(source, /WITH deleted AS \([\s\S]*DELETE FROM api_event_stream[\s\S]*purge_after <= clock_timestamp\(\)[\s\S]*RETURNING sequence/u);
  assert.match(source, /MAX\(sequence\) AS max_deleted_sequence/u);
  assert.match(source, /expired_through_sequence = GREATEST\([\s\S]*max_deleted_sequence/u);
  assert.match(source, /SELECT deleted_count FROM summary/u);
  assert.match(source, /readonly apiEventStream: number;/u);
  assert.match(source, /apiEventStream: Number\(apiEventStream\.rows\[0\]\?\.deleted_count \?\? 0\),/u);
  assert.doesNotMatch(source, /DELETE FROM api_event_stream_state/u);
});

void test('la purge retourne le compteur agrégé de l’outbox, pas le rowCount du SELECT', async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes('WITH deleted AS')) {
        return { rows: [{ deleted_count: '7' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as InstanceType<typeof pg.Pool>;

  const result = await purgeExpiredFoundationData(pool);

  assert.equal(result.apiEventStream, 7);
  assert.ok(queries.some((query) => query.includes('RETURNING sequence')));
  assert.deepEqual(queries.slice(-1), ['COMMIT']);
});

void test('la purge retire les projections participants expirées avant leurs événements', async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes('WITH deleted AS')) {
        return { rows: [{ deleted_count: '0' }], rowCount: 1 };
      }
      if (text.includes('DELETE FROM creator_profiles')) return { rows: [], rowCount: 1 };
      if (text.includes('DELETE FROM observed_wallet_positions')) return { rows: [], rowCount: 2 };
      if (text.includes('DELETE FROM token_holders_snapshots')) return { rows: [], rowCount: 1 };
      if (
        text.includes('DELETE FROM domain_events event USING token_launches launch')
      ) return { rows: [], rowCount: 4 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as InstanceType<typeof pg.Pool>;

  const result = await purgeExpiredFoundationData(pool);

  assert.equal(result.creatorProfiles, 1);
  assert.equal(result.observedWalletPositions, 2);
  assert.equal(result.holderSnapshots, 1);
  assert.equal(result.domainEvents, 4);
  const participantQueries = queries.filter((query) =>
    /DELETE FROM (?:creator_profiles|observed_wallet_positions|token_holders_snapshots)/u.test(query));
  assert.equal(participantQueries.length, 3);
  for (const query of participantQueries) {
    assert.match(query, /USING token_launches launch/u);
    assert.match(query, /launch\.purge_after <= NOW\(\)/u);
  }
  const domainDeletion = queries.findIndex((query) =>
    query.includes('DELETE FROM domain_events WHERE purge_after <= NOW()'));
  assert.ok(domainDeletion > queries.findIndex((query) => query.includes('DELETE FROM creator_profiles')));
  assert.ok(queries.some((query) =>
    query.includes('DELETE FROM domain_events event USING token_launches launch')
    && query.includes("'CreatorProfileUpdated', 'HolderDistributionUpdated'")
    && query.includes('launch.purge_after <= NOW()')));
});

void test('la migration fonctionne en base réelle si TEST_DATABASE_URL est configurée', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }

  const schema = `api_event_stream_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 3,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    } finally {
      client.release();
    }
    for (const migration of [
      '001_initial.sql',
      '002_pumpfun_foundation.sql',
      '003_pumpfun_observations.sql',
      '004_paper_trading.sql',
      '005_pumpswap_market.sql',
    ]) await applyMigration(pool, migration);
    await pool.query(`INSERT INTO domain_events (
      event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
      confirmation_status, observed_at, payload_version, payload
    ) VALUES ('legacy-live', 'LegacyUnknown', 'mint-live', 'legacy', 'legacy-program', 'legacy-signature',
      40, 0, 0, 'processed', NOW(), 1, '{}'::jsonb)`);
    await pool.query(`INSERT INTO domain_events (
      event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
      confirmation_status, observed_at, payload_version, payload, terminal_at, purge_after
    ) VALUES ('backfill-live', 'TokenLaunchDetected', 'mint-live', 'listener', 'program-live',
      'backfill-signature', 41, 0, 0, 'processed', NOW(), 1, '{}'::jsonb,
      NOW(), NOW() + INTERVAL '1 hour')`);
    assert.deepEqual(await migrateDatabase({ pool }), [
      '006_api_event_stream.sql',
      '007_participant_analytics.sql',
    ]);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    assert.equal((await pool.query(
      "SELECT 1 FROM api_event_stream WHERE domain_event_id = 'legacy-live'",
    )).rowCount, 0);
    assert.equal((await pool.query(
      "SELECT 1 FROM api_event_stream WHERE domain_event_id = 'backfill-live'",
    )).rowCount, 1);
    assert.equal((await pool.query<{ readonly backfill_completed: boolean }>(
      'SELECT backfill_completed FROM api_event_stream_state WHERE id = 1',
    )).rows[0]?.backfill_completed, true);
    await pool.query("SET TIME ZONE 'Europe/Paris'");

    await pool.query(`
        INSERT INTO token_launches (
          mint, launchpad, program_id, creator, token_program, current_state,
          created_signature, created_slot, created_transaction_index, created_instruction_index,
          detected_at, updated_at
        ) VALUES ('mint-live', 'pumpfun', 'program-live', 'creator-live', 'token-program',
          'detected', 'launch-signature', 1, 0, 0, NOW(), NOW())
    `);
    await pool.query(`
        INSERT INTO raw_chain_events (
          event_id, source, program, mint, signature, slot, transaction_index, instruction_index,
          confirmation_status, observed_at, payload_version, payload
        ) VALUES ('raw-live', 'listener', 'program-live', 'mint-live', 'signature-live', 42, 1, 2,
          'processed', '2025-01-02T03:04:05.000Z', 1, '{"amountRaw":"9007199254740993"}'::jsonb)
    `);
    await pool.query(`
        INSERT INTO domain_events (
          event_id, raw_event_id, type, mint, source, program, signature, slot,
          transaction_index, instruction_index, inner_instruction_index, confirmation_status,
          blockchain_time, observed_at, payload_version, payload
        ) VALUES ('domain-live', 'raw-live', 'TokenLaunchDetected', 'mint-live', 'listener', 'program-live',
          'signature-live', 42, 1, 2, NULL, 'processed', '2025-01-02T03:04:04.000Z',
          '2025-01-02T03:04:05.000Z', 1, '{"amountRaw":"9007199254740993"}'::jsonb)
    `);
    await pool.query("UPDATE domain_events SET confirmation_status = 'processed' WHERE event_id = 'domain-live'");
    await pool.query("UPDATE domain_events SET confirmation_status = 'confirmed' WHERE event_id = 'domain-live'");
    await pool.query("UPDATE domain_events SET confirmation_status = 'finalized' WHERE event_id = 'domain-live'");
    await pool.query("UPDATE domain_events SET confirmation_status = 'orphaned' WHERE event_id = 'domain-live'");
    const revisions = await pool.query<{ readonly revision: string; readonly confirmation_status: string }>(
      'SELECT revision, confirmation_status FROM api_event_stream WHERE domain_event_id = $1 ORDER BY sequence', ['domain-live'],
    );
    assert.deepEqual(revisions.rows.map((row) => row.revision), ['1', '2', '3', '4']);
    assert.deepEqual(revisions.rows.map((row) => row.confirmation_status), ['processed', 'confirmed', 'finalized', 'orphaned']);
    const publicEvent = await pool.query<{ readonly observed_at: string }>(
      "SELECT event->>'observedAt' AS observed_at FROM api_event_stream WHERE domain_event_id = 'domain-live' ORDER BY sequence LIMIT 1",
    );
    assert.equal(publicEvent.rows[0]?.observed_at, '2025-01-02T03:04:05.000Z');
    await pool.query("UPDATE domain_events SET terminal_at = NOW() WHERE event_id = 'domain-live'");
    assert.equal((await pool.query('SELECT 1 FROM api_event_stream WHERE domain_event_id = $1', ['domain-live'])).rowCount, 4);

    const migrationSql = await readFile(migrationUrl, 'utf8');
    await pool.query("SET TIME ZONE 'America/New_York'");
    await pool.query(migrationSql);
    const checkpointAfterFirstReplay = (await pool.query<{ readonly last_sequence: string }>(
      'SELECT last_sequence FROM api_event_stream_state WHERE id = 1',
    )).rows[0]?.last_sequence;
    await pool.query(migrationSql);
    assert.equal(
      (await pool.query<{ readonly last_sequence: string }>(
        'SELECT last_sequence FROM api_event_stream_state WHERE id = 1',
      )).rows[0]?.last_sequence,
      checkpointAfterFirstReplay,
    );
    assert.equal((await pool.query('SELECT 1 FROM api_event_stream WHERE domain_event_id = $1', ['backfill-live'])).rowCount, 1);
    assert.equal((await pool.query('SELECT 1 FROM api_event_stream WHERE domain_event_id = $1', ['domain-live'])).rowCount, 4);

    await pool.query(`INSERT INTO domain_events (
      event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
      confirmation_status, observed_at, payload_version, payload
    ) VALUES ('revision-live', 'TokenLaunchDetected', 'mint-live', 'listener', 'program-live', 'revision-signature',
      44, 1, 2, 'processed', NOW(), 1, '{"state":"A"}'::jsonb)`);
    await pool.query("UPDATE domain_events SET payload = '{\"state\":\"B\"}'::jsonb WHERE event_id = 'revision-live'");
    await pool.query("UPDATE domain_events SET payload = '{\"state\":\"A\"}'::jsonb WHERE event_id = 'revision-live'");
    const payloadRevisions = await pool.query<{
      readonly revision: string;
      readonly state: string;
    }>("SELECT revision, event->'payload'->>'state' AS state FROM api_event_stream WHERE domain_event_id = 'revision-live' ORDER BY revision");
    assert.deepEqual(payloadRevisions.rows, [
      { revision: '1', state: 'A' },
      { revision: '2', state: 'B' },
      { revision: '3', state: 'A' },
    ]);

    await pool.query(`INSERT INTO domain_events (
      event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
      confirmation_status, observed_at, payload_version, payload
    ) VALUES ('partial-replay-live', 'TokenLaunchDetected', 'mint-live', 'listener', 'program-live', 'partial-signature',
      46, 1, 2, 'processed', NOW(), 1, '{"state":"A"}'::jsonb)`);
    await pool.query("UPDATE domain_events SET payload = '{\"state\":\"B\"}'::jsonb WHERE event_id = 'partial-replay-live'");
    await pool.query('DELETE FROM api_event_stream WHERE domain_event_id = $1 AND revision = 1', ['partial-replay-live']);
    await pool.query(migrationSql);
    const retainedRevision = await pool.query<{ readonly revision: string; readonly state: string }>(
      "SELECT revision, event->'payload'->>'state' AS state FROM api_event_stream WHERE domain_event_id = 'partial-replay-live' ORDER BY revision",
    );
    assert.deepEqual(retainedRevision.rows, [{ revision: '2', state: 'B' }]);

    await assert.rejects(
      pool.query(`INSERT INTO domain_events (
        event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
        confirmation_status, observed_at, payload_version, payload
      ) VALUES ('unsupported-live', 'UnsupportedNewType', 'mint-live', 'listener', 'program-live',
        'unsupported-signature', 47, 1, 2, 'processed', NOW(), 1, '{}'::jsonb)`),
      /api_event_stream_event_type_check/u,
    );
    assert.equal((await pool.query(
      "SELECT 1 FROM api_event_stream WHERE domain_event_id = 'unsupported-live'",
    )).rowCount, 0);

    await assertCommitOrderedSequences(pool, schema);
    await assertSequenceOrderedExpirations(pool);

    for (const [eventId, signature, slot] of [
      ['purge-prefix-first', 'purge-prefix-first-signature', '50'],
      ['purge-prefix-second', 'purge-prefix-second-signature', '51'],
      ['purge-retained', 'purge-retained-signature', '52'],
    ] as const) await pool.query(domainEventInsertSql, [eventId, signature, slot]);
    const purgeCandidates = await pool.query<{
      readonly domain_event_id: string;
      readonly sequence: string;
    }>(
      `SELECT domain_event_id, sequence
       FROM api_event_stream
       WHERE domain_event_id LIKE 'purge-%'
       ORDER BY sequence`,
    );
    assert.deepEqual(purgeCandidates.rows.map((row) => row.domain_event_id), [
      'purge-prefix-first',
      'purge-prefix-second',
      'purge-retained',
    ]);
    const maxPrefixSequence = purgeCandidates.rows[1]?.sequence ?? '0';
    await pool.query(
      `UPDATE api_event_stream
       SET purge_after = clock_timestamp() - INTERVAL '1 second'
       WHERE domain_event_id IN ('purge-prefix-first', 'purge-prefix-second')`,
    );
    await pool.query(
      `UPDATE domain_events
       SET terminal_at = clock_timestamp(),
           purge_after = clock_timestamp() - INTERVAL '1 second'
       WHERE event_id IN ('purge-prefix-first', 'purge-prefix-second')`,
    );
    const stateBeforePurge = (await pool.query<{
      readonly backfill_completed: boolean;
      readonly expired_through_sequence: string;
      readonly last_sequence: string;
    }>(
      `SELECT backfill_completed, expired_through_sequence, last_sequence
       FROM api_event_stream_state WHERE id = 1`,
    )).rows[0];
    await pool.query(`CREATE FUNCTION reject_domain_event_purge()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced purge rollback';
      END
      $$`);
    await pool.query(`CREATE TRIGGER reject_domain_event_purge_trigger
      BEFORE DELETE ON domain_events
      FOR EACH STATEMENT EXECUTE FUNCTION reject_domain_event_purge()`);
    await assert.rejects(purgeExpiredFoundationData(pool), /forced purge rollback/u);
    assert.equal((await pool.query(
      `SELECT 1 FROM api_event_stream
       WHERE domain_event_id IN ('purge-prefix-first', 'purge-prefix-second')`,
    )).rowCount, 2);
    assert.deepEqual((await pool.query(
      `SELECT backfill_completed, expired_through_sequence, last_sequence
       FROM api_event_stream_state WHERE id = 1`,
    )).rows[0], stateBeforePurge);
    await pool.query('DROP TRIGGER reject_domain_event_purge_trigger ON domain_events');
    await pool.query('DROP FUNCTION reject_domain_event_purge()');

    const partialPurge = await purgeExpiredFoundationData(pool);
    assert.equal(partialPurge.apiEventStream, 2);
    assert.equal((await pool.query(
      `SELECT 1 FROM api_event_stream
       WHERE domain_event_id IN ('purge-prefix-first', 'purge-prefix-second')`,
    )).rowCount, 0);
    const stateAfterPartialPurge = (await pool.query<{
      readonly backfill_completed: boolean;
      readonly expired_through_sequence: string;
      readonly last_sequence: string;
    }>(
      `SELECT backfill_completed, expired_through_sequence, last_sequence
       FROM api_event_stream_state WHERE id = 1`,
    )).rows[0];
    assert.equal(stateAfterPartialPurge?.expired_through_sequence, maxPrefixSequence);
    assert.equal(stateAfterPartialPurge?.last_sequence, stateBeforePurge?.last_sequence);
    assert.equal(stateAfterPartialPurge?.backfill_completed, stateBeforePurge?.backfill_completed);
    const emptyPurge = await purgeExpiredFoundationData(pool);
    assert.equal(emptyPurge.apiEventStream, 0);
    assert.deepEqual((await pool.query(
      `SELECT backfill_completed, expired_through_sequence, last_sequence
       FROM api_event_stream_state WHERE id = 1`,
    )).rows[0], stateAfterPartialPurge);

    await pool.query(
      domainEventInsertSql,
      ['post-partial-purge', 'post-partial-purge-signature', '53'],
    );
    const stateAfterNewEvent = (await pool.query<{
      readonly expired_through_sequence: string;
      readonly last_sequence: string;
    }>(
      `SELECT expired_through_sequence, last_sequence
       FROM api_event_stream_state WHERE id = 1`,
    )).rows[0];
    assert.ok(
      BigInt(stateAfterNewEvent?.last_sequence ?? '0')
        > BigInt(stateAfterPartialPurge?.last_sequence ?? '0'),
    );
    assert.equal(
      stateAfterNewEvent?.expired_through_sequence,
      stateAfterPartialPurge?.expired_through_sequence,
    );

    const checkpointBeforePurge = await pool.query<{
      readonly backfill_completed: boolean;
      readonly expired_through_sequence: string;
      readonly last_sequence: string;
      readonly visible_max: string;
    }>(
      `SELECT state.backfill_completed, state.expired_through_sequence, state.last_sequence,
              COALESCE(MAX(stream.sequence), 0) AS visible_max
       FROM api_event_stream_state state
       LEFT JOIN api_event_stream stream ON TRUE
       WHERE state.id = 1
       GROUP BY state.id, state.backfill_completed, state.expired_through_sequence,
                state.last_sequence`,
    );
    assert.ok(BigInt(checkpointBeforePurge.rows[0]?.last_sequence ?? '-1') > 0n);
    assert.equal(
      checkpointBeforePurge.rows[0]?.last_sequence,
      checkpointBeforePurge.rows[0]?.visible_max,
    );
    const visibleBeforeTotalPurge = (await pool.query<{ readonly count: string }>(
      'SELECT COUNT(*) AS count FROM api_event_stream',
    )).rows[0]?.count ?? '0';
    await pool.query(
      "UPDATE api_event_stream SET purge_after = clock_timestamp() - INTERVAL '1 second'",
    );
    const totalPurge = await purgeExpiredFoundationData(pool);
    assert.equal(totalPurge.apiEventStream, Number(visibleBeforeTotalPurge));
    assert.equal((await pool.query('SELECT 1 FROM api_event_stream')).rowCount, 0);
    const stateAfterTotalPurge = (await pool.query<{
      readonly backfill_completed: boolean;
      readonly expired_through_sequence: string;
      readonly last_sequence: string;
    }>(
      `SELECT backfill_completed, expired_through_sequence, last_sequence
       FROM api_event_stream_state WHERE id = 1`,
    )).rows[0];
    assert.equal(stateAfterTotalPurge?.last_sequence, checkpointBeforePurge.rows[0]?.last_sequence);
    assert.equal(stateAfterTotalPurge?.expired_through_sequence, stateAfterTotalPurge?.last_sequence);
    assert.equal(stateAfterTotalPurge?.backfill_completed, checkpointBeforePurge.rows[0]?.backfill_completed);
    await pool.query(migrationSql);
    assert.equal((await pool.query('SELECT 1 FROM api_event_stream')).rowCount, 0);
    assert.deepEqual((await pool.query(
      `SELECT backfill_completed, expired_through_sequence, last_sequence
       FROM api_event_stream_state WHERE id = 1`,
    )).rows[0], stateAfterTotalPurge);

    const shadowClient = await pool.connect();
    try {
      await shadowClient.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await shadowClient.query(`CREATE TEMP TABLE api_event_stream (
        LIKE ${quoteIdentifier(schema)}.api_event_stream INCLUDING ALL
      )`);
      await shadowClient.query(`CREATE TEMP TABLE api_event_stream_state (
        LIKE ${quoteIdentifier(schema)}.api_event_stream_state INCLUDING ALL
      )`);
      await shadowClient.query('INSERT INTO api_event_stream_state(id) VALUES (1)');
      await shadowClient.query(`INSERT INTO domain_events (
        event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
        confirmation_status, observed_at, payload_version, payload
      ) VALUES ('schema-target-live', 'TokenLaunchDetected', 'mint-live', 'listener', 'program-live',
        'schema-target-signature', 45, 1, 2, 'processed', NOW(), 1, '{}'::jsonb)`);
      await shadowClient.query(`UPDATE domain_events
        SET confirmation_status = 'confirmed'
        WHERE event_id = 'schema-target-live'`);
      const persistentCount = await shadowClient.query<{ readonly count: string }>(
        `SELECT count(*) AS count FROM ${quoteIdentifier(schema)}.api_event_stream
         WHERE domain_event_id = 'schema-target-live'`,
      );
      const temporaryCount = await shadowClient.query<{ readonly count: string }>(
        "SELECT count(*) AS count FROM api_event_stream WHERE domain_event_id = 'schema-target-live'",
      );
      const persistentCheckpoint = await shadowClient.query<{
        readonly backfill_completed: boolean;
        readonly expired_through_sequence: string;
        readonly last_sequence: string;
        readonly visible_max: string;
      }>(
        `SELECT state.backfill_completed, state.expired_through_sequence, state.last_sequence,
                MAX(stream.sequence) AS visible_max
         FROM ${quoteIdentifier(schema)}.api_event_stream_state state
         JOIN ${quoteIdentifier(schema)}.api_event_stream stream ON TRUE
         WHERE state.id = 1
         GROUP BY state.id, state.backfill_completed, state.expired_through_sequence,
                  state.last_sequence`,
      );
      const temporaryCheckpoint = await shadowClient.query<{
        readonly expired_through_sequence: string;
        readonly last_sequence: string;
      }>(
        'SELECT expired_through_sequence, last_sequence FROM api_event_stream_state WHERE id = 1',
      );
      assert.equal(persistentCount.rows[0]?.count, '2');
      assert.equal(temporaryCount.rows[0]?.count, '0');
      assert.ok(
        BigInt(persistentCheckpoint.rows[0]?.last_sequence ?? '0')
          > BigInt(checkpointBeforePurge.rows[0]?.last_sequence ?? '0'),
      );
      assert.equal(
        persistentCheckpoint.rows[0]?.last_sequence,
        persistentCheckpoint.rows[0]?.visible_max,
      );
      assert.equal(persistentCheckpoint.rows[0]?.backfill_completed, true);
      assert.equal(
        persistentCheckpoint.rows[0]?.expired_through_sequence,
        stateAfterTotalPurge?.expired_through_sequence,
      );
      assert.equal(temporaryCheckpoint.rows[0]?.last_sequence, '0');
      assert.equal(temporaryCheckpoint.rows[0]?.expired_through_sequence, '0');
    } finally {
      shadowClient.release();
    }
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error('Unsafe SQL identifier.');
  return `"${identifier}"`;
}

function sqlStringListAfter(sql: string, marker: string): readonly string[] {
  const start = sql.indexOf(marker);
  assert.ok(start >= 0);
  const end = sql.indexOf(')', start + marker.length);
  assert.ok(end > start);
  return [...sql.slice(start + marker.length, end).matchAll(/'([^']+)'/gu)]
    .map((match) => match[1] ?? '');
}

async function applyMigration(
  pool: InstanceType<typeof pg.Pool>,
  migration: string,
): Promise<void> {
  const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO migration_history(version) VALUES ($1)', [migration]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assertSequenceOrderedExpirations(
  pool: InstanceType<typeof pg.Pool>,
): Promise<void> {
  const earlierTransaction = await pool.connect();
  const laterTransaction = await pool.connect();
  let earlierOpen = false;
  let laterOpen = false;
  try {
    await earlierTransaction.query('BEGIN');
    earlierOpen = true;
    await delay(50);
    await laterTransaction.query('BEGIN');
    laterOpen = true;
    await laterTransaction.query(
      domainEventInsertSql,
      ['expiration-sequence-first', 'expiration-sequence-first-signature', '54'],
    );
    await laterTransaction.query('COMMIT');
    laterOpen = false;
    await earlierTransaction.query(
      domainEventInsertSql,
      ['expiration-sequence-second', 'expiration-sequence-second-signature', '55'],
    );
    await earlierTransaction.query('COMMIT');
    earlierOpen = false;

    const expirations = await pool.query<{
      readonly domain_event_id: string;
      readonly purge_after: Date;
      readonly sequence: string;
    }>(
      `SELECT domain_event_id, purge_after, sequence
       FROM api_event_stream
       WHERE domain_event_id IN ('expiration-sequence-first', 'expiration-sequence-second')
       ORDER BY sequence`,
    );
    assert.deepEqual(expirations.rows.map((row) => row.domain_event_id), [
      'expiration-sequence-first',
      'expiration-sequence-second',
    ]);
    assert.ok(
      (expirations.rows[1]?.purge_after.getTime() ?? 0)
        >= (expirations.rows[0]?.purge_after.getTime() ?? 1),
    );
  } finally {
    if (earlierOpen) await earlierTransaction.query('ROLLBACK');
    if (laterOpen) await laterTransaction.query('ROLLBACK');
    earlierTransaction.release();
    laterTransaction.release();
  }
}

async function assertCommitOrderedSequences(
  pool: InstanceType<typeof pg.Pool>,
  schema: string,
): Promise<void> {
  const first = await pool.connect();
  const second = await pool.connect();
  let firstOpen = false;
  let secondOpen = false;
  try {
    for (const client of [first, second]) {
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await client.query("SET statement_timeout TO '5s'");
    }
    const firstPid = (await first.query<{ readonly pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    )).rows[0]?.pid;
    const secondPid = (await second.query<{ readonly pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    )).rows[0]?.pid;
    assert.notEqual(firstPid, undefined);
    assert.notEqual(secondPid, undefined);
    await first.query('BEGIN');
    firstOpen = true;
    await second.query('BEGIN');
    secondOpen = true;
    await first.query(domainEventInsertSql, ['concurrent-first', 'concurrent-first-signature', '48']);

    const secondInsert = second.query(
      domainEventInsertSql,
      ['concurrent-second', 'concurrent-second-signature', '49'],
    );
    await waitForAdvisoryLockWait(pool, firstPid ?? -1, secondPid ?? -1);
    assert.equal((await pool.query(
      `SELECT 1 FROM ${quoteIdentifier(schema)}.api_event_stream
       WHERE domain_event_id IN ('concurrent-first', 'concurrent-second')`,
    )).rowCount, 0);

    await first.query('COMMIT');
    firstOpen = false;
    await withTimeout(secondInsert, 2_000);
    const betweenCommits = await pool.query<{
      readonly domain_event_id: string;
      readonly sequence: string;
    }>(
      `SELECT domain_event_id, sequence
       FROM ${quoteIdentifier(schema)}.api_event_stream
       WHERE domain_event_id IN ('concurrent-first', 'concurrent-second')`,
    );
    assert.deepEqual(betweenCommits.rows.map((row) => row.domain_event_id), ['concurrent-first']);
    assert.equal(
      (await pool.query<{ readonly last_sequence: string }>(
        `SELECT last_sequence FROM ${quoteIdentifier(schema)}.api_event_stream_state WHERE id = 1`,
      )).rows[0]?.last_sequence,
      betweenCommits.rows[0]?.sequence,
    );

    await second.query('COMMIT');
    secondOpen = false;

    const sequences = await pool.query<{ readonly domain_event_id: string; readonly sequence: string }>(
      `SELECT domain_event_id, sequence
       FROM ${quoteIdentifier(schema)}.api_event_stream
       WHERE domain_event_id IN ('concurrent-first', 'concurrent-second')
       ORDER BY sequence`,
    );
    assert.deepEqual(sequences.rows.map((row) => row.domain_event_id), [
      'concurrent-first',
      'concurrent-second',
    ]);
    assert.ok(BigInt(sequences.rows[0]?.sequence ?? '0') < BigInt(sequences.rows[1]?.sequence ?? '0'));
    assert.equal(
      (await pool.query<{ readonly last_sequence: string }>(
        `SELECT last_sequence FROM ${quoteIdentifier(schema)}.api_event_stream_state WHERE id = 1`,
      )).rows[0]?.last_sequence,
      sequences.rows[1]?.sequence,
    );
  } finally {
    if (firstOpen) await first.query('ROLLBACK');
    if (secondOpen) await second.query('ROLLBACK');
    first.release();
    second.release();
  }
}

const domainEventInsertSql = `INSERT INTO domain_events (
  event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
  confirmation_status, observed_at, payload_version, payload
) VALUES ($1, 'TokenLaunchDetected', 'mint-live', 'listener', 'program-live', $2,
  $3, 1, 2, 'processed', NOW(), 1, '{}'::jsonb)`;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const rejection = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('PostgreSQL concurrency test timed out.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, rejection]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForAdvisoryLockWait(
  pool: InstanceType<typeof pg.Pool>,
  holderPid: number,
  waiterPid: number,
): Promise<void> {
  await pollUntil(async () => {
    const locks = await pool.query<{
      readonly granted: boolean;
      readonly pid: number;
      readonly wait_event_type: string | null;
    }>(
      `SELECT lock.pid, lock.granted, activity.wait_event_type
       FROM pg_locks lock
       JOIN pg_stat_activity activity ON activity.pid = lock.pid
       WHERE lock.locktype = 'advisory'
         AND lock.classid = $1::oid
         AND lock.objid = $2::oid
         AND lock.objsubid = 2
         AND lock.pid = ANY($3::int[])`,
      [1095782223, 1163281235, [holderPid, waiterPid]],
    );
    const holder = locks.rows.find((row) => row.pid === holderPid);
    const waiter = locks.rows.find((row) => row.pid === waiterPid);
    return holder?.granted === true
      && waiter?.granted === false
      && waiter.wait_event_type === 'Lock';
  }, 2_000);
}

async function pollUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error('PostgreSQL advisory lock wait was not observed before timeout.');
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
