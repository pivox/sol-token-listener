import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  SystemProgram,
} from '@solana/web3.js';
import type { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  LIVE_RPC_MAX_RESPONSE_BYTES,
  LiveRpcError,
  SolanaLiveRpcSession,
  type SolanaLiveRpcSessionConfig,
} from '../src/executor-live/rpc-gateway.js';
import type {
  ExecutionRawSubmissionRequestV1,
  ExecutionSignedSimulationRequestV1,
} from '../src/ports/execution-live-gateway.js';

const GENESIS = SystemProgram.programId.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

void test('uses exact JSON-RPC ids, caches the verified genesis and reports usage', async () => {
  const transport = rpcTransport(({ method }) => {
    assert.equal(method, 'getGenesisHash');
    return GENESIS;
  });
  const session = new SolanaLiveRpcSession(config(), transport.fetch);

  assert.deepEqual(await session.verifyGenesis(signal()), Object.freeze({
    payloadVersion: 1,
    providerId: 'primary',
    expectedGenesisHash: GENESIS,
    observedGenesisHash: GENESIS,
  }));
  assert.deepEqual(await session.verifyGenesis(signal()), Object.freeze({
    payloadVersion: 1,
    providerId: 'primary',
    expectedGenesisHash: GENESIS,
    observedGenesisHash: GENESIS,
  }));
  assert.deepEqual(transport.requests.map(({ id }) => id), [1]);
  assert.deepEqual(session.usage(), Object.freeze({
    providerId: 'primary', rpcCallsUsed: 1, rpcCallsLimit: 8,
  }));
});

void test('reads blockhash validity and then block height sequentially', async () => {
  let validitySettled = false;
  const transport = rpcTransport(async ({ method }) => {
    if (method === 'getGenesisHash') return GENESIS;
    if (method === 'isBlockhashValid') {
      await Promise.resolve();
      validitySettled = true;
      return { context: { slot: 124 }, value: true };
    }
    assert.equal(method, 'getBlockHeight');
    assert.equal(validitySettled, true);
    return 900;
  });
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());

  assert.deepEqual(await session.blockhashValidity(BLOCKHASH, 123n, signal()), Object.freeze({
    payloadVersion: 1,
    providerId: 'primary',
    blockhash: BLOCKHASH,
    valid: true,
    contextSlot: 124n,
    observedBlockHeight: 900n,
  }));
  assert.deepEqual(transport.requests.map(({ method }) => method), [
    'getGenesisHash', 'isBlockhashValid', 'getBlockHeight',
  ]);
  assert.deepEqual(transport.requests[1]?.params, [
    BLOCKHASH, { commitment: 'confirmed', minContextSlot: 123 },
  ]);
  assert.deepEqual(transport.requests[2]?.params, [{ commitment: 'confirmed' }]);
});

void test('rejects blockhash validity returned below the persisted causal floor', async () => {
  const transport = rpcTransport(({ method }) => method === 'getGenesisHash'
    ? GENESIS : { context: { slot: 122 }, value: true });
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());

  await rejectsCode(
    session.blockhashValidity(BLOCKHASH, 123n, signal()),
    'RPC_RESPONSE_INVALID',
  );
  assert.deepEqual(transport.requests[1]?.params, [
    BLOCKHASH, { commitment: 'confirmed', minContextSlot: 123 },
  ]);
  assert.equal(transport.requests.length, 2);
});

void test('simulates signed bytes and derives payer, SPL base and SPL quote deltas', async () => {
  const fixture = simulationFixture();
  const transport = rpcTransport(({ method }) => {
    if (method === 'getGenesisHash') return GENESIS;
    if (method === 'getMultipleAccounts') {
      return {
        context: { slot: 123 },
        value: fixture.pre,
      };
    }
    assert.equal(method, 'simulateTransaction');
    return {
      context: { slot: 125 },
      value: {
        err: null,
        logs: ['Program log: signed', 'Program success'],
        unitsConsumed: 26_000,
        accounts: fixture.post,
      },
    };
  });
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());

  const result = await session.simulateSignedTransaction(fixture.request, signal());

  assert.deepEqual(result, Object.freeze({
    payloadVersion: 1,
    providerId: 'primary',
    contextSlot: 125n,
    failureKind: null,
    unitsConsumed: 26_000n,
    feePayerLamportDebit: 6_000n,
    baseDeltaRaw: 95n,
    quoteDeltaRaw: -100n,
    logsFingerprint: logsFingerprint(['Program log: signed', 'Program success']),
    logsLineCount: 2,
  }));
  assert.deepEqual(transport.requests.map(({ method }) => method), [
    'getGenesisHash', 'getMultipleAccounts', 'simulateTransaction',
  ]);
  assert.deepEqual(transport.requests[1]?.params, [
    [...fixture.request.accountAddresses],
    { encoding: 'base64', commitment: 'confirmed', minContextSlot: 123 },
  ]);
  assert.deepEqual(transport.requests[2]?.params, [
    fixture.request.transactionBase64,
    {
      encoding: 'base64', commitment: 'confirmed', sigVerify: true,
      replaceRecentBlockhash: false, minContextSlot: 123,
      accounts: {
        encoding: 'base64', addresses: [...fixture.request.accountAddresses],
      },
    },
  ]);
});

void test('supports an absent pre base account and classifies program failures', async () => {
  const fixture = simulationFixture();
  const transport = rpcTransport(({ method }) => {
    if (method === 'getGenesisHash') return GENESIS;
    if (method === 'getMultipleAccounts') {
      return { context: { slot: 123 }, value: [fixture.pre[0], null, fixture.pre[2]] };
    }
    return {
      context: { slot: 125 },
      value: {
        err: { InstructionError: [1, 'Custom'] },
        logs: ['Program failed'],
        unitsConsumed: 10,
        accounts: [
          systemAccount(7_954_720), fixture.post[1], fixture.post[2],
        ],
      },
    };
  });
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());

  const result = await session.simulateSignedTransaction(fixture.request, signal());

  assert.equal(result.failureKind, 'PROGRAM_ERROR');
  assert.equal(result.baseDeltaRaw, 105n);
  assert.equal(result.quoteDeltaRaw, -100n);
});

void test('rejects a signed simulation whose quote address is not the payer WSOL ATA', async () => {
  const fixture = simulationFixture();
  const transport = rpcTransport(() => GENESIS);
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());

  await rejectsCode(session.simulateSignedTransaction(Object.freeze({
    ...fixture.request,
    accountAddresses: Object.freeze([
      fixture.request.accountAddresses[0],
      fixture.request.accountAddresses[1],
      Keypair.generate().publicKey.toBase58(),
    ] as const),
  }), signal()), 'INVALID_INPUT');
  assert.equal(transport.requests.length, 1);
});

void test('derives PumpSwap SELL quote proceeds when the WSOL ATA is absent then closed', async () => {
  const fixture = simulationFixture();
  const transport = rpcTransport(({ method }) => {
    if (method === 'getGenesisHash') return GENESIS;
    if (method === 'getMultipleAccounts') {
      return {
        context: { slot: 123 },
        value: [systemAccount(10_000_000), fixture.pre[1], null],
      };
    }
    return {
      context: { slot: 125 },
      value: {
        err: null,
        logs: ['Program success'],
        unitsConsumed: 20_000,
        accounts: [
          systemAccount(10_095_000),
          withTokenAmount(fixture.pre[1], 0n),
          null,
        ],
      },
    };
  });
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());

  const result = await session.simulateSignedTransaction(Object.freeze({
    ...fixture.request,
    estimatedFeeLamports: 5_000n,
  }), signal());

  assert.equal(result.baseDeltaRaw, -10n);
  assert.equal(result.quoteDeltaRaw, 100_000n);
  assert.equal(result.feePayerLamportDebit, 0n);
});

void test('includes pre-existing WSOL ATA lamports when PumpSwap SELL closes it', async () => {
  const fixture = simulationFixture();
  const preQuote = tokenAccount(NATIVE_MINT, fixture.payer, 50n);
  const transport = rpcTransport(({ method }) => {
    if (method === 'getGenesisHash') return GENESIS;
    if (method === 'getMultipleAccounts') {
      return {
        context: { slot: 123 },
        value: [systemAccount(10_000_000), fixture.pre[1], preQuote],
      };
    }
    return {
      context: { slot: 125 },
      value: {
        err: null,
        logs: ['Program success'],
        unitsConsumed: 20_000,
        accounts: [
          systemAccount(10_000_000 + preQuote.lamports + 95_000),
          withTokenAmount(fixture.pre[1], 0n),
          null,
        ],
      },
    };
  });
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());

  const result = await session.simulateSignedTransaction(Object.freeze({
    ...fixture.request,
    estimatedFeeLamports: 5_000n,
  }), signal());

  assert.equal(result.baseDeltaRaw, -10n);
  assert.equal(result.quoteDeltaRaw, 100_000n);
});

void test('submits through official sendTransaction wire with exact closed options', async () => {
  const signature = bs58.encode(Uint8Array.from({ length: 64 }, (_item, index) => index + 1));
  const transport = rpcTransport(({ method }) => {
    if (method === 'getGenesisHash') return GENESIS;
    assert.equal(method, 'sendTransaction');
    return signature;
  });
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());

  assert.deepEqual(await session.sendRawTransaction(submissionRequest(), signal()),
    Object.freeze({ signature }));
  assert.deepEqual(transport.requests[1], {
    jsonrpc: '2.0', id: 2, method: 'sendTransaction',
    params: [
      'AQ==',
      {
        encoding: 'base64', skipPreflight: true, maxRetries: 0,
        preflightCommitment: 'confirmed',
      },
    ],
  });
});

void test('rejects non-canonical signatures and poisons the session', async () => {
  const transport = rpcTransport(({ method }) => method === 'getGenesisHash'
    ? GENESIS : '1'.repeat(63));
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());

  await rejectsCode(
    session.sendRawTransaction(submissionRequest(), signal()),
    'RPC_RESPONSE_INVALID',
  );
  await rejectsCode(session.verifyGenesis(signal()), 'SESSION_FAILED');
});

void test('matches the exact JSON-RPC response id and rejects extra envelope fields', async () => {
  for (const envelope of [
    { jsonrpc: '2.0', id: 2, result: GENESIS },
    { jsonrpc: '2.0', id: 1, result: GENESIS, extra: true },
    { jsonrpc: '2.0', id: '1', result: GENESIS },
    { jsonrpc: '2.0', id: 1, result: GENESIS, error: null },
  ]) {
    const session = new SolanaLiveRpcSession(config(), async () => response(envelope));
    await rejectsCode(session.verifyGenesis(signal()), 'RPC_RESPONSE_INVALID');
    await rejectsCode(session.verifyGenesis(signal()), 'SESSION_FAILED');
  }
});

void test('maps HTTP status, JSON-RPC errors and genesis mismatch to closed codes', async () => {
  const rateLimited = new SolanaLiveRpcSession(config(), async () => new Response('', {
    status: 429,
  }));
  await rejectsCode(rateLimited.verifyGenesis(signal()), 'RPC_RATE_LIMITED');

  const unavailable = new SolanaLiveRpcSession(config(), async () => new Response('', {
    status: 503,
  }));
  await rejectsCode(unavailable.verifyGenesis(signal()), 'RPC_UNAVAILABLE');

  const rpcError = new SolanaLiveRpcSession(config(), async () => response({
    jsonrpc: '2.0', id: 1, error: { code: -32_005, message: 'node unhealthy' },
  }));
  await rejectsCode(rpcError.verifyGenesis(signal()), 'RPC_UNAVAILABLE');

  const mismatch = new SolanaLiveRpcSession(config(), rpcTransport(() => BLOCKHASH).fetch);
  await rejectsCode(mismatch.verifyGenesis(signal()), 'GENESIS_MISMATCH');
});

void test('bounds declared Content-Length and streamed response bytes', async () => {
  const declared = new SolanaLiveRpcSession(config(), async () => new Response('{}', {
    headers: { 'content-length': String(LIVE_RPC_MAX_RESPONSE_BYTES + 1) },
  }));
  await rejectsCode(declared.verifyGenesis(signal()), 'RPC_RESPONSE_TOO_LARGE');

  const invalidLength = new SolanaLiveRpcSession(config(), async () => new Response('{}', {
    headers: { 'content-length': '01' },
  }));
  await rejectsCode(invalidLength.verifyGenesis(signal()), 'RPC_RESPONSE_INVALID');

  const chunks = [
    new Uint8Array(LIVE_RPC_MAX_RESPONSE_BYTES),
    new Uint8Array([1]),
  ];
  const streamed = new SolanaLiveRpcSession(config(), async () => new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    }),
  ));
  await rejectsCode(streamed.verifyGenesis(signal()), 'RPC_RESPONSE_TOO_LARGE');
});

void test('rejects malformed UTF-8 and malformed signed account evidence', async () => {
  const utf8 = new SolanaLiveRpcSession(config(), async () => new Response(
    new Uint8Array([0xc3, 0x28]),
  ));
  await rejectsCode(utf8.verifyGenesis(signal()), 'RPC_RESPONSE_INVALID');

  const fixture = simulationFixture();
  const malformed = rpcTransport(({ method }) => {
    if (method === 'getGenesisHash') return GENESIS;
    if (method === 'getMultipleAccounts') {
      return { context: { slot: 123 }, value: fixture.pre };
    }
    return {
      context: { slot: 125 },
      value: {
        err: null, logs: [], unitsConsumed: 1,
        accounts: [fixture.post[0], { ...fixture.post[1], owner: GENESIS }, fixture.post[2]],
      },
    };
  });
  const session = new SolanaLiveRpcSession(config(), malformed.fetch);
  await session.verifyGenesis(signal());
  await rejectsCode(
    session.simulateSignedTransaction(fixture.request, signal()),
    'RPC_RESPONSE_INVALID',
  );
});

void test('rejects signed SPL deltas outside the downstream i64 contract', async () => {
  const fixture = simulationFixture();
  const transport = rpcTransport(({ method }) => {
    if (method === 'getGenesisHash') return GENESIS;
    if (method === 'getMultipleAccounts') {
      return { context: { slot: 123 }, value: fixture.pre };
    }
    return {
      context: { slot: 125 },
      value: {
        err: null,
        logs: [],
        unitsConsumed: 1,
        accounts: [
          fixture.post[0],
          withTokenAmount(fixture.post[1], (1n << 63n) + 100n),
          fixture.post[2],
        ],
      },
    };
  });
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());

  await rejectsCode(
    session.simulateSignedTransaction(fixture.request, signal()),
    'RPC_RESPONSE_INVALID',
  );
});

void test('distinguishes timeout from caller abort and aborts the transport', async () => {
  let timeoutAborted = false;
  const timeoutSession = new SolanaLiveRpcSession(config({ timeoutMs: 5 }),
    async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        timeoutAborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }));
  await rejectsCode(timeoutSession.verifyGenesis(signal()), 'RPC_TIMEOUT');
  assert.equal(timeoutAborted, true);

  let callerAborted = false;
  const callerSession = new SolanaLiveRpcSession(config({ timeoutMs: 1_000 }),
    async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        callerAborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }));
  const controller = new AbortController();
  const pending = callerSession.verifyGenesis(controller.signal);
  controller.abort();
  await rejectsCode(pending, 'OPERATION_ABORTED');
  assert.equal(callerAborted, true);
});

void test('enforces one shared call budget and permanently fails the session', async () => {
  const fixture = simulationFixture();
  const transport = rpcTransport(({ method }) => {
    if (method === 'getGenesisHash') return GENESIS;
    return { context: { slot: 123 }, value: fixture.pre };
  });
  const session = new SolanaLiveRpcSession(config({ maxCalls: 1 }), transport.fetch);
  await session.verifyGenesis(signal());

  await rejectsCode(
    session.simulateSignedTransaction(fixture.request, signal()),
    'CALL_BUDGET_EXCEEDED',
  );
  await rejectsCode(session.blockhashValidity(BLOCKHASH, 123n, signal()), 'SESSION_FAILED');
  assert.equal(transport.requests.length, 1);
});

void test('validates exact frozen configuration and requests before transport', async () => {
  assert.throws(
    () => new SolanaLiveRpcSession({ ...config(), httpRpcUrl: 'ftp://invalid.test' }),
    (error: unknown) => hasCode(error, 'INVALID_INPUT'),
  );
  assert.throws(
    () => new SolanaLiveRpcSession({ ...config(), expectedGenesisHash: 'genesis' }),
    (error: unknown) => hasCode(error, 'INVALID_INPUT'),
  );

  const transport = rpcTransport(() => GENESIS);
  const session = new SolanaLiveRpcSession(config(), transport.fetch);
  await session.verifyGenesis(signal());
  const mutable = { ...submissionRequest() };
  await rejectsCode(
    session.sendRawTransaction(mutable as ExecutionRawSubmissionRequestV1, signal()),
    'INVALID_INPUT',
  );
  assert.equal(transport.requests.length, 1);
});

interface RpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

function rpcTransport<Result>(
  handler: (request: RpcRequest) => Result | Promise<Result>,
): Readonly<{ requests: RpcRequest[]; fetch: typeof fetch }> {
  const requests: RpcRequest[] = [];
  const fetchImplementation: typeof fetch = async (_url, init) => {
    assert.equal(init?.method, 'POST');
    assert.deepEqual(init?.headers, {
      accept: 'application/json',
      'content-type': 'application/json',
    });
    assert.ok(init?.signal instanceof AbortSignal);
    const body = init?.body;
    assert.equal(typeof body, 'string');
    if (typeof body !== 'string') throw new TypeError('Expected a string RPC body.');
    const decoded = JSON.parse(body) as RpcRequest;
    requests.push(decoded);
    const result = await handler(decoded);
    return response({ jsonrpc: '2.0', id: decoded.id, result });
  };
  return Object.freeze({ requests, fetch: fetchImplementation });
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function config(
  overrides: Partial<SolanaLiveRpcSessionConfig> = {},
): SolanaLiveRpcSessionConfig {
  return Object.freeze({
    providerId: 'primary',
    httpRpcUrl: 'http://127.0.0.1:8899',
    expectedGenesisHash: GENESIS,
    timeoutMs: 100,
    maxCalls: 8,
    ...overrides,
  });
}

function submissionRequest(): ExecutionRawSubmissionRequestV1 {
  return Object.freeze({
    payloadVersion: 1,
    transactionBase64: 'AQ==',
    skipPreflight: true,
    maxRetries: 0,
    preflightCommitment: 'confirmed',
  });
}

function simulationFixture(): Readonly<{
  request: ExecutionSignedSimulationRequestV1;
  payer: PublicKey;
  pre: readonly [RpcAccount, RpcAccount, RpcAccount];
  post: readonly [RpcAccount, RpcAccount, RpcAccount];
}> {
  const payer = Keypair.generate().publicKey;
  const baseAddress = Keypair.generate().publicKey;
  const quoteAddress = getAssociatedTokenAddressSync(NATIVE_MINT, payer);
  const baseMint = Keypair.generate().publicKey;
  const request: ExecutionSignedSimulationRequestV1 = Object.freeze({
    payloadVersion: 1,
    transactionBase64: 'AQ==',
    snapshotSlot: 123n,
    estimatedFeeLamports: 6_000n,
    accountAddresses: Object.freeze([
      payer.toBase58(), baseAddress.toBase58(), quoteAddress.toBase58(),
    ] as const),
    commitment: 'confirmed',
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  return Object.freeze({
    request,
    payer,
    pre: Object.freeze([
      systemAccount(10_000_000),
      tokenAccount(baseMint, payer, 10n),
      tokenAccount(NATIVE_MINT, payer, 200n),
    ] as const),
    post: Object.freeze([
      systemAccount(9_994_000),
      tokenAccount(baseMint, payer, 105n),
      tokenAccount(NATIVE_MINT, payer, 100n),
    ] as const),
  });
}

interface RpcAccount {
  readonly lamports: number;
  readonly owner: string;
  readonly executable: false;
  readonly rentEpoch: number;
  readonly space: number;
  readonly data: readonly [string, 'base64'];
}

function systemAccount(lamports: number): RpcAccount {
  return Object.freeze({
    lamports,
    owner: SystemProgram.programId.toBase58(),
    executable: false,
    rentEpoch: 0,
    space: 0,
    data: Object.freeze(['', 'base64'] as const),
  });
}

function tokenAccount(mint: PublicKey, holder: PublicKey, amount: bigint): RpcAccount {
  const data = Buffer.alloc(165);
  data.set(mint.toBytes(), 0);
  data.set(holder.toBytes(), 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return Object.freeze({
    lamports: Number(2_039_280n + (mint.equals(NATIVE_MINT) ? amount : 0n)),
    owner: TOKEN_PROGRAM_ID.toBase58(),
    executable: false,
    rentEpoch: 0,
    space: data.byteLength,
    data: Object.freeze([data.toString('base64'), 'base64'] as const),
  });
}

function withTokenAmount(account: RpcAccount, amount: bigint): RpcAccount {
  const data = Buffer.from(account.data[0], 'base64');
  data.writeBigUInt64LE(amount, 64);
  return Object.freeze({
    ...account,
    data: Object.freeze([data.toString('base64'), 'base64'] as const),
  });
}

function logsFingerprint(logs: readonly string[]): string {
  const values = ['execution-simulation-logs-v1', ...logs];
  const bytes = Buffer.concat(values.flatMap((value) => {
    const encoded = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(encoded.byteLength);
    return [length, encoded];
  }));
  return createHash('sha256').update(bytes).digest('hex');
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function rejectsCode(
  operation: Promise<unknown>,
  code: LiveRpcError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => hasCode(error, code));
}

function hasCode(error: unknown, code: LiveRpcError['code']): boolean {
  return error instanceof LiveRpcError
    && error.code === code
    && error.message === 'Live RPC operation failed.';
}
