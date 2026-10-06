import assert from 'node:assert/strict';
import test from 'node:test';
import { captureMarket } from '../src/telemetry/postgres.js';

void test('read-only capture uses bounded timeout and no RPC; unavailable stays unknown', async () => {
  const statements: string[] = [];
  const pool: any = { connect: async () => ({ query: async (sql: string) => { statements.push(sql); return { rows: [] }; }, release: () => {} }) };
  const result = await captureMarket(pool,'mint','100',()=>1234);
  assert.equal(result.coverage,'UNAVAILABLE');
  assert.equal(result.atMs,1234);
  assert.equal(result.graphAvailable,false);
  assert.ok(statements.some(x => x.includes('READ ONLY')));
  assert.ok(statements.some(x => x.includes('statement_timeout')));
  assert.ok(statements.every(x => !/INSERT|UPDATE|DELETE/.test(x)));
});
void test('capture maps finalized Pump.fun and PumpSwap raw values and graph evidence', async () => {
  const pool: any = { connect: async () => ({ query: async (sql: string) => ({ rows:
    sql.includes('FROM token_launches') ? [{creator:'creator'}] :
    sql.includes('FROM launch_trades') ? [{id:'event',signature:'tx',wallet:'buyer',side:'BUY',quote_amount_raw:'9007199254740993',quote_mint:'SOL',slot:'101',observed_at:new Date(1000),confirmation:'finalized'}] :
    sql.includes('FROM wallet_graph_profiles') ? [{coverage:{notProcessedBuyerCount:2},confirmation_status:'finalized',input_fingerprint:'fp'}] :
    sql.includes('FROM wallet_clusters') ? [{id:'cluster',wallets:['a','b'],shared_funder:true}] :
    sql.includes('FROM wallet_relationships') ? [{left_wallet:'a',right_wallet:'b',confidence:'STRONG'}] : [] }), release:()=>{} }) };
  const result = await captureMarket(pool,'mint','100',()=>1234);
  assert.equal(result.trades[0]?.quoteAmountRaw,'9007199254740993');
  assert.equal(result.clusters[0]?.sharedFunder,true);
  assert.equal(result.graphAvailable,true);
});
