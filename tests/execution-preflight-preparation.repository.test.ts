import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { ClaimedExecutionPreflightPreparation } from '../src/domain/execution-preflight-preparation.js';
import { createExecutionPreflightPreparationIdentity } from '../src/domain/execution-preflight-preparation.js';
import {
  ExecutionPreflightPreparationPostgresRepository,
  ExecutionPreflightPreparationRepositoryError,
  type ExecutionPreflightPreparationPool,
} from '../src/storage/execution-preflight-preparation.repository.js';
import { migrateDatabase } from '../src/storage/database.js';

const NOW_MS = 1_789_000_000_000;
const DEADLINE_MS = NOW_MS + 45_000;
const LEASE_EXPIRES_AT_MS = NOW_MS + 30_000;
const LEASE_TOKEN = '00000000-0000-4000-8000-000000000001';
const IDENTITY = createExecutionPreflightPreparationIdentity(LEASE_TOKEN);
const RUN_ID = IDENTITY.runId;

void test('starts one database-watermarked preparation under a global selector fence', async () => {
  const client = new ScriptedClient([
    result([], null),
    result([], 1),
    result([], 0),
    result([claimRow()], 1),
    result([], null),
  ]);
  const repository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(client),
    () => LEASE_TOKEN,
  );

  const claim = await repository.startOrResume(Object.freeze({
    ownerId: 'h2j-test', selectionWindowMs: 45_000, leaseMs: 30_000,
  }));

  assert.equal(claim.preparation.state, 'WAITING');
  assert.equal(claim.preparation.watermarkAtMs, NOW_MS);
  assert.equal(claim.preparation.deadlineAtMs, DEADLINE_MS);
  assert.equal(claim.leaseExpiresAtMs, LEASE_EXPIRES_AT_MS);
  assert.equal(client.calls[0]?.text, 'BEGIN');
  assert.match(client.calls[1]?.text ?? '', /pg_advisory_xact_lock/u);
  assert.match(client.calls[2]?.text ?? '', /WHERE state IN \('WAITING','PREPARING'\)/u);
  assert.match(client.calls[3]?.text ?? '', /statement_timestamp\(\)/u);
  assert.deepEqual(
    client.calls[3]?.values?.slice(-4),
    [45_000, 'h2j-test', LEASE_TOKEN, 30_000],
  );
  assert.equal(client.calls[4]?.text, 'COMMIT');
});

void test('selects only the first exact post-watermark pair without SKIP LOCKED', async () => {
  const claim = preparationClaim();
  const client = new ScriptedClient([
    result([], null),
    result([{ ...claimRow(), operation_at_ms: String(NOW_MS) }], 1),
    result([pairRow()], 1),
    result([claimRow({ state: 'PREPARING', stateRevision: 1n, pairId: 'pair-1' })], 1),
    result([], null),
  ]);
  const repository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(client),
    () => LEASE_TOKEN,
  );

  const selected = await repository.selectFirstPair(claim);

  assert.equal(selected?.pairId, 'pair-1');
  assert.equal(selected?.targetIntentId, 'target-1');
  assert.equal(selected?.simulationIntentId, 'probe-1');
  const selectionSql = client.calls[2]?.text ?? '';
  assert.match(selectionSql, /pair\.created_at > preparation\.watermark_at/u);
  assert.match(selectionSql, /ORDER BY pair\.created_at,pair\.pair_id/u);
  assert.match(selectionSql, /LIMIT 1/u);
  assert.match(selectionSql, /FOR UPDATE OF pair,target,simulation/u);
  assert.doesNotMatch(selectionSql, /SKIP LOCKED/u);
  assert.match(client.calls[3]?.text ?? '', /WHERE preparation\.run_id=\$1/u);
});

void test('returns idle without selecting a replacement and rejects hostile options', async () => {
  const claim = preparationClaim();
  const client = new ScriptedClient([
    result([], null),
    result([{ ...claimRow(), operation_at_ms: String(NOW_MS) }], 1),
    result([], 0),
    result([], null),
  ]);
  const repository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(client),
    () => LEASE_TOKEN,
  );
  assert.equal(await repository.selectFirstPair(claim), null);
  assert.equal(client.calls.length, 4);

  const never = new NeverPool();
  const hostileRepository = new ExecutionPreflightPreparationPostgresRepository(
    never,
    () => LEASE_TOKEN,
  );
  await assert.rejects(
    hostileRepository.startOrResume({
      ownerId: 'h2j-test', selectionWindowMs: 45_000, leaseMs: 30_000,
    }),
    (error: unknown) => error instanceof ExecutionPreflightPreparationRepositoryError
      && error.code === 'INVALID_INPUT',
  );
  assert.equal(never.connections, 0);
});

void test('renews and fails only the exact preparation lease with monotone revisions', async () => {
  const waiting = preparationClaim();
  const renewedRow = claimRow();
  const renewedClient = new ScriptedClient([result([{
    ...renewedRow,
    state_revision: '1',
    updated_at_ms: String(NOW_MS + 1),
    lease_expires_at_ms: String(NOW_MS + 35_000),
  }], 1)]);
  const renewedRepository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(renewedClient),
    () => LEASE_TOKEN,
  );
  const renewed = await renewedRepository.renew(waiting, 20_000);
  assert.equal(renewed.preparation.stateRevision, 1n);
  assert.match(renewedClient.calls[0]?.text ?? '', /state_revision=preparation\.state_revision\+1/u);
  assert.deepEqual(renewedClient.calls[0]?.values?.slice(-1), [20_000]);

  const failedClient = new ScriptedClient([result([{
    ...preparationRow(),
    state: 'FAILED',
    state_revision: '1',
    failure_code: 'PREFLIGHT_RPC_CAPACITY_UNVERIFIED',
    completed_at_ms: String(NOW_MS + 1),
    purge_after_ms: String(NOW_MS + 1 + 14_400_000),
    updated_at_ms: String(NOW_MS + 1),
  }], 1)]);
  const failedRepository = new ExecutionPreflightPreparationPostgresRepository(
    new ScriptedPool(failedClient),
    () => LEASE_TOKEN,
  );
  const failed = await failedRepository.fail(waiting, 'PREFLIGHT_RPC_CAPACITY_UNVERIFIED');
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.failureCode, 'PREFLIGHT_RPC_CAPACITY_UNVERIFIED');
  assert.match(failedClient.calls[0]?.text ?? '', /lease_token=\$5::UUID/u);
});

void test('PostgreSQL selects and crash-resumes the same exact pair', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: preparation repository integration skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'preflight_preparation_repo', async (pool) => {
    await migrateDatabase({ pool });
    const firstFactory = uuidSequence([
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000011',
    ]);
    const repository = new ExecutionPreflightPreparationPostgresRepository(pool, firstFactory);
    const started = await repository.startOrResume(Object.freeze({
      ownerId: 'h2j-first', selectionWindowMs: 45_000, leaseMs: 30_000,
    }));

    await pool.query('SELECT pg_sleep(0.003)');
    await insertPairWithParents(pool, 'pair-after-watermark', 'target-after', 'probe-after');
    const selected = await repository.selectFirstPair(started);
    assert.equal(selected?.pairId, 'pair-after-watermark');
    assert.equal(selected?.preparation.preparation.state, 'PREPARING');

    const busyRepository = new ExecutionPreflightPreparationPostgresRepository(pool, uuidSequence([
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000013',
    ]));
    await assert.rejects(
      busyRepository.startOrResume(Object.freeze({
        ownerId: 'h2j-other', selectionWindowMs: 45_000, leaseMs: 30_000,
      })),
      (error: unknown) => error instanceof ExecutionPreflightPreparationRepositoryError
        && error.code === 'PREPARATION_BUSY',
    );

    await pool.query(`UPDATE execution_preflight_intent_preparation_runs
      SET lease_expires_at=date_trunc('milliseconds',statement_timestamp()),
        state_revision=state_revision+1
      WHERE run_id=$1`, [started.preparation.runId]);
    const resumed = await busyRepository.startOrResume(Object.freeze({
      ownerId: 'h2j-other', selectionWindowMs: 45_000, leaseMs: 20_000,
    }));
    assert.equal(resumed.preparation.runId, started.preparation.runId);
    assert.equal(resumed.preparation.pairId, 'pair-after-watermark');
    assert.equal(resumed.preparation.state, 'PREPARING');

    const recoveredSelection = await busyRepository.selectFirstPair(resumed);
    assert.equal(recoveredSelection?.pairId, 'pair-after-watermark');
    assert.equal(recoveredSelection?.targetIntentId, 'target-after');
    assert.equal(recoveredSelection?.simulationIntentId, 'probe-after');
  });
});

function preparationClaim(): ClaimedExecutionPreflightPreparation {
  return Object.freeze({
    preparation: Object.freeze({
      payloadVersion: 1,
      runId: RUN_ID,
      runFingerprint: IDENTITY.runFingerprint,
      state: 'WAITING',
      stateRevision: 0n,
      watermarkAtMs: NOW_MS,
      deadlineAtMs: DEADLINE_MS,
      pairId: null,
      assessmentId: null,
      assessmentFingerprint: null,
      artifactId: null,
      artifactFingerprint: null,
      manifestFingerprint: null,
      failureCode: null,
      createdAtMs: NOW_MS,
      updatedAtMs: NOW_MS,
      selectedAtMs: null,
      completedAtMs: null,
      purgeAfterMs: null,
    }),
    leaseOwner: 'h2j-test',
    leaseToken: LEASE_TOKEN,
    leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
  });
}

function claimRow(overrides: Readonly<{
  state?: 'WAITING' | 'PREPARING';
  stateRevision?: bigint;
  pairId?: string | null;
}> = {}): Readonly<Record<string, unknown>> {
  return {
    run_id: RUN_ID,
    payload_version: 1,
    run_fingerprint: IDENTITY.runFingerprint,
    state: overrides.state ?? 'WAITING',
    state_revision: String(overrides.stateRevision ?? 0n),
    watermark_at_ms: String(NOW_MS),
    deadline_at_ms: String(DEADLINE_MS),
    pair_id: overrides.pairId ?? null,
    assessment_id: null,
    assessment_fingerprint: null,
    artifact_id: null,
    artifact_fingerprint: null,
    manifest_fingerprint: null,
    failure_code: null,
    created_at_ms: String(NOW_MS),
    updated_at_ms: String(NOW_MS),
    selected_at_ms: overrides.state === 'PREPARING' ? String(NOW_MS + 1) : null,
    completed_at_ms: null,
    purge_after_ms: null,
    lease_owner: 'h2j-test',
    lease_token: LEASE_TOKEN,
    lease_expires_at_ms: String(LEASE_EXPIRES_AT_MS),
  };
}

function pairRow(): Readonly<Record<string, unknown>> {
  return {
    pair_id: 'pair-1',
    pair_fingerprint: 'b'.repeat(64),
    target_intent_id: 'target-1',
    simulation_intent_id: 'probe-1',
    decision_event_id: 'decision-1',
    decision_fingerprint: 'c'.repeat(64),
    pair_created_at_ms: String(NOW_MS + 1),
    pair_expires_at_ms: String(DEADLINE_MS + 15_000),
  };
}

function preparationRow(): Readonly<Record<string, unknown>> {
  const row = { ...claimRow() };
  delete row.lease_owner;
  delete row.lease_token;
  delete row.lease_expires_at_ms;
  return row;
}

interface QueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}

interface Call { readonly text: string; readonly values?: readonly unknown[] }

class ScriptedClient {
  public readonly calls: Call[] = [];
  public constructor(private readonly results: readonly QueryResult[]) {}
  public async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.calls.push(values === undefined ? { text } : { text, values });
    const next = this.results[this.calls.length - 1];
    if (next === undefined) throw new Error('Unexpected query.');
    return next;
  }
  public release(): void {}
}

class ScriptedPool implements ExecutionPreflightPreparationPool {
  public constructor(private readonly client: ScriptedClient) {}
  public async connect(): Promise<ScriptedClient> { return this.client; }
}

class NeverPool implements ExecutionPreflightPreparationPool {
  public connections = 0;
  public async connect(): Promise<never> {
    this.connections += 1;
    throw new Error('must not connect');
  }
}

function result(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount: number | null,
): QueryResult {
  return { rows, rowCount };
}

interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<Readonly<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number | null;
  }>>;
}

async function insertPairWithParents(
  pool: InstanceType<typeof pg.Pool>,
  pairId: string,
  targetId: string,
  simulationId: string,
): Promise<void> {
  const client = await pool.connect();
  const requestedAtMs = Date.now();
  const expiresAtMs = requestedAtMs + 60_000;
  try {
    await client.query('BEGIN');
    await insertIntent(client, targetId, 'TARGET', requestedAtMs, expiresAtMs);
    await insertIntent(client, simulationId, 'SIMULATION', requestedAtMs, expiresAtMs);
    await client.query(`INSERT INTO execution_preflight_intent_pairs (
      pair_id,payload_version,pair_fingerprint,target_intent_id,simulation_intent_id,
      decision_event_id,decision_fingerprint,expires_at
    ) VALUES ($1,1,$2,$3,$4,'decision-event',repeat('d',64),
      TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond'))`, [
      pairId,
      createHash('sha256').update(pairId).digest('hex'),
      targetId,
      simulationId,
      expiresAtMs,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve primary failure */ }
    throw error;
  } finally {
    client.release();
  }
}

async function insertIntent(
  client: Queryable,
  id: string,
  lane: 'TARGET' | 'SIMULATION',
  requestedAtMs: number,
  expiresAtMs: number,
): Promise<void> {
  const suffix = createHash('sha256').update(id).digest('hex');
  const command = lane === 'TARGET'
    ? `paper_open_${suffix}`
    : `execution_preflight_probe_${suffix}`;
  await client.query(`INSERT INTO execution_intents (
    id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
    logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
    quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,
    decision_event_id,decision_fingerprint,requested_at,expires_at,status
  ) VALUES ($1,1,$2,'creation-entry-v1',1,'position',$2,
    '11111111111111111111111111111111','BUY','PUMP_FUN_ONLY',
    'So11111111111111111111111111111111111111112','SPL_TOKEN',9,500000,NULL,1,
    'decision-event',repeat('d',64),
    TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($4::BIGINT*INTERVAL '1 millisecond'),'PENDING')`, [
    id, command, requestedAtMs, expiresAtMs,
  ]);
}

function uuidSequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) return randomUUID();
    return value;
  };
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try {
      await pool.end();
    } finally {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}
