import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { LIVE_EXECUTION_MIGRATION_CATALOG } from '../src/execution-migrations/live-catalog.js';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '062_drop_dossier_and_legacy_tables.sql';

const droppedTables = [
  'discovered_pools', 'token_sessions', 'swap_events', 'trades', 'token_risk_reports',
  'listener_checkpoints', 'risk_settings', 'ignored_assets',
  'social_enrichment_jobs', 'social_evidence_collections', 'social_http_observations',
  'social_links', 'social_verification_evidence',
  'creator_profiles', 'token_holders_snapshots', 'observed_wallet_positions',
  'wallet_funding_observations', 'wallet_funding_evidence', 'wallet_graph_profiles',
  'wallet_graph_snapshots', 'wallet_relationships', 'wallet_clusters', 'wallet_cluster_members',
  'launch_trades',
  'paper_mvp_runs', 'paper_mvp_position_samples',
] as const;

const droppedFunctions = [
  'prevent_paper_mvp_sample_mutation()',
  'prevent_paper_mvp_run_immutable_mutation()',
] as const;

const keptTables = [
  'state_transitions', 'token_metadata_snapshots', 'domain_events', 'token_launches',
  'raw_chain_events', 'market_trades',
] as const;

void test('062 drops the 26 dossier, paper MVP and legacy tables', async (context) => {
  assert.equal(droppedTables.length, 26);
  assert.ok(LIVE_EXECUTION_MIGRATION_CATALOG.some((entry) => entry.name === migrationName));
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    assert.deepEqual(await migrateDatabase({ pool }), []);
    for (const table of droppedTables) {
      const row = (await pool.query<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS present', [table])).rows[0];
      assert.equal(row?.present, false, `table still present: ${table}`);
    }
    for (const signature of droppedFunctions) {
      const row = (await pool.query<{ present: boolean }>(
        'SELECT to_regprocedure($1) IS NOT NULL AS present', [signature])).rows[0];
      assert.equal(row?.present, false, `function still present: ${signature}`);
    }
    for (const table of keptTables) {
      const row = (await pool.query<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS present', [table])).rows[0];
      assert.equal(row?.present, true, `kept table missing: ${table}`);
    }
    // The dossier event types stay readable and streamable for historical rows.
    await pool.query(`INSERT INTO domain_events (
      event_id, type, mint, source, program, signature, slot,
      transaction_index, instruction_index, confirmation_status,
      observed_at, payload_version, payload
    ) VALUES (
      'holder-event', 'HolderDistributionUpdated', 'mint', 'pumpfun',
      'pump-program', 'signature', 1, 0, 0, 'processed', NOW(), 1, '{}'::jsonb
    )`);
    assert.equal((await pool.query(
      "SELECT 1 FROM api_event_stream WHERE domain_event_id = 'holder-event'",
    )).rowCount, 1);
  });
});

async function withTemporarySchema(
  context: TestContext,
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: drop dossier tables migration test skipped');
    return;
  }
  const schema = `drop_dossier_tables_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1,
  });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await run(pool);
  } finally {
    await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  }
}
