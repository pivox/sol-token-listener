import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { PumpFunPaperQuoteProvider } from '../src/paper/pumpfun-paper-quote.provider.js';
import { createPumpFunBondingCurveInstructions } from '../src/live/pumpfun-bonding-curve-instructions.js';
import { KeypairLiveSigner } from '../src/live/keypair-live-signer.js';
import { LiveTransactionExecutor } from '../src/live/live-transaction-executor.js';
import { accounts, FakeReader, MINT, quoteAsset } from './helpers/pumpfun-paper-quote-state.js';

void test('same execution path signs real BUY and SELL instructions, submits once and confirms both', async () => {
  const market = await accounts();
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(21));
  const signer = new KeypairLiveSigner(wallet);
  const provider = new PumpFunPaperQuoteProvider(new FakeReader(market.snapshots), () => 1_700_000_000_000);
  const journal = new MemoryJournal();
  const rpc = new FakeRpc(wallet.publicKey.toBase58(), 'confirmed', (signature) => journal.events.push(`rpc-send:${signature}`));
  const executor = new LiveTransactionExecutor(rpc, journal, signer, { commitment: 'confirmed', confirmationPolls: 2, delayMs: 0, maxPriorityFeeLamports: 1n, exitReserveLamports: 1n });
  const user = wallet.publicKey;
  const buyState = await provider.quoteAndState({
    mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 100n,
  });
  const buyInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
    ...await createPumpFunBondingCurveInstructions({
    side: 'BUY', quoteAndState: buyState, associatedUserAccountInfo: null, user,
  }),
  ];
  const allowed = new Set([user.toBase58(), ...buyInstructions.flatMap((ix) => [
    ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58()),
  ])]);
  const buy = await executor.execute({
    order: order('BUY', user.toBase58(), { mint: MINT.toBase58(), quoteBudgetRaw: '1000000', tokenProgram: TOKEN_PROGRAM_ID.toBase58() }),
    instructions: buyInstructions, allowedAccounts: allowed,
    maxSpendRaw: 1_000_000n, maxTokenAmountRaw: buyState.quote.amountOutRaw, positionRemainingRaw: 0n,
  });
  assert.equal(buy.status, 'CONFIRMED');
  assert.deepEqual(buy.tokenBalance, {
    status: 'KNOWN', mint: MINT.toBase58(), owner: user.toBase58(),
    preAmountRaw: 0n, postAmountRaw: 12_345n, deltaRaw: 12_345n,
  });
  assert.equal(buy.signature, rpc.sentSignatures[0]);

  const sellState = await provider.quoteAndState({
    mint: MINT.toBase58(), quoteAsset, side: 'SELL', amountInRaw: buyState.quote.minimumAmountOutRaw, slippageBps: 100n,
  });
  const sellInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
    ...await createPumpFunBondingCurveInstructions({
    side: 'SELL', quoteAndState: sellState, associatedUserAccountInfo: null, user,
  }),
  ];
  const sellAllowed = new Set([user.toBase58(), ...sellInstructions.flatMap((ix) => [
    ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58()),
  ])]);
  const sell = await executor.execute({
    order: order('SELL', user.toBase58(), { mint: MINT.toBase58(), quoteMint: quoteAsset.mint, tokenAmountRaw: buyState.quote.minimumAmountOutRaw.toString() }),
    instructions: sellInstructions, allowedAccounts: sellAllowed,
    maxSpendRaw: 0n, maxTokenAmountRaw: buyState.quote.minimumAmountOutRaw,
    positionRemainingRaw: buyState.quote.minimumAmountOutRaw,
  });
  assert.equal(sell.status, 'CONFIRMED');
  assert.equal(rpc.sentSignatures.length, 2);
  assert.equal(journal.events.filter((event) => event.startsWith('prepare:')).length, 2);
  assert.ok(journal.events.indexOf(`signed:${buy.signature}`) < journal.events.indexOf(`submitted:${buy.orderId}`));
  assert.ok(journal.events.indexOf(`submitted:${buy.orderId}`) < journal.events.indexOf(`rpc-send:${buy.signature}`));
  assert.ok(journal.events.includes(`confirmed:${buy.orderId}`));
  assert.ok(journal.events.includes(`confirmed:${sell.orderId}`));
});

void test('BUY preserves the configured exit reserve after exact spend, fee and ATA rent', async () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(31));
  const market = await accounts();
  const provider = new PumpFunPaperQuoteProvider(new FakeReader(market.snapshots), () => 1_700_000_000_000);
  const state = await provider.quoteAndState({ mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 100n });
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
    ...await createPumpFunBondingCurveInstructions({ side: 'BUY', quoteAndState: state, associatedUserAccountInfo: null, user: wallet.publicKey })];
  const allowedAccounts = new Set([wallet.publicKey.toBase58(), ...instructions.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58())])]);
  const input = { order: order('BUY', wallet.publicKey.toBase58(), { mint: MINT.toBase58(), quoteBudgetRaw: '1000000', tokenProgram: TOKEN_PROGRAM_ID.toBase58() }),
    instructions, allowedAccounts, maxSpendRaw: 1_000_000n, maxTokenAmountRaw: state.quote.amountOutRaw, positionRemainingRaw: 0n } as const;
  const rpc = new FakeRpc(wallet.publicKey.toBase58());
  rpc.feeLamports = 5_001;
  rpc.rentLamports = 2_000_000;
  rpc.balanceLamports = 1_000_000_000;
  rpc.balanceObservedAtMs = 1_700_000_000_000;
  const executor = new LiveTransactionExecutor(rpc, new MemoryJournal(), new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 1n,
    exitReserveLamports: 10_000_000n, now: () => 1_700_000_000_000,
  });
  assert.equal((await executor.execute(input)).status, 'CONFIRMED');
  assert.equal(rpc.balanceReads, 1);

  // Equality is allowed: quote budget + total network fee + one ATA rent + reserve.
  const exact = new FakeRpc(wallet.publicKey.toBase58());
  exact.feeLamports = 5_001;
  exact.rentLamports = 2_000_000;
  exact.balanceLamports = 1_000_000 + 5_001 + 2_000_000 + 10_000_000;
  exact.balanceObservedAtMs = 1_700_000_000_000;
  const exactExecutor = new LiveTransactionExecutor(exact, new MemoryJournal(), new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 1n,
    exitReserveLamports: 10_000_000n, now: () => 1_700_000_000_000,
  });
  assert.equal((await exactExecutor.execute(input)).status, 'CONFIRMED');
});

void test('BUY refuses before journal or signature when it would dip into reserve or balance is unknown/stale', async () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(32));
  const market = await accounts();
  const provider = new PumpFunPaperQuoteProvider(new FakeReader(market.snapshots), () => 1_700_000_000_000);
  const state = await provider.quoteAndState({ mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 100n });
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
    ...await createPumpFunBondingCurveInstructions({ side: 'BUY', quoteAndState: state, associatedUserAccountInfo: null, user: wallet.publicKey })];
  const input = { order: order('BUY', wallet.publicKey.toBase58(), { mint: MINT.toBase58(), quoteBudgetRaw: '1000000', tokenProgram: TOKEN_PROGRAM_ID.toBase58() }),
    instructions, allowedAccounts: new Set([wallet.publicKey.toBase58(), ...instructions.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58())])]),
    maxSpendRaw: 1_000_000n, maxTokenAmountRaw: state.quote.amountOutRaw, positionRemainingRaw: 0n } as const;
  for (const mode of ['below-reserve', 'unknown-balance', 'stale-balance', 'unknown-fee'] as const) {
    const rpc = new FakeRpc(wallet.publicKey.toBase58());
    rpc.feeLamports = 5_001;
    rpc.rentLamports = 2_000_000;
    rpc.balanceLamports = mode === 'below-reserve' ? 1_000_000 + 5_000 + 2_000_000 + 9_999_999 : 1_000_000_000;
    rpc.balanceObservedAtMs = 1_700_000_000_000;
    if (mode === 'unknown-balance') rpc.balanceUnavailable = true;
    if (mode === 'stale-balance') rpc.balanceObservedAtMs = 1_699_999_990_000;
    if (mode === 'unknown-fee') rpc.feeLamports = null;
    const journal = new MemoryJournal();
    const signer = new KeypairLiveSigner(wallet);
    let signatures = 0;
    const sign = signer.sign.bind(signer);
    signer.sign = (transaction): ReturnType<KeypairLiveSigner['sign']> => { signatures += 1; return sign(transaction); };
    const executor = new LiveTransactionExecutor(rpc, journal, signer, {
      commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 1n,
      exitReserveLamports: 10_000_000n, maximumBalanceAgeMs: 5_000, now: () => 1_700_000_000_000,
    });
    await assert.rejects(executor.execute(input), /reserve|balance|fee/u);
    assert.equal(signatures, 0, mode);
    assert.equal(rpc.sentBytes.length, 0, mode);
    assert.equal(journal.events.some((event) => event.startsWith('prepare:')), false, mode);
  }
});

void test('SELL is not blocked by the BUY reserve floor', async () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(33));
  const market = await accounts();
  const provider = new PumpFunPaperQuoteProvider(new FakeReader(market.snapshots), () => 1_700_000_000_000);
  const state = await provider.quoteAndState({ mint: MINT.toBase58(), quoteAsset, side: 'SELL', amountInRaw: 10_000n, slippageBps: 100n });
  const instructions = await createPumpFunBondingCurveInstructions({ side: 'SELL', quoteAndState: state, associatedUserAccountInfo: null, user: wallet.publicKey });
  const rpc = new FakeRpc(wallet.publicKey.toBase58());
  rpc.balanceLamports = 0;
  rpc.balanceUnavailable = true;
  const executor = new LiveTransactionExecutor(rpc, new MemoryJournal(), new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 0n, exitReserveLamports: 10_000_000n,
  });
  const result = await executor.execute({ order: order('SELL', wallet.publicKey.toBase58(), { mint: MINT.toBase58(), quoteMint: quoteAsset.mint }),
    instructions, allowedAccounts: new Set([wallet.publicKey.toBase58(), ...instructions.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58())])]),
    maxSpendRaw: 0n, maxTokenAmountRaw: 10_000n, positionRemainingRaw: 10_000n });
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(rpc.balanceReads, 0);
});

void test('null confirmation remains UNKNOWN and blocks any claim of transaction failure', async () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(22));
  const market = await accounts();
  const journal = new MemoryJournal();
  const rpc = new FakeRpc(wallet.publicKey.toBase58(), 'unknown', (signature) => journal.events.push(`rpc-send:${signature}`));
  const executor = new LiveTransactionExecutor(rpc, journal, new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 0n,
    exitReserveLamports: 1n,
  });
  const provider = new PumpFunPaperQuoteProvider(new FakeReader(market.snapshots), () => 1_700_000_000_000);
  const state = await provider.quoteAndState({
    mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 100n,
  });
  const instructions = await createPumpFunBondingCurveInstructions({
    side: 'BUY', quoteAndState: state, associatedUserAccountInfo: null, user: wallet.publicKey,
  });
  const result = await executor.execute({
    order: order('BUY', wallet.publicKey.toBase58(), { mint: MINT.toBase58(), quoteBudgetRaw: '1000000', tokenProgram: TOKEN_PROGRAM_ID.toBase58() }),
    instructions, allowedAccounts: new Set([wallet.publicKey.toBase58(), ...instructions.flatMap((ix) => [
      ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58()),
    ])]), maxSpendRaw: state.quote.amountInRaw, maxTokenAmountRaw: state.quote.amountOutRaw, positionRemainingRaw: 0n,
  });
  assert.equal(result.status, 'UNKNOWN');
  assert.ok(journal.events.includes(`unknown:${result.orderId}`));
  assert.equal(journal.events.includes(`failed:${result.orderId}`), false);
});

void test('restart replays identical signed bytes and resolves the same signature without rebuilding', async () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(24));
  const market = await accounts();
  const journal = new MemoryJournal();
  const provider = new PumpFunPaperQuoteProvider(new FakeReader(market.snapshots), () => 1_700_000_000_000);
  const state = await provider.quoteAndState({
    mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 100n,
  });
  const instructions = await createPumpFunBondingCurveInstructions({
    side: 'BUY', quoteAndState: state, associatedUserAccountInfo: null, user: wallet.publicKey,
  });
  const allowedAccounts = new Set([wallet.publicKey.toBase58(), ...instructions.flatMap((ix) => [
    ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58()),
  ])]);
  const firstRpc = new FakeRpc(wallet.publicKey.toBase58(), 'unknown');
  const firstExecutor = new LiveTransactionExecutor(firstRpc, journal, new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 0n,
    exitReserveLamports: 1n,
  });
  const orderInput = order('BUY', wallet.publicKey.toBase58(), { mint: MINT.toBase58(), quoteBudgetRaw: '1000000', tokenProgram: TOKEN_PROGRAM_ID.toBase58() });
  const first = await firstExecutor.execute({
    order: orderInput, instructions, allowedAccounts, maxSpendRaw: state.quote.amountInRaw,
    maxTokenAmountRaw: state.quote.amountOutRaw, positionRemainingRaw: 0n,
  });
  assert.equal(first.status, 'UNKNOWN');
  const persisted = journal.orders.get(first.orderId);
  assert.ok(persisted?.signedTransaction);

  const recoveryRpc = new FakeRpc(wallet.publicKey.toBase58(), 'late', () => undefined, first.signature);
  const recovery = new LiveTransactionExecutor(recoveryRpc, journal, new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 2, delayMs: 0, maxPriorityFeeLamports: 0n,
    exitReserveLamports: 1n,
  });
  const recovered = await recovery.resume({
    ...persisted.order, status: 'UNKNOWN', signature: first.signature,
    signedTransaction: persisted.signedTransaction,
  });

  assert.equal(recovered.status, 'CONFIRMED');
  assert.equal(recovered.signature, first.signature);
  const replayedBytes=recoveryRpc.sentBytes[0];
  assert.ok(replayedBytes);
  assert.deepEqual([...replayedBytes], [...persisted.signedTransaction]);
  assert.equal(recoveryRpc.sentSignatures[0], first.signature);
});

void test('restart never edits a persisted transaction to fit a newly lower priority-fee cap', async () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(27));
  const market = await accounts();
  const provider = new PumpFunPaperQuoteProvider(new FakeReader(market.snapshots), () => 1_700_000_000_000);
  const state = await provider.quoteAndState({
    mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 100n,
  });
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 6 }),
    ...await createPumpFunBondingCurveInstructions({ side: 'BUY', quoteAndState: state, associatedUserAccountInfo: null, user: wallet.publicKey }),
  ];
  const allowedAccounts = new Set([wallet.publicKey.toBase58(), ...instructions.flatMap((ix) => [
    ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58()),
  ])]);
  const journal = new MemoryJournal();
  const originalRpc = new FakeRpc(wallet.publicKey.toBase58(), 'unknown');
  const originalExecutor = new LiveTransactionExecutor(originalRpc, journal, new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 2n,
    exitReserveLamports: 1n,
  });
  const input = {
    order: order('BUY', wallet.publicKey.toBase58(), { mint: MINT.toBase58(), quoteBudgetRaw: '1000000', tokenProgram: TOKEN_PROGRAM_ID.toBase58() }),
    instructions, allowedAccounts, maxSpendRaw: state.quote.amountInRaw,
    maxTokenAmountRaw: state.quote.amountOutRaw, positionRemainingRaw: 0n,
  } as const;
  const submitted = await originalExecutor.execute(input);
  assert.equal(submitted.status, 'UNKNOWN');
  const persisted = journal.orders.get(submitted.orderId);
  assert.ok(persisted?.signedTransaction);
  const originalBytes = Uint8Array.from(persisted.signedTransaction);

  const recoveryRpc = new FakeRpc(wallet.publicKey.toBase58(), 'unknown', () => undefined, submitted.signature);
  const recovery = new LiveTransactionExecutor(recoveryRpc, journal, new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 1n,
    exitReserveLamports: 1n,
  });
  const resumed = await recovery.resume({ ...persisted.order, status: 'UNKNOWN', signature: submitted.signature,
    signedTransaction: persisted.signedTransaction });
  assert.equal(resumed.status, 'UNKNOWN');
  assert.equal(recoveryRpc.sentBytes.length, 0);
  assert.deepEqual([...persisted.signedTransaction], [...originalBytes]);
  assert.ok(journal.events.includes(`unknown:${submitted.orderId}`));
});

void test('final compiled BUY message priority fee uses exact ceiling and rejects over-cap before signer or send', async () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(25));
  const market = await accounts();
  const provider = new PumpFunPaperQuoteProvider(new FakeReader(market.snapshots), () => 1_700_000_000_000);
  const state = await provider.quoteAndState({
    mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 100n,
  });
  const tradeInstructions = await createPumpFunBondingCurveInstructions({
    side: 'BUY', quoteAndState: state, associatedUserAccountInfo: null, user: wallet.publicKey,
  });
  const withBuilderFee = [
    ...tradeInstructions,
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 6 }),
  ];
  const allowedAccounts = new Set([wallet.publicKey.toBase58(), ...withBuilderFee.flatMap((ix) => [
    ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58()),
  ])]);
  const input = {
    order: order('BUY', wallet.publicKey.toBase58(), { mint: MINT.toBase58(), quoteBudgetRaw: '1000000', tokenProgram: TOKEN_PROGRAM_ID.toBase58() }),
    instructions: withBuilderFee, allowedAccounts, maxSpendRaw: state.quote.amountInRaw,
    maxTokenAmountRaw: state.quote.amountOutRaw, positionRemainingRaw: 0n,
  } as const;

  const rejectedJournal = new MemoryJournal();
  const rejectedRpc = new FakeRpc(wallet.publicKey.toBase58());
  const rejectedSigner = new KeypairLiveSigner(wallet);
  let rejectedSignatures = 0;
  const originalSign = rejectedSigner.sign.bind(rejectedSigner);
  rejectedSigner.sign = (transaction): ReturnType<KeypairLiveSigner['sign']> => {
    rejectedSignatures += 1;
    return originalSign(transaction);
  };
  const tooLow = new LiveTransactionExecutor(rejectedRpc, rejectedJournal, rejectedSigner, {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 1n,
    exitReserveLamports: 1n,
  });
  await assert.rejects(tooLow.execute(input), /priority fee.*2 lamports.*1 lamports/iu);
  assert.equal(rejectedSignatures, 0);
  assert.equal(rejectedRpc.sentBytes.length, 0);
  assert.equal(rejectedJournal.events.some((event) => event.startsWith('prepare:')), false);

  // The same final instructions are admitted when the explicit cap is raised to the computed 2 lamports.
  const admittedRpc = new FakeRpc(wallet.publicKey.toBase58());
  const admitted = new LiveTransactionExecutor(admittedRpc, new MemoryJournal(), new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 2n,
    exitReserveLamports: 1n,
  });
  assert.equal((await admitted.execute(input)).status, 'CONFIRMED');
  assert.equal(admittedRpc.sentBytes.length, 1);
});

void test('integer priority-fee rounding admits below and exactly at cap and rejects malformed budget requests', async () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(26));
  const market = await accounts();
  const provider = new PumpFunPaperQuoteProvider(new FakeReader(market.snapshots), () => 1_700_000_000_000);
  const state = await provider.quoteAndState({
    mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 100n,
  });
  const trade = await createPumpFunBondingCurveInstructions({ side: 'BUY', quoteAndState: state, associatedUserAccountInfo: null, user: wallet.publicKey });
  const executeWithPrice = async (microLamports: number, cap: bigint, units: number | null = 200_000): Promise<{ result: string; sends: number }> => {
    const instructions = [
      ...(units === null ? [] : [ComputeBudgetProgram.setComputeUnitLimit({ units })]),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...trade,
    ];
    const rpc = new FakeRpc(wallet.publicKey.toBase58());
    const executor = new LiveTransactionExecutor(rpc, new MemoryJournal(), new KeypairLiveSigner(wallet), {
      commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: cap,
      exitReserveLamports: 1n,
    });
    try {
      const result = await executor.execute({
        order: order('BUY', wallet.publicKey.toBase58(), { mint: MINT.toBase58(), quoteBudgetRaw: '1000000', tokenProgram: TOKEN_PROGRAM_ID.toBase58() }),
        instructions, allowedAccounts: new Set([wallet.publicKey.toBase58(), ...instructions.flatMap((ix) => [
          ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58()),
        ])]), maxSpendRaw: state.quote.amountInRaw, maxTokenAmountRaw: state.quote.amountOutRaw, positionRemainingRaw: 0n,
      });
      return { result: result.status, sends: rpc.sentBytes.length };
    } catch (error) {
      if (error instanceof Error && error.message.includes('priority fee')) return { result: 'REJECTED', sends: rpc.sentBytes.length };
      throw error;
    }
  };
  assert.deepEqual(await executeWithPrice(1, 2n), { result: 'CONFIRMED', sends: 1 }); // ceil(200000 / 1,000,000) = 1 lamport
  assert.deepEqual(await executeWithPrice(5, 1n), { result: 'CONFIRMED', sends: 1 }); // exactly 1 lamport
  assert.deepEqual(await executeWithPrice(6, 1n), { result: 'REJECTED', sends: 0 }); // ceil(1.2) = 2 lamports
  assert.deepEqual(await executeWithPrice(1, 1n, null), { result: 'CONFIRMED', sends: 1 }); // default upper bound: 2 instructions × 200k CU

  const malformed = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
  const broken = new TransactionInstruction({ programId: malformed.programId, keys: malformed.keys, data: Buffer.from([3, 1]) });
  const brokenInstructions = [broken, ...trade];
  const rpc = new FakeRpc(wallet.publicKey.toBase58());
  const executor = new LiveTransactionExecutor(rpc, new MemoryJournal(), new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 1n,
    exitReserveLamports: 1n,
  });
  await assert.rejects(executor.execute({
    order: order('BUY', wallet.publicKey.toBase58(), { mint: MINT.toBase58(), quoteBudgetRaw: '1000000', tokenProgram: TOKEN_PROGRAM_ID.toBase58() }),
    instructions: brokenInstructions,
    allowedAccounts: new Set([wallet.publicKey.toBase58(), ...brokenInstructions.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58())])]),
    maxSpendRaw: state.quote.amountInRaw, maxTokenAmountRaw: state.quote.amountOutRaw, positionRemainingRaw: 0n,
  }), /Compute Budget instruction/u);
  assert.equal(rpc.sentBytes.length, 0);

  const tipInstructions = [...trade, SystemProgram.transfer({
    fromPubkey: wallet.publicKey, toPubkey: Keypair.fromSeed(new Uint8Array(32).fill(28)).publicKey, lamports: 1n,
  })];
  await assert.rejects(executor.execute({
    order: order('BUY', wallet.publicKey.toBase58(), { mint: MINT.toBase58(), quoteBudgetRaw: '1000000', tokenProgram: TOKEN_PROGRAM_ID.toBase58() }),
    instructions: tipInstructions,
    allowedAccounts: new Set([wallet.publicKey.toBase58(), ...tipInstructions.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((key) => key.pubkey.toBase58())])]),
    maxSpendRaw: state.quote.amountInRaw, maxTokenAmountRaw: state.quote.amountOutRaw, positionRemainingRaw: 0n,
  }), /transfers and tips are not authorized/u);
  assert.equal(rpc.sentBytes.length, 0);
});

let nextOrder = 0;
function order(side: 'BUY' | 'SELL', wallet: string, intent: Readonly<Record<string, unknown>>) {
  return {
    orderId: `${side.toLowerCase()}-${++nextOrder}`,
    wallet, positionId: 'position-1', side, intent, validity: { commitment: 'confirmed' },
  } as const;
}

class FakeRpc {
  public readonly sentSignatures: string[] = [];
  public readonly sentBytes: Uint8Array[] = [];
  private lastSignature: string | null = null;
  private statusChecks = 0;
  public balanceLamports = 1_000_000_000;
  public balanceReads = 0;
  public balanceUnavailable = false;
  public balanceObservedAtMs = Date.now();
  public feeLamports: number | null = 5_000;
  public feeContextSlot = 700;
  public feeObservedAtMs = Date.now();
  public rentLamports = 0;
  public constructor(
    private readonly wallet: string,
    private readonly mode: 'confirmed' | 'unknown' | 'late' = 'confirmed',
    private readonly onSend: (signature: string) => void = () => undefined,
    private readonly expectedSignature: string | null = null,
  ) {}
  public async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 500 };
  }
  public async getWalletBalance(wallet: string) {
    assert.equal(wallet, this.wallet);
    this.balanceReads += 1;
    return this.balanceUnavailable ? null : { lamports: BigInt(this.balanceLamports), contextSlot: 700n, observedAtMs: this.balanceObservedAtMs };
  }
  public async getMessageFee() {
    return this.feeLamports === null ? null : { lamports: BigInt(this.feeLamports), contextSlot: BigInt(this.feeContextSlot), observedAtMs: this.feeObservedAtMs };
  }
  public async getTokenAccountRentExemption(): Promise<bigint | null> { return BigInt(this.rentLamports); }
  public async sendRawTransaction(bytes: Uint8Array): Promise<string> {
    const transaction = VersionedTransaction.deserialize(bytes);
    const payer = transaction.message.staticAccountKeys[0];
    assert.ok(payer);
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), payer.toBuffer()]),
      format: 'der', type: 'spki',
    });
    const signature=transaction.signatures[0];
    assert.ok(signature);
    assert.equal(verify(null, transaction.message.serialize(), publicKey, signature), true);
    this.lastSignature = bs58.encode(signature);
    this.sentSignatures.push(this.lastSignature);
    this.sentBytes.push(Uint8Array.from(bytes));
    this.onSend(this.lastSignature);
    return this.lastSignature;
  }
  public async getSignatureStatus(signature: string): Promise<null | { confirmationStatus: 'confirmed'; err: null }> {
    assert.equal(signature, this.lastSignature ?? this.expectedSignature);
    this.statusChecks += 1;
    if (this.mode === 'unknown' || (this.mode === 'late' && this.statusChecks === 1)) return null;
    return { confirmationStatus: 'confirmed', err: null };
  }
  public async getBlockHeight(): Promise<number> { return 400; }
  public async getTransaction(signature: string): Promise<null | { slot: number; meta: { err: null; fee: number; preTokenBalances: unknown[]; postTokenBalances: unknown[] } }> {
    assert.equal(signature, this.lastSignature ?? this.expectedSignature);
    return this.mode === 'unknown' ? null : { slot: 700, meta: {
      err: null, fee: 5_000,
      preTokenBalances: [],
      postTokenBalances: [{ owner: this.wallet, mint: MINT.toBase58(), uiTokenAmount: { amount: '12345' } }],
    } };
  }
}

class MemoryJournal {
  public readonly events: string[] = [];
  public readonly orders = new Map<string, { order: ReturnType<typeof order>; signature: string | null; signedTransaction: Uint8Array | null }>();
  public async prepare(input: ReturnType<typeof order>): Promise<void> { this.events.push(`prepare:${input.orderId}`); this.orders.set(input.orderId, { order: input, signature: null, signedTransaction: null }); }
  public async persistSigned(orderId: string, signature: string, bytes: Uint8Array): Promise<void> {
    this.events.push(`signed:${signature}`); this.events.push(`bytes:${orderId}`);
    const current = this.orders.get(orderId);
    assert.ok(current);
    this.orders.set(orderId, { ...current, signature, signedTransaction: Uint8Array.from(bytes) });
  }
  public async markSubmitted(orderId: string): Promise<void> { this.events.push(`submitted:${orderId}`); }
  public async markUnknown(orderId: string): Promise<void> { this.events.push(`unknown:${orderId}`); }
  public async resolve(orderId: string, status: 'CONFIRMED' | 'FAILED' | 'EXPIRED'): Promise<void> { this.events.push(`${status.toLowerCase()}:${orderId}`); }
}
