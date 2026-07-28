import {
  Connection,
  type Commitment,
  type Finality,
} from '@solana/web3.js';
import type { AppConfig } from '../../config/env.js';

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
