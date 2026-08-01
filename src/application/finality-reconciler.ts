import {
  assertValidFinalityCandidate,
  type FinalityCandidate,
} from '../domain/transaction-ingestion.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';

export const DEFAULT_FINALITY_MISSING_POLL_THRESHOLD = 3;
export const MIN_FINALITY_MISSING_POLL_THRESHOLD = 2;
export const MAX_FINALITY_RECONCILE_LIMIT = 1_000;

export interface FinalityHistoryStatus {
  readonly slot: bigint;
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized';
}

export interface FinalityReconcilerSource {
  getHistoryStatuses(signatures: readonly string[]): Promise<unknown>;
  getFinalizedSlot(): Promise<unknown>;
}

export type FinalityReconcilerRepository = Pick<
  TransactionInboxRepository,
  'listForFinality' | 'recordFinalityPoll' | 'enqueueRevision'
>;

export interface FinalityReconcilerOptions {
  readonly limit: number;
  readonly missingPollThreshold?: number;
  readonly now?: () => number;
}

export interface FinalityReconcileResult {
  readonly candidateCount: number;
  readonly pollCount: number;
  readonly revisionCount: number;
}

export type FinalityReconcilerErrorStage =
  | 'list'
  | 'history'
  | 'root'
  | 'poll'
  | 'revision'
  | 'clock'
  | 'finality-contradiction';

export class FinalityReconcilerError extends Error {
  public constructor(public readonly stage: FinalityReconcilerErrorStage) {
    super('Transaction finality reconciliation failed.');
    this.name = 'FinalityReconcilerError';
    Object.freeze(this);
  }
}

export class FinalityReconciler {
  private readonly limit: number;
  private readonly missingPollThreshold: number;
  private readonly now: () => number;

  public constructor(
    private readonly source: FinalityReconcilerSource,
    private readonly repository: FinalityReconcilerRepository,
    options: FinalityReconcilerOptions,
  ) {
    if (!boundedPositiveInteger(options.limit, MAX_FINALITY_RECONCILE_LIMIT)) {
      throw new TypeError('Finality reconcile limit is invalid.');
    }
    const threshold = options.missingPollThreshold
      ?? DEFAULT_FINALITY_MISSING_POLL_THRESHOLD;
    if (!Number.isSafeInteger(threshold)
      || threshold < MIN_FINALITY_MISSING_POLL_THRESHOLD) {
      throw new TypeError('Finality missing poll threshold is invalid.');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('Finality reconciler clock is invalid.');
    }
    this.limit = options.limit;
    this.missingPollThreshold = threshold;
    this.now = options.now ?? Date.now;
  }

  public async runOnce(): Promise<FinalityReconcileResult> {
    const candidates = await this.readCandidates();
    if (candidates.length === 0) return result(0, 0, 0);

    const signatures = Object.freeze(candidates.map((candidate) => candidate.signature));
    const [rawStatuses, rawRoot] = await Promise.all([
      this.readHistory(signatures),
      this.readRoot(),
    ]);
    const statuses = snapshotStatuses(rawStatuses, candidates.length);
    const finalizedRoot = finalizedSlot(rawRoot);
    assertConsistentHistory(candidates, statuses, finalizedRoot);
    const observedAtMs = this.readNow();

    let pollCount = 0;
    let revisionCount = 0;
    for (const [index, candidate] of candidates.entries()) {
      const status = statuses[index];
      if (status === undefined) throw new FinalityReconcilerError('history');
      if (status?.confirmationStatus === 'finalized') {
        await this.enqueueRevision(candidate.signature, 'finalized', observedAtMs);
        revisionCount += 1;
        continue;
      }

      const polled = await this.recordPoll(candidate, status?.confirmationStatus ?? null, observedAtMs);
      pollCount += 1;
      if (status === null
        && polled.missingFinalityPolls >= this.missingPollThreshold
        && finalizedRoot > candidate.slot) {
        await this.enqueueRevision(candidate.signature, 'orphaned', observedAtMs);
        revisionCount += 1;
      }
    }
    return result(candidates.length, pollCount, revisionCount);
  }

  private async readCandidates(): Promise<readonly FinalityCandidate[]> {
    try {
      const values = await this.repository.listForFinality(this.limit);
      if (Object.getPrototypeOf(values) !== Array.prototype
        || values.length > this.limit
        || Reflect.ownKeys(values).length !== values.length + 1) {
        throw new TypeError('Invalid finality candidate page.');
      }
      return Object.freeze(values.map((value) => snapshotCandidate(value)));
    } catch {
      throw new FinalityReconcilerError('list');
    }
  }

  private async readHistory(signatures: readonly string[]): Promise<unknown> {
    try {
      return await this.source.getHistoryStatuses(signatures);
    } catch {
      throw new FinalityReconcilerError('history');
    }
  }

  private async readRoot(): Promise<unknown> {
    try {
      return await this.source.getFinalizedSlot();
    } catch {
      throw new FinalityReconcilerError('root');
    }
  }

  private async recordPoll(
    candidate: FinalityCandidate,
    confirmationStatus: 'processed' | 'confirmed' | null,
    observedAtMs: number,
  ): Promise<FinalityCandidate> {
    try {
      const rawUpdated = await this.repository.recordFinalityPoll(Object.freeze({
        signature: candidate.signature,
        confirmationStatus,
        expectedMissingFinalityPolls: candidate.missingFinalityPolls,
        observedAtMs,
      }));
      const updated = snapshotCandidate(rawUpdated);
      assertPollTransition(candidate, confirmationStatus, updated);
      return updated;
    } catch {
      throw new FinalityReconcilerError('poll');
    }
  }

  private async enqueueRevision(
    signature: string,
    confirmationStatus: 'finalized' | 'orphaned',
    observedAtMs: number,
  ): Promise<void> {
    try {
      await this.repository.enqueueRevision(Object.freeze({
        signature, confirmationStatus, observedAtMs,
      }));
    } catch {
      throw new FinalityReconcilerError('revision');
    }
  }

  private readNow(): number {
    try {
      const value = this.now();
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new TypeError('Invalid finality reconcile time.');
      }
      return value;
    } catch {
      throw new FinalityReconcilerError('clock');
    }
  }
}

function snapshotStatuses(value: unknown, expectedLength: number): readonly (FinalityHistoryStatus | null)[] {
  try {
    if (!Array.isArray(value)
      || value.length !== expectedLength
      || Reflect.ownKeys(value).length !== expectedLength + 1) {
      throw new TypeError('Invalid finality history batch.');
    }
    return Object.freeze(value.map((entry) => snapshotStatus(entry)));
  } catch {
    throw new FinalityReconcilerError('history');
  }
}

function snapshotCandidate(value: unknown): FinalityCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid finality candidate.');
  }
  const candidate = Object.freeze({
    signature: dataProperty(value, 'signature'),
    slot: dataProperty(value, 'slot'),
    confirmationStatus: dataProperty(value, 'confirmationStatus'),
    missingFinalityPolls: dataProperty(value, 'missingFinalityPolls'),
    processedAtMs: dataProperty(value, 'processedAtMs'),
  });
  assertValidFinalityCandidate(candidate);
  return candidate;
}

function assertPollTransition(
  before: FinalityCandidate,
  observed: 'processed' | 'confirmed' | null,
  after: FinalityCandidate,
): void {
  if (after.signature !== before.signature
    || after.slot !== before.slot
    || after.processedAtMs !== before.processedAtMs) {
    throw new TypeError('Finality poll identity changed.');
  }
  if (observed === null) {
    const expectedMissing = before.missingFinalityPolls + 1;
    if (!Number.isSafeInteger(expectedMissing)
      || after.confirmationStatus !== before.confirmationStatus
      || after.missingFinalityPolls !== expectedMissing) {
      throw new TypeError('Finality missing poll transition is invalid.');
    }
    return;
  }
  const expectedStatus = before.confirmationStatus === 'confirmed'
    || observed === 'confirmed'
    ? 'confirmed'
    : 'processed';
  if (after.confirmationStatus !== expectedStatus || after.missingFinalityPolls !== 0) {
    throw new TypeError('Finality observed poll transition is invalid.');
  }
}

function snapshotStatus(value: unknown): FinalityHistoryStatus | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid finality history status.');
  }
  const slot = dataProperty(value, 'slot');
  const status = dataProperty(value, 'confirmationStatus');
  if (typeof slot !== 'bigint' || slot < 0n
    || (status !== 'processed' && status !== 'confirmed' && status !== 'finalized')) {
    throw new TypeError('Invalid finality history status.');
  }
  return Object.freeze({ slot, confirmationStatus: status });
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError('Invalid finality history status.');
  }
  return descriptor.value as unknown;
}

function finalizedSlot(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new FinalityReconcilerError('root');
  }
  return value;
}

function assertConsistentHistory(
  candidates: readonly FinalityCandidate[],
  statuses: readonly (FinalityHistoryStatus | null)[],
  finalizedRoot: bigint,
): void {
  for (const [index, candidate] of candidates.entries()) {
    const status = statuses[index];
    if (status === undefined) throw new FinalityReconcilerError('history');
    if (status !== null
      && (status.slot !== candidate.slot
        || (status.confirmationStatus === 'finalized' && finalizedRoot < candidate.slot))) {
      throw new FinalityReconcilerError('finality-contradiction');
    }
  }
}

function result(
  candidateCount: number,
  pollCount: number,
  revisionCount: number,
): FinalityReconcileResult {
  return Object.freeze({ candidateCount, pollCount, revisionCount });
}

function boundedPositiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum && !Object.is(value, -0);
}
