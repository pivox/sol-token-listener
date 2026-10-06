import assert from 'node:assert/strict';
import test from 'node:test';
import { trustedTerminalAttribution, trustedTerminalAttributionContext } from '../src/domain/terminal-attribution.js';
import { trustedObservedPipelineOrigin } from '../src/domain/observed-pipeline-failure.js';
import { decodePumpInstruction } from '../src/launchpads/pumpfun/instruction-decoder.js';
import { decodePumpCpiEvent } from '../src/launchpads/pumpfun/event-decoder.js';
import { PUMP_INSTRUCTIONS, PUMP_EVENTS } from '../src/launchpads/pumpfun/generated/pump-idl.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import type { NormalizedInstruction } from '../src/solana/rpc/types.js';
import { createEventInstruction, tradeEventInstruction } from './pumpfun-event-decoder.test.js';
import { realPumpPipeline, malformedPumpTransaction } from './observed-pipeline-failure-fixtures.js';
import { trustedObservedPipelineFailure } from '../src/application/observed-transaction-pipeline.js';
import { decodePumpTransaction } from '../src/launchpads/pumpfun/transaction-decoder.js';

function instruction(name: keyof typeof PUMP_INSTRUCTIONS, payload: Uint8Array,
  innerInstructionIndex: number | null = null): NormalizedInstruction {
  return { programId: PUMP_PROGRAM_ID,
    accounts: PUMP_INSTRUCTIONS[name].accounts.map((_, index) => `account-${index}`),
    data: Uint8Array.from([...PUMP_INSTRUCTIONS[name].discriminator, ...payload]),
    instructionIndex: 3, innerInstructionIndex, parentInstructionIndex: null, stackHeight: 1 };
}

function capture(operation: () => unknown): unknown {
  try { operation(); } catch (error) { return error; }
  assert.fail('Expected existing decoder rejection');
}

for (const inner of [null, 7]) {
  void test(`attributes instruction suffix failure at ${inner === null ? 'outer' : 'inner'} cursor`, () => {
    const value = instruction('buy', Uint8Array.from([...new Uint8Array(16), 2]), inner);
    const error = capture(() => decodePumpInstruction(value));
    assert.equal(trustedObservedPipelineOrigin(error), 'PUMP_BORSH_INVALID');
    assert.deepEqual(trustedTerminalAttribution(error), {
      version: 1, diagnosticCode: 'PUMP_BORSH_INVALID', causeKind: 'PUMP_DECODER',
      pumpWire: { surface: 'INSTRUCTION', location: inner === null ? 'OUTER' : 'INNER',
        discriminatorHex: Buffer.from(PUMP_INSTRUCTIONS.buy.discriminator).toString('hex'),
        idlName: 'buy', totalBytes: 25, payloadBytes: 17, suffixBytes: 1 },
    });
  });

  void test(`attributes CPI event suffix failure at ${inner === null ? 'outer' : 'inner'} cursor`, () => {
    const value = { ...tradeEventInstruction(), innerInstructionIndex: inner };
    value.data = Uint8Array.from([...value.data, 0]);
    const error = capture(() => decodePumpCpiEvent(value));
    assert.equal(trustedObservedPipelineOrigin(error), 'PUMP_BORSH_INVALID');
    assert.deepEqual(trustedTerminalAttribution(error)?.pumpWire, {
      surface: 'CPI_EVENT', location: inner === null ? 'OUTER' : 'INNER',
      discriminatorHex: Buffer.from(PUMP_EVENTS.TradeEvent.discriminator).toString('hex'),
      idlName: 'TradeEvent', totalBytes: value.data.length,
      payloadBytes: value.data.length - 16, suffixBytes: 17,
    });
  });
}

void test('required UTF-8 and length failures never claim reader remainder as suffix', () => {
  for (const payload of [Uint8Array.from([1, 0, 0, 0, 255]), Uint8Array.from([255, 255, 255, 255])]) {
    const value = instruction('create', payload);
    const error = capture(() => decodePumpInstruction(value));
    assert.equal(trustedObservedPipelineOrigin(error), 'PUMP_BORSH_INVALID');
    assert.equal(trustedTerminalAttribution(error)?.pumpWire?.suffixBytes, null);
  }
  const value = createEventInstruction();
  const error = capture(() => decodePumpCpiEvent({ ...value,
    data: Uint8Array.from([...value.data.subarray(0, 16), 1, 0, 0, 0, 255]) }));
  assert.equal(trustedTerminalAttribution(error)?.pumpWire?.suffixBytes, null);
});

void test('generic residual arguments have an explicit suffix boundary', () => {
  const error = capture(() => decodePumpInstruction(instruction('sell', new Uint8Array(19))));
  assert.equal(trustedTerminalAttribution(error)?.pumpWire?.suffixBytes, 3);
});

void test('unknown 32-byte TradeEvent suffix remains attributed and rejected', () => {
  const value = tradeEventInstruction(new Uint8Array(16));
  const error = capture(() => decodePumpCpiEvent(value));
  assert.equal(trustedObservedPipelineOrigin(error), 'PUMP_BORSH_INVALID');
  assert.deepEqual(trustedTerminalAttribution(error)?.pumpWire, {
    surface: 'CPI_EVENT', location: 'INNER',
    discriminatorHex: Buffer.from(PUMP_EVENTS.TradeEvent.discriminator).toString('hex'),
    idlName: 'TradeEvent', totalBytes: value.data.length,
    payloadBytes: value.data.length - 16, suffixBytes: 32,
  });
});

void test('CreateEvent invalid suffix boolean preserves the original suffix length', () => {
  const value = createEventInstruction();
  const bytes = Uint8Array.from(value.data);
  bytes[bytes.length - 1] = 2;
  const error = capture(() => decodePumpCpiEvent({ ...value, data: bytes }));
  assert.equal(trustedTerminalAttribution(error)?.pumpWire?.suffixBytes, 9);
});

void test('unknown discriminators and truncated required fields retain existing decisions', () => {
  assert.equal(decodePumpInstruction({ ...instruction('buy', new Uint8Array()), data: new Uint8Array(8) }), null);
  const event = createEventInstruction();
  const data = Uint8Array.from(event.data);
  data.fill(0, 8, 16);
  assert.equal(decodePumpCpiEvent({ ...event, data }), null);
  const error = capture(() => decodePumpInstruction(instruction('buy', new Uint8Array(3))));
  assert.equal(trustedObservedPipelineOrigin(error), 'PUMP_BORSH_TRUNCATED');
  assert.equal(trustedTerminalAttribution(error), null);
});

void test('real pipeline transfers wire evidence to its exact frozen three-field failure', async () => {
  await assert.rejects(realPumpPipeline().process(malformedPumpTransaction('PUMP_BORSH_INVALID'), 1_000),
    (error: unknown) => {
      const failure = trustedObservedPipelineFailure(error);
      assert.ok(failure);
      assert.deepEqual(Reflect.ownKeys(failure), ['code', 'errorName', 'retryable']);
      assert.ok(Object.isFrozen(failure));
      assert.equal(failure.retryable, false);
      assert.equal(trustedTerminalAttribution(failure)?.pumpWire?.suffixBytes, 1);
      return true;
    });
});

void test('transaction attribution identifies only the throwing instruction among multiple Pump instructions', () => {
  for (const surface of ['INSTRUCTION', 'CPI_EVENT'] as const) {
    for (const inner of [null, 7]) {
      const malformed = surface === 'INSTRUCTION'
        ? instruction('buy', Uint8Array.from([...new Uint8Array(16), 2]), inner)
        : { ...tradeEventInstruction(), instructionIndex: 3, innerInstructionIndex: inner,
          data: Uint8Array.from([...tradeEventInstruction().data, 0]) };
      const tx = { ...malformedPumpTransaction('PUMP_BORSH_INVALID'), instructions: [
        { ...instruction('migrate', new Uint8Array()), instructionIndex: 1 },
        malformed,
        { ...malformed, instructionIndex: 8 },
      ] };
      const error = capture(() => decodePumpTransaction(tx));
      assert.deepEqual(trustedTerminalAttributionContext(error), {
        originCode: 'PUMP_BORSH_INVALID', locator: {
          signature: tx.signature, slot: tx.slot, transactionIndex: tx.transactionIndex,
          confirmationStatus: 'confirmed', instructionIndex: 3, innerInstructionIndex: inner,
        },
      });
      assert.equal(trustedTerminalAttribution(error)?.pumpWire?.surface, surface);
      tx.confirmationStatus = 'FINALIZED';
      assert.equal(trustedTerminalAttributionContext(error)?.locator.confirmationStatus, 'confirmed');
    }
  }
});

void test('non-wire decoder errors preserve authenticated origin and locator without invented cursor', () => {
  const tx = { ...malformedPumpTransaction('PUMP_BORSH_INVALID'), transactionIndex: null };
  const error = capture(() => decodePumpTransaction(tx));
  assert.equal(trustedTerminalAttributionContext(error)?.originCode, 'PUMP_TRANSACTION_INDEX_REQUIRED');
  assert.equal(trustedTerminalAttributionContext(error)?.locator.transactionIndex, null);
  assert.equal(trustedTerminalAttributionContext(error)?.locator.instructionIndex, null);
});

void test('invalid required booleans remain suffix-unavailable for instruction and CPI', () => {
  const event = tradeEventInstruction(new Uint8Array(), { is_buy: true });
  const bytes = Uint8Array.from(event.data);
  bytes[16 + 32 + 8 + 8] = 2;
  const error = capture(() => decodePumpCpiEvent({ ...event, data: bytes }));
  assert.equal(trustedObservedPipelineOrigin(error), 'PUMP_BORSH_INVALID');
  assert.equal(trustedTerminalAttribution(error)?.pumpWire?.suffixBytes, null);
  const required = Uint8Array.from([...new Uint8Array(12 + 32), 2]);
  const instructionError = capture(() => decodePumpInstruction(instruction('create_v2', required)));
  assert.equal(trustedObservedPipelineOrigin(instructionError), 'PUMP_BORSH_INVALID');
  assert.equal(trustedTerminalAttribution(instructionError)?.pumpWire?.suffixBytes, null);
});

void test('an attribution bound rejection cannot replace the original decoder result', () => {
  const value = instruction('sell', new Uint8Array(1_300));
  const error = capture(() => decodePumpInstruction(value));
  assert.equal(trustedObservedPipelineOrigin(error), 'PUMP_BORSH_INVALID');
  assert.equal(trustedTerminalAttribution(error), null);
  const tx = { ...malformedPumpTransaction('PUMP_BORSH_INVALID'), slot: -1n };
  const transactionError = capture(() => decodePumpTransaction(tx));
  assert.equal(trustedObservedPipelineOrigin(transactionError), 'PUMP_BORSH_INVALID');
  assert.equal(trustedTerminalAttribution(transactionError)?.pumpWire?.suffixBytes, 1);
  assert.equal(trustedTerminalAttributionContext(transactionError), null);
});
