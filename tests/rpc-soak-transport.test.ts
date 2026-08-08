import assert from 'node:assert/strict';
import test from 'node:test';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { RpcSoakTransportError } from '../src/solana/rpc/rpc-soak.js';
import {
  RpcSoakWebsocketError,
  SolanaRpcSoakTransport,
  type RpcSoakFetch,
  type RpcSoakLogsConnection,
} from '../src/solana/rpc/rpc-soak-transport.js';

void test('samples one canonical confirmed slot without exposing the endpoint', async () => {
  const calls: { readonly input: string; readonly init: RequestInit }[] = [];
  const transport = new SolanaRpcSoakTransport({
    httpRpcUrl: 'https://user:secret@rpc.example.invalid/key',
    commitment: 'confirmed',
    fetch: async (input, init) => {
      calls.push({ input, init });
      return response(200, { jsonrpc: '2.0', id: 1, result: 123 });
    },
    connection: new FakeLogsConnection(),
  });

  assert.equal(await transport.sampleHttpSlot(), 123n);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, 'https://user:secret@rpc.example.invalid/key');
  const body = calls[0]?.init.body;
  if (typeof body !== 'string') throw new TypeError('Expected string request body.');
  assert.deepEqual(JSON.parse(body), {
    jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }],
  });
  assert.equal((calls[0]?.init.headers as Record<string, string>)['content-type'], 'application/json');
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
    const transport = new SolanaRpcSoakTransport({
      httpRpcUrl: 'https://secret.invalid/key', commitment: 'confirmed',
      fetch: entry.fetch, connection: new FakeLogsConnection(),
    });
    await assert.rejects(transport.sampleHttpSlot(), (error: unknown) => {
      assert.ok(error instanceof RpcSoakTransportError, entry.name);
      assert.equal(error.code, entry.code, entry.name);
      assert.doesNotMatch(String(error), /secret|private|provider|quota|invalid\/key/u);
      return true;
    });
  }
});

void test('subscribes to both canonical programs and forwards only program family and slot', async () => {
  const connection = new FakeLogsConnection();
  const transport = new SolanaRpcSoakTransport({
    httpRpcUrl: 'https://rpc.example.invalid', commitment: 'confirmed',
    fetch: async () => response(200, { jsonrpc: '2.0', id: 1, result: 1 }),
    connection,
  });
  const observations: unknown[] = [];

  const subscription = await transport.subscribe((value) => { observations.push(value); });

  assert.deepEqual(connection.programs, [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID]);
  assert.deepEqual(connection.commitments, ['processed', 'processed']);
  connection.emit(0, 10);
  connection.emit(1, 11);
  connection.emit(0, -1);
  assert.deepEqual(observations, [
    { program: 'pumpfun', slot: 10n },
    { program: 'pumpswap', slot: 11n },
  ]);
  await Promise.all([subscription.close(), subscription.close()]);
  assert.deepEqual(connection.removed.sort((left, right) => left - right), [100, 101]);
});

void test('rolls back partial subscription and attempts every removal on cleanup failure', async () => {
  const partial = new FakeLogsConnection();
  partial.listenerIds = [100, -1];
  const partialTransport = transport(partial);
  await assert.rejects(partialTransport.subscribe(() => undefined), (error: unknown) => {
    assert.ok(error instanceof RpcSoakWebsocketError);
    assert.equal(error.stage, 'subscribe');
    return true;
  });
  assert.deepEqual(partial.removed, [100]);

  const cleanup = new FakeLogsConnection();
  cleanup.removeFailures.add(100);
  const active = await transport(cleanup).subscribe(() => undefined);
  await assert.rejects(active.close(), (error: unknown) => {
    assert.ok(error instanceof RpcSoakWebsocketError);
    assert.equal(error.stage, 'cleanup');
    assert.doesNotMatch(String(error), /private/u);
    return true;
  });
  assert.deepEqual(cleanup.removed.sort((left, right) => left - right), [100, 101]);
});

function transport(connection: FakeLogsConnection): SolanaRpcSoakTransport {
  return new SolanaRpcSoakTransport({
    httpRpcUrl: 'https://rpc.example.invalid', commitment: 'confirmed', connection,
    fetch: async () => response(200, { jsonrpc: '2.0', id: 1, result: 1 }),
  });
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

class FakeLogsConnection implements RpcSoakLogsConnection {
  public programs: string[] = [];
  public commitments: string[] = [];
  public removed: number[] = [];
  public listenerIds: number[] = [100, 101];
  public removeFailures = new Set<number>();
  private readonly callbacks: ((logs: unknown, context: { readonly slot: number }) => void)[] = [];

  public onLogs(
    program: { toBase58(): string },
    callback: (logs: unknown, context: { readonly slot: number }) => void,
    commitment: 'processed',
  ): number {
    this.programs.push(program.toBase58());
    this.commitments.push(commitment);
    this.callbacks.push(callback);
    return this.listenerIds[this.callbacks.length - 1] ?? -1;
  }

  public async removeOnLogsListener(id: number): Promise<void> {
    this.removed.push(id);
    if (this.removeFailures.has(id)) throw new Error('private cleanup');
  }

  public emit(index: number, slot: number): void {
    this.callbacks[index]?.({ signature: 'must-not-be-forwarded' }, { slot });
  }
}
