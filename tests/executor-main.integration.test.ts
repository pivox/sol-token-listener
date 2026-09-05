import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  EXECUTOR_INTEGRATION_GENESIS,
  EXECUTOR_INTEGRATION_MINT,
  EXECUTOR_INTEGRATION_PAYER,
  startScriptedPumpFunBuyRpc,
} from './helpers/executor-simulation-rpc.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const provisioningScriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);
const databaseUrl = process.env.TEST_DATABASE_URL;
const CHILD_TERM_TIMEOUT_MS = 2_500;
const CHILD_KILL_TIMEOUT_MS = 1_000;

type TrackedChild = ChildProcess & Readonly<{ captured: string[] }>;
type ChildExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;

const childCleanups = new WeakMap<ChildProcess, Promise<ChildExit>>();

interface ParentState {
  readonly status: string;
  readonly attempt_count: number;
  readonly state_revision: string;
  readonly updated_at: string;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: string | null;
}

interface SimulationState {
  readonly status: string;
  readonly attempt_count: number;
  readonly result_kind: string;
  readonly effective_venue: string;
  readonly quote_status: string;
  readonly build_status: string;
  readonly simulation_status: string;
  readonly failure_code: string | null;
  readonly terminal_reason_code: string;
  readonly message_hash: string | null;
  readonly transaction_columns: number;
}

void test('compiled executor records once, remains non-consuming and exits cleanly on SIGTERM', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL absent: compiled executor integration skipped');
    return;
  }
  const children = new Set<TrackedChild>();
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const databaseRole = await currentDatabaseRole(admin);
  const schema = `executor_main_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  context.after(async () => {
    await Promise.all([...children].map(stopExecutorChild));
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  });
  const schemaPool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  context.after(async () => {
    await Promise.all([...children].map(stopExecutorChild));
    await schemaPool.end();
  });
  await migrateDatabase({ pool: schemaPool });

  const repository = new PostgresExecutionIntentRepository(schemaPool);
  const created = await createIntent(repository, 'first');
  const before = await parentState(schemaPool, created.intent.id);
  const applicationName = `executor-idle-${randomUUID()}`;
  const executorUrl = databaseUrlForSchema(databaseUrl, schema, applicationName, databaseRole);

  const first = startExecutor(context, children, executorUrl);
  await waitForAssessment(schemaPool, created.intent.id, 1, first);
  const idlePid = await waitForIdleBackend(admin, applicationName, first);
  const terminated = await admin.query<{ terminated: boolean }>(
    'SELECT pg_terminate_backend($1) AS terminated',
    [idlePid],
  );
  assert.equal(terminated.rows[0]?.terminated, true);
  const continued = await createIntent(repository, 'continued');
  await waitForAssessment(schemaPool, continued.intent.id, 1, first);
  assert.equal(first.exitCode, null, childOutput(first));
  assert.deepEqual(await stopExecutorChild(first), { code: 0, signal: null }, childOutput(first));
  assertChildOutputRedacted(childOutput(first), executorUrl, databaseUrl, schema);

  assert.equal(await assessmentCount(schemaPool, created.intent.id), 1);
  assert.equal(await assessmentCount(schemaPool, continued.intent.id), 1);
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

  const second = startExecutor(context, children, executorUrl);
  await waitForIdleBackend(admin, applicationName, second);
  assert.equal(await assessmentCount(schemaPool, created.intent.id), 1);
  assert.deepEqual(await stopExecutorChild(second), { code: 0, signal: null }, childOutput(second));
  assert.equal(await assessmentCount(schemaPool, created.intent.id), 1);
});

void test('compiled simulation-only executor records one unsigned Pump.fun BUY without submission', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL absent: compiled simulation-only integration skipped');
    return;
  }
  const children = new Set<TrackedChild>();
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const databaseRole = await currentDatabaseRole(admin);
  const schema = `executor_simulation_main_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const schemaPool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  const rpc = await startScriptedPumpFunBuyRpc();
  context.after(async () => {
    await Promise.all([...children].map(stopExecutorChild));
    await rpc.close();
    await schemaPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  });
  await migrateDatabase({ pool: schemaPool });

  const repository = new PostgresExecutionIntentRepository(schemaPool);
  const created = await createSimulationIntent(repository);
  const executorUrl = databaseUrlForSchema(
    databaseUrl,
    schema,
    `executor-simulation-${randomUUID()}`,
    databaseRole,
  );
  const child = startSimulationExecutor(context, children, executorUrl, rpc.url);
  await waitForSimulationArtifact(schemaPool, created.intent.id, child);

  assert.deepEqual(await stopExecutorChild(child), { code: 0, signal: null }, childOutput(child));
  assert.deepEqual(rpc.requestErrors, []);
  assert.deepEqual(rpc.methods, [
    'getGenesisHash',
    'getMultipleAccounts',
    'getMultipleAccounts',
    'getLatestBlockhash',
    'getFeeForMessage',
    'simulateTransaction',
  ]);
  assert.equal(rpc.methods.includes('sendTransaction'), false);
  assert.equal(rpc.methods.includes('sendRawTransaction'), false);
  assert.equal(rpc.simulatedTransactionWasUnsigned(), true);
  assert.deepEqual(await simulationState(schemaPool, created.intent.id), {
    status: 'SUCCEEDED',
    attempt_count: 1,
    result_kind: 'SUCCESS',
    effective_venue: 'PUMP_FUN',
    quote_status: 'SUCCEEDED',
    build_status: 'SUCCEEDED',
    simulation_status: 'SUCCEEDED',
    failure_code: null,
    terminal_reason_code: 'INTENT_SUCCEEDED',
    message_hash: await simulationMessageHash(schemaPool, created.intent.id),
    transaction_columns: 0,
  });
  assert.match(await simulationMessageHash(schemaPool, created.intent.id), /^[0-9a-f]{64}$/u);
  assert.equal(await simulationArtifactCount(schemaPool, created.intent.id), 1);
  assert.equal(await simulationTransitionCount(schemaPool, created.intent.id), 3);
  assertSimulationChildOutputRedacted(
    childOutput(child), executorUrl, databaseUrl, schema, rpc.url, rpc.privateMarker,
    created.intent.id,
  );
});

void test('compiled non-signing executors run under the isolated worker login', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL absent: worker login integration skipped');
    return;
  }
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const capability = (await maintenance.query<{
    readonly rolsuper: boolean;
    readonly rolcreatedb: boolean;
    readonly server_version_number: number;
  }>(`SELECT rolsuper,rolcreatedb,
      current_setting('server_version_num')::INTEGER AS server_version_number
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (!capability?.rolsuper || !capability.rolcreatedb
    || capability.server_version_number < 160_000
    || capability.server_version_number >= 170_000) {
    await maintenance.end();
    context.skip('PostgreSQL 16 superuser with CREATEDB is required.');
    return;
  }
  const releaseRoleLock = await acquireExecutorRoleTestLock(maintenance);
  const suffix = randomUUID().replaceAll('-', '');
  const databaseName = `executor_worker_main_${suffix}`;
  const loginName = `executor_worker_login_${suffix}`;
  const password = randomUUID().replaceAll('-', '');
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  isolatedUrl.searchParams.delete('options');
  const children = new Set<TrackedChild>();
  let isolated: InstanceType<typeof pg.Pool> | undefined;
  let loginPool: InstanceType<typeof pg.Pool> | undefined;
  let databaseCreated = false;
  let loginCreated = false;
  try {
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);
    databaseCreated = true;
    isolated = new pg.Pool({ connectionString: isolatedUrl.href });
    await migrateDatabase({ pool: isolated });
    assert.equal((await isolated.query<{ readonly schema_name: string }>(
      'SELECT current_schema() AS schema_name',
    )).rows[0]?.schema_name, 'public');
    const provisioningSql = await readFile(provisioningScriptUrl, 'utf8');
    await isolated.query(provisioningSql);
    await maintenance.query(`CREATE ROLE ${quoteIdentifier(loginName)} LOGIN NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD ${quoteLiteral(password)}`);
    loginCreated = true;
    await maintenance.query(`GRANT sol_token_executor_worker TO ${quoteIdentifier(loginName)}
      WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
    assert.deepEqual((await maintenance.query<{
      readonly membership_count: string;
      readonly login_inherit: boolean;
    }>(`SELECT
        (SELECT COUNT(*)::TEXT FROM pg_auth_members membership
          JOIN pg_roles member ON member.oid=membership.member
          WHERE member.rolname=$1) AS membership_count,
        (SELECT rolinherit FROM pg_roles WHERE rolname=$1) AS login_inherit`,
    [loginName])).rows, [{ membership_count: '1', login_inherit: false }]);
    const workerUrl = new URL(isolatedUrl);
    workerUrl.username = loginName;
    workerUrl.password = password;
    workerUrl.searchParams.set(
      'options',
      '-c role=sol_token_executor_worker -c search_path=pg_catalog,public',
    );
    loginPool = new pg.Pool({ connectionString: workerUrl.href, max: 1 });
    assert.deepEqual((await loginPool.query(
      `SELECT session_user,current_user,current_setting('search_path') AS search_path`,
    )).rows, [{
      session_user: loginName,
      current_user: 'sol_token_executor_worker',
      search_path: 'pg_catalog,public',
    }]);

    const repository = new PostgresExecutionIntentRepository(isolated);
    const dryRunIntent = await createIntent(repository, `worker-${suffix}`);
    const dryRun = startExecutor(context, children, workerUrl.href);
    await waitForAssessment(isolated, dryRunIntent.intent.id, 1, dryRun);
    assert.deepEqual(
      await stopExecutorChild(dryRun),
      { code: 0, signal: null },
      childOutput(dryRun),
    );

    const rpc = await startScriptedPumpFunBuyRpc();
    try {
      const simulationIntent = await createSimulationIntent(repository);
      const simulation = startSimulationExecutor(
        context, children, workerUrl.href, rpc.url,
      );
      await waitForSimulationArtifact(isolated, simulationIntent.intent.id, simulation);
      assert.deepEqual(
        await stopExecutorChild(simulation),
        { code: 0, signal: null },
        childOutput(simulation),
      );
      assert.equal(await simulationArtifactCount(isolated, simulationIntent.intent.id), 1);
      assert.deepEqual(rpc.requestErrors, []);
      assert.equal(rpc.methods.includes('sendTransaction'), false);
      assert.equal(rpc.methods.includes('sendRawTransaction'), false);
      assert.equal(rpc.simulatedTransactionWasUnsigned(), true);
    } finally {
      await rpc.close();
    }
  } finally {
    await Promise.all([...children].map(stopExecutorChild));
    if (loginPool !== undefined) await loginPool.end();
    if (isolated !== undefined) await isolated.end();
    if (databaseCreated) {
      await maintenance.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=$1 AND pid<>pg_backend_pid()`, [databaseName]);
      await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    }
    if (loginCreated) await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(loginName)}`);
    try { await releaseRoleLock(); } finally { await maintenance.end(); }
  }
});

function startExecutor(
  context: TestContext,
  children: Set<TrackedChild>,
  url: string,
): TrackedChild {
  const child = Object.assign(
    spawn(process.execPath, [resolve(repositoryRoot, 'dist/src/executor/main.js')], {
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
    }),
    { captured: [] as string[] },
  );
  children.add(child);
  context.after(() => stopExecutorChild(child));
  const { captured } = child;
  child.stdout?.on('data', (chunk: Buffer) => { captured.push(chunk.toString('utf8')); });
  child.stderr?.on('data', (chunk: Buffer) => { captured.push(chunk.toString('utf8')); });
  return child;
}

function startSimulationExecutor(
  context: TestContext,
  children: Set<TrackedChild>,
  database: string,
  rpcUrl: string,
): TrackedChild {
  const child = Object.assign(
    spawn(process.execPath, [resolve(repositoryRoot, 'dist/src/executor/main.js')], {
      cwd: repositoryRoot,
      env: {
        DATABASE_URL: database,
        EXECUTOR_MODE: 'simulation-only',
        LIVE_TRADING_ENABLED: 'false',
        EXECUTOR_PUBLIC_KEY: EXECUTOR_INTEGRATION_PAYER,
        EXECUTOR_RPC_PROVIDER_ID: 'integration-provider',
        SOLANA_HTTP_RPC_URL: rpcUrl,
        SOLANA_EXPECTED_GENESIS_HASH: EXECUTOR_INTEGRATION_GENESIS,
        LIVE_QUOTE_MINT_ALLOWLIST: 'So11111111111111111111111111111111111111112',
        EXECUTOR_QUOTE_MAX_AGE_MS: '60000',
        EXECUTOR_SLIPPAGE_BPS: '500',
        EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '8',
        EXECUTOR_MAX_COMPUTE_UNITS: '300000',
        EXECUTOR_MAX_FEE_LAMPORTS: '100000',
        EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '5000000',
        EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS: '0',
        EXECUTOR_RPC_TIMEOUT_MS: '2000',
        EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '8',
        EXECUTOR_POLL_MS: '100',
        EXECUTOR_LEASE_MS: '30000',
        EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '100',
        EXECUTOR_SHUTDOWN_GRACE_MS: '1100',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    { captured: [] as string[] },
  );
  children.add(child);
  context.after(() => stopExecutorChild(child));
  child.stdout?.on('data', (chunk: Buffer) => { child.captured.push(chunk.toString('utf8')); });
  child.stderr?.on('data', (chunk: Buffer) => { child.captured.push(chunk.toString('utf8')); });
  return child;
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
  assert.fail(`executor assessment deadline exceeded for ${intentId}: ${childOutput(child)}`);
}

async function assessmentCount(pool: InstanceType<typeof pg.Pool>, intentId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT COUNT(*)::INTEGER AS count FROM execution_dry_run_assessments WHERE intent_id=$1',
    [intentId],
  );
  return result.rows[0]?.count ?? -1;
}

async function waitForSimulationArtifact(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
  child: ChildProcess & Partial<{ captured: string[] }>,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await simulationArtifactCount(pool, intentId) === 1) return;
    if (child.exitCode !== null) {
      assert.fail(`executor exited before simulation artifact with code ${child.exitCode}: ${childOutput(child)}`);
    }
    await delay(25);
  }
  assert.fail(`executor simulation artifact deadline exceeded for ${intentId}: ${childOutput(child)}`);
}

async function simulationArtifactCount(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT COUNT(*)::INTEGER AS count FROM execution_simulation_artifacts WHERE intent_id=$1',
    [intentId],
  );
  return result.rows[0]?.count ?? -1;
}

async function simulationTransitionCount(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT COUNT(*)::INTEGER AS count FROM execution_intent_transitions WHERE intent_id=$1',
    [intentId],
  );
  return result.rows[0]?.count ?? -1;
}

async function simulationMessageHash(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
): Promise<string> {
  const result = await pool.query<{ message_hash: string | null }>(
    'SELECT message_hash FROM execution_simulation_artifacts WHERE intent_id=$1',
    [intentId],
  );
  const hash = result.rows[0]?.message_hash;
  assert.ok(hash !== undefined && hash !== null);
  return hash;
}

async function simulationState(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
): Promise<SimulationState> {
  const result = await pool.query<SimulationState>(
    `SELECT intent.status,intent.attempt_count,artifact.result_kind,
      artifact.effective_venue,artifact.quote_status,artifact.build_status,
      artifact.simulation_status,artifact.failure_code,artifact.terminal_reason_code,
      artifact.message_hash,
      (SELECT COUNT(*)::INTEGER FROM information_schema.columns
       WHERE table_schema=current_schema()
         AND table_name='execution_simulation_artifacts'
         AND column_name IN ('transaction','transaction_base64','signed_transaction'))
        AS transaction_columns
     FROM execution_intents AS intent
     JOIN execution_simulation_artifacts AS artifact ON artifact.intent_id=intent.id
     WHERE intent.id=$1`,
    [intentId],
  );
  assert.equal(result.rowCount, 1);
  const row = result.rows[0];
  assert.ok(row !== undefined);
  return row;
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

function stopExecutorChild(child: TrackedChild): Promise<ChildExit> {
  const existing = childCleanups.get(child);
  if (existing !== undefined) return existing;
  const cleanup = stopExecutorChildOnce(child);
  childCleanups.set(child, cleanup);
  return cleanup;
}

async function stopExecutorChildOnce(child: TrackedChild): Promise<ChildExit> {
  const existing = currentChildExit(child);
  if (existing !== null) return existing;

  try { child.kill('SIGTERM'); } catch { /* The child may have exited between checks. */ }
  const terminated = await waitForChildExit(child, CHILD_TERM_TIMEOUT_MS);
  if (terminated !== null) return terminated;

  try { child.kill('SIGKILL'); } catch { /* The child may have exited between checks. */ }
  const killed = await waitForChildExit(child, CHILD_KILL_TIMEOUT_MS);
  if (killed !== null) return killed;
  throw new Error('Executor child did not exit after SIGKILL.');
}

function currentChildExit(child: ChildProcess): ChildExit | null {
  if (child.exitCode === null && child.signalCode === null) return null;
  return Object.freeze({ code: child.exitCode, signal: child.signalCode });
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit | null> {
  const existing = currentChildExit(child);
  if (existing !== null) return existing;

  let timer: NodeJS.Timeout | undefined;
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const exit = new Promise<ChildExit>((resolveExit) => {
    exitListener = (code, signal) => { resolveExit(Object.freeze({ code, signal })); };
    child.once('exit', exitListener);
  });
  const timeout = new Promise<null>((resolveTimeout) => {
    timer = setTimeout(() => { resolveTimeout(null); }, timeoutMs);
  });
  try {
    return await Promise.race([exit, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (exitListener !== undefined) child.off('exit', exitListener);
  }
}

function childOutput(child: ChildProcess & Partial<{ captured: string[] }>): string {
  return child.captured?.join('') ?? '';
}

async function currentDatabaseRole(pool: InstanceType<typeof pg.Pool>): Promise<string> {
  const result = await pool.query<{ readonly current_user: string }>('SELECT current_user');
  const role = result.rows[0]?.current_user;
  if (typeof role !== 'string') assert.fail('PostgreSQL did not expose one current role.');
  assert.match(role, /^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/u);
  return role;
}

function databaseUrlForSchema(
  value: string,
  schema: string,
  applicationName: string,
  databaseRole: string,
): string {
  const url = new URL(value);
  if (url.username === '' && url.searchParams.get('user') === null) {
    url.searchParams.set('user', databaseRole);
  }
  url.searchParams.set('options', `-c search_path=${quoteIdentifier(schema)}`);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function delay(durationMs: number): Promise<void> {
  await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, durationMs); });
}

async function createIntent(
  repository: PostgresExecutionIntentRepository,
  suffix: string,
) {
  const now = Date.now();
  return repository.create(createExecutionIntentDraft({
    strategyId: 'executor-main-integration', strategyVersion: 1,
    positionId: `position-${suffix}`, logicalCommandId: `command-${suffix}`,
    mint: '11111111111111111111111111111111', side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: `event-${suffix}`, decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: now, expiresAtMs: now + 60_000,
  }));
}

async function createSimulationIntent(repository: PostgresExecutionIntentRepository) {
  const now = Date.now();
  return repository.create(createExecutionIntentDraft({
    strategyId: 'executor-simulation-main-integration',
    strategyVersion: 1,
    positionId: 'position-simulation-buy',
    logicalCommandId: `command-simulation-buy-${randomUUID()}`,
    mint: EXECUTOR_INTEGRATION_MINT,
    side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    quoteAmountRaw: 1_000_000n,
    baseAmountRaw: null,
    minimumAmountOutRaw: 1n,
    decisionEventId: `event-simulation-buy-${randomUUID()}`,
    decisionFingerprint: 'b'.repeat(64),
    requestedAtMs: now,
    expiresAtMs: now + 120_000,
  }));
}

async function waitForIdleBackend(
  pool: InstanceType<typeof pg.Pool>,
  applicationName: string,
  child: ChildProcess & Partial<{ captured: string[] }>,
): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      assert.fail(`executor exited before idle backend: ${childOutput(child)}`);
    }
    const result = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE application_name=$1 AND state='idle'
       ORDER BY backend_start LIMIT 1`,
      [applicationName],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await delay(25);
  }
  assert.fail('executor idle backend deadline exceeded');
}

function assertChildOutputRedacted(
  output: string,
  executorUrl: string,
  adminUrl: string,
  schema: string,
): void {
  const parsed = new URL(adminUrl);
  for (const forbidden of [
    executorUrl, adminUrl, parsed.username, parsed.password, parsed.hostname,
    parsed.pathname.slice(1), schema, 'search_path', 'secretKey',
    'terminating connection due to administrator command',
    'Connection terminated unexpectedly',
  ]) {
    if (forbidden.length > 0) assert.equal(output.includes(forbidden), false, forbidden);
  }
  assert.match(output, /executor\.database_client_error/u);
  assert.match(output, /DATABASE_IDLE_CLIENT_ERROR/u);
}

function assertSimulationChildOutputRedacted(
  output: string,
  executorUrl: string,
  adminUrl: string,
  schema: string,
  rpcUrl: string,
  rpcMarker: string,
  intentId: string,
): void {
  const parsed = new URL(adminUrl);
  for (const forbidden of [
    executorUrl, adminUrl, parsed.username, parsed.password, parsed.hostname,
    parsed.pathname.slice(1), schema, rpcUrl, rpcMarker, intentId,
    EXECUTOR_INTEGRATION_MINT, EXECUTOR_INTEGRATION_PAYER,
    'transactionBase64', 'sendTransaction', 'sendRawTransaction',
  ]) {
    if (forbidden.length > 0) assert.equal(output.includes(forbidden), false, forbidden);
  }
  assert.match(output, /executor\.simulation_recorded/u);
  assert.match(output, /SIMULATION_SUCCEEDED/u);
  assert.match(output, /integration-provider/u);
}
