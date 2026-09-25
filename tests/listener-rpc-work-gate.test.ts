import assert from 'node:assert/strict';
import test from 'node:test';
import { ListenerRpcWorkGate } from '../src/application/listener-rpc-work-gate.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

void test('returns the result of a submitted operation', async () => {
  const gate = new ListenerRpcWorkGate();

  assert.equal(await gate.run(async () => 'result'), 'result');
});

void test('admits exactly one operation at a time in submission order', async () => {
  const gate = new ListenerRpcWorkGate();
  const firstRelease = deferred();
  const secondRelease = deferred();
  const thirdRelease = deferred();
  const releases = [firstRelease, secondRelease, thirdRelease];
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const jobs = releases.map((release, index) => gate.run(async () => {
    started.push(index);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await release.promise;
    active -= 1;
    return index;
  }));

  await flush();
  assert.deepEqual(started, [0]);
  firstRelease.resolve();
  await flush();
  assert.deepEqual(started, [0, 1]);
  secondRelease.resolve();
  await flush();
  assert.deepEqual(started, [0, 1, 2]);
  thirdRelease.resolve();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
  assert.equal(maximumActive, 1);
});

void test('preserves an operation rejection and admits the next operation', async () => {
  const gate = new ListenerRpcWorkGate();
  const failure = new Error('provider failure');
  const order: string[] = [];
  const failed = gate.run(async () => { order.push('failed'); throw failure; });
  const next = gate.run(async () => { order.push('next'); return 42; });

  await assert.rejects(failed, (error: unknown) => error === failure);
  assert.equal(await next, 42);
  assert.deepEqual(order, ['failed', 'next']);
});

void test('turns a synchronous operation throw into a rejection and frees the gate', async () => {
  const gate = new ListenerRpcWorkGate();
  const failure = new Error('synchronous failure');
  const failed = gate.run<number>(() => { throw failure; });
  const next = gate.run(async () => 'next');

  await assert.rejects(failed, (error: unknown) => error === failure);
  assert.equal(await next, 'next');
});

void test('rejects a non-function operation without exposing its data or poisoning the queue', async () => {
  const gate = new ListenerRpcWorkGate();
  const hostile = { secret: 'private-rpc-token', toString() { throw new Error(this.secret); } };
  const invalid = gate.run(hostile as never);
  const next = gate.run(async () => 'next');

  await assert.rejects(invalid, (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, 'RPC work operation must be a function');
    assert.doesNotMatch(error.message, /private-rpc-token/u);
    return true;
  });
  assert.equal(await next, 'next');
});
