import { isProxy } from 'node:util/types';

export const MIN_RETENTION_PURGE_INTERVAL_MS = 60_000;
export const MAX_RETENTION_PURGE_INTERVAL_MS = 86_400_000;
export const MAX_RETENTION_COUNTERS = 128;
// The native accessor is intentionally retained for its internal-slot brand check.
// eslint-disable-next-line @typescript-eslint/unbound-method
const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;

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
  readonly intervalMs: number;
  readonly signal: AbortSignal;
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
      await dependencies.wait(settings.intervalMs, settings.signal);
    } while (!retentionSignalAborted(settings.signal));
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
  const descriptors = readDescriptors(options, invalidOptions);
  const once = requiredDataField(descriptors, 'once');
  const intervalMs = requiredDataField(descriptors, 'intervalMs');
  const signal = requiredDataField(descriptors, 'signal');
  if (typeof once !== 'boolean') throw new TypeError('Retention mode is invalid.');
  if (
    typeof intervalMs !== 'number'
    || !Number.isSafeInteger(intervalMs)
    || intervalMs < MIN_RETENTION_PURGE_INTERVAL_MS
    || intervalMs > MAX_RETENTION_PURGE_INTERVAL_MS
  ) throw new RangeError('Retention interval is invalid.');
  if (!isNativeAbortSignal(signal)) {
    throw new TypeError('Retention abort signal is invalid.');
  }
  return Object.freeze({
    once,
    intervalMs,
    signal,
  });
}

function requiredDataField(
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
  key: string,
): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined) {
    throw new TypeError(`Retention option ${key} is required.`);
  }
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
  ) throw new TypeError('Retention counters are invalid.');
  const descriptors = readDescriptors(value, invalidCounters);
  const entries: [string, number][] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = ownDescriptor(descriptors, key);
    if (descriptor === undefined || !('value' in descriptor)) invalidCounters();
    const source: unknown = descriptor.value;
    if (typeof source !== 'object' || source === null) invalidCounters();
    const property = source as PropertyDescriptor;
    if (!property.enumerable) continue;
    if (typeof key !== 'string') invalidCounters();
    if (
      !/^[a-z][A-Za-z0-9]{0,63}$/u.test(key)
      || !('value' in property)
      || typeof property.value !== 'number'
      || !Number.isSafeInteger(property.value)
      || property.value < 0
      || Object.is(property.value, -0)
    ) invalidCounters();
    entries.push([key, property.value]);
    if (entries.length > MAX_RETENTION_COUNTERS) invalidCounters();
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  const counters = Object.create(null) as Record<string, number>;
  for (const [key, counter] of entries) counters[key] = counter;
  return Object.freeze(counters);
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  try {
    retentionSignalAborted(value as AbortSignal);
    return true;
  } catch {
    return false;
  }
}

export function retentionSignalAborted(signal: AbortSignal): boolean {
  if (
    typeof signal !== 'object'
    || isProxy(signal)
    || abortSignalAborted === undefined
  ) throw new TypeError('Retention abort signal is invalid.');
  try {
    const aborted: unknown = abortSignalAborted.call(signal);
    if (typeof aborted === 'boolean') return aborted;
  } catch {
    // The fixed error below does not retain an attacker-controlled failure.
  }
  throw new TypeError('Retention abort signal is invalid.');
}

function readDescriptors(
  value: object,
  invalid: () => never,
): Readonly<Record<string, PropertyDescriptor>> {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
}

function ownDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

function invalidOptions(): never {
  throw new TypeError('Retention options are invalid.');
}

function invalidCounters(): never {
  throw new RangeError('Retention counters are invalid.');
}
