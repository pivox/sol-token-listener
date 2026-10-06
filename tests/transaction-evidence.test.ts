import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRpcTransaction, reconcileSession, reconcileTransaction } from '../src/telemetry/transaction-evidence.js';
import { evaluateQuoteAtDecision } from '../src/telemetry/causal-quote.js';
import { buildSignatureIndex } from '../src/telemetry/signature-index.js';
import { collectGetTransaction, type RpcAttemptRecord } from '../src/telemetry/transaction-collector.js';

const wallet = 'Wallet1111111111111111111111111111111111';
const ata = 'Ata1111111111111111111111111111111111111';
const wsol = 'Wsol111111111111111111111111111111111111';
const outside = 'Outside1111111111111111111111111111111111';
const positionMint = 'Mint1111111111111111111111111111111111111';
const wsolMint = 'So11111111111111111111111111111111111111112';
const tokenProgram = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const rpc = (result: unknown): { result: unknown } => ({ result });

function tx(overrides: Record<string, unknown> = {}): any {
  return {
    slot: 99, blockTime: 1234, version: 0,
    transaction: { message: { accountKeys: [wallet, ata, wsol, outside], instructions: [
      { program: 'system', parsed: { type: 'createAccount', info: { source: wallet, newAccount: ata, lamports: 100 } } },
      { program: 'spl-token-2022', parsed: { type: 'transferChecked', info: { source: ata, destination: outside, authority: wallet, mint: positionMint, tokenAmount: { amount: '30', decimals: 6 } } } },
    ] } },
    meta: {
      err: null, fee: 10, preBalances: [1000, 0, 100, 50], postBalances: [890, 100, 100, 50],
      preTokenBalances: [
        { accountIndex: 2, mint: wsolMint, owner: wallet, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '50', decimals: 9 } },
        { accountIndex: 1, mint: positionMint, owner: wallet, programId: tokenProgram, uiTokenAmount: { amount: '0', decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: wsolMint, owner: wallet, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '20', decimals: 9 } },
        { accountIndex: 1, mint: positionMint, owner: wallet, programId: tokenProgram, uiTokenAmount: { amount: '30', decimals: 6 } },
      ],
    },
    ...overrides,
  };
}

void test('net wallet change already includes network fee; fee is disclosed without a second deduction', () => {
  const result = reconcileTransaction('buy-signature', rpc(tx()), wallet);
  assert.equal(result.status, 'RESPONSE_AVAILABLE');
  assert.equal(result.walletLamportDeltaRaw, '-110');
  assert.equal(result.networkFeeRaw, '10');
  assert.equal(result.networkFeeIncludedInWalletDelta, true);
  const ledger = reconcileSession({ wallet, walletStartLamportsRaw: '1000', walletEndLamportsRaw: '890', transactions: [result], externalFlowCoverage: 'COMPLETE', trackedAccounts: [{ address: ata, startLamportsRaw: '0', endLamportsRaw: '100', lifecycle: 'CREATED_DURING_SESSION' }], residualPositionValueRaw: '30' });
  assert.equal(ledger.economicNetRaw, '20'); // -110 cash +100 ATA +30 residual; fee is already inside cash.
});

void test('pre-existing ATA is not misreported as session-created rent', () => {
  const existing = tx({ meta: { ...tx().meta, preBalances: [1000, 100, 100, 50], postBalances: [990, 100, 100, 50] } });
  const result = reconcileTransaction('buy-existing', rpc(existing), wallet);
  assert.equal(result.accountLifecycles.find(x => x.address === ata)?.classification, 'PREEXISTING');
  const ledger = reconcileSession({ wallet, walletStartLamportsRaw: '1000', walletEndLamportsRaw: '990', transactions: [result], externalFlowCoverage: 'COMPLETE', trackedAccounts: [{ address: ata, startLamportsRaw: '100', endLamportsRaw: '100', lifecycle: 'PREEXISTING' }], residualPositionValueRaw: null });
  assert.equal(ledger.immobilizedDeltaRaw, '0');
  assert.equal(ledger.economicNetRaw, null); // missing position value remains unknown.
});

void test('ATA refund is included in wallet cash and offsets released immobilized funds once', () => {
  const close = tx({ transaction: { message: { accountKeys: [wallet, ata], instructions: [
    { program: 'spl-token-2022', parsed: { type: 'closeAccount', info: { account: ata, destination: wallet, owner: wallet } } },
  ] } }, meta: { err: null, fee: 10, preBalances: [800, 100], postBalances: [890, 0], preTokenBalances: [], postTokenBalances: [] } });
  const result = reconcileTransaction('close-signature', rpc(close), wallet);
  assert.equal(result.walletLamportDeltaRaw, '90');
  assert.deepEqual(result.accountLifecycles.find(x => x.address === ata), { address: ata, classification: 'CLOSED_DURING_TRANSACTION', startLamportsRaw: '100', endLamportsRaw: '0', closeDestination: wallet, closeAuthority: wallet });
  const ledger = reconcileSession({ wallet, walletStartLamportsRaw: '800', walletEndLamportsRaw: '890', transactions: [result], externalFlowCoverage: 'COMPLETE', trackedAccounts: [{ address: ata, startLamportsRaw: '100', endLamportsRaw: '0', lifecycle: 'CLOSED_DURING_SESSION' }], residualPositionValueRaw: '0' });
  assert.equal(ledger.immobilizedDeltaRaw, '-100');
  assert.equal(ledger.economicNetRaw, '-10'); // +90 wallet and -100 account; fee is the only loss.
});

void test('wrapped SOL token movement remains a token movement, separate from wallet lamports', () => {
  const result = reconcileTransaction('wsol-signature', rpc(tx()), wallet);
  assert.equal(result.walletLamportDeltaRaw, '-110');
  assert.deepEqual(result.tokenChanges.find(x => x.mint === wsolMint)?.deltaRaw, '-30');
  assert.equal(result.tokenChanges.find(x => x.mint === wsolMint)?.assetClass, 'WRAPPED_SOL');
});

void test('missing RPC response and missing metadata stay distinct from zero or success', () => {
  assert.equal(classifyRpcTransaction(null).status, 'RPC_NULL');
  assert.equal(classifyRpcTransaction({ result: null }).status, 'RPC_NULL');
  assert.equal(classifyRpcTransaction({ result: { slot: 1, transaction: {} } }).status, 'METADATA_ABSENT');
  assert.equal(classifyRpcTransaction({ error: { code: -32602, message: 'unsupported transaction version' } }).status, 'VERSION_UNSUPPORTED');
  const failed = reconcileTransaction('failed-signature', rpc(tx({ meta: { ...tx().meta, err: { InstructionError: [0, 'Custom'] } } })), wallet);
  assert.equal(failed.status, 'EXECUTED_WITH_ERROR');
  assert.equal(failed.walletLamportDeltaRaw, '-110');
});

void test('v0 transaction resolves lookup table accounts for balance and fee payer attribution', () => {
  const versioned = tx({ transaction: { message: { accountKeys: [wallet], instructions: [] } }, meta: { err: null, fee: 10,
    loadedAddresses: { writable: [ata], readonly: [outside] }, preBalances: [1000, 0, 50], postBalances: [990, 100, 50], preTokenBalances: [], postTokenBalances: [] } });
  const result = reconcileTransaction('v0-signature', rpc(versioned), wallet);
  assert.equal(result.accountResolution, 'RESOLVED_WITH_LOADED_ADDRESSES');
  assert.equal(result.feePayer, wallet);
  assert.equal(result.accounts.find(x => x.address === ata)?.lamportDeltaRaw, '100');
});

void test('future state reception or quote calculation cannot be used for a past decision', () => {
  assert.deepEqual(evaluateQuoteAtDecision({ decisionAtMs: 4000, stateReceivedAtMs: 3500, stateSlot: '20', quoteCalculatedAtMs: 5000, maxAgeMs: 1000, validity: 'VALID' }), { evaluable: false, reason: 'FUTURE_QUOTE' });
  assert.deepEqual(evaluateQuoteAtDecision({ decisionAtMs: 4000, stateReceivedAtMs: 4500, stateSlot: '20', quoteCalculatedAtMs: 3900, maxAgeMs: 1000, validity: 'VALID' }), { evaluable: false, reason: 'FUTURE_STATE' });
});

void test('unreviewed wallet transfer is not assumed external; reviewed external flow is removed once', () => {
  const transfer = rpc({ ...tx({ transaction: { message: { accountKeys: [wallet, outside], instructions: [
    { program: 'system', parsed: { type: 'transfer', info: { source: wallet, destination: outside, lamports: 100 } } },
  ] } }, meta: { err: null, fee: 10, preBalances: [1000, 0], postBalances: [890, 0], preTokenBalances: [], postTokenBalances: [] } }) });
  const result = reconcileTransaction('transfer-signature', transfer, wallet);
  const base = { wallet, walletStartLamportsRaw: '1000', walletEndLamportsRaw: '890', transactions: [result], externalFlowCoverage: 'COMPLETE' as const, trackedAccounts: [], residualPositionValueRaw: '0' };
  const unreviewed = reconcileSession(base);
  assert.equal(unreviewed.externalWalletFlowRaw, null);
  assert.equal(unreviewed.economicNetRaw, null);
  assert.equal(unreviewed.externalTransferCandidates.length, 1);
  const reviewed = reconcileSession({ ...base, movementReviews: [{ signature: 'transfer-signature', location: 'outer:0', classification: 'UNRELATED_EXTERNAL' }] });
  assert.equal(reviewed.externalWalletFlowRaw, '-100');
  assert.equal(reviewed.economicNetRaw, '-10');
});

void test('signature inventory deduplicates signatures but preserves position and source links', () => {
  const rows = [
    { relativePath: 'wave-001/canary.jsonl', wave: 1, event: 'buy_submitted', signature: 'sig-buy', mint: positionMint },
    { relativePath: 'wave-001/canary.jsonl', wave: 1, event: 'buy_confirmed', signature: 'sig-buy', mint: positionMint },
    { relativePath: 'status.json', wave: 1, event: 'status_buy_link', signature: 'sig-buy', mint: positionMint },
    { relativePath: 'wave-001/sniff.jsonl', wave: 1, event: 'pumpfun_create', signature: 'sig-create', mint: positionMint },
    { relativePath: 'wave-001/activity.jsonl', wave: 1, event: 'trade', signature: 'sig-market', mint: positionMint },
  ];
  const index = buildSignatureIndex(rows);
  assert.equal(index.length, 3);
  assert.equal(index.find(x => x.signature === 'sig-buy')?.links.length, 3);
  assert.ok(index.find(x => x.signature === 'sig-buy')?.links.every(link => link.role === 'BUY'));
  assert.equal(index.find(x => x.signature === 'sig-create')?.links[0]?.role, 'TOKEN_CREATE');
  assert.equal(index.find(x => x.signature === 'sig-market')?.links[0]?.role, 'MARKET_ACTIVITY');
});

void test('RPC fetch reuses definitive cached response and obeys a hard request budget', async () => {
  const params = { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 };
  const cacheRow: any = { signature: 'sig', parameters: params, status: 'RESPONSE_AVAILABLE', httpResponse: { result: { meta: { err: null } } } };
  let calls = 0;
  const cached = await collectGetTransaction({ signature: 'sig', links: [], params, existingAttempts: [cacheRow], retries: 2,
    budget: { limit: 1, used: 0 }, request: async () => { calls++; return { response: null }; }, append: async () => undefined });
  assert.equal(cached.cacheHit, true);
  assert.equal(calls, 0);
  const rows: RpcAttemptRecord[] = [];
    const bounded = await collectGetTransaction({ signature: 'other', links: [], params, existingAttempts: [], retries: 3,
    budget: { limit: 2, used: 0 }, request: async () => { calls++; return { response: null, rawBody: 'network-failure', transportErrorCategory: 'NETWORK_ERROR' }; },
    append: async row => { rows.push(row); } });
  assert.equal(bounded.attempts, 2);
  assert.equal(bounded.status, 'RPC_ERROR');
  assert.equal(calls, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.httpBodyRaw, 'network-failure');
  assert.deepEqual(rows.map(row => row.attempt), [1, 2]);

  const refusedRows: RpcAttemptRecord[] = [];
  const refused = await collectGetTransaction({ signature: 'refused', links: [], params, existingAttempts: [], retries: 1,
    budget: { limit: 5, used: 0 }, request: async () => ({ response: { error: { code: 403, message: 'forbidden' } },
      transportErrorCategory: 'HTTP_403_ACCESS_REFUSED', halt: true }), append: async row => { refusedRows.push(row); } });
  assert.equal(refused.halted, true);
  assert.equal(refused.attempts, 1);
  assert.equal(refusedRows.length, 1);
  assert.equal(refusedRows[0]?.transportErrorCategory, 'HTTP_403_ACCESS_REFUSED');
});

void test('RPC retries retain global attempt ordinals and stop on transport access refusal', async () => {
  const params = { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 };
  const rows: RpcAttemptRecord[] = [];
  let calls = 0;
  const result = await collectGetTransaction({ signature: 'safe-signature', links: [], params, existingAttempts: [],
    retries: 2, attemptStartNumber: 2, budget: { limit: 3, used: 0 },
    request: async () => { calls++; throw Object.assign(new Error('network unavailable'), { cause: { code: 'EACCES' } }); },
    append: async row => { rows.push(row); } });
  assert.equal(calls, 1);
  assert.equal(result.halted, true);
  assert.equal(result.status, 'RPC_ERROR');
  assert.deepEqual(rows.map(row => row.attempt), [2]);
  assert.equal(rows[0]?.transportErrorCategory, 'NETWORK_ACCESS_REFUSED_EACCES');
  assert.match(rows[0]?.transportErrorDetail ?? '', /cause.code=EACCES/u);
});

void test('transport diagnostics retain useful cause and timeout while redacting endpoint credentials', async () => {
  const rows: RpcAttemptRecord[] = [];
  const endpointSecret = 'FAKE_RPC_SECRET_47f9';
  const failure = Object.assign(new Error(`fetch failed https://rpc.invalid/?api-key=${endpointSecret}`), {
    cause: Object.assign(new Error(`connect ECONNREFUSED https://rpc.invalid/?api-key=${endpointSecret}`), {
      code: 'ECONNREFUSED',
    }),
  });
  await collectGetTransaction({ signature: 'sig', links: [], params: {}, existingAttempts: [], retries: 0,
    requestTimeoutMs: 12_000, budget: { limit: 1, used: 0 }, request: async () => { throw failure; },
    append: async row => { rows.push(row); } });
  assert.equal(rows[0]?.transportErrorCategory, 'NETWORK_ACCESS_REFUSED_ECONNREFUSED');
  assert.equal(rows[0]?.timeoutMs, 12_000);
  assert.equal(rows[0]?.httpStatus, null);
  assert.match(rows[0]?.transportErrorDetail ?? '', /ECONNREFUSED/u);
  assert.match(rows[0]?.transportErrorDetail ?? '', /connect/u);
  assert.doesNotMatch(rows[0]?.transportErrorDetail ?? '', new RegExp(endpointSecret, 'u'));
});

void test('timeout remains a transport timeout with its configured duration and no fabricated HTTP status', async () => {
  const rows: RpcAttemptRecord[] = [];
  const failure = Object.assign(new Error('request timed out'), { name: 'TimeoutError', cause: { code: 'ETIMEDOUT' } });
  await collectGetTransaction({ signature: 'sig', links: [], params: {}, existingAttempts: [], retries: 0,
    requestTimeoutMs: 15_000, budget: { limit: 1, used: 0 }, request: async () => { throw failure; },
    append: async row => { rows.push(row); } });
  assert.equal(rows[0]?.transportErrorCategory, 'TIMEOUT');
  assert.equal(rows[0]?.timeoutMs, 15_000);
  assert.equal(rows[0]?.httpStatus, null);
  assert.match(rows[0]?.transportErrorDetail ?? '', /TimeoutError/u);
  assert.match(rows[0]?.transportErrorDetail ?? '', /cause.code=ETIMEDOUT/u);
});

void test('JSON-RPC diagnostics redact credentialized URLs in error messages and stored raw response text', async () => {
  const rows: RpcAttemptRecord[] = [];
  const sentinel = 'FAKE_RPC_MESSAGE_SECRET_47f9';
  const body = JSON.stringify({ error: { code: -32000, message: `provider rejected https://rpc.invalid/?api-key=${sentinel}` } });
  await collectGetTransaction({ signature: 'sig', links: [], params: {}, existingAttempts: [], retries: 0,
    budget: { limit: 1, used: 0 }, request: async () => ({ response: JSON.parse(body) as unknown, rawBody: body, httpStatus: 200 }),
    append: async row => { rows.push(row); } });
  assert.equal(rows[0]?.status, 'RPC_ERROR');
  assert.equal(rows[0]?.httpStatus, 200);
  assert.doesNotMatch(JSON.stringify(rows[0]?.httpResponse), new RegExp(sentinel, 'u'));
  assert.doesNotMatch(rows[0]?.httpBodyRaw ?? '', new RegExp(sentinel, 'u'));
  assert.match(rows[0]?.httpBodyRaw ?? '', /\[REDACTED\]/u);
});
