import { createRequire } from 'node:module';
import type * as PumpSdkModule from '@pump-fun/pump-sdk';

// @pump-fun/pump-sdk 1.36.0 cannot be loaded through its ESM condition on the
// supported Node 22 line because one transitive Anchor dependency exposes CJS
// named exports incompatibly. Keep the literal CJS bridge isolated here and
// export only the reviewed instruction/codec surface below.
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
