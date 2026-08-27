import {
  Connection,
  type Commitment,
  type ConnectionConfig,
  type FetchFn,
  type Finality,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { AppConfig } from '../../config/env.js';
import {
  createRpcHttpFailoverFetch,
  type RpcHttpEndpointId,
  type RpcHttpFailoverEvent,
} from './http-failover-transport.js';
import type { LegacyConfirmationStatus } from './types.js';

export interface RpcHealth {
  readonly version: string;
  readonly httpSlot: bigint;
  readonly finalizedSlot: bigint;
}

export interface SolanaRpcClientDependencies {
  readonly fetch?: FetchFn;
  readonly now?: () => number;
  readonly onHttpFailoverEvent?: (event: RpcHttpFailoverEvent) => void;
}

type SolanaConnectionConfig = Pick<
  AppConfig,
  'httpRpcUrl' | 'httpRpcFallbackUrls' | 'wsRpcUrl' | 'commitment'
>;

export function createSolanaConnectionConfig(
  config: SolanaConnectionConfig,
  dependencies: SolanaRpcClientDependencies = {},
): ConnectionConfig {
  if (config.httpRpcFallbackUrls.length === 0) {
    return {
      commitment: config.commitment,
      wsEndpoint: config.wsRpcUrl,
    };
  }

  const endpoints = Object.freeze([
    Object.freeze({ id: 'primary' as const, url: config.httpRpcUrl }),
    ...config.httpRpcFallbackUrls.map((url, index) => Object.freeze({
      id: `fallback-${index + 1}` as RpcHttpEndpointId,
      url,
    })),
  ]);
  return {
    commitment: config.commitment,
    wsEndpoint: config.wsRpcUrl,
    fetch: createRpcHttpFailoverFetch({
      endpoints,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.onHttpFailoverEvent === undefined
        ? {}
        : { onEvent: dependencies.onHttpFailoverEvent }),
    }),
    disableRetryOnRateLimit: true,
  };
}

export class SolanaRpcClient {
  readonly http: Connection;
  readonly commitment: Commitment;
  readonly finality: Finality;

  constructor(
    config: Pick<
      AppConfig,
      'httpRpcUrl' | 'httpRpcFallbackUrls' | 'wsRpcUrl' | 'commitment' | 'finality'
    >,
    dependencies: SolanaRpcClientDependencies = {},
  ) {
    this.commitment = config.commitment;
    this.finality = config.finality;
    this.http = new Connection(
      config.httpRpcUrl,
      createSolanaConnectionConfig(config, dependencies),
    );
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
  ): Promise<readonly string[]> {
    const numericSlot = Number(slot);
    if (!Number.isSafeInteger(numericSlot) || numericSlot < 0) {
      throw new TypeError('Solana block slot is invalid.');
    }
    const block = await this.http.getBlockSignatures(numericSlot, rpcFinality(confirmationStatus));
    return Object.freeze([...block.signatures]);
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
