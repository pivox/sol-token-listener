import { isProxy } from 'node:util/types';

export const MIN_RETENTION_PURGE_INTERVAL_MS = 60_000;
export const MAX_RETENTION_PURGE_INTERVAL_MS = 86_400_000;
export const DEFAULT_RETENTION_PURGE_INTERVAL_MS = 900_000;

export type RetentionCounters = Readonly<Record<string, number>>;

export interface RetentionLogEntry {
  readonly event: 'retention.purged';
  readonly counters: RetentionCounters;
}

export interface RetentionRunnerDependencies {
  readonly purge: () => Promise<unknown>;
  readonly closeDatabase: () => Promise<void>;
  readonly wait: (intervalMs: number, signal: AbortSignal) => Promise<void>;
  readonly log: (entry: RetentionLogEntry) => void;
}

export interface RetentionRunnerOptions {
  readonly once: boolean;
  readonly intervalMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function runRetention(
  options: RetentionRunnerOptions,
  dependencies: RetentionRunnerDependencies,
): Promise<void> {
  const settings = validateOptions(options);
  let primaryFailure: unknown;
  let primaryFailed = false;
  try {
    do {
      const counters = safeCounters(await dependencies.purge());
      dependencies.log(Object.freeze({ event: 'retention.purged', counters }));
      if (settings.once) break;
      try {
        await dependencies.wait(settings.intervalMs, settings.signal);
      } catch (error) {
        if (!settings.signal.aborted) throw error;
      }
    } while (!settings.signal.aborted);
  } catch (error) {
    primaryFailure = error;
    primaryFailed = true;
  }

  let closeFailure: unknown;
  let closeFailed = false;
  try {
    await dependencies.closeDatabase();
  } catch (error) {
    closeFailure = error;
    closeFailed = true;
  }

  if (primaryFailed && closeFailed) {
    throw new AggregateError([primaryFailure, closeFailure], 'Retention run and database close failed.');
  }
  if (primaryFailed) throw primaryFailure;
  if (closeFailed) throw closeFailure;
}

function validateOptions(options: RetentionRunnerOptions): Readonly<{
  once: boolean;
  intervalMs: number;
  signal: AbortSignal;
}> {
  if (typeof options !== 'object' || isProxy(options)) {
    throw new TypeError('Retention options are invalid.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const once = dataField(descriptors, 'once');
  const interval = dataField(descriptors, 'intervalMs');
  const suppliedSignal = dataField(descriptors, 'signal');
  if (typeof once !== 'boolean') throw new TypeError('Retention mode is invalid.');
  const intervalMs = interval === undefined ? DEFAULT_RETENTION_PURGE_INTERVAL_MS : interval;
  if (
    typeof intervalMs !== 'number'
    || !Number.isSafeInteger(intervalMs)
    || intervalMs < MIN_RETENTION_PURGE_INTERVAL_MS
    || intervalMs > MAX_RETENTION_PURGE_INTERVAL_MS
  ) throw new RangeError('Retention interval is invalid.');
  if (suppliedSignal !== undefined && !(suppliedSignal instanceof AbortSignal)) {
    throw new TypeError('Retention abort signal is invalid.');
  }
  return Object.freeze({
    once,
    intervalMs,
    signal: suppliedSignal ?? new AbortController().signal,
  });
}

function dataField(
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
  key: string,
): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`Retention option ${key} is invalid.`);
  }
  return descriptor.value;
}

function safeCounters(value: unknown): RetentionCounters {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError('Retention counters are invalid.');
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError('Retention counters are invalid.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort((left, right) => left.localeCompare(right));
  if (keys.length > 64) throw new RangeError('Retention counters are invalid.');
  const counters: Record<string, number> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || !/^[a-z][A-Za-z0-9]{0,63}$/u.test(key)
      || typeof descriptor.value !== 'number'
      || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 0
      || Object.is(descriptor.value, -0)
    ) throw new RangeError('Retention counters are invalid.');
    counters[key] = descriptor.value;
  }
  return Object.freeze(counters);
}
