import { createHash } from 'node:crypto';
import { assertValidTransactionCursor } from '../../domain/cursor.js';
import { assertValidTimestampMs } from '../../domain/timestamp.js';
import type {
  BondingCurveState,
  LaunchpadTrade,
  ObservedChainTransaction,
  TokenLaunch,
  TokenProgramKind,
} from '../../domain/types.js';
import type { LaunchpadAdapter } from '../../ports/launchpad-adapter.js';
import type { NormalizedTransaction } from '../../solana/rpc/types.js';
import {
  PUMP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
} from './constants.js';
import { PumpDecodingError } from './errors.js';
import { decodePumpTransaction } from './transaction-decoder.js';
import type {
  DecodedPumpCreation,
  DecodedPumpTrade,
  DecodedPumpTransaction,
} from './types.js';

const CONFIRMATION_STATUS = {
  PROCESSED: 'processed',
  CONFIRMED: 'confirmed',
  FINALIZED: 'finalized',
  ORPHANED: 'orphaned',
} as const;

export interface PumpFunObservedTransaction extends ObservedChainTransaction {
  readonly raw: NormalizedTransaction;
}

export interface PumpFunBondingCurveStateReader {
  readonly read: (launch: TokenLaunch) => Promise<BondingCurveState>;
}

export function createPumpFunObservedTransaction(
  raw: NormalizedTransaction,
  observedAtMs: number,
): PumpFunObservedTransaction {
  if (raw.transactionIndex === null) {
    throw new PumpDecodingError(
      'PUMP_TRANSACTION_INDEX_REQUIRED',
      true,
      `Transaction ${raw.signature} sans index canonique.`,
      raw.signature,
    );
  }
  assertValidTimestampMs('observedAtMs', observedAtMs);
  return Object.freeze({
    signature: raw.signature,
    confirmationStatus: CONFIRMATION_STATUS[raw.confirmationStatus],
    blockTimeMs: raw.blockTimeMs,
    observedAtMs,
    cursor: Object.freeze({
      slot: raw.slot,
      transactionIndex: raw.transactionIndex,
    }),
    raw,
  });
}

export class PumpFunLaunchpadAdapter
implements LaunchpadAdapter<PumpFunObservedTransaction> {
  public readonly source = 'pumpfun';
  public readonly programId = PUMP_PROGRAM_ID;
  private readonly decoded = new WeakMap<
    PumpFunObservedTransaction,
    Promise<DecodedPumpTransaction>
  >();

  public constructor(
    private readonly bondingCurveReader: PumpFunBondingCurveStateReader,
    private readonly decode: (
      transaction: NormalizedTransaction,
    ) => DecodedPumpTransaction = decodePumpTransaction,
  ) {}

  public readonly detectLaunches = async (
    transaction: PumpFunObservedTransaction,
  ): Promise<readonly TokenLaunch[]> =>
    (await this.decodeOnce(transaction)).creations.map((creation) =>
      projectTokenLaunch(transaction.raw, creation));

  public readonly decodeTrades = async (
    transaction: PumpFunObservedTransaction,
    trackedMints: ReadonlySet<string>,
  ): Promise<readonly LaunchpadTrade[]> =>
    (await this.decodeOnce(transaction)).trades
      .filter((trade) => trackedMints.has(trade.event.mint))
      .map((trade) => projectLaunchpadTrade(transaction.raw, trade));

  public readonly readBondingCurveState = async (
    launch: TokenLaunch,
  ): Promise<BondingCurveState> => this.bondingCurveReader.read(launch);

  private decodeOnce(
    transaction: PumpFunObservedTransaction,
  ): Promise<DecodedPumpTransaction> {
    validateObservedTransaction(transaction);
    const cached = this.decoded.get(transaction);
    if (cached !== undefined) return cached;
    const decoding = Promise.resolve().then(() => this.decode(transaction.raw));
    this.decoded.set(transaction, decoding);
    return decoding;
  }
}

function projectTokenLaunch(
  transaction: NormalizedTransaction,
  creation: DecodedPumpCreation,
): TokenLaunch {
  const { event, action } = creation;
  return Object.freeze({
    mint: event.mint,
    creator: event.creator,
    tokenProgram: mapTokenProgram(event.tokenProgram),
    quoteAssets: Object.freeze([creation.quoteAsset]),
    launchpad: 'pumpfun',
    createdAt: Object.freeze({
      slot: transaction.slot,
      transactionIndex: requiredTransactionIndex(transaction),
      instructionIndex: action.instruction.instructionIndex,
      innerInstructionIndex: action.instruction.innerInstructionIndex,
    }),
    parameters: Object.freeze({
      instruction: action.name,
      name: event.name,
      symbol: event.symbol,
      uri: event.uri,
      bondingCurve: event.bondingCurve,
      user: event.user,
      blockchainTimestampSeconds: event.timestamp,
      virtualTokenReservesRaw: event.virtualTokenReserves,
      virtualQuoteReservesRaw: event.virtualQuoteReserves,
      realTokenReservesRaw: event.realTokenReserves,
      tokenTotalSupplyRaw: event.tokenTotalSupply,
      mayhem: event.isMayhemMode,
      cashback: event.isCashbackEnabled,
      rawQuoteMint: event.quoteMint,
      trailingEventDataHex: creation.eventCpi.trailingDataHex,
    }),
  });
}

function projectLaunchpadTrade(
  transaction: NormalizedTransaction,
  trade: DecodedPumpTrade,
): LaunchpadTrade {
  return Object.freeze({
    id: deterministicTradeId(transaction, trade),
    launchMint: trade.event.mint,
    kind: trade.action.family,
    trader: trade.event.user,
    baseAmountRaw: trade.event.tokenAmount,
    quoteAmountRaw: trade.event.quoteAmount,
    quoteAsset: trade.quoteAsset,
    cursor: Object.freeze({
      slot: transaction.slot,
      transactionIndex: requiredTransactionIndex(transaction),
      instructionIndex: trade.action.instruction.instructionIndex,
      innerInstructionIndex: trade.action.instruction.innerInstructionIndex,
    }),
  });
}

function validateObservedTransaction(
  transaction: PumpFunObservedTransaction,
): void {
  const { raw } = transaction;
  if (
    transaction.signature !== raw.signature
    || transaction.cursor.slot !== raw.slot
    || transaction.cursor.transactionIndex !== raw.transactionIndex
    || transaction.confirmationStatus !== CONFIRMATION_STATUS[raw.confirmationStatus]
  ) {
    throw new PumpDecodingError(
      'PUMP_SCHEMA_UNSUPPORTED',
      false,
      'Enveloppe Pump.fun incohérente avec la transaction normalisée.',
      raw.signature,
    );
  }
  assertValidTimestampMs('observedAtMs', transaction.observedAtMs);
  assertValidTransactionCursor(transaction.cursor);
}

function mapTokenProgram(program: string): TokenProgramKind {
  if (program === SPL_TOKEN_PROGRAM_ID) return 'SPL_TOKEN';
  if (program === TOKEN_2022_PROGRAM_ADDRESS) return 'TOKEN_2022';
  throw new PumpDecodingError(
    'PUMP_TOKEN_PROGRAM_UNSUPPORTED',
    false,
    `Programme token Pump non pris en charge: ${program}.`,
  );
}

function deterministicTradeId(
  transaction: NormalizedTransaction,
  trade: DecodedPumpTrade,
): string {
  return createHash('sha256').update(JSON.stringify([
    transaction.signature,
    transaction.slot.toString(),
    requiredTransactionIndex(transaction),
    trade.action.instruction.instructionIndex,
    trade.action.instruction.innerInstructionIndex,
    trade.action.family,
    trade.event.mint,
  ])).digest('hex');
}

function requiredTransactionIndex(transaction: NormalizedTransaction): number {
  if (transaction.transactionIndex === null) {
    throw new PumpDecodingError(
      'PUMP_TRANSACTION_INDEX_REQUIRED',
      true,
      `Transaction ${transaction.signature} sans index canonique.`,
      transaction.signature,
    );
  }
  return transaction.transactionIndex;
}
