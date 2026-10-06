import { createRequire } from 'node:module';
import type * as PumpSwapSdkModule from '@pump-fun/pump-swap-sdk';

// See the Pump.fun bridge: the official SDK's package metadata is ambiguous
// to Node 22/24 when a TypeScript loader selects its import condition.
const sdk = createRequire(import.meta.url)('@pump-fun/pump-swap-sdk') as typeof PumpSwapSdkModule;

export const {
  buyQuoteInput,
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  poolPda,
  poolV2Pda,
  PUMP_AMM_FEE_CONFIG_PDA,
  OFFLINE_PUMP_AMM_PROGRAM,
  PUMP_AMM_SDK,
  PUMP_FEE_PROGRAM_ID,
  sellBaseInput,
  userVolumeAccumulatorPda,
} = sdk;

export type { GlobalConfig } from '@pump-fun/pump-swap-sdk';
