import assert from 'node:assert/strict';
import test from 'node:test';
import { LaunchpadObservationService } from '../src/application/launchpad-observation.service.js';
import { PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ADDRESS } from '../src/launchpads/pumpfun/constants.js';
import {
  createPumpFunObservedTransaction,
  PumpFunLaunchpadAdapter,
} from '../src/launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import type { DecodedPumpTransaction } from '../src/launchpads/pumpfun/types.js';
import type { BondingCurveState, TokenLaunch } from '../src/domain/types.js';
import type { LaunchpadEventSink } from '../src/ports/launchpad-event-sink.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';

const MINT = 'Mint111111111111111111111111111111111111111';
const CREATOR = 'Creator111111111111111111111111111111111111';
const USER = 'User111111111111111111111111111111111111111';
const QUOTE = 'Quote11111111111111111111111111111111111111';

void test('projette création et achat initial via le service sans double décodage', async () => {
  const raw = transaction();
  const observed = createPumpFunObservedTransaction(raw, 2_000);
  let decodeCalls = 0;
  const adapter = new PumpFunLaunchpadAdapter(
    { read: async (launch) => curveState(launch) },
    () => {
      decodeCalls += 1;
      return decoded(raw);
    },
  );
  const sink = new RecordingSink();
  const service = new LaunchpadObservationService(adapter, sink);

  await service.observe(observed, new Set());

  assert.equal(decodeCalls, 1);
  assert.deepEqual(sink.events.map((event) => event.type), [
    'TokenLaunchDetected',
    'BondingCurveTradeObserved',
  ]);
  assert.equal(sink.events[0]?.mint, MINT);
  assert.equal(sink.events[1]?.payload.trade?.trader, CREATOR);
  const launch = sink.events[0]?.payload.launch;
  assert.equal(launch?.quoteAssets.length, 1);
  assert.deepEqual(launch?.quoteAssets[0], {
    mint: QUOTE,
    decimals: 6,
    tokenProgram: 'SPL_TOKEN',
  });
  assert.deepEqual(launch?.parameters, {
    instruction: 'create_v2',
    name: 'Éclair',
    symbol: 'ECL',
    uri: 'ipfs://metadata',
    bondingCurve: 'Curve1111111111111111111111111111111111111',
    user: USER,
    blockchainTimestampSeconds: 1_700_000_000n,
    virtualTokenReservesRaw: 1_000n,
    virtualQuoteReservesRaw: 2_000n,
    realTokenReservesRaw: 900n,
    tokenTotalSupplyRaw: 1_000n,
    mayhem: true,
    cashback: true,
    rawQuoteMint: QUOTE,
    trailingEventDataHex: '',
  });
  assert.equal(sink.events[1]?.payload.trade.baseAmountRaw, 50n);
  assert.equal(sink.events[1]?.payload.trade.quoteAmountRaw, 75n);
});

void test('filtre les trades non suivis et délègue la lecture de courbe', async () => {
  const raw = transaction();
  let requestedLaunch: TokenLaunch | null = null;
  const adapter = new PumpFunLaunchpadAdapter({
    read: async (launch) => {
      requestedLaunch = launch;
      return curveState(launch);
    },
  }, () => decoded(raw));
  const observed = createPumpFunObservedTransaction(raw, 2_000);

  assert.deepEqual(await adapter.decodeTrades(observed, new Set()), []);
  const [launch] = await adapter.detectLaunches(observed);
  assert.ok(launch);
  const [trade] = await adapter.decodeTrades(observed, new Set([MINT]));
  assert.equal(trade?.launchMint, MINT);
  const state = await adapter.readBondingCurveState(launch);
  assert.equal(state.launchMint, MINT);
  assert.equal(requestedLaunch, launch);
});

void test('construit une enveloppe immuable cohérente avec la transaction brute', () => {
  const observed = createPumpFunObservedTransaction(transaction(), 2_000);
  assert.equal(observed.confirmationStatus, 'confirmed');
  assert.equal(observed.cursor.transactionIndex, 4);
  assert.ok(Object.isFrozen(observed));
  assert.throws(
    () => createPumpFunObservedTransaction(transaction({ transactionIndex: null }), 2_000),
    /index canonique/,
  );
});

class RecordingSink implements LaunchpadEventSink {
  public events: readonly { readonly type: string; readonly mint: string; readonly payload: { readonly launch?: TokenLaunch; readonly trade?: { readonly trader: string | null; readonly baseAmountRaw: bigint; readonly quoteAmountRaw: bigint } } }[] = [];

  public readonly record: LaunchpadEventSink['record'] = async (batch) => {
    this.events = batch.events;
    return {
      events: batch.events.map((event) => ({ eventId: event.id, outcome: 'created' })),
      affectedMints: [...new Set(batch.events.map((event) => event.mint))].sort(),
    };
  };
}

function transaction(
  override: Partial<NormalizedTransaction> = {},
): NormalizedTransaction {
  return {
    signature: 'adapter-signature',
    slot: 100n,
    transactionIndex: 4,
    confirmationStatus: 'CONFIRMED',
    version: 'legacy',
    blockTimeMs: 1_700_000_000_000,
    accountKeys: [],
    signerKeys: [],
    instructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
    preBalancesLamports: [],
    postBalancesLamports: [],
    feeLamports: 0n,
    computeUnits: null,
    logs: [],
    error: null,
    ...override,
  };
}

function decoded(raw: NormalizedTransaction): DecodedPumpTransaction {
  const quoteAsset = Object.freeze({ mint: QUOTE, decimals: 6, tokenProgram: 'SPL_TOKEN' as const });
  const creation = Object.freeze({
    action: Object.freeze({
      name: 'create_v2' as const,
      family: 'CREATE' as const,
      instruction: instruction(2),
      accounts: Object.freeze({ mint: MINT }),
      args: Object.freeze({}),
    }),
    event: Object.freeze({
      name: 'Éclair', symbol: 'ECL', uri: 'ipfs://metadata', mint: MINT,
      bondingCurve: 'Curve1111111111111111111111111111111111111', user: USER,
      creator: CREATOR, timestamp: 1_700_000_000n, virtualTokenReserves: 1_000n,
      virtualSolReserves: 2_000n, realTokenReserves: 900n,
      tokenTotalSupply: 1_000n, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      isMayhemMode: true, isCashbackEnabled: true, quoteMint: QUOTE,
      virtualQuoteReserves: 2_000n,
    }),
    eventCpi: Object.freeze({ kind: 'CREATE' as const, event: undefined as never, instruction: instruction(2, 0), trailingDataHex: '' }),
    quoteAsset,
  });
  const trade = Object.freeze({
    action: Object.freeze({
      name: 'buy_v2' as const, family: 'BUY' as const, instruction: instruction(3),
      accounts: Object.freeze({}), args: Object.freeze({}),
    }),
    event: Object.freeze({
      mint: MINT, solAmount: 75n, tokenAmount: 50n, isBuy: true, user: CREATOR,
      timestamp: 1_700_000_001n, virtualSolReserves: 2_075n,
      virtualTokenReserves: 950n, realSolReserves: 75n, realTokenReserves: 850n,
      feeRecipient: USER, feeBasisPoints: 0n, fee: 0n, creator: CREATOR,
      creatorFeeBasisPoints: 0n, creatorFee: 0n, trackVolume: true,
      totalUnclaimedTokens: 0n, totalClaimedTokens: 0n, currentSolVolume: 0n,
      lastUpdateTimestamp: 1_700_000_001n, ixName: 'buy', mayhemMode: true,
      cashbackFeeBasisPoints: 0n, cashback: 0n, buybackFeeBasisPoints: 0n,
      buybackFee: 0n, shareholders: Object.freeze([]), quoteMint: QUOTE,
      quoteAmount: 75n, virtualQuoteReserves: 2_075n, realQuoteReserves: 75n,
    }),
    eventCpi: Object.freeze({ kind: 'TRADE' as const, event: undefined as never, instruction: instruction(3, 0), trailingDataHex: '' }),
    quoteAsset,
  });
  return Object.freeze({
    transaction: raw,
    creations: Object.freeze([creation]),
    trades: Object.freeze([trade]),
    migrations: Object.freeze([]),
  }) as DecodedPumpTransaction;
}

function instruction(instructionIndex: number, innerInstructionIndex: number | null = null) {
  return Object.freeze({
    programId: PUMP_PROGRAM_ID, accounts: Object.freeze([]), data: new Uint8Array(),
    instructionIndex, innerInstructionIndex,
    parentInstructionIndex: innerInstructionIndex === null ? null : instructionIndex,
    stackHeight: innerInstructionIndex === null ? 1 : 2,
  });
}

function curveState(launch: TokenLaunch): BondingCurveState {
  const quoteAsset = launch.quoteAssets[0];
  if (quoteAsset === undefined) throw new Error('Quote asset de test absent.');
  return {
    launchMint: launch.mint, quoteAsset,
    realBaseReservesRaw: 1n, realQuoteReservesRaw: 2n,
    virtualBaseReservesRaw: 3n, virtualQuoteReservesRaw: 4n,
    progressBps: 5n, complete: false, observedSlot: 100n,
  };
}
