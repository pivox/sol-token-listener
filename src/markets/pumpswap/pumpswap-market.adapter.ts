import { createDeterministicChainEventId } from '../../domain/events.js';
import type {
  CanonicalMarketPool,
  MarketQuote,
  MarketQuoteRequest,
  MarketReserves,
  MarketTrade,
} from '../../domain/market.js';
import { assertValidTransactionCursor } from '../../domain/cursor.js';
import { assertValidTimestampMs } from '../../domain/timestamp.js';
import type { MarketAdapter } from '../../ports/market-adapter.js';
import type { PumpSwapQuotePort } from '../../ports/pumpswap-quote-provider.js';
import type { SolanaObservedTransaction } from '../../solana/rpc/observed-transaction.js';
import type { NormalizedTransaction } from '../../solana/rpc/types.js';
import { PUMPSWAP_PROGRAM_ID } from './constants.js';
import { PumpSwapDecodingError } from './errors.js';
import { decodePumpSwapTransaction } from './transaction-decoder.js';
import type {
  DecodedPumpSwapPoolCreation,
  DecodedPumpSwapTrade,
  DecodedPumpSwapTransaction,
} from './types.js';

export interface PumpSwapPoolValidator {
  validate(
    creation: DecodedPumpSwapPoolCreation,
    transaction: SolanaObservedTransaction,
  ): Promise<CanonicalMarketPool | null>;
}

export interface PumpSwapReservePort {
  read(pool: CanonicalMarketPool): Promise<MarketReserves>;
}

export class PumpSwapMarketAdapter
implements MarketAdapter<SolanaObservedTransaction> {
  public readonly source = 'pumpswap';
  public readonly programId = PUMPSWAP_PROGRAM_ID;
  private readonly decoded = new WeakMap<
    SolanaObservedTransaction,
    Promise<DecodedPumpSwapTransaction>
  >();

  public constructor(
    private readonly transactionDecoder: (
      transaction: NormalizedTransaction,
    ) => DecodedPumpSwapTransaction = decodePumpSwapTransaction,
    private readonly poolValidator: PumpSwapPoolValidator,
    private readonly reserveReader: PumpSwapReservePort,
    private readonly quoteProvider: PumpSwapQuotePort,
    private readonly reportIssue: (issue: PumpSwapDecodingError) => void,
  ) {}

  public decodeEvidence(
    transaction: SolanaObservedTransaction,
  ): Promise<DecodedPumpSwapTransaction> {
    validateEnvelope(transaction);
    const cached = this.decoded.get(transaction);
    if (cached !== undefined) return cached;
    const decoding = Promise.resolve()
      .then(() => this.transactionDecoder(transaction.raw))
      .then((evidence) => {
        for (const issue of evidence.issues) this.reportIssue(issue);
        return evidence;
      });
    this.decoded.set(transaction, decoding);
    return decoding;
  }

  public readonly detectPools = async (
    transaction: SolanaObservedTransaction,
  ): Promise<readonly CanonicalMarketPool[]> => {
    const evidence = await this.decodeEvidence(transaction);
    const pools = await Promise.all(evidence.poolCreations.map((creation) =>
      this.poolValidator.validate(creation, transaction)));
    return Object.freeze(
      pools.filter((pool): pool is CanonicalMarketPool => pool !== null),
    );
  };

  public readonly decodeTrades = async (
    transaction: SolanaObservedTransaction,
    trackedPools: ReadonlyMap<string, CanonicalMarketPool>,
  ): Promise<readonly MarketTrade[]> =>
    Object.freeze((await this.decodeEvidence(transaction)).trades
      .filter((trade) => compatible(trade, trackedPools.get(trade.pool)))
      .map((trade) =>
        projectTrade(transaction, trade, requiredPool(trackedPools, trade.pool))));

  public readonly readReserves = (
    pool: CanonicalMarketPool,
  ): Promise<MarketReserves> => this.reserveReader.read(pool);

  public readonly quote = async (
    request: MarketQuoteRequest,
  ): Promise<MarketQuote> => this.quoteProvider.quote({
    ...request,
    reserves: await this.readReserves(request.pool),
  });
}

function projectTrade(
  transaction: SolanaObservedTransaction,
  trade: DecodedPumpSwapTrade,
  pool: CanonicalMarketPool,
): MarketTrade {
  const cursor = Object.freeze({
    slot: transaction.cursor.slot,
    transactionIndex: transaction.cursor.transactionIndex,
    instructionIndex: trade.action.instruction.instructionIndex,
    innerInstructionIndex: trade.action.instruction.innerInstructionIndex,
  });
  return Object.freeze({
    id: createDeterministicChainEventId({
      type: 'PumpSwapTradeObserved',
      mint: pool.baseMint,
      source: 'pumpswap',
      program: PUMPSWAP_PROGRAM_ID,
      signature: transaction.signature,
      cursor,
    }),
    pool: pool.address,
    mint: pool.baseMint,
    quoteAsset: pool.quoteAsset,
    kind: trade.kind,
    trader: trade.trader,
    baseAmountRaw: trade.baseAmountRaw,
    quoteAmountRaw: trade.quoteAmountRaw,
    source: 'pumpswap',
    program: PUMPSWAP_PROGRAM_ID,
    signature: transaction.signature,
    cursor,
    confirmationStatus: transaction.confirmationStatus,
    blockchainTimeMs: transaction.blockTimeMs,
    observedAtMs: transaction.observedAtMs,
  });
}

function compatible(
  trade: DecodedPumpSwapTrade,
  pool: CanonicalMarketPool | undefined,
): boolean {
  return trade.baseMint === pool?.baseMint
    && trade.quoteMint === pool.quoteAsset.mint;
}

function requiredPool(
  pools: ReadonlyMap<string, CanonicalMarketPool>,
  address: string,
): CanonicalMarketPool {
  const pool = pools.get(address);
  if (pool === undefined) {
    throw new PumpSwapDecodingError(
      'PUMPSWAP_EVENT_MISMATCH',
      `Pool suivi absent pendant la projection: ${address}.`,
    );
  }
  return pool;
}

function validateEnvelope(transaction: SolanaObservedTransaction): void {
  const { raw } = transaction;
  const status = raw.confirmationStatus.toLowerCase();
  if (
    transaction.signature !== raw.signature
    || transaction.cursor.slot !== raw.slot
    || transaction.cursor.transactionIndex !== raw.transactionIndex
    || transaction.confirmationStatus !== status
  ) {
    throw new PumpSwapDecodingError(
      'PUMPSWAP_SCHEMA_UNSUPPORTED',
      'Enveloppe PumpSwap incohérente.',
      raw.signature,
    );
  }
  assertValidTimestampMs('observedAtMs', transaction.observedAtMs);
  assertValidTransactionCursor(transaction.cursor);
}
