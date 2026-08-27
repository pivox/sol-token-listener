import bs58 from 'bs58';
import {
  MAX_FINALITY_EVIDENCE_VERSION,
  assertValidFinalityCandidate,
  assertValidFinalityPollObservation,
  assertValidFinalityRevision,
  type FinalityCandidate,
  type FinalityPollObservation,
  type FinalityRevision,
} from '../domain/transaction-ingestion.js';
import { isRpcProviderId, type RpcProviderId } from '../domain/rpc-provider.js';
import type {
  FinalityProviderPass,
  FinalityProviderPassSource,
} from '../ports/finality-provider-pass.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';

export const DEFAULT_FINALITY_MISSING_POLL_THRESHOLD = 3;
export const MIN_FINALITY_MISSING_POLL_THRESHOLD = 2;
export const MAX_FINALITY_RECONCILE_LIMIT = 256;

const MAX_FINALITY_BLOCK_SLOTS_PER_RUN = 16;
const MAX_FINALIZED_BLOCK_SIGNATURES = 10_000;
const MAX_CAPABILITY_PROTOTYPE_DEPTH = 16;
const BASE58_TEXT = /^[1-9A-HJ-NP-Za-km-z]+$/u;
const MIN_SIGNATURE_LENGTH = 64;
const MAX_SIGNATURE_LENGTH = 88;

export interface FinalityHistoryStatus {
  readonly slot: bigint;
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized';
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
  | 'pass'
  | 'history'
  | 'root'
  | 'poll'
  | 'block'
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

interface CapturedFinalityPass {
  readonly providerId: RpcProviderId;
  getHistoryStatuses(signatures: readonly string[]): Promise<unknown>;
  getFinalizedSlot(): Promise<unknown>;
  getFinalizedBlockSignatures(slot: bigint): Promise<unknown>;
}

interface EligibleOrphan {
  readonly candidate: FinalityCandidate;
}

export class FinalityReconciler {
  private readonly limit: number;
  private readonly missingPollThreshold: number;
  private readonly now: () => number;

  public constructor(
    private readonly source: FinalityProviderPassSource,
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

    const pass = capturePass(this.source);
    const signatures = Object.freeze(candidates.map((candidate) => candidate.signature));
    const rawStatuses = await this.readHistory(pass, signatures);
    const statuses = snapshotStatuses(rawStatuses, candidates.length);
    const rawRoot = await this.readRoot(pass);
    const finalizedRoot = finalizedSlot(rawRoot);
    assertConsistentHistory(candidates, statuses, finalizedRoot);
    const observedAtMs = this.readNow();

    let pollCount = 0;
    let revisionCount = 0;
    const eligibleBySlot = new Map<bigint, EligibleOrphan[]>();
    for (const [index, candidate] of candidates.entries()) {
      const status = statuses[index];
      if (status === undefined) throw new FinalityReconcilerError('history');
      if (status?.confirmationStatus === 'finalized') {
        await this.enqueueFinalizedRevision(candidate.signature, observedAtMs);
        revisionCount += 1;
        continue;
      }

      const confirmationStatus = status?.confirmationStatus ?? null;
      const polled = await this.recordPoll(
        candidate,
        confirmationStatus,
        pass.providerId,
        observedAtMs,
      );
      pollCount += 1;
      if (confirmationStatus !== null
        || polled.missingFinalityPolls < this.missingPollThreshold
        || polled.lastMissingFinalityProviderId !== pass.providerId
        || finalizedRoot <= polled.slot) {
        continue;
      }
      const group = eligibleBySlot.get(polled.slot);
      const eligible = Object.freeze({ candidate: polled });
      if (group === undefined) eligibleBySlot.set(polled.slot, [eligible]);
      else group.push(eligible);
    }

    let blockSlotCount = 0;
    for (const [slot, eligible] of eligibleBySlot) {
      if (blockSlotCount >= MAX_FINALITY_BLOCK_SLOTS_PER_RUN) break;
      blockSlotCount += 1;
      const signaturesInBlock = await this.readBlock(pass, slot);
      const signatureSet = new Set(signaturesInBlock);
      if (eligible.some(({ candidate }) => signatureSet.has(candidate.signature))) {
        throw new FinalityReconcilerError('finality-contradiction');
      }
      for (const { candidate } of eligible) {
        await this.enqueueOrphanedRevision(candidate, observedAtMs);
        revisionCount += 1;
      }
    }
    return result(candidates.length, pollCount, revisionCount);
  }

  private async readCandidates(): Promise<readonly FinalityCandidate[]> {
    try {
      const values = await this.repository.listForFinality(this.limit);
      return snapshotDenseArray(
        values,
        (length) => length <= this.limit,
        snapshotCandidate,
      );
    } catch {
      throw new FinalityReconcilerError('list');
    }
  }

  private async readHistory(
    pass: CapturedFinalityPass,
    signatures: readonly string[],
  ): Promise<unknown> {
    try {
      return await pass.getHistoryStatuses(signatures);
    } catch {
      throw new FinalityReconcilerError('history');
    }
  }

  private async readRoot(pass: CapturedFinalityPass): Promise<unknown> {
    try {
      return await pass.getFinalizedSlot();
    } catch {
      throw new FinalityReconcilerError('root');
    }
  }

  private async readBlock(
    pass: CapturedFinalityPass,
    slot: bigint,
  ): Promise<readonly string[]> {
    try {
      const value = await pass.getFinalizedBlockSignatures(slot);
      return snapshotBlockSignatures(value);
    } catch {
      throw new FinalityReconcilerError('block');
    }
  }

  private async recordPoll(
    candidate: FinalityCandidate,
    confirmationStatus: 'processed' | 'confirmed' | null,
    providerId: RpcProviderId,
    observedAtMs: number,
  ): Promise<FinalityCandidate> {
    try {
      const expectedVersion = candidate.finalityEvidenceVersion + 1n;
      if (candidate.finalityEvidenceVersion >= MAX_FINALITY_EVIDENCE_VERSION
        || expectedVersion > MAX_FINALITY_EVIDENCE_VERSION) {
        throw new TypeError('Finality evidence version is exhausted.');
      }
      if (confirmationStatus === null
        && candidate.lastMissingFinalityProviderId === providerId
        && !Number.isSafeInteger(candidate.missingFinalityPolls + 1)) {
        throw new TypeError('Finality missing poll count is exhausted.');
      }
      const observation: FinalityPollObservation = Object.freeze({
        signature: candidate.signature,
        confirmationStatus,
        providerId,
        expectedMissingFinalityPolls: candidate.missingFinalityPolls,
        expectedLastMissingFinalityProviderId: candidate.lastMissingFinalityProviderId,
        expectedFinalityEvidenceVersion: candidate.finalityEvidenceVersion,
        observedAtMs,
      });
      assertValidFinalityPollObservation(observation);
      const rawUpdated = await this.repository.recordFinalityPoll(observation);
      const updated = snapshotCandidate(rawUpdated);
      assertPollTransition(candidate, confirmationStatus, providerId, expectedVersion, updated);
      return updated;
    } catch {
      throw new FinalityReconcilerError('poll');
    }
  }

  private async enqueueFinalizedRevision(
    signature: string,
    observedAtMs: number,
  ): Promise<void> {
    try {
      const revision: FinalityRevision = Object.freeze({
        signature,
        confirmationStatus: 'finalized',
        observedAtMs,
      });
      assertValidFinalityRevision(revision);
      await this.repository.enqueueRevision(revision);
    } catch {
      throw new FinalityReconcilerError('revision');
    }
  }

  private async enqueueOrphanedRevision(
    candidate: FinalityCandidate,
    observedAtMs: number,
  ): Promise<void> {
    try {
      const providerId = candidate.lastMissingFinalityProviderId;
      if (providerId === null) throw new TypeError('Missing orphan provider evidence.');
      const revision: FinalityRevision = Object.freeze({
        signature: candidate.signature,
        confirmationStatus: 'orphaned',
        expectedConfirmationStatus: candidate.confirmationStatus,
        expectedMissingFinalityPolls: candidate.missingFinalityPolls,
        expectedLastMissingFinalityProviderId: providerId,
        expectedFinalityEvidenceVersion: candidate.finalityEvidenceVersion,
        observedAtMs,
      });
      assertValidFinalityRevision(revision);
      await this.repository.enqueueRevision(revision);
    } catch {
      throw new FinalityReconcilerError('revision');
    }
  }

  private readNow(): number {
    try {
      const value: unknown = Reflect.apply(this.now, undefined, []);
      if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
        throw new TypeError('Invalid finality reconcile time.');
      }
      return value as number;
    } catch {
      throw new FinalityReconcilerError('clock');
    }
  }
}

function capturePass(source: FinalityProviderPassSource): CapturedFinalityPass {
  try {
    if (!objectRecord(source)) throw new TypeError('Invalid finality pass source.');
    const openPass = dataMethod(source, 'openPass');
    const rawPass: unknown = Reflect.apply(openPass, source, []);
    if (!objectRecord(rawPass)) throw new TypeError('Invalid finality pass.');
    const pass = rawPass as FinalityProviderPass;
    const providerId = dataValue(pass, 'providerId');
    if (!isRpcProviderId(providerId)) throw new TypeError('Invalid finality provider.');
    const history = dataMethod(pass, 'getHistoryStatuses');
    const root = dataMethod(pass, 'getFinalizedSlot');
    const block = dataMethod(pass, 'getFinalizedBlockSignatures');
    return Object.freeze({
      providerId,
      getHistoryStatuses(signatures: readonly string[]): Promise<unknown> {
        const response: unknown = Reflect.apply(history, pass, [signatures]);
        return Promise.resolve(response);
      },
      getFinalizedSlot(): Promise<unknown> {
        const response: unknown = Reflect.apply(root, pass, []);
        return Promise.resolve(response);
      },
      getFinalizedBlockSignatures(slot: bigint): Promise<unknown> {
        const response: unknown = Reflect.apply(block, pass, [slot]);
        return Promise.resolve(response);
      },
    });
  } catch {
    throw new FinalityReconcilerError('pass');
  }
}

function snapshotStatuses(
  value: unknown,
  expectedLength: number,
): readonly (FinalityHistoryStatus | null)[] {
  try {
    return snapshotDenseArray(
      value,
      (length) => length === expectedLength,
      snapshotStatus,
    );
  } catch {
    throw new FinalityReconcilerError('history');
  }
}

function snapshotDenseArray<TResult>(
  value: unknown,
  acceptsLength: (length: number) => boolean,
  snapshotItem: (item: unknown) => TResult,
): readonly TResult[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('Invalid dense array.');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    throw new TypeError('Invalid dense array length.');
  }
  const length: unknown = lengthDescriptor.value;
  if (typeof length !== 'number'
    || !Number.isSafeInteger(length)
    || length < 0
    || !acceptsLength(length)) {
    throw new TypeError('Invalid dense array length.');
  }
  const keys = new Set(Reflect.ownKeys(value));
  if (keys.size !== length + 1 || !keys.delete('length')) {
    throw new TypeError('Invalid dense array keys.');
  }
  const snapshots: TResult[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.delete(key)) throw new TypeError('Invalid dense array item.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError('Invalid dense array item.');
    }
    snapshots.push(snapshotItem(descriptor.value));
  }
  if (keys.size !== 0) throw new TypeError('Invalid dense array keys.');
  return Object.freeze(snapshots);
}

function snapshotCandidate(value: unknown): FinalityCandidate {
  if (!objectRecord(value)) throw new TypeError('Invalid finality candidate.');
  const candidate = Object.freeze({
    signature: ownEnumerableDataProperty(value, 'signature'),
    slot: ownEnumerableDataProperty(value, 'slot'),
    confirmationStatus: ownEnumerableDataProperty(value, 'confirmationStatus'),
    missingFinalityPolls: ownEnumerableDataProperty(value, 'missingFinalityPolls'),
    lastMissingFinalityProviderId: ownEnumerableDataProperty(
      value,
      'lastMissingFinalityProviderId',
    ),
    finalityEvidenceVersion: ownEnumerableDataProperty(value, 'finalityEvidenceVersion'),
    processedAtMs: ownEnumerableDataProperty(value, 'processedAtMs'),
  });
  assertValidFinalityCandidate(candidate);
  return candidate;
}

function assertPollTransition(
  before: FinalityCandidate,
  observed: 'processed' | 'confirmed' | null,
  providerId: RpcProviderId,
  expectedVersion: bigint,
  after: FinalityCandidate,
): void {
  if (after.signature !== before.signature
    || after.slot !== before.slot
    || after.processedAtMs !== before.processedAtMs
    || after.finalityEvidenceVersion !== expectedVersion) {
    throw new TypeError('Finality poll identity or evidence version changed.');
  }
  if (observed === null) {
    const expectedMissing = before.lastMissingFinalityProviderId === providerId
      ? before.missingFinalityPolls + 1
      : 1;
    if (!Number.isSafeInteger(expectedMissing)
      || after.confirmationStatus !== before.confirmationStatus
      || after.missingFinalityPolls !== expectedMissing
      || after.lastMissingFinalityProviderId !== providerId) {
      throw new TypeError('Finality missing poll transition is invalid.');
    }
    return;
  }
  const expectedStatus = before.confirmationStatus === 'confirmed'
    || observed === 'confirmed'
    ? 'confirmed'
    : 'processed';
  if (after.confirmationStatus !== expectedStatus
    || after.missingFinalityPolls !== 0
    || after.lastMissingFinalityProviderId !== null) {
    throw new TypeError('Finality observed poll transition is invalid.');
  }
}

function snapshotStatus(value: unknown): FinalityHistoryStatus | null {
  if (value === null) return null;
  if (!objectRecord(value)) throw new TypeError('Invalid finality history status.');
  const slot = ownEnumerableDataProperty(value, 'slot');
  const confirmationStatus = ownEnumerableDataProperty(value, 'confirmationStatus');
  if (typeof slot !== 'bigint' || slot < 0n
    || (confirmationStatus !== 'processed'
      && confirmationStatus !== 'confirmed'
      && confirmationStatus !== 'finalized')) {
    throw new TypeError('Invalid finality history status.');
  }
  return Object.freeze({ slot, confirmationStatus });
}

function snapshotBlockSignatures(value: unknown): readonly string[] {
  const seen = new Set<string>();
  return snapshotDenseArray(
    value,
    (length) => length <= MAX_FINALIZED_BLOCK_SIGNATURES,
    (entry) => {
      if (!canonicalSignature(entry) || seen.has(entry)) {
        throw new TypeError('Invalid block signature.');
      }
      seen.add(entry);
      return entry;
    },
  );
}

function canonicalSignature(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length < MIN_SIGNATURE_LENGTH
    || value.length > MAX_SIGNATURE_LENGTH
    || !BASE58_TEXT.test(value)) return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 64 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

function dataMethod(value: object, key: string): (...args: unknown[]) => unknown {
  const method = dataValue(value, key);
  if (typeof method !== 'function') throw new TypeError('Invalid finality capability.');
  return method as (...args: unknown[]) => unknown;
}

function dataValue(value: object, key: string): unknown {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < MAX_CAPABILITY_PROTOTYPE_DEPTH; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) throw new TypeError('Invalid finality capability.');
      return descriptor.value;
    }
    const prototype: unknown = Object.getPrototypeOf(current);
    current = objectRecord(prototype) ? prototype : null;
  }
  throw new TypeError('Missing finality capability.');
}

function ownEnumerableDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError('Invalid finality data property.');
  }
  return descriptor.value;
}

function objectRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
