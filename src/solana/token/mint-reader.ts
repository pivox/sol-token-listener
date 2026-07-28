import {
  ExtensionType,
  getExtensionTypes,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token';
import { PublicKey, type Connection } from '@solana/web3.js';
import type { TokenExtensionInfo, TokenMetadata } from '../../domain/types.js';

export interface MintReadResult {
  readonly metadata: TokenMetadata;
  readonly initialized: boolean;
  readonly slot: bigint;
}

export class MintReader {
  constructor(private readonly connection: Connection) {}

  async read(mintAddress: string): Promise<MintReadResult> {
    const address = new PublicKey(mintAddress);
    const response = await this.connection.getAccountInfoAndContext(address, 'confirmed');
    if (response.value === null) throw new Error(`Compte mint introuvable: ${mintAddress}.`);

    const owner = response.value.owner;
    const isSplToken = owner.equals(TOKEN_PROGRAM_ID);
    const isToken2022 = owner.equals(TOKEN_2022_PROGRAM_ID);
    if (!isSplToken && !isToken2022) throw new Error(`Programme du mint non pris en charge: ${owner.toBase58()}.`);

    const mint = unpackMint(address, response.value, owner);
    const extensions: TokenExtensionInfo[] = getExtensionTypes(mint.tlvData).map((extension) => ({
      type: ExtensionType[extension],
      details: {},
      affectsTransfers: true,
      mutable: null,
    }));
    return {
      metadata: {
        mint: mintAddress,
        tokenProgram: owner.toBase58(),
        decimals: mint.decimals,
        supplyRaw: mint.supply,
        mintAuthority: mint.mintAuthority?.toBase58() ?? null,
        freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
        extensions,
        name: null,
        symbol: null,
        uri: null,
        updateAuthority: null,
        mutable: null,
      },
      initialized: mint.isInitialized,
      slot: BigInt(response.context.slot),
    };
  }
}
