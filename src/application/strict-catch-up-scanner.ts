import { isProxy } from 'node:util/types';
import {
  advanceStrictCatchUpRun,
  assertValidStrictCatchUpRun,
  createStrictCatchUpRun,
  terminalizeStrictCatchUpRun,
} from '../domain/strict-catch-up-run.js';
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
import type { ListenerIngestionProgram } from '../ports/listener-ingestion-program.js';
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
  readonly programs?: readonly ListenerIngestionProgram[];
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
  | 'failure-resolve'
  | 'run-read'
  | 'run-create'
  | 'run-progress'
  | 'run-complete'
  | 'run-fail'
  | 'run-supersede';

export class StrictCatchUpPausedError extends Error {
  public readonly code = 'CATCH_UP_PAGE_BUDGET_EXHAUSTED' as const;
  public readonly retryable = true;
  public readonly stage = 'page-budget' as const;

  public constructor(
    public readonly providerId: RpcProviderId,
    public readonly checkpointKey: ProcessingCheckpointKey,
    public readonly runId: string,
    public readonly pagesScanned: bigint,
    public readonly signaturesEnqueued: bigint,
  ) {
    super('Strict catch-up paused after its page budget.');
    Object.defineProperty(this, 'name', { value: 'StrictCatchUpPausedError' });
    Object.freeze(this);
  }
}

export class StrictCatchUpProviderAffinityError extends Error {
  public readonly retryable = true;
  public readonly stage = 'provider-affinity' as const;

  public constructor(
    public readonly pinnedProviderId: RpcProviderId,
    public readonly currentProviderId: RpcProviderId,
    public readonly checkpointKey: ProcessingCheckpointKey,
  ) {
    super('Strict catch-up requires its pinned provider.');
    Object.defineProperty(this, 'name', { value: 'StrictCatchUpProviderAffinityError' });
    Object.freeze(this);
  }
}

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

const WINDOW_FRONTIERS = new WeakMap<
  StrictCatchUpWindowExceededError,
  StrictCatchUpBoundaries
>();

export class StrictCatchUpAbortedError extends Error {
  public constructor() {
    super('Strict catch-up scan was aborted.');
    Object.defineProperty(this, 'name', { value: 'StrictCatchUpAbortedError' });
    Object.freeze(this);
  }
}

export class StrictCatchUpWindowExceededError extends Error {
  public readonly code: 'CATCH_UP_WINDOW_EXCEEDED';
  public readonly stage: 'window';
  public readonly retryable: false;
  public readonly providerId: RpcProviderId;
  public readonly checkpointKey: ProcessingCheckpointKey;

  public constructor(
    providerId: RpcProviderId,
    checkpointKey: ProcessingCheckpointKey,
    frontier: StrictCatchUpBoundaries,
  ) {
    super('Strict catch-up scan window was exceeded.');
    this.code = 'CATCH_UP_WINDOW_EXCEEDED';
    this.stage = 'window';
    this.retryable = false;
    this.providerId = providerId;
    this.checkpointKey = checkpointKey;
    Object.defineProperty(this, 'name', { value: 'StrictCatchUpWindowExceededError' });
    WINDOW_FRONTIERS.set(this, snapshotBoundaries(frontier));
    Object.freeze(this);
  }

  public sameFrontier(other: StrictCatchUpWindowExceededError): boolean {
    const left = WINDOW_FRONTIERS.get(this);
    const right = WINDOW_FRONTIERS.get(other);
    return left !== undefined && right !== undefined
      && sameCheckpoint(left.launchpad, right.launchpad)
      && sameCheckpoint(left.market, right.market);
  }
}

interface StrictProgramScan {
  readonly discoveredCount: number;
  readonly checkpointCasCount: number;
  readonly pageCount: number;
}

const DEFAULT_PROGRAMS: readonly ListenerIngestionProgram[] = Object.freeze([
  Object.freeze({ key: 'launchpad', family: 'pumpfun', id: PUMP_PROGRAM_ID }),
  Object.freeze({ key: 'market', family: 'pumpswap', id: PUMPSWAP_PROGRAM_ID }),
]);

export class StrictCatchUpScanner {
  private readonly providerId: RpcProviderId;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  private readonly programs: readonly ListenerIngestionProgram[];

  public constructor(
    private readonly source: StrictCatchUpSource,
    private readonly repository: StrictCatchUpRepository,
    options: StrictCatchUpScannerOptions,
  ) {
    this.providerId = snapshotProviderId(source);
    const { pageSize, maxPages, now, programs } = snapshotOptions(options);
    if (!positiveBound(pageSize, MAX_CATCH_UP_PAGE_SIZE)
      || !positiveBound(maxPages, MAX_STRICT_CATCH_UP_PAGES)
      || (now !== undefined && typeof now !== 'function')) {
      throw new TypeError('Strict catch-up scanner bounds are invalid.');
    }
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.now = now === undefined ? Date.now : now as () => number;
    this.programs = snapshotPrograms(programs ?? DEFAULT_PROGRAMS);
  }

  public async scan(signal: AbortSignal): Promise<StrictCatchUpScanResult> {
    assertNotAborted(signal);
    const observedAtMs = this.readNow();
    const checkpoints: {
      launchpad: ProcessingCheckpoint | null;
      market: ProcessingCheckpoint | null;
    } = { launchpad: null, market: null };
    for (const program of this.programs) {
      checkpoints[program.key] = await this.awaited(
        signal,
        () => this.readCheckpoint(program.key, signal),
      );
    }
    const boundaries: StrictCatchUpBoundaries = Object.freeze({ ...checkpoints });
    const scans: StrictProgramScan[] = [];
    const discoveries = new Map<string, CatchUpSignature>();
    for (const program of this.programs) {
      scans.push(await this.awaited(signal, () => this.scanProgram(
        program, boundaries, observedAtMs, discoveries, signal,
      )));
    }

    return Object.freeze({
      providerId: this.providerId,
      discoveredCount: scans.reduce((sum, scan) => sum + scan.discoveredCount, 0),
      enqueuedCount: scans.reduce((sum, scan) => sum + scan.discoveredCount, 0),
      checkpointCasCount: scans.reduce((sum, scan) => sum + scan.checkpointCasCount, 0),
      pageCount: scans.reduce((sum, scan) => sum + scan.pageCount, 0),
      boundaries,
    });
  }

  private async scanProgram(
    program: CatchUpDiscoveryProgram,
    boundaries: StrictCatchUpBoundaries,
    observedAtMs: number,
    discoveries: Map<string, CatchUpSignature>,
    signal: AbortSignal,
  ): Promise<StrictProgramScan> {
    const expected = boundaries[program.key];
    let run = expected === null ? null : await this.operation(signal, 'run-read', program.key, async () => {
      const active = await this.repository.readActiveStrictCatchUpRun(program.key);
      if (active !== null) {
        assertValidStrictCatchUpRun(active);
        if (active.state !== 'ACTIVE' || active.checkpointKey !== program.key) throw new TypeError();
      }
      return active;
    });
    if (run !== null && !sameCheckpoint(run.previous, expected)) {
      const stale = run;
      await this.operation(signal, 'run-supersede', program.key,
        () => this.repository.supersedeStaleStrictCatchUpRun(stale, observedAtMs));
      run = null;
    }
    if (run !== null && run.providerId !== this.providerId) {
      throw new StrictCatchUpProviderAffinityError(run.providerId, this.providerId, program.key);
    }
    if (run !== null && observedAtMs < run.updatedAtMs) throw this.failure('run-read', program.key);
    const signatures = new Set<string>();
    if (run !== null) {
      signatures.add(run.beforeSignature);
      signatures.add(run.observedHead.signature);
    }
    let before = run?.beforeSignature;
    let previousSlot = run?.lastAcceptedSlot ?? null;
    let observedHead = run?.observedHead ?? null;
    let discoveredCount = 0;

    for (let pageCount = 1; pageCount <= this.maxPages; pageCount += 1) {
      const page = await this.awaited(
        signal,
        () => this.readPage(program, before, signal),
      );
      const rows: CatchUpSignature[] = [];
      let boundaryFound = false;
      let crossedBoundarySlot = false;
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
        if (expected !== null && row.signature === expected.signature) {
          if (row.slot !== expected.slot) throw this.failure('source', program.key, 'response');
          boundaryFound = true;
          break;
        }
        // An older slot proves the exact boundary is missing; never persist an older cursor.
        if (expected !== null && row.slot < expected.slot) {
          crossedBoundarySlot = true;
          break;
        }
        const previous = discoveries.get(row.signature);
        if (previous !== undefined) {
          try {
            const merged = mergeCatchUpDiscoveries([
              { program, rows: [previous] }, { program, rows: [row] },
            ]);
            discoveries.set(row.signature, merged[0] ?? row);
          } catch {
            throw this.failure('source', program.key, 'response');
          }
        } else {
          discoveries.set(row.signature, row);
        }
        rows.push(row);
      }
      observedHead ??= rows[0] ?? null;
      for (const row of rows) {
        const notification: TransactionNotification = Object.freeze({
          signature: row.signature,
          slot: row.slot,
          source: 'CATCH_UP',
          ingestionHint: null,
          programIds: Object.freeze([program.id]),
          confirmationStatus: row.confirmationStatus,
          observedAtMs,
        });
        await this.operation(signal, 'enqueue', program.key, () => this.repository.enqueue(notification));
      }
      discoveredCount += rows.length;

      const tail = rows.at(-1);
      if (expected !== null && (!boundaryFound || run !== null)
        && tail !== undefined && observedHead !== null) {
        const current = run;
        const head = observedHead;
        run = await this.operation(signal, current === null ? 'run-create' : 'run-progress', program.key, async () => {
          const progress = {
            beforeSignature: tail.signature, lastAcceptedSlot: tail.slot,
            pagesScanned: (current?.pagesScanned ?? 0n) + 1n,
            signaturesEnqueued: (current?.signaturesEnqueued ?? 0n) + BigInt(rows.length),
            updatedAtMs: observedAtMs,
          };
          if (current === null) {
            return this.repository.createStrictCatchUpRun(createStrictCatchUpRun({
              ...progress, checkpointKey: program.key, previous: expected,
              providerId: this.providerId,
              observedHead: { slot: head.slot, signature: head.signature },
              revision: 0n, startedAtMs: observedAtMs,
            }));
          }
          const next = advanceStrictCatchUpRun(current, progress);
          await this.repository.advanceStrictCatchUpRun(current, next);
          return next;
        });
        before = run.beforeSignature;
      }

      if (expected === null || boundaryFound) {
        let checkpointCasCount = 0;
        if (observedHead === null) {
          await this.operation(signal, 'failure-resolve', program.key,
            () => this.repository.resolveStrictCatchUpFailures(program.key, expected));
        } else {
          const next: ProcessingCheckpoint = Object.freeze({
            key: program.key, slot: observedHead.slot,
            signature: observedHead.signature, updatedAtMs: observedAtMs,
          });
          const completedRun = run;
          if (completedRun === null) {
            await this.operation(signal, 'checkpoint-cas', program.key,
              () => this.repository.compareAndSwapCheckpoint(expected, next));
          } else {
            await this.operation(signal, 'run-complete', program.key,
              () => this.repository.completeStrictCatchUpRun({ run: completedRun, nextCheckpoint: next }));
          }
          checkpointCasCount = 1;
        }
        return Object.freeze({ discoveredCount, checkpointCasCount, pageCount });
      }

      if (page.length < this.pageSize || crossedBoundarySlot) {
        await this.recordWindowFailure(program.key, expected, observedHead?.slot ?? null, observedAtMs, signal);
        const failedRun = run;
        if (failedRun !== null) {
          await this.operation(signal, 'run-fail', program.key, () => this.repository.failStrictCatchUpRun(
            failedRun, terminalizeStrictCatchUpRun(failedRun, {
              state: 'FAILED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED', completedAtMs: observedAtMs,
            }),
          ));
        }
        throw new StrictCatchUpWindowExceededError(this.providerId, program.key, boundaries);
      }
    }
    if (run === null) throw this.failure('source', program.key, 'pagination');
    throw new StrictCatchUpPausedError(this.providerId, program.key, run.runId,
      run.pagesScanned, run.signaturesEnqueued);
  }

  private async operation<T>(
    signal: AbortSignal,
    stage: StrictCatchUpScannerStage,
    key: ProcessingCheckpointKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.awaited(signal, async () => {
      try {
        return await operation();
      } catch {
        throw this.failure(stage, key);
      }
    });
  }

  private async readPage(
    program: CatchUpDiscoveryProgram,
    before: string | undefined,
    signal: AbortSignal,
  ): Promise<readonly CatchUpSignature[]> {
    const value = await this.awaited(signal, async () => {
      try {
        return await this.source.list(program.id, before, this.pageSize);
      } catch (error) {
        throw this.failure(
          'source',
          program.key,
          trustedCatchUpSourceErrorStage(error) ?? 'request',
        );
      }
    });
    try {
      return snapshotCatchUpSignatures(value, this.pageSize);
    } catch {
      throw this.failure('source', program.key, 'response');
    }
  }

  private async readCheckpoint(
    key: ProcessingCheckpointKey,
    signal: AbortSignal,
  ): Promise<ProcessingCheckpoint | null> {
    return this.awaited(signal, async () => {
      try {
        const value = await this.repository.readCheckpoint(key);
        return value === null ? null : snapshotCheckpoint(value, key);
      } catch {
        throw this.failure('checkpoint-read', key);
      }
    });
  }

  private async recordWindowFailure(
    checkpointKey: ProcessingCheckpointKey,
    previous: ProcessingCheckpoint,
    observedHeadSlot: bigint | null,
    detectedAtMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.awaited(signal, async () => {
      try {
        const failure = createStrictCatchUpFailure({
          checkpointKey,
          previous,
          providerId: this.providerId,
          observedHeadSlot,
          detectedAtMs,
        });
        await this.repository.recordStrictCatchUpFailure(failure);
      } catch {
        throw this.failure('failure-write', checkpointKey);
      }
    });
  }

  private async awaited<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    assertNotAborted(signal);
    try {
      return await operation();
    } finally {
      assertNotAborted(signal);
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

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new StrictCatchUpAbortedError();
}

function snapshotBoundaries(value: unknown): StrictCatchUpBoundaries {
  try {
    if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
      throw new TypeError();
    }
    const prototype: object | null = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('launchpad') || !keys.includes('market')) {
      throw new TypeError();
    }
    const launchpad = ownData(value, 'launchpad');
    const market = ownData(value, 'market');
    return Object.freeze({
      launchpad: launchpad === null
        ? null
        : snapshotCheckpoint(launchpad, 'launchpad'),
      market: market === null
        ? null
        : snapshotCheckpoint(market, 'market'),
    });
  } catch {
    throw new TypeError('Strict catch-up frontier is invalid.');
  }
}

function sameCheckpoint(
  left: ProcessingCheckpoint | null,
  right: ProcessingCheckpoint | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.key === right.key
      && left.slot === right.slot
      && left.signature === right.signature;
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
  readonly programs: unknown;
} {
  try {
    if (typeof options !== 'object' || options === null || isProxy(options) || Array.isArray(options)) {
      throw new TypeError();
    }
    const prototype: object | null = Object.getPrototypeOf(options) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(options);
    if (keys.length < 2 || keys.length > 4
      || !keys.includes('pageSize')
      || !keys.includes('maxPages')
      || keys.some((key) => key !== 'pageSize'
        && key !== 'maxPages'
        && key !== 'now'
        && key !== 'programs')) {
      throw new TypeError();
    }
    return Object.freeze({
      pageSize: ownData(options, 'pageSize'),
      maxPages: ownData(options, 'maxPages'),
      now: keys.includes('now') ? ownData(options, 'now') : undefined,
      programs: keys.includes('programs') ? ownData(options, 'programs') : undefined,
    });
  } catch {
    throw new TypeError('Strict catch-up scanner bounds are invalid.');
  }
}

function snapshotPrograms(value: unknown): readonly ListenerIngestionProgram[] {
  if (isProxy(value) || !Array.isArray(value)) {
    throw new TypeError('Strict catch-up scanner programs are invalid.');
  }
  const lengthField = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthField !== undefined && 'value' in lengthField
    ? lengthField.value as unknown
    : undefined;
  if (length !== 1 && length !== 2) {
    throw new TypeError('Strict catch-up scanner programs are invalid.');
  }
  const arrayKeys = Reflect.ownKeys(value);
  if (arrayKeys.length !== length + 1
    || !arrayKeys.includes('length')
    || Array.from({ length }, (_, index) => String(index))
      .some((key) => !arrayKeys.includes(key))) {
    throw new TypeError('Strict catch-up scanner programs are invalid.');
  }
  const expected = [
    Object.freeze({ key: 'launchpad', family: 'pumpfun', id: PUMP_PROGRAM_ID }),
    Object.freeze({ key: 'market', family: 'pumpswap', id: PUMPSWAP_PROGRAM_ID }),
  ] as const;
  const result: ListenerIngestionProgram[] = [];
  for (let index = 0; index < length; index += 1) {
    const canonical = expected[index];
    const entryField = Object.getOwnPropertyDescriptor(value, String(index));
    const entry: unknown = entryField !== undefined
      && entryField.enumerable
      && 'value' in entryField
      ? entryField.value as unknown
      : undefined;
    if (canonical === undefined
      || typeof entry !== 'object'
      || entry === null
      || isProxy(entry)
      || Array.isArray(entry)) {
      throw new TypeError('Strict catch-up scanner programs are invalid.');
    }
    const prototype: object | null = Object.getPrototypeOf(entry) as object | null;
    const keys = Reflect.ownKeys(entry);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 3
      || !keys.includes('key')
      || !keys.includes('family')
      || !keys.includes('id')
      || ownData(entry, 'key') !== canonical.key
      || ownData(entry, 'family') !== canonical.family
      || ownData(entry, 'id') !== canonical.id) {
      throw new TypeError('Strict catch-up scanner programs are invalid.');
    }
    result.push(canonical);
  }
  return Object.freeze(result);
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
