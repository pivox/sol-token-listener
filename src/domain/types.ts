import type { VersionedTransaction } from '@solana/web3.js';
import type { ExecutionMode } from '../config/env.js';

export type TokenProgramKind = 'SPL_TOKEN' | 'TOKEN_2022';
export type ChainConfirmationStatus = 'processed' | 'confirmed' | 'finalized' | 'orphaned';

export interface ChainCursor {
  readonly slot: bigint;
  readonly transactionIndex: number;
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null;
}

export interface QuoteAsset {
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: TokenProgramKind;
}

export type LaunchParameterValue =
  | null
  | string
  | boolean
  | bigint
  | number
  | readonly LaunchParameterValue[]
  | LaunchParameterObject;

export interface LaunchParameterObject {
  readonly [key: string]: LaunchParameterValue;
}

export interface TokenLaunch {
  readonly mint: string;
  readonly creator: string;
  readonly tokenProgram: TokenProgramKind;
  readonly quoteAssets: readonly QuoteAsset[];
  readonly launchpad: string;
  readonly createdAt: ChainCursor;
  readonly parameters: LaunchParameterObject;
}

export interface ObservedChainTransaction {
  readonly signature: string;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockTimeMs: number | null;
  readonly observedAtMs: number;
  readonly cursor: Pick<ChainCursor, 'slot' | 'transactionIndex'>;
  readonly raw: unknown;
}

export interface LaunchpadTrade {
  readonly id: string;
  readonly launchMint: string;
  readonly kind: 'BUY' | 'SELL';
  readonly trader: string | null;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
  readonly quoteAsset: QuoteAsset;
  readonly cursor: ChainCursor;
}

export interface BondingCurveState {
  readonly launchMint: string;
  readonly quoteAsset: QuoteAsset;
  readonly realBaseReservesRaw: bigint;
  readonly realQuoteReservesRaw: bigint;
  readonly virtualBaseReservesRaw: bigint;
  readonly virtualQuoteReservesRaw: bigint;
  readonly progressBps: bigint;
  readonly complete: boolean;
  readonly observedSlot: bigint;
}

export interface MarketPool {
  readonly address: string;
  readonly market: string;
  readonly baseMint: string;
  readonly quoteAsset: QuoteAsset;
  readonly activatedAt: ChainCursor;
}

export interface MarketReserves {
  readonly pool: string;
  readonly baseReservesRaw: bigint;
  readonly quoteVaultAmountRaw: bigint;
  readonly virtualQuoteReservesRaw: bigint;
  readonly effectiveQuoteReservesRaw: bigint;
  readonly observedSlot: bigint;
}

export interface MarketQuote {
  readonly pool: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  readonly minimumAmountOutRaw: bigint;
  readonly feesRaw: bigint;
  readonly priceImpactBps: bigint;
  readonly observedSlot: bigint;
}

export interface MarketTrade {
  readonly id: string;
  readonly pool: string;
  readonly kind: 'BUY' | 'SELL';
  readonly trader: string | null;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
  readonly cursor: ChainCursor;
}

// Legacy Raydium projection types. They remain isolated from the generic ports.
export interface PoolInfo {
  readonly dex: 'RAYDIUM_CPMM';
  readonly programId: string;
  readonly pool: string;
  readonly tokenMint: string;
  readonly wsolMint: string;
  tokenVault: string;
  wsolVault: string;
  readonly lpMint: string;
  readonly tokenProgram: string;
  readonly wsolTokenProgram: string;
  readonly creator: string | null;
  readonly openTimeUnix: bigint;
  readonly createdSlot: bigint;
  readonly createdSignature: string;
  readonly createdInstructionIndex: number;
  readonly discoveredAtMs: number;
}

export type SwapKind = 'BUY' | 'SELL';

export interface SwapEvent {
  readonly id: string;
  readonly dex: 'RAYDIUM_CPMM';
  readonly pool: string;
  readonly signature: string;
  readonly kind: SwapKind;
  readonly payer: string | null;
  readonly authority: string | null;
  readonly amountWsolRaw: bigint;
  readonly amountTokenRaw: bigint;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: 'PROCESSED' | 'CONFIRMED' | 'FINALIZED' | 'ORPHANED';
  readonly observedAtMs: number;
}

export interface PoolRuntimeState {
  readonly pool: string;
  readonly statusBits: number;
  readonly swapsEnabled: boolean;
  readonly openTimeUnix: bigint;
  readonly tokenVaultBalanceRaw: bigint;
  readonly wsolVaultBalanceRaw: bigint;
  readonly observedSlot: bigint;
}

export interface QuoteResult {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  readonly minimumAmountOutRaw: bigint;
  readonly tradeFeeRaw: bigint;
  readonly transferFeeRaw: bigint;
  readonly priceImpactBps: number;
  readonly observedSlot: bigint;
}

export interface BuiltTransaction {
  readonly transaction: VersionedTransaction;
  readonly lastValidBlockHeight?: bigint | undefined;
}

export interface TransactionSimulation {
  readonly ok: boolean;
  readonly error: string | null;
  readonly logs: readonly string[];
  readonly unitsConsumed: bigint | null;
  readonly replacementBlockhash: string | null;
}

export interface EntryExecution {
  readonly mode: ExecutionMode;
  readonly amountInLamports: bigint;
  readonly amountOutTokenRaw: bigint;
  readonly quotedOutTokenRaw: bigint;
  readonly signature?: string | undefined;
  readonly feeLamports?: bigint | undefined;
  readonly rentDeltaLamports?: bigint | undefined;
  readonly priorityFeeLamports?: bigint | undefined;
  readonly computeUnits?: bigint | undefined;
  readonly cursor: ChainCursor | null;
  readonly confirmedAtMs: number;
  readonly simulation: TransactionSimulation;
}

export interface ExitExecution {
  readonly mode: ExecutionMode;
  readonly amountInTokenRaw: bigint;
  readonly amountOutLamports: bigint;
  readonly quotedOutLamports: bigint;
  readonly signature?: string | undefined;
  readonly feeLamports?: bigint | undefined;
  readonly rentDeltaLamports?: bigint | undefined;
  readonly priorityFeeLamports?: bigint | undefined;
  readonly computeUnits?: bigint | undefined;
  readonly confirmedAtMs: number;
  readonly simulation: TransactionSimulation;
}

export type TokenSessionStatus =
  | 'POOL_DISCOVERED'
  | 'WAITING_POOL_OPEN'
  | 'WAITING_FIRST_BUY'
  | 'RISK_CHECKING'
  | 'BUY_PENDING'
  | 'HOLDING'
  | 'SELL_PENDING'
  | 'CLOSED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'ORPHANED'
  | 'MANUAL_REVIEW';

export interface TokenSession {
  readonly id: string;
  readonly pool: PoolInfo;
  metadata: TokenMetadata | null;
  status: TokenSessionStatus;
  subsequentBuyCount: number;
  targetBuysAfterEntry: number;
  countedBuyEventIds: string[];
  sellAttempts: number;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  lastProcessedCursor?: ChainCursor | undefined;
  firstBuy?: SwapEvent | undefined;
  riskReportId?: string | undefined;
  entry?: EntryExecution | undefined;
  exit?: ExitExecution | undefined;
  rejectionReason?: string | undefined;
}

export interface TradeRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly pool: string;
  readonly tokenMint: string;
  readonly side: 'BUY' | 'SELL';
  readonly mode: ExecutionMode;
  readonly status: 'SIMULATED' | 'CONFIRMED' | 'FAILED';
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  readonly quotedOutRaw: bigint;
  readonly signature?: string | undefined;
  readonly slot?: bigint | undefined;
  readonly feeLamports?: bigint | undefined;
  readonly rentDeltaLamports?: bigint | undefined;
  readonly priorityFeeLamports?: bigint | undefined;
  readonly computeUnits?: bigint | undefined;
  readonly error?: string | undefined;
  readonly payload: Record<string, unknown>;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface TokenExtensionInfo {
  readonly type: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly affectsTransfers: boolean;
  readonly mutable: boolean | null;
}

export interface TokenMetadata {
  readonly mint: string;
  readonly tokenProgram: string;
  readonly decimals: number;
  readonly supplyRaw: bigint;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly extensions: readonly TokenExtensionInfo[];
  readonly name: string | null;
  readonly symbol: string | null;
  readonly uri: string | null;
  readonly updateAuthority: string | null;
  readonly mutable: boolean | null;
}
