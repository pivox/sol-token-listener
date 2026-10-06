import assert from 'node:assert/strict';
import bs58 from 'bs58';
import test from 'node:test';
import type { Context, Logs, PublicKey } from '@solana/web3.js';
import { CatchUpScanner, CatchUpWindowExceededError, type CatchUpSource } from '../src/application/catch-up-scanner.js';
import { StartupScanner } from '../src/application/production-listener-factory.js';
import type { ProcessingCheckpoint, TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import type { TransactionInboxRepository } from '../src/ports/transaction-inbox-repository.js';
import type { CatchUpSignature } from '../src/solana/rpc/catch-up-source.js';
import { SolanaProgramSubscriber, type ProgramLogsCallback, type ProgramLogsConnection } from '../src/solana/rpc/program-subscriber.js';
import type { FinalizedProgramFrontier } from '../src/application/program-finalized-frontier.js';

void test('strict startup refuses an unreachable checkpoint without applying a cutover', async () => {
  const store = new DurableInbox({ launchpad: checkpoint('old-launchpad', 1) });
  const captured: string[] = [];
  const scanner = new StartupScanner(makeScanner(store, outOfWindowSource()), async (program) => {
    captured.push(program);
    return frontier(program, program === 'launchpad' ? 6 : 5);
  });

  await assert.rejects(scanner.scan(), CatchUpWindowExceededError);
  assert.deepEqual(captured, ['launchpad', 'market']);
  assert.equal(scanner.state(), 'DEGRADED');
  assert.equal(store.checkpoints.get('launchpad')?.signature, 'old-launchpad');
});

void test('per-program frontiers survive a 2,500-event WS race and cut over each program once', async () => {
  const store = new DurableInbox({
    launchpad: checkpoint('old-launchpad', 1),
    market: checkpoint('old-market', 1, 'market'),
  });
  const connection = new FakeConnection();
  const subscriber = new SolanaProgramSubscriber(connection, store);
  await subscriber.start();

  const launchFrontier = frontier('launchpad', 6);
  const marketFrontier = frontier('market', 5);
  const captured: string[] = [];
  const evidence: { program: string; frontier: FinalizedProgramFrontier; scan: CatchUpWindowExceededError['diagnostic'] }[] = [];
  const source = outOfWindowSource();
  const scanner = new StartupScanner(
    makeScanner(store, source),
    async (program) => {
      captured.push(program);
      if (program === 'launchpad') return launchFrontier;
      // This runs after the launchpad frontier is fixed and before market's frontier returns.
      if (captured.filter((value) => value === 'market').length === 1) {
        for (let value = 20_000; value < 22_500; value += 1) {
          connection.emit(PUMP_PROGRAM_ID, signature(value), value);
        }
        connection.emit(PUMP_PROGRAM_ID, launchFrontier.signature, Number(launchFrontier.slot));
        connection.emit(PUMPSWAP_PROGRAM_ID, marketFrontier.signature, Number(marketFrontier.slot));
      }
      return marketFrontier;
    },
    async (error, selectedFrontier) => {
      assert.ok(error instanceof CatchUpWindowExceededError);
      assert.equal(connection.listenerCount(), 2, 'both existing WS subscriptions remain installed');
      const expected = error.program === 'launchpad' ? launchFrontier : marketFrontier;
      assert.strictEqual(selectedFrontier, expected, 'cutover uses the captured signature directly');
      evidence.push({ program: error.program, frontier: selectedFrontier, scan: error.diagnostic });
      connection.emit(
        error.program === 'launchpad' ? PUMP_PROGRAM_ID : PUMPSWAP_PROGRAM_ID,
        signature(30_000 + evidence.length),
        30_000 + evidence.length,
      );
      await subscriber.drainDurableEnqueues();
      store.checkpoints.set(error.program, checkpoint(
        selectedFrontier.signature, Number(selectedFrontier.slot), error.program,
      ));
    },
  );

  await scanner.scan();
  await subscriber.drainDurableEnqueues();
  assert.equal(scanner.state(), 'RUNNING');
  assert.deepEqual(captured, ['launchpad', 'market', 'launchpad', 'market']);
  assert.deepEqual(evidence.map((item) => item.program), ['launchpad', 'market']);
  assert.strictEqual(evidence[0]?.frontier, launchFrontier);
  assert.strictEqual(evidence[1]?.frontier, marketFrontier);
  assert.equal(evidence[0]?.scan.frontierSignature, launchFrontier.signature);
  assert.equal(evidence[1]?.scan.frontierSignature, marketFrontier.signature);
  assert.deepEqual([...store.checkpoints.entries()].map(([program, value]) => [program, value.slot]), [
    ['launchpad', 6n], ['market', 5n],
  ]);
  assert.equal(connection.listenerCount(), 2);
  assert.equal(connection.removeCount, 0);
  assert.equal(subscriber.metrics().eventsReceived, 2_504);
  assert.equal(subscriber.metrics().enqueuesCompleted, 2_504);
  assert.equal(store.rows.get(launchFrontier.signature)?.count, 1);
  assert.equal(store.rows.get(marketFrontier.signature)?.count, 1);

  await subscriber.close();
  const beforeRestartCutovers = evidence.length;
  const strictRestart = new StartupScanner(makeScanner(store, outOfWindowSource()), async (program) => (
    frontier(program, program === 'launchpad' ? 6 : 5)
  ));
  await strictRestart.scan();
  assert.equal(strictRestart.state(), 'RUNNING');
  assert.equal(evidence.length, beforeRestartCutovers, 'normal restart does not repeat operator cutovers');
  assert.equal(store.checkpoints.get('launchpad')?.slot, 6n);
  assert.equal(store.checkpoints.get('market')?.slot, 5n);
});

void test('a successful cutover is terminal for bootstrap and the first rolling sweep starts immediately', async () => {
  const store = new DurableInbox({
    launchpad: checkpoint('old-launchpad', 1),
    market: checkpoint('old-market', 1, 'market'),
  });
  const calls: string[] = [];
  const source: CatchUpSource = {
    async list(programId) {
      calls.push(programId);
      return programId === PUMPSWAP_PROGRAM_ID
        ? [row(5), row(4), row(3)]
        : [row(6), row(5), row(4)];
    },
  };
  const frontiers = { launchpad: frontier('launchpad', 6), market: frontier('market', 5) };
  const startup = new StartupScanner(
    makeScanner(store, source),
    async (program) => frontiers[program],
    async (error, selected) => {
      assert.strictEqual(selected, frontiers[error.program]);
      store.checkpoints.set(error.program, checkpoint(
        selected.signature, Number(selected.slot), error.program,
      ));
    },
    { intervalMs: 15_000, readCheckpoint: (program) => store.readCheckpoint(program) },
  );

  const result = await startup.scan();

  assert.deepEqual(calls, [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID],
    'the cutover checkpoints are not searched for again; equal F/F2 rolling checks are no-ops');
  assert.equal(result.programs.launchpad.bootstrapMode, 'RECORDED_LIVE_EDGE_CUTOVER');
  assert.equal(result.programs.launchpad.durableFrontier.signature, frontiers.launchpad.signature);
  assert.equal(result.programs.market?.bootstrapMode, 'RECORDED_LIVE_EDGE_CUTOVER');
  assert.equal(result.programs.market?.durableFrontier.signature, frontiers.market.signature);
  assert.equal(startup.metrics().coverageState, 'HEALTHY');
  assert.equal(startup.metrics().programs.launchpad.sweepsSucceeded, 1);
  assert.equal(startup.metrics().programs.market.sweepsSucceeded, 1);
  await startup.close();
});

void test('a cutover failure preserves the original catch-up window diagnostic', async () => {
  const store = new DurableInbox({ launchpad: checkpoint('old-launchpad', 1) });
  const secondary = new Error('simulated database outage');
  const scanner = new StartupScanner(
    makeScanner(store, outOfWindowSource()),
    async (program) => frontier(program, 6),
    async () => { throw secondary; },
  );

  await assert.rejects(scanner.scan(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors[0] instanceof CatchUpWindowExceededError);
    assert.strictEqual(error.errors[1], secondary);
    assert.equal((error.errors[0] as CatchUpWindowExceededError).diagnostic.program, 'launchpad');
    return true;
  });
  assert.equal(store.checkpoints.get('launchpad')?.signature, 'old-launchpad');
});

function makeScanner(store: DurableInbox, source: CatchUpSource): CatchUpScanner {
  return new CatchUpScanner(source, store, { pageSize: 3, maxPages: 1, now: () => 10_000 });
}

function outOfWindowSource(): CatchUpSource {
  return {
    async list(programId) {
      if (programId === PUMPSWAP_PROGRAM_ID) return [row(5), row(4), row(3)];
      return [row(6), row(5), row(4)];
    },
  };
}

function row(slot: number): CatchUpSignature {
  return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null };
}

function frontier(program: 'launchpad' | 'market', slot: number): FinalizedProgramFrontier {
  return Object.freeze({
    program,
    signature: signature(slot),
    slot: BigInt(slot),
    confirmationStatus: 'finalized',
  });
}

function checkpoint(
  value: string,
  slot: number,
  key: 'launchpad' | 'market' = 'launchpad',
): ProcessingCheckpoint {
  return Object.freeze({ key, signature: value, slot: BigInt(slot), updatedAtMs: 1 });
}

function signature(value: number): string {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(value, 60);
  return bs58.encode(bytes);
}

class DurableInbox implements Pick<TransactionInboxRepository, 'enqueue' | 'readCheckpoint' | 'storeCheckpoint'> {
  public readonly rows = new Map<string, { count: number; programIds: string[] }>();
  public readonly checkpoints: Map<'launchpad' | 'market', ProcessingCheckpoint>;

  public constructor(checkpoints: Partial<Record<'launchpad' | 'market', ProcessingCheckpoint>>) {
    this.checkpoints = new Map(Object.entries(checkpoints) as ['launchpad' | 'market', ProcessingCheckpoint][]);
  }

  public async enqueue(value: TransactionNotification): Promise<void> {
    const prior = this.rows.get(value.signature);
    if (prior === undefined) {
      this.rows.set(value.signature, { count: 1, programIds: [...value.programIds].sort() });
      return;
    }
    prior.programIds = [...new Set([...prior.programIds, ...value.programIds])].sort();
  }

  public async readCheckpoint(key: 'launchpad' | 'market'): Promise<ProcessingCheckpoint | null> {
    return this.checkpoints.get(key) ?? null;
  }

  public async storeCheckpoint(value: ProcessingCheckpoint): Promise<void> {
    this.checkpoints.set(value.key, value);
  }
}

class FakeConnection implements ProgramLogsConnection {
  private nextId = 0;
  private readonly listeners = new Map<number, { program: string; callback: ProgramLogsCallback }>();
  private readonly states = new Map<number, (state: string) => void>();
  public removeCount = 0;

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

  public async removeOnLogsListener(id: number): Promise<void> {
    this.removeCount += 1;
    this.listeners.delete(id);
  }

  public emit(program: string, txSignature: string, slot: number): void {
    for (const listener of this.listeners.values()) {
      if (listener.program === program) {
        listener.callback({ signature: txSignature, err: null, logs: [] } as Logs, { slot } as Context);
      }
    }
  }

  public listenerCount(): number { return this.listeners.size; }
}
