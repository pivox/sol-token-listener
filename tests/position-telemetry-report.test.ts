import assert from 'node:assert/strict';
import test from 'node:test';
import { exactStats, analyzeDataset, renderReport } from '../src/telemetry/report.js';
import { snapshotPosition, type PositionEvidence, type Observation } from '../src/telemetry/position.js';
const entry: PositionEvidence = {runId:'r',positionId:'p',mint:'m',buySignature:'b',wallet:'w',quoteMint:'SOL',entryAtMs:1000,entrySlot:'1',amountInRaw:'1000000',buyNetworkFeeRaw:'10',economicCostRaw:'1000010',tokenAmountRaw:'100',sellNetworkFeeEstimateRaw:'5',solUsdt:'100',exit:{atMs:10000,signature:'s',reason:'max_hold_5_minutes',realizedNetPnlRaw:'-5000000'}};
const observation: Observation = {id:'q',kind:'quote',atMs:5000,creator:null,coverage:'UNAVAILABLE',trades:[],clusters:[],relationships:[],graphAvailable:false,graphCoverage:null,quote:{status:'AVAILABLE',venue:'PUMP_FUN_BONDING_CURVE',observedAtMs:5000,observedSlot:null,stateReceivedAtMs:4900,stateSlot:'2',quoteCalculatedAtMs:4950,validity:'VALID',freshnessMs:100,freshnessLimitMs:10000,invalidReason:null,feeTreatment:'INCLUDED_IN_MIN_OUT',netPnlEstimateRaw:null,amountInRaw:'100',amountOutRaw:'500000',minimumAmountOutRaw:'450000',feesRaw:null,slippageBps:'1000',priceImpactBps:null,metadataUnavailable:[]}};
void test('exact statistics preserve financial precision, median and missing population',()=>{
  const stats = exactStats(['9007199254740993001','9007199254740993003',null]);
  assert.equal(stats.n,2);
  assert.equal(stats.missing,1);
  assert.deepEqual(stats.mean,{numerator:'18014398509481986004',denominator:'2'});
  assert.deepEqual(stats.median,{numerator:'18014398509481986004',denominator:'2'});
});
void test('offline WIN/LOSS populations and labelled counterfactuals never choose a threshold',()=>{
  const result = analyzeDataset([{entry,observations:[observation]}]);
  assert.equal(result.positions[0]?.group,'LOSS');
  assert.equal(result.comparisons[0]?.LOSS.netExecutablePnlRaw?.n,1);
  assert.equal(result.comparisons[1]?.LOSS.netExecutablePnlRaw?.n,0);
  assert.equal(result.counterfactuals[0]?.triggered,1);
  assert.ok(renderReport(result).includes('contrefactuelles'));
  assert.ok(renderReport(result).toLowerCase().includes('petite population'));
});
void test('late orphan evidence reconciles activity without adding future buyers to snapshots',()=>{
  const market: Observation = {...observation,id:'market',kind:'market',quote:null,coverage:'OBSERVED',trades:[{id:'t',signature:'tx',wallet:'buyer',side:'BUY',quoteAmountRaw:'20',quoteMint:'SOL',slot:'2',observedAtMs:4000,confirmation:'finalized'}]};
  const orphan: Observation = {...market,id:'orphan',atMs:12000,trades:market.trades.map(t=>({...t,confirmation:'orphaned'}))};
  assert.equal(snapshotPosition(entry,[market,orphan],6000).activity?.buyCount,1);
  const result = analyzeDataset([{entry,observations:[market,orphan]}]);
  assert.equal(result.positions[0]?.snapshots[0]?.activity?.buyCount,0);
  assert.equal(result.positions[0]?.orphanedTradeIds.length,1);
});

void test('orphan invalidates quotes lacking chain provenance, without inventing replacement prices',()=>{
  const orphan: Observation = {...observation,id:'orphan',atMs:12000,kind:'market',quote:null,trades:[{id:'t',signature:'tx',wallet:'buyer',side:'BUY',quoteAmountRaw:'1',quoteMint:'SOL',slot:'2',observedAtMs:4000,confirmation:'orphaned'}]};
  const result=analyzeDataset([{entry,observations:[observation,orphan]}]);
  assert.equal(result.positions[0]?.snapshots[0]?.netExecutablePnlRaw,null);
  assert.equal(result.positions[0]?.snapshots[0]?.quote.status,'UNAVAILABLE');
});
