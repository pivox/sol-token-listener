import type {
  QuoteAsset,
} from '../../domain/types.js';
import type {
  NormalizedInstruction,
  NormalizedTransaction,
} from '../../solana/rpc/types.js';

export type PumpInstructionName =
  | 'buy'
  | 'buy_exact_quote_in_v2'
  | 'buy_exact_sol_in'
  | 'buy_v2'
  | 'create'
  | 'create_v2'
  | 'migrate'
  | 'migrate_v2'
  | 'sell'
  | 'sell_v2';

export type PumpInstructionFamily = 'CREATE' | 'BUY' | 'SELL' | 'MIGRATE';

export interface PumpIdlObject {
  readonly [key: string]: PumpIdlValue;
}

export type PumpIdlValue =
  | string
  | boolean
  | bigint
  | readonly PumpIdlValue[]
  | PumpIdlObject;

export interface DecodedPumpInstruction {
  readonly name: PumpInstructionName;
  readonly family: PumpInstructionFamily;
  readonly instruction: NormalizedInstruction;
  readonly accounts: Readonly<Record<string, string>>;
  readonly args: Readonly<Record<string, PumpIdlValue>>;
}

export interface DecodedPumpShareholder {
  readonly address: string;
  readonly shareBps: bigint;
}

export interface DecodedPumpCreateEvent {
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly mint: string;
  readonly bondingCurve: string;
  readonly user: string;
  readonly creator: string;
  readonly timestamp: bigint;
  readonly virtualTokenReserves: bigint;
  readonly virtualSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly tokenTotalSupply: bigint;
  readonly tokenProgram: string;
  readonly isMayhemMode: boolean;
  readonly isCashbackEnabled: boolean;
  readonly quoteMint: string;
  readonly virtualQuoteReserves: bigint;
}

export interface DecodedPumpTradeEvent {
  readonly mint: string;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly isBuy: boolean;
  readonly user: string;
  readonly timestamp: bigint;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly feeRecipient: string;
  readonly feeBasisPoints: bigint;
  readonly fee: bigint;
  readonly creator: string;
  readonly creatorFeeBasisPoints: bigint;
  readonly creatorFee: bigint;
  readonly trackVolume: boolean;
  readonly totalUnclaimedTokens: bigint;
  readonly totalClaimedTokens: bigint;
  readonly currentSolVolume: bigint;
  readonly lastUpdateTimestamp: bigint;
  readonly ixName: string;
  readonly mayhemMode: boolean;
  readonly cashbackFeeBasisPoints: bigint;
  readonly cashback: bigint;
  readonly buybackFeeBasisPoints: bigint;
  readonly buybackFee: bigint;
  readonly shareholders: readonly DecodedPumpShareholder[];
  readonly quoteMint: string;
  readonly quoteAmount: bigint;
  readonly virtualQuoteReserves: bigint;
  readonly realQuoteReserves: bigint;
}

export type DecodedPumpCpiEvent =
  | {
    readonly kind: 'CREATE';
    readonly event: DecodedPumpCreateEvent;
    readonly instruction: NormalizedInstruction;
    readonly trailingDataHex: string;
  }
  | {
    readonly kind: 'TRADE';
    readonly event: DecodedPumpTradeEvent;
    readonly instruction: NormalizedInstruction;
    readonly trailingDataHex: string;
  };

export interface DecodedPumpCreation {
  readonly action: DecodedPumpInstruction & { readonly family: 'CREATE' };
  readonly event: DecodedPumpCreateEvent;
  readonly eventCpi: Extract<
    DecodedPumpCpiEvent,
    { readonly kind: 'CREATE' }
  >;
  readonly quoteAsset: QuoteAsset;
}

export interface DecodedPumpTrade {
  readonly action: DecodedPumpInstruction & {
    readonly family: 'BUY' | 'SELL';
  };
  readonly event: DecodedPumpTradeEvent;
  readonly eventCpi: Extract<
    DecodedPumpCpiEvent,
    { readonly kind: 'TRADE' }
  >;
  readonly quoteAsset: QuoteAsset;
}

export interface DecodedPumpMigration {
  readonly action: DecodedPumpInstruction & { readonly family: 'MIGRATE' };
  readonly instruction: 'MIGRATE' | 'MIGRATE_V2';
  readonly mint: string;
  readonly bondingCurve: string;
  readonly announcedPool: string;
  readonly baseTokenProgram: import('../../domain/types.js').TokenProgramKind;
  readonly quoteAsset: QuoteAsset;
}

export interface DecodedPumpTransaction {
  readonly transaction: NormalizedTransaction;
  readonly creations: readonly DecodedPumpCreation[];
  readonly trades: readonly DecodedPumpTrade[];
  readonly migrations: readonly DecodedPumpMigration[];
}
