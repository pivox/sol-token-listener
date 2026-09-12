import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMP_EVENTS } from '../src/launchpads/pumpfun/generated/pump-idl.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import {
  WsProgramSessionError,
  openWsProgramSession,
  type WsProgramSessionScheduler,
  type WsProgramSessionWebSocket,
} from '../src/solana/rpc/ws-program-session.js';

void test('opens only after both confirmed subscriptions acknowledge and forwards the first program immediately', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const signature = '1'.repeat(64);
  const frames: unknown[] = [];
  const opening = openWsProgramSession(
    { id: 'primary', url: 'wss://user:secret@rpc.invalid/private' },
    async (frame) => { frames.push(frame); },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  );
  const state = settlement(opening);

  socket.open();
  assert.deepEqual(socket.sent.map(parseJson), [
    {
      jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
      params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: 'confirmed' }],
    },
    {
      jsonrpc: '2.0', id: 2, method: 'logsSubscribe',
      params: [{ mentions: [PUMPSWAP_PROGRAM_ID] }, { commitment: 'confirmed' }],
    },
  ]);
  assert.equal(await state(), 'pending');

  socket.message({ jsonrpc: '2.0', id: 2, result: 102 });
  socket.message(notification(102, 41, signature));
  assert.equal(await state(), 'pending');
  assert.deepEqual(frames, [{
    endpointId: 'primary',
    program: 'pumpswap',
    signature,
    slot: 41n,
    hint: 'NONE',
    hintMint: null,
  }]);

  socket.message({ jsonrpc: '2.0', id: 1, result: 101 });
  const session = await opening;
  assert.equal(session.endpointId, 'primary');
  assert.ok(Object.isFrozen(session));
  assert.equal(scheduler.pendingCount, 0);
});

void test('subscribes and unsubscribes only the configured launchpad program', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const signature = '1'.repeat(64);
  const frames: unknown[] = [];
  const opening = openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async (frame) => { frames.push(frame); },
    new AbortController().signal,
    {
      createWebSocket: () => socket,
      scheduler,
      programs: Object.freeze([Object.freeze({
        key: 'launchpad',
        family: 'pumpfun',
        id: PUMP_PROGRAM_ID,
      })]),
    },
  );

  socket.open();
  assert.deepEqual(socket.sent.map(parseJson), [{
    jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
    params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: 'confirmed' }],
  }]);
  socket.message({ jsonrpc: '2.0', id: 1, result: 101 });
  const session = await opening;
  socket.message(notification(101, 41, signature));
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(frames, [{
    endpointId: 'primary',
    program: 'pumpfun',
    signature,
    slot: 41n,
    hint: 'NONE',
    hintMint: null,
  }]);

  const closing = session.close(new AbortController().signal);
  assert.deepEqual(socket.sent.slice(1).map(parseJson), [{
    jsonrpc: '2.0', id: 3, method: 'logsUnsubscribe', params: [101],
  }]);
  socket.message({ jsonrpc: '2.0', id: 3, result: true });
  await closing;
  assert.equal(socket.closeCalls, 1);
});

void test('derives only the closed Pump.fun create hint from the official event discriminator', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const frames: unknown[] = [];
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async (frame) => { frames.push(frame); },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  const encodedCreateEvent = Buffer.concat([
    Buffer.from(PUMP_EVENTS.CreateEvent.discriminator),
    Buffer.from([0, 1, 2, 3]),
  ]).toString('base64');

  socket.message(notification(
    101,
    42,
    '1'.repeat(64),
    null,
    [`Program data: ${encodedCreateEvent}`],
  ));
  await new Promise<void>((resolve) => { setImmediate(resolve); });

  assert.deepEqual(frames, [Object.freeze({
    endpointId: 'primary',
    program: 'pumpfun',
    signature: '1'.repeat(64),
    slot: 42n,
    hint: 'PUMPFUN_CREATE',
    hintMint: null,
  })]);
  assert.equal(Object.hasOwn(frames[0] as object, 'logs'), false);
  const closing = session.close(new AbortController().signal);
  socket.message({ jsonrpc: '2.0', id: 3, result: true });
  socket.message({ jsonrpc: '2.0', id: 4, result: true });
  await closing;
});

void test('forwards the detached canonical Pump.fun trade mint', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const frames: unknown[] = [];
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async (frame) => { frames.push(frame); },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  const mint = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
  const encodedTradeEvent = Buffer.concat([
    Buffer.from(PUMP_EVENTS.TradeEvent.discriminator), mint.toBytes(),
  ]).toString('base64');

  socket.message(notification(101, 43, '1'.repeat(64), null, [`Program data: ${encodedTradeEvent}`]));
  await new Promise<void>((resolve) => { setImmediate(resolve); });

  assert.deepEqual(frames, [Object.freeze({
    endpointId: 'primary', program: 'pumpfun', signature: '1'.repeat(64), slot: 43n,
    hint: 'PUMPFUN_TRADE', hintMint: mint.toBase58(),
  })]);
  const closing = session.close(new AbortController().signal);
  socket.message({ jsonrpc: '2.0', id: 3, result: true });
  socket.message({ jsonrpc: '2.0', id: 4, result: true });
  await closing;
});

void test('keeps the create hint when a Pump.fun notification contains both trade and create events', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const frames: unknown[] = [];
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async (frame) => { frames.push(frame); },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  const mint = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
  const encodedTradeEvent = Buffer.concat([
    Buffer.from(PUMP_EVENTS.TradeEvent.discriminator), mint.toBytes(),
  ]).toString('base64');
  const encodedCreateEvent = Buffer.from(PUMP_EVENTS.CreateEvent.discriminator).toString('base64');

  socket.message(notification(101, 43, '1'.repeat(64), null, [
    `Program data: ${encodedTradeEvent}`, `Program data: ${encodedCreateEvent}`,
  ]));
  await new Promise<void>((resolve) => { setImmediate(resolve); });

  assert.deepEqual(frames, [Object.freeze({
    endpointId: 'primary', program: 'pumpfun', signature: '1'.repeat(64), slot: 43n,
    hint: 'PUMPFUN_CREATE', hintMint: null,
  })]);
  const closing = session.close(new AbortController().signal);
  socket.message({ jsonrpc: '2.0', id: 3, result: true });
  socket.message({ jsonrpc: '2.0', id: 4, result: true });
  await closing;
});

void test('rejects accessor-backed ingestion programs before opening a socket', async () => {
  let getterCalls = 0;
  let socketCalls = 0;
  const programs = Object.defineProperty([], '0', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return { key: 'launchpad', family: 'pumpfun', id: PUMP_PROGRAM_ID };
    },
  });
  Object.defineProperty(programs, 'length', { value: 1 });

  await assert.rejects(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => undefined,
    new AbortController().signal,
    {
      createWebSocket: () => { socketCalls += 1; return new FakeWebSocket(); },
      programs,
    },
  ), (error: unknown) => {
    assertStableError(error, 'PROTOCOL_INVALID');
    return true;
  });
  assert.equal(getterCalls, 0);
  assert.equal(socketCalls, 0);

  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  await assert.rejects(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => undefined,
    new AbortController().signal,
    { programs: revoked.proxy },
  ), (error: unknown) => {
    assertStableError(error, 'PROTOCOL_INVALID');
    return true;
  });
});

void test('accepts native Node MessageEvent frames with inherited data accessors', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const opening = openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => undefined,
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  );

  socket.open();
  socket.nativeMessage({ jsonrpc: '2.0', id: 1, result: 101 });
  socket.nativeMessage({ jsonrpc: '2.0', id: 2, result: 102 });
  const session = await opening;
  const closing = session.close(new AbortController().signal);
  socket.nativeMessage({ jsonrpc: '2.0', id: 3, result: true });
  socket.nativeMessage({ jsonrpc: '2.0', id: 4, result: true });
  await closing;

  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('rejects proxied native frames and inherited application getters without invoking them',
  async () => {
    let inheritedGetterCalls = 0;
    const inherited = Object.create(Object.defineProperty({}, 'data', {
      enumerable: true,
      get: () => {
        inheritedGetterCalls += 1;
        return JSON.stringify({ jsonrpc: '2.0', id: 1, result: 101 });
      },
    })) as object;
    const native = new MessageEvent('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: 101 }),
    });
    const revoked = Proxy.revocable(native, {});
    revoked.revoke();

    for (const frame of [inherited, new Proxy(native, {}), revoked.proxy]) {
      const socket = new FakeWebSocket();
      const scheduler = new ManualScheduler();
      const opening = openWsProgramSession(
        { id: 'primary', url: 'wss://rpc.invalid/private' },
        async () => undefined,
        new AbortController().signal,
        { createWebSocket: () => socket, scheduler },
      );
      socket.open();
      socket.messageEvent(frame);
      await assert.rejects(opening, (error: unknown) => {
        assertStableError(error, 'PROTOCOL_INVALID');
        return true;
      });
      assert.equal(socket.closeCalls, 1);
      assert.equal(socket.listenerCount, 0);
      assert.equal(scheduler.pendingCount, 0);
    }
    assert.equal(inheritedGetterCalls, 0);
  });

void test('rejects a partial acknowledgement at the fixed setup deadline and drains resources', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const opening = openWsProgramSession(
    { id: 'fallback-1', url: 'wss://user:secret@rpc.invalid/private' },
    async () => undefined,
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  );

  socket.open();
  socket.message({ jsonrpc: '2.0', id: 1, result: 101 });
  scheduler.runNext();

  await assert.rejects(opening, (error: unknown) => {
    assertStableError(error, 'SETUP_TIMEOUT');
    return true;
  });
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('drains an observation accepted after the first ACK before rejecting setup', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const observer = deferred();
  const opening = openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => { await observer.promise; },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  );
  const state = settlement(opening);
  socket.open();
  socket.message({ jsonrpc: '2.0', id: 1, result: 101 });
  socket.message(notification(101, 41, '1'.repeat(64)));

  scheduler.runNext();
  assert.equal(await state(), 'pending');
  observer.resolve();
  await assert.rejects(opening, (error: unknown) => {
    assertStableError(error, 'SETUP_TIMEOUT');
    return true;
  });
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('bounds a stuck pre-second-ACK observation with cleanup failure', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const observer = deferred();
  const opening = openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => { await observer.promise; },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  );
  socket.open();
  socket.message({ jsonrpc: '2.0', id: 1, result: 101 });
  socket.message(notification(101, 41, '1'.repeat(64)));

  scheduler.runNext();
  scheduler.runNext();

  await assert.rejects(opening, (error: unknown) => {
    assertStableError(error, 'CLEANUP_FAILED');
    return true;
  });
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('rejects malformed, duplicate, rejected, and oversized acknowledgements as redacted protocol failures', async () => {
  const cases: readonly Readonly<{
    name: string;
    messages: readonly unknown[];
  }>[] = [
    { name: 'jsonrpc', messages: [{ jsonrpc: '1.0', id: 1, result: 101 }] },
    { name: 'rpc-error', messages: [{ jsonrpc: '2.0', id: 1, error: { message: 'private rejection' } }] },
    { name: 'duplicate-response', messages: [
      { jsonrpc: '2.0', id: 1, result: 101 },
      { jsonrpc: '2.0', id: 1, result: 102 },
    ] },
    { name: 'duplicate-subscription', messages: [
      { jsonrpc: '2.0', id: 1, result: 101 },
      { jsonrpc: '2.0', id: 2, result: 101 },
    ] },
    { name: 'negative-subscription', messages: [{ jsonrpc: '2.0', id: 1, result: -1 }] },
    { name: 'malformed-json', messages: ['{private malformed'] },
    { name: 'oversized', messages: [`"${'x'.repeat(1_048_576)}"`] },
  ];

  for (const entry of cases) {
    const socket = new FakeWebSocket();
    const scheduler = new ManualScheduler();
    const opening = openWsProgramSession(
      { id: 'primary', url: 'wss://user:secret@rpc.invalid/private' },
      async () => undefined,
      new AbortController().signal,
      { createWebSocket: () => socket, scheduler },
    );
    socket.open();
    for (const message of entry.messages) {
      if (typeof message === 'string') socket.rawMessage(message);
      else socket.message(message);
    }
    await assert.rejects(opening, (error: unknown) => {
      assertStableError(error, 'PROTOCOL_INVALID');
      return true;
    }, entry.name);
    assert.equal(socket.closeCalls, 1, entry.name);
    assert.equal(socket.listenerCount, 0, entry.name);
    assert.equal(scheduler.pendingCount, 0, entry.name);
  }
});

void test('settles completion once with a redacted protocol failure for an unknown active subscription', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const session = await acknowledge(openWsProgramSession(
    { id: 'fallback-2', url: 'wss://user:secret@rpc.invalid/private' },
    async () => undefined,
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);

  socket.message(notification(999, 42, '1'.repeat(64)));
  const completion = await session.completion;
  assert.deepEqual(completion, { reason: 'PROTOCOL_INVALID' });
  assert.ok(Object.isFrozen(completion));
  socket.error();
  socket.disconnect(1006);
  assert.equal(await session.completion, completion);
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('closes idempotently only after both unsubscribe acknowledgements', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => undefined,
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  const controller = new AbortController();

  const first = session.close(controller.signal);
  const second = session.close(controller.signal);
  assert.equal(first, second);
  assert.deepEqual(socket.sent.slice(2).map(parseJson), [
    { jsonrpc: '2.0', id: 3, method: 'logsUnsubscribe', params: [101] },
    { jsonrpc: '2.0', id: 4, method: 'logsUnsubscribe', params: [102] },
  ]);
  const state = settlement(first);
  socket.message({ jsonrpc: '2.0', id: 4, result: true });
  assert.equal(await state(), 'pending');
  socket.message({ jsonrpc: '2.0', id: 3, result: true });

  await Promise.all([first, second]);
  assert.deepEqual(await session.completion, { reason: 'LOCAL_CLOSE' });
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('forces redacted cleanup failure on abort or the fixed cleanup deadline', async () => {
  for (const trigger of ['abort', 'timeout'] as const) {
    const socket = new FakeWebSocket();
    const scheduler = new ManualScheduler();
    const session = await acknowledge(openWsProgramSession(
      { id: 'fallback-3', url: 'wss://user:secret@rpc.invalid/private' },
      async () => undefined,
      new AbortController().signal,
      { createWebSocket: () => socket, scheduler },
    ), socket);
    const controller = new AbortController();
    const closing = session.close(controller.signal);
    let failure: unknown;
    void closing.catch((error: unknown) => { failure = error; });
    const state = settlement(closing);

    if (trigger === 'abort') controller.abort();
    else scheduler.runNext();

    assert.equal(await state(), 'rejected', trigger);
    assertStableError(failure, 'CLEANUP_FAILED');
    assert.deepEqual(await session.completion, { reason: 'CLEANUP_FAILED' });
    assert.equal(socket.closeCalls, 1, trigger);
    assert.equal(socket.listenerCount, 0, trigger);
    assert.equal(scheduler.pendingCount, 0, trigger);
  }
});

void test('rejects false or malformed unsubscribe acknowledgements and forces local cleanup', async () => {
  for (const response of [
    { jsonrpc: '2.0', id: 3, result: false },
    { jsonrpc: '2.0', id: 3, error: { message: 'private unsubscribe rejection' } },
    { jsonrpc: '1.0', id: 3, result: true },
  ]) {
    const socket = new FakeWebSocket();
    const scheduler = new ManualScheduler();
    const session = await acknowledge(openWsProgramSession(
      { id: 'primary', url: 'wss://rpc.invalid/private' },
      async () => undefined,
      new AbortController().signal,
      { createWebSocket: () => socket, scheduler },
    ), socket);
    const closing = session.close(new AbortController().signal);
    socket.message(response);
    socket.message({ jsonrpc: '2.0', id: 4, result: true });
    await assert.rejects(closing, (error: unknown) => {
      assertStableError(error, 'CLEANUP_FAILED');
      return true;
    });
    assert.deepEqual(await session.completion, { reason: 'CLEANUP_FAILED' });
    assert.equal(socket.closeCalls, 1);
    assert.equal(socket.listenerCount, 0);
    assert.equal(scheduler.pendingCount, 0);
  }
});

void test('turns observer rejection into a one-shot redacted session failure', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => { throw new Error('private durable enqueue failure'); },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  const state = settlement(session.completion);

  socket.message(notification(101, 42, '1'.repeat(64)));

  assert.equal(await state(), 'fulfilled');
  assert.deepEqual(await session.completion, { reason: 'NOTIFICATION_FAILED' });
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.listenerCount, 0);
});

void test('stops accepting and drains in-flight observers before close completes', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const observer = deferred();
  let observations = 0;
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => { observations += 1; await observer.promise; },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  socket.message(notification(101, 42, '1'.repeat(64)));
  assert.equal(observations, 1);

  const closing = session.close(new AbortController().signal);
  const state = settlement(closing);
  socket.message(notification(101, 43, '2'.repeat(64)));
  socket.message({ jsonrpc: '2.0', id: 3, result: true });
  socket.message({ jsonrpc: '2.0', id: 4, result: true });

  assert.equal(observations, 1);
  assert.equal(await state(), 'pending');
  observer.resolve();
  await closing;
  assert.deepEqual(await session.completion, { reason: 'LOCAL_CLOSE' });
});

void test('ignores failed transactions without observing raw logs or failing the session', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  let observations = 0;
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => { observations += 1; },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  const completionState = settlement(session.completion);

  socket.message(notification(
    101,
    42,
    '1'.repeat(64),
    { InstructionError: [0, 'private failure'] },
  ));

  assert.equal(observations, 0);
  assert.equal(await completionState(), 'pending');
  const closing = session.close(new AbortController().signal);
  socket.message({ jsonrpc: '2.0', id: 3, result: true });
  socket.message({ jsonrpc: '2.0', id: 4, result: true });
  await closing;
});

void test('rejects a successful-looking notification whose err field is absent', async () => {
  const socket = new FakeWebSocket();
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => undefined,
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler: new ManualScheduler() },
  ), socket);
  const malformed = notification(101, 42, '1'.repeat(64)) as {
    params: { result: { value: { err?: unknown } } };
  };
  delete malformed.params.result.value.err;

  socket.message(malformed);

  assert.deepEqual(await session.completion, { reason: 'PROTOCOL_INVALID' });
  assert.equal(socket.closeCalls, 1);
});

void test('rejects non-canonical signatures and unsafe slots before observation', async () => {
  const cases: readonly Readonly<{ signature: string; slot: number }>[] = [
    { signature: 'not-canonical', slot: 42 },
    { signature: '1'.repeat(63), slot: 42 },
    { signature: '1'.repeat(64), slot: -1 },
    { signature: '1'.repeat(64), slot: 1.5 },
    { signature: '1'.repeat(64), slot: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const entry of cases) {
    const socket = new FakeWebSocket();
    const scheduler = new ManualScheduler();
    let observations = 0;
    const session = await acknowledge(openWsProgramSession(
      { id: 'primary', url: 'wss://rpc.invalid/private' },
      async () => { observations += 1; },
      new AbortController().signal,
      { createWebSocket: () => socket, scheduler },
    ), socket);
    const state = settlement(session.completion);
    socket.message(notification(101, entry.slot, entry.signature));
    assert.equal(await state(), 'fulfilled');
    assert.equal(observations, 0);
    assert.deepEqual(await session.completion, { reason: 'PROTOCOL_INVALID' });
    assert.equal(socket.listenerCount, 0);
  }
});

void test('reports disconnect immediately but close still drains a pending observer', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const observer = deferred();
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => { await observer.promise; },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  socket.message(notification(101, 42, '1'.repeat(64)));

  socket.error();
  assert.deepEqual(await session.completion, { reason: 'SOCKET_ERROR' });
  const closing = session.close(new AbortController().signal);
  const state = settlement(closing);
  assert.equal(await state(), 'pending');

  observer.resolve();
  await closing;
  assert.equal(scheduler.pendingCount, 0);
});

void test('waits for an asynchronous socket close after reporting active failure', async () => {
  const socket = new FakeWebSocket(false);
  const scheduler = new ManualScheduler();
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => undefined,
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);

  socket.error();
  assert.deepEqual(await session.completion, { reason: 'SOCKET_ERROR' });
  const closing = session.close(new AbortController().signal);
  const state = settlement(closing);
  assert.equal(await state(), 'pending');

  socket.finishClose();
  await closing;
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('fails local close deterministically when an in-flight observer rejects', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const observer = rejectableDeferred();
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => { await observer.promise; },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  socket.message(notification(101, 42, '1'.repeat(64)));
  const closing = session.close(new AbortController().signal);

  observer.reject();

  await assert.rejects(closing, (error: unknown) => {
    assertStableError(error, 'CLEANUP_FAILED');
    return true;
  });
  assert.deepEqual(await session.completion, { reason: 'CLEANUP_FAILED' });
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('reports cleanup failure when socket close throws after active failure', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => undefined,
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  socket.throwOnClose = true;

  socket.error();
  assert.deepEqual(await session.completion, { reason: 'SOCKET_ERROR' });

  await assert.rejects(session.close(new AbortController().signal), (error: unknown) => {
    assertStableError(error, 'CLEANUP_FAILED');
    return true;
  });
  assert.equal(socket.closeCalls, 2);
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('bounds post-failure observer draining with the cleanup deadline', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const observer = deferred();
  const session = await acknowledge(openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => { await observer.promise; },
    new AbortController().signal,
    { createWebSocket: () => socket, scheduler },
  ), socket);
  socket.message(notification(101, 42, '1'.repeat(64)));
  socket.disconnect(1006);
  assert.deepEqual(await session.completion, { reason: 'REMOTE_CLOSE' });

  const closing = session.close(new AbortController().signal);
  assert.equal(scheduler.pendingCount, 1);
  scheduler.runNext();

  await assert.rejects(closing, (error: unknown) => {
    assertStableError(error, 'CLEANUP_FAILED');
    return true;
  });
  assert.deepEqual(await session.completion, { reason: 'REMOTE_CLOSE' });
  assert.equal(socket.listenerCount, 0);
});

void test('aborts setup with a redacted failure and no remaining resources', async () => {
  const socket = new FakeWebSocket();
  const scheduler = new ManualScheduler();
  const controller = new AbortController();
  const opening = openWsProgramSession(
    { id: 'primary', url: 'wss://user:secret@rpc.invalid/private' },
    async () => undefined,
    controller.signal,
    { createWebSocket: () => socket, scheduler },
  );
  let failure: unknown;
  void opening.catch((error: unknown) => { failure = error; });
  const state = settlement(opening);

  controller.abort();

  assert.equal(await state(), 'rejected');
  assertStableError(failure, 'ABORTED');
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('waits for asynchronous socket teardown before rejecting setup', async () => {
  const socket = new FakeWebSocket(false);
  const scheduler = new ManualScheduler();
  const controller = new AbortController();
  const opening = openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => undefined,
    controller.signal,
    { createWebSocket: () => socket, scheduler },
  );
  const state = settlement(opening);

  controller.abort();
  assert.equal(await state(), 'pending');
  socket.finishClose();

  await assert.rejects(opening, (error: unknown) => {
    assertStableError(error, 'ABORTED');
    return true;
  });
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

void test('bounds setup teardown when the socket never emits close', async () => {
  const socket = new FakeWebSocket(false);
  const scheduler = new ManualScheduler();
  const controller = new AbortController();
  const opening = openWsProgramSession(
    { id: 'primary', url: 'wss://rpc.invalid/private' },
    async () => undefined,
    controller.signal,
    { createWebSocket: () => socket, scheduler },
  );

  controller.abort();
  scheduler.runNext();

  await assert.rejects(opening, (error: unknown) => {
    assertStableError(error, 'CLEANUP_FAILED');
    return true;
  });
  assert.equal(socket.listenerCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

function notification(
  subscription: number,
  slot: number,
  signature: string,
  err: unknown = null,
  logs: unknown = ['private raw logs'],
): unknown {
  return {
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: {
      subscription,
      result: {
        context: { slot },
        value: { signature, err, logs },
      },
    },
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

async function acknowledge(
  opening: ReturnType<typeof openWsProgramSession>,
  socket: FakeWebSocket,
): ReturnType<typeof openWsProgramSession> {
  socket.open();
  socket.message({ jsonrpc: '2.0', id: 1, result: 101 });
  socket.message({ jsonrpc: '2.0', id: 2, result: 102 });
  return opening;
}

function assertStableError(
  error: unknown,
  reason: WsProgramSessionError['reason'],
): asserts error is WsProgramSessionError {
  assert.ok(error instanceof WsProgramSessionError);
  assert.equal(error.reason, reason);
  assert.equal(error.message, 'Solana WebSocket program session failed.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(String(error), /secret|private|rpc\.invalid/u);
}

function settlement<T>(promise: Promise<T>): () => Promise<'pending' | 'fulfilled' | 'rejected'> {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  void promise.then(
    () => { state = 'fulfilled'; },
    () => { state = 'rejected'; },
  );
  return async () => {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    return state;
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function rejectableDeferred(): {
  readonly promise: Promise<void>;
  readonly reject: () => void;
} {
  let reject!: () => void;
  const promise = new Promise<void>((_resolve, fail) => {
    reject = () => { fail(new Error('private observer failure')); };
  });
  return { promise, reject };
}

class ManualScheduler implements WsProgramSessionScheduler {
  private nextId = 1;
  private readonly tasks = new Map<number, () => void>();

  public get pendingCount(): number {
    return this.tasks.size;
  }

  public schedule(callback: () => void, _delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, callback);
    return id;
  }

  public cancel(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
  }

  public runNext(): void {
    const entry = this.tasks.entries().next().value as [number, () => void] | undefined;
    if (entry === undefined) throw new Error('No scheduled task.');
    this.tasks.delete(entry[0]);
    entry[1]();
  }
}

class FakeWebSocket implements WsProgramSessionWebSocket {
  public readyState = 0;
  public readonly sent: string[] = [];
  public closeCalls = 0;
  public throwOnClose = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  public constructor(private readonly closeSynchronously = true) {}

  public get listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }

  public addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: unknown) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: unknown) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(data: string): void {
    if (this.readyState !== 1) throw new Error('private socket state');
    this.sent.push(data);
  }

  public close(): void {
    this.closeCalls += 1;
    if (this.throwOnClose) throw new Error('private close failure');
    this.readyState = 2;
    if (this.closeSynchronously) this.finishClose();
  }

  public finishClose(): void {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: 'private close reason' });
  }

  public open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  public message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) });
  }

  public nativeMessage(value: unknown): void {
    this.messageEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  public messageEvent(event: unknown): void {
    this.emit('message', event);
  }

  public rawMessage(data: string): void {
    this.emit('message', { data });
  }

  public error(): void {
    this.emit('error', { message: 'private socket error' });
  }

  public disconnect(code: number): void {
    this.readyState = 3;
    this.emit('close', { code, reason: 'private remote reason' });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}
