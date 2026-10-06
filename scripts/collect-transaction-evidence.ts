import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { EvidenceJournal, identity } from '../src/telemetry/journal.js';
import { buildSignatureIndex, type SignatureSourceRow } from '../src/telemetry/signature-index.js';
import { collectGetTransaction } from '../src/telemetry/transaction-collector.js';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, out: { type: 'string' }, 'index-only': { type: 'boolean' },
  'budget-rpc-requests': { type: 'string' }, retries: { type: 'string' }, commitment: { type: 'string' },
  'max-supported-version': { type: 'string' }, roles: { type: 'string' }, 'expected-signatures': { type: 'string' },
} });
if (!values.source || !values.out) throw new Error('Usage: tsx scripts/collect-transaction-evidence.ts --source EVIDENCE_DIR --out NEW_DIR [--index-only | --budget-rpc-requests N]');
const positiveInteger = (value: string | undefined, name: string, max: number): number => {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`INVALID_${name}`);
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`INVALID_${name}`);
  return parsed;
};
const source = path.resolve(values.source); const out = path.resolve(values.out);
const indexOnly = values['index-only'] === true;
const budget = indexOnly ? 0 : positiveInteger(values['budget-rpc-requests'], 'RPC_BUDGET', 20);
if (!indexOnly && budget < 1) throw new Error('RPC_BUDGET_MUST_BE_POSITIVE');
const retries = values.retries === undefined ? 1 : positiveInteger(values.retries, 'RETRIES', 3);
const maxVersion = values['max-supported-version'] === undefined ? 0 : positiveInteger(values['max-supported-version'], 'MAX_SUPPORTED_VERSION', 10);
const commitment = values.commitment ?? 'finalized';
if (!['confirmed', 'finalized'].includes(commitment)) throw new Error('INVALID_COMMITMENT');
const roles = values.roles === 'all' ? null : new Set((values.roles ?? 'BUY,SELL,OTHER_TRANSACTION').split(',').filter(Boolean));
if (roles !== null && [...roles].some(role => !['BUY', 'SELL', 'TOKEN_CREATE', 'MARKET_ACTIVITY', 'OTHER_TRANSACTION'].includes(role))) throw new Error('INVALID_ROLES');
const expectedSignatures = values['expected-signatures'] === undefined ? null : positiveInteger(values['expected-signatures'], 'EXPECTED_SIGNATURES', 20);
let rpcEndpoint: URL | null = null;
if (!indexOnly) {
  const rawEndpoint = process.env.SOLANA_HTTP_RPC_URL;
  if (!rawEndpoint) throw new Error('SOLANA_HTTP_RPC_URL_REQUIRED');
  try { rpcEndpoint = new URL(rawEndpoint); } catch { throw new Error('SOLANA_HTTP_RPC_URL_INVALID'); }
  if (rpcEndpoint.protocol !== 'https:') throw new Error('RPC_TLS_REQUIRED');
}

async function parseRows(file: string): Promise<Record<string, unknown>[]> {
  let text: string; try { text = await readFile(file, 'utf8'); } catch { return []; }
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).flatMap(line => {
    try { const row: unknown = JSON.parse(line); return typeof row === 'object' && row !== null && !Array.isArray(row) ? [row as Record<string, unknown>] : []; }
    catch { return []; }
  });
}

const sourceRows: SignatureSourceRow[] = [];
const dirs = (await readdir(source, { withFileTypes: true })).filter(x => x.isDirectory() && /^wave-\d+$/.test(x.name)).sort((a,b) => a.name.localeCompare(b.name));
for (const dir of dirs) {
  const wave = Number(dir.name.slice(5));
  for (const name of ['canary.jsonl', 'sniff.jsonl', 'activity.jsonl']) {
    const relativePath = `${dir.name}/${name}`;
    const rows = await parseRows(path.join(source, relativePath));
    const canaryMint = name === 'canary.jsonl' ? rows.find(row => row.event === 'preflight')?.mint : undefined;
    for (const row of rows) {
      if (typeof row.event !== 'string') continue;
      sourceRows.push({ relativePath, wave, event: row.event, signature: row.signature, mint: row.mint ?? canaryMint });
    }
  }
}
const statusRows = await parseRows(path.join(source, 'session.jsonl'));
for (const row of statusRows) {
  if (row.event === 'trade_started' && typeof row.mint === 'string') continue;
  if (typeof row.signature === 'string') sourceRows.push({ relativePath: 'session.jsonl', wave: Number(row.wave ?? 0),
    event: String(row.event ?? 'session_event'), signature: row.signature, mint: row.mint,
    ...(typeof row.positionId === 'string' ? { positionId: row.positionId } : {}),
    ...(typeof row.orderId === 'string' ? { orderId: row.orderId } : {}),
    ...(row.side === 'BUY' || row.side === 'SELL' ? { side: row.side } : {}),
    ...(typeof row.orderStatus === 'string' ? { orderStatus: row.orderStatus } : {}) });
}
try {
  const status = JSON.parse(await readFile(path.join(source, 'status.json'), 'utf8')) as Record<string, unknown>;
  if (Array.isArray(status.trades)) for (const item of status.trades) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>; const wave = Number(row.wave ?? 0); const mint = row.mint;
    for (const [field, event] of [['buySignature', 'status_buy_link'], ['sellSignature', 'status_sell_link']] as const) {
      if (typeof row[field] === 'string') sourceRows.push({ relativePath: 'status.json', wave, event, signature: row[field], mint });
    }
  }
} catch { /* status snapshot is optional; canary evidence remains authoritative */ }
const index = buildSignatureIndex(sourceRows);
const collectionIndex = roles === null ? index : index.filter(item => item.links.some(link => roles.has(link.role)));
if (!indexOnly && expectedSignatures !== null && collectionIndex.length !== expectedSignatures) throw new Error('UNEXPECTED_SIGNATURE_COUNT');
await (await import('node:fs/promises')).mkdir(out, { recursive: true, mode: 0o700 });
const indexJournal = await EvidenceJournal.open(path.join(out, 'signature-index.v1.jsonl'));
for (const row of index) await indexJournal.append({ id: identity(row), schema: 'transaction_evidence.v1', kind: 'signature_index', ...row });
await indexJournal.close();
if (indexOnly) {
  const emptyRpcJournal = await EvidenceJournal.open(path.join(out, 'transactions.v1.jsonl'));
  await emptyRpcJournal.close();
  console.log(JSON.stringify({ event: 'signature_index_built', signatures: index.length, rpcRequests: 0, output: 'signature-index.v1.jsonl' }));
  process.exit(0);
}
const rpcJournal = await EvidenceJournal.open(path.join(out, 'transactions.v1.jsonl'));
const resultJournal = await EvidenceJournal.open(path.join(out, 'collection-results.v1.jsonl'));
const requestParams = { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: maxVersion };
const attemptsBySignature = new Map<string, Record<string, unknown>[]>();
for (const row of rpcJournal.rows) {
  if (row.kind !== 'rpc_attempt' || typeof row.signature !== 'string') continue;
  attemptsBySignature.set(row.signature, [...(attemptsBySignature.get(row.signature) ?? []), row]);
}
const budgetState = { limit: budget, used: 0 }; let cacheHits = 0; let retriesUsed = 0; let haltedReason: string | null = null;
const finalResults = new Map<string, { status: string; attempts: number; retrievedAt: number | null }>();
let nextRequestAt = 0; let retryAfterUntil = 0;
const parseRetryAfter = (value: string | null, now: number): number | null => {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - now) : null;
};
const transient = (row: Record<string, unknown>): boolean => {
  const category = String(row.transportErrorCategory ?? '');
  if (category === 'TIMEOUT' || category === 'NETWORK_ERROR' || category === 'HTTP_429' || /^HTTP_5\d\d$/.test(category)) return true;
  const error = (row.httpResponse as Record<string, unknown> | null)?.error as Record<string, unknown> | undefined;
  return error?.code === -32005 || error?.code === -32004 || /rate limit|too many requests|node is behind|temporarily unavailable/i.test(String(error?.message ?? ''));
};
const collectOne = async (item: typeof collectionIndex[number], attempts: Record<string, unknown>[]) => {
  const result = await collectGetTransaction({ signature: item.signature, links: item.links, params: requestParams, existingAttempts: attempts,
    retries: 0, budget: budgetState, requestTimeoutMs: 15_000, attemptStartNumber: attempts.length + 1,
    request: async () => {
      const earliest = Math.max(nextRequestAt, retryAfterUntil);
      if (Date.now() < earliest) await sleep(earliest - Date.now());
      const requestedAt = Date.now(); nextRequestAt = requestedAt + 1000;
      const response = await fetch(rpcEndpoint as URL, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: budgetState.used, method: 'getTransaction', params: [item.signature, requestParams] }),
        signal: AbortSignal.timeout(15000) });
      const body = await response.text(); const retryAfterRaw = response.headers.get('retry-after');
      const retryAfterMs = parseRetryAfter(retryAfterRaw, Date.now());
      if (response.status === 429 && retryAfterMs !== null) retryAfterUntil = Math.max(retryAfterUntil, Date.now() + retryAfterMs);
      let httpResponse: unknown = null; let transportErrorCategory: string | null = null;
      try { httpResponse = JSON.parse(body); } catch { transportErrorCategory = `HTTP_${response.status}_INVALID_JSON`; }
      if (response.status === 401 || response.status === 403) transportErrorCategory = `HTTP_${response.status}_ACCESS_REFUSED`;
      else if (response.status === 429) transportErrorCategory = 'HTTP_429';
      else if (response.status >= 500) transportErrorCategory = `HTTP_${response.status}`;
      else if (!response.ok && transportErrorCategory === null) transportErrorCategory = `HTTP_${response.status}`;
      return { response: httpResponse, rawBody: body, httpStatus: response.status, transportErrorCategory,
        retryAfterRaw, retryAfterMs, halt: response.status === 401 || response.status === 403 };
    },
    append: async row => { await rpcJournal.append({ ...row, id: identity([row.signature, row.parameters, row.attempt, row.retrievedAt]) }); },
  });
  if (result.cacheHit) cacheHits++;
  const attemptCount = rpcJournal.rows.filter(row => row.kind === 'rpc_attempt' && row.signature === item.signature
    && JSON.stringify(row.parameters) === JSON.stringify(requestParams)).length;
  finalResults.set(item.signature, { status: result.status, attempts: attemptCount, retrievedAt: result.retrievedAt });
  await resultJournal.append({ id: identity([item.signature, requestParams, result.status, result.retrievedAt]), schema: 'transaction_evidence.v1',
    kind: 'collection_result', signature: item.signature, links: item.links, parameters: requestParams,
    status: result.status, attempts: attemptCount, retrievedAt: result.retrievedAt });
  if (result.halted) haltedReason = String(rpcJournal.rows.filter(row => row.kind === 'rpc_attempt' && row.signature === item.signature).at(-1)?.transportErrorCategory ?? 'ACCESS_REFUSED');
  return { result, attemptCount };
};
try {
  // First pass gives every requested signature one chance before any retry.
  for (const item of collectionIndex) {
    const previous = attemptsBySignature.get(item.signature) ?? [];
    await collectOne(item, previous);
    if (haltedReason !== null || budgetState.used >= budgetState.limit) break;
  }
  // Only known transient failures are retried, one at a time, after the initial sweep.
  if (haltedReason === null && retries > 0 && budgetState.used < budgetState.limit) {
    for (const item of collectionIndex) {
      const attempts = rpcJournal.rows.filter(row => row.kind === 'rpc_attempt' && row.signature === item.signature
        && JSON.stringify(row.parameters) === JSON.stringify(requestParams));
      if (attempts.length === 0 || attempts.length > retries || !transient(attempts.at(-1) ?? {})) continue;
      await collectOne(item, attempts);
      retriesUsed++;
      if (haltedReason !== null || budgetState.used >= budgetState.limit) break;
    }
  }
  const counts = new Map<string, number>(); for (const value of finalResults.values()) counts.set(value.status, (counts.get(value.status) ?? 0) + 1);
  const summary = { id: identity(['collection_summary', requestParams, budgetState.used, Date.now()]), schema: 'transaction_evidence.v1', kind: 'collection_summary',
    completedAt: Date.now(), parameters: requestParams, roles: roles === null ? 'all' : [...roles], signatureCount: collectionIndex.length, rpcRequests: budgetState.used, rpcBudget: budget,
    cacheHits, retriesUsed, haltedReason, statuses: Object.fromEntries(counts) };
  await resultJournal.append(summary);
  console.log(JSON.stringify({ event: 'transaction_collection_finished', signatureCount: collectionIndex.length, rpcRequests: budgetState.used, rpcBudget: budget,
    cacheHits, retriesUsed, haltedReason, statuses: Object.fromEntries(counts) }));
} catch {
  console.error('TRANSACTION_EVIDENCE_COLLECTION_FAILED: inspect local output permissions and RPC availability; no signing or transaction submission is implemented.');
  process.exitCode = 1;
} finally { await rpcJournal.close(); await resultJournal.close(); }
