import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isEligibleForCanary } from './selection-policy.mjs';

const project = '/Users/haythem.mabrouk/workspace/perso/sol-token-listener';
const worktree = path.join(project, '.worktrees/unissued-work-inventory');
const require = createRequire(path.join(worktree, 'package.json'));
const { Connection, PublicKey } = require('@solana/web3.js');
const { OnlinePumpSdk, PUMP_PROGRAM_ID } = require('@pump-fun/pump-sdk');
require('dotenv').config({ path: path.join(project, '.env'), quiet: true });
const { PumpBorshReader } = await import(path.join(worktree, 'dist/src/launchpads/pumpfun/borsh-reader.js'));
const { decodeIdlFields } = await import(path.join(worktree, 'dist/src/launchpads/pumpfun/idl-codec.js'));
const { PUMP_TYPES, PUMP_EVENTS } = await import(path.join(worktree, 'dist/src/launchpads/pumpfun/generated/pump-idl.js'));
const outdir = process.env.DISCOVER_OUTDIR ?? '/tmp/sol-token-listener-microtrade-20261003-r2';
const conn = new Connection(process.env.SOLANA_HTTP_RPC_URL, { commitment: 'confirmed', wsEndpoint: process.env.SOLANA_WS_RPC_URL });
const sdk = new OnlinePumpSdk(conn);
const maxTokens = 15;
const createDisc = Buffer.from(PUMP_EVENTS.CreateEvent.discriminator);
const tradeDisc = Buffer.from(PUMP_EVENTS.TradeEvent.discriminator);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function write(file, record) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...record });
  fs.appendFileSync(path.join(outdir, file), `${line}\n`, { mode: 0o600 });
  if (record.event !== 'trade') console.log(line);
}
function parse(line, kind) {
  if (!line.startsWith('Program data: ')) return null;
  const bytes = Buffer.from(line.slice(14), 'base64');
  const disc = kind === 'create' ? createDisc : tradeDisc;
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(disc)) return null;
  try {
    const reader = new PumpBorshReader(bytes.subarray(8));
    const fields = decodeIdlFields(PUMP_TYPES[kind === 'create' ? 'CreateEvent' : 'TradeEvent'].type.fields.slice(0, -2), reader);
    return { fields, suffixBytes: reader.remaining };
  } catch { return null; }
}
if (process.env.SOLANA_CLUSTER !== 'mainnet-beta' || await conn.getGenesisHash() !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new Error('Mainnet guard failed');
const captures = [];
const seen = new Set();
write('sniff.jsonl', { event: 'sniff_started', maxTokens, timeoutSeconds: 120 });
const listener = conn.onLogs(PUMP_PROGRAM_ID, (log, ctx) => {
  if (log.err || captures.length >= maxTokens) return;
  for (const line of log.logs) {
    const event = parse(line, 'create');
    if (!event) continue;
    const mint = event.fields.mint;
    if (typeof mint !== 'string' || seen.has(mint)) continue;
    seen.add(mint);
    const row = { event: 'pumpfun_create', index: captures.length + 1, mint, signature: log.signature, slot: ctx.slot, suffixBytes: event.suffixBytes };
    captures.push(row);
    write('sniff.jsonl', row);
    if (captures.length >= maxTokens) break;
  }
}, 'confirmed');
const started = Date.now();
while (captures.length < maxTokens && Date.now() - started < 120000) await sleep(500);
await conn.removeOnLogsListener(listener);
write('sniff.jsonl', { event: 'sniff_stopped', count: captures.length, reason: captures.length === maxTokens ? 'limit_15' : 'timeout' });
const candidateRows = [];
for (const capture of captures) {
  try {
    let tx = null;
    for (let i = 0; i < 15 && !tx; i++) {
      tx = await conn.getTransaction(capture.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 1 });
      if (!tx) await sleep(1000);
    }
    const mint = new PublicKey(capture.mint);
    const [curve, mintInfo] = await Promise.all([sdk.fetchBondingCurve(mint), conn.getAccountInfo(mint, 'finalized')]);
    const row = { event: 'candidate', index: capture.index, mint: capture.mint, creationFinalized: !!tx && tx.meta.err === null, mintOwner: mintInfo?.owner.toBase58() ?? null, quoteMint: curve.quoteMint.toBase58(), mayhem: curve.isMayhemMode, complete: curve.complete, realQuoteLamports: curve.realQuoteReserves.toString(), realTokenRaw: curve.realTokenReserves.toString(), error: null };
    candidateRows.push(row);
    write('candidates.jsonl', row);
  } catch (error) {
    const row = { event: 'candidate', index: capture.index, mint: capture.mint, error: String(error.message ?? error).slice(0, 160) };
    candidateRows.push(row);
    write('candidates.jsonl', row);
  }
}
const watched = new Set(captures.map((x) => x.mint));
const counts = new Map();
const seenSigs = new Set();
write('activity.jsonl', { event: 'activity_started', seconds: 45 });
const monitor = conn.onLogs(PUMP_PROGRAM_ID, (log, ctx) => {
  if (log.err || seenSigs.has(log.signature)) return;
  seenSigs.add(log.signature);
  for (const line of log.logs) {
    const event = parse(line, 'trade');
    if (!event || !watched.has(event.fields.mint)) continue;
    const mint = event.fields.mint;
    const count = counts.get(mint) ?? { buys: 0, sells: 0, buyers: new Set() };
    if (event.fields.is_buy) { count.buys += 1; count.buyers.add(event.fields.user); }
    else count.sells += 1;
    counts.set(mint, count);
    write('activity.jsonl', { event: 'trade', mint, signature: log.signature, slot: ctx.slot, isBuy: event.fields.is_buy, user: event.fields.user, suffixBytes: event.suffixBytes });
  }
}, 'confirmed');
const activityStart = Date.now();
while (Date.now() - activityStart < 45000) {
  await sleep(5000);
  const summary = Object.fromEntries([...counts].map(([mint, x]) => [mint, { buys: x.buys, sells: x.sells, uniqueBuyers: x.buyers.size }]));
  write('activity.jsonl', { event: 'activity_progress', elapsedSeconds: Math.round((Date.now() - activityStart) / 1000), summary });
}
await conn.removeOnLogsListener(monitor);
const summary = Object.fromEntries([...counts].map(([mint, x]) => [mint, { buys: x.buys, sells: x.sells, uniqueBuyers: x.buyers.size }]));
write('activity.jsonl', { event: 'activity_stopped', summary });
const eligible = [];
for (const candidate of candidateRows.filter((r) => isEligibleForCanary(r, summary[r.mint]))) {
  try {
    const fresh = await sdk.fetchBondingCurve(new PublicKey(candidate.mint));
    const row = { ...candidate, complete: fresh.complete, realQuoteLamports: fresh.realQuoteReserves.toString(), realTokenRaw: fresh.realTokenReserves.toString() };
    const stillEligible = isEligibleForCanary(row, summary[row.mint]);
    write('candidate-rechecks.jsonl', { event: 'candidate_recheck', mint: row.mint, realQuoteLamports: row.realQuoteLamports, realTokenRaw: row.realTokenRaw, complete: row.complete, eligible: stillEligible });
    if (stillEligible) eligible.push(row);
  } catch (error) {
    write('candidate-rechecks.jsonl', { event: 'candidate_recheck', mint: candidate.mint, eligible: false, error: String(error.message ?? error).slice(0, 160) });
  }
}
eligible.sort((a, b) => (summary[b.mint]?.uniqueBuyers ?? 0) - (summary[a.mint]?.uniqueBuyers ?? 0) || Number(BigInt(b.realQuoteLamports) - BigInt(a.realQuoteLamports)));
write('selection.jsonl', { event: 'selection', eligible: eligible.map((r) => ({ index: r.index, mint: r.mint, reserve: r.realQuoteLamports, activity: summary[r.mint] })), chosen: eligible[0]?.mint ?? null });
