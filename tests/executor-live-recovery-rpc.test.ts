import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import {
  AddressLookupTableAccount,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  LiveRecoveryRpcError,
  SolanaFinalityRpcSession,
} from '../src/executor-live-recovery/rpc-gateway.js';

const GENESIS = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';

void test('verifies the configured genesis through a bounded read-only call', async () => {
  const requests: RpcRequest[] = [];
  const session = sessionFor(requests, ({ method }) => {
    assert.equal(method, 'getGenesisHash');
    return GENESIS;
  });
  assert.deepEqual(await session.verifyGenesis(new AbortController().signal), {
    providerId: 'primary', expectedGenesisHash: GENESIS, observedGenesisHash: GENESIS,
  });
  assert.equal(requests.length, 1);
});

void test('observes confirmed and finalized signatures without exposing transport methods', async () => {
  const requests: RpcRequest[] = [];
  const session = sessionFor(requests, () => ({
    context: { slot: 501, apiVersion: '2.3.1' },
    value: [{ slot: 500, confirmations: null, err: null, confirmationStatus: 'finalized' }],
  }));
  assert.deepEqual(await session.observeSignature('1'.repeat(64), signal()), {
    confirmationStatus: 'FINALIZED', observedSlot: 500n, observedAtMs: 2_000,
  });
  assert.deepEqual(requests[0], {
    jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses',
    params: [['1'.repeat(64)], { searchTransactionHistory: true }],
  });
  assert.equal(Object.keys(session).some((key) => /send|sign|submit/iu.test(key)), false);
});

void test('rejects malformed or unknown signature-status context fields', async () => {
  for (const context of [
    { slot: 501, apiVersion: 231 },
    { slot: 501, apiVersion: '2.3.1', extra: true },
  ]) {
    const session = sessionFor([], () => ({
      context,
      value: [{ slot: 500, confirmations: null, err: null, confirmationStatus: 'finalized' }],
    }));
    await assert.rejects(
      session.observeSignature('1'.repeat(64), signal()),
      (error: unknown) => error instanceof LiveRecoveryRpcError
        && error.code === 'RPC_RESPONSE_INVALID',
    );
  }
});

void test('shares one finalized transaction read and derives exact wallet deltas as bigint', async () => {
  const fixture = transactionFixture();
  const requests: RpcRequest[] = [];
  const session = sessionFor(requests, ({ method }) => {
    if (method === 'getBlockHeight') return 1_001;
    if (method === 'getSignatureStatuses') {
      return { context: { slot: 501 }, value: [{
        slot: 500, confirmations: null, err: null, confirmationStatus: 'finalized',
      }] };
    }
    if (method === 'getTransaction') return fixture.rpcTransaction;
    throw new Error('unexpected method');
  });
  const request = Object.freeze({
    signature: fixture.signature,
    walletPublicKey: fixture.wallet,
    mint: fixture.mint,
    quoteMint: WSOL,
    side: 'BUY' as const,
  });
  const [height, history, transaction, deltas] = await Promise.all([
    session.readFinalizedBlockHeight(signal()),
    session.readSignatureHistory(fixture.signature, signal()),
    session.readNormalizedTransaction(fixture.signature, signal()),
    session.readFinalizedWalletDeltas(request, signal()),
  ]);
  assert.equal(height, 1_001n);
  assert.equal(history, 'PRESENT');
  assert.deepEqual(transaction, {
    signature: fixture.signature,
    blockhash: GENESIS,
    messageHash: fixture.messageHash,
  });
  assert.deepEqual(deltas, {
    confirmationStatus: 'FINALIZED', observedSlot: 500n,
    feeLamports: 5_000n, walletLamportDelta: -105_000n,
    baseDeltaRaw: 500n, quoteDeltaRaw: -100_000n,
    unexpectedResidualTokenBalanceRaw: 0n,
    observedAtMs: 2_000, finalizedAtMs: 2_000,
  });
  assert.equal(requests.filter((item) => item.method === 'getTransaction').length, 1);
  assert.deepEqual(
    requests.find((item) => item.method === 'getTransaction')?.params,
    [fixture.signature, {
      commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0,
    }],
  );
});

void test('accepts the complete v0 getTransaction response and resolves loaded token accounts', async () => {
  const fixture = fullV0TransactionFixture();
  const session = sessionFor([], ({ method }) => {
    if (method === 'getTransaction') return fixture.rpcTransaction;
    throw new Error('unexpected method');
  });
  const request = Object.freeze({
    signature: fixture.signature,
    walletPublicKey: fixture.wallet,
    mint: fixture.mint,
    quoteMint: WSOL,
    side: 'BUY' as const,
  });

  assert.deepEqual(await session.readNormalizedTransaction(fixture.signature, signal()), {
    signature: fixture.signature,
    blockhash: GENESIS,
    messageHash: fixture.messageHash,
  });
  assert.deepEqual(await session.readFinalizedWalletDeltas(request, signal()), {
    confirmationStatus: 'FINALIZED', observedSlot: 501n,
    feeLamports: 5_000n, walletLamportDelta: -105_000n,
    baseDeltaRaw: 500n, quoteDeltaRaw: -100_000n,
    unexpectedResidualTokenBalanceRaw: 0n,
    observedAtMs: 2_000, finalizedAtMs: 2_000,
  });
});

void test('rejects invalid v0 versions, loaded addresses, and token account indexes', async () => {
  const fixture = fullV0TransactionFixture();
  const malformed = [
    { ...fixture.rpcTransaction, version: 1 },
    {
      ...fixture.rpcTransaction,
      meta: {
        ...fixture.rpcTransaction.meta,
        loadedAddresses: { writable: ['not-a-public-key'], readonly: [] },
      },
    },
    {
      ...fixture.rpcTransaction,
      meta: {
        ...fixture.rpcTransaction.meta,
        postTokenBalances: [{
          ...fixture.rpcTransaction.meta.postTokenBalances[0], accountIndex: 99,
        }],
      },
    },
  ];
  for (const response of malformed) {
    const session = sessionFor([], ({ method }) => {
      if (method === 'getTransaction') return response;
      throw new Error('unexpected method');
    });
    await assert.rejects(
      session.readNormalizedTransaction(fixture.signature, signal()),
      (error: unknown) => error instanceof LiveRecoveryRpcError
        && error.code === 'RPC_RESPONSE_INVALID',
    );
  }
});

void test('rejects v0 loaded-address shifts and token balance indexes above u8', async () => {
  const fixture = fullV0TransactionFixture();
  const malformed = [
    {
      ...fixture.rpcTransaction,
      meta: {
        ...fixture.rpcTransaction.meta,
        loadedAddresses: {
          writable: [fixture.loadedWritable, fixture.loadedReadonly], readonly: [],
        },
      },
    },
    {
      ...fixture.rpcTransaction,
      meta: {
        ...fixture.rpcTransaction.meta,
        loadedAddresses: {
          writable: [], readonly: [fixture.loadedWritable, fixture.loadedReadonly],
        },
      },
    },
    {
      ...fixture.rpcTransaction,
      meta: {
        ...fixture.rpcTransaction.meta,
        postTokenBalances: [{
          ...fixture.rpcTransaction.meta.postTokenBalances[0], accountIndex: 256,
        }],
      },
    },
  ];
  for (const response of malformed) {
    const session = sessionFor([], ({ method }) => {
      if (method === 'getTransaction') return response;
      throw new Error('unexpected method');
    });
    await assert.rejects(
      session.readNormalizedTransaction(fixture.signature, signal()),
      (error: unknown) => error instanceof LiveRecoveryRpcError
        && error.code === 'RPC_RESPONSE_INVALID',
    );
  }
});

void test('rejects a token-balance identity change at one account index', async () => {
  const fixture = fullV0TransactionFixture();
  const session = sessionFor([], ({ method }) => {
    if (method !== 'getTransaction') throw new Error('unexpected method');
    return {
      ...fixture.rpcTransaction,
      meta: {
        ...fixture.rpcTransaction.meta,
        postTokenBalances: [{
          ...fixture.rpcTransaction.meta.postTokenBalances[0], owner: fixture.loadedReadonly,
        }],
      },
    };
  });
  await assert.rejects(
    session.readFinalizedWalletDeltas({
      signature: fixture.signature, walletPublicKey: fixture.wallet, mint: fixture.mint,
      quoteMint: WSOL, side: 'BUY',
    }, signal()),
    (error: unknown) => error instanceof LiveRecoveryRpcError
      && error.code === 'RPC_RESPONSE_INVALID',
  );
});

void test('reports absent finalized history without inventing a transaction or deltas', async () => {
  const session = sessionFor([], ({ method }) => {
    if (method === 'getBlockHeight') return 1_001;
    if (method === 'getSignatureStatuses') return { context: { slot: 501 }, value: [null] };
    if (method === 'getTransaction') return null;
    throw new Error('unexpected method');
  });
  const request = {
    signature: '1'.repeat(64), walletPublicKey: GENESIS, mint: GENESIS,
    quoteMint: WSOL, side: 'SELL' as const,
  };
  assert.equal(await session.readSignatureHistory(request.signature, signal()), 'ABSENT');
  assert.equal(await session.readNormalizedTransaction(request.signature, signal()), null);
  assert.deepEqual(await session.readFinalizedWalletDeltas(request, signal()), {
    confirmationStatus: 'NOT_FOUND', observedSlot: null, feeLamports: 0n,
    walletLamportDelta: 0n, baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
    unexpectedResidualTokenBalanceRaw: 0n, observedAtMs: 2_000, finalizedAtMs: null,
  });
});

void test('classifies 429, timeout, abort, oversized and malformed responses with fixed errors', async () => {
  const scenarios: readonly [typeof fetch, string][] = [
    [async () => new Response('', { status: 429 }), 'RPC_RATE_LIMITED'],
    [async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('secret', 'AbortError'));
      });
    }), 'RPC_TIMEOUT'],
    [async () => new Response('{}', { headers: { 'content-length': '99999999' } }),
      'RPC_RESPONSE_TOO_LARGE'],
    [async () => new Response('{"jsonrpc":"2.0","id":99,"result":null}'),
      'RPC_RESPONSE_INVALID'],
  ];
  for (const [fetchImplementation, code] of scenarios) {
    const session = new SolanaFinalityRpcSession({
      providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
      expectedGenesisHash: GENESIS, timeoutMs: 5, maxCalls: 8,
    }, fetchImplementation, () => 2_000);
    await assert.rejects(
      session.verifyGenesis(signal()),
      (error: unknown) => error instanceof LiveRecoveryRpcError
        && error.code === code && !error.message.includes('secret'),
    );
  }

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    sessionFor([], () => GENESIS).verifyGenesis(controller.signal),
    (error: unknown) => error instanceof LiveRecoveryRpcError
      && error.code === 'OPERATION_ABORTED',
  );
});

void test('abandons never-ending response bodies before every pre-read dispatch exit', async () => {
  const scenarios: readonly [number, Readonly<Record<string, string>> | undefined, string][] = [
    [429, undefined, 'RPC_RATE_LIMITED'],
    [500, undefined, 'RPC_UNAVAILABLE'],
    [200, { 'content-length': 'not-a-length' }, 'RPC_RESPONSE_TOO_LARGE'],
    [200, { 'content-length': '16777217' }, 'RPC_RESPONSE_TOO_LARGE'],
  ];
  for (const [status, headers, code] of scenarios) {
    let cancelled = false;
    const fetchState: { signal: AbortSignal | null } = { signal: null };
    const session = new SolanaFinalityRpcSession({
      providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
      expectedGenesisHash: GENESIS, timeoutMs: 1_000, maxCalls: 8,
    }, async (_input, init) => {
      fetchState.signal = init?.signal instanceof AbortSignal ? init.signal : null;
      return new Response(new ReadableStream<Uint8Array>({
        pull() { /* never ends */ },
        cancel() { cancelled = true; },
      }), headers === undefined ? { status } : { status, headers });
    }, () => 2_000);
    await assert.rejects(
      session.verifyGenesis(signal()),
      (error: unknown) => error instanceof LiveRecoveryRpcError && error.code === code,
    );
    assert.equal(fetchState.signal?.aborted, true);
    assert.equal(cancelled, true);
  }
});

void test('decodes many one-byte response chunks without retaining chunk objects', async () => {
  const payload = Buffer.concat([
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: GENESIS })),
    Buffer.alloc(32 * 1024, 0x20),
  ]);
  const session = new SolanaFinalityRpcSession({
    providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: GENESIS, timeoutMs: 1_000, maxCalls: 8,
  }, async () => new Response(oneByteStream(payload)), () => 2_000);
  assert.deepEqual(await session.verifyGenesis(signal()), {
    providerId: 'primary', expectedGenesisHash: GENESIS, observedGenesisHash: GENESIS,
  });
});

void test('rejects malformed UTF-8 even when it is in an unused JSON string', async () => {
  const bytes = Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":[{"slot":1,"confirmations":null,"err":"'),
    Buffer.from([0xc3]),
    Buffer.from('","confirmationStatus":"finalized"}]}}'),
  ]);
  const session = new SolanaFinalityRpcSession({
    providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: GENESIS, timeoutMs: 1_000, maxCalls: 8,
  }, async () => new Response(bytes), () => 2_000);
  await assert.rejects(
    session.observeSignature('1'.repeat(64), signal()),
    (error: unknown) => error instanceof LiveRecoveryRpcError
      && error.code === 'RPC_RESPONSE_INVALID',
  );
});

void test('keeps timeout and abort handling active while reading an RPC response body', async () => {
  const timeout = new SolanaFinalityRpcSession({
    providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: GENESIS, timeoutMs: 5, maxCalls: 8,
  }, streamingFetch((stream, fetchSignal) => {
    fetchSignal.addEventListener('abort', () => {
      stream.error(new DOMException('secret', 'AbortError'));
    });
  }), () => 2_000);
  await assert.rejects(
    timeout.verifyGenesis(signal()),
    (error: unknown) => error instanceof LiveRecoveryRpcError
      && error.code === 'RPC_TIMEOUT' && !error.message.includes('secret'),
  );

  const controller = new AbortController();
  const aborted = new SolanaFinalityRpcSession({
    providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: GENESIS, timeoutMs: 1_000, maxCalls: 8,
  }, streamingFetch((stream, fetchSignal) => {
    fetchSignal.addEventListener('abort', () => {
      stream.error(new DOMException('secret', 'AbortError'));
    });
    setTimeout(() => { controller.abort(); }, 5);
  }), () => 2_000);
  await assert.rejects(
    aborted.verifyGenesis(controller.signal),
    (error: unknown) => error instanceof LiveRecoveryRpcError
      && error.code === 'OPERATION_ABORTED' && !error.message.includes('secret'),
  );
});

void test('stops reading and cancels a chunked RPC body once it exceeds 16 MiB', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      if (cancelled) return;
      if ((this as { chunks?: number }).chunks === undefined) {
        (this as { chunks?: number }).chunks = 1;
        return;
      }
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { cancelled = true; },
  });
  const session = new SolanaFinalityRpcSession({
    providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: GENESIS, timeoutMs: 1_000, maxCalls: 8,
  }, async () => new Response(body), () => 2_000);
  await assert.rejects(
    session.verifyGenesis(signal()),
    (error: unknown) => error instanceof LiveRecoveryRpcError
      && error.code === 'RPC_RESPONSE_TOO_LARGE',
  );
  assert.equal(cancelled, true);
});

void test('fails the session permanently on genesis mismatch and call-budget exhaustion', async () => {
  const mismatch = sessionFor([], () => Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 9))
    .publicKey.toBase58());
  await assert.rejects(
    mismatch.verifyGenesis(signal()),
    (error: unknown) => error instanceof LiveRecoveryRpcError
      && error.code === 'GENESIS_MISMATCH',
  );
  await assert.rejects(
    mismatch.observeSignature('1'.repeat(64), signal()),
    (error: unknown) => error instanceof LiveRecoveryRpcError
      && error.code === 'SESSION_FAILED',
  );

  const budget = new SolanaFinalityRpcSession({
    providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: GENESIS, timeoutMs: 1_000, maxCalls: 1,
  }, rpcFetch(() => GENESIS, []), () => 2_000);
  await budget.verifyGenesis(signal());
  await assert.rejects(
    budget.readFinalizedBlockHeight(signal()),
    (error: unknown) => error instanceof LiveRecoveryRpcError
      && error.code === 'CALL_BUDGET_EXCEEDED',
  );
});

interface RpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

function sessionFor(
  requests: RpcRequest[],
  result: (request: RpcRequest) => unknown,
): SolanaFinalityRpcSession {
  return new SolanaFinalityRpcSession({
    providerId: 'primary', httpRpcUrl: 'https://credential@rpc.example.test/solana',
    expectedGenesisHash: GENESIS, timeoutMs: 1_000, maxCalls: 8,
  }, rpcFetch(result, requests), () => 2_000);
}

function rpcFetch(
  result: (request: RpcRequest) => unknown,
  requests: RpcRequest[],
): typeof fetch {
  return async (_input, init) => {
    if (typeof init?.body !== 'string') throw new TypeError('Expected string RPC body.');
    const request = JSON.parse(init.body) as RpcRequest;
    requests.push(request);
    return new Response(JSON.stringify({
      jsonrpc: '2.0', id: request.id, result: result(request),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function transactionFixture() {
  const payer = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 1));
  const recipient = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 2)).publicKey;
  const mint = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 3)).publicKey.toBase58();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: GENESIS,
    instructions: [SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 1,
    })],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const signature = bs58.encode(transaction.signatures[0] ?? new Uint8Array());
  const messageHash = createHash('sha256').update(message.serialize()).digest('hex');
  return {
    signature,
    wallet: payer.publicKey.toBase58(),
    mint,
    messageHash,
    rpcTransaction: {
      slot: 500,
      blockTime: 2,
      version: 0,
      transaction: [Buffer.from(transaction.serialize()).toString('base64'), 'base64'],
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [1_000_000, 0, 1],
        postBalances: [895_000, 100_000, 1],
        preTokenBalances: [{
          accountIndex: 1, mint, owner: payer.publicKey.toBase58(),
          uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
        }],
        postTokenBalances: [{
          accountIndex: 1, mint, owner: payer.publicKey.toBase58(),
          uiTokenAmount: { amount: '500', decimals: 6, uiAmount: 0.0005, uiAmountString: '0.0005' },
        }],
        loadedAddresses: { writable: [], readonly: [] },
      },
    },
  };
}

function fullV0TransactionFixture() {
  const payer = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 10));
  const tokenAccount = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 11)).publicKey;
  const readonlyAccount = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 14)).publicKey;
  const mint = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 12)).publicKey.toBase58();
  const lookup = new AddressLookupTableAccount({
    key: Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 13)).publicKey,
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [tokenAccount, readonlyAccount],
    },
  });
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: GENESIS,
    instructions: [new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: readonlyAccount, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(0),
    })],
  }).compileToV0Message([lookup]);
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const signature = bs58.encode(transaction.signatures[0] ?? new Uint8Array());
  const messageHash = createHash('sha256').update(message.serialize()).digest('hex');
  const accountIndex = message.staticAccountKeys.length;
  return {
    signature,
    wallet: payer.publicKey.toBase58(),
    mint,
    messageHash,
    loadedWritable: tokenAccount.toBase58(),
    loadedReadonly: readonlyAccount.toBase58(),
    rpcTransaction: {
      slot: 501,
      blockTime: 2,
      version: 0,
      transaction: [Buffer.from(transaction.serialize()).toString('base64'), 'base64'],
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [1_000_000, 1, 0, 0],
        postBalances: [895_000, 1, 100_000, 0],
        preTokenBalances: [{
          accountIndex, mint, owner: payer.publicKey.toBase58(),
          programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
          uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
        }],
        postTokenBalances: [{
          accountIndex, mint, owner: payer.publicKey.toBase58(),
          programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
          uiTokenAmount: { amount: '500', decimals: 6, uiAmount: 0.0005, uiAmountString: '0.0005' },
        }],
        innerInstructions: [],
        logMessages: [],
        rewards: null,
        status: { Ok: null },
        loadedAddresses: {
          writable: [tokenAccount.toBase58()], readonly: [readonlyAccount.toBase58()],
        },
        returnData: null,
        computeUnitsConsumed: 123,
        costUnits: 456,
      },
    },
  };
}

function streamingFetch(
  onStart: (stream: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal) => void,
): typeof fetch {
  return async (_input, init) => {
    const fetchSignal = init?.signal;
    if (!(fetchSignal instanceof AbortSignal)) throw new TypeError('Expected abort signal.');
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) { onStart(stream, fetchSignal); },
    }));
  };
}

function oneByteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + 1));
      offset += 1;
    },
  });
}

function signal(): AbortSignal { return new AbortController().signal; }
