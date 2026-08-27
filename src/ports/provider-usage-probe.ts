import { types } from 'node:util';
import type { PaperMvpProviderUsage } from '../domain/paper-mvp.js';

const MAX_CREDITS_USED = 10n ** 78n - 1n;
const MAX_RATE_LIMITED_COUNT = 1_000_000;
const SNAPSHOT_FIELDS = [
  'status', 'creditsUsedStart', 'creditsUsedEnd', 'rateLimitedCount',
] as const;
const providerUsageSnapshotBrand: unique symbol = Symbol('providerUsageSnapshot');

type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];

export type ProviderUsageSnapshotInput = Readonly<{
  status: 'AVAILABLE';
  creditsUsedStart: bigint;
  creditsUsedEnd: bigint;
  rateLimitedCount: number;
}> | Readonly<{
  status: 'UNAVAILABLE';
  creditsUsedStart: null;
  creditsUsedEnd: null;
  rateLimitedCount: number;
}>;

export type ProviderUsageSnapshot = PaperMvpProviderUsage & Readonly<{
  [providerUsageSnapshotBrand]: true;
}>;

export interface ProviderUsageProbe {
  readonly identity: string;
  snapshot(signal?: AbortSignal): Promise<ProviderUsageSnapshot>;
}

export function createProviderUsageSnapshot(
  input: ProviderUsageSnapshotInput,
): ProviderUsageSnapshot;
export function createProviderUsageSnapshot(
  input: unknown,
): ProviderUsageSnapshot {
  const fields = snapshotFields(input);
  const status = fields.status;
  const rateLimitedCount = fields.rateLimitedCount;
  if (
    typeof rateLimitedCount !== 'number'
    || !Number.isSafeInteger(rateLimitedCount)
    || rateLimitedCount < 0 || rateLimitedCount > MAX_RATE_LIMITED_COUNT
  ) invalid();

  if (status === 'AVAILABLE') {
    const creditsUsedStart = fields.creditsUsedStart;
    const creditsUsedEnd = fields.creditsUsedEnd;
    if (
      typeof creditsUsedStart !== 'bigint' || typeof creditsUsedEnd !== 'bigint'
      || creditsUsedStart < 0n || creditsUsedStart > MAX_CREDITS_USED
      || creditsUsedEnd < creditsUsedStart || creditsUsedEnd > MAX_CREDITS_USED
    ) invalid();
    return branded({
      status: 'AVAILABLE' as const,
      creditsUsedStart,
      creditsUsedEnd,
      rateLimitedCount,
    });
  }

  if (
    status !== 'UNAVAILABLE'
    || fields.creditsUsedStart !== null || fields.creditsUsedEnd !== null
  ) invalid();
  return branded({
    status: 'UNAVAILABLE' as const,
    creditsUsedStart: null,
    creditsUsedEnd: null,
    rateLimitedCount,
  });
}

function branded(snapshot: PaperMvpProviderUsage): ProviderUsageSnapshot {
  Object.defineProperty(snapshot, providerUsageSnapshotBrand, { value: true });
  return Object.freeze(snapshot) as ProviderUsageSnapshot;
}

function snapshotFields(input: unknown): Record<SnapshotField, unknown> {
  try {
    if (
      typeof input !== 'object' || input === null
      || types.isProxy(input) || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
    ) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== SNAPSHOT_FIELDS.length
      || keys.some((key) => typeof key !== 'string' || !SNAPSHOT_FIELDS.includes(key as SnapshotField))
    ) invalid();
    const fields: Record<SnapshotField, unknown> = {
      status: undefined,
      creditsUsedStart: undefined,
      creditsUsedEnd: undefined,
      rateLimitedCount: undefined,
    };
    for (const field of SNAPSHOT_FIELDS) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined || !('value' in descriptor)
        || descriptor.enumerable !== true || descriptor.writable !== true
        || descriptor.configurable !== true
      ) invalid();
      fields[field] = descriptor.value;
    }
    return fields;
  } catch {
    invalid();
  }
}

function invalid(): never {
  throw new TypeError('Provider usage snapshot is invalid.');
}
