import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_WEBSOCKET_HEALTH_GENERATION,
  WEBSOCKET_DISCONNECT_REASON_CODES,
  WEBSOCKET_HEALTH_PHASES,
  WEBSOCKET_HEALTH_STALE_AFTER_MS,
  WEBSOCKET_RECOVERY_REASON_CODES,
  WEBSOCKET_RECOVERY_STATUSES,
  WebSocketHealthValidationError,
  assertValidWebSocketHealthSnapshot,
  createWebSocketHealthSnapshot,
  publicWebSocketState,
  type WebSocketHealthSnapshot,
} from '../src/domain/websocket-health.js';

const NOW_MS = 1_777_000_000_000;

void test('exports the exact immutable WebSocket health vocabulary and public mapping', () => {
  assert.deepEqual(WEBSOCKET_HEALTH_PHASES, [
    'STOPPED', 'CONNECTING', 'WAITING_FOR_ACKS', 'ACKNOWLEDGED', 'RECOVERING',
    'RUNNING', 'DEGRADED', 'UNRECOVERABLE', 'STOPPING',
  ]);
  assert.deepEqual(WEBSOCKET_RECOVERY_STATUSES, [
    'NOT_REQUIRED', 'REQUIRED', 'IN_PROGRESS', 'RECOVERED', 'FAILED',
  ]);
  assert.deepEqual(WEBSOCKET_DISCONNECT_REASON_CODES, [
    'SETUP_TIMEOUT', 'ABORTED', 'SOCKET_ERROR', 'REMOTE_CLOSE', 'PROTOCOL_INVALID',
    'NOTIFICATION_FAILED', 'CLEANUP_FAILED', 'UNEXPECTED_RESTART',
  ]);
  assert.deepEqual(WEBSOCKET_RECOVERY_REASON_CODES, [
    'STARTUP', 'UNEXPECTED_RESTART', 'SESSION_FAILURE', 'RPC_UNAVAILABLE',
    'CHECKPOINT_CONFLICT', 'CATCH_UP_WINDOW_EXCEEDED',
  ]);
  for (const values of [
    WEBSOCKET_HEALTH_PHASES,
    WEBSOCKET_RECOVERY_STATUSES,
    WEBSOCKET_DISCONNECT_REASON_CODES,
    WEBSOCKET_RECOVERY_REASON_CODES,
  ]) assert.ok(Object.isFrozen(values));
  assert.equal(WEBSOCKET_HEALTH_STALE_AFTER_MS, 30_000);
  assert.equal(MAX_WEBSOCKET_HEALTH_GENERATION, 9_223_372_036_854_775_807n);

  assert.equal(publicWebSocketState('STOPPED'), 'STOPPED');
  assert.equal(publicWebSocketState('CONNECTING'), 'CONNECTING');
  assert.equal(publicWebSocketState('WAITING_FOR_ACKS'), 'CONNECTING');
  assert.equal(publicWebSocketState('ACKNOWLEDGED'), 'ACKNOWLEDGED');
  assert.equal(publicWebSocketState('RUNNING'), 'ACKNOWLEDGED');
  assert.equal(publicWebSocketState('RECOVERING'), 'RECOVERING');
  assert.equal(publicWebSocketState('DEGRADED'), 'DEGRADED');
  assert.equal(publicWebSocketState('UNRECOVERABLE'), 'DEGRADED');
  assert.equal(publicWebSocketState('STOPPING'), 'DEGRADED');
});

void test('creates a detached deeply frozen snapshot and validates every detailed phase', () => {
  const observation = { observedAtMs: NOW_MS - 2, slot: 42n };
  const recovery = {
    status: 'RECOVERED', startedAtMs: NOW_MS - 5, completedAtMs: NOW_MS - 3,
    reasonCode: 'STARTUP',
  };
  const input = validInput({
    phase: 'RUNNING', activeSessionGeneration: 3n, providerId: 'fallback-2',
    acknowledgedAtMs: NOW_MS - 4, lastObservation: observation, recovery,
    heartbeatAtMs: NOW_MS - 1, evidencePurgeAfterMs: NOW_MS + 14_400_000,
  });

  const snapshot = createWebSocketHealthSnapshot(input);

  assert.notEqual(snapshot, input);
  assert.notEqual(snapshot.lastObservation, observation);
  assert.notEqual(snapshot.recovery, recovery);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.lastObservation));
  assert.ok(Object.isFrozen(snapshot.recovery));
  assert.doesNotThrow(() => { assertValidWebSocketHealthSnapshot(snapshot); });
  observation.slot = 99n;
  recovery.reasonCode = 'SESSION_FAILURE';
  assert.equal(snapshot.lastObservation?.slot, 42n);
  assert.equal(snapshot.recovery.reasonCode, 'STARTUP');

  for (const inputForPhase of validInputsForEveryPhase()) {
    const value = createWebSocketHealthSnapshot(inputForPhase);
    assert.doesNotThrow(() => { assertValidWebSocketHealthSnapshot(value); });
  }
});

void test('accepts exact generation bounds and rejects non-bigint or out-of-range generations', () => {
  const maximum = createWebSocketHealthSnapshot(validInput({
    ownerGeneration: MAX_WEBSOCKET_HEALTH_GENERATION,
    revision: MAX_WEBSOCKET_HEALTH_GENERATION,
    phase: 'RUNNING',
    activeSessionGeneration: MAX_WEBSOCKET_HEALTH_GENERATION,
    providerId: 'primary',
    acknowledgedAtMs: NOW_MS,
  }));
  assert.equal(maximum.ownerGeneration, MAX_WEBSOCKET_HEALTH_GENERATION);

  for (const overrides of [
    { ownerGeneration: 1 },
    { revision: -1n },
    { ownerGeneration: MAX_WEBSOCKET_HEALTH_GENERATION + 1n },
    { activeSessionGeneration: 0n, providerId: 'primary', phase: 'RUNNING', acknowledgedAtMs: NOW_MS },
    { candidateSessionGeneration: MAX_WEBSOCKET_HEALTH_GENERATION + 1n, candidateProviderId: 'primary', phase: 'CONNECTING' },
  ]) assertInvalid(() => createWebSocketHealthSnapshot(validInput(overrides)));
});

void test('rejects provider/session mismatches, duplicate sessions, and incoherent phases', () => {
  const cases: readonly Readonly<Record<string, unknown>>[] = [
    { providerId: 'primary' },
    { activeSessionGeneration: 1n },
    { candidateProviderId: 'fallback-1' },
    { candidateSessionGeneration: 2n },
    {
      phase: 'CONNECTING', candidateProviderId: 'fallback-4', candidateSessionGeneration: 2n,
    },
    {
      phase: 'CONNECTING', providerId: 'primary', activeSessionGeneration: 2n,
      candidateProviderId: 'fallback-1', candidateSessionGeneration: 2n,
    },
    { phase: 'CONNECTING' },
    {
      phase: 'WAITING_FOR_ACKS', candidateProviderId: 'primary', candidateSessionGeneration: 2n,
      acknowledgedAtMs: NOW_MS,
    },
    {
      phase: 'ACKNOWLEDGED', candidateProviderId: 'primary', candidateSessionGeneration: 2n,
      acknowledgedAtMs: null,
    },
    {
      phase: 'RUNNING', candidateProviderId: 'primary', candidateSessionGeneration: 2n,
      acknowledgedAtMs: NOW_MS,
    },
    { phase: 'STOPPED', providerId: 'primary', activeSessionGeneration: 2n },
    { phase: 'DEGRADED', acknowledgedAtMs: NOW_MS },
  ];
  for (const overrides of cases) assertInvalid(() => createWebSocketHealthSnapshot(validInput(overrides)));
});

void test('rejects incoherent inactive and recovery lifecycle combinations', () => {
  const cases: readonly Readonly<Record<string, unknown>>[] = [
    { supervision: 'INACTIVE', ownerGeneration: 1n },
    { supervision: 'INACTIVE', revision: 1n },
    { supervision: 'INACTIVE', phase: 'DEGRADED' },
    { supervision: 'INACTIVE', heartbeatAtMs: NOW_MS },
    { recovery: { status: 'NOT_REQUIRED', startedAtMs: NOW_MS, completedAtMs: null, reasonCode: null } },
    { recovery: { status: 'REQUIRED', startedAtMs: null, completedAtMs: null, reasonCode: null } },
    { recovery: { status: 'IN_PROGRESS', startedAtMs: null, completedAtMs: null, reasonCode: 'STARTUP' } },
    { recovery: { status: 'IN_PROGRESS', startedAtMs: NOW_MS, completedAtMs: NOW_MS, reasonCode: 'STARTUP' } },
    { recovery: { status: 'RECOVERED', startedAtMs: NOW_MS, completedAtMs: NOW_MS - 1, reasonCode: 'STARTUP' } },
    { recovery: { status: 'FAILED', startedAtMs: NOW_MS, completedAtMs: NOW_MS + 1, reasonCode: 'REMOTE_TEXT' } },
  ];
  for (const overrides of cases) assertInvalid(() => createWebSocketHealthSnapshot(validInput(overrides)));
});

void test('rejects invalid timestamps, slots, pair fields, and unknown enum values', () => {
  for (const overrides of [
    { updatedAtMs: Number.NaN },
    { updatedAtMs: Number.MAX_SAFE_INTEGER },
    { heartbeatAtMs: -0 },
    { acknowledgedAtMs: 1.5, phase: 'RUNNING', providerId: 'primary', activeSessionGeneration: 1n },
    { lastObservation: { observedAtMs: NOW_MS, slot: -1n } },
    { lastObservation: { observedAtMs: NOW_MS, slot: 10n ** 78n } },
    { lastObservation: { observedAtMs: NOW_MS, slot: 1 } },
    { disconnect: { occurredAtMs: NOW_MS, reasonCode: 'REMOTE_PRIVATE_REASON' } },
    { supervision: 'ENABLED' },
    { phase: 'OPEN' },
    { recovery: { status: 'REQUIRED', startedAtMs: null, completedAtMs: null, reasonCode: 'NETWORK_TEXT' } },
    { evidencePurgeAfterMs: Number.POSITIVE_INFINITY },
  ]) assertInvalid(() => createWebSocketHealthSnapshot(validInput(overrides)));
});

void test('rejects getters, inherited fields, and non-data or extra properties without invoking accessors', () => {
  let getterCalls = 0;
  const getter = validInput();
  Object.defineProperty(getter, 'providerId', {
    enumerable: true,
    get: () => { getterCalls += 1; return null; },
  });
  const inherited = Object.assign(Object.create({ payloadVersion: 1 }) as object, validInput());
  delete (inherited as Record<string, unknown>).payloadVersion;
  const hidden = validInput();
  Object.defineProperty(hidden, 'secret', { value: 'wss://secret.invalid', enumerable: false });
  const symbol = validInput();
  Object.defineProperty(symbol, Symbol('secret'), { value: 'private', enumerable: true });

  for (const value of [getter, inherited, hidden, symbol]) {
    assertInvalid(() => createWebSocketHealthSnapshot(value));
  }
  assert.equal(getterCalls, 0);
});

void test('rejects top-level and nested proxies without invoking their traps', () => {
  let traps = 0;
  const trap = (): never => {
    traps += 1;
    throw new Error('wss://secret.invalid/private proxy trap');
  };
  const topLevel = new Proxy(validInput(), {
    getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  });
  const nested = new Proxy({}, {
    getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  });
  const canonical = createWebSocketHealthSnapshot(validInput());
  const assertedTopLevel = new Proxy(canonical, {
    getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap,
  });
  const assertedNested = Object.freeze({ ...canonical, recovery: nested });

  assertInvalid(() => createWebSocketHealthSnapshot(topLevel));
  assertInvalid(() => createWebSocketHealthSnapshot(validInput({ recovery: nested })));
  assertInvalid(() => { assertValidWebSocketHealthSnapshot(assertedTopLevel); });
  assertInvalid(() => { assertValidWebSocketHealthSnapshot(assertedNested); });
  assert.equal(traps, 0);
});

void test('assertion rejects mutable top-level and nested snapshots', () => {
  const canonical = createWebSocketHealthSnapshot(validInput());
  const mutableTopLevel = { ...canonical };
  const mutableRecovery = Object.freeze({ ...canonical, recovery: { ...canonical.recovery } });
  const mutableObservation = Object.freeze({
    ...canonical,
    lastObservation: { observedAtMs: NOW_MS, slot: 1n },
  });

  assertInvalid(() => { assertValidWebSocketHealthSnapshot(mutableTopLevel); });
  assertInvalid(() => { assertValidWebSocketHealthSnapshot(mutableRecovery); });
  assertInvalid(() => { assertValidWebSocketHealthSnapshot(mutableObservation); });
});

function validInput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    payloadVersion: 1,
    supervision: 'ACTIVE',
    ownerGeneration: 1n,
    revision: 0n,
    activeSessionGeneration: null,
    candidateSessionGeneration: null,
    providerId: null,
    candidateProviderId: null,
    phase: 'STOPPED',
    acknowledgedAtMs: null,
    lastObservation: null,
    disconnect: null,
    recovery: {
      status: 'NOT_REQUIRED', startedAtMs: null, completedAtMs: null, reasonCode: null,
    },
    heartbeatAtMs: null,
    updatedAtMs: NOW_MS,
    evidencePurgeAfterMs: null,
    ...overrides,
  };
}

function validInputsForEveryPhase(): readonly Record<string, unknown>[] {
  return [
    validInput({ phase: 'STOPPED' }),
    validInput({ phase: 'CONNECTING', candidateSessionGeneration: 2n, candidateProviderId: 'primary' }),
    validInput({ phase: 'WAITING_FOR_ACKS', candidateSessionGeneration: 2n, candidateProviderId: 'primary' }),
    validInput({
      phase: 'ACKNOWLEDGED', candidateSessionGeneration: 2n, candidateProviderId: 'primary',
      acknowledgedAtMs: NOW_MS,
    }),
    validInput({
      phase: 'RECOVERING', candidateSessionGeneration: 2n, candidateProviderId: 'primary',
      acknowledgedAtMs: NOW_MS,
      recovery: { status: 'IN_PROGRESS', startedAtMs: NOW_MS, completedAtMs: null, reasonCode: 'STARTUP' },
    }),
    validInput({
      phase: 'RUNNING', activeSessionGeneration: 2n, providerId: 'primary',
      acknowledgedAtMs: NOW_MS,
    }),
    validInput({
      phase: 'DEGRADED', activeSessionGeneration: 2n, providerId: 'primary',
      acknowledgedAtMs: NOW_MS,
      disconnect: { occurredAtMs: NOW_MS, reasonCode: 'REMOTE_CLOSE' },
      recovery: { status: 'REQUIRED', startedAtMs: null, completedAtMs: null, reasonCode: 'SESSION_FAILURE' },
    }),
    validInput({
      phase: 'UNRECOVERABLE',
      recovery: { status: 'FAILED', startedAtMs: NOW_MS - 1, completedAtMs: NOW_MS, reasonCode: 'CATCH_UP_WINDOW_EXCEEDED' },
    }),
    validInput({
      phase: 'STOPPING', activeSessionGeneration: 2n, providerId: 'primary',
      acknowledgedAtMs: NOW_MS,
    }),
  ];
}

function assertInvalid(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof WebSocketHealthValidationError);
    assert.equal(error.message, 'Invalid WebSocket health snapshot.');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(String(error), /secret|private|wss?:\/\//iu);
    return true;
  });
}

const _snapshotContract: WebSocketHealthSnapshot | null = null;
void _snapshotContract;
