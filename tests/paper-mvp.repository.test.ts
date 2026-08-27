import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  createPaperMvpPositionSample,
  createPaperMvpReport,
  type PaperMvpPositionSample,
  type PaperMvpProviderUsage,
} from '../src/domain/paper-mvp.js';
import type {
  PaperMvpRunConfiguration,
  PaperMvpUnknownPosition,
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
  externalUniqueBuyersTarget: 10, takeProfitMultiplierBps: 20_000n,
  providerIdentity: 'provider:test:v1',
});
const OWNER = 'paper-mvp-owner-test';
const progressCounters = Object.freeze({
  creationsObserved: 1, entriesRejected: 0,
  duplicateLogicalBuys: 0, duplicateLogicalSells: 0, openedPositions: 2, openPositions: 1,
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

  await assert.rejects(repository.startOrResume(configuration, OWNER, 1_000), /operation failed/u);
  assert.equal(commands[0], 'BEGIN');
  assert.match(commands[1] ?? '', /pg_advisory_xact_lock/u);
  assert.equal(commands.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

void test('rejects invalid financial configuration before opening PostgreSQL', async () => {
  let connectionCount = 0;
  const repository = new PostgresPaperMvpRepository({
    connect: async () => {
      connectionCount += 1;
      throw new Error('must not connect');
    },
  });
  await assert.rejects(
    repository.startOrResume({ ...configuration, initialCapitalRaw: 0n }, OWNER, 1_000),
    /initial capital/u,
  );
  await assert.rejects(
    repository.startOrResume({ ...configuration, networkFeeRawPerTransaction: -1n }, OWNER, 1_000),
    /network fee/u,
  );
  assert.equal(connectionCount, 0);
});

void test('validates provider numeric(78) boundaries and hostile values before PostgreSQL', async () => {
  let connectionCount = 0;
  const repository = new PostgresPaperMvpRepository({
    connect: async () => {
      connectionCount += 1;
      throw new Error('must not connect');
    },
  });
  const maximum = 10n ** 78n - 1n;
  const progress = (providerUsage: unknown) => repository.recordProgress({
    runId: 'provider-validation-run', runnerOwnerId: OWNER,
    expectedUpdatedAtMs: 1_000, observedAtMs: 2_000, counters: progressCounters,
    providerUsage: providerUsage as PaperMvpProviderUsage,
    samples: Object.freeze([]), unknownPositions: Object.freeze([]),
  });
  await assert.rejects(progress({
    status: 'AVAILABLE', creditsUsedStart: maximum, creditsUsedEnd: maximum,
    rateLimitedCount: 0,
  }), /repository operation failed/u);
  for (const invalid of [
    { status: 'AVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: 10n ** 78n, rateLimitedCount: 0 },
    { status: 'AVAILABLE', creditsUsedStart: 0, creditsUsedEnd: 1n, rateLimitedCount: 0 },
    { status: 'AVAILABLE', creditsUsedStart: '0', creditsUsedEnd: '1', rateLimitedCount: 0 },
    { status: 'AVAILABLE', creditsUsedStart: -1n, creditsUsedEnd: 1n, rateLimitedCount: 0 },
    { status: 'AVAILABLE', creditsUsedStart: 2n, creditsUsedEnd: 1n, rateLimitedCount: 0 },
    new Proxy({
      status: 'AVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: 1n, rateLimitedCount: 0,
    }, {}),
    Object.defineProperty({
      creditsUsedStart: 0n, creditsUsedEnd: 1n, rateLimitedCount: 0,
    }, 'status', { get: () => { throw new Error('provider-secret'); } }),
  ]) {
    await assert.rejects(progress(invalid), /^TypeError: Paper MVP provider usage is invalid\.$/u);
  }
  assert.equal(connectionCount, 1);
});

void test('persists the exact 79-digit derived PnL at the accepted 78-digit fee boundary', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL numeric boundary test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const maximumFee = BigInt('9'.repeat(78));
    const repository = new PostgresPaperMvpRepository(pool);
    const run = await repository.startOrResume({
      ...configuration, networkFeeRawPerTransaction: maximumFee,
    }, OWNER, 1_000);
    const boundarySample = createPaperMvpPositionSample({
      ...sample(), buyAmountInRaw: 1n, buyAmountOutRaw: 1n,
      buyMinimumAmountOutRaw: 1n, sellAmountInRaw: 1n, sellAmountOutRaw: 1n,
      sellMinimumAmountOutRaw: 1n, networkFeeRawPerTransaction: maximumFee,
    });
    await repository.recordProgress({
      runId: run.runId, runnerOwnerId: OWNER, expectedUpdatedAtMs: run.updatedAtMs, observedAtMs: 2_000,
      counters: progressCounters,
      providerUsage: Object.freeze({
        status: 'AVAILABLE', creditsUsedStart: 1n, creditsUsedEnd: 2n,
        rateLimitedCount: 0,
      }),
      samples: Object.freeze([boundarySample]), unknownPositions: Object.freeze([]),
    });
    assert.equal((await repository.load(run.runId))?.samples[0]?.modelNetPnlRaw,
      -2n * maximumFee);
  });
});

void test('persists only explicit configuration, sample, and provider projections', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL projection test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const configurationCandidate = Object.freeze({
      ...configuration,
      providerApiKey: 'configuration-api-key-secret',
      secretSentinel: 'configuration-secret-sentinel',
    });
    const typedConfiguration: PaperMvpRunConfiguration = configurationCandidate;
    const sampleCandidate = Object.freeze({
      ...sample(),
      positionId: 'secret-position',
      providerApiKey: 'sample-api-key-secret',
      secretSentinel: 'sample-secret-sentinel',
    });
    const typedSample: PaperMvpPositionSample = sampleCandidate;
    const unknownCandidate = Object.freeze({
      positionId: 'secret-unknown-position',
      reason: 'MISSING_SELL_TRADE' as const,
      providerApiKey: 'unknown-api-key-secret',
      secretSentinel: 'unknown-secret-sentinel',
    });
    const typedUnknown: PaperMvpUnknownPosition = unknownCandidate;
    const providerCandidate = Object.freeze({
      status: 'AVAILABLE' as const,
      creditsUsedStart: 100n,
      creditsUsedEnd: 101n,
      rateLimitedCount: 0,
      providerApiKey: 'provider-api-key-secret',
      secretSentinel: 'provider-secret-sentinel',
    });
    const typedProvider: PaperMvpProviderUsage = providerCandidate;
    const repository = new PostgresPaperMvpRepository(pool);

    const run = await repository.startOrResume(typedConfiguration, OWNER, 1_000);
    const progressed = await repository.recordProgress({
      runId: run.runId,
      runnerOwnerId: OWNER,
      expectedUpdatedAtMs: run.updatedAtMs,
      observedAtMs: 2_000,
      counters: progressCounters,
      providerUsage: typedProvider,
      samples: Object.freeze([typedSample]),
      unknownPositions: Object.freeze([typedUnknown]),
    });
    const stored = await pool.query(
      `SELECT run.configuration_payload,observation.sample_payload
       FROM paper_mvp_runs run JOIN paper_mvp_position_samples observation USING (run_id)
       WHERE run.run_id=$1`,
      [run.runId],
    );
    const storedJson = JSON.stringify(stored.rows);
    assert.doesNotMatch(storedJson, /providerApiKey|secretSentinel|api-key-secret|secret-sentinel/u);
    assert.equal(Object.hasOwn(run.configuration, 'providerApiKey'), false);
    assert.equal(Object.hasOwn(progressed.providerUsage, 'providerApiKey'), false);
  });
});

void test('bounds cumulative observations without charging identical replays', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL observation limit test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const repository = new PostgresPaperMvpRepository(pool);
    const run = await repository.startOrResume(Object.freeze({
      ...configuration,
      targetClosedPositions: 1_000,
    }), OWNER, 1_000);
    const usage = Object.freeze({
      status: 'AVAILABLE' as const,
      creditsUsedStart: 100n,
      creditsUsedEnd: 101n,
      rateLimitedCount: 0,
    });
    const samples = Object.freeze(Array.from({ length: 1_000 }, (_, index) => Object.freeze({
      ...sample(),
      positionId: `bounded-position-${index.toString().padStart(4, '0')}`,
    })));
    assert.equal((await repository.recordProgress({
      runId: run.runId,
      runnerOwnerId: OWNER,
      expectedUpdatedAtMs: run.updatedAtMs,
      observedAtMs: 2_000,
      counters: progressCounters,
      providerUsage: usage,
      samples,
      unknownPositions: Object.freeze([]),
    })).closedPositions, 1_000);
    assert.equal((await repository.recordProgress({
      runId: run.runId,
      runnerOwnerId: OWNER,
      expectedUpdatedAtMs: 2_000,
      observedAtMs: 2_001,
      counters: progressCounters,
      providerUsage: usage,
      samples,
      unknownPositions: Object.freeze([]),
    })).closedPositions, 1_000);

    await assert.rejects(repository.recordProgress({
      runId: run.runId,
      runnerOwnerId: OWNER,
      expectedUpdatedAtMs: 2_001,
      observedAtMs: 2_002,
      counters: progressCounters,
      providerUsage: usage,
      samples: Object.freeze([Object.freeze({
        ...sample(),
        positionId: 'bounded-position-overflow',
      })]),
      unknownPositions: Object.freeze([]),
    }), isConflict('PROGRESS_LIMIT_EXCEEDED'));
    const afterOverflow = await repository.load(run.runId);
    assert.ok(afterOverflow);
    assert.equal(afterOverflow.samples.length, 1_000);
    assert.equal(afterOverflow.run.updatedAtMs, 2_001);

    const unknownPositions = Object.freeze(Array.from({ length: 1_000 }, (_, index) => Object.freeze({
      positionId: `bounded-unknown-${index.toString().padStart(4, '0')}`,
      reason: 'MISSING_SELL_TRADE' as const,
    })));
    assert.equal((await repository.recordProgress({
      runId: run.runId,
      runnerOwnerId: OWNER,
      expectedUpdatedAtMs: 2_001,
      observedAtMs: 2_003,
      counters: progressCounters,
      providerUsage: usage,
      samples: Object.freeze([]),
      unknownPositions,
    })).counters.unknownTerminalPositions, 1_000);
    assert.equal((await repository.recordProgress({
      runId: run.runId,
      runnerOwnerId: OWNER,
      expectedUpdatedAtMs: 2_003,
      observedAtMs: 2_004,
      counters: progressCounters,
      providerUsage: usage,
      samples: Object.freeze([]),
      unknownPositions,
    })).counters.unknownTerminalPositions, 1_000);
    await assert.rejects(repository.recordProgress({
      runId: run.runId,
      runnerOwnerId: OWNER,
      expectedUpdatedAtMs: 2_004,
      observedAtMs: 2_005,
      counters: progressCounters,
      providerUsage: usage,
      samples: Object.freeze([]),
      unknownPositions: Object.freeze([Object.freeze({
        positionId: 'bounded-unknown-overflow',
        reason: 'MISSING_SELL_TRADE',
      })]),
    }), isConflict('PROGRESS_LIMIT_EXCEEDED'));
    const afterUnknownOverflow = await repository.load(run.runId);
    assert.ok(afterUnknownOverflow);
    assert.equal(afterUnknownOverflow.unknownPositions.length, 1_000);
    assert.equal(afterUnknownOverflow.run.updatedAtMs, 2_004);
  });
});

void test('rolls back a distinct valid sample that would exceed the immutable run target', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL run target cap test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const repository = new PostgresPaperMvpRepository(pool);
    const run = await repository.startOrResume(configuration,OWNER,1_000);
    const first = await repository.recordProgress({
      runId:run.runId,runnerOwnerId:OWNER,expectedUpdatedAtMs:run.updatedAtMs,
      observedAtMs:2_000,counters:progressCounters,providerUsage:run.providerUsage,
      samples:Object.freeze([sample()]),unknownPositions:Object.freeze([]),
    });
    const withUnknown = await repository.recordProgress({
      runId:run.runId,runnerOwnerId:OWNER,expectedUpdatedAtMs:first.updatedAtMs,
      observedAtMs:2_500,counters:progressCounters,providerUsage:first.providerUsage,
      samples:Object.freeze([]),unknownPositions:Object.freeze([Object.freeze({
        positionId:'target-full-unknown',reason:'MISSING_SELL_TRADE',
      })]),
    });
    await assert.rejects(repository.recordProgress({
      runId:run.runId,runnerOwnerId:OWNER,expectedUpdatedAtMs:withUnknown.updatedAtMs,
      observedAtMs:3_000,counters:Object.freeze({ ...progressCounters,creationsObserved:2 }),
      providerUsage:withUnknown.providerUsage,
      samples:Object.freeze([Object.freeze({ ...sample(),positionId:'target-overflow' })]),
      unknownPositions:Object.freeze([]),
    }),isConflict('PROGRESS_LIMIT_EXCEEDED'));
    const after = await repository.load(run.runId);
    assert.ok(after);
    assert.equal(after.run.closedPositions,1);
    assert.equal(after.run.updatedAtMs,2_500);
    assert.equal(after.run.counters.creationsObserved,1);
    assert.deepEqual(after.samples.map((value) => value.positionId),['position']);
    assert.deepEqual(after.unknownPositions,[
      { positionId:'target-full-unknown',reason:'MISSING_SELL_TRADE' },
    ]);
  });
});

void test('rejects a stale progress snapshot before inserting observations', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL stale progress test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const repository = new PostgresPaperMvpRepository(pool);
    const run = await repository.startOrResume(configuration, OWNER, 1_000);
    const progressed = await repository.recordProgress({
      runId:run.runId,runnerOwnerId:OWNER,
      expectedUpdatedAtMs:run.updatedAtMs,observedAtMs:2_000,
      counters:progressCounters,providerUsage:run.providerUsage,
      samples:Object.freeze([sample()]),unknownPositions:Object.freeze([]),
    });

    await assert.rejects(repository.recordProgress({
      runId:run.runId,runnerOwnerId:OWNER,
      expectedUpdatedAtMs:run.updatedAtMs,observedAtMs:3_000,
      counters:progressCounters,providerUsage:progressed.providerUsage,
      samples:Object.freeze([Object.freeze({ ...sample(),positionId:'stale-position' })]),
      unknownPositions:Object.freeze([]),
    }), isConflict('PROGRESS_SNAPSHOT_STALE'));
    const stored = await repository.load(run.runId);
    assert.equal(stored?.run.updatedAtMs,2_000);
    assert.deepEqual(stored?.samples.map((value) => value.positionId),['position']);
  });
});

void test('loads one repeatable read snapshot while progress commits concurrently', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL snapshot test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const writer = new PostgresPaperMvpRepository(pool);
    const run = await writer.startOrResume(configuration, OWNER, 1_000);
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
      runId: run.runId, runnerOwnerId: OWNER, expectedUpdatedAtMs: run.updatedAtMs,
      observedAtMs: 2_000, counters: progressCounters,
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
    const run = await repository.startOrResume(configuration, OWNER, 1_000);
    const usage = Object.freeze({
      status: 'AVAILABLE' as const, creditsUsedStart: 100n, creditsUsedEnd: 101n,
      rateLimitedCount: 0,
    });
    await repository.recordProgress({
      runId: run.runId, runnerOwnerId: OWNER, expectedUpdatedAtMs: run.updatedAtMs,
      observedAtMs: 2_000, counters: progressCounters,
      providerUsage: usage, samples: Object.freeze([losingSample()]),
      unknownPositions: Object.freeze([]),
    });
    const fabricatedPass = createPaperMvpReport({
      runId: run.runId, completionReason: 'TARGET_REACHED',
      startedAtMs: run.startedAtMs, completedAtMs: 3_000,
      targetClosedPositions: 1, initialCapitalRaw: configuration.initialCapitalRaw,
      quoteMint: configuration.quoteMint, creationsObserved: 1, entriesRejected: 0,
      samples: Object.freeze([sample()]), unknownTerminalPositions: 0,
      duplicateLogicalBuys: 0, duplicateLogicalSells: 0, providerUsage: usage,
    });
    assert.equal(fabricatedPass.verdict, 'PASS');

    await assert.rejects(repository.terminalize({
      runId: run.runId, runnerOwnerId: OWNER, terminalAtMs: 3_000, state: 'COMPLETED',
      completionReason: 'TARGET_REACHED', report: fabricatedPass, failureCode: null,
    }), isConflict('TERMINALIZATION_CONTRADICTION'));
    const targetEvaluation = createPaperMvpReport({
      runId: run.runId, completionReason: 'TARGET_REACHED',
      startedAtMs: run.startedAtMs, completedAtMs: 3_000,
      targetClosedPositions: 1, initialCapitalRaw: configuration.initialCapitalRaw,
      quoteMint: configuration.quoteMint, creationsObserved: 1, entriesRejected: 0,
      samples: Object.freeze([losingSample()]), unknownTerminalPositions: 0,
      duplicateLogicalBuys: 0, duplicateLogicalSells: 0, providerUsage: usage,
    });
    const mismatchedReasonEvaluation = Object.freeze({
      ...targetEvaluation,
      completionReason: 'TIMEOUT' as const,
    });
    await assert.rejects(repository.terminalize({
      runId: run.runId, runnerOwnerId: OWNER, terminalAtMs: 3_000, state: 'COMPLETED',
      completionReason: 'TIMEOUT', report: mismatchedReasonEvaluation, failureCode: null,
    }), isConflict('TERMINALIZATION_CONTRADICTION'));
    assert.equal((await repository.load(run.runId))?.run.state, 'RUNNING');
  });
});

void test('replacement ownership fences stale progress and terminalization', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL runner fencing test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const repository = new PostgresPaperMvpRepository(pool);
    const first = await repository.startOrResume(configuration, 'owner-a', 1_000);
    const replacement = await repository.startOrResume(configuration, 'owner-b', 2_000);
    assert.equal(replacement.runId, first.runId);
    assert.equal(replacement.runnerOwnerId, 'owner-b');

    await assert.rejects(repository.recordProgress({
      runId: first.runId, runnerOwnerId: 'owner-a', expectedUpdatedAtMs: first.updatedAtMs,
      observedAtMs: 2_001, counters: progressCounters,
      providerUsage: first.providerUsage, samples: Object.freeze([]),
      unknownPositions: Object.freeze([]),
    }), isConflict('RUN_OWNERSHIP_LOST'));
    await assert.rejects(repository.terminalize({
      runId: first.runId, runnerOwnerId: 'owner-a', terminalAtMs: 2_001,
      state: 'FAILED', completionReason: null, report: null, failureCode: 'STALE_OWNER',
    }), isConflict('RUN_OWNERSHIP_LOST'));

    const progressed = await repository.recordProgress({
      runId: first.runId, runnerOwnerId: 'owner-b', expectedUpdatedAtMs: first.updatedAtMs,
      observedAtMs: 2_001, counters: progressCounters,
      providerUsage: first.providerUsage, samples: Object.freeze([]),
      unknownPositions: Object.freeze([]),
    });
    assert.equal(progressed.runnerOwnerId, 'owner-b');
    const terminal = await repository.terminalize({
      runId: first.runId, runnerOwnerId: 'owner-b', terminalAtMs: 2_002,
      state: 'FAILED', completionReason: null, report: null, failureCode: 'REPLACEMENT_STOPPED',
    });
    assert.equal(terminal.runnerOwnerId, null);
    assert.equal(terminal.state, 'FAILED');
  });
});

void test('replacement claim waits for in-flight progress then fences every later stale write', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL fencing barrier test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    const initial = await new PostgresPaperMvpRepository(pool)
      .startOrResume(configuration, 'owner-a', 1_000);
    let resolveShared: (() => void) | undefined;
    const sharedAcquired = new Promise<void>((resolve) => { resolveShared = resolve; });
    let releaseShared: (() => void) | undefined;
    const mayProgress = new Promise<void>((resolve) => { releaseShared = resolve; });
    const oldOwner = new PostgresPaperMvpRepository({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: readonly unknown[]) => {
            const result = await client.query(text, values === undefined ? [] : [...values]);
            if (text.includes('pg_advisory_xact_lock_shared')) {
              resolveShared?.();
              await mayProgress;
            }
            return result;
          },
          release: () => { client.release(); },
        };
      },
    });
    const inFlight = oldOwner.recordProgress({
      runId: initial.runId, runnerOwnerId: 'owner-a', expectedUpdatedAtMs: initial.updatedAtMs,
      observedAtMs: 1_500, counters: progressCounters, providerUsage: initial.providerUsage,
      samples: Object.freeze([]), unknownPositions: Object.freeze([]),
    });
    await sharedAcquired;
    let replacementSettled = false;
    const replacementPromise = new PostgresPaperMvpRepository(pool)
      .startOrResume(configuration, 'owner-b', 2_000)
      .finally(() => { replacementSettled = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(replacementSettled, false);
    releaseShared?.();
    assert.equal((await inFlight).runnerOwnerId, 'owner-a');
    const replacement = await replacementPromise;
    assert.equal(replacement.runnerOwnerId, 'owner-b');
    assert.equal(replacement.updatedAtMs, 1_500);
    await assert.rejects(oldOwner.recordProgress({
      runId: initial.runId, runnerOwnerId: 'owner-a', expectedUpdatedAtMs: 1_500,
      observedAtMs: 2_001, counters: progressCounters, providerUsage: initial.providerUsage,
      samples: Object.freeze([]), unknownPositions: Object.freeze([]),
    }), isConflict('RUN_OWNERSHIP_LOST'));
  });
});

void test('fails closed instead of claiming a legacy v1 run with unknown strategy thresholds', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL legacy configuration test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    await pool.query(`INSERT INTO paper_mvp_runs (
      run_id,strategy_id,strategy_version,quote_mint,target_closed_positions,
      initial_capital_raw,network_fee_raw_per_transaction,max_duration_ms,
      provider_identity,state,started_at,deadline_at,updated_at,payload_version,
      configuration_payload,runner_owner_id
    ) VALUES ('legacy-v1','creation-entry-v1',1,$1,1,1000000,5000,60000,
      'provider:test:v1','RUNNING',$2,$3,$2,1,'{}'::jsonb,'legacy-owner')`, [
      configuration.quoteMint, new Date(1_000), new Date(61_000),
    ]);

    const repository = new PostgresPaperMvpRepository(pool);
    await assert.rejects(
      repository.startOrResume(configuration, OWNER, 2_000),
      isConflict('ACTIVE_RUN_INCOMPATIBLE'),
    );
    assert.deepEqual((await pool.query(
      "SELECT runner_owner_id,payload_version FROM paper_mvp_runs WHERE run_id='legacy-v1'",
    )).rows, [{ runner_owner_id:'legacy-owner', payload_version:1 }]);
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
    const run = await repository.startOrResume(configuration, OWNER, 1_000);
    assert.equal(run.state, 'RUNNING');
    assert.equal(run.startedAtMs, 1_000);
    assert.equal(run.deadlineAtMs, 61_000);
    assert.deepEqual((await repository.startOrResume(configuration, OWNER, 2_000)).configuration, configuration);
    await assert.rejects(
      repository.startOrResume({ ...configuration, targetClosedPositions: 2 }, OWNER, 2_000),
      isConflict('ACTIVE_RUN_INCOMPATIBLE'),
    );
    await assert.rejects(
      repository.startOrResume({ ...configuration, externalUniqueBuyersTarget: 11 }, OWNER, 2_000),
      isConflict('ACTIVE_RUN_INCOMPATIBLE'),
    );
    await assert.rejects(
      repository.startOrResume({ ...configuration, takeProfitMultiplierBps: 25_000n }, OWNER, 2_000),
      isConflict('ACTIVE_RUN_INCOMPATIBLE'),
    );
    await assert.rejects(
      pool.query(`INSERT INTO paper_mvp_runs (
        run_id,strategy_id,strategy_version,quote_mint,target_closed_positions,
        initial_capital_raw,network_fee_raw_per_transaction,max_duration_ms,
        external_unique_buyers_target,take_profit_multiplier_bps,
        provider_identity,state,started_at,deadline_at,updated_at,
        payload_version,configuration_payload,runner_owner_id
      ) SELECT 'second-active',strategy_id,strategy_version,quote_mint,target_closed_positions,
        initial_capital_raw,network_fee_raw_per_transaction,max_duration_ms,
        external_unique_buyers_target,take_profit_multiplier_bps,
        provider_identity,state,started_at,deadline_at,updated_at,
        payload_version,configuration_payload,'second-owner'
        FROM paper_mvp_runs WHERE run_id=$1`, [run.runId]),
      /paper_mvp_runs_one_active_idx/u,
    );

    const firstSample = sample();
    const progressed = await repository.recordProgress({
      runId: run.runId, runnerOwnerId: OWNER, expectedUpdatedAtMs: run.updatedAtMs,
      observedAtMs: 2_000, counters: progressCounters,
      providerUsage: Object.freeze({
        status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 101n,
        rateLimitedCount: 0,
      }),
      samples: Object.freeze([firstSample]),
      unknownPositions: Object.freeze([]),
    });
    assert.equal(progressed.closedPositions, 1);
    assert.deepEqual([progressed.counters.openedPositions, progressed.counters.openPositions], [2, 1]);
    const replayed = await repository.recordProgress({
      runId: run.runId, runnerOwnerId: OWNER, expectedUpdatedAtMs: progressed.updatedAtMs,
      observedAtMs: 2_001, counters: progressCounters,
      providerUsage: progressed.providerUsage,
      samples: Object.freeze([firstSample]),
      unknownPositions: Object.freeze([]),
    });
    assert.equal(replayed.closedPositions, 1);
    assert.deepEqual([replayed.counters.openedPositions, replayed.counters.openPositions], [2, 1]);

    const withUnknown = await repository.recordProgress({
      runId: run.runId, runnerOwnerId: OWNER, expectedUpdatedAtMs: replayed.updatedAtMs,
      observedAtMs: 2_002, counters: progressCounters,
      providerUsage: progressed.providerUsage, samples: Object.freeze([]),
      unknownPositions: Object.freeze([Object.freeze({
        positionId: 'position-unknown', reason: 'MISSING_SELL_TRADE',
      })]),
    });
    assert.equal(withUnknown.counters.unknownTerminalPositions, 1);
    assert.equal((await repository.recordProgress({
      runId: run.runId, runnerOwnerId: OWNER, expectedUpdatedAtMs: withUnknown.updatedAtMs,
      observedAtMs: 2_003, counters: progressCounters,
      providerUsage: progressed.providerUsage, samples: Object.freeze([]),
      unknownPositions: Object.freeze([Object.freeze({
        positionId: 'position-unknown', reason: 'MISSING_SELL_TRADE',
      })]),
    })).counters.unknownTerminalPositions, 1);
    await assert.rejects(repository.recordProgress({
      runId: run.runId, runnerOwnerId: OWNER, expectedUpdatedAtMs: 2_003,
      observedAtMs: 2_004, counters: progressCounters,
      providerUsage: progressed.providerUsage, samples: Object.freeze([]),
      unknownPositions: Object.freeze([Object.freeze({
        positionId: 'position-unknown', reason: 'MISSING_BUY_TRADE',
      })]),
    }), isConflict('SAMPLE_CONTRADICTION'));

    await assert.rejects(repository.recordProgress({
      runId: run.runId, runnerOwnerId: OWNER, expectedUpdatedAtMs: 2_003,
      observedAtMs: 2_004,
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
      runId: run.runId, completionReason: 'TARGET_REACHED',
      startedAtMs: run.startedAtMs, completedAtMs: 3_000,
      targetClosedPositions: 1, initialCapitalRaw: configuration.initialCapitalRaw,
      quoteMint: configuration.quoteMint, creationsObserved: 1, entriesRejected: 0,
      openedPositions: 2, openPositions: 1,
      samples: Object.freeze([firstSample]), unknownTerminalPositions: 1,
      duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
      providerUsage: progressed.providerUsage,
    });
    const terminal = await repository.terminalize({
      runId: run.runId, runnerOwnerId: OWNER, terminalAtMs: 3_000, state: 'COMPLETED', completionReason: 'TARGET_REACHED', report,
      failureCode: null,
    });
    assert.equal(terminal.state, 'COMPLETED');
    assert.deepEqual([terminal.counters.openedPositions, terminal.counters.openPositions], [2, 1]);
    assert.equal(terminal.purgeAfterMs, 3_000 + 4 * 60 * 60 * 1_000);
    assert.equal((await repository.terminalize({
      runId: run.runId, runnerOwnerId: OWNER, terminalAtMs: 3_000, state: 'COMPLETED', completionReason: 'TARGET_REACHED', report,
      failureCode: null,
    })).state, 'COMPLETED');
    await assert.rejects(
      pool.query(`UPDATE paper_mvp_runs SET entries_rejected=entries_rejected+1
        WHERE run_id=$1`, [run.runId]),
      /terminal.*immutable/iu,
    );

    const unavailableRun = await repository.startOrResume(configuration, OWNER, 4_000);
    const unavailableReport = createPaperMvpReport({
      runId: unavailableRun.runId, completionReason: 'TARGET_REACHED',
      startedAtMs: 4_000, completedAtMs: 5_000,
      targetClosedPositions: 1, initialCapitalRaw: configuration.initialCapitalRaw,
      quoteMint: configuration.quoteMint, creationsObserved: 0, entriesRejected: 0,
      samples: Object.freeze([]), unknownTerminalPositions: 0,
      duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
      providerUsage: unavailableRun.providerUsage,
    });
    assert.equal((await repository.terminalize({
      runId: unavailableRun.runId, runnerOwnerId: OWNER, terminalAtMs: 5_000, state: 'COMPLETED',
      completionReason: 'TARGET_REACHED', report: unavailableReport, failureCode: null,
    })).state, 'COMPLETED');

    const failedRun = await repository.startOrResume(configuration, OWNER, 6_000);
    assert.equal((await repository.terminalize({
      runId: failedRun.runId, runnerOwnerId: OWNER, terminalAtMs: 7_000, state: 'FAILED',
      completionReason: null, report: null, failureCode: 'SOURCE_CONTRADICTION',
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
