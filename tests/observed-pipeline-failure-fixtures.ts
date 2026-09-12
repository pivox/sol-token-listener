import { ObservedTransactionPipeline } from '../src/application/observed-transaction-pipeline.js';
import { LaunchpadObservationService } from '../src/application/launchpad-observation.service.js';
import { PumpFunLaunchpadAdapter } from '../src/launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import { PUMP_INSTRUCTIONS } from '../src/launchpads/pumpfun/generated/pump-idl.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';

export function failurePipeline(
  operation: () => unknown,
  stage: 'launchpad_observation' | 'pumpswap_observation' | 'load_tracked_mints' = 'launchpad_observation',
  launchpad?: ConstructorParameters<typeof ObservedTransactionPipeline>[1],
  market?: ConstructorParameters<typeof ObservedTransactionPipeline>[5],
): ObservedTransactionPipeline {
  return new ObservedTransactionPipeline({
    async listTrackedMints() {
      if (stage === 'load_tracked_mints') await operation();
      return new Set<string>();
    },
    async listActiveEventsBySignature() { return []; },
  }, launchpad ?? {
    async observe() {
      if (stage === 'launchpad_observation') await operation();
      return { events: [], affectedMints: [] };
    },
  }, { async observe() { return { assessments: [], evidence: [] }; } },
  { async rebuild() {} }, { async rebuild() {} }, market ?? {
    async processObserved() {
      if (stage === 'pumpswap_observation') await operation();
      return { migrations: [], activations: [], affectedMints: [] };
    },
  });
}

export function realPumpPipeline(): ObservedTransactionPipeline {
  const adapter = new PumpFunLaunchpadAdapter({ async read() { throw new Error('unexpected RPC'); } });
  const service = new LaunchpadObservationService(adapter, {
    async record() { throw new Error('unexpected persistence'); },
  });
  return failurePipeline(() => {}, 'launchpad_observation', service);
}

export function malformedPumpTransaction(
  code: 'PUMP_BORSH_INVALID' | 'PUMP_BORSH_TRUNCATED' | 'PUMP_ACCOUNT_MISSING',
  signature = 'sig',
): NormalizedTransaction {
  const data = code === 'PUMP_BORSH_INVALID'
    ? Uint8Array.from([...PUMP_INSTRUCTIONS.buy.discriminator, ...new Uint8Array(16), 2])
    : Uint8Array.from(PUMP_INSTRUCTIONS.buy.discriminator);
  const accounts = code === 'PUMP_ACCOUNT_MISSING'
    ? [] : PUMP_INSTRUCTIONS.buy.accounts.map((_, index) => `synthetic-account-${index}`);
  return {
    ...failureTransaction(signature),
    instructions: [{ programId: PUMP_PROGRAM_ID, accounts, data,
      instructionIndex: 0, innerInstructionIndex: null, parentInstructionIndex: null, stackHeight: null }],
  };
}

export function failureTransaction(signature = 'sig'): NormalizedTransaction {
  return {
    signature, slot: 1n, transactionIndex: 0, confirmationStatus: 'CONFIRMED',
    version: 'legacy', blockTimeMs: 999, accountKeys: [], signerKeys: [],
    instructions: [], preTokenBalances: [], postTokenBalances: [],
    preBalancesLamports: [], postBalancesLamports: [], feeLamports: 0n,
    computeUnits: null, logs: [], error: null,
  };
}
