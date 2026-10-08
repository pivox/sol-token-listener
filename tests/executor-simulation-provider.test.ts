import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import type {
  ExecutionMarketGateway,
  ExecutionProviderUsage,
} from '../src/ports/execution-market-gateway.js';
import {
  ExecutionProviderSessionError,
  ProviderAffineSession,
} from '../src/executor-simulation/provider-session.js';

const PUBLIC_KEY = '11111111111111111111111111111111';
const OTHER_KEY = 'So11111111111111111111111111111111111111112';
const DATA = Buffer.from([1, 2, 3]).toString('base64');

void test('pins one provider and normalizes the complete causal RPC sequence', async () => {
  const scripted = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(100, [account(DATA), null]), 2),
    rpcResult(context(101, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
    rpcResult(context(101, 5_000), 4),
    rpcResult(context(102, {
      err: null,
      logs: ['Program log: ok'],
      unitsConsumed: 20_000,
      accounts: [account(DATA, false)],
      returnData: { programId: PUBLIC_KEY, data: ['AQID', 'base64'] },
      innerInstructions: [{
        index: 0,
        instructions: [
          {
            programId: PUBLIC_KEY, accounts: [PUBLIC_KEY, OTHER_KEY],
            data: '3Bxs', stackHeight: 2,
          },
          {
            program: 'spl-token', programId: OTHER_KEY,
            parsed: { type: 'transfer', info: { authority: PUBLIC_KEY } },
            stackHeight: null,
          },
        ],
      }],
    }), 5),
  ]);
  const session: ExecutionMarketGateway = new ProviderAffineSession(config(5), scripted.fetch);

  const genesis = await session.verifyGenesis(activeSignal());
  const snapshot = await session.readAccountSnapshot(
    Object.freeze([PUBLIC_KEY, OTHER_KEY]), activeSignal(),
  );
  const blockhash = await session.getLatestBlockhash(100n, activeSignal());
  const fee = await session.getFeeForMessage('AQID', 100n, activeSignal());
  const simulation = await session.simulateUnsignedTransaction(Object.freeze({
    transactionBase64: 'AQID', snapshotSlot: 100n,
    accountAddresses: Object.freeze([PUBLIC_KEY]),
  }), activeSignal());

  assert.deepEqual(genesis, Object.freeze({
    providerId: 'primary', expectedGenesisHash: PUBLIC_KEY, observedGenesisHash: PUBLIC_KEY,
  }));
  assert.equal(snapshot.providerId, 'primary');
  assert.equal(snapshot.slot, 100n);
  assert.deepEqual(snapshot.accounts, Object.freeze([
    Object.freeze({
      address: PUBLIC_KEY, lamports: 123n, owner: PUBLIC_KEY, executable: false,
      rentEpoch: 7n, space: 3n, dataBase64: DATA,
    }),
    null,
  ]));
  assert.deepEqual(blockhash, Object.freeze({
    providerId: 'primary', contextSlot: 101n, blockhash: OTHER_KEY,
    lastValidBlockHeight: 500n,
  }));
  assert.deepEqual(fee, Object.freeze({
    providerId: 'primary', contextSlot: 101n, feeLamports: 5_000n,
  }));
  assert.equal(simulation.contextSlot, 102n);
  assert.equal(simulation.failureKind, null);
  assert.equal(simulation.unitsConsumed, 20_000n);
  assert.deepEqual(simulation.logs, Object.freeze(['Program log: ok']));
  assert.deepEqual(simulation.innerInstructions, Object.freeze([Object.freeze({
    index: 0,
    instructions: Object.freeze([
      Object.freeze({
        kind: 'PARTIALLY_DECODED', programId: PUBLIC_KEY,
        accounts: Object.freeze([PUBLIC_KEY, OTHER_KEY]), data: '3Bxs', stackHeight: 2,
      }),
      Object.freeze({
        kind: 'PARSED', programId: OTHER_KEY, accounts: null, data: null, stackHeight: null,
      }),
    ]),
  })]));
  assert.ok(Object.isFrozen(simulation));
  assert.ok(Object.isFrozen(simulation.accounts));
  assert.deepEqual(session.usage(), Object.freeze({
    providerId: 'primary', rpcCallsUsed: 5, rpcCallsLimit: 5,
  } satisfies ExecutionProviderUsage));

  assert.equal(scripted.calls.length, 5);
  const bodies = scripted.calls.map((call) => JSON.parse(call.body) as Record<string, unknown>);
  assert.deepEqual(bodies.map((body) => body.method), [
    'getGenesisHash', 'getMultipleAccounts', 'getLatestBlockhash',
    'getFeeForMessage', 'simulateTransaction',
  ]);
  assert.deepEqual(bodies.map((body) => body.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(bodies[1]?.params, [
    [PUBLIC_KEY, OTHER_KEY], { encoding: 'base64', commitment: 'confirmed' },
  ]);
  assert.deepEqual(bodies[2]?.params, [{ commitment: 'confirmed', minContextSlot: 100 }]);
  // Fee and simulation depend on the blockhash: their floor is its context slot (101), not the
  // snapshot slot (100), so a lagging load-balanced node cannot answer without knowing it.
  assert.deepEqual(bodies[3]?.params, ['AQID', {
    commitment: 'confirmed', minContextSlot: 101,
  }]);
  assert.deepEqual(bodies[4]?.params, ['AQID', {
    encoding: 'base64', commitment: 'confirmed', sigVerify: false,
    replaceRecentBlockhash: false, minContextSlot: 101, innerInstructions: true,
    accounts: { encoding: 'base64', addresses: [PUBLIC_KEY] },
  }]);
  for (const call of scripted.calls) {
    assert.equal(call.url, 'https://credential.invalid/rpc?token=secret');
    assert.equal(call.method, 'POST');
    assert.equal(call.contentType, 'application/json');
    assert.ok(call.signal instanceof AbortSignal);
  }
});

void test('raises the fee and simulation minContextSlot to a blockhash context above the snapshot', async () => {
  // Production race (2026-10-08, twice): snapshot at S, blockhash issued at S+1 by one node,
  // then getFeeForMessage with minContextSlot=S answered `null` by another node still at S.
  const scripted = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(454_538_709, [account(DATA)]), 2),
    rpcResult(context(454_538_710, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
    rpcResult(context(454_538_710, 5_000), 4),
    rpcResult(context(454_538_710, { err: null, logs: [] }), 5),
  ]);
  const session = new ProviderAffineSession(config(5), scripted.fetch);
  await session.verifyGenesis(activeSignal());
  await session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
  await session.getLatestBlockhash(454_538_709n, activeSignal());
  const fee = await session.getFeeForMessage('AQID', 454_538_709n, activeSignal());
  const simulation = await session.simulateUnsignedTransaction(Object.freeze({
    transactionBase64: 'AQID', snapshotSlot: 454_538_709n,
    accountAddresses: Object.freeze([]),
  }), activeSignal());

  assert.equal(fee.contextSlot, 454_538_710n);
  assert.equal(fee.feeLamports, 5_000n);
  assert.equal(simulation.contextSlot, 454_538_710n);
  const bodies = scripted.calls.map((call) => JSON.parse(call.body) as Record<string, unknown>);
  assert.deepEqual(bodies[2]?.params, [{ commitment: 'confirmed', minContextSlot: 454_538_709 }]);
  assert.deepEqual(bodies[3]?.params, ['AQID', { commitment: 'confirmed', minContextSlot: 454_538_710 }]);
  assert.deepEqual(bodies[4]?.params, ['AQID', {
    encoding: 'base64', commitment: 'confirmed', sigVerify: false,
    replaceRecentBlockhash: false, minContextSlot: 454_538_710, innerInstructions: true,
    accounts: { encoding: 'base64', addresses: [] },
  }]);

  // A fee answered below the blockhash context (even at or above the snapshot) is not evidence
  // about this blockhash and is rejected instead of being surfaced as a null fee.
  const lagging = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(100, [account(DATA)]), 2),
    rpcResult(context(101, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
    rpcResult(context(100, null), 4),
  ]);
  const laggingSession = new ProviderAffineSession(config(4), lagging.fetch);
  await laggingSession.verifyGenesis(activeSignal());
  await laggingSession.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
  await laggingSession.getLatestBlockhash(100n, activeSignal());
  await expectCode(laggingSession.getFeeForMessage('AQID', 100n, activeSignal()), 'RPC_RESPONSE_INVALID');
  assert.equal(lagging.calls.length, 4);
});

void test('keeps the snapshot slot as the floor when the blockhash context equals it', async () => {
  const scripted = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(100, [account(DATA)]), 2),
    rpcResult(context(100, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
    rpcResult(context(100, 5_000), 4),
    rpcResult(context(100, { err: null, logs: [] }), 5),
  ]);
  const session = new ProviderAffineSession(config(5), scripted.fetch);
  await session.verifyGenesis(activeSignal());
  await session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
  await session.getLatestBlockhash(100n, activeSignal());
  const fee = await session.getFeeForMessage('AQID', 100n, activeSignal());
  const simulation = await session.simulateUnsignedTransaction(Object.freeze({
    transactionBase64: 'AQID', snapshotSlot: 100n,
    accountAddresses: Object.freeze([]),
  }), activeSignal());

  assert.equal(fee.contextSlot, 100n);
  assert.equal(simulation.contextSlot, 100n);
  const bodies = scripted.calls.map((call) => JSON.parse(call.body) as Record<string, unknown>);
  assert.deepEqual(bodies[2]?.params, [{ commitment: 'confirmed', minContextSlot: 100 }]);
  assert.deepEqual(bodies[3]?.params, ['AQID', { commitment: 'confirmed', minContextSlot: 100 }]);
  assert.deepEqual(bodies[4]?.params, ['AQID', {
    encoding: 'base64', commitment: 'confirmed', sigVerify: false,
    replaceRecentBlockhash: false, minContextSlot: 100, innerInstructions: true,
    accounts: { encoding: 'base64', addresses: [] },
  }]);
});

void test('keeps address discovery separate from the one provider-owned causal snapshot', async () => {
  const scripted = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(99, [account(DATA), account(DATA)]), 2),
    rpcResult(context(100, [account(DATA), null]), 3),
  ]);
  const session = new ProviderAffineSession(config(3), scripted.fetch);

  await session.verifyGenesis(activeSignal());
  const discovery = await session.readAddressDiscovery(
    Object.freeze([PUBLIC_KEY, OTHER_KEY]), activeSignal(),
  );
  const snapshot = await session.readAccountSnapshot(
    Object.freeze([PUBLIC_KEY, OTHER_KEY]), activeSignal(),
  );

  assert.equal(discovery.slot, 99n);
  assert.equal(session.ownsAccountSnapshot(discovery), false);
  assert.equal(snapshot.slot, 100n);
  assert.equal(session.ownsAccountSnapshot(snapshot), true);
  assert.deepEqual(scripted.calls.map((call) => (
    JSON.parse(call.body) as { readonly method: string }
  ).method), ['getGenesisHash', 'getMultipleAccounts', 'getMultipleAccounts']);
});

void test('requires exactly two unique addresses for non-causal discovery', async () => {
  const scripted = new ScriptedFetch([rpcResult(PUBLIC_KEY, 1)]);
  const session = new ProviderAffineSession(config(3), scripted.fetch);
  await session.verifyGenesis(activeSignal());

  await expectCode(
    session.readAddressDiscovery(Object.freeze([PUBLIC_KEY]), activeSignal()),
    'INVALID_INPUT',
  );
  await expectCode(
    session.readAddressDiscovery(Object.freeze([
      PUBLIC_KEY, OTHER_KEY, bs58.encode(new Uint8Array(32).fill(7)),
    ]), activeSignal()),
    'INVALID_INPUT',
  );
  assert.equal(scripted.calls.length, 1);
});

void test('requires genesis first, caches it, and enforces the exact dispatch budget', async () => {
  const scripted = new ScriptedFetch([rpcResult(PUBLIC_KEY, 1)]);
  const session = new ProviderAffineSession(config(1), scripted.fetch);

  await expectCode(session.getLatestBlockhash(1n, activeSignal()), 'INVALID_INPUT');
  assert.equal(session.usage().rpcCallsUsed, 0);
  const first = await session.verifyGenesis(activeSignal());
  const cached = await session.verifyGenesis(activeSignal());
  assert.strictEqual(cached, first);
  assert.equal(scripted.calls.length, 1);
  await expectCode(
    session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal()),
    'INVALID_INPUT',
  );
  assert.equal(scripted.calls.length, 1);
  assert.equal(session.usage().rpcCallsUsed, 1);
});

void test('normalizes 429, transport, malformed JSON, and genesis mismatch without leakage', async () => {
  const cases = [
    { step: new Response(new ReadableStream<Uint8Array>({ start: () => { /* stay pending */ } }), {
      status: 429,
    }), code: 'RPC_RATE_LIMITED' },
    { step: new Error('https://credential.invalid secret header'), code: 'RPC_UNAVAILABLE' },
    { step: new Response('{bad json', { status: 200 }), code: 'RPC_RESPONSE_INVALID' },
    { step: jsonResponse({
      jsonrpc: '2.0', id: 1, error: { code: -32_005, message: 'node secret' },
    }), code: 'RPC_UNAVAILABLE' },
  ] as const;
  for (const entry of cases) {
    const scripted = new ScriptedFetch([entry.step]);
    const session = new ProviderAffineSession(config(2), scripted.fetch);
    const error = await expectCode(session.verifyGenesis(activeSignal()), entry.code);
    assert.equal(error.genesisEvidence, null);
    assert.equal(session.usage().rpcCallsUsed, 1);
    await expectCode(session.verifyGenesis(activeSignal()), 'INVALID_INPUT');
    assert.equal(scripted.calls.length, 1);
  }

  const mismatchFetch = new ScriptedFetch([rpcResult(OTHER_KEY, 1)]);
  const mismatch = new ProviderAffineSession(config(2), mismatchFetch.fetch);
  const error = await expectCode(mismatch.verifyGenesis(activeSignal()), 'GENESIS_MISMATCH');
  assert.deepEqual(error.genesisEvidence, Object.freeze({
    providerId: 'primary', expectedGenesisHash: PUBLIC_KEY, observedGenesisHash: OTHER_KEY,
  }));
  assert.doesNotMatch(String(error), /credential|secret|header|provider message/iu);
});

void test('retries the identical request once after a -32016 lag and charges both calls to the budget', async () => {
  const scripted = new ScriptedFetch([
    minContextSlotNotReached(1),
    rpcResult(PUBLIC_KEY, 2),
    rpcResult(context(100, [account(DATA)]), 3),
  ]);
  const sleeps: number[] = [];
  const session = new ProviderAffineSession(config(5), scripted.fetch, async (delayMs) => {
    sleeps.push(delayMs);
  });

  const genesis = await session.verifyGenesis(activeSignal());
  assert.equal(genesis.observedGenesisHash, PUBLIC_KEY);
  assert.equal(session.usage().rpcCallsUsed, 2);
  assert.deepEqual(sleeps, [250]);
  assert.equal(scripted.calls.length, 2);
  const bodies = scripted.calls.map((call) => JSON.parse(call.body) as Record<string, unknown>);
  assert.deepEqual(bodies[0], { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] });
  assert.deepEqual(bodies[1], { jsonrpc: '2.0', id: 2, method: 'getGenesisHash', params: [] });

  // The session is not failed: the causal sequence continues on the remaining budget.
  const snapshot = await session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
  assert.equal(snapshot.slot, 100n);
  assert.equal(session.usage().rpcCallsUsed, 3);
});

void test('fails the session with RPC_UNAVAILABLE after three -32016 answers and 250/500 ms backoffs', async () => {
  const scripted = new ScriptedFetch([
    minContextSlotNotReached(1), minContextSlotNotReached(2), minContextSlotNotReached(3),
  ]);
  const sleeps: number[] = [];
  const session = new ProviderAffineSession(config(5), scripted.fetch, async (delayMs) => {
    sleeps.push(delayMs);
  });

  const error = await expectCode(session.verifyGenesis(activeSignal()), 'RPC_UNAVAILABLE');
  assert.doesNotMatch(String(error), /Minimum context slot|lagging secret/iu);
  assert.deepEqual(sleeps, [250, 500]);
  assert.equal(scripted.calls.length, 3);
  assert.equal(session.usage().rpcCallsUsed, 3);
  await expectCode(session.verifyGenesis(activeSignal()), 'INVALID_INPUT');
  assert.equal(scripted.calls.length, 3);
});

void test('does not retry a -32016 lag beyond the call budget and fails with RPC_UNAVAILABLE', async () => {
  const scripted = new ScriptedFetch([minContextSlotNotReached(1)]);
  const sleeps: number[] = [];
  const session = new ProviderAffineSession(config(1), scripted.fetch, async (delayMs) => {
    sleeps.push(delayMs);
  });

  await expectCode(session.verifyGenesis(activeSignal()), 'RPC_UNAVAILABLE');
  assert.deepEqual(sleeps, []);
  assert.equal(scripted.calls.length, 1);
  assert.deepEqual(session.usage(), Object.freeze({
    providerId: 'primary', rpcCallsUsed: 1, rpcCallsLimit: 1,
  }));
  await expectCode(session.verifyGenesis(activeSignal()), 'INVALID_INPUT');

  // Two calls left: the second lag answer exhausts the budget before the third attempt.
  const twoLeft = new ScriptedFetch([minContextSlotNotReached(1), minContextSlotNotReached(2)]);
  const twoSleeps: number[] = [];
  const twoSession = new ProviderAffineSession(config(2), twoLeft.fetch, async (delayMs) => {
    twoSleeps.push(delayMs);
  });
  await expectCode(twoSession.verifyGenesis(activeSignal()), 'RPC_UNAVAILABLE');
  assert.deepEqual(twoSleeps, [250]);
  assert.equal(twoLeft.calls.length, 2);
  assert.equal(twoSession.usage().rpcCallsUsed, 2);
});

void test('aborting during the -32016 backoff yields OPERATION_ABORTED without a further call', async () => {
  const scripted = new ScriptedFetch([minContextSlotNotReached(1)]);
  const session = new ProviderAffineSession(config(5), scripted.fetch);
  const controller = new AbortController();
  const pending = session.verifyGenesis(controller.signal);
  await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  assert.equal(scripted.calls.length, 1);
  controller.abort();

  await expectCode(pending, 'OPERATION_ABORTED');
  assert.equal(scripted.calls.length, 1);
  assert.equal(session.usage().rpcCallsUsed, 1);
  await expectCode(session.verifyGenesis(activeSignal()), 'INVALID_INPUT');
});

void test('keeps 429 and -32005 JSON-RPC errors immediate and session-killing despite the lag retry', async () => {
  for (const code of [429, -32_005] as const) {
    const scripted = new ScriptedFetch([jsonResponse({
      jsonrpc: '2.0', id: 1, error: { code, message: 'provider secret' },
    })]);
    const sleeps: number[] = [];
    const session = new ProviderAffineSession(config(5), scripted.fetch, async (delayMs) => {
      sleeps.push(delayMs);
    });
    await expectCode(
      session.verifyGenesis(activeSignal()),
      code === 429 ? 'RPC_RATE_LIMITED' : 'RPC_UNAVAILABLE',
    );
    assert.deepEqual(sleeps, []);
    assert.equal(scripted.calls.length, 1);
    assert.equal(session.usage().rpcCallsUsed, 1);
    await expectCode(session.verifyGenesis(activeSignal()), 'INVALID_INPUT');
  }
});

void test('distinguishes timeout and caller abort while counting only dispatched calls', async () => {
  const timeoutFetch = new ScriptedFetch(['WAIT_FOR_ABORT']);
  const timeout = new ProviderAffineSession(config(2, 5), timeoutFetch.fetch);
  await expectCode(timeout.verifyGenesis(activeSignal()), 'RPC_TIMEOUT');
  assert.equal(timeout.usage().rpcCallsUsed, 1);

  const before = new AbortController();
  before.abort();
  const unused = new ScriptedFetch([]);
  await expectCode(
    new ProviderAffineSession(config(2), unused.fetch).verifyGenesis(before.signal),
    'OPERATION_ABORTED',
  );
  assert.equal(unused.calls.length, 0);

  const duringFetch = new ScriptedFetch(['WAIT_FOR_ABORT']);
  const during = new ProviderAffineSession(config(2, 1_000), duringFetch.fetch);
  const controller = new AbortController();
  const pending = during.verifyGenesis(controller.signal);
  await Promise.resolve();
  controller.abort();
  await expectCode(pending, 'OPERATION_ABORTED');
  assert.equal(during.usage().rpcCallsUsed, 1);
});

void test('rejects hostile contextual values, base64, cardinality and response identities', async () => {
  const malformedResults: readonly unknown[] = [
    context(-1, [account(DATA)]),
    context(1, [account('%%%')]),
    context(1, []),
    context(Number.MAX_SAFE_INTEGER + 1, [account(DATA)]),
  ];
  for (const malformed of malformedResults) {
    const scripted = new ScriptedFetch([rpcResult(PUBLIC_KEY, 1), rpcResult(malformed, 2)]);
    const session = new ProviderAffineSession(config(3), scripted.fetch);
    await session.verifyGenesis(activeSignal());
    await expectCode(
      session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal()),
      'RPC_RESPONSE_INVALID',
    );
    assert.equal(scripted.calls.length, 2);
  }

  const wrongId = new ScriptedFetch([jsonResponse({ jsonrpc: '2.0', id: 99, result: PUBLIC_KEY })]);
  await expectCode(
    new ProviderAffineSession(config(2), wrongId.fetch).verifyGenesis(activeSignal()),
    'RPC_RESPONSE_INVALID',
  );
});

void test('accepts omitted optional simulation fields and rejects hostile return data', async () => {
  const optionalFetch = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(1, [account(DATA)]), 2),
    rpcResult(context(2, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
    rpcResult(context(2, 5_000), 4),
    rpcResult(context(2, { err: 'BlockhashNotFound', logs: null }), 5),
  ]);
  const optional = new ProviderAffineSession(config(5), optionalFetch.fetch);
  await optional.verifyGenesis(activeSignal());
  await optional.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
  await optional.getLatestBlockhash(1n, activeSignal());
  await optional.getFeeForMessage('AQID', 1n, activeSignal());
  const result = await optional.simulateUnsignedTransaction(Object.freeze({
    transactionBase64: 'AQID', snapshotSlot: 1n,
    accountAddresses: Object.freeze([]),
  }), activeSignal());
  assert.deepEqual(result, Object.freeze({
    providerId: 'primary', contextSlot: 2n, failureKind: 'BLOCKHASH_NOT_FOUND',
    logs: null, unitsConsumed: null, accounts: null, innerInstructions: null,
  }));

  const hostileFetch = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(1, [account(DATA)]), 2),
    rpcResult(context(2, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
    rpcResult(context(2, 5_000), 4),
    rpcResult(context(2, {
      err: null, logs: [], returnData: {
        programId: PUBLIC_KEY, data: ['A'.repeat(1_500_000), 'base64'],
      },
    }), 5),
  ]);
  const hostile = new ProviderAffineSession(config(5), hostileFetch.fetch);
  await hostile.verifyGenesis(activeSignal());
  await hostile.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
  await hostile.getLatestBlockhash(1n, activeSignal());
  await hostile.getFeeForMessage('AQID', 1n, activeSignal());
  await expectCode(hostile.simulateUnsignedTransaction(Object.freeze({
    transactionBase64: 'AQID', snapshotSlot: 1n,
    accountAddresses: Object.freeze([]),
  }), activeSignal()), 'RPC_RESPONSE_INVALID');
});

void test('enforces one exact snapshot and the causal blockhash, fee, simulation order', async () => {
  const scripted = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(100, [account(DATA)]), 2),
    rpcResult(context(101, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
    rpcResult(context(101, 5_000), 4),
    rpcResult(context(100, { err: null, logs: [] }), 5),
  ]);
  const session = new ProviderAffineSession(config(5), scripted.fetch);
  await session.verifyGenesis(activeSignal());
  await expectCode(session.getLatestBlockhash(100n, activeSignal()), 'INVALID_INPUT');
  assert.equal(scripted.calls.length, 1);
  await session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
  await expectCode(
    session.readAccountSnapshot(Object.freeze([OTHER_KEY]), activeSignal()),
    'INVALID_INPUT',
  );
  await expectCode(session.getLatestBlockhash(99n, activeSignal()), 'INVALID_INPUT');
  assert.equal(scripted.calls.length, 2);
  await session.getLatestBlockhash(100n, activeSignal());
  await expectCode(session.simulateUnsignedTransaction(Object.freeze({
    transactionBase64: 'AQID', snapshotSlot: 100n,
    accountAddresses: Object.freeze([]),
  }), activeSignal()), 'INVALID_INPUT');
  await expectCode(session.getFeeForMessage('AQID', 99n, activeSignal()), 'INVALID_INPUT');
  assert.equal(scripted.calls.length, 3);
  await session.getFeeForMessage('AQID', 100n, activeSignal());
  await expectCode(session.simulateUnsignedTransaction(Object.freeze({
    transactionBase64: 'AQID', snapshotSlot: 99n,
    accountAddresses: Object.freeze([]),
  }), activeSignal()), 'INVALID_INPUT');
  await expectCode(session.simulateUnsignedTransaction(Object.freeze({
    transactionBase64: 'AQID', snapshotSlot: 100n,
    accountAddresses: Object.freeze([]),
  }), activeSignal()), 'RPC_RESPONSE_INVALID');
  assert.equal(scripted.calls.length, 5);
});

void test('rejects prototype-polluting decoded records instead of consuming inherited optionals', async () => {
  const hostileSimulation = new Response(
    `{"jsonrpc":"2.0","id":5,"result":{"context":{"slot":2},"value":`
      + `{"err":"BlockhashNotFound","logs":null,"__proto__":{"returnData":null}}}}`,
    { status: 200 },
  );
  const scripted = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(1, [account(DATA)]), 2),
    rpcResult(context(2, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
    rpcResult(context(2, 5_000), 4),
    hostileSimulation,
  ]);
  const session = new ProviderAffineSession(config(5), scripted.fetch);
  await session.verifyGenesis(activeSignal());
  await session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
  await session.getLatestBlockhash(1n, activeSignal());
  await session.getFeeForMessage('AQID', 1n, activeSignal());
  await expectCode(session.simulateUnsignedTransaction(Object.freeze({
    transactionBase64: 'AQID', snapshotSlot: 1n,
    accountAddresses: Object.freeze([]),
  }), activeSignal()), 'RPC_RESPONSE_INVALID');
});

void test('validates address array own data descriptors without invoking accessors or traps', async () => {
  const session = new ProviderAffineSession(
    config(2), new ScriptedFetch([rpcResult(PUBLIC_KEY, 1)]).fetch,
  );
  await session.verifyGenesis(activeSignal());
  let getterCalls = 0;
  const accessor: string[] = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    configurable: false,
    get: () => { getterCalls += 1; return PUBLIC_KEY; },
  });
  Object.defineProperty(accessor, 'length', { value: 1, writable: false });
  Object.freeze(accessor);
  const extra = [PUBLIC_KEY];
  Object.defineProperty(extra, 'unexpected', { enumerable: true, value: OTHER_KEY });
  Object.freeze(extra);
  let proxyTraps = 0;
  const proxy = new Proxy(Object.freeze([PUBLIC_KEY]), {
    ownKeys: () => { proxyTraps += 1; throw new Error('proxy secret'); },
    get: () => { proxyTraps += 1; throw new Error('proxy secret'); },
  });
  for (const addresses of [accessor, extra, proxy]) {
    await expectCode(
      session.readAccountSnapshot(addresses, activeSignal()), 'INVALID_INPUT',
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyTraps, 0);
});

void test('reserves every causal stage before dispatch under concurrent calls', async (context) => {
  await context.test('genesis', async () => {
    const firstGate = new FetchGate(rpcResult(PUBLIC_KEY, 1));
    const secondGate = new FetchGate(rpcResult(PUBLIC_KEY, 2));
    const scripted = new ScriptedFetch([firstGate.promise, secondGate.promise]);
    const session = new ProviderAffineSession(config(8), scripted.fetch);
    const first = session.verifyGenesis(activeSignal());
    const second = session.verifyGenesis(activeSignal());
    await settleConcurrentStage(first, second, scripted, 1, firstGate, secondGate);
  });

  await context.test('snapshot', async () => {
    const firstGate = new FetchGate(rpcResult(contextValue(100, [account(DATA)]), 2));
    const secondGate = new FetchGate(rpcResult(contextValue(100, [account(DATA)]), 3));
    const scripted = new ScriptedFetch([
      rpcResult(PUBLIC_KEY, 1), firstGate.promise, secondGate.promise,
    ]);
    const session = new ProviderAffineSession(config(8), scripted.fetch);
    await session.verifyGenesis(activeSignal());
    const first = session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
    const second = session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
    await settleConcurrentStage(first, second, scripted, 2, firstGate, secondGate);
  });

  await context.test('blockhash', async () => {
    const blockhashResult = contextValue(101, {
      blockhash: OTHER_KEY, lastValidBlockHeight: 500,
    });
    const firstGate = new FetchGate(rpcResult(blockhashResult, 3));
    const secondGate = new FetchGate(rpcResult(blockhashResult, 4));
    const scripted = new ScriptedFetch([
      rpcResult(PUBLIC_KEY, 1), rpcResult(contextValue(100, [account(DATA)]), 2),
      firstGate.promise, secondGate.promise,
    ]);
    const session = new ProviderAffineSession(config(8), scripted.fetch);
    await session.verifyGenesis(activeSignal());
    await session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
    const first = session.getLatestBlockhash(100n, activeSignal());
    const second = session.getLatestBlockhash(100n, activeSignal());
    await settleConcurrentStage(first, second, scripted, 3, firstGate, secondGate);
  });

  await context.test('fee', async () => {
    const firstGate = new FetchGate(rpcResult(contextValue(101, 5_000), 4));
    const secondGate = new FetchGate(rpcResult(contextValue(101, 5_000), 5));
    const scripted = new ScriptedFetch([
      rpcResult(PUBLIC_KEY, 1), rpcResult(contextValue(100, [account(DATA)]), 2),
      rpcResult(contextValue(101, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
      firstGate.promise, secondGate.promise,
    ]);
    const session = new ProviderAffineSession(config(8), scripted.fetch);
    await session.verifyGenesis(activeSignal());
    await session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
    await session.getLatestBlockhash(100n, activeSignal());
    const first = session.getFeeForMessage('AQID', 100n, activeSignal());
    const second = session.getFeeForMessage('AQID', 100n, activeSignal());
    await settleConcurrentStage(first, second, scripted, 4, firstGate, secondGate);
  });

  await context.test('simulation', async () => {
    const simulationResult = contextValue(102, { err: null, logs: [] });
    const firstGate = new FetchGate(rpcResult(simulationResult, 5));
    const secondGate = new FetchGate(rpcResult(simulationResult, 6));
    const scripted = new ScriptedFetch([
      rpcResult(PUBLIC_KEY, 1), rpcResult(contextValue(100, [account(DATA)]), 2),
      rpcResult(contextValue(101, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
      rpcResult(contextValue(101, 5_000), 4), firstGate.promise, secondGate.promise,
    ]);
    const session = new ProviderAffineSession(config(8), scripted.fetch);
    await session.verifyGenesis(activeSignal());
    await session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
    await session.getLatestBlockhash(100n, activeSignal());
    await session.getFeeForMessage('AQID', 100n, activeSignal());
    const request = Object.freeze({
      transactionBase64: 'AQID', snapshotSlot: 100n,
      accountAddresses: Object.freeze([]),
    });
    const first = session.simulateUnsignedTransaction(request, activeSignal());
    const second = session.simulateUnsignedTransaction(request, activeSignal());
    await settleConcurrentStage(first, second, scripted, 5, firstGate, secondGate);
  });
});

void test('stops streaming an oversized response body and never invokes config accessors', async () => {
  const chunks = Array.from({ length: 17 }, () => new Uint8Array(1_048_576));
  const oversized = new Response(new ReadableStream<Uint8Array>({
    pull(controller): void {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  }), { status: 200 });
  const session = new ProviderAffineSession(config(1, 1_000), new ScriptedFetch([oversized]).fetch);
  await expectCode(session.verifyGenesis(activeSignal()), 'RPC_RESPONSE_INVALID');

  let getterCalls = 0;
  const accessor = { ...config(1) };
  Object.defineProperty(accessor, 'httpRpcUrl', {
    enumerable: true,
    get: () => { getterCalls += 1; return 'https://credential.invalid/accessor'; },
  });
  Object.freeze(accessor);
  assert.throws(
    () => new ProviderAffineSession(accessor),
    (error: unknown) => error instanceof ExecutionProviderSessionError
      && error.code === 'INVALID_INPUT',
  );
  assert.equal(getterCalls, 0);
});

void test('rejects non-frozen or noncanonical request DTOs before dispatch', async () => {
  const scripted = new ScriptedFetch([rpcResult(PUBLIC_KEY, 1)]);
  const session = new ProviderAffineSession(config(5), scripted.fetch);
  await session.verifyGenesis(activeSignal());

  for (const run of [
    () => session.readAccountSnapshot([PUBLIC_KEY], activeSignal()),
    () => session.readAccountSnapshot(Object.freeze([PUBLIC_KEY, PUBLIC_KEY]), activeSignal()),
    () => session.getLatestBlockhash(-1n, activeSignal()),
    () => session.getFeeForMessage('not-base64', 1n, activeSignal()),
    () => session.simulateUnsignedTransaction({
      transactionBase64: 'AQID', snapshotSlot: 1n,
      accountAddresses: Object.freeze([PUBLIC_KEY]),
    }, activeSignal()),
  ]) await expectCode(run(), 'INVALID_INPUT');
  assert.equal(scripted.calls.length, 1);
});

void test('enforces configured snapshot lag before accepting a blockhash context', async () => {
  const scripted = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(100, [account(DATA)]), 2),
    rpcResult(context(109, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
  ]);
  const session = new ProviderAffineSession(config(3), scripted.fetch);
  await session.verifyGenesis(activeSignal());
  await session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
  await expectCode(session.getLatestBlockhash(100n, activeSignal()), 'RPC_RESPONSE_INVALID');
});

void test('normalizes official account space and rent epoch sentinel but rejects other unsafe epochs', async () => {
  const sentinel = Number(18_446_744_073_709_551_615n);
  const officialAccount = {
    lamports: 123, owner: PUBLIC_KEY, executable: false,
    rentEpoch: sentinel, space: 3, data: [DATA, 'base64'],
  };
  const scripted = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1), rpcResult(context(1, [officialAccount]), 2),
  ]);
  const session = new ProviderAffineSession(config(2), scripted.fetch);
  await session.verifyGenesis(activeSignal());
  const snapshot = await session.readAccountSnapshot(
    Object.freeze([PUBLIC_KEY]), activeSignal(),
  );
  assert.deepEqual(snapshot.accounts[0], Object.freeze({
    address: PUBLIC_KEY, lamports: 123n, owner: PUBLIC_KEY, executable: false,
    rentEpoch: null, space: 3n, dataBase64: DATA,
  }));

  const unsafeFetch = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1), rpcResult(context(1, [{
      ...officialAccount, rentEpoch: Number.MAX_SAFE_INTEGER + 1,
    }]), 2),
  ]);
  const unsafe = new ProviderAffineSession(config(2), unsafeFetch.fetch);
  await unsafe.verifyGenesis(activeSignal());
  await expectCode(unsafe.readAccountSnapshot(
    Object.freeze([PUBLIC_KEY]), activeSignal(),
  ), 'RPC_RESPONSE_INVALID');
});

void test('validates current simulation loaded data size and forbids replacement blockhash evidence', async () => {
  const valid = await preparedSimulationSession({
    err: null, logs: [], loadedAccountsDataSize: 123, replacementBlockhash: null,
  });
  const result = await valid.session.simulateUnsignedTransaction(simulationRequest(), activeSignal());
  assert.equal(result.failureKind, null);

  for (const simulationValue of [
    { err: null, logs: [], loadedAccountsDataSize: -1, replacementBlockhash: null },
    {
      err: null, logs: [], loadedAccountsDataSize: 123,
      replacementBlockhash: { blockhash: OTHER_KEY, lastValidBlockHeight: 500 },
    },
  ]) {
    const hostile = await preparedSimulationSession(simulationValue);
    await expectCode(
      hostile.session.simulateUnsignedTransaction(simulationRequest(), activeSignal()),
      'RPC_RESPONSE_INVALID',
    );
  }
});

void test('tolerates the Agave 4.3 simulateTransaction fields and still rejects unknown keys', async () => {
  const agaveValue = Object.freeze({
    accounts: [], err: null, fee: 5_000, innerInstructions: [], loadedAccountsDataSize: 149,
    loadedAddresses: { readonly: [], writable: [] }, logs: [],
    postBalances: [402_934_765, 1], preBalances: [402_939_765, 1],
    postTokenBalances: [{
      accountIndex: 1, mint: OTHER_KEY, owner: PUBLIC_KEY, programId: OTHER_KEY,
      uiTokenAmount: { amount: '500', decimals: 6, uiAmount: 0.0005, uiAmountString: '0.0005' },
    }],
    preTokenBalances: [],
    replacementBlockhash: null, returnData: null, unitsConsumed: 150,
  });
  const valid = await preparedSimulationSession(agaveValue);
  const result = await valid.session.simulateUnsignedTransaction(simulationRequest(), activeSignal());
  assert.equal(result.failureKind, null);
  assert.equal(result.unitsConsumed, 150n);
  assert.deepEqual(Object.keys(result).sort(), [
    'accounts', 'contextSlot', 'failureKind', 'innerInstructions', 'logs', 'providerId',
    'unitsConsumed',
  ]);

  for (const simulationValue of [
    { ...agaveValue, zzzUnexpected: 1 },
    { ...agaveValue, fee: -1 },
    { ...agaveValue, fee: '5000' },
    { ...agaveValue, loadedAddresses: { readonly: [], writable: [], zzzUnexpected: [] } },
    { ...agaveValue, loadedAddresses: { readonly: ['not-a-key'], writable: [] } },
    { ...agaveValue, preBalances: [-1, 1] },
    { ...agaveValue, postBalances: 'many' },
    { ...agaveValue, postTokenBalances: [{ ...agaveValue.postTokenBalances[0], zzzUnexpected: 1 }] },
    { ...agaveValue, postTokenBalances: [{ ...agaveValue.postTokenBalances[0], accountIndex: 256 }] },
    {
      ...agaveValue,
      postTokenBalances: [{
        ...agaveValue.postTokenBalances[0],
        uiTokenAmount: { amount: '500', decimals: 6, uiAmount: 0.0005 },
      }],
    },
  ]) {
    const hostile = await preparedSimulationSession(simulationValue);
    await expectCode(
      hostile.session.simulateUnsignedTransaction(simulationRequest(), activeSignal()),
      'RPC_RESPONSE_INVALID',
    );
  }
});

void test('accepts bounded fractional parsed evidence but rejects non-finite JSON numbers', async () => {
  const finite = await preparedSimulationSession({
    err: null,
    logs: [],
    innerInstructions: [{
      index: 0,
      instructions: [{
        program: 'spl-token',
        programId: OTHER_KEY,
        parsed: {
          type: 'transferChecked',
          info: {
            tokenAmount: {
              amount: '1', decimals: 6, uiAmount: 0.000_001, uiAmountString: '0.000001',
            },
          },
        },
      }],
    }],
  });
  const result = await finite.session.simulateUnsignedTransaction(
    simulationRequest(), activeSignal(),
  );
  assert.equal(result.innerInstructions?.[0]?.instructions[0]?.kind, 'PARSED');

  const nonFiniteResponse = new Response(
    '{"jsonrpc":"2.0","id":5,"result":{"context":{"slot":102},"value":'
      + '{"err":null,"logs":[],"innerInstructions":[{"index":0,"instructions":['
      + '{"program":"spl-token","programId":"So11111111111111111111111111111111111111112",'
      + '"parsed":{"type":"transferChecked","info":{"uiAmount":1e309}}}]}]}}}',
    { status: 200 },
  );
  const nonFinite = await preparedSimulationSession(nonFiniteResponse);
  await expectCode(nonFinite.session.simulateUnsignedTransaction(
    simulationRequest(), activeSignal(),
  ), 'RPC_RESPONSE_INVALID');
});

void test('cancels non-consumed response streams for HTTP failures and invalid declared sizes', async () => {
  for (const [status, headers, expectedCode] of [
    [429, undefined, 'RPC_RATE_LIMITED'],
    [503, undefined, 'RPC_UNAVAILABLE'],
    [200, { 'content-length': '999999999' }, 'RPC_RESPONSE_INVALID'],
  ] as const) {
    let cancelCalls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      start: () => { /* permanently pending */ },
      cancel: () => { cancelCalls += 1; throw new Error('provider cancel secret'); },
    }), { status, ...(headers === undefined ? {} : { headers }) });
    const session = new ProviderAffineSession(config(1), new ScriptedFetch([response]).fetch);
    await expectCode(session.verifyGenesis(activeSignal()), expectedCode);
    assert.equal(cancelCalls, 1);
  }
});

void test('rejects 101 unique getMultipleAccounts addresses before dispatch', async () => {
  const scripted = new ScriptedFetch([rpcResult(PUBLIC_KEY, 1)]);
  const session = new ProviderAffineSession(config(2), scripted.fetch);
  await session.verifyGenesis(activeSignal());
  const addresses = Object.freeze(Array.from({ length: 101 }, (_unused, index) => {
    const bytes = new Uint8Array(32);
    bytes[28] = (index >>> 24) & 0xff;
    bytes[29] = (index >>> 16) & 0xff;
    bytes[30] = (index >>> 8) & 0xff;
    bytes[31] = index & 0xff;
    return bs58.encode(bytes);
  }));
  await expectCode(session.readAccountSnapshot(addresses, activeSignal()), 'INVALID_INPUT');
  assert.equal(scripted.calls.length, 1);
});

type FetchStep = Response | Error | Promise<Response> | 'WAIT_FOR_ABORT';

class FetchGate {
  public readonly promise: Promise<Response>;
  private readonly resolvePromise: (response: Response) => void;

  public constructor(private readonly response: Response) {
    let resolvePromise!: (response: Response) => void;
    this.promise = new Promise<Response>((resolve) => { resolvePromise = resolve; });
    this.resolvePromise = resolvePromise;
  }

  public resolve(): void {
    this.resolvePromise(this.response);
  }
}

class ScriptedFetch {
  public readonly calls: Readonly<{
    url: string;
    method: string | undefined;
    contentType: string | null;
    body: string;
    signal: AbortSignal | null;
  }>[] = [];

  public constructor(private readonly steps: FetchStep[]) {}

  public readonly fetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    this.calls.push(Object.freeze({
      url: fetchInputUrl(input), method: init?.method,
      contentType: headers.get('content-type'), body,
      signal: init?.signal instanceof AbortSignal ? init.signal : null,
    }));
    const step = this.steps.shift();
    if (step === undefined) throw new Error('Unexpected fetch call.');
    if (step instanceof Error) throw step;
    if (step instanceof Promise) return step;
    if (step === 'WAIT_FOR_ABORT') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted secret'));
        }, {
          once: true,
        });
      });
    }
    return step;
  };
}

function fetchInputUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function config(maxCalls: number, timeoutMs = 100): Readonly<{
  providerId: string;
  httpRpcUrl: string;
  expectedGenesisHash: string;
  timeoutMs: number;
  maxCalls: number;
  maxSnapshotSlotLag: number;
}> {
  return Object.freeze({
    providerId: 'primary',
    httpRpcUrl: 'https://credential.invalid/rpc?token=secret',
    expectedGenesisHash: PUBLIC_KEY,
    timeoutMs,
    maxCalls,
    maxSnapshotSlotLag: 8,
  });
}

async function preparedSimulationSession(
  simulationValue: unknown,
): Promise<Readonly<{ session: ProviderAffineSession; scripted: ScriptedFetch }>> {
  const scripted = new ScriptedFetch([
    rpcResult(PUBLIC_KEY, 1),
    rpcResult(context(100, [account(DATA)]), 2),
    rpcResult(context(101, { blockhash: OTHER_KEY, lastValidBlockHeight: 500 }), 3),
    rpcResult(context(101, 5_000), 4),
    simulationValue instanceof Response
      ? simulationValue
      : rpcResult(context(102, simulationValue), 5),
  ]);
  const session = new ProviderAffineSession(config(5), scripted.fetch);
  await session.verifyGenesis(activeSignal());
  await session.readAccountSnapshot(Object.freeze([PUBLIC_KEY]), activeSignal());
  await session.getLatestBlockhash(100n, activeSignal());
  await session.getFeeForMessage('AQID', 100n, activeSignal());
  return Object.freeze({ session, scripted });
}

function simulationRequest(): Readonly<{
  transactionBase64: string;
  snapshotSlot: bigint;
  accountAddresses: readonly string[];
}> {
  return Object.freeze({
    transactionBase64: 'AQID',
    snapshotSlot: 100n,
    accountAddresses: Object.freeze([]),
  });
}

function rpcResult(result: unknown, id = 1): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

function minContextSlotNotReached(id: number): Response {
  return jsonResponse({
    jsonrpc: '2.0', id,
    error: {
      code: -32_016, message: 'Minimum context slot has not been reached lagging secret',
      data: { contextSlot: 99 },
    },
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function contextValue(slot: number, value: unknown): Readonly<Record<string, unknown>> {
  return { context: { slot }, value };
}

function context(slot: number, value: unknown): Readonly<Record<string, unknown>> {
  return contextValue(slot, value);
}

function account(
  dataBase64: string,
  includeRentEpoch = true,
): Readonly<Record<string, unknown>> {
  return {
    lamports: 123, owner: PUBLIC_KEY, executable: false,
    ...(includeRentEpoch ? { rentEpoch: 7 } : {}),
    space: Buffer.from(dataBase64, 'base64').byteLength,
    data: [dataBase64, 'base64'],
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: InstanceType<typeof ExecutionProviderSessionError>['code'],
): Promise<ExecutionProviderSessionError> {
  let captured: ExecutionProviderSessionError | undefined;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ExecutionProviderSessionError);
    assert.equal(error.code, code);
    assert.equal(error.message, 'Execution provider session operation failed.');
    assert.doesNotMatch(String(error), /credential|secret|header|body|provider message/iu);
    captured = error;
    return true;
  });
  return required(captured);
}

async function settleConcurrentStage(
  first: Promise<unknown>,
  second: Promise<unknown>,
  scripted: ScriptedFetch,
  expectedDispatchCount: number,
  firstGate: FetchGate,
  secondGate: FetchGate,
): Promise<void> {
  const dispatchedBeforeResolution = scripted.calls.length;
  firstGate.resolve();
  secondGate.resolve();
  const settled = await Promise.allSettled([first, second]);
  assert.equal(dispatchedBeforeResolution, expectedDispatchCount);
  assert.equal(scripted.calls.length, expectedDispatchCount);
  assert.equal(settled[0]?.status, 'fulfilled');
  assert.equal(settled[1]?.status, 'rejected');
  const reason = settled[1]?.status === 'rejected' ? settled[1].reason as unknown : null;
  assert.ok(reason instanceof ExecutionProviderSessionError);
  assert.equal(reason.code, 'INVALID_INPUT');
}

function required<Value>(value: Value | null | undefined): Value {
  assert.notEqual(value, null);
  assert.notEqual(value, undefined);
  return value as Value;
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}
