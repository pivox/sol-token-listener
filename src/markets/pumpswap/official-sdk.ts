import { createRequire } from 'node:module';
import type * as PumpSwapSdkModule from '@pump-fun/pump-swap-sdk';

// See the Pump.fun bridge: the official SDK's package metadata is ambiguous
// to Node 22/24 when a TypeScript loader selects its import condition.
const sdk = createRequire(import.meta.url)('@pump-fun/pump-swap-sdk') as typeof PumpSwapSdkModule;

export const {
  buyQuoteInput,
  GLOBAL_CONFIG_PDA,
  poolPda,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_SDK,
  PUMP_FEE_PROGRAM_ID,
  sellBaseInput,
} = sdk;

export type { GlobalConfig } from '@pump-fun/pump-swap-sdk';
