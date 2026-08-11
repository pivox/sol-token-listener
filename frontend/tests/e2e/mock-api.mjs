import { createServer } from 'node:http';

const MINT = '11111111111111111111111111111111';
const SECOND_MINT = '22222222222222222222222222222222';
const QUOTE = 'So11111111111111111111111111111111111111112';
const NOW = '2026-08-11T00:00:00.000Z';
const scores = { preparation: { score: 12, maximum: 15 }, socialAuthenticity: { score: 17, maximum: 25 }, onchainHealth: { score: 43, maximum: 60 }, total: { score: 72, maximum: 100 } };
const summary = (mint, name) => ({ mint, detectedAt: NOW, detectedSlot: '100', status: 'WATCHLISTED', name, symbol: 'SYN', quoteMint: QUOTE, quoteDecimals: 9, marketCapQuote: null, liquidityQuote: '120000000', qualificationSummary: { verdict: 'WATCHLISTED', scores, blockerCodes: ['SHARED_FUNDER_CLUSTER'], evaluatedAt: NOW }, candidate: null, paperStrategy: null });
const social = { status: 'NOT_AVAILABLE', links: [], evidence: [] };
const holders = { status: 'NOT_AVAILABLE', snapshots: [], positions: [], clusters: [], clusterAnalysisStatus: 'NOT_AVAILABLE' };
const detail = (launch) => ({ ...launch, creator: MINT, tokenProgram: 'SPL_TOKEN', launchpad: 'PUMP_FUN', initialTokenAmount: '1000', initialQuoteAmount: '100', reserveBase: '2000', reserveQuote: '200', feeBps: '100', social, holders });
const risk = { ruleSet: { id: 'pumpfun-v1-initial', version: 1, status: 'UNVALIDATED_RULE_SET', minimumTotalScore: 60, fingerprint: null }, scores, evidence: [], conditions: [{ code: 'SHARED_FUNDER_CLUSTER', mode: 'ENFORCED', status: 'TRIGGERED', observed: {}, thresholds: {}, message: 'Cluster partagé.' }], blockers: [{ code: 'SHARED_FUNDER_CLUSTER', message: 'Condition active.' }], verdict: 'REJECTED', evaluatedAt: NOW };
const paper = { id: 'position-a', mint: MINT, status: 'PAPER_CLOSED', openedAt: NOW, closedAt: NOW, quoteMint: QUOTE, quantity: '1000', entryQuoteAmount: '100', exitQuoteAmount: '120', realizedPnlQuote: '19', estimatedFeesQuote: '1', strategyId: 'validated-external-buys', strategyVersion: 1, strategySessionId: null, qualificationReportId: null, candidateId: null, externalBuyCount: 10, externalBuyTarget: 10, entryVenue: 'PUMP_FUN_BONDING_CURVE', reasonCodes: ['EXTERNAL_BUY_TARGET_REACHED'] };
const health = { status: 'OK', observedAt: NOW, postgresql: { status: 'AVAILABLE' }, http: { status: 'AVAILABLE' }, pipeline: { pumpfun: 'RUNNING', pumpswap: 'RUNNING', paperDecision: 'RUNNING', social: 'RUNNING' }, socialJobs: { pendingCount: 0, leasedCount: 0, retryableFailedCount: 0, exhaustedCount: 0 }, paperDecisionJobs: { pendingCount: 0, leasedCount: 0, retryableFailedCount: 0, exhaustedCount: 0, lastSuccessAt: NOW, lastErrorCode: null }, checkpoints: { launchpad: '100', market: '100' }, heartbeat: { startedAt: NOW, updatedAt: NOW, lastHttpSlot: '100', lastWebsocketSlot: '100', lastFinalizedSlot: '100', lastSignature: null, pendingTransactions: 0, activeSessions: 0 }, lagSlots: '0' };

let launches = [summary(MINT, 'Synthetic token')];
let sequence = 0;
let expireNextCursor = false;
let resyncDelay = false;
const streams = new Set();
const requests = [];
const envelope = (data) => JSON.stringify({ apiVersion: 'v1', meta: { generatedAt: NOW, nextCursor: null }, data });

function cors(response) {
  response.setHeader('access-control-allow-origin', 'http://127.0.0.1:4173');
  response.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  response.setHeader('access-control-allow-headers', 'Last-Event-ID');
}
function json(response, status, value) {
  cors(response); response.writeHead(status, { 'content-type': 'application/json' }); response.end(typeof value === 'string' ? value : JSON.stringify(value));
}
function eventFor(mint) {
  return { eventId: `event-${sequence}`, type: 'QualificationUpdated', mint, source: 'mock', program: 'pumpfun', signature: `signature-${sequence}`, cursor: { slot: String(100 + sequence), transactionIndex: '0', instructionIndex: '0', innerInstructionIndex: null }, confirmationStatus: 'confirmed', blockchainTime: NOW, observedAt: NOW, payloadVersion: 1, payload: { verdict: 'WATCHLISTED' } };
}
function broadcast(mint) {
  sequence += 1; const event = eventFor(mint); const frame = `id: cursor-${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const stream of streams) stream.write(frame);
}
function closeStreams() { for (const stream of streams) stream.end(); streams.clear(); }

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:3000');
  if (request.headers.origin === 'http://127.0.0.1:4173') requests.push({ method: request.method, path: url.pathname, lastEventId: request.headers['last-event-id'] ?? null });
  if (request.method === 'OPTIONS') { cors(response); response.writeHead(204); response.end(); return; }
  if (url.pathname === '/__test/ready') { json(response, 200, { ready: true }); return; }
  if (url.pathname === '/__test/add-launch' && request.method === 'POST') { if (!launches.some((item) => item.mint === SECOND_MINT)) launches = [...launches, summary(SECOND_MINT, 'Second token')]; broadcast(SECOND_MINT); json(response, 200, { ok: true }); return; }
  if (url.pathname === '/__test/reconnect' && request.method === 'POST') { closeStreams(); json(response, 200, { ok: true }); return; }
  if (url.pathname === '/__test/expire' && request.method === 'POST') {
    expireNextCursor = true; resyncDelay = true; closeStreams();
    // Also catches a reconnect GET that was accepted just before this control call.
    setTimeout(closeStreams, 100);
    json(response, 200, { ok: true }); return;
  }
  if (url.pathname === '/__test/requests') { json(response, 200, { requests }); return; }
  if (url.pathname === '/api/v1/events') {
    cors(response);
    if (expireNextCursor && request.headers['last-event-id']) { expireNextCursor = false; json(response, 409, { apiVersion: 'v1', error: { code: 'EVENT_CURSOR_EXPIRED', message: 'expired' } }); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }); response.write(': connected\n\n'); streams.add(response); response.on('close', () => streams.delete(response)); return;
  }
  if (resyncDelay && url.pathname.startsWith('/api/v1/')) { await new Promise((resolve) => setTimeout(resolve, 350)); resyncDelay = false; }
  if (url.pathname === '/api/v1/launches') { json(response, 200, envelope(launches)); return; }
  const match = /^\/api\/v1\/launches\/([^/]+)(?:\/(events|risk|social|holders))?$/u.exec(url.pathname);
  if (match) {
    const launch = launches.find((item) => item.mint === match[1]); if (!launch) { json(response, 404, { apiVersion: 'v1', error: { code: 'LAUNCH_NOT_FOUND', message: 'missing' } }); return; }
    if (!match[2]) json(response, 200, envelope(detail(launch)));
    else if (match[2] === 'risk') json(response, 200, envelope(risk));
    else if (match[2] === 'social') json(response, 200, envelope(social));
    else if (match[2] === 'holders') json(response, 200, envelope(holders));
    else json(response, 200, envelope([{ id: 'timeline-a', type: 'QualificationUpdated', occurredAt: NOW, slot: '100', confirmationStatus: 'confirmed', payloadVersion: 1, payload: { verdict: 'REJECTED' } }]));
    return;
  }
  if (url.pathname === '/api/v1/paper-positions') { json(response, 200, envelope([paper])); return; }
  if (url.pathname === '/api/v1/health') { json(response, 200, envelope(health)); return; }
  json(response, 404, { apiVersion: 'v1', error: { code: 'ROUTE_NOT_FOUND', message: 'missing' } });
});

server.listen(3000, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { closeStreams(); server.close(() => process.exit(0)); });
