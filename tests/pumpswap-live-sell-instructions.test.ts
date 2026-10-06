import assert from 'node:assert/strict';
import test from 'node:test';
import BN from 'bn.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction, type AccountInfo } from '@solana/web3.js';
import type { CanonicalMarketPool, MarketQuote } from '../src/domain/market.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { PUMPSWAP_ACCOUNTS, PUMPSWAP_INSTRUCTIONS } from '../src/markets/pumpswap/generated/pumpswap-idl.js';
import { coinCreatorVaultAuthorityPda, coinCreatorVaultAtaPda, poolPda } from '../src/markets/pumpswap/official-sdk.js';
import { createPumpSwapSellInstructions } from '../src/live/pumpswap-sell-instructions.js';
import { KeypairLiveSigner } from '../src/live/keypair-live-signer.js';
import { LiveTransactionExecutor } from '../src/live/live-transaction-executor.js';

void test('PumpSwap SELL builder uses SDK instruction and preserves integer amount/minimum', async () => {
  const pool = canonicalPool();
  const quote = marketQuote(pool);
  const instructions = await createPumpSwapSellInstructions({
    pool,
    poolAccountInfo: account(pool.address, PUMPSWAP_PROGRAM_ID, poolData(pool,-2_000_000n, 300)),
    globalConfig: globalConfig(),
    feeConfig: null,
    baseMintAccount: {},
    baseAmountRaw: 123_456_789n,
    poolBaseAmountRaw: 9_000_000_000n,
    poolQuoteAmountRaw: 5_000_000_000n,
    user: key(10),
    userBaseTokenAccount: key(11),
    userQuoteTokenAccount: key(12),
    userBaseAccountInfo: account(key(11).toBase58(), TOKEN_PROGRAM_ID.toBase58(), Buffer.alloc(165)),
    userQuoteAccountInfo: account(key(12).toBase58(), TOKEN_PROGRAM_ID.toBase58(), Buffer.alloc(165)),
    quote,
    slippageBps: 75n,
  });
  const ix = instructions.find((instruction) => instruction.programId.toBase58() === PUMPSWAP_PROGRAM_ID);
  assert.ok(ix);
  assert.deepEqual([...ix.data.subarray(0, 8)], PUMPSWAP_INSTRUCTIONS.sell.discriminator);
  assert.equal(ix.data.readBigUInt64LE(8), 123_456_789n);
  assert.equal(ix.data.readBigUInt64LE(16), 987_654n);
  assert.equal(ix.keys[0]?.pubkey.toBase58(), pool.address);
  assert.equal(ix.keys[1]?.pubkey.toBase58(), key(10).toBase58());
});

void test('PumpSwap SELL builder rejects a quote for a different pool or mint', async () => {
  const pool = canonicalPool();
  await assert.rejects(createPumpSwapSellInstructions({
    pool,
    poolAccountInfo: account(pool.address, PUMPSWAP_PROGRAM_ID, poolData(pool,0n, 300)),
    globalConfig: globalConfig(), feeConfig: null, baseMintAccount: {}, baseAmountRaw: 123_456_789n,
    poolBaseAmountRaw: 9_000_000_000n, poolQuoteAmountRaw: 5_000_000_000n,
    user: key(10), userBaseTokenAccount: key(11), userQuoteTokenAccount: key(12),
    userBaseAccountInfo: account(key(11).toBase58(), TOKEN_PROGRAM_ID.toBase58(), Buffer.alloc(165)),
    userQuoteAccountInfo: account(key(12).toBase58(), TOKEN_PROGRAM_ID.toBase58(), Buffer.alloc(165)),
    quote: { ...marketQuote(pool), pool: key(29).toBase58() }, slippageBps: 75n,
  }), /inconsistent/u);
});

void test('PumpSwap SELL builder derives Token-2022 base accounts and emits the matching Program', async () => {
  const pool = canonicalPool('TOKEN_2022');
  const owner = key(10);
  const baseProgram = TOKEN_2022_PROGRAM_ID;
  const userBase = getAssociatedTokenAddressSync(new PublicKey(pool.baseMint), owner, false, baseProgram);
  const instructions = await createPumpSwapSellInstructions({
    pool, poolAccountInfo: account(pool.address, PUMPSWAP_PROGRAM_ID, poolData(pool,0n,300)),
    globalConfig: globalConfig(), feeConfig: null, baseMintAccount: {}, baseAmountRaw: 123_456_789n,
    poolBaseAmountRaw: 9_000_000_000n, poolQuoteAmountRaw: 5_000_000_000n,
    user: owner, userBaseTokenAccount: userBase, userQuoteTokenAccount: key(12),
    userBaseAccountInfo: account(userBase.toBase58(), baseProgram.toBase58(), Buffer.alloc(170)),
    userQuoteAccountInfo: account(key(12).toBase58(), TOKEN_PROGRAM_ID.toBase58(), Buffer.alloc(165)),
    quote: marketQuote(pool), slippageBps: 75n,
  });
  const sell = instructions.find((instruction) => instruction.programId.toBase58() === PUMPSWAP_PROGRAM_ID);
  assert.equal(sell?.keys[11]?.pubkey.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(sell?.keys[5]?.pubkey.toBase58(), userBase.toBase58());
});

void test('PumpSwap SELL passes through the shared executor priority-fee guard before signing', async () => {
  const pool = canonicalPool();
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(40));
  const amount = 123_456_789n;
  const quote = marketQuote(pool);
  const userBase = getAssociatedTokenAddressSync(new PublicKey(pool.baseMint), wallet.publicKey);
  const userQuote = getAssociatedTokenAddressSync(new PublicKey(pool.quoteAsset.mint), wallet.publicKey);
  const config = globalConfig();
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
    ...await createPumpSwapSellInstructions({
      pool, poolAccountInfo: account(pool.address, PUMPSWAP_PROGRAM_ID, poolData(pool, -2_000_000n, 300)),
      globalConfig: config, feeConfig: null, baseMintAccount: {}, baseAmountRaw: amount,
      poolBaseAmountRaw: 9_000_000_000n, poolQuoteAmountRaw: 5_000_000_000n,
      user: wallet.publicKey, userBaseTokenAccount: userBase, userQuoteTokenAccount: userQuote,
      userBaseAccountInfo: account(userBase.toBase58(), TOKEN_PROGRAM_ID.toBase58(), Buffer.alloc(165)),
      userQuoteAccountInfo: account(userQuote.toBase58(), TOKEN_PROGRAM_ID.toBase58(), Buffer.alloc(165)),
      quote, slippageBps: quote.slippageBps,
    }),
  ];
  const coinCreator = key(8);
  const buybackRecipient = config.buybackFeeRecipients[0];
  assert.ok(buybackRecipient);
  const intent = {
    mint: pool.baseMint, market: 'pumpswap', poolAddress: pool.address, quoteMint: pool.quoteAsset.mint,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), poolCoinCreator: coinCreator.toBase58(),
    poolBaseVault: pool.baseVault, poolQuoteVault: pool.quoteVault, cashback: false,
    buybackFeeRecipient: buybackRecipient.toBase58(),
    buybackFeeRecipientTokenAccount: getAssociatedTokenAddressSync(new PublicKey(pool.quoteAsset.mint), buybackRecipient, true).toBase58(),
  };
  const allowedAccounts = new Set([wallet.publicKey.toBase58(), ...instructions.flatMap((instruction) => [
    instruction.programId.toBase58(), ...instruction.keys.map((keyMeta) => keyMeta.pubkey.toBase58()),
  ])]);
  const rpc = new ExecutorRpc(wallet.publicKey.toBase58(), pool.baseMint, amount);
  const executor = new LiveTransactionExecutor(rpc, new ExecutorJournal(), new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 1n, exitReserveLamports: 1n,
  });
  const result = await executor.execute({
    order: { orderId: 'pumpswap-sell', wallet: wallet.publicKey.toBase58(), positionId: 'position-1', side: 'SELL', intent, validity: {} },
    instructions, allowedAccounts, maxSpendRaw: 0n, maxTokenAmountRaw: amount, positionRemainingRaw: amount,
  });
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(rpc.sent.length, 1);
  assert.equal(rpc.sent[0]?.signature, result.signature);
  assert.equal(coinCreatorVaultAuthorityPda(coinCreator).toBase58(), instructions.find((ix) => ix.programId.toBase58() === PUMPSWAP_PROGRAM_ID)?.keys[18]?.pubkey.toBase58());
  assert.equal(coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(coinCreator), new PublicKey(pool.quoteAsset.mint), TOKEN_PROGRAM_ID).toBase58(),
    instructions.find((ix) => ix.programId.toBase58() === PUMPSWAP_PROGRAM_ID)?.keys[17]?.pubkey.toBase58());
});

class ExecutorRpc {
  public readonly sent: { signature: string; bytes: Uint8Array }[] = [];
  private signature = '';
  public constructor(private readonly wallet: string, private readonly mint: string, private readonly amount: bigint) {}
  public async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 };
  }
  public async getWalletBalance() { return { lamports: 1_000_000_000n, contextSlot: 20n, observedAtMs: Date.now() }; }
  public async getMessageFee() { return { lamports: 5_000n, contextSlot: 20n, observedAtMs: Date.now() }; }
  public async getTokenAccountRentExemption(): Promise<bigint | null> { return 2_000_000n; }
  public async sendRawTransaction(bytes: Uint8Array): Promise<string> {
    const transaction = VersionedTransaction.deserialize(bytes);
    const signature = transaction.signatures[0];
    assert.ok(signature);
    this.signature = bs58.encode(signature);
    this.sent.push({ signature: this.signature, bytes: Uint8Array.from(bytes) });
    return this.signature;
  }
  public async getSignatureStatus(signature: string): Promise<{ confirmationStatus: 'confirmed'; err: null }> {
    assert.equal(signature, this.signature);
    return { confirmationStatus: 'confirmed', err: null };
  }
  public async getTransaction(signature: string) {
    assert.equal(signature, this.signature);
    return { slot: 20, meta: { err: null, fee: 5_000, preTokenBalances: [
      { owner: this.wallet, mint: this.mint, uiTokenAmount: { amount: this.amount.toString() } },
    ], postTokenBalances: [{ owner: this.wallet, mint: this.mint, uiTokenAmount: { amount: '0' } }] } };
  }
  public async getBlockHeight(): Promise<number> { return 1; }
}

class ExecutorJournal {
  public async prepare(): Promise<void> {}
  public async persistSigned(): Promise<void> {}
  public async markSubmitted(): Promise<void> {}
  public async markUnknown(): Promise<void> {}
  public async resolve(): Promise<void> {}
}

function canonicalPool(baseTokenProgram: 'SPL_TOKEN'|'TOKEN_2022' = 'SPL_TOKEN'): CanonicalMarketPool {
  const creator=key(4);const baseMint=key(2);const quoteMint=key(3);
  const baseProgram=baseTokenProgram==='TOKEN_2022'?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
  return {
    address: poolPda(0,creator,baseMint,quoteMint).toBase58(), market: 'pumpswap', programId: PUMPSWAP_PROGRAM_ID,
    baseMint: baseMint.toBase58(), quoteAsset: { mint: quoteMint.toBase58(), decimals: 9, tokenProgram: 'SPL_TOKEN' },
    index: 0, creator: creator.toBase58(),
    baseVault: getAssociatedTokenAddressSync(baseMint,poolPda(0,creator,baseMint,quoteMint),true,baseProgram).toBase58(),
    quoteVault: getAssociatedTokenAddressSync(quoteMint,poolPda(0,creator,baseMint,quoteMint),true).toBase58(),
    lpMint: key(7).toBase58(), baseTokenProgram, activatedAt: {
      slot: 1n, transactionIndex: 0, instructionIndex: 0, innerInstructionIndex: null,
    }, confirmationStatus: 'confirmed',
  };
}

function marketQuote(pool: CanonicalMarketPool): MarketQuote {
  return {
    id: 'quote', pool: pool.address, inputMint: pool.baseMint, outputMint: pool.quoteAsset.mint,
    amountInRaw: 123_456_789n, amountOutRaw: 1_000_000n, minimumAmountOutRaw: 987_654n,
    feesRaw: 0n, slippageBps: 75n, priceImpactBps: 1n, observedAtMs: 1_000,
    observedSlot: 10n, stateReceivedAtMs: 1_000,
  };
}

function poolData(pool:CanonicalMarketPool,virtualQuoteReservesRaw: bigint, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  Buffer.from(PUMPSWAP_ACCOUNTS.Pool.discriminator).copy(buffer, 0);
  let offset = 8;
  const write = (bytes: Uint8Array): void => { Buffer.from(bytes).copy(buffer, offset); offset += bytes.length; };
  write(Uint8Array.from([1])); write(Uint8Array.from([0, 0]));
  for (const value of [new PublicKey(pool.creator), new PublicKey(pool.baseMint), new PublicKey(pool.quoteAsset.mint), new PublicKey(pool.lpMint), new PublicKey(pool.baseVault), new PublicKey(pool.quoteVault)]) write(value.toBytes());
  write(Uint8Array.from(le(8, 1n))); write(key(8).toBytes()); write(Uint8Array.from([0, 0]));
  write(Uint8Array.from(le(16, virtualQuoteReservesRaw)));
  return buffer;
}

function account(_address: string, owner: string, data: Buffer): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 1, owner: new PublicKey(owner), rentEpoch: 0 };
}
function globalConfig() {
  return {
    admin: key(20), lpFeeBasisPoints: new BN(20), protocolFeeBasisPoints: new BN(5),
    disableFlags: 0, protocolFeeRecipients: [key(21)], coinCreatorFeeBasisPoints: new BN(0),
    adminSetCoinCreatorAuthority: key(22), whitelistPda: key(23), reservedFeeRecipient: key(24),
    mayhemModeEnabled: false, reservedFeeRecipients: [key(25)], buybackFeeRecipients: [key(26)],
    buybackBasisPoints: new BN(0), boostAuthority: key(27), boostEnabled: false,
  };
}
function key(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => seed + i));
}
function le(width: number, input: bigint): number[] {
  let value = input < 0n ? (1n << BigInt(width * 8)) + input : input;
  return Array.from({ length: width }, () => { const b = Number(value & 255n); value >>= 8n; return b; });
}
