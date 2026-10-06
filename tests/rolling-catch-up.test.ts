import assert from 'node:assert/strict';
import bs58 from 'bs58';
import test from 'node:test';
import type { Context, Logs, PublicKey } from '@solana/web3.js';
import { CatchUpScanner, type CatchUpSource } from '../src/application/catch-up-scanner.js';
import { CatchUpSourceError } from '../src/solana/rpc/catch-up-source.js';
import { guardLiveDecisionConsumer, StartupScanner } from '../src/application/production-listener-factory.js';
import type { ProcessingCheckpoint, TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import type { TransactionInboxRepository } from '../src/ports/transaction-inbox-repository.js';
import type { FinalizedProgramFrontier } from '../src/application/program-finalized-frontier.js';
import { SolanaProgramSubscriber, type ProgramLogsCallback, type ProgramLogsConnection } from '../src/solana/rpc/program-subscriber.js';

void test('rolling catch-up advances both durable checkpoints across more than 20,000 total signatures', async () => {
  const repository = new DurableInbox();
  const scheduler = new ManualScheduler();
  let target = 0;
  const connection = new FakeConnection();
  const subscriber = new SolanaProgramSubscriber(connection, repository);
  await subscriber.start();
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      const cursor = before === undefined ? target : slotFromSignature(before) - 1;
      const minimum = programId === PUMP_PROGRAM_ID || programId === PUMPSWAP_PROGRAM_ID ? 0 : -1;
      return Array.from({ length: Math.min(limit, cursor - minimum + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const scanner = new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 });
  const startup = new StartupScanner(scanner, async (program) => frontier(program, target), undefined, {
    intervalsMs: { launchpad: 5_000, market: 5_000 },
    scheduler,
    readCheckpoint: (program) => repository.readCheckpoint(program),
    isSubscriberRunning: () => subscriber.state === 'RUNNING',
  });

  await startup.scan();
  target = 8_000;
  emitRange(connection, 1, target);
  await subscriber.drainDurableEnqueues();
  await scheduler.fireNext();
  await scheduler.fireNext();
  await waitUntil(() => startup.metrics().programs.launchpad.sweepsSucceeded === 2
    && startup.metrics().programs.market.sweepsSucceeded === 2);
  target = 16_000;
  emitRange(connection, 8_001, target);
  await subscriber.drainDurableEnqueues();
  await scheduler.fireNext();
  await scheduler.fireNext();
  await waitUntil(() => startup.metrics().programs.launchpad.sweepsSucceeded === 3
    && startup.metrics().programs.market.sweepsSucceeded === 3);

  const metrics = startup.metrics();
  assert.equal(metrics.programs.launchpad.checkpointSlot, '16000');
  assert.equal(metrics.programs.market.checkpointSlot, '16000');
  assert.equal(metrics.programs.launchpad.sweepsSucceeded, 3);
  assert.equal(metrics.programs.market.sweepsSucceeded, 3);
  assert.equal(repository.rows.size, 16_000);
  assert.deepEqual(repository.rows.get(signature(5)), new Set(['WEBSOCKET', 'CATCH_UP']));
  assert.equal(subscriber.metrics().eventsReceived, 32_000);
  assert.equal(subscriber.metrics().enqueuesCompleted, 32_000);
  assert.equal(startup.state(), 'RUNNING');
  await startup.close();
  await subscriber.close();
});

void test('frequent market HTTP 429 leaves its checkpoint unchanged and records per-sweep RPC metrics', async () => {
  const repository = new DurableInbox();
  const counts = {
    launchpad: { requestCount: 0, http429Count: 0, retryCount: 0, retryBackoffTotalMs: 0, otherRpcErrors: 0 },
    market: { requestCount: 0, http429Count: 0, retryCount: 0, retryBackoffTotalMs: 0, otherRpcErrors: 0 },
  };
  const calls = new Map<string, number>();
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      const program = programId === PUMP_PROGRAM_ID ? 'launchpad' : 'market';
      const count = (calls.get(program) ?? 0) + 1;
      calls.set(program, count);
      counts[program].requestCount += 1;
      if (program === 'market' && count === 2) {
        counts.market.http429Count += 1;
        throw new CatchUpSourceError('request', 'market', {
          pageCount: 0, signaturesRead: 0, newestSlot: null, oldestSlot: null,
        });
      }
      const target = count === 1 ? 10 : 11;
      const cursor = before === undefined ? target : slotFromSignature(before) - 1;
      return Array.from({ length: Math.min(limit, cursor + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const frontierReads = new Map<string, number>();
  const startup = new StartupScanner(new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 }),
    async (program) => {
      const count = (frontierReads.get(program) ?? 0) + 1;
      frontierReads.set(program, count);
      return frontier(program, count === 1 ? 10 : 11);
    }, undefined, {
      intervalsMs: { launchpad: 15_000, market: 5_000 },
      scheduler: new ManualScheduler(),
      readCheckpoint: (program) => repository.readCheckpoint(program),
      getRpcMetrics: (program) => Object.freeze({ ...counts[program] }),
    });

  await startup.scan();

  assert.equal(startup.metrics().coverageState, 'DEGRADED');
  assert.equal(repository.checkpointSlot('market'), 10n);
  const failedSweep = startup.metrics().programs.market.lastSweep;
  assert.equal(failedSweep?.program, 'market');
  assert.equal(failedSweep?.outcome, 'FAILED');
  assert.ok((failedSweep?.completedAtMs ?? 0) >= (failedSweep?.startedAtMs ?? 1));
  assert.equal(failedSweep?.durationMs, (failedSweep?.completedAtMs ?? 0) - (failedSweep?.startedAtMs ?? 0));
  assert.equal(failedSweep?.checkpointSlotBefore, '10');
  assert.equal(failedSweep?.frontierSlot, '11');
  assert.equal(failedSweep?.estimatedHeadDistanceSlots, '1');
  assert.equal(failedSweep?.http429Count, 1);
  assert.equal(failedSweep?.checkpointSlotAfter, '10');
  await startup.close();
});

void test('the first post-bootstrap sweeps start immediately and independently per program', async () => {
  const repository = new DurableInbox();
  const scheduler = new ManualScheduler();
  const calls = new Map<string, number>();
  let launchpadSweepEntered: (() => void) | undefined;
  let releaseLaunchpadSweep: (() => void) | undefined;
  let marketSweepEntered: (() => void) | undefined;
  let releaseMarketSweep: (() => void) | undefined;
  let launchpadSweepStarted = false;
  let marketSweepStarted = false;
  const launchpadEntered = new Promise<void>((resolve) => { launchpadSweepEntered = resolve; });
  const marketEntered = new Promise<void>((resolve) => { marketSweepEntered = resolve; });
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      const program = programId === PUMP_PROGRAM_ID ? 'launchpad' : 'market';
      const count = (calls.get(program) ?? 0) + 1;
      calls.set(program, count);
      if (count === 2 && program === 'launchpad') {
        launchpadSweepStarted = true;
        launchpadSweepEntered?.();
        await new Promise<void>((resolve) => { releaseLaunchpadSweep = resolve; });
      }
      if (count === 2 && program === 'market') {
        marketSweepStarted = true;
        marketSweepEntered?.();
        await new Promise<void>((resolve) => { releaseMarketSweep = resolve; });
      }
      const cursor = before === undefined ? (count === 1 ? 10 : 20) : slotFromSignature(before) - 1;
      const minimum = program === 'launchpad' || program === 'market' ? 0 : -1;
      return Array.from({ length: Math.min(limit, cursor - minimum + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const frontierReads = new Map<string, number>();
  const startup = new StartupScanner(
    new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 }),
    async (program) => {
      const count = (frontierReads.get(program) ?? 0) + 1;
      frontierReads.set(program, count);
      return frontier(program, count === 1 ? 10 : 20);
    },
    undefined,
    { intervalMs: 15_000, scheduler, readCheckpoint: (program) => repository.readCheckpoint(program) },
  );

  const starting = startup.scan();
  try {
    await waitUntil(() => launchpadSweepStarted && marketSweepStarted);
    await Promise.all([launchpadEntered, marketEntered]);
    assert.equal(startup.metrics().programs.launchpad.sweepActive, true);
    assert.equal(startup.metrics().programs.market.sweepActive, true);
    assert.equal(startup.metrics().coverageState, 'WARMING_UP');
    releaseLaunchpadSweep?.();
    await waitUntil(() => startup.metrics().programs.launchpad.sweepsSucceeded === 1);
    assert.equal(startup.metrics().coverageState, 'WARMING_UP',
      'coverage stays warming until both initial sweeps complete');
    assert.equal(startup.metrics().programs.market.sweepActive, true);
    releaseMarketSweep?.();
  } finally {
    releaseLaunchpadSweep?.();
    releaseMarketSweep?.();
  }
  await starting;

  assert.equal(repository.checkpointSlot('launchpad'), 20n);
  assert.equal(repository.checkpointSlot('market'), 20n);
  assert.equal(startup.metrics().coverageState, 'HEALTHY');
  assert.equal(startup.metrics().programs.launchpad.sweepsSucceeded, 1);
  assert.equal(startup.metrics().programs.market.sweepsSucceeded, 1);
  assert.equal(scheduler.pendingCount, 2, 'each program has its own periodic timer after the immediate sweep');
  await startup.close();
});

void test('market and launchpad use independent rolling cadences without overlapping a market sweep', async () => {
  const repository = new DurableInbox();
  const scheduler = new ManualScheduler();
  const calls = new Map<string, number>();
  let releaseLaunchpad: (() => void) | undefined;
  let launchpadSweepEntered: (() => void) | undefined;
  const launchpadEntered = new Promise<void>((resolve) => { launchpadSweepEntered = resolve; });
  let releaseMarket: (() => void) | undefined;
  let marketSweepEntered: (() => void) | undefined;
  const marketEntered = new Promise<void>((resolve) => { marketSweepEntered = resolve; });
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      const program = programId === PUMP_PROGRAM_ID ? 'launchpad' : 'market';
      const count = (calls.get(program) ?? 0) + 1;
      calls.set(program, count);
      if (program === 'launchpad' && count === 2) {
        launchpadSweepEntered?.();
        await new Promise<void>((resolve) => { releaseLaunchpad = resolve; });
      }
      if (program === 'market' && count === 3) {
        marketSweepEntered?.();
        await new Promise<void>((resolve) => { releaseMarket = resolve; });
      }
      const target = count <= 1 ? 10 : count <= 2 ? 20 : 30;
      const cursor = before === undefined ? target : slotFromSignature(before) - 1;
      return Array.from({ length: Math.min(limit, cursor + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const frontierReads = new Map<string, number>();
  const startup = new StartupScanner(new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 }),
    async (program) => {
      const count = (frontierReads.get(program) ?? 0) + 1;
      frontierReads.set(program, count);
      return frontier(program, count === 1 ? 10 : count === 2 ? 20 : 30);
    }, undefined, {
      intervalsMs: { launchpad: 15_000, market: 5_000 },
      scheduler,
      // A frozen clock keeps the cadence assertions independent of wall-clock jitter.
      now: () => 1_700_000_000_000,
      readCheckpoint: (program) => repository.readCheckpoint(program),
    });

  const boot = startup.scan();
  await launchpadEntered;
  await waitUntil(() => startup.metrics().programs.market.sweepsSucceeded === 1);
  assert.equal(scheduler.delays.length, 1);
  const marketDelay = scheduler.delays[0];
  assert.ok(marketDelay !== undefined && marketDelay >= 4_999 && marketDelay <= 5_000);
  releaseLaunchpad?.();
  await boot;
  const nextMarketDelay = scheduler.delays[0];
  assert.ok(nextMarketDelay !== undefined && nextMarketDelay >= 4_999 && nextMarketDelay <= 5_000);
  const launchpadDelay = scheduler.delays[1];
  assert.ok(launchpadDelay !== undefined && launchpadDelay >= 14_999 && launchpadDelay <= 15_000);

  await scheduler.fireNext();
  await marketEntered;
  assert.equal(startup.metrics().programs.market.sweepActive, true);
  assert.equal(scheduler.pendingCount, 1, 'no second market timer is scheduled while its sweep is active');
  releaseMarket?.();
  await waitUntil(() => startup.metrics().programs.market.sweepsSucceeded === 2);
  assert.equal(startup.metrics().programs.launchpad.sweepsSucceeded, 1);
  assert.equal(repository.checkpointSlot('market'), 30n);
  await startup.close();
});

void test('a launchpad-only startup scanner never reads or sweeps the market program', async () => {
  const repository = new DurableInbox();
  const scheduler = new ManualScheduler();
  const listedPrograms = new Set<string>();
  const frontierPrograms: string[] = [];
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      listedPrograms.add(programId);
      const cursor = before === undefined ? 10 : slotFromSignature(before) - 1;
      return Array.from({ length: Math.min(limit, cursor + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const scanner = new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20, programs: ['launchpad'] });
  const startup = new StartupScanner(scanner, async (program) => {
    frontierPrograms.push(program);
    return frontier(program, 10);
  }, undefined, {
    programs: ['launchpad'],
    intervalsMs: { launchpad: 15_000 },
    scheduler,
    readCheckpoint: (program) => repository.readCheckpoint(program),
  });

  const result = await startup.scan();

  assert.deepEqual([...new Set(frontierPrograms)], ['launchpad']);
  assert.deepEqual([...listedPrograms], [PUMP_PROGRAM_ID]);
  assert.equal(result.programs.market, undefined);
  assert.equal(result.programs.launchpad.durableFrontier.slot, '10');
  assert.equal(startup.metrics().programs.launchpad.sweepsSucceeded, 1);
  assert.equal(startup.metrics().programs.market.sweepsSucceeded, 0);
  assert.equal(startup.isCoverageHealthy(), true);
  assert.equal(scheduler.pendingCount, 1, 'only the launchpad has a periodic timer');
  await startup.close();
});

void test('a startup scanner rejects an invalid program list', () => {
  const scanner = new CatchUpScanner({ list: async () => [] }, new DurableInbox(), { pageSize: 10, maxPages: 2 });
  for (const programs of [[], ['market', 'market'], ['unknown'], ['market']]) {
    assert.throws(() => new StartupScanner(scanner, async (program) => frontier(program, 1), undefined, {
      programs: programs as never,
    }), TypeError);
  }
});

void test('a startup scanner inherits the catch-up scanner program list when none is given', async () => {
  const repository = new DurableInbox();
  const listedPrograms = new Set<string>();
  const frontierPrograms = new Set<string>();
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      listedPrograms.add(programId);
      const cursor = before === undefined ? 10 : slotFromSignature(before) - 1;
      return Array.from({ length: Math.min(limit, cursor + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const scanner = new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20, programs: ['launchpad'] });
  assert.deepEqual(scanner.enabledPrograms(), ['launchpad']);
  const startup = new StartupScanner(scanner, async (program) => {
    frontierPrograms.add(program);
    return frontier(program, 10);
  }, undefined, {
    intervalsMs: { launchpad: 15_000 },
    scheduler: new ManualScheduler(),
    readCheckpoint: (program) => repository.readCheckpoint(program),
  });

  const result = await startup.scan();

  assert.deepEqual([...frontierPrograms], ['launchpad']);
  assert.deepEqual([...listedPrograms], [PUMP_PROGRAM_ID]);
  assert.equal(result.programs.market, undefined);
  assert.equal(startup.isCoverageHealthy(), true);
  await startup.close();
});

void test('a startup scanner refuses a program list that differs from its catch-up scanner', () => {
  const launchpadOnly = new CatchUpScanner({ list: async () => [] }, new DurableInbox(), {
    pageSize: 10, maxPages: 2, programs: ['launchpad'],
  });
  const both = new CatchUpScanner({ list: async () => [] }, new DurableInbox(), { pageSize: 10, maxPages: 2 });
  assert.deepEqual(both.enabledPrograms(), ['launchpad', 'market']);
  assert.throws(() => new StartupScanner(launchpadOnly, async (program) => frontier(program, 1), undefined, {
    programs: ['launchpad', 'market'],
  }), { name: 'TypeError', message: 'Startup and catch-up scanner program lists differ.' });
  assert.throws(() => new StartupScanner(both, async (program) => frontier(program, 1), undefined, {
    programs: ['launchpad'],
  }), { name: 'TypeError', message: 'Startup and catch-up scanner program lists differ.' });
  assert.doesNotThrow(() => new StartupScanner(both, async (program) => frontier(program, 1), undefined, {
    programs: ['market', 'launchpad'],
  }));
});

void test('a market window exceeding 20,000 signatures within five seconds stays degraded without checkpoint movement', async () => {
  const repository = new DurableInbox();
  let launchpadCalls = 0;
  let marketCalls = 0;
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      const market = programId === PUMPSWAP_PROGRAM_ID;
      const call = market ? ++marketCalls : ++launchpadCalls;
      const target = call === 1 ? 10 : market ? 20_011 : 11;
      const cursor = before === undefined ? target : slotFromSignature(before) - 1;
      return Array.from({ length: Math.min(limit, cursor + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  let clockMs = 1_000;
  const frontierReads = new Map<string, number>();
  const startup = new StartupScanner(new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 }),
    async (program) => {
      const call = (frontierReads.get(program) ?? 0) + 1;
      frontierReads.set(program, call);
      if (program === 'market' && call === 2) clockMs += 4_999;
      return frontier(program, program === 'market' && call === 2 ? 20_011 : 10);
    }, undefined, {
      intervalsMs: { launchpad: 15_000, market: 5_000 },
      scheduler: new ManualScheduler(),
      now: () => clockMs,
      readCheckpoint: (program) => repository.readCheckpoint(program),
    });

  await startup.scan();

  assert.equal(startup.metrics().programs.market.lastSweep?.durationMs, 4_999,
    'fixture generates the whole failing interval before the five-second frontier');
  assert.equal(startup.metrics().programs.market.lastSweep?.signaturesRead, 20_000);
  assert.equal(startup.metrics().programs.market.lastSweep?.pageCount, 20);
  assert.equal(startup.metrics().coverageState, 'DEGRADED');
  assert.equal(repository.checkpointSlot('market'), 10n);
  await startup.close();
});

void test('a rolling sweep over the 20,000-signature budget is visible and leaves checkpoints unchanged', async () => {
  const repository = new DurableInbox();
  let sourceCalls = 0;
  const source: CatchUpSource = {
    async list(_programId, before, limit) {
      sourceCalls += 1;
      const target = sourceCalls <= 2 ? 10 : 20_011;
      const cursor = before === undefined ? target : slotFromSignature(before) - 1;
      return Array.from({ length: Math.min(limit, cursor + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const scheduler = new ManualScheduler();
  let frontierCalls = 0;
  const startup = new StartupScanner(new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 }),
    async (program) => {
      frontierCalls += 1;
      return frontier(program, frontierCalls <= 2 ? 10 : 20_011);
    }, undefined, { intervalMs: 5_000, scheduler, readCheckpoint: (program) => repository.readCheckpoint(program) });
  await startup.scan();
  const metrics = startup.metrics();
  assert.equal(metrics.state, 'DEGRADED');
  assert.equal(metrics.programs.launchpad.checkpointSlot, '10');
  assert.equal(metrics.programs.launchpad.sweepsFailed, 1);
  assert.equal(metrics.programs.launchpad.lastSweepPageCount, 20);
  assert.equal(metrics.programs.launchpad.lastSweepSignatureCount, 20_000);
  assert.equal(repository.checkpointSlot('launchpad'), 10n);
  await startup.close();
});

void test('a failed first rolling sweep degrades coverage and blocks only new live decisions', async () => {
  const repository = new DurableInbox();
  let calls = 0;
  const source: CatchUpSource = {
    async list(_programId, before, limit) {
      calls += 1;
      if (calls > 2) throw Object.assign(new Error('simulated RPC failure'), { code: 'RPC_UNAVAILABLE' });
      const cursor = before === undefined ? 10 : slotFromSignature(before) - 1;
      return Array.from({ length: Math.min(limit, cursor + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  let frontierCalls = 0;
  const startup = new StartupScanner(new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 }),
    async (program) => {
      frontierCalls += 1;
      return frontier(program, frontierCalls <= 2 ? 10 : 11);
    }, undefined, {
      intervalMs: 15_000, scheduler: new ManualScheduler(),
      readCheckpoint: (program) => repository.readCheckpoint(program),
    });
  await startup.scan();
  assert.equal(startup.metrics().coverageState, 'DEGRADED');
  assert.equal(startup.metrics().programs.launchpad.sweepsFailed, 1);
  let decisions = 0;
  const guarded = guardLiveDecisionConsumer(async () => { decisions += 1; },
    () => startup.isCoverageHealthy(), () => undefined);
  await guarded?.();
  assert.equal(decisions, 0, 'degraded catch-up coverage rejects a new BUY decision');
  assert.equal(repository.checkpointSlot('launchpad'), 10n);
  assert.equal(repository.checkpointSlot('market'), 10n);
  await startup.close();
});

void test('WebSocket loss blocks a rolling sweep without advancing its checkpoint', async () => {
  const repository = new DurableInbox();
  const scheduler = new ManualScheduler();
  const target = 10;
  let websocketRunning = true;
  const startup = makeStartup(repository, scheduler, () => target, () => websocketRunning);
  await startup.scan();
  const previous = repository.checkpointSlot('launchpad');
  websocketRunning = false;
  await scheduler.fireNext();
  await waitUntil(() => !startup.metrics().sweepActive && startup.metrics().programs.launchpad.sweepsFailed === 1);
  assert.equal(startup.state(), 'DEGRADED');
  assert.equal(repository.checkpointSlot('launchpad'), previous);
  assert.equal(startup.metrics().programs.launchpad.lastErrorCode, 'WEBSOCKET_NOT_RUNNING');
  await startup.close();
});

void test('activity after a fixed frontier remains in WS inbox and is covered by the next sweep', async () => {
  const repository = new DurableInbox();
  const scheduler = new ManualScheduler();
  let target = 10;
  let activityEmitted = false;
  const source: CatchUpSource = {
    async list(_programId, before, limit) {
      if (!activityEmitted) {
        activityEmitted = true;
        target = 20;
        await repository.enqueue(notification(signature(20), 20, 'WEBSOCKET', PUMP_PROGRAM_ID));
      }
      const cursor = before === undefined ? target : slotFromSignature(before) - 1;
      return Array.from({ length: Math.min(limit, cursor + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const catchUp = new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 });
  const startup = new StartupScanner(catchUp, async (program) => frontier(program, target), undefined, {
    intervalMs: 5_000, scheduler, readCheckpoint: (program) => repository.readCheckpoint(program),
  });

  await startup.scan();
  assert.equal(repository.checkpointSlot('launchpad'), 20n);
  assert.equal(repository.rows.get(signature(20))?.has('WEBSOCKET'), true);
  target = 20;
  await scheduler.fireNext();
  await waitUntil(() => startup.metrics().programs.launchpad.sweepsSucceeded === 2);
  assert.equal(repository.checkpointSlot('launchpad'), 20n);
  assert.deepEqual(repository.rows.get(signature(20)), new Set(['WEBSOCKET', 'CATCH_UP']));
  await startup.close();
});

void test('a new scanner process resumes from the last successfully stored rolling frontier', async () => {
  const repository = new DurableInbox();
  let target = 10;
  const first = makeStartup(repository, new ManualScheduler(), () => target);
  await first.scan();
  target = 30;
  const restarted = makeStartup(repository, new ManualScheduler(), () => target);
  await restarted.scan();
  assert.equal(restarted.state(), 'RUNNING');
  assert.equal(repository.checkpointSlot('launchpad'), 30n);
  assert.equal(restarted.metrics().programs.launchpad.lastDurableFrontierSlot, '30');
  await first.close();
  await restarted.close();
});

void test('restart after enqueue crash replays the same interval idempotently before checkpointing', async () => {
  const repository = new DurableInbox();
  repository.failOnceOn = signature(50);
  const first = makeStartup(repository, new ManualScheduler(), () => 100);
  await assert.rejects(first.scan());
  assert.equal(repository.checkpointSlot('launchpad'), 0n);
  assert.ok(repository.rows.size > 0);
  await first.close();

  const restarted = makeStartup(repository, new ManualScheduler(), () => 100);
  await restarted.scan();
  assert.equal(repository.checkpointSlot('launchpad'), 100n);
  assert.equal(repository.checkpointSlot('market'), 100n);
  assert.equal(repository.rows.size, 100);
  await restarted.close();
});

void test('rolling coordinator never overlaps a sweep for the same programs', async () => {
  const repository = new DurableInbox();
  const scheduler = new ManualScheduler();
  let target = 10;
  let blockNextSweep = false;
  let enteredSweep: (() => void) | undefined;
  let releaseSweep: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enteredSweep = resolve; });
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      if (blockNextSweep) {
        blockNextSweep = false;
        enteredSweep?.();
        await new Promise<void>((resolve) => { releaseSweep = resolve; });
      }
      const cursor = before === undefined ? target : slotFromSignature(before) - 1;
      const minimum = programId === PUMP_PROGRAM_ID || programId === PUMPSWAP_PROGRAM_ID ? 0 : -1;
      return Array.from({ length: Math.min(limit, cursor - minimum + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const startup = new StartupScanner(new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 }),
    async (program) => frontier(program, target), undefined, {
      intervalMs: 5_000, scheduler, readCheckpoint: (program) => repository.readCheckpoint(program),
    });
  await startup.scan();
  target = 20;
  blockNextSweep = true;
  await scheduler.fireNext();
  await entered;
  assert.equal(scheduler.pendingCount, 1, 'the other program retains its independent timer');
  assert.equal(startup.metrics().sweepActive, true);
  await scheduler.fireNext();
  await waitUntil(() => startup.metrics().programs.market.sweepsSucceeded === 2);
  assert.equal(startup.metrics().programs.launchpad.sweepActive, true,
    'the launchpad sweep remains active while market completes independently');
  releaseSweep?.();
  await waitUntil(() => startup.metrics().programs.launchpad.sweepsSucceeded === 2);
  assert.equal(scheduler.pendingCount, 2);
  await startup.close();
});

void test('cadence is measured between frontier sweeps and accounts for the prior sweep duration', async () => {
  const repository = new DurableInbox();
  const scheduler = new ManualScheduler();
  let now = 1_000;
  let listCalls = 0;
  let frontierCalls = 0;
  let observedHead = 10;
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      listCalls += 1;
      if (listCalls > 2) now += 4_500;
      const checkpoint = repository.checkpointSlot(programId === PUMP_PROGRAM_ID ? 'launchpad' : 'market');
      const newest = Math.max(Number(checkpoint), observedHead);
      const cursor = before === undefined ? newest : slotFromSignature(before) - 1;
      return Array.from({ length: Math.min(limit, cursor + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const scanner = new StartupScanner(new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 }),
    async (program) => {
      frontierCalls += 1;
      if (frontierCalls > 2) observedHead = 20;
      return frontier(program, frontierCalls <= 2 ? 10 : 20);
    }, undefined, {
      intervalMs: 15_000,
      scheduler,
      now: () => now,
      readCheckpoint: (program) => repository.readCheckpoint(program),
    });

  await scanner.scan();
  assert.equal(now, 10_000);
  assert.deepEqual(scheduler.delays, [6_000, 6_000]);
  assert.equal(scheduler.lastDelayMs, 6_000);
  await scanner.close();
});

function slotFromSignature(value: string): number {
  return Buffer.from(bs58.decode(value)).readUInt32BE(60);
}

function signature(slot: number): string {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(slot, 60);
  return bs58.encode(bytes);
}

function frontier(program: 'launchpad' | 'market', slot: number): FinalizedProgramFrontier {
  return Object.freeze({ program, slot: BigInt(slot), signature: signature(slot), confirmationStatus: 'finalized' });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(predicate(), true, 'rolling sweep did not complete before the test deadline');
}

class ManualScheduler {
  private readonly callbacks: (() => void)[] = [];
  public readonly delays: number[] = [];
  public lastDelayMs: number | null = null;

  public schedule(callback: () => void, delayMs: number): number {
    this.lastDelayMs = delayMs;
    this.delays.push(delayMs);
    this.callbacks.push(callback);
    return this.callbacks.length;
  }

  public cancel(_handle: unknown): void {}

  public get pendingCount(): number { return this.callbacks.length; }

  public async fireNext(): Promise<void> {
    const callback = this.callbacks.shift();
    assert.ok(callback, 'expected a scheduled rolling sweep');
    callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class FakeConnection implements ProgramLogsConnection {
  private nextId = 0;
  private readonly listeners = new Map<number, { program: string; callback: ProgramLogsCallback }>();
  private readonly states = new Map<number, (state: string) => void>();

  public onLogs(program: PublicKey, callback: ProgramLogsCallback): number {
    const id = ++this.nextId;
    this.listeners.set(id, { program: program.toBase58(), callback });
    return id;
  }

  public watchSubscriptionState(id: number, callback: (state: string) => void): () => void {
    this.states.set(id, callback);
    setImmediate(() => { callback('subscribed'); });
    return () => { this.states.delete(id); };
  }

  public async removeOnLogsListener(id: number): Promise<void> { this.listeners.delete(id); }

  public emit(program: string, value: string, slot: number): void {
    for (const row of this.listeners.values()) {
      if (row.program === program) row.callback({ signature: value, err: null, logs: [] } as Logs, { slot } as Context);
    }
  }
}

function emitRange(connection: FakeConnection, from: number, to: number): void {
  for (let slot = from; slot <= to; slot += 1) {
    const value = signature(slot);
    connection.emit(PUMP_PROGRAM_ID, value, slot);
    connection.emit(PUMPSWAP_PROGRAM_ID, value, slot);
  }
}

class DurableInbox implements Pick<TransactionInboxRepository, 'enqueue' | 'readCheckpoint' | 'storeCheckpoint'> {
  public readonly rows = new Map<string, Set<string>>();
  public failOnceOn: string | null = null;
  private readonly checkpoints = new Map<'launchpad' | 'market', ProcessingCheckpoint>([
    ['launchpad', checkpoint('launchpad', 0)], ['market', checkpoint('market', 0)],
  ]);

  public async enqueue(value: TransactionNotification): Promise<void> {
    if (this.failOnceOn === value.signature) {
      this.failOnceOn = null;
      throw new Error('simulated crash before durable enqueue');
    }
    const sources = this.rows.get(value.signature) ?? new Set<string>();
    sources.add(value.source);
    this.rows.set(value.signature, sources);
  }

  public async readCheckpoint(key: 'launchpad' | 'market'): Promise<ProcessingCheckpoint | null> {
    return this.checkpoints.get(key) ?? null;
  }

  public async storeCheckpoint(value: ProcessingCheckpoint): Promise<void> { this.checkpoints.set(value.key, value); }

  public checkpointSlot(program: 'launchpad' | 'market'): bigint | null {
    return this.checkpoints.get(program)?.slot ?? null;
  }
}

function makeStartup(
  repository: DurableInbox,
  scheduler: ManualScheduler,
  getTarget: () => number,
  isSubscriberRunning?: () => boolean,
): StartupScanner {
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      const cursor = before === undefined ? getTarget() : slotFromSignature(before) - 1;
      const minimum = programId === PUMP_PROGRAM_ID || programId === PUMPSWAP_PROGRAM_ID ? 0 : -1;
      return Array.from({ length: Math.min(limit, cursor - minimum + 1) }, (_, index) => {
        const slot = cursor - index;
        return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
      });
    },
  };
  const scanner = new CatchUpScanner(source, repository, { pageSize: 1_000, maxPages: 20 });
  return new StartupScanner(scanner, async (program) => frontier(program, getTarget()), undefined, {
    intervalMs: 5_000,
    scheduler,
    readCheckpoint: (program) => repository.readCheckpoint(program),
    ...(isSubscriberRunning === undefined ? {} : { isSubscriberRunning }),
  });
}

function notification(
  value: string,
  slot: number,
  source: 'WEBSOCKET' | 'CATCH_UP',
  programId: string,
): TransactionNotification {
  return Object.freeze({
    signature: value,
    slot: BigInt(slot),
    source,
    programIds: [programId],
    confirmationStatus: source === 'WEBSOCKET' ? 'processed' : 'finalized',
    observedAtMs: 1,
  });
}

function checkpoint(key: 'launchpad' | 'market', slot: number): ProcessingCheckpoint {
  return Object.freeze({ key, slot: BigInt(slot), signature: signature(slot), updatedAtMs: 1 });
}
