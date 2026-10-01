import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as terminal from '../src/domain/terminal-attribution.js';
import {
  attachTrustedTerminalAttribution,
  createTerminalAttribution,
  inheritTrustedTerminalAttribution,
  MAX_PUMP_WIRE_BYTES,
  registerTrustedTerminalAttribution,
  TERMINAL_ATTRIBUTION_CAUSE_KINDS,
  TERMINAL_DIAGNOSTIC_CODES,
  trustedTerminalAttribution,
  type TerminalAttributionV1,
} from '../src/domain/terminal-attribution.js';
import {
  inheritObservedPipelineOrigin,
  registerInternalDecodingFailure,
  trustedObservedPipelineOrigin,
} from '../src/domain/observed-pipeline-failure.js';
import {
  createLaunchpadObservationError,
} from '../src/application/launchpad-observation-errors.js';
import {
  createPumpDecodingError,
  registerPumpDecodingTerminalAttribution,
  PumpDecodingError,
} from '../src/launchpads/pumpfun/errors.js';
import {
  createPumpSwapDecodingError,
  registerPumpSwapDecodingTerminalAttribution,
  rethrowMutablePumpSwapRpcFailure,
  PumpSwapDecodingError,
  PumpSwapMutableRpcDecodingError,
} from '../src/markets/pumpswap/errors.js';

const diagnosticCodes = [
  'PUMP_BORSH_INVALID',
  'FUNDING_OBSERVATION_VALIDATE',
  'FUNDING_OBSERVATION_EXTRACT',
  'FUNDING_OBSERVATION_RECORD',
  'WALLET_GRAPH_POSTGRES_SERIALIZATION',
  'WALLET_GRAPH_POSTGRES_DEADLOCK',
  'WALLET_GRAPH_LAUNCH_MISSING',
  'WALLET_GRAPH_DATA_INVALID',
  'WALLET_GRAPH_ANALYSIS_INVALID',
  'WALLET_GRAPH_PERSISTENCE_UNKNOWN',
  'PUMPSWAP_MUTABLE_RPC_UNAVAILABLE',
  'PUMPSWAP_RPC_CONTEXT_INVALID',
  'PUMPSWAP_MUTABLE_ACCOUNT_DECODING',
  'PUMPSWAP_MARKET_POOL_MISMATCH',
  'PUMPSWAP_MARKET_POOL_NON_CANONICAL',
  'PUMPSWAP_UNSUPPORTED_TOKEN_EXTENSION',
  'PUMPSWAP_PERSISTENCE_UNKNOWN',
  'QUALIFICATION_CONNECT_FAILED',
  'QUALIFICATION_POSTGRES_SERIALIZATION',
  'QUALIFICATION_POSTGRES_DEADLOCK',
  'QUALIFICATION_DATA_INVALID',
  'QUALIFICATION_LAUNCH_MISSING',
  'QUALIFICATION_REBUILD_UNKNOWN',
  'QUALIFICATION_PERSISTENCE_UNKNOWN',
  'QUALIFICATION_CLEANUP_FAILED',
  'UNAVAILABLE',
] as const;

void test('qualification diagnostics require null cause kind and pump wire', () => {
  for (const diagnosticCode of diagnosticCodes.filter((code) => code.startsWith('QUALIFICATION_'))) {
    assert.doesNotThrow(() => createTerminalAttribution({ version: 1, diagnosticCode, causeKind: null, pumpWire: null }));
    for (const causeKind of TERMINAL_ATTRIBUTION_CAUSE_KINDS) {
      assert.throws(() => createTerminalAttribution({ version: 1, diagnosticCode, causeKind, pumpWire: null }));
    }
    assert.throws(() => createTerminalAttribution(pumpAttribution({ diagnosticCode })));
  }
});

const causeKinds = [
  'PUMP_DECODER',
  'LOCATOR',
  'NORMALIZATION',
  'PUMP_MINT_LIMIT',
  'PUMP_MULTI_MINT',
] as const;

function pumpAttribution(
  overrides: Partial<TerminalAttributionV1> = {},
): Record<string, unknown> {
  return {
    version: 1,
    diagnosticCode: 'PUMP_BORSH_INVALID',
    causeKind: 'PUMP_DECODER',
    pumpWire: {
      surface: 'INSTRUCTION',
      location: 'OUTER',
      discriminatorHex: '66063d1201daebea',
      idlName: 'buy_exact_quote_in_v2',
      totalBytes: 48,
      payloadBytes: 40,
      suffixBytes: 8,
    },
    ...overrides,
  };
}

void test('publishes the exact closed diagnostic and catch-up cause vocabularies', () => {
  assert.deepEqual(TERMINAL_DIAGNOSTIC_CODES, diagnosticCodes);
  assert.deepEqual(TERMINAL_ATTRIBUTION_CAUSE_KINDS, causeKinds);
  assert.ok(Object.isFrozen(TERMINAL_DIAGNOSTIC_CODES));
  assert.ok(Object.isFrozen(TERMINAL_ATTRIBUTION_CAUSE_KINDS));
});

void test('creates an exact detached and deeply immutable attribution snapshot', () => {
  const wire = pumpAttribution().pumpWire as Record<string, unknown>;
  const input = pumpAttribution({ pumpWire: wire as never });
  const attribution = createTerminalAttribution(input);

  assert.deepEqual(attribution, input);
  assert.notEqual(attribution, input);
  assert.notEqual(attribution.pumpWire, wire);
  assert.ok(Object.isFrozen(attribution));
  assert.ok(Object.isFrozen(attribution.pumpWire));
  wire.idlName = 'mutated';
  assert.equal(attribution.pumpWire?.idlName, 'buy_exact_quote_in_v2');
  assert.deepEqual(Reflect.ownKeys(attribution), [
    'version', 'diagnosticCode', 'causeKind', 'pumpWire',
  ]);
});

void test('accepts only exact closed keys and coherent diagnostic variants', () => {
  assert.deepEqual(createTerminalAttribution({
    version: 1,
    diagnosticCode: 'UNAVAILABLE',
    causeKind: null,
    pumpWire: null,
  }), {
    version: 1,
    diagnosticCode: 'UNAVAILABLE',
    causeKind: null,
    pumpWire: null,
  });

  for (const input of [
    { ...pumpAttribution(), extra: 'secret' },
    { ...pumpAttribution(), version: 2 },
    { ...pumpAttribution(), diagnosticCode: 'FORGED' },
    { ...pumpAttribution(), causeKind: 'FORGED' },
    { ...pumpAttribution(), pumpWire: null },
    { ...pumpAttribution(), diagnosticCode: 'UNAVAILABLE' },
    { ...pumpAttribution(), causeKind: null },
    { ...pumpAttribution(), pumpWire: { ...(pumpAttribution().pumpWire as object), extra: 1 } },
  ]) {
    assert.throws(() => createTerminalAttribution(input), TypeError);
  }
});

void test('bounds Pump wire identity with safe integers, UTF-8 bytes and exact layout arithmetic', () => {
  const wire = pumpAttribution().pumpWire as Record<string, unknown>;
  for (const [field, value] of [
    ['surface', 'FORGED'],
    ['location', 'FORGED'],
    ['discriminatorHex', '66063D1201DAEBEA'],
    ['discriminatorHex', '00'],
    ['idlName', 'é'.repeat(33)],
    ['idlName', 'Not_Canonical'],
    ['idlName', 'syntactically_valid_but_not_pinned'],
    ['totalBytes', -1],
    ['totalBytes', -0],
    ['totalBytes', 1.5],
    ['totalBytes', Number.MAX_SAFE_INTEGER + 1],
    ['totalBytes', MAX_PUMP_WIRE_BYTES + 1],
    ['payloadBytes', 39],
    ['suffixBytes', 41],
  ] as const) {
    assert.throws(() => createTerminalAttribution(pumpAttribution({
      pumpWire: { ...wire, [field]: value } as never,
    })), TypeError);
  }

  assert.equal(createTerminalAttribution(pumpAttribution({
    pumpWire: {
      ...wire,
      surface: 'CPI_EVENT',
      location: 'INNER',
      totalBytes: 48,
      payloadBytes: 32,
      suffixBytes: null,
    } as never,
  })).pumpWire?.payloadBytes, 32);
});

void test('rejects accessors, non-plain values, proxies and revoked proxies without invoking traps', () => {
  let traps = 0;
  const trap = (): never => { traps += 1; throw new Error('secret trap'); };
  const accessor = pumpAttribution();
  Object.defineProperty(accessor, 'diagnosticCode', { enumerable: true, get: trap });
  const proxy = new Proxy(pumpAttribution(), {
    get: trap,
    getPrototypeOf: trap,
    ownKeys: trap,
    getOwnPropertyDescriptor: trap,
  });
  const revoked = Proxy.revocable(pumpAttribution(), {});
  revoked.revoke();

  for (const input of [accessor, Object.create(pumpAttribution()), proxy, revoked.proxy]) {
    assert.throws(() => createTerminalAttribution(input), TypeError);
  }
  assert.equal(traps, 0);
});

void test('registers, inherits and attaches evidence by exact identity only', () => {
  const cause = new Error('secret');
  const wrapper = new Error('wrapper');
  const failure = Object.freeze({
    code: 'PIPELINE_STAGE_FAILED',
    errorName: 'ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_INVALID',
    retryable: false,
  });
  const attribution = registerTrustedTerminalAttribution(cause, pumpAttribution());
  inheritTrustedTerminalAttribution(wrapper, cause);
  attachTrustedTerminalAttribution(failure, wrapper);

  assert.deepEqual(trustedTerminalAttribution(cause), attribution);
  assert.equal(trustedTerminalAttribution(wrapper), attribution);
  assert.equal(trustedTerminalAttribution(failure), attribution);
  assert.equal(trustedTerminalAttribution(Object.create(cause)), null);
  assert.equal(trustedTerminalAttribution(new Error('secret')), null);
  assert.equal(trustedTerminalAttribution({ terminalAttribution: attribution }), null);

  const proxiedCause = new Proxy(cause, {});
  const proxiedFailure = new Proxy(failure, {});
  inheritTrustedTerminalAttribution(new Error('no authority'), proxiedCause);
  assert.equal(trustedTerminalAttribution(proxiedCause), null);
  assert.throws(() => { attachTrustedTerminalAttribution(proxiedFailure, cause); }, TypeError);
  assert.throws(() => { attachTrustedTerminalAttribution({}, cause); }, TypeError);
});

void test('contains hostile and revoked identities without reading public fields', () => {
  let traps = 0;
  const trap = (): never => { traps += 1; throw new Error('secret trap'); };
  const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [hostile, revoked.proxy]) {
    assert.equal(trustedTerminalAttribution(value), null);
    inheritTrustedTerminalAttribution(new Error('wrapper'), value);
  }
  assert.equal(traps, 0);
});

void test('trusted decoder factories gate attribution and public error fields cannot forge it', () => {
  const input = pumpAttribution();
  const pump = createPumpDecodingError('PUMP_BORSH_INVALID', false, 'secret');
  const swap = createPumpSwapDecodingError('PUMPSWAP_BORSH_INVALID', 'secret');
  registerPumpDecodingTerminalAttribution(pump, input);
  registerPumpSwapDecodingTerminalAttribution(swap, {
    version: 1, diagnosticCode: 'PUMPSWAP_MUTABLE_ACCOUNT_DECODING',
    causeKind: null, pumpWire: null,
  });
  assert.equal(trustedTerminalAttribution(pump)?.diagnosticCode, 'PUMP_BORSH_INVALID');
  assert.equal(trustedTerminalAttribution(swap)?.diagnosticCode, 'PUMPSWAP_MUTABLE_ACCOUNT_DECODING');

  const forgedPump = new PumpDecodingError('PUMP_BORSH_INVALID', false, 'secret');
  const forgedSwap = new PumpSwapDecodingError('PUMPSWAP_BORSH_INVALID', 'secret');
  for (const forged of [forgedPump, forgedSwap, Object.assign(new Error('secret'), {
    code: 'PUMP_BORSH_INVALID', diagnosticCode: 'PUMP_BORSH_INVALID',
  })]) {
    Object.assign(forged, { cause: pump, terminalAttribution: input });
    assert.equal(trustedTerminalAttribution(forged), null);
  }
  assert.throws(() => { registerPumpDecodingTerminalAttribution(forgedPump, input); }, TypeError);
  assert.throws(() => { registerPumpSwapDecodingTerminalAttribution(forgedSwap, input); }, TypeError);
});

void test('observed and launchpad inheritance preserve attribution without changing origin authority', () => {
  const pump = createPumpDecodingError('PUMP_BORSH_INVALID', false, 'secret');
  registerPumpDecodingTerminalAttribution(pump, pumpAttribution());
  const wrapper = new Error('wrapper');
  inheritObservedPipelineOrigin(wrapper, pump);
  assert.equal(trustedObservedPipelineOrigin(wrapper), 'PUMP_BORSH_INVALID');
  assert.equal(trustedTerminalAttribution(wrapper)?.diagnosticCode, 'PUMP_BORSH_INVALID');

  const launchpad = createLaunchpadObservationError(
    'decode_trades', 'pumpfun', 'program', 'signature', pump,
  );
  assert.equal(trustedObservedPipelineOrigin(launchpad), 'PUMP_BORSH_INVALID');
  assert.equal(trustedTerminalAttribution(launchpad)?.diagnosticCode, 'PUMP_BORSH_INVALID');
});

void test('mutable PumpSwap RPC wrapping preserves diagnostics but strips terminal origin authority', () => {
  const decoder = createPumpSwapDecodingError('PUMPSWAP_BORSH_INVALID', 'secret');
  registerPumpSwapDecodingTerminalAttribution(decoder, {
    version: 1, diagnosticCode: 'PUMPSWAP_MUTABLE_ACCOUNT_DECODING',
    causeKind: null, pumpWire: null,
  });
  assert.throws(() => rethrowMutablePumpSwapRpcFailure(decoder), (error: unknown) => {
    assert.ok(error instanceof PumpSwapMutableRpcDecodingError);
    assert.equal(trustedObservedPipelineOrigin(error), null);
    assert.equal(
      trustedTerminalAttribution(error)?.diagnosticCode,
      'PUMPSWAP_MUTABLE_ACCOUNT_DECODING',
    );
    return true;
  });
});

void test('terminal attribution never alters legacy observed origin registration', () => {
  const error = new Error('internal');
  registerInternalDecodingFailure(error, 'PUMP_BORSH_INVALID');
  registerTrustedTerminalAttribution(error, pumpAttribution());
  assert.equal(trustedObservedPipelineOrigin(error), 'PUMP_BORSH_INVALID');
  assert.equal(trustedTerminalAttribution(error)?.diagnosticCode, 'PUMP_BORSH_INVALID');
});

void test('snapshots and transfers exact bounded transaction context independently of diagnostics', () => {
  assert.equal(typeof terminal.registerTrustedTerminalAttributionContext, 'function');
  const source = new Error('source');
  const locator = { signature: 'signature', slot: 123n, transactionIndex: 4,
    confirmationStatus: 'confirmed', instructionIndex: 3, innerInstructionIndex: 2 };
  const context = terminal.registerTrustedTerminalAttributionContext(source, {
    originCode: 'PUMP_BORSH_TRUNCATED', locator,
  });
  locator.instructionIndex = 9;
  assert.equal(context.locator.instructionIndex, 3);
  assert.ok(Object.isFrozen(context.locator));
  const wrapper = new Error('wrapper');
  inheritTrustedTerminalAttribution(wrapper, source);
  const target = Object.freeze({ code: 'unchanged' });
  attachTrustedTerminalAttribution(target, wrapper);
  assert.equal(terminal.trustedTerminalAttributionContext(target), context);
  assert.equal(terminal.trustedTerminalAttributionContext({ ...target }), null);
  assert.equal(trustedTerminalAttribution(target), null);
  const trap = (): never => { assert.fail('must not inspect hostile identity'); };
  const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [hostile, revoked.proxy]) {
    assert.equal(terminal.trustedTerminalAttributionContext(value), null);
  }
  for (const changed of [
    { signature: 'x'.repeat(129) }, { slot: -1n }, { slot: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    { transactionIndex: -0 }, { instructionIndex: -1 }, { innerInstructionIndex: 0.5 },
    { confirmationStatus: 'forged' }, { instructionIndex: null, innerInstructionIndex: 1 },
    { extra: 'secret' },
  ]) {
    assert.throws(() => terminal.registerTrustedTerminalAttributionContext(new Error(), {
      originCode: 'PUMP_BORSH_TRUNCATED', locator: { ...locator, ...changed },
    }), TypeError);
  }
  assert.throws(() => terminal.registerTrustedTerminalAttributionContext(new Error(), {
    originCode: 'forged', locator,
  }), TypeError);
});

void test('closed attribution validation and origin registration have no runtime import cycle', async () => {
  const taxonomy = await readFile(new URL('../src/domain/observed-pipeline-taxonomy.ts', import.meta.url), 'utf8');
  const attribution = await readFile(new URL('../src/domain/terminal-attribution.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(taxonomy, /^import\s/mu);
  assert.doesNotMatch(attribution, /from ['"]\.\/observed-pipeline-failure\.js['"]/u);
  assert.match(attribution, /from ['"]\.\/observed-pipeline-taxonomy\.js['"]/u);
});
