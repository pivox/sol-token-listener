import BN from 'bn.js';
import { PublicKey, type AccountInfo, type TransactionInstruction } from '@solana/web3.js';
import type { CanonicalMarketPool, MarketQuote } from '../domain/market.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import { decodePumpSwapPoolAccount } from '../markets/pumpswap/pool-account-decoder.js';
import { PUMP_AMM_SDK, poolPda } from '../markets/pumpswap/official-sdk.js';

export interface PumpSwapSellInstructionState {
  readonly pool: CanonicalMarketPool;
  readonly poolAccountInfo: AccountInfo<Buffer>;
  readonly globalConfig: unknown;
  readonly feeConfig: unknown;
  readonly baseMintAccount: unknown;
  readonly baseAmountRaw: bigint;
  readonly poolBaseAmountRaw: bigint;
  readonly poolQuoteAmountRaw: bigint;
  readonly user: PublicKey;
  readonly userBaseTokenAccount: PublicKey;
  readonly userQuoteTokenAccount: PublicKey;
  readonly userBaseAccountInfo: AccountInfo<Buffer>;
  readonly userQuoteAccountInfo: AccountInfo<Buffer> | null;
  readonly quote: MarketQuote;
  readonly slippageBps: bigint;
}

/** Builds only PumpSwap `sell(base input)` instructions from a coherent, checked state. */
export async function createPumpSwapSellInstructions(
  input: PumpSwapSellInstructionState,
): Promise<readonly TransactionInstruction[]> {
  const { pool, quote } = input;
  if (pool.market !== 'pumpswap' || pool.programId !== PUMPSWAP_PROGRAM_ID
    || pool.index !== 0
    || pool.quoteAsset.tokenProgram !== 'SPL_TOKEN') {
    throw new Error('Live PumpSwap supports only canonical index-0 SPL or Token-2022 base with legacy SPL quote.');
  }
  if (pool.baseMint !== quote.inputMint || pool.quoteAsset.mint !== quote.outputMint
    || quote.pool !== pool.address || quote.amountInRaw !== input.baseAmountRaw
    || quote.minimumAmountOutRaw <= 0n || quote.slippageBps !== input.slippageBps
    || input.baseAmountRaw <= 0n || input.poolBaseAmountRaw <= 0n
    || input.poolQuoteAmountRaw <= 0n || input.slippageBps < 0n
    || input.slippageBps > 10_000n) {
    throw new Error('PumpSwap SELL quote and state are inconsistent.');
  }
  if (input.poolAccountInfo.owner.toBase58() !== PUMPSWAP_PROGRAM_ID
    || input.poolAccountInfo.data.length < 8) {
    throw new Error('PumpSwap pool account is absent or owned by another program.');
  }
  const decoded = decodePumpSwapPoolAccount({
    address: pool.address,
    owner: input.poolAccountInfo.owner.toBase58(),
    data: input.poolAccountInfo.data,
    lamports: BigInt(input.poolAccountInfo.lamports),
    slot: quote.observedSlot,
  });
  if (decoded.index !== 0 || decoded.baseMint !== pool.baseMint
    || decoded.quoteMint !== pool.quoteAsset.mint || decoded.creator !== pool.creator
    || decoded.baseVault !== pool.baseVault || decoded.quoteVault !== pool.quoteVault) {
    throw new Error('PumpSwap pool account does not match the canonical route.');
  }
  if (poolPda(0,new PublicKey(decoded.creator),new PublicKey(decoded.baseMint),new PublicKey(decoded.quoteMint)).toBase58()!==pool.address){
    throw new Error('PumpSwap pool address is not the canonical index-0 PDA.');
  }
  const baseProgram = pool.baseTokenProgram === 'TOKEN_2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  if (getAssociatedTokenAddressSync(new PublicKey(pool.baseMint),new PublicKey(pool.address),true,baseProgram).toBase58()!==pool.baseVault
    ||getAssociatedTokenAddressSync(new PublicKey(pool.quoteAsset.mint),new PublicKey(pool.address),true,TOKEN_PROGRAM_ID).toBase58()!==pool.quoteVault){
    throw new Error('PumpSwap vault addresses are not the canonical pool ATAs.');
  }
  const quoteProgram = TOKEN_PROGRAM_ID;
  if (baseProgram.toBase58() !== input.userBaseAccountInfo.owner.toBase58()
    || (input.userQuoteAccountInfo !== null
      && input.userQuoteAccountInfo.owner.toBase58() !== quoteProgram.toBase58())) {
    throw new Error('PumpSwap user token account owner is inconsistent.');
  }

  // The SDK Pool shape uses BN for i128; construct from the signed decimal
  // string so negative virtual reserves keep their sign and never pass through Number.
  const sdkPool = {
    poolBump: decoded.poolBump,
    index: decoded.index,
    creator: new PublicKey(decoded.creator),
    baseMint: new PublicKey(decoded.baseMint),
    quoteMint: new PublicKey(decoded.quoteMint),
    lpMint: new PublicKey(decoded.lpMint),
    poolBaseTokenAccount: new PublicKey(decoded.baseVault),
    poolQuoteTokenAccount: new PublicKey(decoded.quoteVault),
    lpSupply: new BN(decoded.lpSupplyRaw.toString()),
    coinCreator: new PublicKey(decoded.coinCreator),
    isMayhemMode: decoded.isMayhemMode,
    isCashbackCoin: decoded.isCashbackCoin,
    virtualQuoteReserves: new BN(decoded.virtualQuoteReservesRaw.toString()),
  };
  const sdkState = {
    globalConfig: input.globalConfig,
    feeConfig: input.feeConfig,
    poolKey: new PublicKey(pool.address),
    poolAccountInfo: input.poolAccountInfo,
    pool: sdkPool,
    poolBaseAmount: new BN(input.poolBaseAmountRaw.toString()),
    poolQuoteAmount: new BN(input.poolQuoteAmountRaw.toString()),
    baseTokenProgram: baseProgram,
    quoteTokenProgram: quoteProgram,
    baseMint: new PublicKey(pool.baseMint),
    baseMintAccount: input.baseMintAccount,
    user: input.user,
    userBaseTokenAccount: input.userBaseTokenAccount,
    userQuoteTokenAccount: input.userQuoteTokenAccount,
    userBaseAccountInfo: input.userBaseAccountInfo,
    userQuoteAccountInfo: input.userQuoteAccountInfo,
  } as Parameters<typeof PUMP_AMM_SDK.sellInstructions>[0];
  const instructions = await PUMP_AMM_SDK.sellInstructions(
    sdkState,
    new BN(input.baseAmountRaw.toString()),
    new BN(quote.minimumAmountOutRaw.toString()),
  );
  if (instructions.filter((instruction) => instruction.programId.toBase58() === PUMPSWAP_PROGRAM_ID).length !== 1) {
    throw new Error('PumpSwap SDK did not produce exactly one SELL instruction.');
  }
  return Object.freeze(instructions);
}
