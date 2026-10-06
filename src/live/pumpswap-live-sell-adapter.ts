import {
  AccountLayout, ExtensionType, getAssociatedTokenAddressSync, MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import type { CanonicalMarketPool, MarketQuote, MarketReserves } from '../domain/market.js';
import type { MarketRpcReader, ReadonlyAccountSnapshot } from '../ports/market-rpc-reader.js';
import { createPumpSwapQuote } from '../markets/pumpswap/pumpswap-quote.provider.js';
import { decodePumpSwapFeeState } from '../markets/pumpswap/pumpswap-fee-state.js';
import { PUMP_AMM_FEE_CONFIG_PDA, GLOBAL_CONFIG_PDA, PUMP_AMM_SDK, userVolumeAccumulatorPda } from '../markets/pumpswap/official-sdk.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import { PUMPSWAP_INSTRUCTIONS } from '../markets/pumpswap/generated/pumpswap-idl.js';
import { decodePumpSwapPoolAccount } from '../markets/pumpswap/pool-account-decoder.js';
import { createPumpSwapSellInstructions } from './pumpswap-sell-instructions.js';
import type { PumpSwapSellInstructionState } from './pumpswap-sell-instructions.js';
import { sellBaseInput } from '../markets/pumpswap/official-sdk.js';
import BN from 'bn.js';
import { validateSupportedPumpSwapMint } from '../markets/pumpswap/pool-validator.js';

export interface PumpSwapLiveSellPlan {
  readonly pool: CanonicalMarketPool;
  readonly cashback: boolean;
  readonly coinCreator: string;
  readonly quote: MarketQuote;
  readonly instructions: Awaited<ReturnType<typeof createPumpSwapSellInstructions>>;
  readonly buybackFeeRecipient: string;
  readonly buybackFeeRecipientTokenAccount: string;
}

/** Reads one coherent account context and builds a sell only for a persisted canonical pool. */
export class PumpSwapLiveSellAdapter {
  public constructor(
    private readonly rpc: MarketRpcReader,
    private readonly now: () => number = Date.now,
  ) {}

  public async plan(input: {
    readonly pool: CanonicalMarketPool;
    readonly user: PublicKey;
    readonly amountInRaw: bigint;
    readonly slippageBps: bigint;
  }): Promise<PumpSwapLiveSellPlan> {
    const { pool, user } = input;
    if (pool.market !== 'pumpswap' || pool.programId !== PUMPSWAP_PROGRAM_ID
      || pool.index !== 0
      || pool.quoteAsset.tokenProgram !== 'SPL_TOKEN') {
      throw new Error('PumpSwap live path supports only canonical SPL or Token-2022 base with legacy SPL quote.');
    }
    const baseTokenProgram = pool.baseTokenProgram === 'TOKEN_2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const quoteTokenProgram = TOKEN_PROGRAM_ID;
    const userBase = getAssociatedTokenAddressSync(new PublicKey(pool.baseMint), user, false, baseTokenProgram);
    const userQuote = getAssociatedTokenAddressSync(new PublicKey(pool.quoteAsset.mint), user, false, quoteTokenProgram);
    const userVolumeAccumulator=userVolumeAccumulatorPda(user);
    const userVolumeAccumulatorWsolAta=getAssociatedTokenAddressSync(new PublicKey(pool.quoteAsset.mint),userVolumeAccumulator,true,quoteTokenProgram);
    const addresses = [pool.address, pool.baseVault, pool.quoteVault, GLOBAL_CONFIG_PDA.toBase58(),
      PUMP_AMM_FEE_CONFIG_PDA.toBase58(), pool.baseMint, userBase.toBase58(), userQuote.toBase58(),
      userVolumeAccumulator.toBase58(),userVolumeAccumulatorWsolAta.toBase58()];
    const accounts = await this.rpc.readAccountsAtSameSlot(addresses);
    if (accounts.length !== addresses.length) throw new Error('PumpSwap sell state response has the wrong account count.');
    const receivedAt = this.now();
    const [poolAccount, baseVault, quoteVault, globalAccount, feeAccount, mintAccount, userBaseAccount, userQuoteAccount,
      userVolumeAccumulatorAccount,userVolumeAccumulatorWsolAccount] = accounts;
    const required = (value: ReadonlyAccountSnapshot | null | undefined, address: string): ReadonlyAccountSnapshot => {
      if (value?.address !== address) throw new Error(`PumpSwap SELL required account missing: ${address}.`);
      return value;
    };
    const poolSnapshot = required(poolAccount, pool.address);
    const baseVaultSnapshot = required(baseVault, pool.baseVault);
    const quoteVaultSnapshot = required(quoteVault, pool.quoteVault);
    const globalSnapshot = required(globalAccount, GLOBAL_CONFIG_PDA.toBase58());
    const mintSnapshot = required(mintAccount, pool.baseMint);
    const userBaseSnapshot = required(userBaseAccount, userBase.toBase58());
    if ([...accounts].some((account) => account !== null && account.slot !== poolSnapshot.slot)) {
      throw new Error('PumpSwap SELL state is not from one RPC slot.');
    }
    const decodedPool = decodePumpSwapPoolAccount(poolSnapshot);
    if (poolSnapshot.owner !== PUMPSWAP_PROGRAM_ID || decodedPool.index !== 0
      || decodedPool.creator !== pool.creator || decodedPool.baseMint !== pool.baseMint
      || decodedPool.quoteMint !== pool.quoteAsset.mint || decodedPool.baseVault !== pool.baseVault
      || decodedPool.quoteVault !== pool.quoteVault) {
      throw new Error('PumpSwap on-chain pool contradicts the persisted canonical pool.');
    }
    if(userVolumeAccumulatorAccount!==null&&userVolumeAccumulatorAccount!==undefined
      &&userVolumeAccumulatorAccount.owner!==PUMPSWAP_PROGRAM_ID){
      throw new Error('PumpSwap cashback accumulator has an unexpected owner.');
    }
    if(userVolumeAccumulatorWsolAccount!==null&&userVolumeAccumulatorWsolAccount!==undefined){
      const cashbackAccount=AccountLayout.decode(Buffer.from(userVolumeAccumulatorWsolAccount.data));
      if(userVolumeAccumulatorWsolAccount.owner!==quoteTokenProgram.toBase58()
        ||new PublicKey(cashbackAccount.mint).toBase58()!==pool.quoteAsset.mint
        ||new PublicKey(cashbackAccount.owner).toBase58()!==userVolumeAccumulator.toBase58()){
        throw new Error('PumpSwap cashback WSOL account has an unexpected owner or mint.');
      }
    }
    const base = readVault(baseVaultSnapshot, pool.baseMint, baseTokenProgram, pool.address);
    const quote = readVault(quoteVaultSnapshot, pool.quoteAsset.mint, quoteTokenProgram, pool.address);
    const effectiveQuote = quote.amount + decodedPool.virtualQuoteReservesRaw;
    if (effectiveQuote <= 0n || effectiveQuote > 18_446_744_073_709_551_615n) {
      throw new Error('PumpSwap effective quote reserves are outside u64 bounds.');
    }
    const userBaseDecoded = AccountLayout.decode(Buffer.from(userBaseSnapshot.data));
    if (new PublicKey(userBaseDecoded.mint).toBase58() !== pool.baseMint
      || new PublicKey(userBaseDecoded.owner).toBase58() !== user.toBase58()
      || userBaseDecoded.amount < input.amountInRaw) {
      throw new Error('PumpSwap SELL quantity is not held in the expected user ATA.');
    }
    const userQuoteSnapshot = userQuoteAccount === null ? null : required(userQuoteAccount, userQuote.toBase58());
    if (userQuoteSnapshot !== null) {
      const userQuoteDecoded = AccountLayout.decode(Buffer.from(userQuoteSnapshot.data));
      if (new PublicKey(userQuoteDecoded.mint).toBase58() !== pool.quoteAsset.mint
        || new PublicKey(userQuoteDecoded.owner).toBase58() !== user.toBase58()) {
        throw new Error('PumpSwap quote ATA has an unexpected mint or authority.');
      }
    }
    const feeState = decodePumpSwapFeeState([globalSnapshot, feeAccount ?? null, mintSnapshot, poolSnapshot], pool);
    if (feeState.observedSlot !== poolSnapshot.slot) throw new Error('PumpSwap fee state slot mismatch.');
    const reserves: MarketReserves = Object.freeze({
      pool: pool.address, baseReservesRaw: base.amount, quoteVaultAmountRaw: quote.amount,
      virtualQuoteReservesRaw: decodedPool.virtualQuoteReservesRaw,
      effectiveQuoteReservesRaw: effectiveQuote, observedSlot: poolSnapshot.slot,
      observedAtMs: receivedAt, stateReceivedAtMs: receivedAt,
    });
    const quoteResult = createPumpSwapQuote({
      pool, reserves, inputMint: pool.baseMint, amountInRaw: input.amountInRaw,
      slippageBps: input.slippageBps,
    }, { ...feeState, stateReceivedAtMs: receivedAt }, receivedAt);
    const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(toAccountInfo(globalSnapshot));
    const feeSnapshot = feeAccount ?? null;
    const feeConfig = feeSnapshot === null ? null : PUMP_AMM_SDK.decodeFeeConfig(toAccountInfo(feeSnapshot));
    const mintProgram = baseTokenProgram;
    if(mintSnapshot.owner!==mintProgram.toBase58())throw new Error('PumpSwap mint is owned by an unsupported token program.');
    validateSupportedPumpSwapMint(mintSnapshot,pool.baseMint,pool.baseTokenProgram,
      new Set([ExtensionType.MetadataPointer,ExtensionType.TokenMetadata]));
    const mintValue = MintLayout.decode(Buffer.from(mintSnapshot.data));
    const officialQuote=sellBaseInput({
      base:new BN(input.amountInRaw.toString()),slippage:Number(input.slippageBps)/100,
      baseReserve:new BN(base.amount.toString()),quoteReserve:new BN(quote.amount.toString()),
      virtualQuoteReserves:new BN(decodedPool.virtualQuoteReservesRaw.toString()),
      globalConfig,baseMintAccount:mintValue,baseMint:new PublicKey(pool.baseMint),
      coinCreator:new PublicKey(decodedPool.coinCreator),creator:new PublicKey(decodedPool.creator),feeConfig,
    });
    if(BigInt(officialQuote.uiQuote.toString())!==quoteResult.amountOutRaw
      ||BigInt(officialQuote.minQuote.toString())!==quoteResult.minimumAmountOutRaw){
      throw new Error('PumpSwap quote disagrees with the pinned SDK fee and slippage calculation.');
    }
    const instructionInput: PumpSwapSellInstructionState = {
      pool, poolAccountInfo: toAccountInfo(poolSnapshot), globalConfig, feeConfig,
      baseMintAccount: mintValue, baseAmountRaw: input.amountInRaw,
      poolBaseAmountRaw: base.amount, poolQuoteAmountRaw: quote.amount,
      user, userBaseTokenAccount: userBase, userQuoteTokenAccount: userQuote,
      userBaseAccountInfo: toAccountInfo(userBaseSnapshot),
      userQuoteAccountInfo: userQuoteSnapshot === null ? null : toAccountInfo(userQuoteSnapshot),
      quote: quoteResult, slippageBps: input.slippageBps,
    };
    const instructions = await createPumpSwapSellInstructions(instructionInput);
    const sellInstruction=instructions.find((instruction)=>instruction.programId.toBase58()===PUMPSWAP_PROGRAM_ID
      &&instruction.data.subarray(0,8).equals(Buffer.from(PUMPSWAP_INSTRUCTIONS.sell.discriminator)));
    if(sellInstruction===undefined)throw new Error('Pinned PumpSwap SDK did not produce its expected SELL instruction.');
    if(decodedPool.isCashbackCoin){
      const cashbackIndex=PUMPSWAP_INSTRUCTIONS.sell.accounts.length;
      const accumulatorAta=sellInstruction.keys[cashbackIndex];
      const accumulator=sellInstruction.keys[cashbackIndex+1];
      if(accumulatorAta?.pubkey.toBase58()!==userVolumeAccumulatorWsolAta.toBase58()||!accumulatorAta.isWritable
        ||accumulatorAta.isSigner||accumulator?.pubkey.toBase58()!==userVolumeAccumulator.toBase58()
        ||!accumulator.isWritable||accumulator.isSigner){
        throw new Error('Pinned PumpSwap cashback SELL remaining accounts do not match the official SDK derivations and order.');
      }
    }
    const buybackIndex=21+(new PublicKey(decodedPool.coinCreator).equals(PublicKey.default)?0:1)+(decodedPool.isCashbackCoin?2:0);
    const buybackRecipient=sellInstruction.keys[buybackIndex]?.pubkey;
    const buybackRecipientTokenAccount=sellInstruction.keys[buybackIndex+1]?.pubkey;
    const validRecipients=globalConfig.buybackFeeRecipients;
    if(buybackRecipient===undefined||buybackRecipientTokenAccount===undefined
      ||!validRecipients.some((recipient)=>recipient.equals(buybackRecipient))
      ||!getAssociatedTokenAddressSync(new PublicKey(pool.quoteAsset.mint),buybackRecipient,true,quoteTokenProgram).equals(buybackRecipientTokenAccount)){
      throw new Error('PumpSwap SELL buyback accounts do not match decoded GlobalConfig.');
    }
    return Object.freeze({ pool, cashback:decodedPool.isCashbackCoin, coinCreator:decodedPool.coinCreator, quote: quoteResult, instructions,
      buybackFeeRecipient:buybackRecipient.toBase58(),buybackFeeRecipientTokenAccount:buybackRecipientTokenAccount.toBase58() });
  }
}

function readVault(account: ReadonlyAccountSnapshot, mint: string, program: PublicKey, authority: string): { amount: bigint } {
  if (account.owner !== program.toBase58() || account.data.length < AccountLayout.span) {
    throw new Error('PumpSwap vault owner or layout is invalid.');
  }
  const decoded = AccountLayout.decode(Buffer.from(account.data));
  if (new PublicKey(decoded.mint).toBase58() !== mint
    || new PublicKey(decoded.owner).toBase58() !== authority) throw new Error('PumpSwap vault mint or authority mismatch.');
  return { amount: decoded.amount };
}

function toAccountInfo(account: ReadonlyAccountSnapshot): AccountInfo<Buffer> {
  if (account.lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PumpSwap account lamports exceed SDK precision.');
  return { data: Buffer.from(account.data), executable: false, lamports: Number(account.lamports),
    owner: new PublicKey(account.owner), rentEpoch: 0 };
}
