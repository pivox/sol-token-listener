import { isProxy } from 'node:util/types';
import {
  MAX_DATE_MS,
  MAX_STRICT_CATCH_UP_SLOT,
  createStrictCatchUpFailure,
  type RpcProviderId,
} from '../domain/strict-catch-up.js';
import type {
  ProcessingCheckpoint,
  ProcessingCheckpointKey,
  TransactionNotification,
} from '../domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import type { CatchUpSource } from '../ports/catch-up-source.js';
import type { StrictCatchUpRepository } from '../ports/strict-catch-up-repository.js';
import {
  MAX_CATCH_UP_PAGE_SIZE,
  snapshotCatchUpSignatures,
  trustedCatchUpSourceErrorStage,
  type CatchUpSignature,
  type CatchUpSourceStage,
} from '../solana/rpc/catch-up-source.js';
import {
  mergeCatchUpDiscoveries,
  type CatchUpDiscoveryProgram,
} from './catch-up-discovery.js';

export const MAX_STRICT_CATCH_UP_PAGES = 100;

export interface StrictCatchUpSource extends CatchUpSource {
  readonly providerId: RpcProviderId;
}

export interface StrictCatchUpScannerOptions {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly now?: () => number;
}

export interface StrictCatchUpBoundaries {
  readonly launchpad: ProcessingCheckpoint | null;
  readonly market: ProcessingCheckpoint | null;
}

export interface StrictCatchUpScanResult {
  readonly providerId: RpcProviderId;
  readonly discoveredCount: number;
  readonly enqueuedCount: number;
  readonly checkpointCasCount: number;
  readonly pageCount: number;
  readonly boundaries: StrictCatchUpBoundaries;
}

export type StrictCatchUpScannerStage =
  | 'checkpoint-read'
  | 'source'
  | 'enqueue'
  | 'checkpoint-cas'
  | 'failure-write'
  | 'failure-resolve';

export class StrictCatchUpScannerError extends Error {
  public readonly retryable = true;

  public constructor(
    public readonly stage: StrictCatchUpScannerStage,
    public readonly providerId: RpcProviderId,
    public readonly checkpointKey: ProcessingCheckpointKey,
    public readonly sourceStage: CatchUpSourceStage | null = null,
  ) {
    super('Strict catch-up scanner operation failed.');
    this.name = 'StrictCatchUpScannerError';
    Object.freeze(this);
  }
}

export class StrictCatchUpWindowExceededError extends Error {
  public readonly code = 'CATCH_UP_WINDOW_EXCEEDED' as const;
  public readonly stage = 'window' as const;
  public readonly retryable = false;

  public constructor(
    public readonly providerId: RpcProviderId,
    public readonly checkpointKey: ProcessingCheckpointKey,
  ) {
    super('Strict catch-up scan window was exceeded.');
    this.name = 'StrictCatchUpWindowExceededError';
    Object.freeze(this);
  }
}

interface StrictProgramScan {
  readonly program: CatchUpDiscoveryProgram;
  readonly expected: ProcessingCheckpoint | null;
  readonly rows: readonly CatchUpSignature[];
  readonly newest: CatchUpSignature | null;
  readonly pageCount: number;
}

class StrictCatchUpWindowSignal extends Error {
  public constructor(
    public readonly checkpointKey: ProcessingCheckpointKey,
    public readonly previous: ProcessingCheckpoint,
    public readonly observedHeadSlot: bigint | null,
  ) {
    super('Strict catch-up internal window signal.');
    this.name = 'StrictCatchUpWindowSignal';
    Object.freeze(this);
  }
}

const PROGRAMS: readonly CatchUpDiscoveryProgram[] = Object.freeze([
  Object.freeze({ key: 'launchpad', id: PUMP_PROGRAM_ID }),
  Object.freeze({ key: 'market', id: PUMPSWAP_PROGRAM_ID }),
]);

export class StrictCatchUpScanner {
  private readonly providerId: RpcProviderId;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly now: () => number;

  public constructor(
    private readonly source: StrictCatchUpSource,
    private readonly repository: StrictCatchUpRepository,
    options: StrictCatchUpScannerOptions,
  ) {
    this.providerId = snapshotProviderId(source);
    const { pageSize, maxPages, now } = snapshotOptions(options);
    if (!positiveBound(pageSize, MAX_CATCH_UP_PAGE_SIZE)
      || !positiveBound(maxPages, MAX_STRICT_CATCH_UP_PAGES)
      || (now !== undefined && typeof now !== 'function')) {
      throw new TypeError('Strict catch-up scanner bounds are invalid.');
    }
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.now = now === undefined ? Date.now : now as () => number;
  }

  public async scan(): Promise<StrictCatchUpScanResult> {
    const observedAtMs = this.readNow();
    const launchpad = await this.readCheckpoint('launchpad');
    const market = await this.readCheckpoint('market');
    const boundaries: StrictCatchUpBoundaries = Object.freeze({ launchpad, market });
    const scans: StrictProgramScan[] = [];

    for (const program of PROGRAMS) {
      const expected = boundaries[program.key];
      try {
        scans.push(await this.scanProgram(program, expected));
      } catch (error) {
        if (isWindowExceeded(error)) {
          await this.recordWindowFailure(error, observedAtMs);
          throw new StrictCatchUpWindowExceededError(this.providerId, error.checkpointKey);
        }
        throw error;
      }
    }

    let merged;
    try {
      merged = mergeCatchUpDiscoveries(scans);
    } catch (error) {
      const sourceStage = trustedCatchUpSourceErrorStage(error) ?? 'response';
      const checkpointKey = trustedProgramKey(error) ?? 'market';
      throw this.failure('source', checkpointKey, sourceStage);
    }

    for (const discovery of merged) {
      const notification: TransactionNotification = Object.freeze({
        signature: discovery.signature,
        slot: discovery.slot,
        source: 'CATCH_UP',
        programIds: discovery.programIds,
        confirmationStatus: discovery.confirmationStatus,
        observedAtMs,
      });
      try {
        await this.repository.enqueue(notification);
      } catch {
        throw this.failure('enqueue', discoveryKey(discovery.programIds));
      }
    }

    let checkpointCasCount = 0;
    for (const scan of scans) {
      if (scan.newest === null) {
        try {
          await this.repository.resolveStrictCatchUpFailures(
            scan.program.key,
            scan.expected,
            observedAtMs,
          );
        } catch {
          throw this.failure('failure-resolve', scan.program.key);
        }
        continue;
      }
      const next: ProcessingCheckpoint = Object.freeze({
        key: scan.program.key,
        slot: scan.newest.slot,
        signature: scan.newest.signature,
        updatedAtMs: observedAtMs,
      });
      try {
        await this.repository.compareAndSwapCheckpoint(scan.expected, next);
      } catch {
        throw this.failure('checkpoint-cas', scan.program.key);
      }
      checkpointCasCount += 1;
    }

    return Object.freeze({
      providerId: this.providerId,
      discoveredCount: scans.reduce((sum, scan) => sum + scan.rows.length, 0),
      enqueuedCount: merged.length,
      checkpointCasCount,
      pageCount: scans.reduce((sum, scan) => sum + scan.pageCount, 0),
      boundaries,
    });
  }

  private async scanProgram(
    program: CatchUpDiscoveryProgram,
    expected: ProcessingCheckpoint | null,
  ): Promise<StrictProgramScan> {
    const rows: CatchUpSignature[] = [];
    const signatures = new Set<string>();
    const cursors = new Set<string>();
    let before: string | undefined;
    let previousSlot: bigint | null = null;
    let observedHeadSlot: bigint | null = null;

    for (let pageCount = 1; pageCount <= this.maxPages; pageCount += 1) {
      const page = await this.readPage(program, before);
      if (pageCount === 1) observedHeadSlot = page[0]?.slot ?? null;
      for (const row of page) {
        if (row.slot > MAX_STRICT_CATCH_UP_SLOT
          || row.signature.length === 0
          || row.signature !== row.signature.trim()
          || Buffer.byteLength(row.signature, 'utf8') > 128
          || (row.blockTimeMs !== null && !validMilliseconds(row.blockTimeMs))) {
          throw this.failure('source', program.key, 'response');
        }
        if (previousSlot !== null && row.slot > previousSlot) {
          throw this.failure('source', program.key, 'response');
        }
        previousSlot = row.slot;
        if (signatures.has(row.signature)) {
          throw this.failure('source', program.key, 'pagination');
        }
        signatures.add(row.signature);
        if (expected !== null
          && row.signature === expected.signature
          && row.slot === expected.slot) {
          return successfulScan(program, expected, rows, pageCount);
        }
        rows.push(row);
      }
      if (expected === null) return successfulScan(program, expected, rows, pageCount);
      if (page.length < this.pageSize) {
        throw windowExceeded(program.key, expected, observedHeadSlot);
      }
      const cursor = page.at(-1)?.signature;
      if (cursor === undefined || cursor === before || cursors.has(cursor)) {
        throw this.failure('source', program.key, 'pagination');
      }
      cursors.add(cursor);
      before = cursor;
    }
    if (expected === null) throw this.failure('source', program.key, 'pagination');
    throw windowExceeded(program.key, expected, observedHeadSlot);
  }

  private async readPage(
    program: CatchUpDiscoveryProgram,
    before: string | undefined,
  ): Promise<readonly CatchUpSignature[]> {
    let value: unknown;
    try {
      value = await this.source.list(program.id, before, this.pageSize);
    } catch (error) {
      throw this.failure(
        'source',
        program.key,
        trustedCatchUpSourceErrorStage(error) ?? 'request',
      );
    }
    try {
      return snapshotCatchUpSignatures(value, this.pageSize);
    } catch {
      throw this.failure('source', program.key, 'response');
    }
  }

  private async readCheckpoint(
    key: ProcessingCheckpointKey,
  ): Promise<ProcessingCheckpoint | null> {
    try {
      const value = await this.repository.readCheckpoint(key);
      return value === null ? null : snapshotCheckpoint(value, key);
    } catch {
      throw this.failure('checkpoint-read', key);
    }
  }

  private async recordWindowFailure(
    value: StrictCatchUpWindowSignal,
    detectedAtMs: number,
  ): Promise<void> {
    try {
      const failure = createStrictCatchUpFailure({
        checkpointKey: value.checkpointKey,
        previous: value.previous,
        providerId: this.providerId,
        observedHeadSlot: value.observedHeadSlot,
        detectedAtMs,
      });
      await this.repository.recordStrictCatchUpFailure(failure);
    } catch {
      throw this.failure('failure-write', value.checkpointKey);
    }
  }

  private readNow(): number {
    let value: unknown;
    try {
      value = this.now();
    } catch {
      throw this.failure('checkpoint-read', 'launchpad');
    }
    if (!validMilliseconds(value)) throw this.failure('checkpoint-read', 'launchpad');
    return value;
  }

  private failure(
    stage: StrictCatchUpScannerStage,
    checkpointKey: ProcessingCheckpointKey,
    sourceStage: CatchUpSourceStage | null = null,
  ): StrictCatchUpScannerError {
    return new StrictCatchUpScannerError(stage, this.providerId, checkpointKey, sourceStage);
  }
}

function successfulScan(
  program: CatchUpDiscoveryProgram,
  expected: ProcessingCheckpoint | null,
  rows: CatchUpSignature[],
  pageCount: number,
): StrictProgramScan {
  return Object.freeze({
    program,
    expected,
    rows: Object.freeze(rows),
    newest: rows[0] ?? null,
    pageCount,
  });
}

function windowExceeded(
  checkpointKey: ProcessingCheckpointKey,
  previous: ProcessingCheckpoint,
  observedHeadSlot: bigint | null,
): StrictCatchUpWindowSignal {
  return new StrictCatchUpWindowSignal(checkpointKey, previous, observedHeadSlot);
}

function isWindowExceeded(value: unknown): value is StrictCatchUpWindowSignal {
  return value instanceof StrictCatchUpWindowSignal;
}

function snapshotCheckpoint(
  value: unknown,
  expectedKey: ProcessingCheckpointKey,
): ProcessingCheckpoint {
  if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
    throw new TypeError('invalid');
  }
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('invalid');
  const keys = Reflect.ownKeys(value);
  const expectedKeys = ['key', 'slot', 'signature', 'updatedAtMs'];
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    throw new TypeError('invalid');
  }
  const key = ownData(value, 'key');
  const slot = ownData(value, 'slot');
  const signature = ownData(value, 'signature');
  const updatedAtMs = ownData(value, 'updatedAtMs');
  if (key !== expectedKey
    || typeof slot !== 'bigint'
    || slot < 0n
    || slot > MAX_STRICT_CATCH_UP_SLOT
    || typeof signature !== 'string'
    || signature.length === 0
    || signature !== signature.trim()
    || Buffer.byteLength(signature, 'utf8') > 128
    || !validMilliseconds(updatedAtMs)) {
    throw new TypeError('invalid');
  }
  return Object.freeze({ key: expectedKey, slot, signature, updatedAtMs });
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError('invalid');
  }
  return descriptor.value;
}

function snapshotOptions(options: unknown): {
  readonly pageSize: unknown;
  readonly maxPages: unknown;
  readonly now: unknown;
} {
  try {
    if (typeof options !== 'object' || options === null || isProxy(options) || Array.isArray(options)) {
      throw new TypeError();
    }
    const prototype: object | null = Object.getPrototypeOf(options) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(options);
    if (keys.length < 2 || keys.length > 3
      || !keys.includes('pageSize')
      || !keys.includes('maxPages')
      || keys.some((key) => key !== 'pageSize' && key !== 'maxPages' && key !== 'now')) {
      throw new TypeError();
    }
    return Object.freeze({
      pageSize: ownData(options, 'pageSize'),
      maxPages: ownData(options, 'maxPages'),
      now: keys.includes('now') ? ownData(options, 'now') : undefined,
    });
  } catch {
    throw new TypeError('Strict catch-up scanner bounds are invalid.');
  }
}

function snapshotProviderId(source: unknown): RpcProviderId {
  try {
    if (typeof source !== 'object' || source === null || isProxy(source) || Array.isArray(source)) {
      throw new TypeError();
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, 'providerId');
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
      || !validProviderId(descriptor.value)) {
      throw new TypeError();
    }
    return descriptor.value;
  } catch {
    throw new TypeError('Strict catch-up source is invalid.');
  }
}

function trustedProgramKey(value: unknown): ProcessingCheckpointKey | null {
  if (trustedCatchUpSourceErrorStage(value) === null) return null;
  const program = (value as { readonly program: unknown }).program;
  return program === 'launchpad' || program === 'market' ? program : null;
}

function discoveryKey(programIds: readonly string[]): ProcessingCheckpointKey {
  return programIds.includes(PUMPSWAP_PROGRAM_ID) && !programIds.includes(PUMP_PROGRAM_ID)
    ? 'market'
    : 'launchpad';
}

function positiveBound(value: unknown, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= maximum;
}

function validMilliseconds(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DATE_MS
    && !Object.is(value, -0);
}

function validProviderId(value: unknown): value is RpcProviderId {
  return value === 'primary'
    || value === 'fallback-1'
    || value === 'fallback-2'
    || value === 'fallback-3';
}
