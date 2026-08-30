import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;

interface ParentState {
  readonly status: string;
  readonly attempt_count: number;
  readonly state_revision: string;
  readonly updated_at: string;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: string | null;
}

void test('compiled executor records once, remains non-consuming and exits cleanly on SIGTERM', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL absent: compiled executor integration skipped');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `executor_main_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  context.after(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  });
  const schemaPool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  context.after(async () => { await schemaPool.end(); });
  await migrateDatabase({ pool: schemaPool });

  const now = Date.now();
  const created = await new PostgresExecutionIntentRepository(schemaPool).create(
    createExecutionIntentDraft({
      strategyId: 'executor-main-integration', strategyVersion: 1,
      positionId: 'position-1', logicalCommandId: 'command-1',
      mint: '11111111111111111111111111111111', side: 'BUY',
      venuePolicy: 'PUMP_FUN_ONLY',
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
      quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
      decisionEventId: 'event-1', decisionFingerprint: 'a'.repeat(64),
      requestedAtMs: now, expiresAtMs: now + 60_000,
    }),
  );
  const before = await parentState(schemaPool, created.intent.id);
  const executorUrl = databaseUrlForSchema(databaseUrl, schema);

  const first = startExecutor(executorUrl);
  await waitForAssessment(schemaPool, created.intent.id, 1, first);
  first.kill('SIGTERM');
  assert.equal(await exitCode(first), 0, childOutput(first));

  assert.equal(await assessmentCount(schemaPool, created.intent.id), 1);
  const after = await parentState(schemaPool, created.intent.id);
  assert.deepEqual(after, {
    ...before,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
  });
  assert.equal(after.status, 'PENDING');
  assert.equal(after.attempt_count, 0);
  assert.equal((await schemaPool.query(
    'SELECT COUNT(*)::INTEGER AS count FROM execution_attempts WHERE intent_id=$1',
    [created.intent.id],
  )).rows[0]?.count, 0);
  assert.equal((await schemaPool.query(
    'SELECT COUNT(*)::INTEGER AS count FROM execution_intent_transitions WHERE intent_id=$1',
    [created.intent.id],
  )).rows[0]?.count, 0);

  const second = startExecutor(executorUrl);
  await delay(350);
  assert.equal(await assessmentCount(schemaPool, created.intent.id), 1);
  second.kill('SIGTERM');
  assert.equal(await exitCode(second), 0, childOutput(second));
  assert.equal(await assessmentCount(schemaPool, created.intent.id), 1);
});

function startExecutor(url: string): ChildProcess & Readonly<{ captured: string[] }> {
  const child = spawn(process.execPath, [resolve(repositoryRoot, 'dist/src/executor/main.js')], {
    cwd: repositoryRoot,
    env: {
      DATABASE_URL: url,
      EXECUTOR_MODE: 'dry-run',
      LIVE_TRADING_ENABLED: 'false',
      EXECUTOR_POLL_MS: '100',
      EXECUTOR_LEASE_MS: '3000',
      EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '100',
      EXECUTOR_SHUTDOWN_GRACE_MS: '1100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const captured: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => { captured.push(chunk.toString('utf8')); });
  child.stderr?.on('data', (chunk: Buffer) => { captured.push(chunk.toString('utf8')); });
  return Object.assign(child, { captured });
}

async function waitForAssessment(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
  expected: number,
  child: ChildProcess & Partial<{ captured: string[] }>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await assessmentCount(pool, intentId) === expected) return;
    if (child.exitCode !== null) {
      assert.fail(`executor exited before assessment with code ${child.exitCode}: ${childOutput(child)}`);
    }
    await delay(25);
  }
  assert.fail(`executor assessment deadline exceeded for ${intentId}`);
}

async function assessmentCount(pool: InstanceType<typeof pg.Pool>, intentId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT COUNT(*)::INTEGER AS count FROM execution_dry_run_assessments WHERE intent_id=$1',
    [intentId],
  );
  return result.rows[0]?.count ?? -1;
}

async function parentState(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
): Promise<ParentState> {
  const result = await pool.query(
    `SELECT status,attempt_count,state_revision::TEXT AS state_revision,
      updated_at::TEXT AS updated_at,lease_owner,lease_token::TEXT AS lease_token,
      lease_expires_at::TEXT AS lease_expires_at
     FROM execution_intents WHERE id=$1`,
    [intentId],
  );
  assert.equal(result.rowCount, 1);
  const row = result.rows[0];
  assert.ok(row !== undefined);
  return row as ParentState;
}

async function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  return code;
}

function childOutput(child: ChildProcess & Partial<{ captured: string[] }>): string {
  return child.captured?.join('') ?? '';
}

function databaseUrlForSchema(value: string, schema: string): string {
  const url = new URL(value);
  url.searchParams.set('options', `-c search_path=${quoteIdentifier(schema)}`);
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function delay(durationMs: number): Promise<void> {
  await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, durationMs); });
}
