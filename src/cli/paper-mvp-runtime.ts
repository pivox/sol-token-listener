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
  let preparedLease: PaperMvpRunnerLease | null = null;
  let preparedPool: unknown = null;
  const dependencies: PaperMvpRunnerDependencies = {
    config,
    now: Date.now,
    providerUsageProbe,
    runBootstrap: async (runInsideBootstrap) => {
      let activePool: unknown = null;
      try {
        await runApplication({
          loadConfig: () => config,
          getDatabasePool: (databaseUrl) => {
            activePool = getDatabasePool(databaseUrl);
            return activePool;
          },
          beforeStart: async (pool) => {
            if (activePool === null || pool !== activePool || preparedLease !== null) {
              throw new PaperMvpCliError('RUN_FAILED');
            }
            preparedLease = await acquirePostgresRunner(pool);
            preparedPool = pool;
          },
          beforeDatabaseClose: async () => {
            const strandedLease = preparedLease;
            preparedLease = null;
            preparedPool = null;
            if (strandedLease !== null) await strandedLease.release();
          },
          waitForShutdownSignal: async () => {
            if (activePool === null) throw new PaperMvpCliError('RUN_FAILED');
            return runInsideBootstrap(activePool);
          },
        });
      } finally {
        const strandedLease = preparedLease;
        preparedLease = null;
        preparedPool = null;
        if (strandedLease !== null) await strandedLease.release();
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
    acquireRunner: (pool) => {
      if (preparedLease === null || preparedPool !== pool) {
        throw new PaperMvpCliError('RUN_FAILED');
      }
      const lease = preparedLease;
      preparedLease = null;
      preparedPool = null;
      return Promise.resolve(lease);
    },
    createStopController: () => createProcessStopController(),
    writeReport: async (path, contents) => writeFile(path, contents, { flag: 'wx', mode: 0o600 }),
  };
  return Object.freeze(dependencies);
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
  let released = false;
  return Object.freeze({
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
  signalSource: Pick<NodeJS.Process, 'once' | 'off'> = process,
): PaperMvpStopController {
  let closed = false;
  let signal: Exclude<PaperMvpStopReason, 'POLL'> | null = null;
  const listeners = new Set<(value: PaperMvpStopReason) => void>();
  const notify = (value: Exclude<PaperMvpStopReason, 'POLL'>): void => {
    if (closed || signal !== null) return;
    signal = value;
    for (const listener of listeners) listener(value);
    listeners.clear();
  };
  const onSigint = (): void => { notify('SIGINT'); };
  const onSigterm = (): void => { notify('SIGTERM'); };
  signalSource.once('SIGINT', onSigint);
  signalSource.once('SIGTERM', onSigterm);
  return Object.freeze({
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
