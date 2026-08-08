import assert from 'node:assert/strict';
import test from 'node:test';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { RpcSoakTransportError } from '../src/solana/rpc/rpc-soak.js';
import {
  RpcSoakWebsocketError,
  SolanaRpcSoakTransport,
  type RpcSoakFetch,
  type RpcSoakWebSocket,
} from '../src/solana/rpc/rpc-soak-transport.js';

void test('samples one canonical confirmed slot with cancellation and no endpoint exposure', async () => {
  const calls: { readonly input: string; readonly init: RequestInit }[] = [];
  const transport = createTransport(new FakeWebSocket(), async (input, init) => {
    calls.push({ input, init });
    return response(200, { jsonrpc: '2.0', id: 1, result: 123 });
  });
  const signal = new AbortController().signal;

  assert.equal(await transport.sampleHttpSlot(signal), 123n);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, 'https://user:secret@rpc.example.invalid/key');
  assert.equal(calls[0]?.init.signal, signal);
  const body = calls[0]?.init.body;
  if (typeof body !== 'string') throw new TypeError('Expected string request body.');
  assert.deepEqual(JSON.parse(body), {
    jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }],
  });
});

void test('classifies HTTP 429, other failures and invalid JSON-RPC with fixed redacted codes', async () => {
  const cases: readonly {
    readonly name: string;
    readonly fetch: RpcSoakFetch;
    readonly code: 'RPC_RATE_LIMITED' | 'RPC_REQUEST_FAILED' | 'RPC_RESPONSE_INVALID';
  }[] = [
    { name: 'rate', fetch: async () => response(429, { private: 'quota detail' }), code: 'RPC_RATE_LIMITED' },
    { name: 'http', fetch: async () => response(503, { private: 'provider body' }), code: 'RPC_REQUEST_FAILED' },
    { name: 'throw', fetch: async () => { throw new Error('https://secret.invalid/key'); }, code: 'RPC_REQUEST_FAILED' },
    { name: 'shape', fetch: async () => response(200, { jsonrpc: '2.0', id: 1, result: -1 }), code: 'RPC_RESPONSE_INVALID' },
    { name: 'id', fetch: async () => response(200, { jsonrpc: '2.0', id: 2, result: 1 }), code: 'RPC_RESPONSE_INVALID' },
    { name: 'json', fetch: async () => response(200, new Error('private json')), code: 'RPC_RESPONSE_INVALID' },
  ];

  for (const entry of cases) {
    const transport = createTransport(new FakeWebSocket(), entry.fetch);
    await assert.rejects(transport.sampleHttpSlot(new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof RpcSoakTransportError, entry.name);
      assert.equal(error.code, entry.code, entry.name);
      assert.doesNotMatch(String(error), /secret|private|provider|quota|invalid\/key/u);
      return true;
    });
  }
});

void test('requires two server acknowledgements and forwards only typed program slots', async () => {
  const socket = new FakeWebSocket();
  const transport = createTransport(socket);
  const observations: unknown[] = [];
  const pending = transport.subscribe(
    (value) => { observations.push(value); },
    new AbortController().signal,
  );

  socket.open();
  assert.deepEqual(socket.sent.map(parseJson), [
    {
      jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
      params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: 'processed' }],
    },
    {
      jsonrpc: '2.0', id: 2, method: 'logsSubscribe',
      params: [{ mentions: [PUMPSWAP_PROGRAM_ID] }, { commitment: 'processed' }],
    },
  ]);
  socket.message({ jsonrpc: '2.0', id: 1, result: 100 });
  socket.message({ jsonrpc: '2.0', id: 2, result: 101 });
  const subscription = await pending;
  assert.equal(subscription.health(), 'HEALTHY');

  socket.message(notification(100, 10));
  socket.message(notification(101, 11));
  socket.message(notification(999, 12));
  socket.message(notification(100, -1));
  assert.deepEqual(observations, [
    { program: 'pumpfun', slot: 10n },
    { program: 'pumpswap', slot: 11n },
  ]);
  await Promise.all([
    subscription.close(new AbortController().signal),
    subscription.close(new AbortController().signal),
  ]);
  assert.equal(socket.closeCalls, 1);
});

void test('marks an acknowledged session unhealthy after error or disconnect', async () => {
  for (const event of ['error', 'close'] as const) {
    const socket = new FakeWebSocket();
    const pending = createTransport(socket).subscribe(() => undefined, new AbortController().signal);
    socket.open();
    socket.message({ jsonrpc: '2.0', id: 1, result: 100 });
    socket.message({ jsonrpc: '2.0', id: 2, result: 101 });
    const subscription = await pending;

    if (event === 'error') socket.error();
    else socket.disconnect();

    assert.equal(subscription.health(), 'FAILED', event);
  }
});

void test('reports cleanup failure instead of swallowing a partial subscribe rollback', async () => {
  const clean = new FakeWebSocket();
  const cleanPending = createTransport(clean).subscribe(() => undefined, new AbortController().signal);
  clean.open();
  clean.message({ jsonrpc: '2.0', id: 1, result: 100 });
  clean.message({ jsonrpc: '2.0', id: 2, error: { message: 'private rejection' } });
  await assert.rejects(cleanPending, (error: unknown) => {
    assert.ok(error instanceof RpcSoakWebsocketError);
    assert.equal(error.stage, 'subscribe');
    assert.equal(error.cleanupFailed, false);
    return true;
  });

  const failed = new FakeWebSocket();
  failed.closeThrows = true;
  const failedPending = createTransport(failed).subscribe(() => undefined, new AbortController().signal);
  failed.open();
  failed.message({ jsonrpc: '2.0', id: 1, result: 100 });
  failed.message({ jsonrpc: '2.0', id: 2, error: { message: 'private rejection' } });
  await assert.rejects(failedPending, (error: unknown) => {
    assert.ok(error instanceof RpcSoakWebsocketError);
    assert.equal(error.stage, 'cleanup');
    assert.equal(error.cleanupFailed, true);
    assert.doesNotMatch(String(error), /private|rejection/u);
    return true;
  });
});

void test('cancellation forces an active socket close and returns a fixed cleanup error', async () => {
  const socket = new FakeWebSocket();
  socket.autoClose = false;
  const pending = createTransport(socket).subscribe(() => undefined, new AbortController().signal);
  socket.open();
  socket.message({ jsonrpc: '2.0', id: 1, result: 100 });
  socket.message({ jsonrpc: '2.0', id: 2, result: 101 });
  const subscription = await pending;
  const controller = new AbortController();
  const closing = subscription.close(controller.signal);
  controller.abort();
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof RpcSoakWebsocketError);
    assert.equal(error.stage, 'cleanup');
    return true;
  });
  assert.equal(socket.closeCalls, 2);
});

function createTransport(
  socket: FakeWebSocket,
  fetch: RpcSoakFetch = async () => response(200, { jsonrpc: '2.0', id: 1, result: 1 }),
): SolanaRpcSoakTransport {
  return new SolanaRpcSoakTransport({
    httpRpcUrl: 'https://user:secret@rpc.example.invalid/key',
    websocketUrl: 'wss://user:secret@rpc.example.invalid/key',
    commitment: 'confirmed',
    fetch,
    createWebSocket: () => socket,
  });
}

function notification(subscription: number, slot: number): unknown {
  return {
    jsonrpc: '2.0', method: 'logsNotification',
    params: { subscription, result: { context: { slot }, value: { signature: 'not-forwarded' } } },
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function response(status: number, body: unknown): Awaited<ReturnType<RpcSoakFetch>> {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

class FakeWebSocket implements RpcSoakWebSocket {
  public readyState = 0;
  public sent: string[] = [];
  public closeCalls = 0;
  public closeThrows = false;
  public autoClose = true;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const values = this.listeners.get(type) ?? new Set();
    values.add(listener);
    this.listeners.set(type, values);
  }

  public removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(data: string): void {
    if (this.readyState !== 1) throw new Error('private socket state');
    this.sent.push(data);
  }

  public close(): void {
    this.closeCalls += 1;
    if (this.closeThrows) throw new Error('private close failure');
    if (this.autoClose) this.disconnect();
    else this.readyState = 2;
  }

  public open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  public message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) });
  }

  public error(): void {
    this.emit('error', {});
  }

  public disconnect(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
