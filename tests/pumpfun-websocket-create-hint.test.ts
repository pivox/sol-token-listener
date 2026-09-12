import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { PUMP_EVENTS } from '../src/launchpads/pumpfun/generated/pump-idl.js';
import {
  MAX_PUMPFUN_WEBSOCKET_LOG_COUNT,
  MAX_PUMPFUN_WEBSOCKET_LOG_LINE_BYTES,
  MAX_PUMPFUN_WEBSOCKET_LOG_TOTAL_BYTES,
  PUMPFUN_WEBSOCKET_HINTS,
  pumpFunCreateHintFromLogs,
  pumpFunWebSocketHintFromLogs,
} from '../src/launchpads/pumpfun/websocket-create-hint.js';

const createLine = programDataLine(PUMP_EVENTS.CreateEvent.discriminator, [0, 1, 2, 3]);
const firstTradeMint = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const secondTradeMint = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 2));

void test('exports the exact closed hint vocabulary and creates frozen exact results', () => {
  assert.deepEqual(PUMPFUN_WEBSOCKET_HINTS, ['NONE', 'PUMPFUN_CREATE', 'PUMPFUN_TRADE']);
  assert.ok(Object.isFrozen(PUMPFUN_WEBSOCKET_HINTS));
  const createHint = pumpFunWebSocketHintFromLogs([createLine]);
  assert.deepEqual(createHint, { hint: 'PUMPFUN_CREATE', hintMint: null });
  assert.ok(Object.isFrozen(createHint));
  assert.deepEqual(Reflect.ownKeys(createHint), ['hint', 'hintMint']);
  assert.equal(pumpFunCreateHintFromLogs([createLine]), 'PUMPFUN_CREATE');
  assert.equal(pumpFunCreateHintFromLogs([
    programDataLine(PUMP_EVENTS.TradeEvent.discriminator, [0, 1, 2, 3]),
  ]), 'NONE');
  assert.equal(pumpFunCreateHintFromLogs([`Program log: ${createLine}`]), 'NONE');
});

void test('extracts the canonical mint from the 32 bytes after an official TradeEvent discriminator', () => {
  const hint = pumpFunWebSocketHintFromLogs([tradeLine(firstTradeMint)]);
  assert.deepEqual(hint, { hint: 'PUMPFUN_TRADE', hintMint: firstTradeMint.toBase58() });
  assert.ok(Object.isFrozen(hint));
});

void test('fails safe when a valid trade is followed by malformed Program data', () => {
  assert.deepEqual(
    pumpFunWebSocketHintFromLogs([tradeLine(firstTradeMint), 'Program data: not-base64']),
    { hint: 'NONE', hintMint: null },
  );
});

void test('fails safe when a valid trade is followed by a truncated TradeEvent', () => {
  const truncatedDiscriminator = `Program data: ${Buffer.from(
    PUMP_EVENTS.TradeEvent.discriminator.slice(0, -1),
  ).toString('base64')}`;
  const discriminatorOnly = programDataLine(PUMP_EVENTS.TradeEvent.discriminator, []);
  const missingOneMintByte = programDataLine(
    PUMP_EVENTS.TradeEvent.discriminator,
    firstTradeMint.toBytes().subarray(0, 31),
  );

  for (const truncated of [truncatedDiscriminator, discriminatorOnly, missingOneMintByte]) {
    assert.deepEqual(
      pumpFunWebSocketHintFromLogs([tradeLine(firstTradeMint), truncated]),
      { hint: 'NONE', hintMint: null },
    );
  }
});

void test('gives CreateEvent precedence even after ambiguous TradeEvents', () => {
  assert.deepEqual(
    pumpFunWebSocketHintFromLogs([
      tradeLine(firstTradeMint), 'Program data: not-base64',
      programDataLine(PUMP_EVENTS.TradeEvent.discriminator, []), createLine,
    ]),
    { hint: 'PUMPFUN_CREATE', hintMint: null },
  );
});

void test('keeps a trade hint when repeated TradeEvents use the same mint', () => {
  assert.deepEqual(
    pumpFunWebSocketHintFromLogs([tradeLine(firstTradeMint), tradeLine(firstTradeMint)]),
    { hint: 'PUMPFUN_TRADE', hintMint: firstTradeMint.toBase58() },
  );
});

void test('fails safe when valid TradeEvents use distinct mints', () => {
  assert.deepEqual(
    pumpFunWebSocketHintFromLogs([tradeLine(firstTradeMint), tradeLine(secondTradeMint)]),
    { hint: 'NONE', hintMint: null },
  );
});

void test('requires canonical bounded base64 rather than a textual discriminator prefix', () => {
  const encoded = createLine.slice('Program data: '.length);
  assert.equal(pumpFunCreateHintFromLogs([`Program data: ${encoded} `]), 'NONE');
  assert.equal(pumpFunCreateHintFromLogs([`Program data: ${encoded.slice(0, -1)}`]), 'NONE');
  assert.equal(pumpFunCreateHintFromLogs(['Program data: ***']), 'NONE');
  assert.equal(pumpFunCreateHintFromLogs([
    `Program data: ${Buffer.from(PUMP_EVENTS.CreateEvent.discriminator).toString('base64')}suffix`,
  ]), 'NONE');
});

void test('ignores valid unrelated event data and plain non-data logs', () => {
  const unrelatedEvent = programDataLine([255, 254, 253, 252, 251, 250, 249, 248], [1, 2, 3]);
  assert.deepEqual(
    pumpFunWebSocketHintFromLogs([
      'Program log: Log truncated', 'Program log: unrelated', unrelatedEvent, tradeLine(firstTradeMint),
    ]),
    { hint: 'PUMPFUN_TRADE', hintMint: firstTradeMint.toBase58() },
  );
});

void test('rejects hostile arrays without invoking accessors or proxy traps', () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty([], '0', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return createLine;
    },
  });
  Object.defineProperty(accessor, 'length', { value: 1 });
  const sparse = new Array<string>(2);
  sparse[1] = createLine;
  const extra = [createLine];
  Object.defineProperty(extra, 'extra', { enumerable: true, value: 'hostile' });
  let proxyTrapCalls = 0;
  const proxied = new Proxy([createLine], {
    get() {
      proxyTrapCalls += 1;
      throw new Error('hostile proxy trap');
    },
  });
  const revoked = Proxy.revocable([createLine], {});
  revoked.revoke();

  for (const value of [accessor, sparse, extra, proxied, revoked.proxy]) {
    assert.doesNotThrow(() => {
      assert.deepEqual(pumpFunWebSocketHintFromLogs(value), { hint: 'NONE', hintMint: null });
    });
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyTrapCalls, 0);
});

void test('rejects excessive log count, per-line bytes, and cumulative bytes', () => {
  const excessiveCount = Array.from(
    { length: MAX_PUMPFUN_WEBSOCKET_LOG_COUNT + 1 },
    (_, index) => index === MAX_PUMPFUN_WEBSOCKET_LOG_COUNT ? createLine : '',
  );
  const excessiveLine = `Program data: ${Buffer.concat([
    Buffer.from(PUMP_EVENTS.CreateEvent.discriminator),
    Buffer.alloc(MAX_PUMPFUN_WEBSOCKET_LOG_LINE_BYTES),
  ]).toString('base64')}`;
  const cumulative = [
    ...Array.from({ length: 5 }, () => 'x'.repeat(
      Math.floor(MAX_PUMPFUN_WEBSOCKET_LOG_TOTAL_BYTES / 4),
    )),
    createLine,
  ];

  assert.equal(pumpFunCreateHintFromLogs(excessiveCount), 'NONE');
  assert.equal(pumpFunCreateHintFromLogs([excessiveLine]), 'NONE');
  assert.equal(pumpFunCreateHintFromLogs(cumulative), 'NONE');
  assert.equal(pumpFunCreateHintFromLogs(Object.freeze([createLine])), 'PUMPFUN_CREATE');
  assert.equal(pumpFunCreateHintFromLogs(null), 'NONE');
  assert.equal(pumpFunCreateHintFromLogs('not-an-array'), 'NONE');
});

function tradeLine(mint: PublicKey): string {
  return programDataLine(PUMP_EVENTS.TradeEvent.discriminator, mint.toBytes());
}

function programDataLine(
  discriminator: readonly number[],
  payload: readonly number[] | Uint8Array,
): string {
  return `Program data: ${Buffer.concat([
    Buffer.from(discriminator),
    Buffer.from(payload),
  ]).toString('base64')}`;
}
