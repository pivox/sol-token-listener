import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  migrateDatabase,
  purgeExpiredFoundationData,
} from '../src/storage/database.js';
import { createTokenLaunchDetectedEvent } from '../src/domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import type { LaunchpadEventBatch } from '../src/ports/launchpad-event-sink.js';
import type { TokenMetadataSnapshot } from '../src/domain/pumpfun-observation.js';
import type { PublicHttpResult } from '../src/ports/public-http-client.js';
import { PublicSocialVerificationProvider } from '../src/social/public-social-verification.provider.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import { PostgresSocialEvidenceRepository } from '../src/storage/social-evidence.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

void test('creates replayable public social storage without raw content', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.includes('012_public_social_evidence.sql'), true);
    for (const table of [
      'social_enrichment_jobs',
      'social_evidence_collections',
      'social_http_observations',
      'social_links',
      'social_verification_evidence',
    ]) assert.equal(await relationExists(pool, table), true, table);

    const columns = await pool.query<{ readonly table_name: string; readonly column_name: string }>(`
      SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name LIKE 'social_%'
      ORDER BY table_name,column_name`);
    assert.equal(columns.rows.some(({ column_name: name }) =>
      /(?:^|_)(?:body|html|headers?|cookies?|ip_address|dns_answers?)(?:_|$)/iu.test(name)), false);

    const metadataColumns = await pool.query<{ readonly column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='token_metadata_snapshots'`);
    assert.equal(metadataColumns.rows.some((row) => row.column_name === 'source_launch_event_id'), true);
    assert.equal(metadataColumns.rows.some((row) => row.column_name === 'failure_retryable'), true);

    assert.deepEqual(await migrateDatabase({ pool }), []);
  });
});

void test('enforces four-hour terminal retention and checked social enums', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await migrateDatabase({ pool });
    const constraints = await pool.query<{ readonly definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE connamespace=current_schema()::regnamespace
        AND conrelid IN (
          'social_enrichment_jobs'::regclass,
          'social_evidence_collections'::regclass,
          'social_links'::regclass,
          'social_http_observations'::regclass,
          'social_verification_evidence'::regclass
        )`);
    const sql = constraints.rows.map((row) => row.definition).join('\n');
    assert.match(sql, /PENDING.*PROCESSING.*RETRYABLE_FAILED.*COMPLETED.*CANCELLED/su);
    assert.match(sql, /COMPLETE.*PARTIAL.*FAILED/su);
    assert.match(sql, /URL_SYNTAX_VALID.*VERIFICATION_UNKNOWN/su);
    assert.match(sql, /04:00:00|4 hours/iu);
  });
});

void test('purges a complete terminal social graph child-first at its own four-hour deadline', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await migrateDatabase({ pool });
    const terminalAtMs = Date.now() - 4 * 3_600_000;
    await insertTerminalSocialGraph(
      pool,
      'So11111111111111111111111111111111111111112',
      'signature-social-expired',
      terminalAtMs,
    );

    const purged = await purgeExpiredFoundationData(pool);

    assert.equal(purged.websocketHealthEvidence, 0);
    assert.deepEqual(await socialCounts(pool), {
      jobs: 0, collections: 0, links: 0, observations: 0, evidence: 0,
    });
    assert.equal(purged.socialJobs, 1);
    assert.equal(purged.socialCollections, 1);
    assert.equal(purged.socialLinks, 1);
    assert.equal(purged.socialObservations, 1);
    assert.equal(purged.socialEvidence, 3);
  });
});

void test('keeps every terminal social row before its own purge deadline', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await migrateDatabase({ pool });
    const terminalAtMs = Date.now() - 4 * 3_600_000 + 60_000;
    await insertTerminalSocialGraph(
      pool,
      '11111111111111111111111111111111',
      'signature-social-retained',
      terminalAtMs,
    );

    await purgeExpiredFoundationData(pool);

    assert.deepEqual(await socialCounts(pool), {
      jobs: 1, collections: 1, links: 1, observations: 1, evidence: 3,
    });
  });
});

void test('keeps social parent lineage until the fixed social deadline', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await migrateDatabase({ pool });
    const terminalAtMs = Date.now() - 2 * 3_600_000;
    await insertTerminalSocialGraph(
      pool,
      'So11111111111111111111111111111111111111112',
      'signature-social-short-parent-retention',
      terminalAtMs,
      1,
    );

    await purgeExpiredFoundationData(pool);

    assert.deepEqual(await socialCounts(pool), {
      jobs: 1, collections: 1, links: 1, observations: 1, evidence: 3,
    });
    const parents = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM token_launches) launches,
      (SELECT COUNT(*)::int FROM raw_chain_events) raw_events,
      (SELECT COUNT(*)::int FROM domain_events
        WHERE type='TokenLaunchDetected') launch_events,
      (SELECT COUNT(*)::int FROM token_metadata_snapshots) metadata_snapshots`);
    assert.deepEqual(parents.rows[0], {
      launches: 1, raw_events: 1, launch_events: 1, metadata_snapshots: 1,
    });
  });
});

async function relationExists(pool: InstanceType<typeof pg.Pool>, name: string): Promise<boolean> {
  const result = await pool.query<{ readonly exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [name],
  );
  return result.rows[0]?.exists === true;
}

async function insertTerminalSocialGraph(
  pool: InstanceType<typeof pg.Pool>,
  mint: string,
  signature: string,
  terminalAtMs: number,
  parentRetentionHours = 4,
): Promise<void> {
  const launchRepository = new PostgresLaunchpadEventRepository(
    pool,
    parentRetentionHours,
    () => terminalAtMs,
  );
  const processed = launchBatch(mint, signature, 'processed', terminalAtMs);
  await launchRepository.record(processed);
  const socialRepository = new PostgresSocialEvidenceRepository(pool);
  const claimed = await socialRepository.claim({ leaseMs: 5_000, nowMs: terminalAtMs });
  assert.ok(claimed);
  const metadataSnapshot: TokenMetadataSnapshot = Object.freeze({
    mint,
    uri: 'https://metadata.example/token.json',
    resolution: Object.freeze({
      status: 'RESOLVED' as const,
      metadata: Object.freeze({
        name: 'Project', symbol: 'P', description: 'Public project',
        imageUrl: null, videoUrl: null, websiteUrl: 'https://project.example/',
        twitterUrl: null, telegramUrl: null,
      }),
    }),
    fetchedAtMs: terminalAtMs,
    payloadVersion: 1,
  });
  const page: PublicHttpResult = Object.freeze({
    status: 'SUCCEEDED' as const,
    finalUrl: 'https://project.example/',
    httpStatus: 200,
    contentType: 'text/html',
    redirectCount: 0,
    body: new TextEncoder().encode(`<p>${mint}</p>`),
  });
  const collected = await new PublicSocialVerificationProvider({
    get: async () => page,
  }).collect(Object.freeze({
    mint,
    sourceLaunchEventId: claimed.sourceLaunchEventId,
    metadataSnapshot,
  }));
  await socialRepository.persist(claimed, Object.freeze({
    status: 'RESOLVED' as const,
    ...collected,
  }));
  await socialRepository.complete(claimed);
  await launchRepository.record(launchBatch(mint, signature, 'orphaned', terminalAtMs));
}

function launchBatch(
  mint: string,
  signature: string,
  confirmationStatus: 'processed' | 'orphaned',
  observedAtMs: number,
): LaunchpadEventBatch {
  const transaction = Object.freeze({
    signature,
    confirmationStatus,
    blockTimeMs: observedAtMs,
    observedAtMs,
    cursor: Object.freeze({ slot: 10n, transactionIndex: 0 }),
    raw: null,
  });
  const launch = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: 'pump',
    transaction,
    launch: Object.freeze({
      mint,
      creator: 'creator',
      tokenProgram: 'SPL_TOKEN' as const,
      quoteAssets: Object.freeze([Object.freeze({
        mint: 'quote', decimals: 9, tokenProgram: 'SPL_TOKEN' as const,
      })]),
      launchpad: 'pumpfun',
      createdAt: Object.freeze({
        slot: 10n, transactionIndex: 0, instructionIndex: 1,
        innerInstructionIndex: null,
      }),
      parameters: Object.freeze({ uri: 'https://metadata.example/token.json' }),
    }),
  });
  const common = Object.freeze({
    source: 'pumpfun', program: 'pump', signature, events: Object.freeze([launch]),
  });
  return confirmationStatus === 'orphaned'
    ? Object.freeze({
      ...common, confirmationStatus, stateTransitionAction: 'retract' as const,
      transitions: Object.freeze([] as const),
    })
    : Object.freeze({
      ...common, confirmationStatus, stateTransitionAction: 'apply' as const,
      transitions: Object.freeze([createInitialDetectedTransition(launch)]),
    });
}

async function socialCounts(pool: InstanceType<typeof pg.Pool>): Promise<Readonly<{
  jobs: number;
  collections: number;
  links: number;
  observations: number;
  evidence: number;
}>> {
  const result = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM social_enrichment_jobs) jobs,
    (SELECT COUNT(*)::int FROM social_evidence_collections) collections,
    (SELECT COUNT(*)::int FROM social_links) links,
    (SELECT COUNT(*)::int FROM social_http_observations) observations,
    (SELECT COUNT(*)::int FROM social_verification_evidence) evidence`);
  return result.rows[0] as Awaited<ReturnType<typeof socialCounts>>;
}

async function withSchema(run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `social_migration_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
