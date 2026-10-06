import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EvidenceJournal } from '../src/telemetry/journal.js';
import { normalizeRunner } from '../src/telemetry/runner.js';

void test('append-only journal restart, idempotence and torn-tail recovery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'telemetry-'));
  try {
    const file = path.join(dir,'input.jsonl');
    const a = await EvidenceJournal.open(file);
    await a.append({ id: 'one', data: { raw: '9007199254740993' } }); await a.close();
    const before = await readFile(file,'utf8');
    await appendFile(file,'{"id":"partial');
    const b = await EvidenceJournal.open(file);
    assert.equal(await b.append({ id: 'one', data: { raw: '9007199254740993' } }), false);
    await b.append({ id: 'two', data: {} }); await b.close();
    assert.ok((await readFile(file,'utf8')).startsWith(before));
    const c = await EvidenceJournal.open(file);
    assert.deepEqual(c.rows.filter(x => x.id === 'one' || x.id === 'two').map(x => x.id), ['one','two']);
    await c.close();
  } finally { await rm(dir,{ recursive:true,force:true }); }
});
const log = [
  { at: '2026-10-04T00:00:00.000Z', event:'preflight', mint:'mint', wallet:'own', initialWalletLamports: 10000, krakenSolUsdt:100, sellNetworkFeeReserveLamports:'5' },
  { at:'2026-10-04T00:00:01.000Z',event:'buy_confirmed',signature:'buy',slot:100,feeLamports:10,walletBalanceBeforeLamports:10000,walletBalanceAfterLamports:8900 },
  { at:'2026-10-04T00:00:02.000Z',event:'position_open',signature:'buy',slot:100,tokenRaw:'100',buyEconomicCostLamports:'1010',tokenAccountRentLamports:90 },
  { at:'2026-10-04T00:00:05.000Z',event:'price_progress',expectedSellQuoteLamports:'1200',requiredSellQuoteLamports:'1100' },
  { at:'2026-10-04T00:00:06.000Z',event:'sell_started',reason:'net_profit_target' },
  { at:'2026-10-04T00:00:07.000Z',event:'sell_confirmed',signature:'sell',walletBalanceBeforeLamports:8900,walletBalanceAfterLamports:10010 },
  { at:'2026-10-04T00:00:08.000Z',event:'sell_result',remainingTokenRaw:'0' },
  { at:'2026-10-04T00:00:09.000Z',event:'complete',finalWalletLamports:10010 },
];
void test('runner reuse split by BUY identity, actual entry cost, quote reuse and recovery', () => {
  const result = normalizeRunner('run',log);
  assert.equal(result.length,1);
  const p = required(result[0]);
  assert.equal(p.entry.amountInRaw,'1000');
  assert.equal(p.entry.economicCostRaw,'1010');
  assert.equal(p.entry.exit?.realizedNetPnlRaw,'100');
  assert.equal(required(p.observations[0]).quote?.status,'AVAILABLE');
  const quote = required(p.observations[0]).quote;
  assert.ok(quote?.status === 'AVAILABLE');
  assert.equal(quote.minimumAmountOutRaw,'1100');
  assert.equal(quote.observedSlot,null);
  assert.equal(normalizeRunner('run',[...log,...log.map(x => ({...x, signature:x.signature === 'buy' ? 'buy2' : x.signature}))]).length,2);
  const recovery = log.filter(x => !['complete','sell_started'].includes(x.event));
  recovery.push({at:'2026-10-04T00:00:10.000Z',event:'recovery_complete',finalWalletLamports:10010});
  assert.equal(required(normalizeRunner('run',recovery)[0]).entry.positionId,p.entry.positionId);
});

function required<T>(value: T | undefined | null): T { assert.ok(value != null); return value; }

void test('BUY confirmed before position_open remains visible with unknown cost; recovery closes same position', () => {
  const partial = normalizeRunner('run',log.slice(0,2));
  assert.equal(partial.length,1);
  assert.equal(partial[0]?.entry.economicCostRaw,null);
  assert.equal(partial[0]?.entry.tokenAmountRaw,null);
  const recovered = normalizeRunner('run',[...log.slice(0,2),...log.slice(4)]);
  assert.equal(recovered[0]?.entry.positionId,partial[0]?.entry.positionId);
  assert.equal(recovered[0]?.entry.exit?.realizedNetPnlRaw,null);
});
