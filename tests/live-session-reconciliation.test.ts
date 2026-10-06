import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { EvidenceJournal, identity, parseJournal } from '../src/telemetry/journal.js';
import { writeLiveSessionEvidenceReport } from '../scripts/report-live-session-evidence.js';
import { exportLiveSessionEvidence } from '../scripts/export-live-session-evidence.js';
import { migrateDatabase } from '../src/storage/database.js';

const wallet = '11111111111111111111111111111111';
const mint = 'TokenMint111111111111111111111111111111111';
const tokenAccount = 'TokenAccount11111111111111111111111111111';
const wsolAccount = 'WrappedSolAccount11111111111111111111111';
const refundDestination = 'RefundDestination111111111111111111111111';
const sessionId = 'offline-session-1';
const positionId = 'position-1';

void test('exports session attempts to signature index, consumes raw metadata, and keeps null RPC values unknown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'live-session-reconciliation-'));
  const source = path.join(root, 'source');
  const cache = path.join(root, 'cache');
  const reportDir = path.join(root, 'report');
  await mkdir(source);
  const orders = [
    { event: 'buy_order', sessionId, wallet, positionId, orderId: 'buy-1', side: 'BUY', orderStatus: 'CONFIRMED', signature: 'buy-signature', mint },
    { event: 'sell_order', sessionId, wallet, positionId, orderId: 'sell-1', side: 'SELL', orderStatus: 'CONFIRMED', signature: 'sell-signature', mint },
    { event: 'sell_order', sessionId, wallet, positionId, orderId: 'sell-unknown', side: 'SELL', orderStatus: 'UNKNOWN', signature: 'unknown-signature', mint },
    { event: 'buy_order', sessionId, wallet, positionId, orderId: 'buy-failed', side: 'BUY', orderStatus: 'FAILED', signature: 'failed-signature', mint },
    { event: 'account_close', sessionId, wallet, signature: 'close-signature' },
    { event: 'rpc_error', sessionId, wallet, signature: 'transport-error-signature' },
  ];
  await writeFile(path.join(source, 'session.jsonl'), `${orders.map((row) => JSON.stringify(row)).join('\n')}\n`);
  try {
    const indexed = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/collect-transaction-evidence.ts',
      '--source', source, '--out', cache, '--index-only'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(indexed.status, 0, indexed.stderr);
    const signatureIndex = parseJournal(await readFile(path.join(cache, 'signature-index.v1.jsonl'), 'utf8'));
    const buyLink = signatureIndex.find((row) => row.signature === 'buy-signature')?.links as Record<string, unknown>[];
    assert.equal(buyLink[0]?.positionId, positionId);
    assert.equal(buyLink[0]?.orderId, 'buy-1');
    assert.equal(signatureIndex.length, 6, 'all submitted signatures, including unresolved and failed attempts, are indexed');

    const journal = await EvidenceJournal.open(path.join(cache, 'transactions.v1.jsonl'));
    try {
      for (const [signature, response] of [
        ['buy-signature', transaction(10_000_000_000, 9_900_000_000, '10', '110', 5_000)],
        ['sell-signature', transaction(9_900_000_000, 9_960_000_000, '110', '50', 5_000)],
        ['unknown-signature', null],
        ['failed-signature', failedTransaction(9_960_000_000, 9_959_000_000, '50', '50', 5_000)],
        ['close-signature', closedAtaTransaction()],
        ['transport-error-signature', null],
      ] as const) {
        const params = { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 };
        await journal.append({ id: identity([signature, params]), schema: 'transaction_evidence.v1', kind: 'rpc_attempt',
          signature, links: [], parameters: params, attempt: 1, retrievedAt: 1_800_000_000_000,
          status: signature === 'transport-error-signature' ? 'RPC_ERROR'
            : response === null ? 'RPC_NULL' : hasMetaError(response) ? 'EXECUTED_WITH_ERROR' : 'RESPONSE_AVAILABLE',
          httpResponse: response, httpBodyRaw: response === null ? '{"result":null}' : JSON.stringify(response),
          httpStatus: signature === 'transport-error-signature' ? null : 200, timeoutMs: 5_000,
          transportErrorCategory: signature === 'transport-error-signature' ? 'NETWORK_ERROR' : null,
          transportErrorDetail: null,
          retryAfterRaw: null, retryAfterMs: null });
      }
    } finally { await journal.close(); }

    const report = await writeLiveSessionEvidenceReport({ sourceDirectory: source,
      transactionsFile: path.join(cache, 'transactions.v1.jsonl'), wallet, sessionId, outputDirectory: reportDir });
    const reportPositions = report.positions as Record<string, unknown>[];
    assert.equal(reportPositions[0]?.acquiredFromConfirmedSignaturesRaw, '100');
    assert.equal(reportPositions[0]?.soldFromConfirmedSignaturesRaw, '60');
    assert.equal(reportPositions[0]?.remainingFromOrderDeltasRaw, null, 'unknown sell signature prevents an invented remainder');
    assert.equal((reportPositions[0]?.quantityStatus), 'INCOMPLETE_RPC_OR_ORDER_STATUS');
    const transactions = report.transactions as Record<string, unknown>[];
    assert.equal(transactions.find((row) => row.signature === 'unknown-signature')?.status, 'RPC_NULL');
    assert.equal(transactions.find((row) => row.signature === 'unknown-signature')?.walletLamportDeltaRaw, null);
    assert.equal(transactions.find((row) => row.signature === 'transport-error-signature')?.status, 'RPC_ERROR');
    assert.equal(transactions.find((row) => row.signature === 'failed-signature')?.status, 'EXECUTED_WITH_ERROR');
    const funding = report.accountFundingAndRefunds as Record<string, unknown>;
    const lifecycle = funding.transactionLifecycleEvents as Record<string, unknown>[];
    const closed = lifecycle.find((row) => row.signature === 'close-signature');
    assert.equal(closed?.classification, 'CLOSED_DURING_TRANSACTION');
    assert.equal(closed?.refundCandidateRaw, '2039280');
    assert.equal(closed?.refundDestinationLamportDeltaRaw, '2039280');
    const cash = report.cashAndFees as Record<string, unknown>;
    assert.equal(cash.collectedWalletLamportDeltaRaw, null, 'a null response prevents a complete signature-level cash sum');
    assert.equal(cash.observedNetworkFeesRaw, null, 'missing transaction metadata does not become a zero fee');
    assert.equal(cash.wrappedSolTokenDeltaRaw, null, 'unknown transaction metadata prevents a complete wSOL delta');
    assert.equal(cash.feesSubtractedAgain, false);
    assert.equal(cash.economicResultLamportsRaw, null);
    assert.equal(cash.sessionStartBalanceRaw, null);
    const markdown = await readFile(path.join(reportDir, 'session-reconciliation.md'), 'utf8');
    assert.match(markdown, /sell-unknown[\s\S]*unknown-signature/u);
    assert.match(markdown, /NON CALCULABLE/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('read-only session export includes confirmed, failed, and signatureless durable order attempts', async (context) => {
  const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('LIVE_TEST_DATABASE_URL must point to disposable local PostgreSQL.');
    return;
  }
  const schema = `live_evidence_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const output = await mkdtemp(path.join(os.tmpdir(), 'live-evidence-export-'));
  const exportDirectory = path.join(output, 'export');
  const cacheDirectory = path.join(output, 'cache');
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrateDatabase({ pool });
    const intent = JSON.stringify({ sessionId, candidateId: 'candidate-1', mint });
    for (const [orderId, orderStatus, signature] of [
      ['order-confirmed', 'CONFIRMED', 'confirmed-signature'],
      ['order-failed', 'FAILED', 'failed-signature'],
      ['order-prepared', 'PREPARED', null],
    ] as const) {
      await pool.query(`INSERT INTO live_orders (
        order_id,wallet,position_id,side,status,signature,signed_transaction,intent,validity,created_at,updated_at
      ) VALUES ($1,$2,$3,'BUY',$4,$5,$6,$7::jsonb,'{"lastValidBlockHeight":1}'::jsonb,NOW(),NOW())`, [
        orderId, wallet, positionId, orderStatus, signature, signature === null ? null : Buffer.from([1, 2, 3]), intent,
      ]);
    }
    const result = await exportLiveSessionEvidence({ sessionId, wallet, outputDirectory: exportDirectory,
      databaseUrl, queryable: pool });
    assert.deepEqual({ orders: result.orders, signatures: result.signatures }, { orders: 3, signatures: 2 });
    const rows = (await readFile(path.join(exportDirectory, 'session.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(rows.map((row) => row.orderStatus), ['CONFIRMED', 'FAILED', 'PREPARED']);
    assert.equal(rows[2]?.signature, null, 'durable attempts with no signature remain in the export');
    assert.equal(rows.some((row) => 'signedTransaction' in row), false, 'signed bytes are never exported');

    const indexed = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/collect-transaction-evidence.ts',
      '--source', exportDirectory, '--out', cacheDirectory, '--index-only'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(indexed.status, 0, indexed.stderr);
    const rawJournal = await EvidenceJournal.open(path.join(cacheDirectory, 'transactions.v1.jsonl'));
    try {
      const params = { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 };
      for (const [signature, response] of [
        ['confirmed-signature', transaction(10_000_000_000, 9_900_000_000, '0', '100', 5_000)],
        ['failed-signature', failedTransaction(9_900_000_000, 9_899_000_000, '100', '100', 5_000)],
      ] as const) {
        await rawJournal.append({ id: identity([signature, params]), schema: 'transaction_evidence.v1', kind: 'rpc_attempt',
          signature, links: [], parameters: params, attempt: 1, retrievedAt: 1_800_000_000_000,
          status: hasMetaError(response) ? 'EXECUTED_WITH_ERROR' : 'RESPONSE_AVAILABLE',
          httpResponse: response, httpBodyRaw: JSON.stringify(response), httpStatus: 200, timeoutMs: 5_000,
          transportErrorCategory: null, transportErrorDetail: null, retryAfterRaw: null, retryAfterMs: null });
      }
    } finally { await rawJournal.close(); }
    const report = await writeLiveSessionEvidenceReport({ sourceDirectory: exportDirectory,
      transactionsFile: path.join(cacheDirectory, 'transactions.v1.jsonl'), wallet, sessionId,
      outputDirectory: path.join(output, 'report') });
    assert.equal((report.orderAttempts as Record<string, unknown>[]).length, 3);
    assert.equal((report.rpc as Record<string, unknown>).indexedSignatures, 2);
    assert.equal((report.rpc as Record<string, unknown>).transactionsWithUsableMetadata, 1);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    await rm(output, { recursive: true, force: true });
  }
});

function transaction(walletPre: number, walletPost: number, tokenPre: string, tokenPost: string, fee: number): Record<string, unknown> {
  return { result: { slot: 123, blockTime: 1_800_000_000, version: 'legacy', transaction: { message: {
    accountKeys: [wallet, tokenAccount, wsolAccount], instructions: [],
  } }, meta: { err: null, fee, preBalances: [walletPre, 2_039_280, 2_039_280],
    postBalances: [walletPost, 2_039_280, 2_039_280],
    preTokenBalances: [
      { accountIndex: 1, mint, owner: wallet, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: tokenPre, decimals: 0 } },
      { accountIndex: 2, mint: 'So11111111111111111111111111111111111111112', owner: wallet, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '1000', decimals: 9 } },
    ], postTokenBalances: [
      { accountIndex: 1, mint, owner: wallet, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: tokenPost, decimals: 0 } },
      { accountIndex: 2, mint: 'So11111111111111111111111111111111111111112', owner: wallet, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '1000', decimals: 9 } },
    ], innerInstructions: [], loadedAddresses: { writable: [], readonly: [] } } } };
}

function failedTransaction(walletPre: number, walletPost: number, tokenPre: string, tokenPost: string, fee: number): Record<string, unknown> {
  const response = transaction(walletPre, walletPost, tokenPre, tokenPost, fee);
  const result = response.result as Record<string, unknown>;
  const meta = result.meta as Record<string, unknown>;
  return { result: { ...result, meta: { ...meta, err: { InstructionError: [0, 'Custom'] } } } };
}

function hasMetaError(response: Record<string, unknown>): boolean {
  const result = response.result as Record<string, unknown>;
  const meta = result.meta as Record<string, unknown>;
  return meta.err !== null;
}

function closedAtaTransaction(): Record<string, unknown> {
  return { result: { slot: 125, blockTime: 1_800_000_000, version: 'legacy', transaction: { message: {
    accountKeys: [wallet, tokenAccount, refundDestination],
    instructions: [{ program: 'spl-token', parsed: { type: 'closeAccount', info: { account: tokenAccount, destination: refundDestination, owner: wallet } } }],
  } }, meta: { err: null, fee: 5_000, preBalances: [1_000_000, 2_039_280, 5_000_000],
    postBalances: [995_000, 0, 7_039_280], preTokenBalances: [], postTokenBalances: [], innerInstructions: [],
    loadedAddresses: { writable: [], readonly: [] } } } };
}
