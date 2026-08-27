import type { PaperMvpProviderUsage } from '../domain/paper-mvp.js';

const MAX_RATE_LIMITED_COUNT = 1_000_000;
const providerUsageSnapshotBrand: unique symbol = Symbol('providerUsageSnapshot');

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
  snapshot(): Promise<ProviderUsageSnapshot>;
}

export function createProviderUsageSnapshot(
  input: ProviderUsageSnapshotInput,
): ProviderUsageSnapshot;
export function createProviderUsageSnapshot(
  input: unknown,
): ProviderUsageSnapshot {
  if (!isRecord(input) || !hasExactSnapshotFields(input)) invalid();
  const status = input.status;
  const rateLimitedCount = input.rateLimitedCount;
  if (
    typeof rateLimitedCount !== 'number'
    || !Number.isSafeInteger(rateLimitedCount)
    || rateLimitedCount < 0 || rateLimitedCount > MAX_RATE_LIMITED_COUNT
  ) invalid();

  if (status === 'AVAILABLE') {
    const creditsUsedStart = input.creditsUsedStart;
    const creditsUsedEnd = input.creditsUsedEnd;
    if (
      typeof creditsUsedStart !== 'bigint' || typeof creditsUsedEnd !== 'bigint'
      || creditsUsedStart < 0n || creditsUsedEnd < creditsUsedStart
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
    || input.creditsUsedStart !== null || input.creditsUsedEnd !== null
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

function hasExactSnapshotFields(value: Readonly<Record<string, unknown>>): boolean {
  const fields = Object.keys(value).sort();
  return fields.length === 4
    && fields[0] === 'creditsUsedEnd'
    && fields[1] === 'creditsUsedStart'
    && fields[2] === 'rateLimitedCount'
    && fields[3] === 'status';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new TypeError('Provider usage snapshot is invalid.');
}
