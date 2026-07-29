import type {
  ChainConfirmationStatus,
  ChainCursor,
  ObservedChainTransaction,
  QuoteAsset,
  TokenProgramKind,
} from './types.js';

export interface MigrationObservation {
  readonly instruction: 'MIGRATE' | 'MIGRATE_V2';
  readonly mint: string;
  readonly bondingCurve: string;
  readonly announcedPool: string;
  readonly baseTokenProgram: TokenProgramKind;
  readonly quoteAsset: QuoteAsset;
  readonly cursor: ChainCursor;
}

export interface MarketPool {
  readonly address: string;
  readonly market: string;
  readonly baseMint: string;
  readonly quoteAsset: QuoteAsset;
  readonly activatedAt: ChainCursor;
}

export interface CanonicalMarketPool extends MarketPool {
  readonly programId: string;
  readonly index: number;
  readonly creator: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly lpMint: string;
  readonly baseTokenProgram: TokenProgramKind;
  readonly confirmationStatus: ChainConfirmationStatus;
}

export interface MarketReserves {
  readonly id: string;
  readonly pool: string;
  readonly baseReservesRaw: bigint;
  readonly quoteVaultAmountRaw: bigint;
  readonly virtualQuoteReservesRaw: bigint;
  readonly effectiveQuoteReservesRaw: bigint;
  readonly observedSlot: bigint;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly observedAtMs: number;
}

export interface MarketQuote {
  readonly id: string;
  readonly pool: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  readonly minimumAmountOutRaw: bigint;
  readonly feesRaw: bigint;
  readonly slippageBps: bigint;
  readonly priceImpactBps: bigint;
  readonly observedAtMs: number;
  readonly observedSlot: bigint;
}

export interface MarketTrade {
  readonly id: string;
  readonly pool: string;
  readonly mint: string;
  readonly quoteAsset: QuoteAsset;
  readonly kind: 'BUY' | 'SELL';
  readonly trader: string | null;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTimeMs: number | null;
  readonly observedAtMs: number;
}

export interface MarketQuoteRequest {
  readonly pool: CanonicalMarketPool;
  readonly inputMint: string;
  readonly amountInRaw: bigint;
  readonly slippageBps: bigint;
}

export interface RawMarketObservation {
  readonly id: string;
  readonly source: string;
  readonly program: string;
  readonly mint: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTimeMs: number | null;
  readonly observedAtMs: number;
  readonly payloadVersion: 1;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type MarketObservedTransaction = ObservedChainTransaction;
