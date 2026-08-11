import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  MAX_RETENTION_PURGE_INTERVAL_MS,
  MIN_RETENTION_PURGE_INTERVAL_MS,
  runRetention,
  type RetentionRunnerDependencies,
} from '../src/operations/retention-runner.js';
import { closeDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { logger } from '../src/utils/logger.js';

export const DEFAULT_RETENTION_PURGE_INTERVAL_MS = 900_000;

export interface RetentionCliOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly createDependencies: () => RetentionRunnerDependencies;
  readonly write: (line: string) => void;
  readonly signal: AbortSignal;
}

export async function runRetentionCli(options: RetentionCliOptions): Promise<number> {
  let once: boolean;
  let intervalMs: number;
  try {
    once = parseArguments(options.argv);
  } catch {
    writeResult(options.write, 'RETENTION_ARGUMENTS_INVALID');
    return 2;
  }
  try {
    intervalMs = parseInterval(options.environment);
  } catch {
    writeResult(options.write, 'RETENTION_INTERVAL_INVALID');
    return 2;
  }
  try {
    await runRetention({ once, intervalMs, signal: options.signal }, options.createDependencies());
    return 0;
  } catch {
    writeResult(options.write, 'RETENTION_COMMAND_FAILED');
    return 1;
  }
}

function parseArguments(argv: readonly string[]): boolean {
  if (!Array.isArray(argv)) throw new TypeError('Arguments are invalid.');
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === '--once') return true;
  throw new TypeError('Arguments are invalid.');
}

function parseInterval(environment: NodeJS.ProcessEnv): number {
  const descriptor = Object.getOwnPropertyDescriptor(environment, 'RETENTION_PURGE_INTERVAL_MS');
  if (descriptor !== undefined && !('value' in descriptor)) {
    throw new TypeError('Retention interval is invalid.');
  }
  const value: unknown = descriptor === undefined ? undefined : descriptor.value;
  if (value === undefined || value === '') return DEFAULT_RETENTION_PURGE_INTERVAL_MS;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError('Retention interval is invalid.');
  }
  const intervalMs = Number(value);
  if (
    !Number.isSafeInteger(intervalMs)
    || intervalMs < MIN_RETENTION_PURGE_INTERVAL_MS
    || intervalMs > MAX_RETENTION_PURGE_INTERVAL_MS
  ) throw new RangeError('Retention interval is invalid.');
  return intervalMs;
}

function writeResult(write: (line: string) => void, code: string): void {
  write(`${JSON.stringify({ event: 'retention.command', code })}\n`);
}

function wait(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, intervalMs);
    const abort = (): void => {
      clearTimeout(timer);
      finish();
    };
    function finish(): void {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function productionDependencies(): RetentionRunnerDependencies {
  return {
    purge: async () => purgeExpiredFoundationData(),
    closeDatabase,
    wait,
    log: (entry): void => { logger.info(entry); },
  };
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const removeSignals = installSignalHandlers(controller);
  try {
    process.exitCode = await runRetentionCli({
      argv: process.argv.slice(2),
      environment: process.env,
      createDependencies: productionDependencies,
      write: (line) => { process.stdout.write(line); },
      signal: controller.signal,
    });
  } finally {
    removeSignals();
  }
}

function installSignalHandlers(controller: AbortController): () => void {
  const abort = (): void => { controller.abort(); };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  return () => {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
