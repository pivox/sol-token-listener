import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { MergedCatchUpDiscovery } from './catch-up-discovery.js';
import {
  createCatchUpClassification,
  type CatchUpClassification,
  type CatchUpClassificationDisposition,
  type CatchUpClassificationReasonCode,
} from '../domain/catch-up-classification.js';
import { trustedObservedPipelineOrigin } from '../domain/observed-pipeline-failure.js';
import {
  isCanonicalSolanaProgramId,
  type TransactionNotificationIngestionHint,
} from '../domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PUMP_DECODING_ERROR_CODES } from '../launchpads/pumpfun/errors.js';
import { decodePumpTransaction } from '../launchpads/pumpfun/transaction-decoder.js';
import type {
  DecodedPumpTransaction,
  PumpInstructionFamily,
} from '../launchpads/pumpfun/types.js';
import type { CatchUpClassificationRepository } from '../ports/catch-up-classification-repository.js';
import {
  trustedTransactionLocatorFailure,
  type TransactionLocationTarget,
} from '../solana/rpc/transaction-locator.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';

const MAX_DISCOVERIES = 100_000;
const MAX_PROGRAM_IDS = 16;
const MAX_CLASSIFICATION_MINTS = 16;
const MAX_SAFE_MILLISECONDS = 8_640_000_000_000_000;
const DISCOVERY_KEYS = Object.freeze([
  'signature', 'slot', 'confirmationStatus', 'blockTimeMs', 'programIds',
] as const);
const trustedPumpCodes = new Set<string>(PUMP_DECODING_ERROR_CODES);

type EffectiveCommitment = TransactionLocationTarget['confirmationStatus'];
type ClassifierErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CLOCK'
  | 'LOCATOR_RETRYABLE'
  | 'LOCATOR_UNTRUSTED'
  | 'LOCATOR_UNSUPPORTED_FAILURE'
  | 'TRANSACTION_IDENTITY_MISMATCH'
  | 'DECODER_UNTRUSTED';

export interface PumpFunCatchUpTransactionLocator {
  locate(target: TransactionLocationTarget): Promise<NormalizedTransaction>;
}

export class PumpFunCatchUpBlockClassifierError extends Error {
  public constructor(public readonly code: ClassifierErrorCode) {
    super('Pump.fun catch-up block classification failed.');
    this.name = 'PumpFunCatchUpBlockClassifierError';
  }
}

interface SlotDiscovery {
  readonly discovery: MergedCatchUpDiscovery;
  readonly commitment: EffectiveCommitment;
}

interface SlotGroup {
  readonly slot: bigint;
  readonly rows: readonly SlotDiscovery[];
}

type HydrationOutcome =
  | Readonly<{
    kind: 'TRANSACTION';
    discovery: MergedCatchUpDiscovery;
    transaction: NormalizedTransaction;
  }>
  | Readonly<{
    kind: 'QUARANTINE';
    discovery: MergedCatchUpDiscovery;
    reasonCode: Extract<
      CatchUpClassificationReasonCode,
      'PUMP_SCHEMA_UNSUPPORTED' | 'PROVIDER_SIGNATURE_MISSING'
    >;
    marker: string;
  }>;

interface SemanticAction {
  readonly family: PumpInstructionFamily;
  readonly mint: string;
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null;
}

interface ClassificationDecision {
  readonly disposition: CatchUpClassificationDisposition;
  readonly reasonCode: CatchUpClassificationReasonCode;
  readonly ingestionHint: TransactionNotificationIngestionHint | null;
  readonly ingestionHintMint: string | null;
  readonly mints: readonly string[];
  readonly marker: string;
  readonly actions: readonly SemanticAction[];
}

/** Inactive B2b service. No scanner or production factory composes it yet. */
export class PumpFunCatchUpBlockClassifier {
  public constructor(
    private readonly locator: PumpFunCatchUpTransactionLocator,
    private readonly repository: CatchUpClassificationRepository,
    private readonly now: () => number = Date.now,
  ) {}

  public async classify(discoveries: readonly MergedCatchUpDiscovery[]): Promise<void> {
    const slots = snapshotAndGroupDiscoveries(discoveries);
    if (slots.length === 0) return;
    const classifiedAtMs = this.now();
    assertSafeMilliseconds(classifiedAtMs, 'INVALID_CLOCK');
    for (const slot of slots) {
      const classifications = await this.classifySlot(slot, classifiedAtMs);
      for (const classification of classifications) {
        await this.repository.recordCatchUpClassification(classification);
      }
    }
  }

  private async classifySlot(
    slot: SlotGroup,
    classifiedAtMs: number,
  ): Promise<readonly CatchUpClassification[]> {
    const outcomes: HydrationOutcome[] = [];
    for (const row of slot.rows) outcomes.push(await this.hydrate(row));
    return Object.freeze(outcomes.map((outcome) =>
      classificationForOutcome(outcome, classifiedAtMs)));
  }

  private async hydrate(row: SlotDiscovery): Promise<HydrationOutcome> {
    let transaction: NormalizedTransaction;
    try {
      transaction = await this.locator.locate(Object.freeze({
        signature: row.discovery.signature,
        slot: row.discovery.slot,
        confirmationStatus: row.commitment,
      }));
    } catch (error) {
      const trusted = trustedTransactionLocatorFailure(error);
      if (trusted === null) throw failure('LOCATOR_UNTRUSTED');
      if (trusted.retryable) throw failure('LOCATOR_RETRYABLE');
      if (trusted.code === 'TRANSACTION_INDEX_NOT_FOUND') {
        return Object.freeze({
          kind: 'QUARANTINE',
          discovery: row.discovery,
          reasonCode: 'PROVIDER_SIGNATURE_MISSING',
          marker: `LOCATOR:${trusted.code}`,
        });
      }
      if (trusted.code === 'NORMALIZATION_FAILED') {
        return Object.freeze({
          kind: 'QUARANTINE',
          discovery: row.discovery,
          reasonCode: 'PUMP_SCHEMA_UNSUPPORTED',
          marker: `LOCATOR:${trusted.code}`,
        });
      }
      throw failure('LOCATOR_UNSUPPORTED_FAILURE');
    }
    let signature: unknown;
    let observedSlot: unknown;
    try {
      signature = transaction.signature;
      observedSlot = transaction.slot;
    } catch {
      throw failure('TRANSACTION_IDENTITY_MISMATCH');
    }
    if (signature !== row.discovery.signature || observedSlot !== row.discovery.slot) {
      throw failure('TRANSACTION_IDENTITY_MISMATCH');
    }
    return Object.freeze({ kind: 'TRANSACTION', discovery: row.discovery, transaction });
  }
}

export function createPumpFunCatchUpClassificationFromDecoded(
  discovery: MergedCatchUpDiscovery,
  decoded: DecodedPumpTransaction,
  classifiedAtMs: number,
): CatchUpClassification {
  const snapshot = snapshotDiscovery(discovery);
  assertSafeMilliseconds(classifiedAtMs, 'INVALID_CLOCK');
  if (decoded.transaction.signature !== snapshot.signature
    || decoded.transaction.slot !== snapshot.slot) {
    throw failure('TRANSACTION_IDENTITY_MISMATCH');
  }
  return classificationFromDecision(
    snapshot,
    decisionFromDecoded(decoded),
    classifiedAtMs,
  );
}

function classificationForOutcome(
  outcome: HydrationOutcome,
  classifiedAtMs: number,
): CatchUpClassification {
  if (outcome.kind === 'QUARANTINE') {
    return classificationFromDecision(outcome.discovery, Object.freeze({
      disposition: 'QUARANTINED',
      reasonCode: outcome.reasonCode,
      ingestionHint: null,
      ingestionHintMint: null,
      mints: Object.freeze([]),
      marker: outcome.marker,
      actions: Object.freeze([]),
    }), classifiedAtMs);
  }
  if (outcome.transaction.error !== null) {
    return classificationFromDecision(outcome.discovery, Object.freeze({
      disposition: 'IGNORED',
      reasonCode: 'SOLANA_TRANSACTION_FAILED',
      ingestionHint: null,
      ingestionHintMint: null,
      mints: Object.freeze([]),
      marker: 'SOLANA_TRANSACTION_FAILED',
      actions: Object.freeze([]),
    }), classifiedAtMs);
  }
  let decoded: DecodedPumpTransaction;
  try {
    decoded = decodePumpTransaction(outcome.transaction);
  } catch (error) {
    const origin = trustedObservedPipelineOrigin(error);
    if (origin === null || !trustedPumpCodes.has(origin)) {
      throw failure('DECODER_UNTRUSTED');
    }
    return classificationFromDecision(outcome.discovery, Object.freeze({
      disposition: 'QUARANTINED',
      reasonCode: 'PUMP_SCHEMA_UNSUPPORTED',
      ingestionHint: null,
      ingestionHintMint: null,
      mints: Object.freeze([]),
      marker: `DECODER:${origin}`,
      actions: Object.freeze([]),
    }), classifiedAtMs);
  }
  return createPumpFunCatchUpClassificationFromDecoded(
    outcome.discovery,
    decoded,
    classifiedAtMs,
  );
}

function decisionFromDecoded(decoded: DecodedPumpTransaction): ClassificationDecision {
  if (decoded.transaction.error !== null) {
    return Object.freeze({
      disposition: 'IGNORED', reasonCode: 'SOLANA_TRANSACTION_FAILED',
      ingestionHint: null, ingestionHintMint: null, mints: Object.freeze([]),
      marker: 'SOLANA_TRANSACTION_FAILED', actions: Object.freeze([]),
    });
  }
  const actions = semanticActions(decoded);
  const evidenceMints = canonicalMints([
    ...decoded.creations.map(({ event }) => event.mint),
    ...decoded.trades.map(({ event }) => event.mint),
  ]);
  if (evidenceMints.length > MAX_CLASSIFICATION_MINTS) {
    return Object.freeze({
      disposition: 'QUARANTINED', reasonCode: 'PUMP_SCHEMA_UNSUPPORTED',
      ingestionHint: null, ingestionHintMint: null, mints: Object.freeze([]),
      marker: `MINT_LIMIT_EXCEEDED:${evidenceMints.length}`, actions,
    });
  }
  if (decoded.creations.length > 0) {
    return Object.freeze({
      disposition: 'ACTIONABLE', reasonCode: 'PUMP_ACTION_SUPPORTED',
      ingestionHint: 'PUMPFUN_CREATE', ingestionHintMint: null,
      mints: evidenceMints, marker: 'PUMP_ACTION_SUPPORTED', actions,
    });
  }
  const tradeMints = canonicalMints(decoded.trades.map(({ event }) => event.mint));
  if (tradeMints.length === 1) {
    const mint = tradeMints[0];
    if (mint === undefined) throw failure('DECODER_UNTRUSTED');
    return Object.freeze({
      disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: mint,
      mints: tradeMints, marker: 'PUMP_TRADE_UNTRACKED', actions,
    });
  }
  if (tradeMints.length > 1) {
    return Object.freeze({
      disposition: 'QUARANTINED', reasonCode: 'PUMP_SCHEMA_UNSUPPORTED',
      ingestionHint: null, ingestionHintMint: null,
      mints: tradeMints, marker: `TRADE_MULTI_MINT:${tradeMints.length}`, actions,
    });
  }
  return Object.freeze({
    disposition: 'IGNORED', reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
    ingestionHint: null, ingestionHintMint: null, mints: Object.freeze([]),
    marker: 'NO_SUPPORTED_PUMP_ACTION', actions,
  });
}

function classificationFromDecision(
  discovery: MergedCatchUpDiscovery,
  decision: ClassificationDecision,
  classifiedAtMs: number,
): CatchUpClassification {
  return createCatchUpClassification(Object.freeze({
    signature: discovery.signature,
    slot: discovery.slot,
    programIds: discovery.programIds,
    confirmationStatus: discovery.confirmationStatus,
    observedAtMs: classifiedAtMs,
    ingestionHint: decision.ingestionHint,
    ingestionHintMint: decision.ingestionHintMint,
    classificationVersion: 1,
    disposition: decision.disposition,
    reasonCode: decision.reasonCode,
    mints: decision.mints,
    evidenceFingerprint: evidenceFingerprint(discovery, decision),
    classifiedAtMs,
  }));
}

function evidenceFingerprint(
  discovery: MergedCatchUpDiscovery,
  decision: ClassificationDecision,
): string {
  const segments = [
    'pumpfun-catch-up-classification-v1',
    `SIGNATURE:${discovery.signature}`,
    `SLOT:${discovery.slot.toString()}`,
    `DISPOSITION:${decision.disposition}`,
    `REASON:${decision.reasonCode}`,
    `HINT:${decision.ingestionHint ?? 'NONE'}`,
    `HINT_MINT:${decision.ingestionHintMint ?? 'NONE'}`,
    `MINT_COUNT:${decision.mints.length}`,
    ...decision.mints.map((mint) => `MINT:${mint}`),
    `ACTION_COUNT:${decision.actions.length}`,
    ...decision.actions.map((action) =>
      `ACTION:${action.instructionIndex}:${action.innerInstructionIndex ?? 'NONE'}:${action.family}:${action.mint}`),
    `OUTCOME:${decision.marker}`,
  ];
  const digest = createHash('sha256');
  for (const segment of segments) {
    const bytes = Buffer.from(segment, 'utf8');
    digest.update(String(bytes.length));
    digest.update(':');
    digest.update(bytes);
  }
  return digest.digest('hex');
}

function semanticActions(decoded: DecodedPumpTransaction): readonly SemanticAction[] {
  const actions: SemanticAction[] = [];
  for (const creation of decoded.creations) {
    actions.push(actionEvidence('CREATE', creation.event.mint, creation.action.instruction));
  }
  for (const trade of decoded.trades) {
    actions.push(actionEvidence(
      trade.event.isBuy ? 'BUY' : 'SELL',
      trade.event.mint,
      trade.action.instruction,
    ));
  }
  for (const migration of decoded.migrations) {
    actions.push(actionEvidence('MIGRATE', migration.mint, migration.action.instruction));
  }
  actions.sort(actionOrder);
  return Object.freeze(actions);
}

function actionEvidence(
  family: PumpInstructionFamily,
  mint: string,
  instruction: Readonly<{
    readonly instructionIndex: number;
    readonly innerInstructionIndex: number | null;
  }>,
): SemanticAction {
  return Object.freeze({
    family,
    mint,
    instructionIndex: instruction.instructionIndex,
    innerInstructionIndex: instruction.innerInstructionIndex,
  });
}

function actionOrder(left: SemanticAction, right: SemanticAction): number {
  if (left.instructionIndex !== right.instructionIndex) {
    return left.instructionIndex - right.instructionIndex;
  }
  const leftInner = left.innerInstructionIndex ?? -1;
  const rightInner = right.innerInstructionIndex ?? -1;
  if (leftInner !== rightInner) return leftInner - rightInner;
  const family = lexicalOrder(left.family, right.family);
  return family === 0 ? lexicalOrder(left.mint, right.mint) : family;
}

function canonicalMints(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(lexicalOrder));
}

function snapshotAndGroupDiscoveries(value: unknown): readonly SlotGroup[] {
  const discoveries = snapshotDiscoveryArray(value);
  const signatures = new Set<string>();
  const bySlot = new Map<bigint, SlotDiscovery[]>();
  for (const discovery of discoveries) {
    if (signatures.has(discovery.signature)) throw failure('INVALID_INPUT');
    signatures.add(discovery.signature);
    const row = Object.freeze({
      discovery,
      commitment: effectiveCommitment(discovery.confirmationStatus),
    });
    const rows = bySlot.get(discovery.slot);
    if (rows === undefined) bySlot.set(discovery.slot, [row]);
    else rows.push(row);
  }
  const slots = [...bySlot.entries()].map(([slot, rows]) => Object.freeze({
    slot,
    rows: Object.freeze(rows.sort(slotDiscoveryOrder)),
  }));
  slots.sort((left, right) => left.slot === right.slot ? 0 : left.slot < right.slot ? -1 : 1);
  return Object.freeze(slots);
}

function snapshotDiscoveryArray(value: unknown): readonly MergedCatchUpDiscovery[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw failure('INVALID_INPUT');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || (lengthDescriptor.value as number) < 0
    || (lengthDescriptor.value as number) > MAX_DISCOVERIES) {
    throw failure('INVALID_INPUT');
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) throw failure('INVALID_INPUT');
  const result: MergedCatchUpDiscovery[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw failure('INVALID_INPUT');
    }
    result.push(snapshotDiscovery(descriptor.value));
  }
  return Object.freeze(result);
}

function snapshotDiscovery(value: unknown): MergedCatchUpDiscovery {
  const record = exactDataRecord(value, DISCOVERY_KEYS);
  const signature = record.signature;
  const slot = record.slot;
  const confirmationStatus = record.confirmationStatus;
  const blockTimeMs = record.blockTimeMs;
  if (typeof signature !== 'string' || signature.length === 0
    || signature !== signature.trim() || Buffer.byteLength(signature, 'utf8') > 128
    || typeof slot !== 'bigint' || slot < 0n || slot > BigInt(Number.MAX_SAFE_INTEGER)
    || (confirmationStatus !== 'processed'
      && confirmationStatus !== 'confirmed'
      && confirmationStatus !== 'finalized')
    || (blockTimeMs !== null && (!Number.isSafeInteger(blockTimeMs)
      || (blockTimeMs as number) < 0 || Object.is(blockTimeMs, -0)))) {
    throw failure('INVALID_INPUT');
  }
  const programIds = snapshotProgramIds(record.programIds);
  if (!programIds.includes(PUMP_PROGRAM_ID)) throw failure('INVALID_INPUT');
  return Object.freeze({
    signature,
    slot,
    confirmationStatus,
    blockTimeMs: blockTimeMs as number | null,
    programIds,
  });
}

function snapshotProgramIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw failure('INVALID_INPUT');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || (lengthDescriptor.value as number) < 1
    || (lengthDescriptor.value as number) > MAX_PROGRAM_IDS) {
    throw failure('INVALID_INPUT');
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) throw failure('INVALID_INPUT');
  const result: string[] = [];
  let previous: string | null = null;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const programId: unknown = descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
      ? descriptor.value : null;
    if (typeof programId !== 'string' || !isCanonicalSolanaProgramId(programId)
      || (previous !== null && programId <= previous)) throw failure('INVALID_INPUT');
    result.push(programId);
    previous = programId;
  }
  return Object.freeze(result);
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw failure('INVALID_INPUT');
  }
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw failure('INVALID_INPUT');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || keys.some((key) => !ownKeys.includes(key))) {
    throw failure('INVALID_INPUT');
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw failure('INVALID_INPUT');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function effectiveCommitment(
  status: MergedCatchUpDiscovery['confirmationStatus'],
): EffectiveCommitment {
  return status === 'finalized' ? 'FINALIZED' : 'CONFIRMED';
}

function slotDiscoveryOrder(left: SlotDiscovery, right: SlotDiscovery): number {
  if (left.commitment !== right.commitment) return left.commitment === 'CONFIRMED' ? -1 : 1;
  return lexicalOrder(left.discovery.signature, right.discovery.signature);
}

function lexicalOrder(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function assertSafeMilliseconds(value: unknown, code: ClassifierErrorCode): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    || value > MAX_SAFE_MILLISECONDS || Object.is(value, -0)) throw failure(code);
}

function failure(code: ClassifierErrorCode): PumpFunCatchUpBlockClassifierError {
  return new PumpFunCatchUpBlockClassifierError(code);
}
