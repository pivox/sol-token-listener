import { PublicKey } from '@solana/web3.js';
import { poolPda } from './official-sdk.js';
import {
  ExtensionType,
  getExtensionTypes,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token';
import { MarketError } from '../../domain/market-errors.js';
import type { CanonicalMarketPool } from '../../domain/market.js';
import type {
  ChainConfirmationStatus,
  ChainCursor,
  QuoteAsset,
  TokenProgramKind,
} from '../../domain/types.js';
import type { ReadonlyAccountSnapshot } from '../../ports/market-rpc-reader.js';
import type { MarketRpcReader } from '../../ports/market-rpc-reader.js';
import type { SolanaObservedTransaction } from '../../solana/rpc/observed-transaction.js';
import { decodePumpSwapPoolAccount } from './pool-account-decoder.js';
import type {
  DecodedPumpSwapPoolAccount,
  DecodedPumpSwapPoolCreation,
  PumpSwapIdlValue,
} from './types.js';
import { PUMPSWAP_PROGRAM_ID } from './constants.js';

export interface PumpSwapPoolValidationInput {
  readonly account: ReadonlyAccountSnapshot;
  readonly baseMintAccount: ReadonlyAccountSnapshot;
  readonly quoteMintAccount: ReadonlyAccountSnapshot;
  readonly creation: DecodedPumpSwapPoolCreation;
  readonly decoded: DecodedPumpSwapPoolAccount;
  readonly quoteAsset: QuoteAsset;
  readonly baseTokenProgram: TokenProgramKind;
  readonly activatedAt: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
}

export class RpcPumpSwapPoolValidator {
  public constructor(private readonly rpc: MarketRpcReader) {}

  public async validate(
    creation: DecodedPumpSwapPoolCreation,
    transaction: SolanaObservedTransaction,
  ): Promise<CanonicalMarketPool | null> {
    const [poolAccount, baseMintAccount, quoteMintAccount] =
      await this.rpc.readAccountsAtSameSlot([
        creation.pool,
        creation.baseMint,
        creation.quoteMint,
      ]);
    if (poolAccount === null || poolAccount === undefined) return null;
    const baseMint = requiredRpcAccount(baseMintAccount, creation.baseMint);
    const quoteMint = requiredRpcAccount(quoteMintAccount, creation.quoteMint);
    const baseTokenProgram = programKind(
      decodedAddress(creation.action, 'base_token_program'),
    );
    const quoteTokenProgram = programKind(
      decodedAddress(creation.action, 'quote_token_program'),
    );
    if (quoteMint.data.length < MintLayout.span) {
      mismatch('quote mint layout');
    }
    return validateCanonicalPumpSwapPool({
      account: poolAccount,
      baseMintAccount: baseMint,
      quoteMintAccount: quoteMint,
      creation,
      decoded: decodePumpSwapPoolAccount(poolAccount),
      quoteAsset: {
        mint: creation.quoteMint,
        decimals: MintLayout.decode(quoteMint.data).decimals,
        tokenProgram: quoteTokenProgram,
      },
      baseTokenProgram,
      activatedAt: {
        slot: transaction.cursor.slot,
        transactionIndex: transaction.cursor.transactionIndex,
        instructionIndex: creation.action.instruction.instructionIndex,
        innerInstructionIndex:
          creation.action.instruction.innerInstructionIndex,
      },
      confirmationStatus: transaction.confirmationStatus,
    });
  }
}

function requiredRpcAccount(
  account: ReadonlyAccountSnapshot | null | undefined,
  address: string,
): ReadonlyAccountSnapshot {
  if (account?.address !== address) mismatch('mint account missing');
  return account;
}

export function validateCanonicalPumpSwapPool(
  input: PumpSwapPoolValidationInput,
): CanonicalMarketPool {
  const { decoded } = input;
  if (input.account.owner !== PUMPSWAP_PROGRAM_ID) mismatch('pool owner');
  if (decoded.index !== 0) {
    throw new MarketError(
      'MARKET_POOL_NON_CANONICAL',
      `Pool PumpSwap non canonique: index ${decoded.index}.`,
    );
  }
  if (decoded.quoteMint !== input.quoteAsset.mint) mismatch('quote mint');
  verifyCreationProof(input);
  const baseMint = decodeMint(
    input.baseMintAccount,
    decoded.baseMint,
    input.baseTokenProgram,
  );
  const quoteMint = decodeMint(
    input.quoteMintAccount,
    decoded.quoteMint,
    input.quoteAsset.tokenProgram,
  );
  if (quoteMint.decimals !== input.quoteAsset.decimals) {
    mismatch('quote decimals');
  }
  equalEventBigint(input.creation, 'base_mint_decimals', BigInt(baseMint.decimals));
  equalEventBigint(input.creation, 'quote_mint_decimals', BigInt(quoteMint.decimals));
  const expected = poolPda(
    0,
    new PublicKey(decoded.creator),
    new PublicKey(decoded.baseMint),
    new PublicKey(decoded.quoteMint),
  ).toBase58();
  if (expected !== input.account.address) {
    throw new MarketError(
      'MARKET_POOL_NON_CANONICAL',
      'Adresse PDA du pool PumpSwap non canonique.',
    );
  }
  return Object.freeze({
    address: input.account.address,
    market: 'pumpswap',
    programId: input.account.owner,
    baseMint: decoded.baseMint,
    quoteAsset: Object.freeze({ ...input.quoteAsset }),
    index: decoded.index,
    creator: decoded.creator,
    baseVault: decoded.baseVault,
    quoteVault: decoded.quoteVault,
    lpMint: decoded.lpMint,
    baseTokenProgram: input.baseTokenProgram,
    activatedAt: Object.freeze({ ...input.activatedAt }),
    confirmationStatus: input.confirmationStatus,
  });
}

function verifyCreationProof(input: PumpSwapPoolValidationInput): void {
  const { creation, decoded } = input;
  if (
    creation.pool !== input.account.address
    || creation.pool !== decodedAddress(creation.action, 'pool')
    || creation.creator !== decoded.creator
    || creation.baseMint !== decoded.baseMint
    || creation.quoteMint !== decoded.quoteMint
    || creation.index !== BigInt(decoded.index)
    || decodedAddress(creation.action, 'lp_mint') !== decoded.lpMint
    || decodedAddress(creation.action, 'pool_base_token_account')
      !== decoded.baseVault
    || decodedAddress(creation.action, 'pool_quote_token_account')
      !== decoded.quoteVault
    || decodedAddress(creation.action, 'base_token_program')
      !== tokenProgram(input.baseTokenProgram).toBase58()
    || decodedAddress(creation.action, 'quote_token_program')
      !== tokenProgram(input.quoteAsset.tokenProgram).toBase58()
  ) mismatch('instruction, event ou compte pool');
  equalEventText(creation, 'lp_mint', decoded.lpMint);
  equalEventText(creation, 'coin_creator', decoded.coinCreator);
  equalEventBigint(creation, 'pool_bump', BigInt(decoded.poolBump));
}

function decodeMint(
  account: ReadonlyAccountSnapshot,
  address: string,
  programKind: TokenProgramKind,
): ReturnType<typeof unpackMint> {
  if (account.address !== address) mismatch('mint account');
  const program = tokenProgram(programKind);
  let mint: ReturnType<typeof unpackMint>;
  try {
    mint = unpackMint(
      new PublicKey(address),
      {
        data: Buffer.from(account.data),
        executable: false,
        lamports: safeLamports(account.lamports),
        owner: new PublicKey(account.owner),
        rentEpoch: 0,
      },
      program,
    );
  } catch {
    mismatch('mint layout ou programme token');
  }
  const allowed = new Set<ExtensionType>([
    ExtensionType.MintCloseAuthority,
    ExtensionType.MetadataPointer,
    ExtensionType.TokenMetadata,
    ExtensionType.GroupPointer,
    ExtensionType.TokenGroup,
    ExtensionType.GroupMemberPointer,
    ExtensionType.TokenGroupMember,
  ]);
  for (const extension of getExtensionTypes(mint.tlvData)) {
    if (!allowed.has(extension)) {
      throw new MarketError(
        'UNSUPPORTED_TOKEN_EXTENSION',
        `Extension Token-2022 non supportée: ${ExtensionType[extension]}.`,
      );
    }
  }
  return mint;
}

function decodedAddress(
  action: DecodedPumpSwapPoolCreation['action'],
  name: string,
): string {
  const value = action.accounts[name];
  if (value === undefined) mismatch(name);
  return value;
}

function equalEventText(
  creation: DecodedPumpSwapPoolCreation,
  name: string,
  expected: string,
): void {
  if (eventValue(creation, name) !== expected) mismatch(`event ${name}`);
}

function equalEventBigint(
  creation: DecodedPumpSwapPoolCreation,
  name: string,
  expected: bigint,
): void {
  if (eventValue(creation, name) !== expected) mismatch(`event ${name}`);
}

function eventValue(
  creation: DecodedPumpSwapPoolCreation,
  name: string,
): PumpSwapIdlValue | undefined {
  return creation.event.fields[name];
}

function tokenProgram(kind: TokenProgramKind): PublicKey {
  return kind === 'TOKEN_2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

function programKind(address: string): TokenProgramKind {
  if (address === TOKEN_PROGRAM_ID.toBase58()) return 'SPL_TOKEN';
  if (address === TOKEN_2022_PROGRAM_ID.toBase58()) return 'TOKEN_2022';
  mismatch('token program');
}

function safeLamports(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    mismatch('mint lamports');
  }
  return Number(value);
}

function mismatch(field: string): never {
  throw new MarketError(
    'MARKET_POOL_MISMATCH',
    `Preuve de pool PumpSwap contradictoire: ${field}.`,
  );
}
