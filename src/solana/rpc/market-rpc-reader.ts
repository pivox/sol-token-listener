import {
  PublicKey,
  type AccountInfo,
  type Commitment,
} from '@solana/web3.js';
import type {
  MarketRpcReader,
  ReadonlyAccountSnapshot,
} from '../../ports/market-rpc-reader.js';
import {
  registerTrustedTerminalAttribution,
  trustedTerminalAttribution,
} from '../../domain/terminal-attribution.js';

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
    let keys: PublicKey[];
    try {
      keys = addresses.map((address) => new PublicKey(address));
    } catch (error) {
      registerMarketRpcDiagnostic(error, 'PUMPSWAP_RPC_CONTEXT_INVALID');
      throw error;
    }
    let response: Awaited<ReturnType<
      ReadonlyConnection['getMultipleAccountsInfoAndContext']
    >>;
    try {
      response = await this.connection.getMultipleAccountsInfoAndContext(
        keys,
        { commitment: this.commitment },
      );
    } catch (error) {
      registerMarketRpcDiagnostic(
        error,
        'PUMPSWAP_MUTABLE_RPC_UNAVAILABLE',
      );
      throw error;
    }
    if (!Number.isSafeInteger(response.context.slot) || response.context.slot < 0) {
      throw contextError('Slot RPC non canonique.');
    }
    if (response.value.length !== keys.length) {
      throw contextError('Nombre de comptes RPC incohérent.');
    }
    const slot = BigInt(response.context.slot);
    return Object.freeze(response.value.map((account, index) => {
      if (account === null) return null;
      const key = keys[index];
      if (key === undefined || !Number.isSafeInteger(account.lamports) || account.lamports < 0) {
        throw contextError('Compte RPC non canonique.');
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

function contextError(message: string): MarketRpcContextError {
  const error = new MarketRpcContextError(message);
  registerMarketRpcDiagnostic(error, 'PUMPSWAP_RPC_CONTEXT_INVALID');
  return error;
}

function registerMarketRpcDiagnostic(
  identity: unknown,
  diagnosticCode:
    | 'PUMPSWAP_MUTABLE_RPC_UNAVAILABLE'
    | 'PUMPSWAP_RPC_CONTEXT_INVALID',
): void {
  if (typeof identity !== 'object'
    || identity === null
    || trustedTerminalAttribution(identity) !== null) return;
  try {
    registerTrustedTerminalAttribution(identity, {
      version: 1,
      diagnosticCode,
      causeKind: null,
      pumpWire: null,
    });
  } catch {
    // Hostile/proxied/revoked provider failures preserve runtime behavior.
  }
}
