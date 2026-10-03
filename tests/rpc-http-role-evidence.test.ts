import assert from 'node:assert/strict';
import test from 'node:test';
import { RPC_PROVIDER_IDS } from '../src/domain/rpc-provider.js';
import {
  RPC_HTTP_ROLES,
  assertValidRuntimeRpcHttpRoleEvidence,
  createRuntimeRpcHttpRoleEvidence,
} from '../src/domain/rpc-http-role-evidence.js';

const zeroCell = (providerId: string, role: string) => ({
  providerId, role, attempts: 0, responses: 0, http429Responses: 0,
  failures: 0, inFlight: 0, maxInFlight: 0,
  headerLatencyBuckets: Array<number>(10).fill(0), maxHeaderLatencyMs: 0,
});

function validInput() {
  return {
    version: 1, overflowed: false,
    entries: RPC_PROVIDER_IDS.flatMap((providerId) => [
      'SOURCE', 'FINALITY', 'BLOCK_HYDRATION', 'SHARED_CLIENT',
    ].map((role) => zeroCell(providerId, role))),
  };
}

void test('publishes fixed roles and returns a detached deeply frozen provider-major snapshot', () => {
  assert.deepEqual(RPC_HTTP_ROLES, ['SOURCE', 'FINALITY', 'BLOCK_HYDRATION', 'SHARED_CLIENT']);
  assert.ok(Object.isFrozen(RPC_HTTP_ROLES));
  const input = validInput();
  const first = input.entries[0];
  assert.ok(first);
  first.attempts = 3;
  first.responses = 2;
  first.http429Responses = 1;
  first.inFlight = 1;
  first.maxInFlight = 2;
  first.headerLatencyBuckets[0] = 1;
  first.headerLatencyBuckets[9] = 1;
  first.maxHeaderLatencyMs = 31_000;
  const snapshot = createRuntimeRpcHttpRoleEvidence(input);

  assert.deepEqual(snapshot.entries.map(({ providerId, role }) => [providerId, role]),
    RPC_PROVIDER_IDS.flatMap((providerId) => RPC_HTTP_ROLES.map((role) => [providerId, role])));
  assert.deepEqual(Reflect.ownKeys(snapshot), ['version', 'overflowed', 'entries']);
  assert.deepEqual(Reflect.ownKeys(snapshot.entries[0] ?? {}), [
    'providerId', 'role', 'attempts', 'responses', 'http429Responses', 'failures',
    'inFlight', 'maxInFlight', 'headerLatencyBuckets', 'maxHeaderLatencyMs',
  ]);
  assert.equal(snapshot.entries.length, 16);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.entries));
  assert.ok(snapshot.entries.every((entry) => Object.isFrozen(entry)
    && Object.isFrozen(entry.headerLatencyBuckets) && entry.headerLatencyBuckets.length === 10));
  assert.notStrictEqual(snapshot, input);
  assert.notStrictEqual(snapshot.entries, input.entries);
  assert.notStrictEqual(snapshot.entries[0], input.entries[0]);
  assert.notStrictEqual(snapshot.entries[0]?.headerLatencyBuckets, input.entries[0]?.headerLatencyBuckets);
  first.headerLatencyBuckets[0] = 0;
  assert.equal(snapshot.entries[0]?.headerLatencyBuckets[0], 1);
  assert.doesNotThrow(() => { assertValidRuntimeRpcHttpRoleEvidence(snapshot); });
});

void test('rejects noncanonical order, cardinality, fields, counters and histogram shape', () => {
  const valid = validInput();
  const variants: unknown[] = [
    { ...valid, version: 2 },
    { ...valid, endpoint: 'secret' },
    { ...valid, entries: valid.entries.slice(1) },
    { ...valid, entries: [...valid.entries].reverse() },
    { ...valid, entries: valid.entries.map((entry, index) => index === 0 ? { ...entry, role: 'WORKER' } : entry) },
    { ...valid, entries: valid.entries.map((entry, index) => index === 0 ? { ...entry, signature: 'secret' } : entry) },
    { ...valid, entries: valid.entries.map((entry, index) => index === 0 ? { ...entry, attempts: -0 } : entry) },
    { ...valid, entries: valid.entries.map((entry, index) => index === 0 ? { ...entry, failures: Number.MAX_SAFE_INTEGER + 1 } : entry) },
    { ...valid, entries: valid.entries.map((entry, index) => index === 0 ? { ...entry, maxHeaderLatencyMs: 0.5 } : entry) },
    { ...valid, entries: valid.entries.map((entry, index) => index === 0 ? { ...entry, headerLatencyBuckets: Array<number>(9).fill(0) } : entry) },
    { ...valid, entries: valid.entries.map((entry, index) => index === 0 ? { ...entry, headerLatencyBuckets: [...entry.headerLatencyBuckets, 0] } : entry) },
    { ...valid, entries: valid.entries.map((entry, index) => index === 0 ? { ...entry, headerLatencyBuckets: [NaN, ...entry.headerLatencyBuckets.slice(1)] } : entry) },
  ];
  for (const variant of variants) {
    assert.throws(() => { assertValidRuntimeRpcHttpRoleEvidence(variant); }, TypeError);
  }
});

void test('requires exact nonoverflowed accounting while allowing saturated overflow snapshots', () => {
  const valid = validInput();
  const first = valid.entries[0];
  assert.ok(first);
  const invalidCells = [
    { ...first, attempts: 1 },
    { ...first, attempts: 1, responses: 1 },
    { ...first, attempts: 1, responses: 1, http429Responses: 2, headerLatencyBuckets: [1, ...first.headerLatencyBuckets.slice(1)] },
    { ...first, attempts: 1, inFlight: 1, maxInFlight: 0 },
  ];
  for (const cell of invalidCells) {
    const entries = [...valid.entries];
    entries[0] = cell;
    assert.throws(() => { assertValidRuntimeRpcHttpRoleEvidence({ ...valid, entries }); }, TypeError);
  }
  const overflowed = { ...valid, overflowed: true, entries: [...valid.entries] };
  overflowed.entries[0] = { ...first, attempts: Number.MAX_SAFE_INTEGER, responses: 1 };
  assert.doesNotThrow(() => { assertValidRuntimeRpcHttpRoleEvidence(overflowed); });
});

void test('rejects proxies, getters, symbols and sparse arrays without invoking hostile code', () => {
  const valid = validInput();
  let reads = 0;
  const hostile = (): never => { reads += 1; throw new Error('should not read'); };
  const topAccessor = { ...valid };
  Object.defineProperty(topAccessor, 'entries', { enumerable: true, get: hostile });
  const cellAccessor = { ...valid.entries[0] };
  Object.defineProperty(cellAccessor, 'attempts', { enumerable: true, get: hostile });
  const bucketAccessor = Array<number>(10).fill(0);
  Object.defineProperty(bucketAccessor, '0', { enumerable: true, get: hostile });
  const sparseBuckets = Array<number>(10);
  const variants: unknown[] = [
    new Proxy(valid, { ownKeys: hostile }), topAccessor,
    { ...valid, entries: new Proxy(valid.entries, { ownKeys: hostile }) },
    { ...valid, entries: [new Proxy(valid.entries[0] ?? {}, { ownKeys: hostile }), ...valid.entries.slice(1)] },
    { ...valid, entries: [cellAccessor, ...valid.entries.slice(1)] },
    { ...valid, entries: [{ ...valid.entries[0], headerLatencyBuckets: bucketAccessor }, ...valid.entries.slice(1)] },
    { ...valid, entries: [{ ...valid.entries[0], headerLatencyBuckets: sparseBuckets }, ...valid.entries.slice(1)] },
    Object.assign({ ...valid }, { [Symbol('hidden')]: 1 }),
  ];
  for (const variant of variants) {
    assert.throws(() => { createRuntimeRpcHttpRoleEvidence(variant); }, TypeError);
  }
  assert.equal(reads, 0);
});
