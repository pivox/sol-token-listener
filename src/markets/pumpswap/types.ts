import type { NormalizedInstruction } from '../../solana/rpc/types.js';

export type PumpSwapInstructionName =
  | 'buy'
  | 'buy_exact_quote_in'
  | 'create_pool'
  | 'sell';
export type PumpSwapInstructionFamily = 'BUY' | 'CREATE_POOL' | 'SELL';
export type PumpSwapIdlValue =
  | string
  | boolean
  | bigint
  | readonly PumpSwapIdlValue[];

export interface DecodedPumpSwapInstruction {
  readonly name: PumpSwapInstructionName;
  readonly family: PumpSwapInstructionFamily;
  readonly instruction: NormalizedInstruction;
  readonly accounts: Readonly<Record<string, string>>;
  readonly args: Readonly<Record<string, PumpSwapIdlValue>>;
}

interface DecodedPumpSwapCpiEventBase {
  readonly fields: Readonly<Record<string, PumpSwapIdlValue>>;
  readonly instruction: NormalizedInstruction;
  readonly trailingDataHex: string;
}

export type DecodedPumpSwapCpiEvent =
  | (DecodedPumpSwapCpiEventBase & { readonly kind: 'BUY' })
  | (DecodedPumpSwapCpiEventBase & { readonly kind: 'CREATE_POOL' })
  | (DecodedPumpSwapCpiEventBase & { readonly kind: 'SELL' });

export interface DecodedPumpSwapPoolCreation {
  readonly action: DecodedPumpSwapInstruction & {
    readonly family: 'CREATE_POOL';
  };
  readonly event: DecodedPumpSwapCpiEvent & {
    readonly kind: 'CREATE_POOL';
  };
  readonly pool: string;
  readonly index: bigint;
  readonly creator: string;
  readonly baseMint: string;
  readonly quoteMint: string;
}

export interface DecodedPumpSwapTrade {
  readonly action: DecodedPumpSwapInstruction & {
    readonly family: 'BUY' | 'SELL';
  };
  readonly event: DecodedPumpSwapCpiEvent & {
    readonly kind: 'BUY' | 'SELL';
  };
  readonly kind: 'BUY' | 'SELL';
  readonly pool: string;
  readonly trader: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
}

export interface DecodedPumpSwapTransaction {
  readonly poolCreations: readonly DecodedPumpSwapPoolCreation[];
  readonly trades: readonly DecodedPumpSwapTrade[];
}

export interface DecodedPumpSwapPoolAccount {
  readonly poolBump: number;
  readonly index: number;
  readonly creator: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly lpMint: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly lpSupplyRaw: bigint;
  readonly coinCreator: string;
  readonly isMayhemMode: boolean;
  readonly isCashbackCoin: boolean;
  readonly virtualQuoteReservesRaw: bigint;
  readonly trailingDataHex: string;
}
