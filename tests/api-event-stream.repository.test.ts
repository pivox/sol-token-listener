import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiEventStreamDataError,
  MAX_API_EVENT_JSON_BYTES,
  MAX_API_PAYLOAD_JSON_BYTES,
  PostgresApiEventStreamRepository,
  type Queryable,
} from '../src/storage/api-event-stream.repository.js';
import { ApiEventStreamCursorExpiredError } from '../src/ports/api-event-stream-repository.js';

interface Call {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

class FakeQueryable implements Queryable {
  public readonly calls: Call[] = [];

  public constructor(private readonly respond: (call: Call) => readonly Record<string, unknown>[]) {}

  public async query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }> {
    const call = { text, values };
    this.calls.push(call);
    return { rows: this.respond(call) };
  }
}

const event = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  eventId: 'event-1', type: 'TokenLaunchDetected', mint: 'mint-1', source: 'listener',
  program: 'program-1', signature: 'signature-1', slot: '900719925474099312345',
  transactionIndex: 3, instructionIndex: 4, innerInstructionIndex: null,
  confirmationStatus: 'confirmed', blockchainTime: '2026-07-29T12:00:00.000Z',
  observedAt: '2026-07-29T12:00:01.000Z', payloadVersion: 1, payload: { amount: '42' },
  ...overrides,
});

const row = (sequence: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sequence, stream_event_id: `stream-${sequence}`, domain_event_id: 'event-1', revision: '1',
  event_type: 'TokenLaunchDetected', mint: 'mint-1', confirmation_status: 'confirmed',
  payload_version: 1, event: event(), ...overrides,
});

const state = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  state_count: '1',
  last_sequence: '8',
  expired_through: '0',
  ...overrides,
});

const emptyBatch = {
  sequence: null,
  stream_event_id: null,
  domain_event_id: null,
  revision: null,
  event_type: null,
  mint: null,
  confirmation_status: null,
  payload_version: null,
  event: null,
} as const;

const batchResult = (
  batch: Record<string, unknown> | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...state(),
  cursor_status: 'CURRENT',
  ...(batch ?? emptyBatch),
  ...overrides,
});

void test('reads the currently retained non-expired high-water mark', async () => {
  const empty = new PostgresApiEventStreamRepository(new FakeQueryable(() => [{
    ...state({ last_sequence: '8', expired_through: '8' }),
    high_water_mark: '0',
  }]));
  assert.equal(await empty.highWaterMark(), 0n);

  const database = new FakeQueryable(() => [{
    ...state({ last_sequence: '9223372036854775807' }),
    high_water_mark: '9223372036854775807',
  }]);
  const large = new PostgresApiEventStreamRepository(database, 'api_data');
  assert.equal(await large.highWaterMark(), 9223372036854775807n);
  assert.match(database.calls[0]?.text ?? '', /COALESCE\(MAX\(sequence\), 0\)::text AS high_water_mark/u);
  assert.match(database.calls[0]?.text ?? '', /purge_after > clock_timestamp\(\)/u);
  assert.match(database.calls[0]?.text ?? '', /"api_data"\."api_event_stream"/u);
  assert.match(database.calls[0]?.text ?? '', /FROM "api_data"\."api_event_stream_state"/u);
  assert.match(database.calls[0]?.text ?? '', /WHERE id = 1/u);
});

void test('rejects absent, duplicate, numeric, and malformed durable state', async () => {
  for (const rows of [
    [],
    [{ ...state({ state_count: '0', last_sequence: null, expired_through: null }), high_water_mark: '0' }],
    [{ ...state({ state_count: '2' }), high_water_mark: '8' }],
    [{ ...state({ expired_through: '9' }), high_water_mark: '8' }],
    [{ ...state(), high_water_mark: 1 }],
    [{ ...state(), high_water_mark: '01' }],
    [{ ...state({ last_sequence: '9223372036854775808' }), high_water_mark: '8' }],
  ]) {
    const repository = new PostgresApiEventStreamRepository(new FakeQueryable(() => rows));
    await assert.rejects(repository.highWaterMark(), (error: unknown) => {
      assert.ok(error instanceof ApiEventStreamDataError);
      assert.equal(error.message, 'Stored API event stream data is invalid.');
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
});

void test('wraps database failures with the fixed public data error', async () => {
  const database: Queryable = {
    query: async () => { throw new Error('postgresql connection string leaked'); },
  };
  const repository = new PostgresApiEventStreamRepository(database);
  for (const operation of [
    () => repository.highWaterMark(),
    () => repository.resolve(1n),
    () => repository.readAfter(0n, 1),
  ]) {
    await assert.rejects(operation(), (error: unknown) => {
      assert.ok(error instanceof ApiEventStreamDataError);
      assert.equal(error.message, 'Stored API event stream data is invalid.');
      assert.ok(error.cause instanceof Error);
      assert.doesNotMatch(error.message, /postgresql|connection/u);
      return true;
    });
  }
});

void test('resolves retained, future, floor-expired, and logically expired cursors atomically', async () => {
  const currentDb = new FakeQueryable(() => [{
    ...state(),
    cursor_retained: true,
  }]);
  const current = new PostgresApiEventStreamRepository(currentDb, 'api_data');
  assert.deepEqual(await current.resolve(5n), { status: 'CURRENT', sequence: 5n });
  assert.match(currentDb.calls[0]?.text ?? '', /"api_data"\."api_event_stream_state"/u);
  assert.match(currentDb.calls[0]?.text ?? '', /"api_data"\."api_event_stream"/u);
  assert.doesNotMatch(currentDb.calls[0]?.text ?? '', /FROM\s+api_event_stream_state/u);
  assert.deepEqual(currentDb.calls[0]?.values, ['5']);
  assert.equal(currentDb.calls.length, 1);
  assert.match(currentDb.calls[0]?.text ?? '', /purge_after > retained_at/u);

  const future = new PostgresApiEventStreamRepository(new FakeQueryable(() => [{
    ...state(),
    cursor_retained: false,
  }]));
  assert.deepEqual(await future.resolve(9n), { status: 'FUTURE' });

  const floorExpired = new PostgresApiEventStreamRepository(new FakeQueryable(() => [{
    ...state({ expired_through: '5' }),
    cursor_retained: false,
  }]));
  assert.deepEqual(await floorExpired.resolve(5n), { status: 'EXPIRED' });

  const logicalExpiry = new PostgresApiEventStreamRepository(new FakeQueryable(() => [{
    ...state(),
    cursor_retained: false,
  }]));
  assert.deepEqual(await logicalExpiry.resolve(5n), { status: 'EXPIRED' });
});

void test('reads non-contiguous revisions in ascending sequence without duplicates', async () => {
  const database = new FakeQueryable((call) => call.values?.[0] === '0'
    ? [
      batchResult(row('5')),
      batchResult(row('8', { event: JSON.stringify(event({ payload: { amount: { $solTokenListenerBigInt: '900719925474099312345' } } })) })),
    ]
    : [batchResult(null)]);
  const repository = new PostgresApiEventStreamRepository(database);
  const first = await repository.readAfter(0n, 20);
  const second = await repository.readAfter(8n, 20);

  assert.deepEqual(first.map((item) => item.sequence), [5n, 8n]);
  assert.deepEqual(first[1]?.event.payload, { amount: '900719925474099312345' });
  assert.deepEqual(second, []);
  assert.match(database.calls[0]?.text ?? '', /stream\.sequence > \$1[\s\S]*ORDER BY stream\.sequence ASC[\s\S]*LIMIT \$2/u);
  assert.deepEqual(database.calls[0]?.values, ['0', 20]);
  assert.deepEqual(database.calls[1]?.values, ['8', 20]);
  assert.equal(database.calls.length, 2);
  assert.match(database.calls[0]?.text ?? '', /^WITH retained_clock AS MATERIALIZED/u);
  assert.match(database.calls[0]?.text ?? '', /expired_through_sequence/u);
  assert.match(database.calls[0]?.text ?? '', /cursor_status/u);
  assert.match(
    database.calls[0]?.text ?? '',
    /purge_after > (?:retained_clock|cursor_snapshot)\.retained_at/u,
  );
  assert.match(database.calls[0]?.text ?? '', /domain_event_id/u);
  assert.match(database.calls[0]?.text ?? '', /revision::text AS revision/u);
  assert.match(database.calls[0]?.text ?? '', /payload_version/u);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0]), true);
  assert.equal(Object.isFrozen(first[0]?.event ?? {}), true);
  assert.equal(Object.isFrozen(first[0]?.event.cursor ?? {}), true);
  assert.equal(Object.isFrozen(first[0]?.event.payload ?? {}), true);
});

void test('readAfter rejects an expired cursor in its single statement instead of returning an empty batch', async () => {
  for (const expiredThrough of ['0', '5']) {
    const database = new FakeQueryable(() => [batchResult(null, {
      expired_through: expiredThrough,
      cursor_status: 'EXPIRED',
    })]);
    const repository = new PostgresApiEventStreamRepository(database);

    await assert.rejects(repository.readAfter(5n, 20), (error: unknown) => {
      assert.ok(error instanceof ApiEventStreamCursorExpiredError);
      assert.equal(error.message, 'API event stream cursor has expired.');
      return true;
    });
    assert.equal(database.calls.length, 1);
  }
});

void test('readAfter treats a future cursor or corrupt state as stored-data errors', async () => {
  for (const result of [
    batchResult(null, { cursor_status: 'FUTURE' }),
    batchResult(null, {
      state_count: '0',
      last_sequence: null,
      expired_through: null,
      cursor_status: 'INVALID_STATE',
    }),
  ]) {
    const repository = new PostgresApiEventStreamRepository(new FakeQueryable(() => [result]));
    await assert.rejects(repository.readAfter(9n, 20), ApiEventStreamDataError);
  }
});

void test('readAfter allows the internal zero cursor after a total purge', async () => {
  const database = new FakeQueryable(() => [batchResult(null, {
    last_sequence: '8',
    expired_through: '8',
    cursor_status: 'CURRENT',
  })]);

  assert.deepEqual(
    await new PostgresApiEventStreamRepository(database).readAfter(0n, 20),
    [],
  );
  assert.equal(database.calls.length, 1);
});

void test('resolve rejects missing or corrupt state instead of inferring a cursor status', async () => {
  for (const result of [
    { ...state({ state_count: '0', last_sequence: null, expired_through: null }), cursor_retained: false },
    { ...state({ expired_through: '9' }), cursor_retained: false },
  ]) {
    const repository = new PostgresApiEventStreamRepository(new FakeQueryable(() => [result]));
    await assert.rejects(repository.resolve(5n), ApiEventStreamDataError);
  }
});

void test('rejects unsafe arguments before querying and rejects invalid schemas', async () => {
  const database = new FakeQueryable(() => []);
  const repository = new PostgresApiEventStreamRepository(database);
  for (const value of [-1n, 9223372036854775808n]) {
    await assert.rejects(repository.readAfter(value, 1), RangeError);
  }
  for (const value of [0, 201]) await assert.rejects(repository.readAfter(0n, value), RangeError);
  await assert.rejects(repository.resolve(0n), RangeError);
  assert.equal(database.calls.length, 0);
  assert.throws(() => new PostgresApiEventStreamRepository(database, 'public; DROP TABLE api_event_stream'), RangeError);
});

void test('wraps malformed rows and detects column disagreement', async () => {
  const invalids: readonly Record<string, unknown>[] = [
    row('01'), row('5', { sequence: 5 }), row('5', { revision: '0' }), row('5', { revision: 1 }),
    row('5', { event: '{' }), row('5', { event: event({ type: 'Nope' }) }),
    row('5', { event: event({ confirmationStatus: 'nope' }) }),
    row('5', { event: event({ observedAt: '2026-07-29' }) }),
    row('5', { event: event({ transactionIndex: -1 }) }),
    row('5', { event: event({ slot: '01' }) }),
    row('5', { event: event({ payload: { amount: 42 } }) }),
    row('5', { event_type: 'QualificationUpdated' }),
    row('5', { mint: 'other-mint' }),
    row('5', { confirmation_status: 'finalized' }),
    row('5', { domain_event_id: 'event-2' }),
    row('5', { payload_version: 2 }),
  ];
  for (const invalid of invalids) {
    const repository = new PostgresApiEventStreamRepository(
      new FakeQueryable(() => [batchResult(invalid)]),
    );
    await assert.rejects(repository.readAfter(0n, 1), (error: unknown) => {
      assert.ok(error instanceof ApiEventStreamDataError);
      assert.equal(error.message, 'Stored API event stream data is invalid.');
      assert.doesNotMatch(error.message, /stream-5|sequence=|SELECT|Nope/u);
      return true;
    });
  }
});

void test('requires the exact flat persisted event keys', async () => {
  const missing = event();
  delete missing.signature;
  for (const storedEvent of [missing, event({ unexpected: true })]) {
    const repository = new PostgresApiEventStreamRepository(
      new FakeQueryable(() => [batchResult(row('5', { event: storedEvent }))]),
    );
    await assert.rejects(repository.readAfter(0n, 1), ApiEventStreamDataError);
  }
});

void test('reserves valid singleton bigint markers and preserves non-singleton collisions', async () => {
  const storedEvent = event({
    payload: {
      decoded: { $solTokenListenerBigInt: '-900719925474099312345' },
      collision: { $solTokenListenerBigInt: '42', meaning: 'business-data' },
    },
  });
  const repository = new PostgresApiEventStreamRepository(
    new FakeQueryable(() => [batchResult(row('5', { event: storedEvent }))]),
  );

  const revisions = await repository.readAfter(0n, 1);

  assert.deepEqual(revisions[0]?.event.payload, {
    decoded: '-900719925474099312345',
    collision: { $solTokenListenerBigInt: '42', meaning: 'business-data' },
  });
});

void test('rejects malformed or oversized reserved bigint markers before decoding', async () => {
  for (const marker of ['+1', '01', '-0', '9'.repeat(79)]) {
    const repository = new PostgresApiEventStreamRepository(new FakeQueryable(() => [
      batchResult(row('5', { event: event({ payload: { amount: { $solTokenListenerBigInt: marker } } }) })),
    ]));
    await assert.rejects(repository.readAfter(0n, 1), ApiEventStreamDataError);
  }
});

void test('bounds encoded event and sanitized payload JSON to one MiB', async () => {
  assert.equal(MAX_API_EVENT_JSON_BYTES, 1024 * 1024);
  assert.equal(MAX_API_PAYLOAD_JSON_BYTES, 1024 * 1024);
  const oversizedPayload = { text: 'x'.repeat(MAX_API_PAYLOAD_JSON_BYTES) };
  const objectRepository = new PostgresApiEventStreamRepository(new FakeQueryable(() => [
    batchResult(row('5', { event: event({ payload: oversizedPayload }) })),
  ]));
  await assert.rejects(objectRepository.readAfter(0n, 1), ApiEventStreamDataError);

  const oversizedEncoded = `${' '.repeat(MAX_API_EVENT_JSON_BYTES)}{}`;
  const stringRepository = new PostgresApiEventStreamRepository(new FakeQueryable(() => [
    batchResult(row('5', { event: oversizedEncoded })),
  ]));
  await assert.rejects(stringRepository.readAfter(0n, 1), ApiEventStreamDataError);
});

void test('sanitizes object payloads without invoking getters', async () => {
  let invoked = false;
  const payload = {};
  Object.defineProperty(payload, 'amount', {
    enumerable: true,
    get: () => {
      invoked = true;
      return '42';
    },
  });
  const repository = new PostgresApiEventStreamRepository(new FakeQueryable(() => [
    batchResult(row('5', { event: event({ payload }) })),
  ]));

  await assert.rejects(repository.readAfter(0n, 1), ApiEventStreamDataError);
  assert.equal(invoked, false);
});
