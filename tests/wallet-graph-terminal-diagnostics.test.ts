import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  WalletGraphLaunchNotFoundError,
  WalletGraphRebuildService,
} from '../src/application/wallet-graph-rebuild.service.js';
import {
  registerTrustedTerminalAttribution,
  trustedTerminalAttribution,
} from '../src/domain/terminal-attribution.js';
import type {
  WalletGraphAnalysis,
  WalletGraphInput,
  WalletGraphProjection,
} from '../src/domain/wallet-graph.js';
import type {
  WalletGraphRepository,
  WalletGraphTransaction,
} from '../src/ports/wallet-graph-repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import {
  PostgresWalletGraphRepository,
  WalletGraphDataError,
  type WalletGraphPool,
} from '../src/storage/wallet-graph.repository.js';
import { graphInput } from './helpers/wallet-graph-fixture.js';

void test('retries authenticated conflicts twice with rollback, fixed waits and fresh transactions',
  async () => {
    const first = postgresFailure('40001');
    const second = postgresFailure('40P01');
    const events: string[] = [];
    const waits: number[] = [];
    const transactions: WalletGraphTransaction[] = [];
    let callbackAttempt = 0;
    const harness = graphRepositoryHarness(events, async (text) => {
      if (text === 'LOAD') {
        callbackAttempt += 1;
        if (callbackAttempt === 1) throw first;
        if (callbackAttempt === 2) throw second;
      }
      return emptyResult();
    }, async (delayMs) => {
      events.push(`WAIT ${delayMs}`);
      waits.push(delayMs);
    });

    const result = await harness.repository.transact('mint', async (transaction) => {
      events.push('CALLBACK');
      transactions.push(transaction);
      await transaction.loadCanonicalInput('mint');
      return 'committed';
    });

    assert.equal(result, 'committed');
    assert.deepEqual(waits, [10, 20]);
    assert.equal(new Set(transactions).size, 3);
    assert.deepEqual(events, [
      'BEGIN', 'LOCK', 'CALLBACK', 'LOAD', 'ROLLBACK', 'WAIT 10',
      'BEGIN', 'LOCK', 'CALLBACK', 'LOAD', 'ROLLBACK', 'WAIT 20',
      'BEGIN', 'LOCK', 'CALLBACK', 'LOAD', 'COMMIT', 'RELEASE',
    ]);
    assert.equal(harness.connectCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(trustedTerminalAttribution(first)?.diagnosticCode,
      'WALLET_GRAPH_POSTGRES_SERIALIZATION');
    assert.equal(trustedTerminalAttribution(second)?.diagnosticCode,
      'WALLET_GRAPH_POSTGRES_DEADLOCK');
  });

void test('retries authenticated lock conflicts before running the callback', async () => {
  const failures = [postgresFailure('40001'), postgresFailure('40P01')] as const;
  const events: string[] = [];
  let locks = 0;
  const harness = graphRepositoryHarness(events, async (text) => {
    if (text === 'LOCK' && locks < failures.length) {
      const failure = failures[locks];
      assert.ok(failure);
      locks += 1;
      throw failure;
    }
    return emptyResult();
  }, async (delayMs) => { events.push(`WAIT ${delayMs}`); });

  assert.equal(await harness.repository.transact('mint', async () => {
    events.push('CALLBACK');
    return 'committed';
  }), 'committed');
  assert.deepEqual(events, [
    'BEGIN', 'LOCK', 'ROLLBACK', 'WAIT 10',
    'BEGIN', 'LOCK', 'ROLLBACK', 'WAIT 20',
    'BEGIN', 'LOCK', 'CALLBACK', 'COMMIT', 'RELEASE',
  ]);
  assert.equal(harness.connectCount(), 1);
  assert.equal(harness.releaseCount(), 1);
});

void test('rethrows the third authenticated conflict unchanged without a fourth attempt', async () => {
  const failures = [postgresFailure('40001'), postgresFailure('40P01'),
    postgresFailure('40001')] as const;
  const events: string[] = [];
  const waits: number[] = [];
  let attempt = 0;
  const harness = graphRepositoryHarness(events, async (text) => {
    if (text === 'LOCK') {
      const failure = failures[attempt];
      assert.ok(failure);
      attempt += 1;
      throw failure;
    }
    return emptyResult();
  }, async (delayMs) => { waits.push(delayMs); events.push(`WAIT ${delayMs}`); });

  await assert.rejects(harness.repository.transact('mint', async () => null), (error) => {
    assert.equal(error, failures[2]);
    return true;
  });
  assert.equal(attempt, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(events, [
    'BEGIN', 'LOCK', 'ROLLBACK', 'WAIT 10',
    'BEGIN', 'LOCK', 'ROLLBACK', 'WAIT 20',
    'BEGIN', 'LOCK', 'ROLLBACK', 'RELEASE',
  ]);
  assert.equal(harness.connectCount(), 1);
  assert.equal(harness.releaseCount(), 1);
});

void test('never retries untrusted, hostile, wrapped or differently attributed failures', async () => {
  const authentic = await authenticPostgresFailure('40001');
  const otherDiagnostic = new Error('trusted but not retryable here');
  registerTrustedTerminalAttribution(otherDiagnostic, {
    version: 1,
    diagnosticCode: 'WALLET_GRAPH_DATA_INVALID',
    causeKind: null,
    pumpWire: null,
  });
  let hostileTrapCount = 0;
  const hostile = new Proxy(Object.create(null) as object, {
    get() { hostileTrapCount += 1; throw new Error('hostile get'); },
    getOwnPropertyDescriptor() { hostileTrapCount += 1; throw new Error('hostile descriptor'); },
    getPrototypeOf() { hostileTrapCount += 1; throw new Error('hostile prototype'); },
  });
  const revocable = Proxy.revocable(Object.create(null) as object, {
    get() { hostileTrapCount += 1; throw new Error('revoked get'); },
  });
  revocable.revoke();
  const cases: readonly unknown[] = [
    new Error('ordinary'),
    'primitive',
    Object.assign(new Error('forged sqlstate'), { code: '40001' }),
    Object.assign(new Error('forged diagnostic'), {
      diagnosticCode: 'WALLET_GRAPH_POSTGRES_SERIALIZATION',
    }),
    Object.assign(new Error('other sqlstate'), { code: '23505' }),
    otherDiagnostic,
    new Error('wrapper', { cause: authentic }),
    hostile,
    revocable.proxy,
  ];

  for (const thrown of cases) {
    const events: string[] = [];
    let waits = 0;
    let callbacks = 0;
    const harness = graphRepositoryHarness(events, async () => emptyResult(), async () => {
      waits += 1;
    });
    const caught = await captureRejection(harness.repository.transact('mint', async () => {
      callbacks += 1;
      throw thrown;
    }));
    assert.equal(caught.error, thrown);
    assert.equal(callbacks, 1);
    assert.equal(waits, 0);
    assert.deepEqual(events, ['BEGIN', 'LOCK', 'ROLLBACK', 'RELEASE']);
    assert.equal(harness.releaseCount(), 1);
  }
  assert.equal(hostileTrapCount, 0);
});

void test('does not retry a non-conflict PostgreSQL query rejection', async () => {
  const failure = postgresFailure('23505');
  const events: string[] = [];
  let waits = 0;
  const harness = graphRepositoryHarness(events, async (text) => {
    if (text === 'LOCK') throw failure;
    return emptyResult();
  }, async () => { waits += 1; });

  assert.equal((await captureRejection(
    harness.repository.transact('mint', async () => null),
  )).error, failure);
  assert.equal(trustedTerminalAttribution(failure), null);
  assert.equal(waits, 0);
  assert.deepEqual(events, ['BEGIN', 'LOCK', 'ROLLBACK', 'RELEASE']);
});

void test('does not retry when rollback or wait fails', async () => {
  const conflict = postgresFailure('40001');
  const rollbackFailure = new Error('rollback failed');
  const rollbackEvents: string[] = [];
  const rollbackHarness = graphRepositoryHarness(rollbackEvents, async (text) => {
    if (text === 'LOCK') throw conflict;
    if (text === 'ROLLBACK') throw rollbackFailure;
    return emptyResult();
  }, async () => { assert.fail('wait must not run after rollback failure'); });
  assert.equal((await captureRejection(
    rollbackHarness.repository.transact('mint', async () => null),
  )).error, rollbackFailure);
  assert.deepEqual(rollbackEvents, ['BEGIN', 'LOCK', 'ROLLBACK', 'RELEASE']);
  assert.equal(rollbackHarness.releaseCount(), 1);

  const waitFailure = new Error('wait failed');
  const waitEvents: string[] = [];
  const waitHarness = graphRepositoryHarness(waitEvents, async (text) => {
    if (text === 'LOCK') throw postgresFailure('40P01');
    return emptyResult();
  }, async (delayMs) => {
    waitEvents.push(`WAIT ${delayMs}`);
    throw waitFailure;
  });
  assert.equal((await captureRejection(
    waitHarness.repository.transact('mint', async () => null),
  )).error, waitFailure);
  assert.deepEqual(waitEvents, ['BEGIN', 'LOCK', 'ROLLBACK', 'WAIT 10', 'RELEASE']);
  assert.equal(waitHarness.releaseCount(), 1);
});

void test('replays the complete callback when commit has an authenticated conflict', async () => {
  const conflict = postgresFailure('40001');
  const events: string[] = [];
  const transactions: WalletGraphTransaction[] = [];
  let commits = 0;
  const harness = graphRepositoryHarness(events, async (text) => {
    if (text === 'COMMIT' && commits++ === 0) throw conflict;
    return emptyResult();
  }, async (delayMs) => { events.push(`WAIT ${delayMs}`); });

  const result = await harness.repository.transact('mint', async (transaction) => {
    transactions.push(transaction);
    events.push('CALLBACK');
    return transactions.length;
  });

  assert.equal(result, 2);
  assert.equal(new Set(transactions).size, 2);
  assert.deepEqual(events, [
    'BEGIN', 'LOCK', 'CALLBACK', 'COMMIT', 'ROLLBACK', 'WAIT 10',
    'BEGIN', 'LOCK', 'CALLBACK', 'COMMIT', 'RELEASE',
  ]);
  assert.equal(harness.releaseCount(), 1);
});

void test('classifies SQLSTATE only when the trusted PostgreSQL query rejects', async () => {
  for (const [sqlState, expected] of [
    ['40001', 'WALLET_GRAPH_POSTGRES_SERIALIZATION'],
    ['40P01', 'WALLET_GRAPH_POSTGRES_DEADLOCK'],
  ] as const) {
    const failure = Object.assign(new Error('database rejected query'), { code: sqlState });
    let released = false;
    const repository = new PostgresWalletGraphRepository({
      async connect() {
        return {
          async query(text: string) {
            if (text.includes('pg_advisory_xact_lock')) throw failure;
            return { rows: [], rowCount: 0 };
          },
          release() { released = true; },
        };
      },
    });

    await assert.rejects(repository.transact('mint', async () => null), (error) => {
      assert.equal(error, failure);
      assert.equal(trustedTerminalAttribution(error)?.diagnosticCode, expected);
      return true;
    });
    assert.equal(released, true);
  }

  const forgedCallback = Object.assign(new Error('operation failed'), {
    code: '40001',
    name: 'DatabaseError',
  });
  const repository = successfulRepository();
  await assert.rejects(
    repository.transact('mint', async () => { throw forgedCallback; }),
    (error) => {
      assert.equal(error, forgedCallback);
      assert.equal(trustedTerminalAttribution(error), null);
      return true;
    },
  );
});

void test('attributes wallet graph launch, data, analysis and persistence failures by exact identity', async () => {
  const missing = new FakeRepository(null);
  await assert.rejects(
    new WalletGraphRebuildService(missing).rebuild('mint'),
    (error) => diagnostic(error, 'WALLET_GRAPH_LAUNCH_MISSING'),
  );

  const invalid = Object.freeze({ ...graphInput(), inputFingerprint: '' });
  await assert.rejects(
    new WalletGraphRebuildService(new FakeRepository(invalid)).rebuild('mint'),
    (error) => diagnostic(error, 'WALLET_GRAPH_DATA_INVALID'),
  );

  const analysisFailure = Object.assign(new Error('analysis failed'), {
    code: '40001',
    diagnosticCode: 'WALLET_GRAPH_POSTGRES_SERIALIZATION',
  });
  const analyzer = {
    analyze(): WalletGraphAnalysis { throw analysisFailure; },
  };
  await assert.rejects(
    new WalletGraphRebuildService(
      new FakeRepository(graphInput()),
      analyzer,
    ).rebuild('mint'),
    (error) => diagnostic(error, 'WALLET_GRAPH_ANALYSIS_INVALID'),
  );

  const persistenceFailure = Object.assign(new Error('persistence failed'), {
    code: '40P01',
  });
  await assert.rejects(
    new WalletGraphRebuildService(
      new FakeRepository(graphInput(), persistenceFailure),
    ).rebuild('mint'),
    (error) => diagnostic(error, 'WALLET_GRAPH_PERSISTENCE_UNKNOWN'),
  );
});

void test('public wallet graph error fields do not forge terminal attribution', () => {
  for (const error of [
    new WalletGraphLaunchNotFoundError('mint'),
    new WalletGraphDataError(),
    Object.assign(new Error('forged'), {
      name: 'WalletGraphDataError',
      code: '40001',
      diagnosticCode: 'WALLET_GRAPH_POSTGRES_SERIALIZATION',
    }),
  ]) {
    assert.equal(trustedTerminalAttribution(error), null);
  }
});

void test('reproduces the same-mint repeatable-read serialization with two workers',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: wallet graph concurrency test skipped');
      return;
    }
    const schema = `wallet_graph_serialization_${randomUUID().replaceAll('-', '')}`;
    assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const database = new pg.Pool({
      connectionString: databaseUrl,
      max: 5,
      options: `-c search_path=${schema}`,
    });
    const beforeACommit = deferredSignal();
    const releaseACommit = deferredSignal();
    const bLockSubmitted = deferredSignal();
    let workerA: Promise<WalletGraphProjection | null> | null = null;
    let workerB: Promise<WalletGraphProjection | null> | null = null;
    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await migrateDatabase({ pool: database });
      await seedLaunch(database);

      const clients: ControlledGraphClient[] = [];
      const controlledPool: WalletGraphPool = {
        async connect() {
          const client = await database.connect();
          const pidResult = await client.query<{ readonly pid: number }>(
            'SELECT pg_backend_pid() AS pid',
          );
          const pid = pidResult.rows[0]?.pid;
          if (pid === undefined) throw new Error('PostgreSQL backend pid unavailable.');
          const role = clients.length === 0 ? 'A' : 'B';
          const controlled = new ControlledGraphClient(
            client,
            pid,
            role,
            beforeACommit,
            releaseACommit,
            bLockSubmitted,
          );
          clients.push(controlled);
          return controlled;
        },
      };
      const waits: number[] = [];
      const service = new WalletGraphRebuildService(
        new PostgresWalletGraphRepository(controlledPool, async (delayMs) => {
          waits.push(delayMs);
        }),
      );

      workerA = service.rebuild('mint');
      await beforeACommit.promise;
      workerB = service.rebuild('mint');
      await bLockSubmitted.promise;
      const workerAClient = clients[0];
      const workerBClient = clients[1];
      assert.ok(workerAClient !== undefined && workerBClient !== undefined);
      await assertBlocked(database, workerAClient.pid, workerBClient.pid);

      releaseACommit.resolve();
      const projectionA = await workerA;
      assert.ok(projectionA !== null);
      const projectionB = await workerB;
      assert.ok(projectionB !== null);
      assert.equal(projectionB.inputFingerprint, projectionA.inputFingerprint);

      assert.equal(workerAClient.released, true);
      assert.equal(workerBClient.released, true);
      assert.equal(workerBClient.rollbackCount, 1);
      assert.equal(workerBClient.beginCount, 2);
      assert.equal(workerBClient.lockCount, 2);
      assert.equal(workerBClient.commitCount, 1);
      assert.deepEqual(waits, [10]);
      assert.deepEqual((await database.query(
        'SELECT input_fingerprint FROM wallet_graph_profiles WHERE mint=$1',
        ['mint'],
      )).rows, [{ input_fingerprint: projectionA.inputFingerprint }]);
      assert.equal((await database.query(
        'SELECT 1 FROM wallet_graph_snapshots WHERE mint=$1',
        ['mint'],
      )).rowCount, 1);
      assert.equal((await database.query(
        "SELECT 1 FROM domain_events WHERE mint=$1 AND type='WalletClusterDetected'",
        ['mint'],
      )).rowCount, 1);
      assert.equal((await database.query(
        'SELECT 1 FROM wallet_relationships WHERE mint=$1', ['mint'],
      )).rowCount, 0);
      assert.equal((await database.query(
        'SELECT 1 FROM wallet_clusters WHERE mint=$1', ['mint'],
      )).rowCount, 0);
      assert.equal((await database.query(
        'SELECT 1 FROM wallet_cluster_members WHERE mint=$1', ['mint'],
      )).rowCount, 0);
    } finally {
      releaseACommit.resolve();
      await Promise.allSettled([
        ...(workerA === null ? [] : [workerA]),
        ...(workerB === null ? [] : [workerB]),
      ]);
      await database.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });

class FakeRepository implements WalletGraphRepository {
  public constructor(
    private readonly input: WalletGraphInput | null,
    private readonly persistenceFailure?: Error,
  ) {}

  public async transact<TResult>(
    _mint: string,
    operation: (transaction: WalletGraphTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return operation({
      loadCanonicalInput: async () => this.input,
      dissolveCurrent: async () => undefined,
      replaceProjection: async () => {
        if (this.persistenceFailure !== undefined) throw this.persistenceFailure;
      },
    });
  }
}

function successfulRepository(): PostgresWalletGraphRepository {
  return new PostgresWalletGraphRepository({
    async connect() {
      return {
        async query() { return { rows: [], rowCount: 0 }; },
        release() {},
      };
    },
  });
}

function graphRepositoryHarness(
  events: string[],
  query: (label: string, text: string) => Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number;
  }>,
  wait: (delayMs: number) => Promise<void>,
) {
  let connections = 0;
  let releases = 0;
  const pool: WalletGraphPool = {
    async connect() {
      connections += 1;
      return {
        async query(text: string) {
          const label = graphQueryLabel(text);
          events.push(label);
          return query(label, text);
        },
        release() {
          releases += 1;
          events.push('RELEASE');
        },
      };
    },
  };
  return {
    repository: new PostgresWalletGraphRepository(pool, wait),
    connectCount: () => connections,
    releaseCount: () => releases,
  };
}

function graphQueryLabel(text: string): string {
  if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ') return 'BEGIN';
  if (text.includes('pg_advisory_xact_lock')) return 'LOCK';
  if (text.includes('FROM token_launches AS launch')
    && text.includes("event.type = 'TokenLaunchDetected'")) return 'LOAD';
  if (text === 'COMMIT' || text === 'ROLLBACK') return text;
  return 'QUERY';
}

function emptyResult() {
  return { rows: [], rowCount: 0 } as const;
}

function postgresFailure(code: string): Error {
  return Object.assign(new Error(`PostgreSQL ${code}`), { code });
}

async function authenticPostgresFailure(code: '40001' | '40P01'): Promise<Error> {
  const failure = postgresFailure(code);
  const harness = graphRepositoryHarness([], async (label) => {
    if (label === 'LOCK') throw failure;
    return emptyResult();
  }, async () => undefined);
  const caught = await captureRejection(harness.repository.transact('mint', async () => null));
  assert.equal(caught.error, failure);
  assert.ok(trustedTerminalAttribution(failure) !== null);
  return failure;
}

async function captureRejection(promise: Promise<unknown>): Promise<{ readonly error: unknown }> {
  try {
    await promise;
  } catch (error) {
    return { error };
  }
  assert.fail('Expected rejection.');
}

function diagnostic(error: unknown, expected: string): boolean {
  assert.equal(trustedTerminalAttribution(error)?.diagnosticCode, expected);
  return true;
}

class ControlledGraphClient {
  public released = false;
  public beginCount = 0;
  public lockCount = 0;
  public rollbackCount = 0;
  public commitCount = 0;

  public constructor(
    private readonly client: pg.PoolClient,
    public readonly pid: number,
    private readonly role: 'A' | 'B',
    private readonly beforeACommit: DeferredSignal,
    private readonly releaseACommit: DeferredSignal,
    private readonly bLockSubmitted: DeferredSignal,
  ) {}

  public async query(text: string, values?: readonly unknown[]) {
    if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ') this.beginCount += 1;
    if (this.role === 'B' && text.includes('pg_advisory_xact_lock')) {
      this.lockCount += 1;
      this.bLockSubmitted.resolve();
    } else if (text.includes('pg_advisory_xact_lock')) {
      this.lockCount += 1;
    }
    if (this.role === 'A' && text === 'COMMIT') {
      this.beforeACommit.resolve();
      await this.releaseACommit.promise;
    }
    if (text === 'ROLLBACK') this.rollbackCount += 1;
    if (text === 'COMMIT') this.commitCount += 1;
    return this.client.query(text, values as unknown[] | undefined);
  }

  public release(): void {
    this.released = true;
    this.client.release();
  }
}

interface DeferredSignal {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferredSignal(): DeferredSignal {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve() {
      if (resolvePromise === undefined) throw new Error('Deferred resolver unavailable.');
      resolvePromise();
    },
  };
}

async function assertBlocked(
  pool: InstanceType<typeof pg.Pool>,
  blockerPid: number,
  waiterPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const result = await pool.query<{ readonly blocked: boolean }>(
      `SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked`,
      [blockerPid, waiterPid],
    );
    if (result.rows[0]?.blocked === true) return;
  }
  assert.fail('Worker B did not wait on worker A advisory lock.');
}

async function seedLaunch(pool: InstanceType<typeof pg.Pool>): Promise<void> {
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
    'create-signature', 10, 0, 1, 'confirmed',
    to_timestamp(1720000000), 1, '{}'::jsonb
  )`);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
