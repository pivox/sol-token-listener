import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  createPaperMvpPositionSample,
  createPaperMvpReport,
} from '../src/domain/paper-mvp.js';
import type {
  PaperMvpRunConfiguration,
} from '../src/ports/paper-mvp-repository.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import {
  PaperMvpConflictError,
  PostgresPaperMvpRepository,
} from '../src/storage/paper-mvp.repository.js';

const configuration: PaperMvpRunConfiguration = Object.freeze({
  strategyId: 'creation-entry-v1', strategyVersion: 1,
  quoteMint: 'So11111111111111111111111111111111111111112',
  targetClosedPositions: 1, initialCapitalRaw: 1_000_000n,
  networkFeeRawPerTransaction: 5_000n, maxDurationMs: 60_000,
  providerIdentity: 'provider:test:v1',
});
const progressCounters = Object.freeze({
  creationsObserved: 1, entriesRejected: 0,
  duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
});

void test('uses a transaction-wide advisory lock and releases after start failure', async () => {
  const commands: string[] = [];
  let released = false;
  const repository = new PostgresPaperMvpRepository({
    connect: async () => ({
      query: async (text: string) => {
        commands.push(text);
        if (text.includes('FROM paper_mvp_runs')) throw new Error('database failure');
        return { rows: [], rowCount: 0 };
      },
      release: () => { released = true; },
    }),
  });

  await assert.rejects(repository.startOrResume(configuration, 1_000), /operation failed/u);
  assert.equal(commands[0], 'BEGIN');
  assert.match(commands[1] ?? '', /pg_advisory_xact_lock/u);
  assert.equal(commands.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

void test('rejects invalid financial configuration before opening PostgreSQL', async () => {
  let connected = false;
  const repository = new PostgresPaperMvpRepository({
    connect: async () => {
      connected = true;
      throw new Error('must not connect');
    },
  });
  await assert.rejects(
    repository.startOrResume({ ...configuration, initialCapitalRaw: 0n }, 1_000),
    /initial capital/u,
  );
  await assert.rejects(
    repository.startOrResume({ ...configuration, networkFeeRawPerTransaction: -1n }, 1_000),
    /network fee/u,
  );
  assert.equal(connected, false);
});

void test('loads one repeatable read snapshot while progress commits concurrently', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL snapshot test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const writer = new PostgresPaperMvpRepository(pool);
    const run = await writer.startOrResume(configuration, 1_000);
    let selectedRun: (() => void) | undefined;
    const runSelected = new Promise<void>((resolve) => { selectedRun = resolve; });
    let resumeRead: (() => void) | undefined;
    const readMayContinue = new Promise<void>((resolve) => { resumeRead = resolve; });
    const reader = new PostgresPaperMvpRepository({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: readonly unknown[]) => {
            const result = await client.query(text, values === undefined ? [] : [...values]);
            if (text.includes('FROM paper_mvp_runs run WHERE run.run_id=$1')) {
              selectedRun?.();
              await readMayContinue;
            }
            return result;
          },
          release: () => { client.release(); },
        };
      },
    });

    const loading = reader.load(run.runId);
    await runSelected;
    await writer.recordProgress({
      runId: run.runId, observedAtMs: 2_000, counters: progressCounters,
      providerUsage: Object.freeze({
        status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 101n,
        rateLimitedCount: 0,
      }),
      samples: Object.freeze([sample()]), unknownPositions: Object.freeze([]),
    });
    resumeRead?.();
    const snapshot = await loading;
    assert.ok(snapshot);
    assert.equal(snapshot.run.closedPositions, 0);
    assert.equal(snapshot.samples.length, 0);
  });
});

void test('rejects a report not canonically rebuilt from durable samples', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL durable report test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const repository = new PostgresPaperMvpRepository(pool);
    const run = await repository.startOrResume(configuration, 1_000);
    const usage = Object.freeze({
      status: 'AVAILABLE' as const, creditsUsedStart: 100n, creditsUsedEnd: 101n,
      rateLimitedCount: 0,
    });
    await repository.recordProgress({
      runId: run.runId, observedAtMs: 2_000, counters: progressCounters,
      providerUsage: usage, samples: Object.freeze([losingSample()]),
      unknownPositions: Object.freeze([]),
    });
    const fabricatedPass = createPaperMvpReport({
      runId: run.runId, startedAtMs: run.startedAtMs, completedAtMs: 3_000,
      targetClosedPositions: 1, initialCapitalRaw: configuration.initialCapitalRaw,
      quoteMint: configuration.quoteMint, creationsObserved: 1, entriesRejected: 0,
      samples: Object.freeze([sample()]), unknownTerminalPositions: 0,
      duplicateLogicalBuys: 0, duplicateLogicalSells: 0, providerUsage: usage,
    });
    assert.equal(fabricatedPass.verdict, 'PASS');

    await assert.rejects(repository.terminalize({
      runId: run.runId, terminalAtMs: 3_000, state: 'COMPLETED',
      report: fabricatedPass, failureCode: null,
    }), isConflict('TERMINALIZATION_CONTRADICTION'));
    assert.equal((await repository.load(run.runId))?.run.state, 'RUNNING');
  });
});

void test('starts or resumes exactly, persists progress atomically, terminalizes and purges', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL paper MVP repository test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const repository = new PostgresPaperMvpRepository(pool);
    const run = await repository.startOrResume(configuration, 1_000);
    assert.equal(run.state, 'RUNNING');
    assert.equal(run.startedAtMs, 1_000);
    assert.equal(run.deadlineAtMs, 61_000);
    assert.deepEqual((await repository.startOrResume(configuration, 2_000)).configuration, configuration);
    await assert.rejects(
      repository.startOrResume({ ...configuration, targetClosedPositions: 2 }, 2_000),
      isConflict('ACTIVE_RUN_INCOMPATIBLE'),
    );
    await assert.rejects(
      pool.query(`INSERT INTO paper_mvp_runs (
        run_id,strategy_id,strategy_version,quote_mint,target_closed_positions,
        initial_capital_raw,network_fee_raw_per_transaction,max_duration_ms,
        provider_identity,state,started_at,deadline_at,updated_at,
        payload_version,configuration_payload
      ) SELECT 'second-active',strategy_id,strategy_version,quote_mint,target_closed_positions,
        initial_capital_raw,network_fee_raw_per_transaction,max_duration_ms,
        provider_identity,state,started_at,deadline_at,updated_at,
        payload_version,configuration_payload FROM paper_mvp_runs WHERE run_id=$1`, [run.runId]),
      /paper_mvp_runs_one_active_idx/u,
    );

    const firstSample = sample();
    const progressed = await repository.recordProgress({
      runId: run.runId, observedAtMs: 2_000, counters: progressCounters,
      providerUsage: Object.freeze({
        status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 101n,
        rateLimitedCount: 0,
      }),
      samples: Object.freeze([firstSample]),
      unknownPositions: Object.freeze([]),
    });
    assert.equal(progressed.closedPositions, 1);
    const replayed = await repository.recordProgress({
      runId: run.runId, observedAtMs: 2_001, counters: progressCounters,
      providerUsage: progressed.providerUsage,
      samples: Object.freeze([firstSample]),
      unknownPositions: Object.freeze([]),
    });
    assert.equal(replayed.closedPositions, 1);

    const withUnknown = await repository.recordProgress({
      runId: run.runId, observedAtMs: 2_001, counters: progressCounters,
      providerUsage: progressed.providerUsage, samples: Object.freeze([]),
      unknownPositions: Object.freeze([Object.freeze({
        positionId: 'position-unknown', reason: 'MISSING_SELL_TRADE',
      })]),
    });
    assert.equal(withUnknown.counters.unknownTerminalPositions, 1);
    assert.equal((await repository.recordProgress({
      runId: run.runId, observedAtMs: 2_001, counters: progressCounters,
      providerUsage: progressed.providerUsage, samples: Object.freeze([]),
      unknownPositions: Object.freeze([Object.freeze({
        positionId: 'position-unknown', reason: 'MISSING_SELL_TRADE',
      })]),
    })).counters.unknownTerminalPositions, 1);
    await assert.rejects(repository.recordProgress({
      runId: run.runId, observedAtMs: 2_001, counters: progressCounters,
      providerUsage: progressed.providerUsage, samples: Object.freeze([]),
      unknownPositions: Object.freeze([Object.freeze({
        positionId: 'position-unknown', reason: 'MISSING_BUY_TRADE',
      })]),
    }), isConflict('SAMPLE_CONTRADICTION'));

    await assert.rejects(repository.recordProgress({
      runId: run.runId, observedAtMs: 2_002,
      counters: Object.freeze({ ...progressCounters, creationsObserved: 2 }),
      providerUsage: progressed.providerUsage,
      samples: Object.freeze([Object.freeze({ ...firstSample, mint: 'contradiction' })]),
      unknownPositions: Object.freeze([]),
    }), isConflict('SAMPLE_CONTRADICTION'));
    const afterRollback = await repository.load(run.runId);
    assert.ok(afterRollback);
    assert.equal(afterRollback.run.counters.creationsObserved, 1);
    assert.equal(afterRollback.run.counters.unknownTerminalPositions, 1);
    assert.equal(afterRollback.samples[0]?.mint, 'mint');
    assert.deepEqual(afterRollback.unknownPositions, [
      { positionId: 'position-unknown', reason: 'MISSING_SELL_TRADE' },
    ]);

    const report = createPaperMvpReport({
      runId: run.runId, startedAtMs: run.startedAtMs, completedAtMs: 3_000,
      targetClosedPositions: 1, initialCapitalRaw: configuration.initialCapitalRaw,
      quoteMint: configuration.quoteMint, creationsObserved: 1, entriesRejected: 0,
      samples: Object.freeze([firstSample]), unknownTerminalPositions: 1,
      duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
      providerUsage: progressed.providerUsage,
    });
    const terminal = await repository.terminalize({
      runId: run.runId, terminalAtMs: 3_000, state: 'COMPLETED', report,
      failureCode: null,
    });
    assert.equal(terminal.state, 'COMPLETED');
    assert.equal(terminal.purgeAfterMs, 3_000 + 4 * 60 * 60 * 1_000);
    assert.equal((await repository.terminalize({
      runId: run.runId, terminalAtMs: 3_000, state: 'COMPLETED', report,
      failureCode: null,
    })).state, 'COMPLETED');
    await assert.rejects(
      pool.query(`UPDATE paper_mvp_runs SET entries_rejected=entries_rejected+1
        WHERE run_id=$1`, [run.runId]),
      /terminal.*immutable/iu,
    );

    const unavailableRun = await repository.startOrResume(configuration, 4_000);
    const unavailableReport = createPaperMvpReport({
      runId: unavailableRun.runId, startedAtMs: 4_000, completedAtMs: 5_000,
      targetClosedPositions: 1, initialCapitalRaw: configuration.initialCapitalRaw,
      quoteMint: configuration.quoteMint, creationsObserved: 0, entriesRejected: 0,
      samples: Object.freeze([]), unknownTerminalPositions: 0,
      duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
      providerUsage: unavailableRun.providerUsage,
    });
    assert.equal((await repository.terminalize({
      runId: unavailableRun.runId, terminalAtMs: 5_000, state: 'COMPLETED',
      report: unavailableReport, failureCode: null,
    })).state, 'COMPLETED');

    const failedRun = await repository.startOrResume(configuration, 6_000);
    assert.equal((await repository.terminalize({
      runId: failedRun.runId, terminalAtMs: 7_000, state: 'FAILED',
      report: null, failureCode: 'SOURCE_CONTRADICTION',
    })).state, 'FAILED');
    await assert.rejects(
      pool.query(`UPDATE paper_mvp_runs SET provider_rate_limited_count=1
        WHERE run_id=$1`, [failedRun.runId]),
      /terminal.*immutable/iu,
    );

    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.paperMvpSamples, 2);
    assert.equal(purged.paperMvpRuns, 3);
    assert.equal((await pool.query('SELECT 1 FROM paper_mvp_position_samples')).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM paper_mvp_runs')).rowCount, 0);
  });
});

function sample() {
  return createPaperMvpPositionSample({
    positionId: 'position', mint: 'mint', quoteMint: configuration.quoteMint,
    exitReason: 'TAKE_PROFIT_2X_EXECUTABLE',
    creationDetectedAtMs: 1_001, entryDecisionAtMs: 1_002, entryQuoteAtMs: 1_003,
    paperBuyAtMs: 1_004, exitTriggerAtMs: 1_005, exitQuoteAtMs: 1_006,
    paperSellAtMs: 1_007, buyAmountInRaw: 10_000n, buyAmountOutRaw: 100n,
    buyMinimumAmountOutRaw: 90n, buyFeesRaw: 1n, buySlippageBps: 10n,
    buyPriceImpactBps: 20n, sellAmountInRaw: 90n, sellAmountOutRaw: 30_001n,
    sellMinimumAmountOutRaw: 30_000n, sellFeesRaw: 1n, sellSlippageBps: 10n,
    sellPriceImpactBps: 20n, networkFeeRawPerTransaction: 5_000n,
  });
}

function losingSample() {
  return createPaperMvpPositionSample({
    ...sample(),
    sellAmountOutRaw: 19_001n,
    sellMinimumAmountOutRaw: 19_000n,
  });
}

function isConflict(code: PaperMvpConflictError['code']) {
  return (error: unknown): boolean => error instanceof PaperMvpConflictError && error.code === code;
}

async function withSchema(
  databaseUrl: string,
  operation: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `paper_mvp_repository_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    await operation(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z_][a-z0-9_]*$/u);
  return `"${identifier}"`;
}
