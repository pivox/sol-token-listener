import assert from 'node:assert/strict';
import test from 'node:test';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { PUMP_PROGRAM_ID, WSOL_MINT } from '../src/launchpads/pumpfun/constants.js';
import { PUMP_SDK } from '../src/launchpads/pumpfun/official-sdk.js';
import type { MarketQuote } from '../src/domain/market.js';
import { createPumpFunBondingCurveInstructions } from '../src/live/pumpfun-bonding-curve-instructions.js';
import { PumpFunPaperQuoteProvider } from '../src/paper/pumpfun-paper-quote.provider.js';
import type { PumpFunQuoteAndState } from '../src/paper/pumpfun-paper-quote.provider.js';
import { accounts, FakeReader, MINT, NOW, quoteAsset, SLOT } from './helpers/pumpfun-paper-quote-state.js';

void test('builds a Pump.fun V2 BUY with the locked SDK from quote-aligned state', async () => {
  const state = await accounts();
  const quote = marketQuote({
    inputMint: WSOL_MINT,
    outputMint: MINT.toBase58(),
    amountInRaw: 10_000_000n,
    amountOutRaw: 80_000_000n,
    minimumAmountOutRaw: 79_200_000n,
    slippageBps: 100n,
  });

  const instructions = await createPumpFunBondingCurveInstructions({
    side: 'BUY',
    quoteAndState: instructionState(quote, state),
    associatedUserAccountInfo: null,
    user: new PublicKey(new Uint8Array(32).fill(4)),
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  });

  assert.equal(instructions.length, 2, 'a missing ATA is created idempotently before the V2 buy');
  const buyInstruction=instructions[1];
  if(buyInstruction===undefined)throw new Error('Pump.fun V2 BUY instruction is missing.');
  assert.equal(buyInstruction.programId.toBase58(), PUMP_PROGRAM_ID);
  assert.equal(buyInstruction.data.length, 24, 'the V2 buy carries the expected discriminator and two u64 values');
  assert.equal(buyInstruction.data.readBigUInt64LE(8), 79_200_000n, 'BUY minimum base amount is the quote floor');
  assert.ok(buyInstruction.data.readBigUInt64LE(16) <= quote.amountInRaw, 'SDK-adjusted BUY cap stays within the quote budget');
  const sdk = PUMP_SDK as unknown as { offlinePumpProgram: { coder: { instruction: { decode(data: Buffer): { name: string } | null } } } };
  assert.equal(sdk.offlinePumpProgram.coder.instruction.decode(buyInstruction.data)?.name, 'buyV2');
});

void test('refuses a quote calculated from another slot before building instructions', async () => {
  const state = await accounts();
  await assert.rejects(
    createPumpFunBondingCurveInstructions({
      side: 'SELL',
      quoteAndState: instructionState(marketQuote({
        inputMint: MINT.toBase58(),
        outputMint: WSOL_MINT,
        amountInRaw: 10_000n,
        amountOutRaw: 1_000_000n,
        minimumAmountOutRaw: 990_000n,
        slippageBps: 100n,
      }), state, SLOT + 1n),
      associatedUserAccountInfo: null,
      user: new PublicKey(new Uint8Array(32).fill(4)),
      quoteTokenProgram: PublicKey.default,
    }),
    /same slot/u,
  );
});

void test('refuses quote minima that do not match the configured slippage arithmetic', async () => {
  const state = await accounts();
  await assert.rejects(
    createPumpFunBondingCurveInstructions({
      side: 'BUY',
      quoteAndState: instructionState(marketQuote({
        inputMint: WSOL_MINT, outputMint: MINT.toBase58(), amountInRaw: 10_000_000n,
        amountOutRaw: 80_000_000n, minimumAmountOutRaw: 79_000_000n, slippageBps: 100n,
      }), state),
      associatedUserAccountInfo: null, user: new PublicKey(new Uint8Array(32).fill(4)),
    }),
    /minimum output does not match/u,
  );
});

void test('builds a Pump.fun V2 SELL with the quote minimum enforced by the SDK', async () => {
  const state = await accounts();
  const quote = marketQuote({
    inputMint: MINT.toBase58(),
    outputMint: WSOL_MINT,
    amountInRaw: 10_000n,
    amountOutRaw: 1_000_000n,
    minimumAmountOutRaw: 990_000n,
    slippageBps: 100n,
  });
  const instructions = await createPumpFunBondingCurveInstructions({
    side: 'SELL', quoteAndState: instructionState(quote, state), associatedUserAccountInfo: null,
    user: new PublicKey(new Uint8Array(32).fill(4)),
  });

  assert.equal(instructions.length, 1);
  const sellInstruction=instructions[0];
  if(sellInstruction===undefined)throw new Error('Pump.fun V2 SELL instruction is missing.');
  assert.equal(sellInstruction.programId.toBase58(), PUMP_PROGRAM_ID);
  assert.equal(sellInstruction.data.readBigUInt64LE(8), 10_000n, 'SELL quantity is the full quoted token amount');
  assert.equal(sellInstruction.data.readBigUInt64LE(16), quote.minimumAmountOutRaw, 'SELL min output matches the quote floor');
  const sdk = PUMP_SDK as unknown as { offlinePumpProgram: { coder: { instruction: { decode(data: Buffer): { name: string } | null } } } };
  assert.equal(sdk.offlinePumpProgram.coder.instruction.decode(sellInstruction.data)?.name, 'sellV2');
});

void test('Pump.fun V2 SELL for current cashback state carries the pinned SDK accumulator account', async () => {
  const state=await accounts({isCashbackCoin:true});
  const user=new PublicKey(new Uint8Array(32).fill(7));
  const quote=marketQuote({inputMint:MINT.toBase58(),outputMint:WSOL_MINT,amountInRaw:10_000n,
    amountOutRaw:1_000_000n,minimumAmountOutRaw:990_000n,slippageBps:100n});
  const quoteState=instructionState(quote,state);
  const instructions=await createPumpFunBondingCurveInstructions({side:'SELL',quoteAndState:quoteState,
    associatedUserAccountInfo:null,user});
  const sell=instructions[0];
  if(sell===undefined)throw new Error('Pump.fun V2 cashback SELL instruction is missing.');
  const sdk=PUMP_SDK as unknown as {offlinePumpProgram:{idl:{instructions:readonly {name:string;accounts:readonly {name:string}[]}[]}}};
  const sellIdl=sdk.offlinePumpProgram.idl.instructions.find((instruction)=>instruction.name==='sellV2');
  const accountIndex=sellIdl?.accounts.findIndex((account)=>account.name==='associatedUserVolumeAccumulator')??-1;
  assert.ok(accountIndex>=0,'pinned sell_v2 IDL names the fixed accumulator ATA account');
  const [accumulator]=PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'),user.toBuffer()],new PublicKey(PUMP_PROGRAM_ID));
  const expectedAta=getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT),accumulator,true,TOKEN_PROGRAM_ID);
  assert.equal(sell.keys[accountIndex]?.pubkey.toBase58(),expectedAta.toBase58());
  assert.equal(sell.keys[accountIndex]?.isWritable,true);
  assert.equal(quoteState.admissionEvidence.isCashbackCoin,true,'status came from current quote state, not the entry intent');
});

void test('Pump.fun SELL refuses cashback evidence that is absent or contradicts current decoded curve state', async () => {
  const state=await accounts({isCashbackCoin:true});
  const quote=marketQuote({inputMint:MINT.toBase58(),outputMint:WSOL_MINT,amountInRaw:10_000n,
    amountOutRaw:1_000_000n,minimumAmountOutRaw:990_000n,slippageBps:100n});
  const quoteState=instructionState(quote,state);
  await assert.rejects(createPumpFunBondingCurveInstructions({side:'SELL',
    quoteAndState:{...quoteState,admissionEvidence:{...quoteState.admissionEvidence,isCashbackCoin:false}},
    associatedUserAccountInfo:null,user:new PublicKey(new Uint8Array(32).fill(8))}),/current Pump.fun cashback state/u);
});

void test('refuses the migrated curve because this first profile has no PumpSwap SELL route', async () => {
  const state = await accounts({ complete: true });
  await assert.rejects(
    createPumpFunBondingCurveInstructions({
      side: 'SELL', quoteAndState: instructionState(marketQuote({
        inputMint: MINT.toBase58(), outputMint: WSOL_MINT, amountInRaw: 10_000n,
        amountOutRaw: 1_000_000n, minimumAmountOutRaw: 990_000n, slippageBps: 100n,
      }), state), associatedUserAccountInfo: null,
      user: new PublicKey(new Uint8Array(32).fill(4)),
    }),
    /migration route is unsupported/u,
  );
});

void test('the canonical quote producer returns the exact decoded state used for instruction construction', async () => {
  const state = await accounts();
  const provider = new PumpFunPaperQuoteProvider(new FakeReader(state.snapshots), () => 1_700_000_000_000);
  const result = await provider.quoteAndState({
    mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 100n,
  });
  const instructions = await createPumpFunBondingCurveInstructions({
    side: 'BUY', quoteAndState: result, associatedUserAccountInfo: null,
    user: new PublicKey(new Uint8Array(32).fill(4)),
  });

  assert.equal(result.quote.observedSlot, result.stateSlot);
  assert.equal(instructions[1]?.programId.toBase58(), PUMP_PROGRAM_ID);
});

function marketQuote(overrides: Pick<MarketQuote,
  'inputMint' | 'outputMint' | 'amountInRaw' | 'amountOutRaw' | 'minimumAmountOutRaw' | 'slippageBps'>): MarketQuote {
  return {
    id: 'fixture-quote', pool: 'PUMP_FUN_BONDING_CURVE', feesRaw: 0n, priceImpactBps: 0n,
    observedAtMs: 1_700_000_000_000, observedSlot: SLOT, stateReceivedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function accountInfo(snapshot: { owner: string; lamports: bigint; data: Uint8Array }): AccountInfo<Buffer> {
  return {
    owner: new PublicKey(snapshot.owner), lamports: Number(snapshot.lamports), data: Buffer.from(snapshot.data),
    executable: false, rentEpoch: 0,
  };
}

function instructionState(
  quote: MarketQuote,
  state: Awaited<ReturnType<typeof accounts>>,
  stateSlot = SLOT,
): PumpFunQuoteAndState {
  return {
    quote, mint: MINT, tokenProgram: new PublicKey(state.snapshots[3].owner), stateSlot,
    global: state.global, bondingCurve: state.curve,
    bondingCurveAccountInfo: accountInfo(state.snapshots[2]),
    admissionEvidence: {
      mint: MINT.toBase58(), tokenProgram: state.snapshots[3].owner, owner: state.snapshots[2].owner,
      layout: state.snapshots[2].data.length === 116 ? 'pump-sdk-1.36-bonding-curve-v2-holder-reward' : 'pump-sdk-1.36-bonding-curve-v2',
      slot: stateSlot, receivedAtMs: NOW, source: 'validated_getMultipleAccounts_same_slot',
      isCashbackCoin: state.snapshots[2].data[82] === 1, isHolderReward: state.snapshots[2].data.length === 116 && state.snapshots[2].data[115] === 1,
      mintExtensions: [],
    },
  };
}
