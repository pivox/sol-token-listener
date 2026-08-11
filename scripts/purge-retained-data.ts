import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  MAX_RETENTION_PURGE_INTERVAL_MS,
  MIN_RETENTION_PURGE_INTERVAL_MS,
  retentionSignalAborted,
  runRetention,
  type RetentionRunnerDependencies,
} from '../src/operations/retention-runner.js';
import { closeDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { logger } from '../src/utils/logger.js';

export const DEFAULT_RETENTION_PURGE_INTERVAL_MS = 900_000;

// Native EventTarget methods bypass attacker-controlled own shadow properties.
// eslint-disable-next-line @typescript-eslint/unbound-method
const nativeAddEventListener = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;

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

interface RetentionTimerDependencies {
  readonly setTimeout: (callback: () => void, intervalMs: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

const productionTimers: RetentionTimerDependencies = {
  setTimeout: (callback, intervalMs) => setTimeout(callback, intervalMs),
  clearTimeout: (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>); },
};

export function waitForRetentionInterval(
  intervalMs: number,
  signal: AbortSignal,
  timers: RetentionTimerDependencies = productionTimers,
): Promise<void> {
  if (retentionSignalAborted(signal)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let listenerRegistered = false;
    function finish(): void {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      if (listenerRegistered) nativeRemoveEventListener.call(signal, 'abort', finish);
      resolve();
    }
    const timer = timers.setTimeout(finish, intervalMs);
    nativeAddEventListener.call(signal, 'abort', finish, { once: true });
    listenerRegistered = true;
    if (retentionSignalAborted(signal)) finish();
  });
}

function productionDependencies(): RetentionRunnerDependencies {
  return {
    purge: async () => purgeExpiredFoundationData(),
    closeDatabase,
    wait: waitForRetentionInterval,
    log: (entry): void => { logger.info(entry); },
  };
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const removeSignals = installRetentionSignalHandlers(controller);
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

interface RetentionSignalTarget {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export function installRetentionSignalHandlers(
  controller: AbortController,
  target: RetentionSignalTarget = process,
): () => void {
  const abort = (): void => { controller.abort(); };
  target.once('SIGINT', abort);
  target.once('SIGTERM', abort);
  return () => {
    target.removeListener('SIGINT', abort);
    target.removeListener('SIGTERM', abort);
  };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
