import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import bs58 from 'bs58';
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, StakeProgram, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { AccountInfo, Connection, VersionedTransactionResponse } from '@solana/web3.js';
import { SolanaJitoGateway, MAINNET_GENESIS_HASH } from '../src/jitosol/rpc-gateway.js';
import { JITOSOL_MINT, SOL_MINT } from '../src/jitosol/jupiter.js';
import type { JupiterClient, JupiterQuote, JupiterSwapInstructions } from '../src/jitosol/jupiter.js';
import { parseJitoBotConfig } from '../src/jitosol/config.js';
import { JitoBotEngine } from '../src/jitosol/engine.js';
import { FileJournal, readJournal } from '../src/jitosol/journal.js';
import { decodeJitoStakePool, deriveStakeDestination, deriveValidatorStakeAddress, JITO_POOL_ADDRESS, quoteStakeWithdrawal, STAKE_POOL_PROGRAM_ID } from '../src/jitosol/stake-pool.js';
import type { Observation, PendingTransaction, Position } from '../src/jitosol/types.js';

// Deterministic, unfunded test-only key; never used by a real RPC or wallet loader.
const pair = Keypair.fromSeed(Buffer.alloc(32, 73));
const wallet = pair.publicKey;
const jitoAta = getAssociatedTokenAddressSync(JITOSOL_MINT, wallet);
const solAta = getAssociatedTokenAddressSync(SOL_MINT, wallet);
const stake = new PublicKey(Buffer.alloc(32, 25));
const config = parseJitoBotConfig({ enabled: true, walletAddress: wallet.toBase58() });
const position: Position = { id: 'position-1', stage: 'purchased', openedAtMs: 100,
  inputLamports: '3000000000', actualJitoReceivedUnits: '3020000000', stakeRentLamports: '2282880',
  tokenAccountRentLamports: '2039280', feesLamports: '5000', nonRefundableCostLamports: '0', stakeAddress: stake.toBase58() };
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), pair.secretKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
const signer = { publicKey: wallet.toBase58(), async signMessage(message: Uint8Array) { return { signature: sign(null, message, privateKey) }; }, async close() {} };
const forbidden = (): never => { throw new Error('forbidden port'); };
const jupiter = { getQuote: forbidden, buildSwapInstructions: forbidden } as Pick<JupiterClient, 'getQuote' | 'buildSwapInstructions'>;

function pending(kind: PendingTransaction['kind'] = 'buy'): PendingTransaction {
  const ix = new TransactionInstruction({ programId: SystemProgram.programId, data: Buffer.alloc(0),
    keys: [wallet, jitoAta, solAta, stake].map((pubkey) => ({ pubkey, isSigner: pubkey.equals(wallet), isWritable: true })) });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }).compileToV0Message());
  tx.sign([pair]);
  return { kind, signature: bs58.encode(must(tx.signatures[0])), wireTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    preparedAtMs: 100, lastValidBlockHeight: 200, estimatedFeeLamports: '5000',
    expected: kind === 'buy' ? { minJitoReceivedUnits: '3020000000' } : {
      stakeAddress: stake.toBase58(), ...(kind === 'withdraw' ? { jitoSpentUnits: '3020000000' } : {}),
      ...(kind === 'withdraw' ? { minimumRedemptionLamports: '3016980000' } : {}),
      ...(kind === 'withdraw' || kind === 'claim' ? { refundableRentLamports: '2282880' } : {}),
    } };
}

function receipt(transaction: PendingTransaction): VersionedTransactionResponse {
  const tx = VersionedTransaction.deserialize(Buffer.from(transaction.wireTransactionBase64, 'base64'));
  const accounts = tx.message.staticAccountKeys;
  const index = (key: PublicKey) => accounts.findIndex((a) => a.equals(key));
  const pre = accounts.map(() => 0); const post = [...pre];
  pre[index(wallet)] = 9_000_000_000;
  post[index(wallet)] = 5_997_955_720;
  post[index(jitoAta)] = 2_039_280;
  const token = (amount: string) => ({ accountIndex: index(jitoAta), mint: JITOSOL_MINT.toBase58(), owner: wallet.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount, decimals: 9, uiAmount: null, uiAmountString: '0' } });
  const result: VersionedTransactionResponse = { slot: 110, blockTime: 100, version: 0,
    transaction: { message: tx.message, signatures: [transaction.signature] },
    meta: { err: null, fee: 5000, preBalances: pre, postBalances: post,
      preTokenBalances: [], postTokenBalances: [token('3020000123')], loadedAddresses: { readonly: [], writable: [] } } };
  if (transaction.kind === 'withdraw') {
    pre[index(jitoAta)] = post[index(jitoAta)] = 2_039_280;
    post[index(wallet)] = 9_000_000_000 - 2_282_880 - 5000;
    post[index(stake)] = 3_019_262_880;
    must(result.meta).preTokenBalances = [token('3020000222')];
    must(result.meta).postTokenBalances = [token('222')];
  } else if (transaction.kind === 'claim') {
    pre[index(stake)] = 3_019_262_880; post[index(stake)] = 0;
    post[index(wallet)] = 9_000_000_000 + 3_019_262_880 - 5000;
    must(result.meta).preTokenBalances = []; must(result.meta).postTokenBalances = [];
  } else if (transaction.kind === 'deactivate') {
    pre[index(stake)] = post[index(stake)] = 3_019_262_880;
    post[index(wallet)] = 9_000_000_000 - 5000;
    must(result.meta).preTokenBalances = []; must(result.meta).postTokenBalances = [];
  }
  return result;
}

function gateway(rpc: Partial<Connection> = {}, liveEnabled = false) {
  return new SolanaJitoGateway({ connection: { getGenesisHash: async () => MAINNET_GENESIS_HASH, ...rpc } as Connection, jupiter, walletAddress: wallet.toBase58(), signer, liveEnabled, now: () => 100 });
}

void test('gateway is disabled by default and refuses prepare/broadcast before RPC or signing', async () => {
  const rpc = new Proxy({}, { get: forbidden }) as Connection;
  const noSigner = new Proxy({}, { get: forbidden }) as typeof signer;
  const g = new SolanaJitoGateway({ connection: rpc, jupiter, walletAddress: wallet.toBase58(), signer: noSigner, now: forbidden });
  await assert.rejects(g.prepare({ kind: 'buy', config, position }), /disabled/);
  await assert.rejects(g.broadcast(pending()), /disabled/);
});

void test('live gateway refuses another signer before touching RPC', async () => {
  const g = new SolanaJitoGateway({ connection: new Proxy({}, { get: forbidden }) as Connection, jupiter,
    walletAddress: wallet.toBase58(), signer: { ...signer, publicKey: stake.toBase58() }, liveEnabled: true });
  await assert.rejects(g.prepare({ kind: 'buy', config, position }), /signer/);
  await assert.rejects(g.broadcast(pending()), /signer/);
});

void test('broadcast submits the exact durable bytes without replacing blockhash or signing', async () => {
  const transaction = pending(); let sent = 0; let genesis = 0;
  const g = new SolanaJitoGateway({ connection: { async getGenesisHash() { genesis++; return MAINNET_GENESIS_HASH; },
    async sendRawTransaction(bytes, options) { sent++; assert.deepEqual(Buffer.from(bytes), Buffer.from(transaction.wireTransactionBase64, 'base64'));
      assert.deepEqual(options, { skipPreflight: false, maxRetries: 0, preflightCommitment: 'confirmed' }); return transaction.signature; },
  } as Partial<Connection> as Connection, jupiter, walletAddress: wallet.toBase58(), signer: { ...signer, signMessage: forbidden }, liveEnabled: true });
  await g.broadcast(transaction); await g.broadcast(transaction);
  assert.equal(sent, 2); assert.equal(genesis, 1);
});

void test('broadcast rejects invalid signature, wrong cluster, signature mismatch and oversized wire', async () => {
  const transaction = pending(); let sends = 0;
  const rpc = { async getGenesisHash() { return MAINNET_GENESIS_HASH; }, async sendRawTransaction() { sends++; return stake.toBase58(); } };
  const g = gateway(rpc, true);
  const bytes = Buffer.from(transaction.wireTransactionBase64, 'base64'); bytes[bytes.length - 1] = must(bytes[bytes.length - 1]) ^ 1;
  await assert.rejects(g.broadcast({ ...transaction, wireTransactionBase64: bytes.toString('base64') }), /wire|signature/);
  await assert.rejects(g.broadcast({ ...transaction, signature: bs58.encode(Buffer.alloc(64, 4)) }), /signature/);
  await assert.rejects(g.broadcast({ ...transaction, wireTransactionBase64: Buffer.alloc(1233).toString('base64') }), /wire/);
  assert.equal(sends, 0);
  await assert.rejects(gateway({ ...rpc, async getGenesisHash() { return 'devnet'; } }, true).broadcast(transaction), /cluster/);
  assert.equal(sends, 0);
  await assert.rejects(g.broadcast(transaction), /signature/);
  assert.equal(sends, 1);
});

void test('poll waits for finalized status and an actual finalized receipt', async () => {
  const transaction = pending(); let reads = 0;
  for (const confirmationStatus of ['processed', 'confirmed'] as const) {
    const g = gateway({ async getSignatureStatuses() { return { context: { slot: 100 }, value: [{ slot: 100, confirmations: 1, err: null, confirmationStatus }] }; },
      async getTransaction() { reads++; return receipt(transaction); } } as Partial<Connection>);
    assert.deepEqual(await g.poll(transaction), { status: 'pending' });
  }
  assert.equal(reads, 0);
  const g = gateway({ async getSignatureStatuses(signatures, options) { assert.deepEqual(signatures, [transaction.signature]);
    assert.deepEqual(options, { searchTransactionHistory: true }); return { context: { slot: 110 }, value: [{ slot: 110, confirmations: null, err: null, confirmationStatus: 'finalized' }] }; },
    async getTransaction(_signature, options) { assert.deepEqual(options, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }); return null; } });
  assert.deepEqual(await g.poll(transaction), { status: 'pending' });
});

void test('null signature status only expires after finalized block height exceeds durable expiry', async () => {
  for (const height of [199, 200, 201]) {
    const g = gateway({ async getSignatureStatuses() { return { context: { slot: 110 }, value: [null] }; },
      async getBlockHeight(commitment) { assert.equal(commitment, 'finalized'); return height; } });
    assert.equal((await g.poll(pending())).status, height > 200 ? 'expired' : 'pending');
  }
  const g = gateway({ async getSignatureStatuses() { throw new Error('https://rpc.invalid/?api-key=SECRET'); } });
  await assert.rejects(g.poll(pending()), (error) => error instanceof Error && error.message === 'poll_rpc_unavailable');
});

void test('polling a resumed transaction verifies the cluster before reading signature status', async () => {
  let reads = 0;
  const g = gateway({ getGenesisHash: async () => 'devnet', getSignatureStatuses: async () => { reads++; return { context: { slot: 100 }, value: [null] }; } });
  assert.equal((await g.poll(pending())).status, 'unknown');
  assert.equal(reads, 0);
});

void test('buy receipt derives precise spent SOL, received Jito and new ATA rent from meta', async () => {
  const transaction = pending(); const actual = receipt(transaction);
  const result = await finalizedGateway(actual).poll(transaction);
  assert.deepEqual(result, { status: 'finalized', effects: { feeLamports: '5000', actualInputLamports: '3000000000', actualJitoReceivedUnits: '3020000123', refundableRentLamports: '2039280' } });
});

void test('existing empty WSOL rent refund is excluded from bought SOL accounting', async () => {
  const transaction = pending(); const actual = receipt(transaction);
  const i = actual.transaction.message.staticAccountKeys.findIndex((a) => a.equals(solAta));
  must(actual.meta).preBalances[i] = 2_039_280;
  must(actual.meta).postBalances[0] = must(must(actual.meta).postBalances[0]) + 2_039_280;
  must(must(actual.meta).preTokenBalances).push({ accountIndex: i, mint: SOL_MINT.toBase58(), owner: wallet.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(),
    uiTokenAmount: { amount: '0', decimals: 9, uiAmount: 0, uiAmountString: '0' } });
  const result = await finalizedGateway(actual).poll(transaction);
  assert.equal(result.status, 'finalized');
  if (result.status === 'finalized') assert.equal(result.effects.actualInputLamports, '3000000000');
});

void test('withdrawal receipt charges actual Jito spent and separately funded stake rent', async () => {
  const transaction = pending('withdraw');
  assert.deepEqual(await finalizedGateway(receipt(transaction)).poll(transaction), { status: 'finalized', effects: {
    feeLamports: '5000', actualJitoSpentUnits: '3020000000', stakeAddress: stake.toBase58(), refundableRentLamports: '2282880',
  } });
});

void test('withdrawal receipt refuses principal below the signed redemption minimum', async () => {
  const transaction = pending('withdraw'); const actual = receipt(transaction);
  const i = actual.transaction.message.staticAccountKeys.findIndex((address) => address.equals(stake));
  must(actual.meta).postBalances[i] = must(must(actual.meta).postBalances[i]) - 1;
  assert.equal((await finalizedGateway(actual).poll(transaction)).status, 'unknown');
});

void test('temporary poll transport failure is sanitized and a later finalized receipt can be reconciled', async () => {
  const transaction = pending(); let attempts = 0;
  const g = gateway({ async getSignatureStatuses() {
    attempts++; if (attempts === 1) throw new Error('429 https://rpc.invalid/SECRET');
    return { context: { slot: 110 }, value: [{ slot: 110, confirmations: null, err: null, confirmationStatus: 'finalized' }] };
  }, async getTransaction() { return receipt(transaction); } } as Partial<Connection>);
  await assert.rejects(g.poll(transaction), (error) => error instanceof Error && error.message === 'poll_rpc_unavailable');
  assert.equal((await g.poll(transaction)).status, 'finalized');
});

void test('claim receipt includes returned stake rent and reports it separately for economic profit', async () => {
  const transaction = pending('claim');
  assert.deepEqual(await finalizedGateway(receipt(transaction)).poll(transaction), { status: 'finalized', effects: {
    feeLamports: '5000', actualClaimedLamports: '3019262880', stakeAddress: stake.toBase58(), refundableRentLamports: '2282880',
  } });
});

void test('failed finalized receipt still charges its actual fee', async () => {
  const transaction = pending(); const actual = receipt(transaction); must(actual.meta).err = { InstructionError: [0, 'Custom'] };
  const result = await finalizedGateway(actual, must(actual.meta).err).poll(transaction);
  assert.deepEqual(result, { status: 'failed', effects: { feeLamports: '5000' }, error: 'transaction_failed' });
});

void test('untrusted receipt ownership, unsafe balance or mismatched finality fails closed', async () => {
  const transaction = pending();
  for (const mutate of [
    (value: VersionedTransactionResponse) => { must(must(must(value.meta).postTokenBalances)[0]).owner = stake.toBase58(); },
    (value: VersionedTransactionResponse) => { must(must(must(value.meta).postTokenBalances)[0]).uiTokenAmount.amount = '1.5'; },
    (value: VersionedTransactionResponse) => { must(value.meta).preBalances[0] = Number.MAX_SAFE_INTEGER + 1; },
    (value: VersionedTransactionResponse) => { value.transaction.signatures[0] = stake.toBase58(); },
    (value: VersionedTransactionResponse) => { must(value.meta).err = { InstructionError: [0, 'Custom'] }; },
  ]) {
    const actual = receipt(transaction); mutate(actual);
    assert.equal((await finalizedGateway(actual).poll(transaction)).status, 'unknown');
  }
});

function finalizedGateway(actual: VersionedTransactionResponse, statusError: unknown = null) {
  return gateway({ async getSignatureStatuses() { return { context: { slot: 110 }, value: [{ slot: 110, confirmations: null, err: statusError, confirmationStatus: 'finalized' }] }; },
    async getTransaction() { return actual; } } as Partial<Connection>);
}

function tokenAccount(mint: PublicKey, units: bigint, owner = wallet): AccountInfo<Buffer> {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount: units, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: mint.equals(SOL_MINT) ? 1 : 0, isNative: 2_039_280n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, rentEpoch: 0, data };
}

function buyFixture() {
  let signs = 0; let quotes = 0; let builds = 0; let clock = 100_000;
  const quote: JupiterQuote = { raw: {}, inputLamports: 3_000_000_000n, expectedOutputAtomic: 3_021_000_000n,
    minimumOutputAtomic: 3_020_000_000n, slippageBps: 1, contextSlot: 100, receivedAtMs: clock,
    routePlan: [{ ammKey: stake.toBase58(), label: 'fixture', inputMint: SOL_MINT.toBase58(), outputMint: JITOSOL_MINT.toBase58(), updateContextSlot: 100 }] };
  const observation: Observation = { observedAtMs: clock,
    quote: { id: 'second-quote', receivedAtMs: clock, contextSlot: 100, routeSlot: 100, inputMint: SOL_MINT.toBase58(),
      outputMint: JITOSOL_MINT.toBase58(), inputLamports: '3000000000', minJitoOutUnits: '3020000000', raw: { kind: 'jitosol-jupiter-v1', quote } },
    pool: { address: config.stakePoolAddress, mint: config.jitoMintAddress, contextSlot: 100, currentEpoch: 1054, lastUpdateEpoch: 1054,
      totalLamports: '1000000000000', tokenSupply: '1000000000000', withdrawalFeeNumerator: '0', withdrawalFeeDenominator: '1000' },
    withdrawal: { available: true, checkedAtMs: clock, minimumDelegationLamports: '1000000000', stakeRentLamports: '2282880', tokenAccountRentLamports: '2039280' },
    wallet: { address: wallet.toBase58(), solLamports: '9000000000', jitoUnits: '111' } };
  const walletAccount = (lamports: number): AccountInfo<Buffer> => ({ data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false, lamports, rentEpoch: 0 });
  const before = new Map<string, AccountInfo<Buffer>>([[wallet.toBase58(), walletAccount(9_000_000_000)], [jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, 111n)]]);
  const after = new Map<string, AccountInfo<Buffer>>([[wallet.toBase58(), walletAccount(5_999_995_000)], [jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, 3_020_000_111n)]]);
  const swap = new TransactionInstruction({ programId: SystemProgram.programId, data: Buffer.alloc(0), keys: [wallet, jitoAta, solAta].map((pubkey) => ({ pubkey, isSigner: pubkey.equals(wallet), isWritable: true })) });
  let simulationError: unknown = null; let fee = 5000; let returnedSigner = wallet;
  const rpc: Partial<Connection> = {
    async getGenesisHash() { return MAINNET_GENESIS_HASH; },
    async getMultipleAccountsInfoAndContext(addresses) { return { context: { slot: 100 }, value: addresses.map((address) => before.get(address.toBase58()) ?? null) }; },
    async getLatestBlockhash() { return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200 }; },
    async getFeeForMessage() { return { context: { slot: 100 }, value: fee }; },
    async getMinimumBalanceForRentExemption() { return 2_039_280; },
    async simulateTransaction(_transaction, options) {
      assert.equal((options as { sigVerify?: boolean }).sigVerify, false);
      assert.equal((options as { replaceRecentBlockhash?: boolean }).replaceRecentBlockhash, false);
      const addresses = (options as { accounts: { addresses: string[] } }).accounts.addresses;
      return { context: { slot: 100 }, value: { err: simulationError, logs: [], accounts: addresses.map((address) => {
        const account = after.get(address); return account ? { ...account, owner: account.owner.toBase58(), data: [account.data.toString('base64'), 'base64'] } : null;
      }) } };
    },
  } as Partial<Connection>;
  const client = { async getQuote() { quotes++; return quote; }, async buildSwapInstructions(given: JupiterQuote): Promise<JupiterSwapInstructions> {
    builds++; assert.equal(given, quote, 'provided second observation quote must be used');
    const ix = returnedSigner.equals(wallet) ? swap : new TransactionInstruction({ programId: swap.programId, data: swap.data, keys: [...swap.keys, { pubkey: returnedSigner, isSigner: true, isWritable: false }] });
    return { instructions: [ix], setupInstructions: [], swapInstruction: ix, cleanupInstruction: null,
      addressLookupTableAddresses: [], sourceTokenAccount: solAta, destinationTokenAccount: jitoAta, remoteComputeUnitLimit: null, remotePriorityFeeLamports: null };
  } };
  const g = new SolanaJitoGateway({ connection: rpc as Connection, jupiter: client, walletAddress: wallet.toBase58(), liveEnabled: true,
    now: () => clock, signer: { ...signer, async signMessage(message) { signs++; return signer.signMessage(message); } } });
  return { g, observation, before, after, swap, get signs() { return signs; }, get quotes() { return quotes; }, get builds() { return builds; },
    failSimulation: () => { simulationError = { InstructionError: [0, 'invalid'] }; },
    excessiveFee: () => { fee = 1_000_001; }, stale: () => { clock += 5001; },
    otherSigner: () => { returnedSigner = stake; },
  };
}

void test('prepare uses the provided newer quote, simulates then signs without broadcasting', async () => {
  const f = buyFixture(); const tx = await f.g.prepare({ kind: 'buy', config, position, observation: f.observation });
  assert.equal(f.signs, 1); assert.equal(f.quotes, 0); assert.equal(f.builds, 1);
  assert.equal(tx.expected.minJitoReceivedUnits, '3020000000'); assert.equal(tx.estimatedFeeLamports, '5000');
  assert.equal(tx.lastValidBlockHeight, 200);
  const wire = VersionedTransaction.deserialize(Buffer.from(tx.wireTransactionBase64, 'base64'));
  assert.equal(wire.message.header.numRequiredSignatures, 1); assert.equal(bs58.encode(must(wire.signatures[0])), tx.signature);
});

void test('prepare rejects failed simulation, low token delta, excess debit, nonzero existing WSOL and unrelated owned tokens before signing', async () => {
  const cases = [
    (f: ReturnType<typeof buyFixture>) => { f.failSimulation(); },
    (f: ReturnType<typeof buyFixture>) => { f.after.set(jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, 3_020_000_110n)); },
    (f: ReturnType<typeof buyFixture>) => { must(f.after.get(wallet.toBase58())).lamports = 5_900_000_000; },
    (f: ReturnType<typeof buyFixture>) => { f.before.set(solAta.toBase58(), tokenAccount(SOL_MINT, 1n)); },
    (f: ReturnType<typeof buyFixture>) => { f.after.set(solAta.toBase58(), tokenAccount(SOL_MINT, 0n));
      must(f.after.get(wallet.toBase58())).lamports -= 2_039_280; },
    (f: ReturnType<typeof buyFixture>) => { f.after.set(jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, 3_020_000_111n, stake)); },
    (f: ReturnType<typeof buyFixture>) => { f.swap.keys.push({ pubkey: stake, isSigner: false, isWritable: true }); f.before.set(stake.toBase58(), tokenAccount(new PublicKey(Buffer.alloc(32, 27)), 1n)); },
    (f: ReturnType<typeof buyFixture>) => { f.otherSigner(); },
    (f: ReturnType<typeof buyFixture>) => { f.excessiveFee(); },
    (f: ReturnType<typeof buyFixture>) => { f.stale(); },
  ];
  for (const mutate of cases) {
    const f = buyFixture(); mutate(f);
    await assert.rejects(f.g.prepare({ kind: 'buy', config, position, observation: f.observation }));
    assert.equal(f.signs, 0);
  }
});

function must<T>(value: T | undefined | null): T { assert.ok(value !== undefined && value !== null); return value; }

const archived = JSON.parse(readFileSync(new URL('./fixtures/jitosol/stake-pool-public.json', import.meta.url), 'utf8')) as {
  epoch: number; account: { owner: string; data: [string, string]; lamports: number };
};
const epoch = BigInt(archived.epoch);
const vote = new PublicKey(Buffer.alloc(32, 19));
const stakeRent = 2_282_880n;
function ownedStake(owner: PublicKey, deactivationEpoch = (1n << 64n) - 1n, lamports = 20_000_000_000n): AccountInfo<Buffer> {
  const data = Buffer.alloc(StakeProgram.space); data.writeUInt32LE(2); data.writeBigUInt64LE(stakeRent, 4);
  owner.toBuffer().copy(data, 12); owner.toBuffer().copy(data, 44); vote.toBuffer().copy(data, 124);
  data.writeBigUInt64LE(lamports - stakeRent, 156); data.writeBigUInt64LE(epoch - 10n, 164); data.writeBigUInt64LE(deactivationEpoch, 172);
  return { data, owner: StakeProgram.programId, lamports: Number(lamports), executable: false, rentEpoch: 0 };
}

function chainFixture() {
  const poolAccount: AccountInfo<Buffer> = { data: Buffer.from(archived.account.data[0], 'base64'), owner: new PublicKey(archived.account.owner),
    lamports: archived.account.lamports, executable: false, rentEpoch: 0 };
  const pool = decodeJitoStakePool(poolAccount, epoch);
  const validators = Buffer.alloc(82); validators[0] = 2; validators.writeUInt32LE(1, 1); validators.writeUInt32LE(1, 5);
  validators.writeBigUInt64LE(20_000_000_000n, 9); validators.writeBigUInt64LE(epoch, 25); vote.toBuffer().copy(validators, 50);
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [JITO_POOL_ADDRESS.toBase58(), poolAccount],
    [pool.validatorList.toBase58(), { data: validators, owner: STAKE_POOL_PROGRAM_ID, lamports: 1_000_000, executable: false, rentEpoch: 0 }],
    [pool.managerFeeAccount.toBase58(), tokenAccount(JITOSOL_MINT, 500n, stake)],
    [deriveValidatorStakeAddress(vote, 0).toBase58(), ownedStake(pool.withdrawAuthority)],
    [wallet.toBase58(), { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 9_000_000_000, executable: false, rentEpoch: 0 }],
    [jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, 3_020_000_111n)],
  ]);
  let reads = 0; let simulationCalls = 0; let simulationErr: unknown = null; let currentEpoch = Number(epoch);
  let beforeRead: (() => void) | undefined;
  const rpc = {
    async getGenesisHash() { return MAINNET_GENESIS_HASH; },
    async getAccountInfo(address: PublicKey) { return accounts.get(address.toBase58()) ?? null; },
    async getAccountInfoAndContext(address: PublicKey, options: unknown) {
      reads++; beforeRead?.(); assert.ok(((options as { minContextSlot?: number }).minContextSlot ?? 0) <= 100);
      return { context: { slot: 100 }, value: accounts.get(address.toBase58()) ?? null };
    },
    async getMultipleAccountsInfoAndContext(addresses: PublicKey[]) { return { context: { slot: 100 }, value: addresses.map((a) => accounts.get(a.toBase58()) ?? null) }; },
    async getEpochInfo() { return { epoch: currentEpoch }; },
    async getStakeMinimumDelegation() { return { context: { slot: 100 }, value: 1_000_000_000 }; },
    async getMinimumBalanceForRentExemption(size: number) { return size === StakeProgram.space ? Number(stakeRent) : 2_039_280; },
    async getLatestBlockhash() { return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200 }; },
    async getFeeForMessage() { return { context: { slot: 100 }, value: 5000 }; },
    async simulateTransaction(transaction: VersionedTransaction, options: { sigVerify?: boolean; replaceRecentBlockhash?: boolean }) {
      simulationCalls++; assert.equal(options.sigVerify, false); assert.equal(options.replaceRecentBlockhash, false);
      assert.ok(transaction.signatures.every((signature) => signature.every((byte) => byte === 0)));
      return { context: { slot: 100 }, value: { err: simulationErr, logs: [] } };
    },
  };
  const quote: JupiterQuote = { raw: {}, inputLamports: 3_000_000_000n, expectedOutputAtomic: 3_021_000_000n,
    minimumOutputAtomic: 3_020_000_000n, slippageBps: 1, contextSlot: 100, receivedAtMs: 100_000,
    routePlan: [{ ammKey: stake.toBase58(), label: 'fixture', inputMint: SOL_MINT.toBase58(), outputMint: JITOSOL_MINT.toBase58(), updateContextSlot: 97 }] };
  const client = { async getQuote() { return quote; }, buildSwapInstructions: forbidden };
  const make = () => new SolanaJitoGateway({ connection: rpc as unknown as Connection, jupiter: client,
    walletAddress: wallet.toBase58(), now: () => 100_000 });
  return { accounts, rpc, quote, make, pool, setBeforeRead: (fn: () => void) => { beforeRead = fn; },
    setEpoch: (value: number) => { currentEpoch = value; }, setSimulationError: (value: unknown) => { simulationErr = value; },
    get reads() { return reads; }, get simulationCalls() { return simulationCalls; } };
}

void test('observation includes actual pool context, conservative route context and validated withdrawal source capacity', async () => {
  const f = chainFixture(); const result = await f.make().observe(config);
  assert.equal(result.pool.contextSlot, 100); assert.equal(result.quote.contextSlot, 100); assert.equal(result.quote.routeSlot, 97);
  assert.equal(result.pool.totalLamports, '10451067197081554');
  assert.equal(result.wallet.jitoUnits, '3020000111'); assert.equal(result.wallet.solLamports, '9000000000');
  assert.equal(result.withdrawal.available, true);
  assert.equal(result.withdrawal.sourceStakeAddress, deriveValidatorStakeAddress(vote, 0).toBase58());
  assert.equal(result.withdrawal.minimumDelegationLamports, '1000000000');
  assert.equal(result.withdrawal.stakeRentLamports, '2282880'); assert.equal(result.withdrawal.tokenAccountRentLamports, '2039280');
  assert.equal((result.quote.raw as { quote: JupiterQuote }).quote, f.quote); assert.equal(f.simulationCalls, 0);
});

void test('observation fails entry closed for missing route freshness, unavailable active stake and incorrect owned token account', async () => {
  const stale = chainFixture(); Object.defineProperty(must(stale.quote.routePlan[0]), 'updateContextSlot', { value: null });
  assert.equal((await stale.make().observe(config)).quote.routeSlot, -1);
  const unavailable = chainFixture(); unavailable.accounts.delete(deriveValidatorStakeAddress(vote, 0).toBase58());
  assert.equal((await unavailable.make().observe(config)).withdrawal.available, false);
  const wrongOwner = chainFixture(); wrongOwner.accounts.set(jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, 500n, stake));
  await assert.rejects(wrongOwner.make().observe(config), /token/);
});

void test('observation rejects changing pool conversion rates or epoch while proving withdrawal capacity', async () => {
  for (const mode of ['rate', 'epoch'] as const) {
    const f = chainFixture();
    f.setBeforeRead(() => {
      if (f.reads === 5) {
        if (mode === 'epoch') f.setEpoch(Number(epoch + 1n));
        else {
          const poolAccount = must(f.accounts.get(JITO_POOL_ADDRESS.toBase58()));
          const data = Buffer.from(poolAccount.data); data.writeBigUInt64LE(data.readBigUInt64LE(258) + 1n, 258);
          f.accounts.set(JITO_POOL_ADDRESS.toBase58(), { ...poolAccount, data });
        }
      }
    });
    await assert.rejects(f.make().observe(config), /observation|pool_changed/);
  }
});

void test('claim readiness waits for actual successful unsigned withdrawal simulation, never elapsed wall time', async () => {
  const f = chainFixture(); const derived = await deriveStakeDestination(wallet, position.id);
  const activePosition = { ...position, stakeAddress: derived.stakeAccount.toBase58() };
  f.accounts.set(derived.stakeAccount.toBase58(), ownedStake(wallet));
  assert.deepEqual(await f.make().canClaim(activePosition), { inactive: false, observedAtMs: 100_000, claimableLamports: '0' });
  assert.equal(f.simulationCalls, 0);
  f.accounts.set(derived.stakeAccount.toBase58(), ownedStake(wallet, epoch - 2n));
  f.setSimulationError({ InstructionError: [2, 'InsufficientFunds'] });
  assert.deepEqual(await f.make().canClaim(activePosition), { inactive: false, observedAtMs: 100_000, claimableLamports: '0' });
  assert.equal(f.simulationCalls, 1);
  f.setSimulationError(null);
  assert.deepEqual(await f.make().canClaim(activePosition), { inactive: true, observedAtMs: 100_000, claimableLamports: '20000000000' });
  assert.equal(f.simulationCalls, 2);
});

void test('claim readiness refuses stake substitution, wrong authority, RPC failure and unexpected simulation error', async () => {
  const f = chainFixture(); const derived = await deriveStakeDestination(wallet, position.id);
  const activePosition = { ...position, stakeAddress: derived.stakeAccount.toBase58() };
  f.accounts.set(derived.stakeAccount.toBase58(), ownedStake(stake, epoch - 2n));
  await assert.rejects(f.make().canClaim(activePosition), /authority/);
  await assert.rejects(f.make().canClaim(position), /stake_mismatch/);
  f.accounts.set(derived.stakeAccount.toBase58(), ownedStake(wallet, epoch - 2n));
  f.setSimulationError({ InstructionError: [2, 'InvalidArgument'] });
  await assert.rejects(f.make().canClaim(activePosition), /claim_readiness/);
  f.rpc.getEpochInfo = async () => { throw new Error('https://rpc.invalid/?api-key=SECRET'); };
  await assert.rejects(f.make().canClaim(activePosition), (error) => error instanceof Error && error.message === 'claim_readiness_failed');
});

async function stakePrepareFixture(kind: 'withdraw' | 'deactivate' | 'claim') {
  const f = chainFixture(); const derived = await deriveStakeDestination(wallet, position.id);
  const stakeAddress = derived.stakeAccount.toBase58(); let signs = 0;
  const currentPosition = { ...position, stakeAddress };
  const redemption = quoteStakeWithdrawal(f.pool, 3_020_000_000n).withdrawLamports;
  const stakeLamports = redemption + stakeRent;
  const after = new Map(f.accounts);
  const walletAfter = { ...must(f.accounts.get(wallet.toBase58())) };
  if (kind === 'withdraw') {
    after.set(jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, 111n));
    after.set(stakeAddress, ownedStake(wallet, (1n << 64n) - 1n, stakeLamports));
    walletAfter.lamports -= Number(stakeRent) + 5000;
  } else {
    const account = ownedStake(wallet, kind === 'claim' ? epoch - 2n : (1n << 64n) - 1n, stakeLamports);
    f.accounts.set(stakeAddress, account);
    if (kind === 'claim') { after.delete(stakeAddress); walletAfter.lamports += Number(stakeLamports) - 5000; }
    else { after.set(stakeAddress, ownedStake(wallet, epoch, stakeLamports)); walletAfter.lamports -= 5000; }
  }
  after.set(wallet.toBase58(), walletAfter);
  const rpc = { ...f.rpc, async simulateTransaction(_tx: VersionedTransaction, options: { accounts?: { addresses: string[] } }) {
    return { context: { slot: 100 }, value: { err: null, logs: [], ...(options.accounts ? { accounts: options.accounts.addresses.map((address) => {
      const account = after.get(address); return account ? { ...account, owner: account.owner.toBase58(), data: [account.data.toString('base64'), 'base64'] } : null;
    }) } : {}) } };
  } };
  const g = new SolanaJitoGateway({ connection: rpc as unknown as Connection, jupiter, walletAddress: wallet.toBase58(),
    liveEnabled: true, now: () => 100_000, signer: { ...signer, async signMessage(message) { signs++; return signer.signMessage(message); } } });
  return { ...f, g, after, position: currentPosition, derived, get signs() { return signs; } };
}

void test('prepare withdrawal burns only actual purchased Jito and creates the deterministic wallet-owned stake', async () => {
  const f = await stakePrepareFixture('withdraw');
  const tx = await f.g.prepare({ kind: 'withdraw', config, position: f.position });
  assert.equal(tx.expected.jitoSpentUnits, f.position.actualJitoReceivedUnits);
  assert.equal(tx.expected.stakeAddress, f.derived.stakeAccount.toBase58());
  assert.equal(tx.expected.refundableRentLamports, stakeRent.toString()); assert.equal(f.signs, 1);
  assert.equal(tx.expected.minimumRedemptionLamports, quoteStakeWithdrawal(f.pool, 3_020_000_000n).withdrawLamports.toString());
});

void test('prepare deactivate and claim validate actual stake changes and claim credit before signing', async () => {
  for (const kind of ['deactivate', 'claim'] as const) {
    const f = await stakePrepareFixture(kind);
    const tx = await f.g.prepare({ kind, config, position: f.position });
    assert.equal(tx.kind, kind); assert.equal(tx.expected.stakeAddress, f.derived.stakeAccount.toBase58());
    if (kind === 'claim') assert.equal(tx.expected.refundableRentLamports, stakeRent.toString());
    assert.equal(f.signs, 1);
  }
});

void test('stake transaction simulations reject unrelated token changes and stake authority or amount mismatch before signing', async () => {
  for (const kind of ['withdraw', 'deactivate', 'claim'] as const) {
    const f = await stakePrepareFixture(kind); f.after.set(solAta.toBase58(), tokenAccount(SOL_MINT, 1n));
    await assert.rejects(f.g.prepare({ kind, config, position: f.position })); assert.equal(f.signs, 0);
  }
  for (const kind of ['deactivate', 'claim'] as const) {
    const f = await stakePrepareFixture(kind); f.after.set(jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, 1n));
    await assert.rejects(f.g.prepare({ kind, config, position: f.position })); assert.equal(f.signs, 0);
  }
  const unauthorized = await stakePrepareFixture('withdraw');
  unauthorized.after.set(unauthorized.derived.stakeAccount.toBase58(), ownedStake(stake));
  await assert.rejects(unauthorized.g.prepare({ kind: 'withdraw', config, position: unauthorized.position })); assert.equal(unauthorized.signs, 0);
  const underfunded = await stakePrepareFixture('withdraw');
  underfunded.after.set(underfunded.derived.stakeAccount.toBase58(), ownedStake(wallet, (1n << 64n) - 1n, 3_000_000_000n));
  await assert.rejects(underfunded.g.prepare({ kind: 'withdraw', config, position: underfunded.position })); assert.equal(underfunded.signs, 0);
});

void test('zero-lamport account tombstones from Agave simulation count as closed WSOL and claimed stake', async () => {
  const empty: AccountInfo<Buffer> = { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 0, executable: false, rentEpoch: 0 };
  const buy = buyFixture(); buy.after.set(solAta.toBase58(), empty);
  assert.equal((await buy.g.prepare({ kind: 'buy', config, position, observation: buy.observation })).kind, 'buy');
  const claim = await stakePrepareFixture('claim'); claim.after.set(claim.derived.stakeAccount.toBase58(), empty);
  assert.equal((await claim.g.prepare({ kind: 'claim', config, position: claim.position })).kind, 'claim');
});

void test('withdrawal refuses a pool rate decline below the entry economic minimum before signing', async () => {
  const f = await stakePrepareFixture('withdraw');
  const account = must(f.accounts.get(JITO_POOL_ADDRESS.toBase58())); const data = Buffer.from(account.data);
  data.writeBigUInt64LE(data.readBigUInt64LE(258) * 7n / 10n, 258);
  f.accounts.set(JITO_POOL_ADDRESS.toBase58(), { ...account, data });
  await assert.rejects(f.g.prepare({ kind: 'withdraw', config, position: f.position }), /withdrawal_economic_floor/);
  assert.equal(f.signs, 0);
});

void test('real gateway and durable journal complete a receipt-accounted cycle after restart and runtime cooldown beyond 72 hours', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jitosol-gateway-integration-'));
  let store = await FileJournal.open(directory);
  try {
    const f = chainFixture(); f.accounts.set(jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, 111n));
    let time = 100_000; let slot = 100; let cooled = false; let signCount = 0;
    const filledUnits = 3_020_000_123n;
    const receipts = new Map<string, VersionedTransactionResponse>();
    const uniqueSends: string[] = [];
    const liveConfig = parseJitoBotConfig({ ...config, maxTotalFeesLamports: '1000000' });
    function action(tx: VersionedTransaction) {
      const ix = must(tx.message.compiledInstructions.at(-1));
      const program = must(tx.message.staticAccountKeys[ix.programIdIndex]);
      if (program.equals(STAKE_POOL_PROGRAM_ID)) return 'withdraw';
      if (program.equals(StakeProgram.programId)) return Buffer.from(ix.data).readUInt32LE() === 5 ? 'deactivate' : 'claim';
      return 'buy';
    }
    function execute(tx: VersionedTransaction): Map<string, AccountInfo<Buffer>> {
      const next = new Map(f.accounts); const kind = action(tx);
      const walletAccount = { ...must(next.get(wallet.toBase58())) };
      const jitoAccount = must(next.get(jitoAta.toBase58()));
      const existingUnits = jitoAccount.data.readBigUInt64LE(64);
      walletAccount.lamports -= 5000;
      const ix = must(tx.message.compiledInstructions.at(-1));
      if (kind === 'buy') {
        walletAccount.lamports -= 3_000_000_000;
        next.set(jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, existingUnits + filledUnits));
        next.delete(solAta.toBase58());
      } else if (kind === 'withdraw') {
        const spent = Buffer.from(ix.data).readBigUInt64LE(1);
        assert.equal(spent, filledUnits, 'gateway must withdraw receipt fill, including price improvement');
        const address = must(tx.message.staticAccountKeys[must(ix.accountKeyIndexes[4])]);
        const principal = quoteStakeWithdrawal(f.pool, spent).withdrawLamports;
        next.set(address.toBase58(), ownedStake(wallet, (1n << 64n) - 1n, principal + stakeRent));
        next.set(jitoAta.toBase58(), tokenAccount(JITOSOL_MINT, existingUnits - spent));
        walletAccount.lamports -= Number(stakeRent);
      } else {
        const address = must(tx.message.staticAccountKeys[must(ix.accountKeyIndexes[0])]);
        const previous = must(next.get(address.toBase58()));
        if (kind === 'deactivate') {
          const data = Buffer.from(previous.data); data.writeBigUInt64LE(epoch, 172);
          next.set(address.toBase58(), { ...previous, data });
        } else { walletAccount.lamports += previous.lamports; next.delete(address.toBase58()); }
      }
      next.set(wallet.toBase58(), walletAccount); return next;
    }
    function tokenBalances(tx: VersionedTransaction, accounts: Map<string, AccountInfo<Buffer>>) {
      return tx.message.staticAccountKeys.flatMap((address, accountIndex) => {
        const account = accounts.get(address.toBase58());
        if (!account || !account.owner.equals(TOKEN_PROGRAM_ID) || account.data.length !== 165) return [];
        return [{ accountIndex, mint: new PublicKey(account.data.subarray(0, 32)).toBase58(),
          owner: new PublicKey(account.data.subarray(32, 64)).toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(),
          uiTokenAmount: { amount: account.data.readBigUInt64LE(64).toString(), decimals: 9, uiAmount: null, uiAmountString: '0' } }];
      });
    }
    const rpc = {
      ...f.rpc,
      async getAccountInfoAndContext(address: PublicKey) { return { context: { slot }, value: f.accounts.get(address.toBase58()) ?? null }; },
      async getMultipleAccountsInfoAndContext(addresses: PublicKey[]) { return { context: { slot }, value: addresses.map((a) => f.accounts.get(a.toBase58()) ?? null) }; },
      async getFeeForMessage() { return { context: { slot }, value: 5000 }; },
      async simulateTransaction(tx: VersionedTransaction, options: { sigVerify?: boolean; accounts?: { addresses: string[] } }) {
        assert.equal(options.sigVerify, false); assert.ok(tx.signatures.every((sig) => sig.every((byte) => byte === 0)));
        if (action(tx) === 'claim' && !cooled) return { context: { slot }, value: { err: { InstructionError: [2, 'InsufficientFunds'] }, logs: [] } };
        const next = execute(tx);
        return { context: { slot }, value: { err: null, logs: [], ...(options.accounts ? { accounts: options.accounts.addresses.map((address) => {
          const account = next.get(address); return account ? { ...account, owner: account.owner.toBase58(), data: [account.data.toString('base64'), 'base64'] }
            : { owner: SystemProgram.programId.toBase58(), data: ['', 'base64'], executable: false, lamports: 0 };
        }) } : {}) } };
      },
      async sendRawTransaction(bytes: Uint8Array) {
        const tx = VersionedTransaction.deserialize(bytes); const signature = bs58.encode(must(tx.signatures[0]));
        const saved = must(must(await readJournal(directory)).pending);
        assert.equal(saved.signature, signature); assert.equal(saved.wireTransactionBase64, Buffer.from(bytes).toString('base64'), 'fsynced journal must precede submission');
        if (receipts.has(signature)) return signature;
        uniqueSends.push(action(tx));
        const next = execute(tx);
        receipts.set(signature, { slot, version: 0, transaction: { message: tx.message, signatures: [signature] }, meta: {
          err: null, fee: 5000, preBalances: tx.message.staticAccountKeys.map((a) => f.accounts.get(a.toBase58())?.lamports ?? 0),
          postBalances: tx.message.staticAccountKeys.map((a) => next.get(a.toBase58())?.lamports ?? 0),
          preTokenBalances: tokenBalances(tx, f.accounts), postTokenBalances: tokenBalances(tx, next), loadedAddresses: { readonly: [], writable: [] },
        } });
        f.accounts.clear(); for (const [address, account] of next) f.accounts.set(address, account);
        return signature;
      },
      async getSignatureStatuses(signatures: string[]) { return { context: { slot }, value: signatures.map((signature) => {
        const actual = receipts.get(signature); return actual ? { slot: actual.slot, confirmations: null, err: null, confirmationStatus: 'finalized' as const } : null;
      }) }; },
      async getTransaction(signature: string) { return receipts.get(signature) ?? null; },
    };
    const client = {
      async getQuote(): Promise<JupiterQuote> { return { ...f.quote, raw: { fixtureSlot: slot }, receivedAtMs: time, contextSlot: slot,
        routePlan: f.quote.routePlan.map((route) => ({ ...route, updateContextSlot: slot })) }; },
      async buildSwapInstructions(): Promise<JupiterSwapInstructions> {
        const ix = new TransactionInstruction({ programId: SystemProgram.programId, data: Buffer.alloc(0),
          keys: [wallet, jitoAta, solAta].map((pubkey) => ({ pubkey, isSigner: pubkey.equals(wallet), isWritable: true })) });
        return { instructions: [ix], setupInstructions: [], swapInstruction: ix, cleanupInstruction: null, addressLookupTableAddresses: [],
          sourceTokenAccount: solAta, destinationTokenAccount: jitoAta, remoteComputeUnitLimit: null, remotePriorityFeeLamports: null };
      },
    };
    const makeEngine = () => new JitoBotEngine({ config: liveConfig, store, now: () => time, stopRequested: () => false,
      gateway: new SolanaJitoGateway({ connection: rpc as unknown as Connection, jupiter: client, walletAddress: wallet.toBase58(), liveEnabled: true,
        now: () => time, signer: { ...signer, async signMessage(message) { signCount++; return signer.signMessage(message); } } }) });
    let engine = makeEngine();
    assert.equal((await engine.tick()).status, 'waiting'); time += 10_000; slot++;
    assert.equal((await engine.tick()).status, 'pending'); assert.deepEqual(uniqueSends, ['buy']);
    const durableBuy = must(must(await store.load()).pending);
    await store.close(); store = await FileJournal.open(directory); engine = makeEngine();
    assert.equal(must(must(await store.load()).pending).signature, durableBuy.signature);
    assert.equal((await engine.tick()).status, 'progress');
    assert.equal(must(must(await store.load()).position).actualJitoReceivedUnits, filledUnits.toString());
    assert.equal((await engine.tick()).status, 'pending'); assert.equal((await engine.tick()).status, 'progress');
    assert.equal((await engine.tick()).status, 'pending'); assert.equal((await engine.tick()).status, 'progress');
    assert.equal(must(must(await store.load()).position).stage, 'deactivated');
    time += 72 * 60 * 60 * 1000; f.setEpoch(Number(epoch + 1n));
    assert.equal((await engine.tick()).status, 'waiting'); assert.deepEqual(uniqueSends, ['buy', 'withdraw', 'deactivate']);
    await store.close(); store = await FileJournal.open(directory); engine = makeEngine();
    time += 24 * 60 * 60 * 1000; cooled = true;
    assert.equal((await engine.tick()).status, 'pending'); assert.equal((await engine.tick()).status, 'complete');
    const final = must(await store.load()); const completed = must(final.completedPositions[0]);
    assert.equal(final.completedCycles, 1); assert.equal(final.totalFeesLamports, '20000'); assert.equal(signCount, 4);
    assert.equal(final.realizedProfitLamports, (quoteStakeWithdrawal(f.pool, filledUnits).withdrawLamports - 3_000_000_000n - 20_000n).toString());
    assert.equal(completed.stakeRentLamports, stakeRent.toString()); assert.equal(final.pending, undefined);
    assert.deepEqual(uniqueSends, ['buy', 'withdraw', 'deactivate', 'claim']);
    assert.equal(must(f.accounts.get(jitoAta.toBase58())).data.readBigUInt64LE(64), 111n, 'preexisting Jito capital is preserved');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
