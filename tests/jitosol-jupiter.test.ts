import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createApproveInstruction, createCloseAccountInstruction, createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { JupiterClient, JITOSOL_MINT, SOL_MINT, JUPITER_PROGRAM_ID } from '../src/jitosol/jupiter.js';

const wallet = new PublicKey('7YttLkHDoNj9wyDur5jm1eL5w4FmhgLMkSaGSWyJb84a');
const stranger = new PublicKey('11111111111111111111111111111112');
const source = getAssociatedTokenAddressSync(SOL_MINT, wallet);
const destination = getAssociatedTokenAddressSync(JITOSOL_MINT, wallet);

// Public GET /swap/v1/quote observed 2026-10-11; no wallet or API key used.
function at<T>(items: T[], index: number): T {
  const item = items[index]; assert.ok(item !== undefined); return item;
}

function quoteFixture() {
  return {
    inputMint: SOL_MINT.toBase58(), inAmount: '3000000000',
    outputMint: JITOSOL_MINT.toBase58(), outAmount: '2299035436', otherAmountThreshold: '2296736401',
    swapMode: 'ExactIn', slippageBps: 10, platformFee: null,
    priceImpactPct: '0.0002353950170180468525841638',
    routePlan: [{ swapInfo: {
      ammKey: 'Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp', label: 'Whirlpool',
      inputMint: SOL_MINT.toBase58(), outputMint: JITOSOL_MINT.toBase58(),
      inAmount: '3000000000', outAmount: '2299035436', updateContextSlot: '455602573',
    }, percent: 100, bps: null }],
    contextSlot: 455602950, timeTaken: 0.000289303, instructionVersion: 'V1',
  };
}

function wire(instruction: TransactionInstruction) {
  return {
    programId: instruction.programId.toBase58(), data: instruction.data.toString('base64'),
    accounts: instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
      pubkey: pubkey.toBase58(), isSigner, isWritable,
    })),
  };
}

// Wire layout from official jup-ag/jupiter-amm-implementation
// jupiter/idls/jupiter_aggregator.json (route, Whirlpool, RoutePlanStep).
// This is a synthetic serialization fixture, not a captured live transaction.
function routeInstruction() {
  const data = Buffer.alloc(36);
  Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]).copy(data);
  data.writeUInt32LE(1, 8);
  Buffer.from([17, 1, 100, 0, 1]).copy(data, 12);
  data.writeBigUInt64LE(3000000000n, 17);
  data.writeBigUInt64LE(2299035436n, 25);
  data.writeUInt16LE(10, 33);
  const accounts = [TOKEN_PROGRAM_ID, wallet, source, destination, JUPITER_PROGRAM_ID, JITOSOL_MINT,
    JUPITER_PROGRAM_ID, new PublicKey('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf'), JUPITER_PROGRAM_ID,
    new PublicKey('Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp')];
  return new TransactionInstruction({
    programId: JUPITER_PROGRAM_ID, data,
    keys: accounts.map((pubkey, index) => ({ pubkey, isSigner: index === 1, isWritable: index === 2 || index === 3 })),
  });
}

function swapFixture() {
  return {
    tokenLedgerInstruction: null,
    computeBudgetInstructions: [wire(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })),
      wire(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000n }))],
    setupInstructions: [
      wire(createAssociatedTokenAccountIdempotentInstruction(wallet, source, wallet, SOL_MINT)),
      wire(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: source, lamports: 3000000000n })),
      wire(createSyncNativeInstruction(source)),
    ],
    swapInstruction: wire(routeInstruction()),
    cleanupInstruction: wire(createCloseAccountInstruction(source, wallet, wallet)),
    otherInstructions: [], addressLookupTableAddresses: [], prioritizationFeeLamports: 10000000,
    computeUnitLimit: 1000000,
  };
}

function clientFor(payload: unknown, options: ConstructorParameters<typeof JupiterClient>[0] = {}) {
  return new JupiterClient({ fetch: async () => Response.json(payload), now: () => 123456, ...options });
}

async function buildFixture(mutate?: (response: ReturnType<typeof swapFixture>) => void) {
  const quote = await clientFor(quoteFixture()).getQuote();
  const response = swapFixture();
  mutate?.(response);
  return clientFor(response).buildSwapInstructions(quote, wallet);
}

void test('quote pins SOL/JitoSOL ExactIn, direct V1 route, amount and 10bps while keeping route freshness separate', async () => {
  let requested: URL | undefined;
  let init: RequestInit | undefined;
  const client = new JupiterClient({ now: () => 123456, fetch: async (input, options) => {
    requested = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); init = options;
    return Response.json(quoteFixture());
  } });
  const quote = await client.getQuote();
  assert.equal(requested?.origin, 'https://api.jup.ag');
  assert.equal(requested?.searchParams.get('amount'), '3000000000');
  assert.equal(requested?.searchParams.get('slippageBps'), '10');
  assert.equal(requested?.searchParams.get('onlyDirectRoutes'), 'true');
  assert.equal(requested?.searchParams.get('instructionVersion'), 'V1');
  assert.equal(init?.redirect, 'error');
  assert.equal(quote.inputLamports, 3000000000n);
  assert.equal(quote.expectedOutputAtomic, 2299035436n);
  assert.equal(quote.minimumOutputAtomic, 2296736400n);
  assert.equal(quote.receivedAtMs, 123456);
  assert.equal(quote.contextSlot, 455602950);
  assert.equal(quote.routePlan[0]?.updateContextSlot, 455602573);
});

void test('quote allows missing route update slot without pretending contextSlot proves freshness', async () => {
  const fixture = quoteFixture();
  Reflect.deleteProperty(at(fixture.routePlan, 0).swapInfo, 'updateContextSlot');
  assert.equal((await clientFor(fixture).getQuote()).routePlan[0]?.updateContextSlot, null);
});

void test('quote rejects wrong mints, amount, slippage, mode, unsafe integer, stale-shape routes and malformed amounts', async () => {
  const mutations: ((quote: Record<string, any>) => void)[] = [
    (q) => { q.inputMint = stranger.toBase58(); },
    (q) => { q.outputMint = stranger.toBase58(); },
    (q) => { q.inAmount = '2999999999'; },
    (q) => { q.inAmount = 3000000000; },
    (q) => { q.slippageBps = 11; },
    (q) => { q.swapMode = 'ExactOut'; },
    (q) => { q.outAmount = '1e9'; },
    (q) => { q.outAmount = '18446744073709551616'; },
    (q) => { q.otherAmountThreshold = '2299035437'; },
    (q) => { q.otherAmountThreshold = '1'; },
    (q) => { q.contextSlot = Number.MAX_SAFE_INTEGER + 1; },
    (q) => { q.routePlan[0].swapInfo.updateContextSlot = '9007199254740992'; },
    (q) => { q.routePlan[0].swapInfo.inputMint = stranger.toBase58(); },
    (q) => { q.routePlan[0].swapInfo.inAmount = '1'; },
    (q) => { q.routePlan[0].percent = 99; },
    (q) => { q.routePlan.push(q.routePlan[0]); },
    (q) => { q.platformFee = { amount: '1', feeBps: 1 }; },
  ];
  for (const mutate of mutations) {
    const fixture = quoteFixture(); mutate(fixture);
    await assert.rejects(clientFor(fixture).getQuote(), /Jupiter/);
  }
});

void test('amount strings above Number precision are preserved when explicitly configured within ticket cap', async () => {
  const amount = 9007199254740993n;
  const fixture = quoteFixture(); fixture.inAmount = amount.toString(); at(fixture.routePlan, 0).swapInfo.inAmount = amount.toString();
  const client = clientFor(fixture, { ticketLamports: amount, maxTicketLamports: amount });
  assert.equal((await client.getQuote()).inputLamports, amount);
  assert.throws(() => new JupiterClient({ ticketLamports: amount }), /ticket/);
});

void test('swap builder binds wallet and destination, creates destination ATA and excludes remote compute fees', async () => {
  const quote = await clientFor(quoteFixture()).getQuote();
  let posted: Record<string, unknown> | undefined;
  const client = new JupiterClient({ fetch: async (_url, init) => {
    assert.equal(typeof init?.body, 'string');
    posted = JSON.parse(init?.body as string) as Record<string, unknown>;
    return Response.json(swapFixture());
  } });
  const result = await client.buildSwapInstructions(quote, wallet);
  assert.equal(posted?.userPublicKey, wallet.toBase58());
  assert.equal(posted?.destinationTokenAccount, destination.toBase58());
  assert.equal(posted?.wrapAndUnwrapSol, true);
  assert.equal(posted?.useSharedAccounts, false);
  assert.equal(posted?.dynamicSlippage, false);
  assert.equal(posted?.prioritizationFeeLamports, 0);
  assert.equal(result.destinationTokenAccount.toBase58(), destination.toBase58());
  assert.equal(result.sourceTokenAccount.toBase58(), source.toBase58());
  assert.equal(result.remotePriorityFeeLamports, 10000000n);
  assert.equal(result.remoteComputeUnitLimit, 1000000);
  assert.equal(result.setupInstructions.length, 4);
  assert.ok(result.instructions.every((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet,
    recentBlockhash: '11111111111111111111111111111111', instructions: result.instructions }).compileToV0Message());
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.ok(tx.signatures.every((signature) => signature.every((byte) => byte === 0)));
  assert.ok(tx.serialize().length > 0);
});

void test('swap rejects wrong top-level program, required cosigner and arbitrary setup token authority', async () => {
  await assert.rejects(buildFixture((r) => { r.swapInstruction.programId = stranger.toBase58(); }), /Jupiter/);
  await assert.rejects(buildFixture((r) => { r.swapInstruction.accounts.push({ pubkey: stranger.toBase58(), isSigner: true, isWritable: false }); }), /signer/);
  await assert.rejects(buildFixture((r) => { r.setupInstructions.push(wire(createApproveInstruction(source, stranger, wallet, 1n))); }), /setup/);
  await assert.rejects(buildFixture((r) => { r.otherInstructions.push(wire(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: stranger, lamports: 1n })) as never); }), /other/);
});

void test('swap rejects unrelated transfers, duplicate funding, wrong ATA owner and account creation', async () => {
  await assert.rejects(buildFixture((r) => { r.setupInstructions[1] = wire(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: stranger, lamports: 3000000000n })); }), /setup/);
  await assert.rejects(buildFixture((r) => { r.setupInstructions.push(at(r.setupInstructions, 1)); }), /funding/);
  await assert.rejects(buildFixture((r) => { at(at(r.setupInstructions, 0).accounts, 2).pubkey = stranger.toBase58(); }), /setup/);
  await assert.rejects(buildFixture((r) => { r.setupInstructions.push(wire(SystemProgram.createAccount({ fromPubkey: wallet, newAccountPubkey: stranger, lamports: 1, space: 165, programId: TOKEN_PROGRAM_ID }))); }), /signer|setup/);
  await assert.rejects(buildFixture((r) => { at(r.cleanupInstruction.accounts, 1).pubkey = stranger.toBase58(); }), /cleanup/);
});

void test('swap rejects route amount, output, slippage, fee, discriminator and destination changes', async () => {
  for (const mutate of [
    (b: Buffer) => b.writeBigUInt64LE(3000000001n, 17),
    (b: Buffer) => b.writeBigUInt64LE(2299035435n, 25),
    (b: Buffer) => b.writeUInt16LE(11, 33),
    (b: Buffer) => { b[35] = 1; },
    (b: Buffer) => { b[0] = 0; },
    (b: Buffer) => { b[12] = 255; },
  ]) {
    await assert.rejects(buildFixture((r) => { const b = Buffer.from(r.swapInstruction.data, 'base64'); mutate(b); r.swapInstruction.data = b.toString('base64'); }), /route/);
  }
  await assert.rejects(buildFixture((r) => { at(r.swapInstruction.accounts, 3).pubkey = stranger.toBase58(); }), /route/);
  await assert.rejects(buildFixture((r) => { at(r.swapInstruction.accounts, 1).isSigner = false; }), /route/);
});

void test('swap route must reference the pool whose quote freshness was checked', async () => {
  await assert.rejects(buildFixture((r) => { at(r.swapInstruction.accounts, 9).pubkey = stranger.toBase58(); }), /route/);
});

void test('official Whirlpool V2 route layout accepts no hook accounts and rejects a hidden remaining account list', async () => {
  const replaceWhirlpoolVariant = (response: ReturnType<typeof swapFixture>, present: number): void => {
    const original = Buffer.from(response.swapInstruction.data, 'base64');
    response.swapInstruction.data = Buffer.concat([original.subarray(0, 12), Buffer.from([47, 1, present]), original.subarray(14)]).toString('base64');
  };
  const result = await buildFixture((r) => { replaceWhirlpoolVariant(r, 0); });
  assert.equal(result.swapInstruction.data[12], 47);
  await assert.rejects(buildFixture((r) => { replaceWhirlpoolVariant(r, 1); }), /remaining accounts/);
});

void test('timeout also cancels a stalled response body and active caller cancellation', async () => {
  let canceled = false;
  const client = new JupiterClient({ timeoutMs: 10, fetch: async () => new Response(new ReadableStream({
    pull: () => new Promise<void>(() => {}), cancel: () => { canceled = true; },
  })) });
  await assert.rejects(client.getQuote(), /timed out/);
  assert.equal(canceled, true);
  const controller = new AbortController();
  const active = new JupiterClient({ fetch: async () => {
    controller.abort();
    return new Promise<Response>(() => {});
  } }).getQuote(controller.signal);
  await assert.rejects(active, /aborted/);
});

void test('swap rejects tampered quote metadata before any request', async () => {
  const quote = await clientFor(quoteFixture()).getQuote();
  let called = false;
  const client = new JupiterClient({ fetch: async () => { called = true; return Response.json(swapFixture()); } });
  await assert.rejects(client.buildSwapInstructions({ ...quote, minimumOutputAtomic: 1n }, wallet), /quote/);
  assert.equal(called, false);
});

void test('endpoint allowlist rejects credentials, nonHTTPS, redirects and query-bearing base URLs', async () => {
  for (const baseUrl of ['http://api.jup.ag', 'https://evil.example', 'https://secret@api.jup.ag', 'https://api.jup.ag?api-key=secret', 'https://api.jup.ag/elsewhere']) {
    assert.throws(() => new JupiterClient({ baseUrl }), /endpoint/);
  }
  const client = new JupiterClient({ apiKey: 'secret-api-key', fetch: async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'secret-api-key');
    assert.equal(init?.redirect, 'error');
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/secret-api-key' } });
  } });
  await assert.rejects(client.getQuote(), (error: Error) => error.message.includes('Jupiter') && !error.message.includes('secret-api-key') && !error.message.includes('evil.example'));
});

void test('response errors are sanitized, malformed JSON and bounded content fail closed', async () => {
  for (const response of [Response.json({ error: 'secret-api-key' }, { status: 401 }),
    new Response('{broken'), new Response('x'.repeat(2049)),
    new Response('{}', { headers: { 'content-length': '9999999999' } }), Response.json(null)]) {
    const client = new JupiterClient({ maxResponseBytes: 2048, fetch: async () => response });
    await assert.rejects(client.getQuote(), (error: Error) => error.message.includes('Jupiter') && !error.message.includes('secret-api-key'));
  }
  await assert.rejects(new JupiterClient({ fetch: async () => { throw new Error('https://api.jup.ag/?api-key=secret'); } }).getQuote(), /^Error: Jupiter request failed$/);
});

void test('request timeout and caller AbortSignal bound a stalled fetch', async () => {
  const stalled: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(new Error('sensitive underlying error')); }, { once: true });
  });
  await assert.rejects(new JupiterClient({ timeoutMs: 10, fetch: stalled }).getQuote(), /Jupiter request timed out/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new JupiterClient({ fetch: stalled }).getQuote(controller.signal), /Jupiter request aborted/);
});

void test('swap rejects malformed wire instructions and excessive lookup tables', async () => {
  await assert.rejects(buildFixture((r) => { r.swapInstruction.data = 'not base64!'; }), /instruction/);
  await assert.rejects(buildFixture((r) => { r.addressLookupTableAddresses = Array<string>(33).fill(stranger.toBase58()) as never[]; }), /lookup/);
  await assert.rejects(buildFixture((r) => { at(r.computeBudgetInstructions, 0).programId = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(); }), /compute/);
});

void test('captured public Jupiter unsigned instructions pass strict validation and compile without signing', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/jitosol/jupiter-public-unsigned.json', import.meta.url), 'utf8')) as {
    walletPublicKey: string; quote: unknown; swapInstructions: unknown;
  };
  const quote = await clientFor(fixture.quote).getQuote();
  const publicWallet = new PublicKey(fixture.walletPublicKey);
  const swap = await clientFor(fixture.swapInstructions).buildSwapInstructions(quote, publicWallet);
  assert.ok(swap.cleanupInstruction);
  const message = new TransactionMessage({ payerKey: publicWallet,
    recentBlockhash: '11111111111111111111111111111111', instructions: swap.instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  assert.equal(transaction.message.header.numRequiredSignatures, 1);
  assert.ok(transaction.signatures.every((signature) => signature.every((byte) => byte === 0)));
  assert.ok(transaction.serialize().length <= 1232);
});

void test('swap requires WSOL cleanup so source rent cannot remain outside tracked JitoSOL rent', async () => {
  const quote = await clientFor(quoteFixture()).getQuote();
  for (const cleanupInstruction of [null, undefined]) {
    await assert.rejects(clientFor({ ...swapFixture(), cleanupInstruction }).buildSwapInstructions(quote, wallet), /cleanup/);
  }
});
