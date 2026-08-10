import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createTokenLaunchDetectedEvent } from '../src/domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import { PostgresSocialEvidenceRepository } from '../src/storage/social-evidence.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const NOW = 1_786_300_000_000;

void test('claims one durable job exclusively and renews only its active lease', async (context) => {
  await withDatabase(context, async (pool) => {
    await enqueue(pool, 'mint-social-a', 'signature-social-a');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    assert.equal(claimed.mint, 'mint-social-a');
    assert.equal(claimed.metadataUri, 'https://metadata.example/token.json');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.attemptsInCycle, 1);
    assert.equal(claimed.leaseExpiresAtMs, NOW + 5_000);
    assert.equal(await repository.claim({ leaseMs: 5_000, nowMs: NOW }), null);
    assert.equal(await repository.renew(claimed.id, 'wrong-token', 5_000, NOW + 1), false);
    assert.equal(await repository.renew(claimed.id, claimed.leaseToken, 6_000, NOW + 1), true);
    const stored = await pool.query(`SELECT status,attempts,attempts_in_cycle,
      (EXTRACT(EPOCH FROM lease_expires_at)*1000)::bigint::text lease_ms
      FROM social_enrichment_jobs`);
    assert.deepEqual(stored.rows[0], {
      status: 'PROCESSING', attempts: 1, attempts_in_cycle: 1,
      lease_ms: String(NOW + 1 + 6_000),
    });
  });
});

void test('schedules bounded retry and reports durable queue counts', async (context) => {
  await withDatabase(context, async (pool) => {
    await enqueue(pool, 'mint-social-b', 'signature-social-b');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    await repository.fail(claimed, Object.freeze({
      code: 'HTTP_TRANSIENT', retryable: true, observedAtMs: NOW + 10,
    }));
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, retryableFailed: 1, exhausted: 0,
    });
    assert.equal(await repository.claim({ leaseMs: 5_000, nowMs: NOW + 499 }), null);
    const retry = await repository.claim({ leaseMs: 5_000, nowMs: NOW + 510 });
    assert.ok(retry);
    assert.equal(retry.attempts, 2);
    assert.equal(retry.attemptsInCycle, 2);
  });
});

void test('terminalizes permanent failures with exact four-hour retention', async (context) => {
  await withDatabase(context, async (pool) => {
    await enqueue(pool, 'mint-social-c', 'signature-social-c');
    const repository = new PostgresSocialEvidenceRepository(pool);
    const claimed = await repository.claim({ leaseMs: 5_000, nowMs: NOW });
    assert.ok(claimed);
    await repository.fail(claimed, Object.freeze({
      code: 'PROVIDER_UNAVAILABLE', retryable: false, observedAtMs: NOW + 20,
    }));
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, retryableFailed: 0, exhausted: 0,
    });
    const row = await pool.query(`SELECT status,error_code,
      EXTRACT(EPOCH FROM (purge_after-terminal_at))::int retention_seconds
      FROM social_enrichment_jobs`);
    assert.deepEqual(row.rows[0], {
      status: 'CANCELLED', error_code: 'PROVIDER_UNAVAILABLE', retention_seconds: 14_400,
    });
  });
});

async function enqueue(
  pool: InstanceType<typeof pg.Pool>,
  mint: string,
  signature: string,
): Promise<void> {
  const transaction = Object.freeze({
    signature,
    confirmationStatus: 'confirmed' as const,
    blockTimeMs: 1_000,
    observedAtMs: NOW,
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
        slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null,
      }),
      parameters: Object.freeze({ uri: 'https://metadata.example/token.json' }),
    }),
  });
  await new PostgresLaunchpadEventRepository(pool).record(Object.freeze({
    source: 'pumpfun',
    program: 'pump',
    signature,
    confirmationStatus: 'confirmed' as const,
    stateTransitionAction: 'apply' as const,
    events: Object.freeze([launch]),
    transitions: Object.freeze([createInitialDetectedTransition(launch)]),
  }));
}

async function withDatabase(
  context: { skip(message?: string): void },
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `social_repository_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await migrateDatabase({ pool });
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
