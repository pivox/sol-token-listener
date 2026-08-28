import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrationName = '027_listener_provider_affine_finality.sql';
const paperFinalityMigrationName = '028_paper_finality_replay_evidence.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const programId = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

void test('backfills and constrains provider-affine finality evidence replay-safely', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: provider-affine finality migration test skipped');
    return;
  }
  const schema = `provider_affine_finality_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const legacyNames = (await readdir(migrationsDirectory))
      .filter((name) => /^(?:00[1-9]|01[0-9]|02[0-6])_[a-z0-9_-]+\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right));
    assert.equal(legacyNames.at(-1), '026_listener_strict_catch_up_failures.sql');
    for (const name of legacyNames) await pool.query(await readFile(new URL(name, migrationsDirectory), 'utf8'));
    for (const version of legacyNames) {
      await pool.query(
        'INSERT INTO migration_history(version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [version],
      );
    }
    await insertLegacyInbox(pool, 'legacy-positive', 3);

    const sql = await readFile(migrationUrl, 'utf8');
    assert.deepEqual(await migrateDatabase({ pool }), [migrationName, paperFinalityMigrationName]);
    assert.match(
      await finalityIndexDefinition(pool),
      /\(updated_at, observed_slot, signature\).*processing_status.*PROCESSED.*target_confirmation_status/iu,
    );
    assert.deepEqual((await pool.query(`SELECT missing_finality_polls,
      last_missing_finality_provider_id, finality_evidence_version::TEXT AS finality_evidence_version
      FROM chain_transaction_inbox WHERE signature = 'legacy-positive'`)).rows, [{
      missing_finality_polls: 0,
      last_missing_finality_provider_id: null,
      finality_evidence_version: '0',
    }]);

    for (const providerId of ['primary', 'fallback-1', 'fallback-2', 'fallback-3']) {
      await insertInbox(pool, `valid-${providerId}`, 1, providerId);
    }
    await assert.rejects(insertInbox(pool, 'zero-provider', 0, 'primary'));
    await assert.rejects(insertInbox(pool, 'positive-null', 1, null));
    await assert.rejects(insertInbox(pool, 'invalid-provider', 1, 'fallback-4'));
    await assert.rejects(pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, missing_finality_polls, last_missing_finality_provider_id,
      finality_evidence_version, observed_at
    ) VALUES (
      'negative-version', 1, ARRAY['WEBSOCKET'], ARRAY[$1], 'confirmed', 'PENDING',
      1, 'primary', -1, NOW()
    )`, [programId]));

    await pool.query(sql);
    assert.match(
      await finalityIndexDefinition(pool),
      /\(updated_at, observed_slot, signature\).*processing_status.*PROCESSED.*target_confirmation_status/iu,
    );
    assert.deepEqual((await pool.query(`SELECT missing_finality_polls,
      last_missing_finality_provider_id,
      finality_evidence_version::TEXT AS finality_evidence_version
      FROM chain_transaction_inbox WHERE signature LIKE 'valid-%'
      ORDER BY signature`)).rows, [
      {
        missing_finality_polls: 1,
        last_missing_finality_provider_id: 'fallback-1',
        finality_evidence_version: '0',
      },
      {
        missing_finality_polls: 1,
        last_missing_finality_provider_id: 'fallback-2',
        finality_evidence_version: '0',
      },
      {
        missing_finality_polls: 1,
        last_missing_finality_provider_id: 'fallback-3',
        finality_evidence_version: '0',
      },
      {
        missing_finality_polls: 1,
        last_missing_finality_provider_id: 'primary',
        finality_evidence_version: '0',
      },
    ]);
    assert.deepEqual(await migrateDatabase({ pool }), []);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

async function finalityIndexDefinition(
  pool: InstanceType<typeof pg.Pool>,
): Promise<string> {
  const result = await pool.query(`SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = CURRENT_SCHEMA()
      AND indexname = 'chain_transaction_inbox_finality_idx'`);
  assert.equal(result.rows.length, 1);
  const definition: unknown = result.rows[0]?.indexdef;
  assert.equal(typeof definition, 'string');
  return definition as string;
}

async function insertInbox(
  pool: InstanceType<typeof pg.Pool>,
  signature: string,
  missingFinalityPolls: number,
  providerId: string | null,
): Promise<void> {
  await pool.query(`INSERT INTO chain_transaction_inbox (
    signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
    processing_status, missing_finality_polls, last_missing_finality_provider_id, observed_at
  ) VALUES ($1, 1, ARRAY['WEBSOCKET'], ARRAY[$2], 'confirmed', 'PENDING', $3, $4, NOW())`, [
    signature,
    programId,
    missingFinalityPolls,
    providerId,
  ]);
}

async function insertLegacyInbox(
  pool: InstanceType<typeof pg.Pool>,
  signature: string,
  missingFinalityPolls: number,
): Promise<void> {
  await pool.query(`INSERT INTO chain_transaction_inbox (
    signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
    processing_status, missing_finality_polls, observed_at
  ) VALUES ($1, 1, ARRAY['WEBSOCKET'], ARRAY[$2], 'confirmed', 'PENDING', $3, NOW())`, [
    signature,
    programId,
    missingFinalityPolls,
  ]);
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error('Unsafe SQL identifier.');
  return `"${identifier}"`;
}
