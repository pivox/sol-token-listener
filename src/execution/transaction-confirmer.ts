import type { BuiltTransaction } from '../domain/types.js';
import type { WalletSigner } from './wallet.js';

export interface ConfirmationResult {
  readonly signature: string;
  readonly confirmedAtMs: number;
}

export class TransactionConfirmer {
  signSendAndConfirm(transaction: BuiltTransaction, wallet: WalletSigner): Promise<ConfirmationResult> {
    void transaction;
    void wallet;
    return Promise.reject(new Error('Transaction submission is disabled in Pump.fun V1.'));
  }
}
