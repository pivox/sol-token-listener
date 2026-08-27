import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { runApplication } from '../app.js';
import { PaperMvpCollector } from '../application/paper-mvp-collector.js';
import { UnavailableProviderUsageProbe } from '../application/unavailable-provider-usage.probe.js';
import type { AppConfig } from '../config/env.js';
import { getDatabasePool } from '../storage/database.js';
import { PostgresPaperMvpSource } from '../storage/paper-mvp-source.js';
import { PostgresPaperMvpRepository } from '../storage/paper-mvp.repository.js';
import {
  PaperMvpCliError,
  type PaperMvpRunnerDependencies,
  type PaperMvpRunnerLease,
  type PaperMvpStopController,
  type PaperMvpStopReason,
} from './paper-mvp.js';

const RUNNER_UNLOCK_TIMEOUT_MS = 5_000;
const PAPER_MVP_DATABASE_TIMEOUTS = Object.freeze({
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
  statement_timeout: 30_000,
  lock_timeout: 10_000,
  idle_in_transaction_session_timeout: 30_000,
});

interface PaperMvpRuntimePool {
  connect(): Promise<PaperMvpRunnerClient>;
}

interface PaperMvpRunnerClient {
  query(text: string, values?: readonly unknown[]): Promise<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
  }>;
  release(destroy?: boolean | Error): void;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
}

export function productionRunnerDependencies(config: AppConfig): PaperMvpRunnerDependencies {
  const providerUsageProbe = new UnavailableProviderUsageProbe();
  const runnerLifecycle = createPaperMvpRunnerLifecycle(acquirePostgresRunner);
  const dependencies: PaperMvpRunnerDependencies = {
    config,
    now: Date.now,
    providerUsageProbe,
    finalCollectionGraceMs: 5_000,
    runBootstrap: async (prepareAfterMigrations, runInsideBootstrap, cleanupBeforeLeaseRelease) => {
      let activePool: unknown = null;
      try {
        await runApplication({
          loadConfig: () => config,
          getDatabasePool: (databaseUrl) => {
            activePool = getDatabasePool(databaseUrl, PAPER_MVP_DATABASE_TIMEOUTS);
            return activePool;
          },
          beforeStart: async (pool) => {
            if (activePool === null || pool !== activePool) {
              throw new PaperMvpCliError('RUN_FAILED');
            }
            await runnerLifecycle.beforeStart(pool);
          },
          afterMigrations: async (pool) => {
            if (activePool === null || pool !== activePool) {
              throw new PaperMvpCliError('RUN_FAILED');
            }
            await prepareAfterMigrations(pool);
          },
          beforeDatabaseClose: async () => {
            try {
              await cleanupBeforeLeaseRelease();
            } finally {
              await runnerLifecycle.beforeDatabaseClose();
            }
          },
          lifecycleGuard: Object.freeze({
            checkpoint: runnerLifecycle.checkpoint,
          }),
          waitForShutdownSignal: async () => {
            if (activePool === null) throw new PaperMvpCliError('RUN_FAILED');
            return runInsideBootstrap(activePool);
          },
        });
      } finally {
        await runnerLifecycle.releaseStranded();
      }
    },
    createRepository: (pool) => new PostgresPaperMvpRepository(
      pool as ConstructorParameters<typeof PostgresPaperMvpRepository>[0],
    ),
    createCollector: (repository, pool, probe) => new PaperMvpCollector(
      repository,
      new PostgresPaperMvpSource(
        pool as ConstructorParameters<typeof PostgresPaperMvpSource>[0],
      ),
      Date.now,
      probe,
    ),
    acquireRunner: runnerLifecycle.acquireRunner,
    createStopController: () => createProcessStopController(),
    writeReport: async (path, contents) => writeFile(path, contents, { flag: 'wx', mode: 0o600 }),
  };
  return Object.freeze(dependencies);
}

export interface PaperMvpRunnerLifecycle {
  readonly beforeStart: (pool: unknown) => Promise<void>;
  readonly beforeDatabaseClose: () => Promise<void>;
  readonly checkpoint: () => Promise<void>;
  readonly acquireRunner: (pool: unknown) => Promise<PaperMvpRunnerLease>;
  readonly releaseStranded: () => Promise<void>;
}

export function createPaperMvpRunnerLifecycle(
  acquire: (pool: unknown) => Promise<PaperMvpRunnerLease>,
): PaperMvpRunnerLifecycle {
  let preparedLease: PaperMvpRunnerLease | null = null;
  let activeLease: PaperMvpRunnerLease | null = null;
  let preparedPool: unknown = null;

  const releaseHeldLease = async (): Promise<void> => {
    const heldLease = activeLease ?? preparedLease;
    activeLease = null;
    preparedLease = null;
    preparedPool = null;
    if (heldLease !== null) await heldLease.release();
  };

  return Object.freeze({
    beforeStart: async (pool: unknown) => {
      if (preparedLease !== null || activeLease !== null || preparedPool !== null) {
        throw new PaperMvpCliError('RUN_FAILED');
      }
      preparedLease = await acquire(pool);
      preparedPool = pool;
    },
    beforeDatabaseClose: releaseHeldLease,
    checkpoint: () => {
      const heldLease = activeLease ?? preparedLease;
      if (heldLease === null || heldLease.isLost()) {
        throw new PaperMvpCliError('RUNNER_LOCK_LOST');
      }
      return Promise.resolve();
    },
    acquireRunner: (pool: unknown) => {
      if (preparedLease === null || activeLease !== null || preparedPool !== pool) {
        throw new PaperMvpCliError('RUN_FAILED');
      }
      const lease = preparedLease;
      activeLease = lease;
      preparedLease = null;
      preparedPool = null;
      return Promise.resolve(Object.freeze({
        ownerId: lease.ownerId,
        lost: lease.lost,
        isLost: () => lease.isLost(),
        release: () => Promise.resolve(),
      }));
    },
    releaseStranded: releaseHeldLease,
  });
}

export async function acquirePostgresRunner(pool: unknown): Promise<PaperMvpRunnerLease> {
  const typedPool = pool as PaperMvpRuntimePool;
  let client: PaperMvpRunnerClient | null = null;
  let lockLost = false;
  let resolveLoss: (() => void) | undefined;
  const lost = new Promise<void>((resolve) => { resolveLoss = resolve; });
  const onClientError = (): void => {
    if (lockLost) return;
    lockLost = true;
    resolveLoss?.();
  };
  try {
    client = await typedPool.connect();
    client.on('error', onClientError);
    const result = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended('paper-mvp-runner:v1', 0)) AS acquired",
    );
    if (result.rows[0]?.acquired !== true) {
      client.off('error', onClientError);
      client.release();
      client = null;
      throw new PaperMvpCliError('RUNNER_ALREADY_ACTIVE');
    }
  } catch (error: unknown) {
    if (error instanceof PaperMvpCliError) throw error;
    if (client !== null) {
      client.off('error', onClientError);
      client.release(true);
    }
    throw new PaperMvpCliError('RUN_FAILED');
  }
  const runnerClient = client;
  const ownerId = `paper_mvp_owner_${randomUUID()}`;
  let released = false;
  return Object.freeze({
    ownerId,
    lost,
    isLost: () => lockLost,
    release: async () => {
      if (released) return;
      released = true;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (lockLost) {
          runnerClient.off('error', onClientError);
          runnerClient.release(true);
          return;
        }
        await Promise.race([
          runnerClient.query(
            "SELECT pg_advisory_unlock(hashtextextended('paper-mvp-runner:v1', 0)) AS unlocked",
          ).then((result) => {
            if (result.rows[0]?.unlocked !== true) throw new Error('runner unlock failed');
          }),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error('runner unlock timeout'));
            }, RUNNER_UNLOCK_TIMEOUT_MS);
            timeout.unref();
          }),
        ]);
        runnerClient.off('error', onClientError);
        runnerClient.release();
      } catch {
        runnerClient.off('error', onClientError);
        runnerClient.release(true);
        throw new PaperMvpCliError('RUN_FAILED');
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  });
}

function createProcessStopController(
  signalSource: Pick<NodeJS.Process, 'on' | 'off'> = process,
): PaperMvpStopController {
  let closed = false;
  let signal: Exclude<PaperMvpStopReason, 'POLL'> | null = null;
  let forceNotified = false;
  let resolveFirst: ((value: Exclude<PaperMvpStopReason, 'POLL'>) => void) | undefined;
  let resolveForced: (() => void) | undefined;
  const firstSignal = new Promise<Exclude<PaperMvpStopReason, 'POLL'>>((resolve) => {
    resolveFirst = resolve;
  });
  const forced = new Promise<void>((resolve) => { resolveForced = resolve; });
  const listeners = new Set<(value: PaperMvpStopReason) => void>();
  const notify = (value: Exclude<PaperMvpStopReason, 'POLL'>): void => {
    if (closed) return;
    if (signal !== null) {
      if (!forceNotified) {
        forceNotified = true;
        resolveForced?.();
      }
      return;
    }
    signal = value;
    resolveFirst?.(value);
    for (const listener of listeners) listener(value);
    listeners.clear();
  };
  const onSigint = (): void => { notify('SIGINT'); };
  const onSigterm = (): void => { notify('SIGTERM'); };
  signalSource.on('SIGINT', onSigint);
  signalSource.on('SIGTERM', onSigterm);
  return Object.freeze({
    firstSignal,
    forced,
    wait: async (durationMs: number) => {
      if (signal !== null) return signal;
      return new Promise<PaperMvpStopReason>((resolve) => {
        const complete = (value: PaperMvpStopReason): void => {
          clearTimeout(timer);
          listeners.delete(complete);
          resolve(value);
        };
        const timer = setTimeout(() => { complete('POLL'); }, durationMs);
        listeners.add(complete);
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      signalSource.off('SIGINT', onSigint);
      signalSource.off('SIGTERM', onSigterm);
      for (const listener of listeners) listener('SIGTERM');
      listeners.clear();
    },
  });
}
