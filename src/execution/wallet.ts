import type { VersionedTransaction } from '@solana/web3.js';

export interface WalletSigner {
  readonly address: string;
  sign(transaction: VersionedTransaction): Promise<void>;
}

export function observationWallet(address = '11111111111111111111111111111111'): WalletSigner {
  return {
    address,
    sign(transaction: VersionedTransaction): Promise<void> {
      void transaction;
      return Promise.reject(new Error('Signing is disabled in Pump.fun V1.'));
    },
  };
}
