import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { PublicKey } from '@solana/web3.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/009_transaction_ingestion.sql', import.meta.url);
const catchUpGapMigrationUrl = new URL('../migrations/016_listener_catch_up_gaps.sql', import.meta.url);
const strictCatchUpFailureMigrationUrl = new URL(
  '../migrations/026_listener_strict_catch_up_failures.sql',
  import.meta.url,
);

void test('creates replayable four-hour catch-up gap evidence', async () => {
  const sql = await readFile(catchUpGapMigrationUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS listener_catch_up_gaps/u);
  assert.match(sql, /gap_id TEXT PRIMARY KEY/u);
  assert.match(sql, /checkpoint_key TEXT NOT NULL/u);
  assert.match(sql, /previous_slot NUMERIC\(78,0\) NOT NULL/u);
  assert.match(sql, /baseline_slot NUMERIC\(78,0\) NOT NULL/u);
  assert.match(sql, /observed_at TIMESTAMPTZ NOT NULL/u);
  assert.match(sql, /purge_after TIMESTAMPTZ NOT NULL/u);
  assert.match(sql, /purge_after = observed_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /checkpoint_key IN \('launchpad', 'market'\)/u);
  assert.match(sql, /baseline_slot >= previous_slot/u);
  assert.match(sql, /OCTET_LENGTH\(previous_signature\) BETWEEN 1 AND 128/u);
  assert.match(sql, /OCTET_LENGTH\(baseline_signature\) BETWEEN 1 AND 128/u);
  assert.match(sql, /listener_catch_up_gaps_purge_idx/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /DROP TABLE|private[_ ]?key|send[_ ]?transaction/iu);
});

void test('creates replayable strict catch-up failure evidence without unsafe diagnostics', async () => {
  const sql = await readFile(strictCatchUpFailureMigrationUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS listener_strict_catch_up_failures/u);
  assert.match(sql, /failure_id TEXT PRIMARY KEY/u);
  assert.match(sql, /failure_id ~ '\^strict_catchup_failure_\[0-9a-f\]\{64\}\$'/u);
  assert.match(sql, /checkpoint_key IN \('launchpad', 'market'\)/u);
  assert.match(sql, /previous_slot NUMERIC\(78,0\)/u);
  assert.match(sql, /previous_signature TEXT/u);
  assert.match(sql, /\(previous_slot IS NULL\) = \(previous_signature IS NULL\)/u);
  assert.match(sql, /previous_slot >= 0/u);
  assert.match(sql, /previous_slot <> 'NaN'::NUMERIC/u);
  assert.match(sql, /OCTET_LENGTH\(previous_signature\) BETWEEN 1 AND 128/u);
  assert.match(sql, /provider_id IN \('primary', 'fallback-1', 'fallback-2', 'fallback-3'\)/u);
  assert.match(sql, /observed_head_slot NUMERIC\(78,0\)/u);
  assert.match(sql, /observed_head_slot >= 0/u);
  assert.match(sql, /observed_head_slot <> 'NaN'::NUMERIC/u);
  assert.match(sql, /reason_code IN \('CATCH_UP_WINDOW_EXCEEDED'\)/u);
  assert.match(sql, /detected_at TIMESTAMPTZ NOT NULL/u);
  assert.match(sql, /resolved_at TIMESTAMPTZ/u);
  assert.match(sql, /purge_after TIMESTAMPTZ/u);
  assert.match(sql, /isfinite\(detected_at\)/u);
  assert.match(sql, /resolved_at IS NULL OR isfinite\(resolved_at\)/u);
  assert.match(sql, /purge_after IS NULL OR isfinite\(purge_after\)/u);
  assert.match(sql, /resolved_at IS NULL AND purge_after IS NULL/u);
  assert.match(sql, /resolved_at IS NOT NULL[\s\S]*purge_after IS NOT NULL/u);
  assert.match(sql, /purge_after = resolved_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /listener_strict_catch_up_failures_unresolved_boundary_idx/u);
  assert.match(sql, /listener_strict_catch_up_failures_resolved_purge_idx/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /error|url|private[_ ]?key|secret|DROP TABLE|send[_ ]?transaction/iu);
});

void test('enforces strict failure lifecycle and finite numeric boundaries in PostgreSQL', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `strict_catch_up_failure_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    const sql = await readFile(strictCatchUpFailureMigrationUrl, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const insert = async (failureId: string, values: Readonly<{
      readonly previousSlot?: string;
      readonly previousSignature?: string | null;
      readonly observedHeadSlot?: string | null;
      readonly detectedAt?: string;
      readonly resolvedAt?: string | null;
      readonly purgeAfter?: string | null;
    }> = {}) => pool.query(`INSERT INTO listener_strict_catch_up_failures (
      failure_id, checkpoint_key, previous_slot, previous_signature, provider_id,
      observed_head_slot, reason_code, detected_at, resolved_at, purge_after
    ) VALUES ($1, 'launchpad', $2::NUMERIC, $3, 'primary', $4::NUMERIC,
      'CATCH_UP_WINDOW_EXCEEDED', $5::TIMESTAMPTZ, $6::TIMESTAMPTZ,
      $7::TIMESTAMPTZ)`, [
      failureId,
      values.previousSlot ?? '1',
      values.previousSignature ?? 'strict-boundary',
      values.observedHeadSlot ?? '2',
      values.detectedAt ?? '2025-01-01T00:00:00.000Z',
      values.resolvedAt ?? null,
      values.purgeAfter ?? null,
    ]);
    const prefix = 'strict_catchup_failure_';
    await assert.rejects(
      insert(`${prefix}${'a'.repeat(64)}`, { resolvedAt: '2025-01-01T00:00:00.000Z' }),
      /listener_strict_catch_up_failures_lifecycle_check/u,
    );
    await assert.rejects(
      insert(`${prefix}${'b'.repeat(64)}`, { previousSlot: 'NaN' }),
      /listener_strict_catch_up_failures_previous_check/u,
    );
    await assert.rejects(
      insert(`${prefix}${'c'.repeat(64)}`, { observedHeadSlot: 'NaN' }),
      /listener_strict_catch_up_failures_head_check/u,
    );
    await assert.rejects(
      insert(`${prefix}${'d'.repeat(64)}`, { detectedAt: 'infinity' }),
      /listener_strict_catch_up_failures_detected_at_check/u,
    );
    await assert.rejects(
      insert(`${prefix}${'e'.repeat(64)}`, { detectedAt: '-infinity' }),
      /listener_strict_catch_up_failures_detected_at_check/u,
    );
    // A finite purge timestamp avoids purge_after_check; lifecycle_check remains
    // legitimately concurrent because no finite value can equal infinity + four hours.
    const resolvedAtOrLifecycle = /listener_strict_catch_up_failures_(?:resolved_at|lifecycle)_check/u;
    await assert.rejects(
      insert(`${prefix}${'f'.repeat(64)}`, {
        resolvedAt: 'infinity', purgeAfter: '2025-01-01T04:00:00.000Z',
      }),
      resolvedAtOrLifecycle,
    );
    await assert.rejects(
      insert(`${prefix}${'0'.repeat(64)}`, {
        resolvedAt: '-infinity', purgeAfter: '2025-01-01T04:00:00.000Z',
      }),
      resolvedAtOrLifecycle,
    );
    // An infinite purge timestamp violates its finite bound and cannot satisfy
    // the lifecycle equation with a finite resolved timestamp.
    const purgeAfterOrLifecycle = /listener_strict_catch_up_failures_(?:purge_after|lifecycle)_check/u;
    await assert.rejects(
      insert(`${prefix}${'1'.repeat(64)}`, {
        resolvedAt: '2025-01-01T00:00:00.000Z', purgeAfter: 'infinity',
      }),
      purgeAfterOrLifecycle,
    );
    await assert.rejects(
      insert(`${prefix}${'2'.repeat(64)}`, {
        resolvedAt: '2025-01-01T00:00:00.000Z', purgeAfter: '-infinity',
      }),
      purgeAfterOrLifecycle,
    );
    await insert(`${prefix}${'3'.repeat(64)}`, {
      resolvedAt: '2025-01-01T00:00:00.000Z',
      purgeAfter: '2025-01-01T04:00:00.000Z',
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('creates a replayable bigint-safe transaction inbox with strict lifecycle checks', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS chain_transaction_inbox/u);
  assert.match(sql, /signature TEXT PRIMARY KEY/u);
  assert.match(sql, /observed_slot NUMERIC\(78,0\) NOT NULL/u);
  assert.match(sql, /discovery_sources TEXT\[\] NOT NULL/u);
  assert.match(sql, /program_ids TEXT\[\] NOT NULL/u);
  assert.match(sql, /target_confirmation_status TEXT NOT NULL/u);
  assert.match(sql, /processing_status TEXT NOT NULL/u);
  assert.match(sql, /attempts INTEGER NOT NULL DEFAULT 0/u);
  assert.match(sql, /missing_finality_polls INTEGER NOT NULL DEFAULT 0/u);
  assert.match(sql, /lease_token TEXT/u);
  assert.match(sql, /lease_expires_at TIMESTAMPTZ/u);
  assert.match(sql, /next_attempt_at TIMESTAMPTZ/u);
  assert.match(sql, /normalized_transaction JSONB/u);
  assert.match(sql, /immutable_fingerprint TEXT/u);
  assert.match(sql, /error_code TEXT/u);
  assert.match(sql, /error_name TEXT/u);
  assert.match(sql, /error_retryable BOOLEAN/u);
  assert.doesNotMatch(sql, /error_message/iu);
  assert.match(sql, /blockchain_time TIMESTAMPTZ/u);
  assert.match(sql, /observed_at TIMESTAMPTZ NOT NULL/u);
  assert.match(sql, /processed_at TIMESTAMPTZ/u);
  assert.match(sql, /terminal_at TIMESTAMPTZ/u);
  assert.match(sql, /purge_after TIMESTAMPTZ/u);

  assert.match(sql, /discovery_sources IN \([\s\S]*ARRAY\['WEBSOCKET'\]::TEXT\[\][\s\S]*ARRAY\['CATCH_UP'\]::TEXT\[\][\s\S]*ARRAY\['WEBSOCKET', 'CATCH_UP'\]::TEXT\[\]/u);
  assert.match(sql, /CARDINALITY\(program_ids\) BETWEEN 1 AND 16/u);
  assert.match(sql, /ARRAY_POSITION\(program_ids, NULL\) IS NULL/u);
  assert.match(sql, /OCTET_LENGTH\(program_id\) NOT BETWEEN 32 AND 44/u);
  assert.match(sql, /program_id !~ '\^\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\$'/u);
  assert.match(sql, /SELECT DISTINCT program_id[\s\S]*ORDER BY program_id/u);
  assert.doesNotMatch(sql, /program_ids TEXT\[\][^\n]*DEFAULT/iu);
  assert.match(sql, /target_confirmation_status IN \('processed', 'confirmed', 'finalized', 'orphaned'\)/u);
  assert.match(sql, /processing_status IN \('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'\)/u);
  assert.match(sql, /attempts >= 0/u);
  assert.match(sql, /missing_finality_polls >= 0/u);
  assert.match(sql, /processing_status = 'FAILED'[\s\S]*error_code IS NOT NULL[\s\S]*error_code IN \([\s\S]*error_name IS NOT NULL[\s\S]*error_retryable IS NOT NULL/u);
  assert.match(sql, /processing_status <> 'FAILED'[\s\S]*error_code IS NULL[\s\S]*error_name IS NULL[\s\S]*error_retryable IS NULL/u);
  assert.match(sql, /OCTET_LENGTH\(error_name\) BETWEEN 1 AND 16384/u);
  assert.doesNotMatch(sql, /(?:^|[^_])LENGTH\(error_name\)|CHAR_LENGTH\(error_name\)/mu);
  assert.match(sql, /lease_token IS NULL AND lease_expires_at IS NULL/u);
  assert.match(sql, /normalized_transaction IS NULL AND immutable_fingerprint IS NULL/u);
  assert.match(sql, /normalized_transaction IS NOT NULL[\s\S]*immutable_fingerprint IS NOT NULL[\s\S]*immutable_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(sql, /terminal_at IS NOT NULL[\s\S]*purge_after IS NOT NULL[\s\S]*purge_after = terminal_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /terminal_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /target_confirmation_status IN \('finalized', 'orphaned'\)/u);
  assert.match(sql, /chain_transaction_inbox_claim_idx/u);
  assert.match(sql, /chain_transaction_inbox_claim_order_idx/u);
  assert.match(sql, /ON chain_transaction_inbox \(observed_slot, signature\)[\s\S]*processing_status = 'PENDING'[\s\S]*error_retryable = TRUE/u);
  assert.match(sql, /chain_transaction_inbox_finality_idx/u);
  assert.match(sql, /chain_transaction_inbox_purge_idx/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /private[_ ]?key|keypair|send[_ ]?transaction/iu);
  assert.doesNotMatch(sql, /DROP TABLE/iu);
});

void test('extends legacy listener heartbeats without seeding checkpoints', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const column of [
    'runtime_state',
    'subscriber_state',
    'scanner_state',
    'worker_state',
    'reconciler_state',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} TEXT`, 'u'));
  }
  assert.match(sql, /ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS leased_transactions INTEGER NOT NULL DEFAULT 0/u);
  assert.match(sql, /STARTING.*RUNNING.*DEGRADED.*STOPPING.*STOPPED/su);
  assert.match(sql, /pending_transactions >= 0/u);
  assert.match(sql, /leased_transactions BETWEEN 0 AND pending_transactions/u);
  assert.doesNotMatch(sql, /INSERT INTO processing_checkpoints/iu);
});

void test('defines the transaction inbox port at the canonical snapshot conversion boundary', async () => {
  const source = await readFile(
    new URL('../src/ports/transaction-inbox-repository.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /export interface TransactionInboxRepository/u);
  for (const method of [
    'enqueue',
    'claim',
    'renewLease',
    'saveSnapshot',
    'markProcessed',
    'markFailed',
    'recoverExhausted',
    'listForFinality',
    'recordFinalityPoll',
    'enqueueRevision',
    'readCheckpoint',
    'storeCheckpoint',
    'recordCatchUpGap',
    'writeHeartbeat',
    'counts',
  ]) assert.match(source, new RegExp(`\\b${method}\\(`, 'u'));
  assert.match(source, /saveSnapshot\([\s\S]*tx: NormalizedTransaction[\s\S]*Promise<void>/u);
  assert.match(source, /createDurableTransactionSnapshot/u);
  assert.doesNotMatch(source, /purge/u);
});

void test('purges only expired resolved strict failures and exposes their count', async () => {
  const source = await readFile(new URL('../src/storage/database.ts', import.meta.url), 'utf8');

  assert.match(source, /readonly listenerStrictCatchUpFailures: number;/u);
  assert.match(
    source,
    /DELETE FROM listener_strict_catch_up_failures[\s\S]*resolved_at IS NOT NULL[\s\S]*purge_after <= clock_timestamp\(\)/u,
  );
  const strictFailureDeletion = /DELETE FROM listener_strict_catch_up_failures[\s\S]*?purge_after <= clock_timestamp\(\)/u
    .exec(source)?.[0] ?? '';
  assert.doesNotMatch(strictFailureDeletion, /resolved_at IS NULL/u);
  assert.match(
    source,
    /listenerStrictCatchUpFailures: listenerStrictCatchUpFailures\.rowCount \?\? 0,/u,
  );
  assert.match(source, /readonly transactionInbox: number;/u);
  assert.match(source, /DELETE FROM chain_transaction_inbox[\s\S]*terminal_at IS NOT NULL[\s\S]*purge_after <= clock_timestamp\(\)/u);
  const deletion = /DELETE FROM chain_transaction_inbox[\s\S]*?purge_after <= clock_timestamp\(\)/u
    .exec(source)?.[0] ?? '';
  assert.doesNotMatch(deletion, /processing_status = 'PROCESSED'/u);
  assert.match(source, /transactionInbox: transactionInbox\.rowCount \?\? 0,/u);
  const inboxDeletion = source.indexOf('DELETE FROM chain_transaction_inbox');
  const rawDeletion = source.indexOf('DELETE FROM raw_chain_events raw');
  assert.ok(inboxDeletion >= 0 && inboxDeletion < rawDeletion);

  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text === "SELECT date_trunc('milliseconds', statement_timestamp()) AS purge_cutoff") {
        return { rows: [{ purge_cutoff: new Date(0) }], rowCount: 1 };
      }
      if (text.includes('DELETE FROM listener_strict_catch_up_failures')) {
        return { rows: [], rowCount: 2 };
      }
      if (text.includes('DELETE FROM chain_transaction_inbox')) return { rows: [], rowCount: 3 };
      if (text.includes('WITH deleted AS')) {
        return { rows: [{ deleted_count: '0' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as InstanceType<typeof pg.Pool>;

  const result = await purgeExpiredFoundationData(pool);
  assert.equal(result.websocketHealthEvidence, 0);
  assert.equal(result.listenerStrictCatchUpFailures, 2);
  assert.equal(result.transactionInbox, 3);
  assert.deepEqual(queries.slice(-1), ['COMMIT']);
});

void test('retains unresolved and unexpired strict failure evidence in PostgreSQL', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `strict_catch_up_retention_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    const strictFailure = async (
      id: string,
      resolvedAt: string | null,
      purgeAfter: string | null,
    ) => pool.query(`INSERT INTO listener_strict_catch_up_failures (
      failure_id, checkpoint_key, previous_slot, previous_signature, provider_id,
      observed_head_slot, reason_code, detected_at, resolved_at, purge_after
    ) VALUES ($1, 'launchpad', 1, 'strict-boundary', 'primary', 2,
      'CATCH_UP_WINDOW_EXCEEDED', '2025-01-01T00:00:00.000Z', $2, $3)`,
    [id, resolvedAt, purgeAfter]);
    const prefix = 'strict_catchup_failure_';
    await strictFailure(`${prefix}${'a'.repeat(64)}`, '2025-01-01T00:00:00.000Z', '2025-01-01T04:00:00.000Z');
    await strictFailure(`${prefix}${'b'.repeat(64)}`, null, null);
    await strictFailure(`${prefix}${'c'.repeat(64)}`, '2999-01-01T00:00:00.000Z', '2999-01-01T04:00:00.000Z');

    const result = await purgeExpiredFoundationData(pool);

    assert.equal(result.websocketHealthEvidence, 0);
    assert.equal(result.listenerStrictCatchUpFailures, 1);
    assert.deepEqual((await pool.query(`SELECT failure_id FROM listener_strict_catch_up_failures
      ORDER BY failure_id`)).rows, [
      { failure_id: `${prefix}${'b'.repeat(64)}` },
      { failure_id: `${prefix}${'c'.repeat(64)}` },
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('applies migrations 001-039 on an empty PostgreSQL schema and replays cleanly', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `transaction_ingestion_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '039_execution_canary_operator_binding.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    assert.equal((await pool.query('SELECT COUNT(*) FROM processing_checkpoints')).rows[0]?.count, '0');
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, error_code, error_name, error_retryable, observed_at,
      terminal_at, purge_after
    ) VALUES (
      'failed-structured', 42, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed',
      'FAILED', 'NORMALIZATION_FAILED', 'TransactionNormalizationError', FALSE, NOW(),
      NOW(), NOW() + INTERVAL '4 hours'
    )`);
    assert.equal((await pool.query(
      "SELECT 1 FROM chain_transaction_inbox WHERE signature = 'failed-structured'",
    )).rowCount, 1);
    const multibyteName = 'é'.repeat(129);
    const exactMultibyteName = 'é'.repeat(8_192);
    const oversizedMultibyteName = `${exactMultibyteName}a`;
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, error_code, error_name, error_retryable, observed_at,
      terminal_at, purge_after
    ) VALUES ($1, 45, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed', 'FAILED',
      'NORMALIZATION_FAILED', $2, FALSE, NOW(), NOW(), NOW() + INTERVAL '4 hours')`,
    ['failed-multibyte', multibyteName]);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, error_code, error_name, error_retryable, observed_at,
      terminal_at, purge_after
    ) VALUES ($1, 46, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed', 'FAILED',
      'NORMALIZATION_FAILED', $2, FALSE, NOW(), NOW(), NOW() + INTERVAL '4 hours')`,
    ['failed-exact-name', exactMultibyteName]);
    assert.equal((await pool.query<{ readonly bytes: number }>(
      "SELECT OCTET_LENGTH(error_name) AS bytes FROM chain_transaction_inbox WHERE signature = 'failed-exact-name'",
    )).rows[0]?.bytes, 16_384);
    await assert.rejects(
      pool.query(`INSERT INTO chain_transaction_inbox (
        signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
        processing_status, error_code, error_name, error_retryable, observed_at,
        terminal_at, purge_after
      ) VALUES ($1, 47, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed', 'FAILED',
        'NORMALIZATION_FAILED', $2, FALSE, NOW(), NOW(), NOW() + INTERVAL '4 hours')`,
      ['failed-oversized-name', oversizedMultibyteName]),
      /chain_transaction_inbox_error_check/u,
    );
    await assert.rejects(
      pool.query(`INSERT INTO chain_transaction_inbox (
        signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
        processing_status, error_code, error_name, observed_at, terminal_at, purge_after
      ) VALUES (
        'failed-incomplete', 43, ARRAY['CATCH_UP'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed',
        'FAILED', 'NORMALIZATION_FAILED', 'TransactionNormalizationError', NOW(),
        NOW(), NOW() + INTERVAL '4 hours'
      )`),
      /chain_transaction_inbox_error_check/u,
    );
    await assert.rejects(
      pool.query(`INSERT INTO chain_transaction_inbox (
        signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
        processing_status, error_name, error_retryable, observed_at, terminal_at, purge_after
      ) VALUES (
        'failed-without-code', 44, ARRAY['CATCH_UP'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed',
        'FAILED', 'TransactionNormalizationError', FALSE, NOW(),
        NOW(), NOW() + INTERVAL '4 hours'
      )`),
      /chain_transaction_inbox_error_check/u,
    );
    await assert.rejects(
      pool.query(`UPDATE chain_transaction_inbox
        SET processing_status = 'PENDING'
        WHERE signature = 'failed-structured'`),
      /chain_transaction_inbox_error_check/u,
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('backfills and constrains a heartbeat row created by migrations 001-008', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `transaction_heartbeat_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await applyMigrations(pool, 8);
    await pool.query(`INSERT INTO listener_heartbeats (
      service_key, last_http_slot, last_websocket_slot, last_finalized_slot,
      last_signature, pending_transactions, retry_count, active_sessions, payload, updated_at
    ) VALUES (
      'legacy-listener', 100, 99, 98, 'legacy-signature', 3, 7, 2,
      '{"legacy":true}'::jsonb, '2025-01-01T00:00:10.000Z'
    )`);

    const migrationSql = await readFile(migrationUrl, 'utf8');
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    const heartbeat = (await pool.query(`SELECT
      service_key, last_http_slot, pending_transactions, retry_count, active_sessions, payload,
      runtime_state, subscriber_state, scanner_state, worker_state, reconciler_state,
      started_at, leased_transactions
      FROM listener_heartbeats WHERE service_key = 'legacy-listener'`)).rows[0];
    assert.deepEqual(heartbeat, {
      service_key: 'legacy-listener',
      last_http_slot: '100',
      pending_transactions: 3,
      retry_count: '7',
      active_sessions: 2,
      payload: { legacy: true },
      runtime_state: 'STOPPED',
      subscriber_state: 'STOPPED',
      scanner_state: 'STOPPED',
      worker_state: 'STOPPED',
      reconciler_state: 'STOPPED',
      started_at: null,
      leased_transactions: 0,
    });
    await assert.rejects(
      pool.query(`UPDATE listener_heartbeats
        SET pending_transactions = 0, leased_transactions = 1
        WHERE service_key = 'legacy-listener'`),
      /listener_heartbeats_runtime_counts_check/u,
    );
    await assert.rejects(
      pool.query(`UPDATE listener_heartbeats
        SET pending_transactions = -1, leased_transactions = 0
        WHERE service_key = 'legacy-listener'`),
      /listener_heartbeats_runtime_counts_check/u,
    );
    await pool.query(`UPDATE listener_heartbeats
      SET pending_transactions = 2, leased_transactions = 2
      WHERE service_key = 'legacy-listener'`);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('backfills strict state transition provenance from pre-009 domain events', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `transition_provenance_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await applyMigrations(pool, 8);
    await pool.query(`INSERT INTO domain_events (
      event_id,type,mint,source,program,signature,slot,transaction_index,
      instruction_index,inner_instruction_index,confirmation_status,
      blockchain_time,observed_at,payload_version,payload
    ) VALUES
      ('event-chain','TokenLaunchDetected','mint-chain','pumpfun','pump',
        'signature-chain',1,0,0,NULL,'confirmed','2025-01-01T00:00:00Z',
        '2025-01-01T00:00:01Z',1,'{}'::jsonb),
      ('event-observation','TokenLaunchDetected','mint-observation','pumpfun','pump',
        'signature-observation',2,0,0,NULL,'confirmed',NULL,
        '2025-01-01T00:00:02Z',1,'{}'::jsonb)`);
    await pool.query(`INSERT INTO state_transitions (
      transition_id,mint,event_id,occurred_at,trigger_event,new_state,human_message
    ) VALUES
      ('transition-chain','mint-chain','event-chain','2025-01-01T00:00:00Z',
        'TokenLaunchDetected','DETECTED','chain'),
      ('transition-observation','mint-observation','event-observation',
        '2025-01-01T00:00:02Z','TokenLaunchDetected','DETECTED','observation'),
      ('transition-unlinked','mint-unlinked',NULL,'2025-01-01T00:00:03Z',
        'TokenLaunchDetected','DETECTED','unlinked')`);

    const migrationSql = await readFile(migrationUrl, 'utf8');
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    assert.deepEqual((await pool.query(`SELECT transition_id,payload_version,
      occurred_at_source FROM state_transitions ORDER BY transition_id`)).rows, [
      { transition_id: 'transition-chain', payload_version: 1, occurred_at_source: 'blockchain' },
      { transition_id: 'transition-observation', payload_version: 1, occurred_at_source: 'observation' },
      { transition_id: 'transition-unlinked', payload_version: 1, occurred_at_source: 'observation' },
    ]);
    assert.deepEqual((await pool.query(`SELECT column_name,is_nullable,column_default
      FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='state_transitions'
        AND column_name IN ('payload_version','occurred_at_source')
      ORDER BY column_name`)).rows, [
      { column_name: 'occurred_at_source', is_nullable: 'NO', column_default: null },
      { column_name: 'payload_version', is_nullable: 'NO', column_default: null },
    ]);
    await assert.rejects(pool.query(`INSERT INTO state_transitions (
      transition_id,mint,event_id,occurred_at,trigger_event,new_state,human_message
    ) VALUES ('missing-provenance','mint-chain','event-chain',clock_timestamp(),
      'TokenLaunchDetected','DETECTED','missing')`), /null value/u);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('enforces inbox lifecycle checks and terminal-only purge in PostgreSQL', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `transaction_matrix_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    const fingerprint = 'a'.repeat(64);
    const snapshot = { signature: 'durable-snapshot' };
    const processed = '2025-01-01T00:00:01.000Z';
    const terminal = '2025-01-01T00:00:02.000Z';
    const purgeAfter = '2025-01-01T04:00:02.000Z';
    const insertCases: readonly InboxInsertCase[] = [
      { name: 'websocket-source', accept: true, value: {} },
      { name: 'catch-up-source', accept: true, value: { discoverySources: ['CATCH_UP'] } },
      { name: 'both-sources', accept: true, value: { discoverySources: ['WEBSOCKET', 'CATCH_UP'] } },
      { name: 'empty-sources', accept: false, value: { discoverySources: [] } },
      { name: 'reversed-sources', accept: false, value: { discoverySources: ['CATCH_UP', 'WEBSOCKET'] } },
      { name: 'duplicate-sources', accept: false, value: { discoverySources: ['WEBSOCKET', 'WEBSOCKET'] } },
      { name: 'unknown-source', accept: false, value: { discoverySources: ['POLLING'] } },
      { name: 'null-source-member', accept: false, value: { discoverySources: ['WEBSOCKET', null] } },
      { name: 'empty-programs', accept: false, value: { programIds: [] } },
      { name: 'two-programs', accept: true, value: { programIds: [
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      ] } },
      { name: 'reversed-programs', accept: false, value: { programIds: [
        'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      ] } },
      { name: 'duplicate-programs', accept: false, value: { programIds: [
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      ] } },
      { name: 'null-program-member', accept: false, value: {
        programIds: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', null],
      } },
      { name: 'invalid-base58-program', accept: false, value: {
        programIds: ['0invalidBase58Address111111111111111111'],
      } },
      { name: 'base58-uppercase-o', accept: false, value: { programIds: ['O'.repeat(32)] } },
      { name: 'base58-uppercase-i', accept: false, value: { programIds: ['I'.repeat(32)] } },
      { name: 'base58-lowercase-l', accept: false, value: { programIds: ['l'.repeat(32)] } },
      { name: 'short-program', accept: false, value: { programIds: ['111'] } },
      { name: 'too-many-programs', accept: false, value: {
        programIds: validProgramIds(17),
      } },
      { name: 'processing-lease', accept: true, value: processingState() },
      { name: 'processing-no-token', accept: false, value: { ...processingState(), leaseToken: null } },
      { name: 'processing-no-expiry', accept: false, value: { ...processingState(), leaseExpiresAt: null } },
      { name: 'pending-with-lease', accept: false, value: { leaseToken: 'lease', leaseExpiresAt: processed } },
      { name: 'snapshot-pair', accept: true, value: { normalizedTransaction: snapshot, immutableFingerprint: fingerprint } },
      { name: 'snapshot-no-fingerprint', accept: false, value: { normalizedTransaction: snapshot } },
      { name: 'fingerprint-no-snapshot', accept: false, value: { immutableFingerprint: fingerprint } },
      { name: 'snapshot-array', accept: false, value: { normalizedTransaction: [], immutableFingerprint: fingerprint } },
      { name: 'uppercase-fingerprint', accept: false, value: { normalizedTransaction: snapshot, immutableFingerprint: 'A'.repeat(64) } },
      { name: 'failed-no-retry', accept: true, value: failedState(false) },
      { name: 'failed-retry', accept: true, value: { ...failedState(true), nextAttemptAt: processed } },
      { name: 'failed-retry-no-time', accept: false, value: failedState(true) },
      { name: 'failed-no-retry-with-time', accept: false, value: { ...failedState(false), nextAttemptAt: processed } },
      { name: 'pending-next-attempt', accept: false, value: { nextAttemptAt: processed } },
      { name: 'failed-no-code', accept: false, value: { ...failedState(false), errorCode: null } },
      { name: 'failed-no-name', accept: false, value: { ...failedState(false), errorName: null } },
      { name: 'failed-no-retryable', accept: false, value: { ...failedState(false), errorRetryable: null } },
      { name: 'failed-unknown-code', accept: false, value: { ...failedState(false), errorCode: 'UNKNOWN' } },
      { name: 'pending-with-failure', accept: false, value: failureFields(false) },
      { name: 'processed-at-processed-finality', accept: true, value: processedState('processed', snapshot, fingerprint, processed) },
      { name: 'processed-confirmed', accept: true, value: processedState('confirmed', snapshot, fingerprint, processed) },
      { name: 'processed-finalized', accept: true, value: terminalState('finalized', snapshot, fingerprint, processed, terminal, purgeAfter) },
      { name: 'processed-orphaned', accept: true, value: terminalState('orphaned', snapshot, fingerprint, processed, terminal, purgeAfter) },
      { name: 'processed-no-snapshot', accept: false, value: { processingStatus: 'PROCESSED', processedAt: processed } },
      { name: 'finalized-no-terminal', accept: false, value: processedState('finalized', snapshot, fingerprint, processed) },
      { name: 'finalized-no-purge', accept: false, value: { ...terminalState('finalized', snapshot, fingerprint, processed, terminal, purgeAfter), purgeAfter: null } },
      { name: 'terminal-pending', accept: false, value: { terminalAt: terminal, purgeAfter } },
      { name: 'terminal-nonterminal-finality', accept: false, value: { ...processedState('confirmed', snapshot, fingerprint, processed), terminalAt: terminal, purgeAfter } },
      { name: 'wrong-purge-deadline', accept: false, value: terminalState('finalized', snapshot, fingerprint, processed, terminal, '2025-01-01T04:00:03.000Z') },
      { name: 'negative-attempts', accept: false, value: { attempts: -1 } },
      { name: 'null-attempts', accept: false, value: { attempts: null } },
      { name: 'negative-missing-polls', accept: false, value: { missingFinalityPolls: -1 } },
      { name: 'null-missing-polls', accept: false, value: { missingFinalityPolls: null } },
      { name: 'invalid-target-finality', accept: false, value: { targetConfirmationStatus: 'unknown' } },
      { name: 'negative-slot', accept: false, value: { observedSlot: '-1' } },
      { name: 'updated-before-created', accept: false, value: { createdAt: processed, updatedAt: '2025-01-01T00:00:00.000Z' } },
      { name: 'processed-before-observed', accept: false, value: { ...processedState('confirmed', snapshot, fingerprint, '2024-12-31T23:59:59.000Z') } },
      { name: 'terminal-before-processed', accept: false, value: terminalState('finalized', snapshot, fingerprint, processed, '2025-01-01T00:00:00.500Z', '2025-01-01T04:00:00.500Z') },
    ];
    for (const [index, item] of insertCases.entries()) {
      const operation = insertInbox(pool, inboxValue(`matrix-${index}`, item.value));
      if (item.accept) await operation;
      else await assert.rejects(operation, /chain_transaction_inbox/u, item.name);
    }

    await insertInbox(pool, inboxValue('update-seed'));
    const updateCases: readonly SqlCase[] = [
      { name: 'status without lease', accept: false, text: "UPDATE chain_transaction_inbox SET processing_status = 'PROCESSING' WHERE signature = 'update-seed'" },
      { name: 'claim with lease', accept: true, text: "UPDATE chain_transaction_inbox SET processing_status = 'PROCESSING', lease_token = 'lease', lease_expires_at = '2025-01-01T00:01:00Z' WHERE signature = 'update-seed'" },
      { name: 'partial lease clear', accept: false, text: "UPDATE chain_transaction_inbox SET lease_token = NULL WHERE signature = 'update-seed'" },
      { name: 'release lease', accept: true, text: "UPDATE chain_transaction_inbox SET processing_status = 'PENDING', lease_token = NULL, lease_expires_at = NULL WHERE signature = 'update-seed'" },
      { name: 'mark processed', accept: true, text: `UPDATE chain_transaction_inbox SET processing_status = 'PROCESSED', normalized_transaction = '{"signature":"durable"}'::jsonb, immutable_fingerprint = '${fingerprint}', processed_at = '${processed}' WHERE signature = 'update-seed'` },
      { name: 'terminal without retention', accept: false, text: "UPDATE chain_transaction_inbox SET target_confirmation_status = 'finalized' WHERE signature = 'update-seed'" },
      { name: 'terminal with retention', accept: true, text: `UPDATE chain_transaction_inbox SET target_confirmation_status = 'finalized', terminal_at = '${terminal}', purge_after = '${purgeAfter}' WHERE signature = 'update-seed'` },
    ];
    for (const item of updateCases) {
      const operation = pool.query(item.text);
      if (item.accept) await operation;
      else await assert.rejects(operation, /chain_transaction_inbox_.+_check/u, item.name);
    }

    await pool.query('TRUNCATE transaction_inbox_recoveries, chain_transaction_inbox');
    await insertInbox(pool, inboxValue('purge-finalized', terminalState(
      'finalized', snapshot, fingerprint, '2020-01-01T00:00:01Z',
      '2020-01-01T00:00:02Z', '2020-01-01T04:00:02Z',
    ), { observedAt: '2020-01-01T00:00:00Z' }));
    await insertInbox(pool, inboxValue('purge-orphaned', terminalState(
      'orphaned', snapshot, fingerprint, '2020-01-01T00:00:01Z',
      '2020-01-01T00:00:02Z', '2020-01-01T04:00:02Z',
    ), { observedAt: '2020-01-01T00:00:00Z' }));
    await pool.query(`INSERT INTO chain_transaction_finality_replay_receipts (
      signature,observed_slot,confirmation_status,finality_evidence_version,
      immutable_fingerprint,replay_completed_at
    ) SELECT signature,observed_slot,target_confirmation_status,finality_evidence_version,
      immutable_fingerprint,processed_at FROM chain_transaction_inbox
      WHERE signature IN ('purge-finalized','purge-orphaned')`);
    await insertInbox(pool, inboxValue('pending-retry', {
      ...failedState(true), nextAttemptAt: '2099-01-01T00:00:00Z',
    }));
    await insertInbox(pool, inboxValue('leased', {
      ...processingState(), leaseExpiresAt: '2099-01-01T00:00:00Z',
    }));
    await insertInbox(pool, inboxValue(
      'processed-nonterminal', processedState('confirmed', snapshot, fingerprint, processed),
    ));
    await insertInbox(pool, inboxValue('unexpired-terminal', terminalState(
      'finalized', snapshot, fingerprint, '2099-01-01T00:00:01Z',
      '2099-01-01T00:00:02Z', '2099-01-01T04:00:02Z',
    ), { observedAt: '2099-01-01T00:00:00Z', createdAt: '2099-01-01T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z' }));

    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.websocketHealthEvidence, 0);
    assert.equal(purged.transactionInbox, 2);
    assert.deepEqual((await pool.query<{ readonly signature: string }>(
      'SELECT signature FROM chain_transaction_inbox ORDER BY signature',
    )).rows.map((row) => row.signature), [
      'leased', 'pending-retry', 'processed-nonterminal', 'unexpired-terminal',
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

type PgPool = InstanceType<typeof pg.Pool>;

interface InboxInsert {
  readonly signature: string;
  readonly observedSlot: string;
  readonly discoverySources: readonly (string | null)[];
  readonly programIds: readonly (string | null)[];
  readonly targetConfirmationStatus: string;
  readonly processingStatus: string;
  readonly attempts: number | null;
  readonly missingFinalityPolls: number | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly normalizedTransaction: unknown;
  readonly immutableFingerprint: string | null;
  readonly errorCode: string | null;
  readonly errorName: string | null;
  readonly errorRetryable: boolean | null;
  readonly blockchainTime: string | null;
  readonly observedAt: string;
  readonly processedAt: string | null;
  readonly terminalAt: string | null;
  readonly purgeAfter: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface InboxInsertCase {
  readonly name: string;
  readonly accept: boolean;
  readonly value: Partial<InboxInsert>;
}

interface SqlCase {
  readonly name: string;
  readonly accept: boolean;
  readonly text: string;
}

function inboxValue(
  signature: string,
  overrides: Partial<InboxInsert> = {},
  timestamps: Partial<InboxInsert> = {},
): InboxInsert {
  return {
    signature,
    observedSlot: '42',
    discoverySources: ['WEBSOCKET'],
    programIds: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
    targetConfirmationStatus: 'confirmed',
    processingStatus: 'PENDING',
    attempts: 0,
    missingFinalityPolls: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    normalizedTransaction: null,
    immutableFingerprint: null,
    errorCode: null,
    errorName: null,
    errorRetryable: null,
    blockchainTime: null,
    observedAt: '2025-01-01T00:00:00.000Z',
    processedAt: null,
    terminalAt: null,
    purgeAfter: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
    ...timestamps,
  };
}

function validProgramIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    new PublicKey(Uint8Array.from({ length: 32 }, () => index + 1)).toBase58()).sort();
}

function processingState(): Partial<InboxInsert> {
  return {
    processingStatus: 'PROCESSING',
    leaseToken: 'lease',
    leaseExpiresAt: '2025-01-01T00:01:00.000Z',
  };
}

function failureFields(retryable: boolean): Partial<InboxInsert> {
  return {
    errorCode: 'RPC_TRANSIENT',
    errorName: 'RpcTransientError',
    errorRetryable: retryable,
  };
}

function failedState(retryable: boolean): Partial<InboxInsert> {
  return retryable
    ? { processingStatus: 'FAILED', ...failureFields(true) }
    : {
      processingStatus: 'FAILED',
      ...failureFields(false),
      terminalAt: '2025-01-01T00:00:02.000Z',
      purgeAfter: '2025-01-01T04:00:02.000Z',
    };
}

function processedState(
  confirmationStatus: string,
  snapshot: unknown,
  fingerprint: string,
  processedAt: string,
): Partial<InboxInsert> {
  return {
    targetConfirmationStatus: confirmationStatus,
    processingStatus: 'PROCESSED',
    normalizedTransaction: snapshot,
    immutableFingerprint: fingerprint,
    processedAt,
  };
}

function terminalState(
  confirmationStatus: 'finalized' | 'orphaned',
  snapshot: unknown,
  fingerprint: string,
  processedAt: string,
  terminalAt: string,
  purgeAfter: string,
): Partial<InboxInsert> {
  return {
    ...processedState(confirmationStatus, snapshot, fingerprint, processedAt),
    terminalAt,
    purgeAfter,
  };
}

async function insertInbox(pool: PgPool, value: InboxInsert): Promise<void> {
  await pool.query(`INSERT INTO chain_transaction_inbox (
    signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
    processing_status, attempts, missing_finality_polls, lease_token, lease_expires_at,
    next_attempt_at, normalized_transaction, immutable_fingerprint, error_code, error_name,
    error_retryable, blockchain_time, observed_at, processed_at, terminal_at, purge_after,
    created_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
    $17, $18, $19, $20, $21, $22, $23
  )`, [
    value.signature, value.observedSlot, value.discoverySources, value.programIds,
    value.targetConfirmationStatus, value.processingStatus, value.attempts,
    value.missingFinalityPolls, value.leaseToken, value.leaseExpiresAt,
    value.nextAttemptAt,
    value.normalizedTransaction === null ? null : JSON.stringify(value.normalizedTransaction),
    value.immutableFingerprint,
    value.errorCode, value.errorName, value.errorRetryable, value.blockchainTime,
    value.observedAt, value.processedAt, value.terminalAt, value.purgeAfter,
    value.createdAt, value.updatedAt,
  ]);
}

async function applyMigrations(pool: PgPool, last: number): Promise<void> {
  for (let version = 1; version <= last; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const migrationNames = [
      '001_initial.sql',
      '002_pumpfun_foundation.sql',
      '003_pumpfun_observations.sql',
      '004_paper_trading.sql',
      '005_pumpswap_market.sql',
      '006_api_event_stream.sql',
      '007_participant_analytics.sql',
      '008_wallet_graph.sql',
    ];
    const name = migrationNames[version - 1];
    assert.ok(name?.startsWith(prefix));
    await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error('Unsafe SQL identifier.');
  return `"${identifier}"`;
}
