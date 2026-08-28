import type { RpcProviderId } from '../domain/rpc-provider.js';

export interface FinalityProviderPass {
  readonly providerId: RpcProviderId;
  getHistoryStatuses(signatures: readonly string[]): Promise<unknown>;
  getFinalizedSlot(): Promise<unknown>;
  getFinalizedBlockSignatures(slot: bigint): Promise<unknown>;
}

export interface FinalityProviderPassSource {
  openPass(): unknown;
}
