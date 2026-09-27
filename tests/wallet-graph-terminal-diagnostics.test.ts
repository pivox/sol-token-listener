import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  WalletGraphLaunchNotFoundError,
  WalletGraphRebuildService,
} from '../src/application/wallet-graph-rebuild.service.js';
import { trustedTerminalAttribution } from '../src/domain/terminal-attribution.js';
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
      const service = new WalletGraphRebuildService(
        new PostgresWalletGraphRepository(controlledPool),
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
      await assert.rejects(workerB, (error) => {
        assert.equal(postgresCode(error), '40001');
        return diagnostic(error, 'WALLET_GRAPH_POSTGRES_SERIALIZATION');
      });

      assert.equal(workerAClient.released, true);
      assert.equal(workerBClient.released, true);
      assert.equal(workerBClient.rolledBack, true);
      assert.deepEqual((await database.query(
        'SELECT input_fingerprint FROM wallet_graph_profiles WHERE mint=$1',
        ['mint'],
      )).rows, [{ input_fingerprint: projectionA.inputFingerprint }]);
      assert.equal((await database.query(
        'SELECT 1 FROM wallet_graph_snapshots WHERE mint=$1',
        ['mint'],
      )).rowCount, 1);
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

function diagnostic(error: unknown, expected: string): boolean {
  assert.equal(trustedTerminalAttribution(error)?.diagnosticCode, expected);
  return true;
}

class ControlledGraphClient {
  public released = false;
  public rolledBack = false;

  public constructor(
    private readonly client: pg.PoolClient,
    public readonly pid: number,
    private readonly role: 'A' | 'B',
    private readonly beforeACommit: DeferredSignal,
    private readonly releaseACommit: DeferredSignal,
    private readonly bLockSubmitted: DeferredSignal,
  ) {}

  public async query(text: string, values?: readonly unknown[]) {
    if (this.role === 'B' && text.includes('pg_advisory_xact_lock')) {
      this.bLockSubmitted.resolve();
    }
    if (this.role === 'A' && text === 'COMMIT') {
      this.beforeACommit.resolve();
      await this.releaseACommit.promise;
    }
    if (text === 'ROLLBACK') this.rolledBack = true;
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

function postgresCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Object.getOwnPropertyDescriptor(error, 'code')?.value
    : undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
