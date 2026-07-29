import {
  PublicKey,
  type AccountInfo,
  type Commitment,
} from '@solana/web3.js';
import type {
  MarketRpcReader,
  ReadonlyAccountSnapshot,
} from '../../ports/market-rpc-reader.js';

interface ReadonlyConnection {
  getMultipleAccountsInfoAndContext(
    publicKeys: readonly PublicKey[],
    config: { readonly commitment: Commitment },
  ): Promise<{
    readonly context: { readonly slot: number };
    readonly value: readonly (AccountInfo<Buffer> | null)[];
  }>;
}

export class MarketRpcContextError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MarketRpcContextError';
  }
}

export class SolanaMarketRpcReader implements MarketRpcReader {
  public constructor(
    private readonly connection: ReadonlyConnection,
    private readonly commitment: Commitment = 'confirmed',
  ) {}

  public async readAccountsAtSameSlot(
    addresses: readonly string[],
  ): Promise<readonly (ReadonlyAccountSnapshot | null)[]> {
    if (addresses.length === 0) return Object.freeze([]);
    const keys = addresses.map((address) => new PublicKey(address));
    const response = await this.connection.getMultipleAccountsInfoAndContext(
      keys,
      { commitment: this.commitment },
    );
    if (!Number.isSafeInteger(response.context.slot) || response.context.slot < 0) {
      throw new MarketRpcContextError('Slot RPC non canonique.');
    }
    if (response.value.length !== keys.length) {
      throw new MarketRpcContextError('Nombre de comptes RPC incohérent.');
    }
    const slot = BigInt(response.context.slot);
    return Object.freeze(response.value.map((account, index) => {
      if (account === null) return null;
      const key = keys[index];
      if (key === undefined || !Number.isSafeInteger(account.lamports) || account.lamports < 0) {
        throw new MarketRpcContextError('Compte RPC non canonique.');
      }
      return Object.freeze({
        address: key.toBase58(),
        owner: account.owner.toBase58(),
        data: Uint8Array.from(account.data),
        lamports: BigInt(account.lamports),
        slot,
      });
    }));
  }
}
