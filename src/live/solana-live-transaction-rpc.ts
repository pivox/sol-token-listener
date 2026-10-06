import { ACCOUNT_SIZE } from '@solana/spl-token';
import { PublicKey, type Connection, type Finality, type Message, type MessageV0 } from '@solana/web3.js';
import type { LiveBlockhash, LiveMessageFee, LiveSignatureStatus, LiveTransactionMeta, LiveTransactionRpc, LiveWalletBalance } from './live-transaction-executor.js';

/** Minimal live RPC adapter. All transaction retries are owned by the durable executor. */
export class SolanaLiveTransactionRpc implements LiveTransactionRpc {
  public constructor(private readonly connection: Connection, private readonly commitment: Finality = 'confirmed') {}

  public async getLatestBlockhash(): Promise<LiveBlockhash> {
    const response = await this.connection.getLatestBlockhash(this.commitment);
    return Object.freeze({ blockhash: response.blockhash, lastValidBlockHeight: response.lastValidBlockHeight });
  }

  public async getWalletBalance(wallet: string): Promise<LiveWalletBalance | null> {
    const response = await this.connection.getBalanceAndContext(new PublicKey(wallet), this.commitment);
    if (!Number.isSafeInteger(response.value) || response.value < 0) return null;
    return Object.freeze({ lamports: BigInt(response.value), contextSlot: BigInt(response.context.slot), observedAtMs: Date.now() });
  }

  public async getMessageFee(message: Message | MessageV0): Promise<LiveMessageFee | null> {
    try {
      const response = await this.connection.getFeeForMessage(message, this.commitment);
      if (response.value === null || !Number.isSafeInteger(response.value) || response.value < 0) return null;
      return Object.freeze({ lamports: BigInt(response.value), contextSlot: BigInt(response.context.slot), observedAtMs: Date.now() });
    } catch {
      return null;
    }
  }

  public async getTokenAccountRentExemption(): Promise<bigint | null> {
    const response = await this.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, this.commitment);
    if (!Number.isSafeInteger(response) || response < 0) return null;
    return BigInt(response);
  }

  public async sendRawTransaction(bytes: Uint8Array): Promise<string> {
    return this.connection.sendRawTransaction(Buffer.from(bytes), {
      maxRetries: 0,
      preflightCommitment: this.commitment,
    });
  }

  public async getSignatureStatus(signature: string): Promise<LiveSignatureStatus | null> {
    const response = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = response.value[0];
    if (status === undefined || status === null) return null;
    return Object.freeze({ confirmationStatus: status.confirmationStatus ?? null, err: status.err });
  }

  public getBlockHeight(): Promise<number> {
    return this.connection.getBlockHeight(this.commitment);
  }

  public async getTransaction(signature: string): Promise<LiveTransactionMeta | null> {
    return await this.connection.getTransaction(signature, {
      commitment: this.commitment,
      maxSupportedTransactionVersion: 0,
    }) as LiveTransactionMeta | null;
  }
}
