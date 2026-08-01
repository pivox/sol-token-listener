import {
  Connection,
  type Commitment,
  type Finality,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { AppConfig } from '../../config/env.js';
import type { LegacyConfirmationStatus } from './types.js';

export interface RpcHealth {
  readonly version: string;
  readonly httpSlot: bigint;
  readonly finalizedSlot: bigint;
}

export class SolanaRpcClient {
  readonly http: Connection;
  readonly commitment: Commitment;
  readonly finality: Finality;

  constructor(config: Pick<AppConfig, 'httpRpcUrl' | 'wsRpcUrl' | 'commitment' | 'finality'>) {
    this.commitment = config.commitment;
    this.finality = config.finality;
    this.http = new Connection(config.httpRpcUrl, {
      commitment: config.commitment,
      wsEndpoint: config.wsRpcUrl,
    });
  }

  async getSlot(commitment: Commitment | Finality = this.commitment): Promise<bigint> {
    return BigInt(await this.http.getSlot(commitment));
  }

  async getTransaction(
    signature: string,
    confirmationStatus: Exclude<LegacyConfirmationStatus, 'ORPHANED'>,
  ): Promise<VersionedTransactionResponse | null> {
    return this.http.getTransaction(signature, {
      commitment: rpcFinality(confirmationStatus),
      maxSupportedTransactionVersion: 0,
    });
  }

  async getBlockSignatures(
    slot: bigint,
    confirmationStatus: Exclude<LegacyConfirmationStatus, 'ORPHANED'>,
  ): Promise<readonly string[] | null> {
    const numericSlot = Number(slot);
    if (!Number.isSafeInteger(numericSlot) || numericSlot < 0) {
      throw new TypeError('Solana block slot is invalid.');
    }
    const response = await this.http.getBlock(numericSlot, {
      commitment: rpcFinality(confirmationStatus),
      transactionDetails: 'signatures',
      rewards: false,
      maxSupportedTransactionVersion: 0,
    });
    const block = response as unknown as { readonly signatures: readonly string[] } | null;
    return block === null
      ? null
      : Object.freeze([...block.signatures]);
  }

  async getHistoryStatuses(signatures: readonly string[]): Promise<readonly ({
    readonly slot: bigint;
    readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized';
  } | null)[]> {
    const response = await this.http.getSignatureStatuses([...signatures], {
      searchTransactionHistory: true,
    });
    return Object.freeze(response.value.map((status) => {
      if (status === null) return null;
      const confirmationStatus = status.confirmationStatus;
      if (confirmationStatus !== 'processed'
        && confirmationStatus !== 'confirmed'
        && confirmationStatus !== 'finalized') {
        throw new TypeError('Solana confirmation status is unavailable.');
      }
      return Object.freeze({ slot: BigInt(status.slot), confirmationStatus });
    }));
  }

  async getFinalizedSlot(): Promise<bigint> {
    return this.getSlot('finalized');
  }

  async checkHealth(): Promise<RpcHealth> {
    const [version, httpSlot, finalizedSlot] = await Promise.all([
      this.http.getVersion(),
      this.getSlot(this.commitment),
      this.getSlot(this.finality),
    ]);
    return {
      version: version['solana-core'],
      httpSlot,
      finalizedSlot,
    };
  }
}

function rpcFinality(
  confirmationStatus: Exclude<LegacyConfirmationStatus, 'ORPHANED'>,
): Finality {
  return confirmationStatus === 'FINALIZED' ? 'finalized' : 'confirmed';
}
