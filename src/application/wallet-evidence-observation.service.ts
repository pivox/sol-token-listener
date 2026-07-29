import {
  assertValidWalletFundingExtractionResult,
  type WalletFundingBuy,
  type WalletFundingExtractionResult,
} from '../domain/wallet-funding.js';
import type {
  BondingCurveTradeObservedEventV1,
} from '../domain/launchpad-events.js';
import {
  assertValidChainCursor,
  compareCursors,
} from '../domain/cursor.js';
import {
  assertValidNullableTimestampMs,
  assertValidTimestampMs,
} from '../domain/timestamp.js';
import type {
  ChainConfirmationStatus,
} from '../domain/types.js';
import type {
  WalletFundingEvidenceExtractor,
} from '../ports/wallet-funding-evidence-extractor.js';
import type {
  WalletEvidenceBatch,
  WalletEvidenceRepository,
} from '../ports/wallet-evidence-repository.js';
import type {
  SolanaObservedTransaction,
} from '../solana/rpc/observed-transaction.js';
import type {
  NormalizedTransaction,
} from '../solana/rpc/types.js';

const EMPTY_RESULT: WalletFundingExtractionResult = Object.freeze({
  assessments: Object.freeze([]),
  evidence: Object.freeze([]),
});

const CONFIRMATION_STATUS: Readonly<
  Record<NormalizedTransaction['confirmationStatus'], ChainConfirmationStatus>
> = Object.freeze({
  PROCESSED: 'processed',
  CONFIRMED: 'confirmed',
  FINALIZED: 'finalized',
  ORPHANED: 'orphaned',
});

export type WalletEvidenceObservationStage =
  | 'validate'
  | 'extract'
  | 'record';

export class WalletEvidenceObservationError extends Error {
  public constructor(
    public readonly stage: WalletEvidenceObservationStage,
    options: ErrorOptions,
  ) {
    super(`Wallet evidence observation failed during ${stage}.`, options);
    this.name = 'WalletEvidenceObservationError';
  }
}

export class WalletEvidenceObservationService {
  public constructor(
    private readonly extractor:
      WalletFundingEvidenceExtractor<NormalizedTransaction>,
    private readonly repository: WalletEvidenceRepository,
  ) {}

  public async observe(
    transaction: SolanaObservedTransaction,
    events: readonly BondingCurveTradeObservedEventV1[],
  ): Promise<WalletFundingExtractionResult> {
    let buys: readonly WalletFundingBuy[];
    try {
      buys = validateAndSnapshot(transaction, events);
    } catch (cause) {
      throw new WalletEvidenceObservationError('validate', { cause });
    }
    if (buys.length === 0) return EMPTY_RESULT;

    let result: WalletFundingExtractionResult;
    try {
      result = this.extractor.extract(transaction.raw, buys);
      assertValidWalletFundingExtractionResult(result);
    } catch (cause) {
      throw new WalletEvidenceObservationError('extract', { cause });
    }

    const batch: WalletEvidenceBatch = Object.freeze({
      signature: transaction.signature,
      confirmationStatus: transaction.confirmationStatus,
      assessments: result.assessments,
      evidence: result.evidence,
    });
    try {
      await this.repository.record(batch);
    } catch (cause) {
      throw new WalletEvidenceObservationError('record', { cause });
    }
    return result;
  }
}

function validateAndSnapshot(
  transaction: SolanaObservedTransaction,
  events: readonly BondingCurveTradeObservedEventV1[],
): readonly WalletFundingBuy[] {
  validateTransaction(transaction);
  if (!Object.isFrozen(events)) {
    throw new TypeError('Wallet evidence events must be frozen.');
  }
  const eventIds = new Set<string>();
  const tradeIds = new Set<string>();
  const cursors = new Set<string>();
  const buys: WalletFundingBuy[] = [];
  for (const event of events) {
    validateEvent(transaction, event);
    const cursorKey = [
      event.cursor.slot.toString(),
      event.cursor.transactionIndex,
      event.cursor.instructionIndex,
      event.cursor.innerInstructionIndex ?? 'outer',
    ].join(':');
    if (
      eventIds.has(event.id)
      || tradeIds.has(event.payload.trade.id)
      || cursors.has(cursorKey)
    ) {
      throw new TypeError('Wallet evidence events contain a duplicate identity.');
    }
    eventIds.add(event.id);
    tradeIds.add(event.payload.trade.id);
    cursors.add(cursorKey);
    const { trade } = event.payload;
    if (trade.kind !== 'BUY' || trade.trader === null) continue;
    buys.push(snapshotBuy(event, trade.trader));
  }
  return Object.freeze(buys.sort((left, right) => {
    const cursorOrder = compareCursors(left.cursor, right.cursor);
    return cursorOrder === 0
      ? left.tradeId.localeCompare(right.tradeId)
      : cursorOrder;
  }));
}

function validateTransaction(transaction: SolanaObservedTransaction): void {
  const { raw } = transaction;
  if (
    raw.transactionIndex === null
    || raw.error !== null
    || transaction.signature !== raw.signature
    || transaction.cursor.slot !== raw.slot
    || transaction.cursor.transactionIndex !== raw.transactionIndex
    || transaction.confirmationStatus !== CONFIRMATION_STATUS[raw.confirmationStatus]
    || transaction.blockTimeMs !== raw.blockTimeMs
  ) {
    throw new TypeError('Wallet evidence transaction envelope is inconsistent.');
  }
  assertValidTimestampMs('observedAtMs', transaction.observedAtMs);
  assertValidNullableTimestampMs('blockchainTimeMs', transaction.blockTimeMs);
}

function validateEvent(
  transaction: SolanaObservedTransaction,
  event: BondingCurveTradeObservedEventV1,
): void {
  const eventType: unknown = event.type;
  if (
    !Object.isFrozen(event)
    || !Object.isFrozen(event.payload)
    || !Object.isFrozen(event.payload.trade)
    || !Object.isFrozen(event.cursor)
    || eventType !== 'BondingCurveTradeObserved'
    || event.signature !== transaction.signature
    || event.cursor.slot !== transaction.cursor.slot
    || event.cursor.transactionIndex !== transaction.cursor.transactionIndex
    || event.confirmationStatus !== transaction.confirmationStatus
    || event.blockchainTimeMs !== transaction.blockTimeMs
    || event.observedAtMs !== transaction.observedAtMs
  ) {
    throw new TypeError('Wallet evidence event does not match its transaction.');
  }
  assertValidChainCursor(event.cursor);
  if (
    event.payload.trade.cursor.slot !== event.cursor.slot
    || event.payload.trade.cursor.transactionIndex
      !== event.cursor.transactionIndex
    || event.payload.trade.cursor.instructionIndex
      !== event.cursor.instructionIndex
    || event.payload.trade.cursor.innerInstructionIndex
      !== event.cursor.innerInstructionIndex
  ) {
    throw new TypeError('Wallet evidence trade cursor is inconsistent.');
  }
}

function snapshotBuy(
  event: BondingCurveTradeObservedEventV1,
  buyer: string,
): WalletFundingBuy {
  const { trade } = event.payload;
  return Object.freeze({
    eventId: event.id,
    tradeId: trade.id,
    mint: event.mint,
    buyer,
    source: event.source,
    program: event.program,
    quoteAsset: Object.freeze({
      mint: trade.quoteAsset.mint,
      decimals: trade.quoteAsset.decimals,
      tokenProgram: trade.quoteAsset.tokenProgram,
    }),
    signature: event.signature,
    cursor: Object.freeze({
      slot: event.cursor.slot,
      transactionIndex: event.cursor.transactionIndex,
      instructionIndex: event.cursor.instructionIndex,
      innerInstructionIndex: event.cursor.innerInstructionIndex,
    }),
    confirmationStatus: event.confirmationStatus,
    blockchainTimeMs: event.blockchainTimeMs,
    observedAtMs: event.observedAtMs,
  });
}
