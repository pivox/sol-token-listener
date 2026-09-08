import assert from 'node:assert/strict';
import test from 'node:test';
import { PUMP_EVENTS } from '../src/launchpads/pumpfun/generated/pump-idl.js';
import {
  MAX_PUMPFUN_WEBSOCKET_LOG_COUNT,
  MAX_PUMPFUN_WEBSOCKET_LOG_LINE_BYTES,
  MAX_PUMPFUN_WEBSOCKET_LOG_TOTAL_BYTES,
  PUMPFUN_WEBSOCKET_HINTS,
  pumpFunCreateHintFromLogs,
} from '../src/launchpads/pumpfun/websocket-create-hint.js';

const createLine = programDataLine(PUMP_EVENTS.CreateEvent.discriminator, [0, 1, 2, 3]);

void test('exports the exact closed hint vocabulary and detects only the official CreateEvent', () => {
  assert.deepEqual(PUMPFUN_WEBSOCKET_HINTS, ['NONE', 'PUMPFUN_CREATE']);
  assert.ok(Object.isFrozen(PUMPFUN_WEBSOCKET_HINTS));
  assert.equal(pumpFunCreateHintFromLogs([createLine]), 'PUMPFUN_CREATE');
  assert.equal(pumpFunCreateHintFromLogs([
    programDataLine(PUMP_EVENTS.TradeEvent.discriminator, [0, 1, 2, 3]),
  ]), 'NONE');
  assert.equal(pumpFunCreateHintFromLogs([`Program log: ${createLine}`]), 'NONE');
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
      assert.equal(pumpFunCreateHintFromLogs(value), 'NONE');
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

function programDataLine(
  discriminator: readonly number[],
  payload: readonly number[],
): string {
  return `Program data: ${Buffer.concat([
    Buffer.from(discriminator),
    Buffer.from(payload),
  ]).toString('base64')}`;
}
