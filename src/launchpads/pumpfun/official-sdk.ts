import { createRequire } from 'node:module';
import type * as PumpSdkModule from '@pump-fun/pump-sdk';

// The official package exposes an ESM condition without declaring its package
// type. Node 22/24 therefore cannot reliably bind its named exports through
// TypeScript loaders. Keep that packaging workaround isolated at this edge.
const sdk = createRequire(import.meta.url)('@pump-fun/pump-sdk') as typeof PumpSdkModule;

export const {
  bondingCurvePda,
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
} = sdk;

export type { BondingCurve, FeeConfig, Global } from '@pump-fun/pump-sdk';
