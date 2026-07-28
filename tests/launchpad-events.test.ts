import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
  UnsupportedLaunchParameterValueError,
} from '../src/domain/launchpad-events.js';
import type {
  LaunchpadTrade,
  ObservedChainTransaction,
  QuoteAsset,
  TokenLaunch,
} from '../src/domain/types.js';

const PROGRAM = 'Pump111111111111111111111111111111111111111';
const SOL: QuoteAsset = {
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
  tokenProgram: 'SPL_TOKEN',
};
const USDC: QuoteAsset = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  tokenProgram: 'SPL_TOKEN',
};
const transaction: ObservedChainTransaction = {
  signature: '5NfSignature',
  confirmationStatus: 'processed',
  blockTimeMs: 1_753_700_000_000,
  observedAtMs: 1_753_700_000_500,
  cursor: { slot: 123n, transactionIndex: 9 },
  raw: null,
};
const launch: TokenLaunch = {
  mint: 'Mint111111111111111111111111111111111111111',
  creator: 'Creator111111111111111111111111111111111111',
  tokenProgram: 'SPL_TOKEN',
  quoteAssets: [SOL, USDC],
  launchpad: 'pumpfun',
  createdAt: {
    ...transaction.cursor,
    instructionIndex: 2,
    innerInstructionIndex: null,
  },
  parameters: { cashback: false, mayhem: false },
};
const trade: LaunchpadTrade = {
  id: 'adapter-trade-id',
  launchMint: launch.mint,
  kind: 'BUY',
  trader: 'Buyer11111111111111111111111111111111111111',
  baseAmountRaw: 1_000_000n,
  quoteAmountRaw: 250_000_000n,
  quoteAsset: SOL,
  cursor: {
    ...transaction.cursor,
    instructionIndex: 3,
    innerInstructionIndex: 0,
  },
};

void test('construit des événements V1 typés sans perdre le multi-quote', () => {
  const launchEvent = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    launch,
  });
  const tradeEvent = createBondingCurveTradeObservedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    trade,
  });

  assert.equal(launchEvent.type, 'TokenLaunchDetected');
  assert.equal(launchEvent.payloadVersion, 1);
  const launchPayloadVersion: 1 = launchEvent.payloadVersion;
  assert.equal(launchPayloadVersion, 1);
  assert.deepEqual(launchEvent.payload.launch.quoteAssets, [SOL, USDC]);
  assert.equal(tradeEvent.type, 'BondingCurveTradeObserved');
  assert.equal(tradeEvent.payloadVersion, 1);
  const tradePayloadVersion: 1 = tradeEvent.payloadVersion;
  assert.equal(tradePayloadVersion, 1);
  assert.equal(tradeEvent.payload.trade.quoteAmountRaw, 250_000_000n);
});

void test('conserve le même ID lors d’une montée de confirmation et d’un nouveau relevé temporel', () => {
  const processed = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    launch,
  });
  const finalized = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction: {
      ...transaction,
      confirmationStatus: 'finalized',
      blockTimeMs: 1_753_700_060_000,
      observedAtMs: transaction.observedAtMs + 60_000,
    },
    launch,
  });

  assert.equal(processed.id, finalized.id);
  assert.equal(finalized.confirmationStatus, 'finalized');
});

void test('snapshotte les entrées mutables pour conserver l’événement et son identité', () => {
  const mutableQuoteAsset = { ...SOL };
  const mutableLaunchCursor = {
    ...transaction.cursor,
    instructionIndex: 2,
    innerInstructionIndex: null,
  };
  const mutableParameterObject = { amount: 1n };
  const mutableParameters = {
    metadata: {
      verified: true,
      values: [1n, mutableParameterObject],
    },
  };
  const mutableLaunch = {
    mint: launch.mint,
    creator: launch.creator,
    tokenProgram: launch.tokenProgram,
    quoteAssets: [mutableQuoteAsset],
    launchpad: launch.launchpad,
    createdAt: mutableLaunchCursor,
    parameters: mutableParameters,
  };
  const mutableTradeCursor = {
    ...transaction.cursor,
    instructionIndex: 3,
    innerInstructionIndex: 0,
  };
  const mutableTrade = {
    ...trade,
    quoteAsset: mutableQuoteAsset,
    cursor: mutableTradeCursor,
  };
  const launchEvent = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    launch: mutableLaunch,
  });
  const tradeEvent = createBondingCurveTradeObservedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    trade: mutableTrade,
  });
  const launchId = launchEvent.id;
  const tradeId = tradeEvent.id;

  mutableLaunchCursor.instructionIndex = 99;
  mutableQuoteAsset.mint = 'ChangedQuoteMint';
  mutableParameters.metadata.verified = false;
  mutableParameterObject.amount = 2n;
  mutableTradeCursor.innerInstructionIndex = 8;

  assert.equal(launchEvent.id, launchId);
  assert.equal(launchEvent.cursor.instructionIndex, 2);
  assert.equal(launchEvent.payload.launch.createdAt.instructionIndex, 2);
  const snapshottedLaunchQuote = launchEvent.payload.launch.quoteAssets[0];
  assert.ok(snapshottedLaunchQuote);
  assert.equal(snapshottedLaunchQuote.mint, SOL.mint);
  assert.deepEqual(launchEvent.payload.launch.parameters, {
    metadata: { verified: true, values: [1n, { amount: 1n }] },
  });
  assert.ok(Object.isFrozen(launchEvent.payload.launch.parameters));
  const snapshottedMetadata = launchEvent.payload.launch.parameters.metadata;
  assert.ok(snapshottedMetadata && typeof snapshottedMetadata === 'object');
  assert.ok(Object.isFrozen(snapshottedMetadata));
  const snapshottedValues = snapshottedMetadata.values;
  assert.ok(Array.isArray(snapshottedValues));
  assert.ok(Object.isFrozen(snapshottedValues));
  assert.ok(Object.isFrozen(launchEvent.payload));
  assert.equal(tradeEvent.id, tradeId);
  assert.equal(tradeEvent.cursor.innerInstructionIndex, 0);
  assert.equal(tradeEvent.payload.trade.cursor.innerInstructionIndex, 0);
  assert.equal(tradeEvent.payload.trade.quoteAsset.mint, SOL.mint);
  assert.ok(Object.isFrozen(tradeEvent.payload));
});

void test('rejette les valeurs de paramètres non normalisées avec leur chemin', () => {
  for (const invalidValue of [
    new Uint8Array([1]),
    new Map([['value', 1]]),
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
    Symbol('parameter'),
    () => undefined,
  ]) {
    assert.throws(
      () => createTokenLaunchDetectedEvent({
        source: 'pumpfun',
        program: PROGRAM,
        transaction,
        launch: {
          ...launch,
          parameters: { invalid: invalidValue } as unknown as TokenLaunch['parameters'],
        },
      }),
      (error: unknown) =>
        error instanceof UnsupportedLaunchParameterValueError
        && error.message.includes('parameters.invalid'),
    );
  }
});

void test('préserve __proto__ comme donnée propre et rejette les clés ou structures non normalisées', () => {
  const protoParameter: Record<string, unknown> = {};
  Object.defineProperty(protoParameter, '__proto__', {
    value: 'preserved', enumerable: true, configurable: true, writable: true,
  });
  const protoEvent = createTokenLaunchDetectedEvent({
    source: 'pumpfun', program: PROGRAM, transaction,
    launch: { ...launch, parameters: protoParameter as TokenLaunch['parameters'] },
  });
  assert.equal(Object.getPrototypeOf(protoEvent.payload.launch.parameters), Object.prototype);
  assert.equal(Object.hasOwn(protoEvent.payload.launch.parameters, '__proto__'), true);
  assert.equal(protoEvent.payload.launch.parameters.__proto__, 'preserved');

  const symbolParameter = Symbol('hidden');
  const withSymbolKey = { valid: true, [symbolParameter]: true };
  const sparse = [1] as unknown[];
  sparse.length = 2;
  const objectCycle: Record<string, unknown> = {};
  objectCycle.self = objectCycle;
  const arrayCycle: unknown[] = [];
  arrayCycle.push(arrayCycle);
  for (const invalidValue of [withSymbolKey, sparse, objectCycle, arrayCycle]) {
    assert.throws(
      () => createTokenLaunchDetectedEvent({
        source: 'pumpfun', program: PROGRAM, transaction,
        launch: { ...launch, parameters: { invalid: invalidValue } as TokenLaunch['parameters'] },
      }),
      (error: unknown) =>
        error instanceof UnsupportedLaunchParameterValueError
        && error.path.startsWith('parameters.invalid'),
    );
  }
});
