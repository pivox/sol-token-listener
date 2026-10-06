import type {
  ProcessingCheckpoint,
  TransactionNotification,
} from '../domain/transaction-ingestion.js';
import { reconcileConfirmationStatus } from '../domain/confirmation-status.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';
import type { FinalizedProgramFrontier } from './program-finalized-frontier.js';
import {
  CatchUpSourceError,
  MAX_CATCH_UP_PAGE_SIZE,
  snapshotCatchUpSignatures,
  trustedCatchUpSourceErrorStage,
  type CatchUpSignature,
} from '../solana/rpc/catch-up-source.js';

export const MAX_CATCH_UP_PAGES = 100;

export type CatchUpProgram = 'launchpad' | 'market';
type ProgramKey = CatchUpProgram;

export type ProgramFinalizedFrontiers = Readonly<Partial<Record<ProgramKey, FinalizedProgramFrontier>>>;

export interface CatchUpSource {
  list(programId: string, before: string | undefined, limit: number): Promise<unknown>;
}

export type CatchUpScannerRepository = Pick<
  TransactionInboxRepository,
  'enqueue' | 'readCheckpoint' | 'storeCheckpoint'
>;

export interface CatchUpScannerOptions {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly now?: () => number;
  /** Programs this scanner reads and checkpoints. Defaults to both. */
  readonly programs?: readonly CatchUpProgram[];
}

export interface CatchUpScanResult {
  readonly discoveredCount: number;
  readonly enqueuedCount: number;
  readonly checkpointWriteCount: number;
  readonly pageCount: number;
  readonly programs: Readonly<Partial<Record<ProgramKey, CatchUpProgramScanResult>>>;
}

export interface CatchUpProgramScanResult {
  readonly checkpointSlot: string | null;
  readonly checkpointSignature: string | null;
  readonly priorCheckpointSlot: string | null;
  readonly priorCheckpointSignature: string | null;
  readonly frontierSlot: string | null;
  readonly frontierSignature: string | null;
  readonly durableFrontier: Readonly<{ signature: string; slot: string }> | null;
  readonly pageCount: number;
  readonly signaturesRead: number;
  readonly signaturesEnqueued: number;
  readonly newestSlot: string | null;
  readonly oldestSlot: string | null;
}

export type CatchUpScannerStage =
  | 'checkpoint-read' | 'frontier-validation' | 'enqueue' | 'checkpoint-write';

export interface CatchUpScanProgress {
  readonly pageCount: number;
  readonly signaturesRead: number;
  readonly newestSlot: string | null;
  readonly oldestSlot: string | null;
}

export class CatchUpScannerError extends Error {
  public constructor(
    public readonly stage: CatchUpScannerStage,
    public readonly program?: ProgramKey,
    public readonly signaturesEnqueued = 0,
    public readonly scanProgress: CatchUpScanProgress | null = null,
  ) {
    super('Catch-up scanner durable operation failed.');
    this.name = 'CatchUpScannerError';
    Object.freeze(this);
  }
}

export class CatchUpWindowExceededError extends Error {
  public readonly stage = 'window' as const;
  public readonly code = 'CATCH_UP_WINDOW_EXCEEDED' as const;
  public readonly retryable = false;

  public constructor(
    public readonly program: ProgramKey,
    public readonly diagnostic: CatchUpWindowDiagnostic,
  ) {
    super('Catch-up scan window was exceeded.');
    this.name = 'CatchUpWindowExceededError';
    Object.freeze(this);
  }
}

export interface CatchUpWindowDiagnostic {
  readonly program: ProgramKey;
  readonly checkpointSlot: string | null;
  readonly checkpointSignature: string | null;
  readonly frontierSlot: string | null;
  readonly frontierSignature: string | null;
  readonly pageSize: number;
  readonly maxPages: number;
  readonly pageCount: number;
  readonly signaturesRead: number;
  readonly newestSlot: string | null;
  readonly oldestSlot: string | null;
  readonly checkpointSignatureFound: boolean;
  readonly frontierSignatureFound: boolean;
  readonly exhaustion: 'page-budget-exhausted' | 'source-history-exhausted';
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
  readonly signaturesRead: number;
  readonly priorCheckpoint: ProcessingCheckpoint | null;
  readonly frontier: FinalizedProgramFrontier | undefined;
  readonly frontierSignatureFound: boolean;
  readonly terminalCutover: boolean;
  readonly newestObservedSlot: string | null;
  readonly oldestObservedSlot: string | null;
}

interface MergedDiscovery extends CatchUpSignature {
  readonly programIds: readonly string[];
}

const PROGRAMS: readonly ProgramDefinition[] = Object.freeze([
  Object.freeze({ key: 'launchpad', id: PUMP_PROGRAM_ID }),
  Object.freeze({ key: 'market', id: PUMPSWAP_PROGRAM_ID }),
]);

function programDefinition(key: ProgramKey): ProgramDefinition {
  const definition = PROGRAMS.find((program) => program.key === key);
  if (definition === undefined) throw new CatchUpScannerError('frontier-validation', key);
  return definition;
}

function terminalCutoverMap(
  frontiers: readonly FinalizedProgramFrontier[],
): ReadonlyMap<ProgramKey, FinalizedProgramFrontier> {
  const result = new Map<ProgramKey, FinalizedProgramFrontier>();
  for (const frontier of frontiers) {
    const candidate: unknown = frontier;
    if (!isFinalizedFrontier(candidate) || result.has(candidate.program)) {
      throw new CatchUpScannerError('frontier-validation');
    }
    result.set(candidate.program, candidate);
  }
  return result;
}

function isFinalizedFrontier(value: unknown): value is FinalizedProgramFrontier {
  if (typeof value !== 'object' || value === null) return false;
  const frontier = value as Partial<FinalizedProgramFrontier>;
  const isKnownProgram = frontier.program === 'launchpad' || frontier.program === 'market';
  return isKnownProgram
    && typeof frontier.signature === 'string'
    && frontier.signature.length > 0
    && typeof frontier.slot === 'bigint'
    && frontier.slot >= 0n
    && frontier.confirmationStatus === 'finalized';
}

function validFrontier(program: ProgramKey, value: unknown): value is FinalizedProgramFrontier {
  if (!isFinalizedFrontier(value)) return false;
  const frontier = value;
  return frontier.program === program;
}

function programResult(scan: ProgramScan): CatchUpProgramScanResult {
  const checkpoint = scan.newest ?? scan.priorCheckpoint;
  return Object.freeze({
    checkpointSlot: checkpoint?.slot.toString() ?? null,
    checkpointSignature: checkpoint?.signature ?? null,
    priorCheckpointSlot: scan.priorCheckpoint?.slot.toString() ?? null,
    priorCheckpointSignature: scan.priorCheckpoint?.signature ?? null,
    frontierSlot: scan.frontier?.slot.toString() ?? null,
    frontierSignature: scan.frontier?.signature ?? null,
    durableFrontier: checkpoint === null ? null : Object.freeze({
      signature: checkpoint.signature,
      slot: checkpoint.slot.toString(),
    }),
    pageCount: scan.pageCount,
    signaturesRead: scan.signaturesRead,
    signaturesEnqueued: scan.rows.length,
    newestSlot: scan.newestObservedSlot,
    oldestSlot: scan.oldestObservedSlot,
  });
}

function scanProgress(scan: ProgramScan | undefined): CatchUpScanProgress | null {
  return scan === undefined ? null : Object.freeze({
    pageCount: scan.pageCount,
    signaturesRead: scan.signaturesRead,
    newestSlot: scan.newestObservedSlot,
    oldestSlot: scan.oldestObservedSlot,
  });
}

export class CatchUpScanner {
  private readonly now: () => number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly programs: readonly ProgramDefinition[];

  public constructor(
    private readonly source: CatchUpSource,
    private readonly repository: CatchUpScannerRepository,
    options: CatchUpScannerOptions,
  ) {
    const pageSize = optionValue(options, 'pageSize');
    const maxPages = optionValue(options, 'maxPages');
    const now = optionValue(options, 'now');
    if (!positiveBound(pageSize, MAX_CATCH_UP_PAGE_SIZE)
      || !positiveBound(maxPages, MAX_CATCH_UP_PAGES)
      || (now !== undefined && typeof now !== 'function')) {
      throw new TypeError('Catch-up scanner bounds are invalid.');
    }
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.now = now ?? Date.now;
    const enabled: readonly unknown[] | undefined = optionValue(options, 'programs');
    if (enabled !== undefined && !validProgramList(enabled)) {
      throw new TypeError('Catch-up scanner program list is invalid.');
    }
    const keys = enabled ?? ['launchpad', 'market'];
    this.programs = Object.freeze(PROGRAMS.filter((program) => keys.includes(program.key)));
  }

  public async scan(
    frontiers?: ProgramFinalizedFrontiers,
    terminalCutovers: readonly FinalizedProgramFrontier[] = [],
  ): Promise<CatchUpScanResult> {
    if (frontiers !== undefined && !this.validEnabledFrontiers(frontiers)) {
      throw new CatchUpScannerError('frontier-validation');
    }
    const cutovers = terminalCutoverMap(terminalCutovers);
    if (cutovers.size > 0 && frontiers === undefined) {
      throw new CatchUpScannerError('frontier-validation');
    }
    for (const program of cutovers.keys()) {
      if (!this.isEnabled(program)) throw new CatchUpScannerError('frontier-validation', program);
    }
    const observedAtMs = this.readNow();
    const scans: ProgramScan[] = [];
    for (const program of this.programs) {
      const checkpoint = await this.readCheckpoint(program.key);
      const frontier = frontiers?.[program.key];
      const terminal = cutovers.get(program.key);
      if (terminal !== undefined) {
        if (checkpoint?.slot !== terminal.slot || checkpoint.signature !== terminal.signature) {
          throw new CatchUpScannerError('checkpoint-read', program.key);
        }
        scans.push(Object.freeze({
          program,
          rows: Object.freeze([]),
          newest: null,
          pageCount: 0,
          signaturesRead: 0,
          priorCheckpoint: checkpoint,
          frontier: terminal,
          frontierSignatureFound: true,
          terminalCutover: true,
          newestObservedSlot: null,
          oldestObservedSlot: null,
        }));
      } else {
        const scan = await this.scanProgramHistory(program, checkpoint, frontier);
        if (frontier !== undefined && !scan.frontierSignatureFound) {
          throw new CatchUpScannerError('frontier-validation', program.key);
        }
        scans.push(scan);
      }
    }

    return this.persistScans(scans, observedAtMs);
  }

  public async scanProgram(
    programKey: 'launchpad' | 'market',
    frontier: FinalizedProgramFrontier,
  ): Promise<CatchUpProgramScanResult> {
    if (!this.isEnabled(programKey) || !validFrontier(programKey, frontier)) {
      throw new CatchUpScannerError('frontier-validation', programKey);
    }
    const observedAtMs = this.readNow();
    const checkpoint = await this.readCheckpoint(programKey);
    if (checkpoint !== null && checkpoint.slot === frontier.slot && checkpoint.signature === frontier.signature) {
      return programResult(Object.freeze({
        program: programDefinition(programKey),
        rows: Object.freeze([]),
        newest: null,
        pageCount: 0,
        signaturesRead: 0,
        priorCheckpoint: checkpoint,
        frontier,
        frontierSignatureFound: true,
        terminalCutover: false,
        newestObservedSlot: null,
        oldestObservedSlot: null,
      }));
    }
    const scan = await this.scanProgramHistory(programDefinition(programKey), checkpoint, frontier);
    if (!scan.frontierSignatureFound) {
      throw new CatchUpScannerError('frontier-validation', programKey, 0, scanProgress(scan));
    }
    const persisted = await this.persistScans([scan], observedAtMs);
    const result = persisted.programs[programKey];
    if (result === undefined) throw new CatchUpScannerError('frontier-validation', programKey);
    return result;
  }

  public enabledPrograms(): readonly CatchUpProgram[] {
    return Object.freeze(this.programs.map((program) => program.key));
  }

  private isEnabled(key: ProgramKey): boolean {
    return this.programs.some((program) => program.key === key);
  }

  private validEnabledFrontiers(value: ProgramFinalizedFrontiers): boolean {
    return this.programs.every(({ key }) => validFrontier(key, value[key]));
  }

  private async persistScans(scans: readonly ProgramScan[], observedAtMs: number): Promise<CatchUpScanResult> {

    const merged = merge(scans);
    let enqueuedCount = 0;
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
        enqueuedCount += 1;
      } catch {
        const scan = scans.length === 1 ? scans[0] : undefined;
        throw new CatchUpScannerError('enqueue', scan?.program.key, enqueuedCount, scanProgress(scan));
      }
    }

    let checkpointWriteCount = 0;
    for (const scan of scans) {
      if (scan.newest === null || scan.terminalCutover) continue;
      const checkpoint: ProcessingCheckpoint = Object.freeze({
        key: scan.program.key,
        slot: scan.newest.slot,
        signature: scan.newest.signature,
        updatedAtMs: observedAtMs,
      });
      try {
        await this.repository.storeCheckpoint(checkpoint);
        checkpointWriteCount += 1;
      } catch {
        const singleScan = scans.length === 1 ? scan : undefined;
        throw new CatchUpScannerError('checkpoint-write', singleScan?.program.key, enqueuedCount, scanProgress(singleScan));
      }
    }

    return Object.freeze({
      discoveredCount: scans.reduce((sum, scan) => sum + scan.rows.length, 0),
      enqueuedCount: merged.length,
      checkpointWriteCount,
      pageCount: scans.reduce((sum, scan) => sum + scan.pageCount, 0),
      programs: Object.freeze(Object.fromEntries(scans.map((scan) => [scan.program.key, Object.freeze({
        ...programResult(scan),
      })])) as Partial<Record<ProgramKey, CatchUpProgramScanResult>>),
    });
  }

  private async scanProgramHistory(
    program: ProgramDefinition,
    checkpoint: ProcessingCheckpoint | null,
    frontier: FinalizedProgramFrontier | undefined,
  ): Promise<ProgramScan> {
    const rows: CatchUpSignature[] = [];
    const signatures = new Set<string>();
    const cursors = new Set<string>();
    let before: string | undefined;
    let completed = false;
    let pageCount = 0;
    let previousSlot: bigint | null = null;
    let newestSlot: bigint | null = null;
    let oldestSlot: bigint | null = null;
    let checkpointSignatureFound = false;
    let frontierSignatureFound = false;
    let signaturesRead = 0;

    scanPages: while (pageCount < this.maxPages) {
      let rawPage: unknown;
      try {
        rawPage = await this.source.list(program.id, before, this.pageSize);
      } catch (error) {
        throw new CatchUpSourceError(
          trustedCatchUpSourceErrorStage(error) ?? 'request',
          program.key,
          Object.freeze({
            pageCount,
            signaturesRead,
            newestSlot: newestSlot?.toString() ?? null,
            oldestSlot: oldestSlot?.toString() ?? null,
          }),
        );
      }
      let page: readonly CatchUpSignature[];
      try {
        page = snapshotCatchUpSignatures(rawPage, this.pageSize);
      } catch {
        throw new CatchUpSourceError('response', program.key, Object.freeze({
          pageCount,
          signaturesRead,
          newestSlot: newestSlot?.toString() ?? null,
          oldestSlot: oldestSlot?.toString() ?? null,
        }));
      }
      pageCount += 1;
      for (const row of page) {
        signaturesRead += 1;
        newestSlot ??= row.slot;
        oldestSlot = row.slot;
        if (previousSlot !== null && row.slot > previousSlot) {
          throw new CatchUpSourceError('response', program.key);
        }
        previousSlot = row.slot;
        if (signatures.has(row.signature)) throw new CatchUpSourceError('pagination', program.key);
        if (checkpoint !== null && row.signature === checkpoint.signature) checkpointSignatureFound = true;
        if (frontier?.signature === row.signature) {
          if (row.slot !== frontier.slot) throw new CatchUpScannerError('frontier-validation', program.key);
          frontierSignatureFound = true;
        }
        if (checkpoint !== null
          && row.signature === checkpoint.signature
          && row.slot === checkpoint.slot) {
          completed = true;
          break scanPages;
        }
        signatures.add(row.signature);
        if (frontier === undefined || row.slot <= frontier.slot) rows.push(row);
      }
      if (checkpoint === null && (frontier === undefined || frontierSignatureFound)) {
        completed = true;
        break;
      }
      if (page.length < this.pageSize) {
        break;
      }
      const cursor = page.at(-1)?.signature;
      if (cursor === undefined || cursor === before || cursors.has(cursor)) {
        throw new CatchUpSourceError('pagination', program.key);
      }
      cursors.add(cursor);
      before = cursor;
    }
    if (!completed) {
      throw new CatchUpWindowExceededError(program.key, Object.freeze({
        program: program.key,
        checkpointSlot: checkpoint?.slot.toString() ?? null,
        checkpointSignature: checkpoint === null ? null : truncateSignature(checkpoint.signature),
        frontierSlot: frontier?.slot.toString() ?? null,
        frontierSignature: frontier?.signature ?? null,
        pageSize: this.pageSize,
        maxPages: this.maxPages,
        pageCount,
        signaturesRead,
        newestSlot: newestSlot?.toString() ?? null,
        oldestSlot: oldestSlot?.toString() ?? null,
        checkpointSignatureFound,
        frontierSignatureFound,
        exhaustion: pageCount === this.maxPages && signaturesRead === this.pageSize * this.maxPages
          ? 'page-budget-exhausted' : 'source-history-exhausted',
      }));
    }

    const newest = frontier === undefined
      ? rows[0] ?? null
      : rows.find((row) => row.signature === frontier.signature) ?? null;
    const monotonicNewest = checkpoint !== null && newest !== null && newest.slot < checkpoint.slot
      ? null
      : newest;
    return Object.freeze({
      program,
      rows: Object.freeze(rows),
      newest: monotonicNewest,
      pageCount,
      signaturesRead,
      priorCheckpoint: checkpoint,
      frontier,
      frontierSignatureFound,
      terminalCutover: false,
      newestObservedSlot: newestSlot?.toString() ?? null,
      oldestObservedSlot: oldestSlot?.toString() ?? null,
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
}

function validProgramList(value: readonly unknown[]): value is readonly CatchUpProgram[] {
  return Array.isArray(value)
    && value.length > 0
    && new Set(value).size === value.length
    && value.every((key) => key === 'launchpad' || key === 'market')
    && value.includes('launchpad');
}

function truncateSignature(signature: string): string {
  if (signature.length <= 16) return signature;
  return `${signature.slice(0, 8)}…${signature.slice(-8)}`;
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
