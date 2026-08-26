import type {
  CatchUpGap,
  ProcessingCheckpoint,
  TransactionNotification,
} from '../domain/transaction-ingestion.js';
import { createCatchUpGap } from '../domain/transaction-ingestion.js';
import { reconcileConfirmationStatus } from '../domain/confirmation-status.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';
import {
  CatchUpSourceError,
  MAX_CATCH_UP_PAGE_SIZE,
  snapshotCatchUpSignatures,
  trustedCatchUpSourceErrorStage,
  type CatchUpSignature,
} from '../solana/rpc/catch-up-source.js';

export const MAX_CATCH_UP_PAGES = 100;

type ProgramKey = 'launchpad' | 'market';

export interface CatchUpSource {
  list(programId: string, before: string | undefined, limit: number): Promise<unknown>;
}

export type CatchUpScannerRepository = Pick<
  TransactionInboxRepository,
  'enqueue' | 'readCheckpoint' | 'storeCheckpoint' | 'recordCatchUpGap'
>;

export interface CatchUpScannerOptions {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly policy?: 'live-edge' | 'strict';
  readonly now?: () => number;
  readonly onGap?: (gap: CatchUpGap) => void;
}

export interface CatchUpScanResult {
  readonly discoveredCount: number;
  readonly enqueuedCount: number;
  readonly checkpointWriteCount: number;
  readonly pageCount: number;
}

export type CatchUpScannerStage = 'checkpoint-read' | 'enqueue' | 'checkpoint-write';

export class CatchUpScannerError extends Error {
  public constructor(public readonly stage: CatchUpScannerStage) {
    super('Catch-up scanner durable operation failed.');
    this.name = 'CatchUpScannerError';
    Object.freeze(this);
  }
}

export class CatchUpWindowExceededError extends Error {
  public readonly stage = 'window' as const;
  public readonly code = 'CATCH_UP_WINDOW_EXCEEDED' as const;
  public readonly retryable = false;

  public constructor(public readonly program: ProgramKey) {
    super('Catch-up scan window was exceeded.');
    this.name = 'CatchUpWindowExceededError';
    Object.freeze(this);
  }
}

interface ProgramDefinition {
  readonly key: ProgramKey;
  readonly id: string;
}

interface ProgramScan {
  readonly program: ProgramDefinition;
  readonly rows: readonly CatchUpSignature[];
  readonly newest: CatchUpSignature | null;
  readonly pageCount: number;
  readonly gap: CatchUpGap | null;
}

interface MergedDiscovery extends CatchUpSignature {
  readonly programIds: readonly string[];
}

const PROGRAMS: readonly ProgramDefinition[] = Object.freeze([
  Object.freeze({ key: 'launchpad', id: PUMP_PROGRAM_ID }),
  Object.freeze({ key: 'market', id: PUMPSWAP_PROGRAM_ID }),
]);

export class CatchUpScanner {
  private readonly now: () => number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly policy: 'live-edge' | 'strict';
  private readonly onGap: ((gap: CatchUpGap) => void) | undefined;

  public constructor(
    private readonly source: CatchUpSource,
    private readonly repository: CatchUpScannerRepository,
    options: CatchUpScannerOptions,
  ) {
    const pageSize = optionValue(options, 'pageSize');
    const maxPages = optionValue(options, 'maxPages');
    const now = optionValue(options, 'now');
    const policy: unknown = optionValue(options, 'policy');
    const onGap = optionValue(options, 'onGap');
    if (!positiveBound(pageSize, MAX_CATCH_UP_PAGE_SIZE)
      || !positiveBound(maxPages, MAX_CATCH_UP_PAGES)
      || (policy !== undefined && policy !== 'live-edge' && policy !== 'strict')
      || (onGap !== undefined && typeof onGap !== 'function')
      || (now !== undefined && typeof now !== 'function')) {
      throw new TypeError('Catch-up scanner bounds are invalid.');
    }
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.policy = policy ?? 'strict';
    this.onGap = onGap;
    this.now = now ?? Date.now;
  }

  public async scan(): Promise<CatchUpScanResult> {
    const observedAtMs = this.readNow();
    const scans: ProgramScan[] = [];
    for (const program of PROGRAMS) {
      const checkpoint = await this.readCheckpoint(program.key);
      scans.push(await this.scanProgram(program, checkpoint, observedAtMs));
    }

    const merged = merge(scans);
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
        throw new CatchUpScannerError('enqueue');
      }
    }

    let checkpointWriteCount = 0;
    for (const scan of scans) {
      if (scan.newest === null) continue;
      const checkpoint: ProcessingCheckpoint = Object.freeze({
        key: scan.program.key,
        slot: scan.newest.slot,
        signature: scan.newest.signature,
        updatedAtMs: observedAtMs,
      });
      try {
        if (scan.gap === null) {
          await this.repository.storeCheckpoint(checkpoint);
        } else {
          await this.repository.recordCatchUpGap(scan.gap);
          this.reportGap(scan.gap);
        }
        checkpointWriteCount += 1;
      } catch {
        throw new CatchUpScannerError('checkpoint-write');
      }
    }

    return Object.freeze({
      discoveredCount: scans.reduce((sum, scan) => sum + scan.rows.length, 0),
      enqueuedCount: merged.length,
      checkpointWriteCount,
      pageCount: scans.reduce((sum, scan) => sum + scan.pageCount, 0),
    });
  }

  private async scanProgram(
    program: ProgramDefinition,
    checkpoint: ProcessingCheckpoint | null,
    observedAtMs: number,
  ): Promise<ProgramScan> {
    const rows: CatchUpSignature[] = [];
    const signatures = new Set<string>();
    const cursors = new Set<string>();
    let before: string | undefined;
    let completed = false;
    let pageCount = 0;
    let previousSlot: bigint | null = null;

    scanPages: while (pageCount < this.maxPages) {
      let rawPage: unknown;
      try {
        rawPage = await this.source.list(program.id, before, this.pageSize);
      } catch (error) {
        throw new CatchUpSourceError(
          trustedCatchUpSourceErrorStage(error) ?? 'request',
          program.key,
        );
      }
      let page: readonly CatchUpSignature[];
      try {
        page = snapshotCatchUpSignatures(rawPage, this.pageSize);
      } catch {
        throw new CatchUpSourceError('response', program.key);
      }
      pageCount += 1;
      for (const row of page) {
        if (previousSlot !== null && row.slot > previousSlot) {
          throw new CatchUpSourceError('response', program.key);
        }
        previousSlot = row.slot;
        if (signatures.has(row.signature)) throw new CatchUpSourceError('pagination', program.key);
        if (checkpoint !== null
          && row.signature === checkpoint.signature
          && row.slot === checkpoint.slot) {
          completed = true;
          break scanPages;
        }
        signatures.add(row.signature);
        rows.push(row);
      }
      if (checkpoint === null) {
        completed = true;
        break;
      }
      if (this.policy === 'live-edge') {
        const baseline = page[0];
        if (baseline === undefined) {
          throw new CatchUpWindowExceededError(program.key);
        }
        const baselineCheckpoint: ProcessingCheckpoint = Object.freeze({
          key: program.key,
          slot: baseline.slot,
          signature: baseline.signature,
          updatedAtMs: observedAtMs,
        });
        const gap = createCatchUpGap(checkpoint, baselineCheckpoint, baselineCheckpoint.updatedAtMs);
        return Object.freeze({
          program,
          rows: Object.freeze([]),
          newest: baseline,
          pageCount,
          gap,
        });
      }
      if (page.length < this.pageSize) {
        throw new CatchUpWindowExceededError(program.key);
      }
      const cursor = page.at(-1)?.signature;
      if (cursor === undefined || cursor === before || cursors.has(cursor)) {
        throw new CatchUpSourceError('pagination', program.key);
      }
      cursors.add(cursor);
      before = cursor;
    }
    if (!completed) throw new CatchUpWindowExceededError(program.key);

    const newest = rows[0] ?? null;
    const monotonicNewest = checkpoint !== null && newest !== null && newest.slot < checkpoint.slot
      ? null
      : newest;
    return Object.freeze({
      program,
      rows: Object.freeze(rows),
      newest: monotonicNewest,
      pageCount,
      gap: null,
    });
  }

  private async readCheckpoint(key: ProgramKey): Promise<ProcessingCheckpoint | null> {
    let checkpoint: ProcessingCheckpoint | null;
    try {
      const raw = await this.repository.readCheckpoint(key);
      checkpoint = raw === null ? null : snapshotCheckpoint(raw);
    } catch {
      throw new CatchUpScannerError('checkpoint-read');
    }
    if (checkpoint !== null && checkpoint.key !== key) {
      throw new CatchUpScannerError('checkpoint-read');
    }
    return checkpoint;
  }

  private readNow(): number {
    let value: number;
    try {
      value = this.now();
    } catch {
      throw new CatchUpScannerError('checkpoint-read');
    }
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError('Catch-up scanner clock is invalid.');
    }
    return value;
  }

  private reportGap(gap: CatchUpGap): void {
    if (this.onGap === undefined) return;
    try {
      this.onGap(gap);
    } catch {
      // Durable recovery must not be rolled back by an observational logger.
    }
  }
}

function snapshotCheckpoint(value: unknown): ProcessingCheckpoint {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('invalid');
    }
    const key = ownData(value, 'key');
    const slot = ownData(value, 'slot');
    const signature = ownData(value, 'signature');
    const updatedAtMs = ownData(value, 'updatedAtMs');
    if ((key !== 'launchpad' && key !== 'market')
      || typeof slot !== 'bigint'
      || slot < 0n
      || typeof signature !== 'string'
      || signature.length === 0
      || signature.length > 128
      || typeof updatedAtMs !== 'number'
      || !Number.isSafeInteger(updatedAtMs)
      || updatedAtMs < 0
      || Object.is(updatedAtMs, -0)) {
      throw new TypeError('invalid');
    }
    return Object.freeze({ key, slot, signature, updatedAtMs });
  } catch {
    throw new CatchUpScannerError('checkpoint-read');
  }
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError('invalid');
  }
  return descriptor.value;
}

function optionValue<K extends keyof CatchUpScannerOptions>(
  options: CatchUpScannerOptions,
  key: K,
): CatchUpScannerOptions[K] {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined) return undefined as CatchUpScannerOptions[K];
    if (!('value' in descriptor) || descriptor.enumerable !== true) throw new TypeError('invalid');
    return descriptor.value as CatchUpScannerOptions[K];
  } catch {
    throw new TypeError('Catch-up scanner bounds are invalid.');
  }
}

function merge(scans: readonly ProgramScan[]): readonly MergedDiscovery[] {
  const bySignature = new Map<string, MergedDiscovery>();
  for (const scan of scans) {
    for (const row of scan.rows) {
      const previous = bySignature.get(row.signature);
      if (previous === undefined) {
        bySignature.set(row.signature, Object.freeze({
          ...row,
          programIds: Object.freeze([scan.program.id]),
        }));
        continue;
      }
      const reconciled = reconcileDiscovery(previous, row, scan.program.key);
      bySignature.set(row.signature, Object.freeze({
        ...reconciled,
        programIds: Object.freeze([...previous.programIds, scan.program.id].sort(lexicalOrder)),
      }));
    }
  }
  return Object.freeze([...bySignature.values()].sort(discoveryOrder));
}

function reconcileDiscovery(
  current: CatchUpSignature,
  incoming: CatchUpSignature,
  program: ProgramKey,
): CatchUpSignature {
  if (current.slot !== incoming.slot) throw new CatchUpSourceError('response', program);
  if (current.blockTimeMs !== null
    && incoming.blockTimeMs !== null
    && current.blockTimeMs !== incoming.blockTimeMs) {
    throw new CatchUpSourceError('response', program);
  }
  const confirmationStatus = reconcileConfirmationStatus(
    current.confirmationStatus,
    incoming.confirmationStatus,
  ) === 'update' ? incoming.confirmationStatus : current.confirmationStatus;
  return Object.freeze({
    signature: current.signature,
    slot: current.slot,
    confirmationStatus,
    blockTimeMs: current.blockTimeMs ?? incoming.blockTimeMs,
  });
}

function discoveryOrder(left: MergedDiscovery, right: MergedDiscovery): number {
  if (left.slot !== right.slot) return left.slot < right.slot ? -1 : 1;
  const signature = lexicalOrder(left.signature, right.signature);
  if (signature !== 0) return signature;
  return lexicalOrder(left.programIds[0] ?? '', right.programIds[0] ?? '');
}

function lexicalOrder(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function positiveBound(value: unknown, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= maximum;
}
