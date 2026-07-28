import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../src/config/env.js';
import type { PoolInfo, SwapEvent, TokenSession, TradeRecord } from '../src/domain/types.js';
import { SessionEngine } from '../src/strategy/session-engine.js';

const pool: PoolInfo = {
  dex:'RAYDIUM_CPMM',programId:'program',pool:'pool',tokenMint:'token',wsolMint:'wsol',tokenVault:'tv',wsolVault:'wv',lpMint:'lp',tokenProgram:'tp',wsolTokenProgram:'tp',creator:'creator',openTimeUnix:0n,createdSlot:1n,createdSignature:'create',createdInstructionIndex:0,discoveredAtMs:1,
};
function event(id: string, index: number, payer='external'): SwapEvent {
  return { id,dex:'RAYDIUM_CPMM',pool:'pool',signature:id,kind:'BUY',payer,authority:null,amountWsolRaw:1n,amountTokenRaw:2n,cursor:{slot:2n,transactionIndex:index,instructionIndex:0,innerInstructionIndex:null},confirmationStatus:'FINALIZED',observedAtMs:Date.now() };
}

void test('attend le premier achat, exclut celui-ci puis compte chaque achat externe une seule fois', async () => {
  const harness = makeHarness({ target: 2, sellFails: false });
  await harness.engine.registerPool(pool);
  await harness.engine.processSwap(event('first', 1));
  let session = harness.engine.listSessions()[0];
  assert.ok(session);
  assert.equal(session.status, 'HOLDING');
  assert.equal(session.subsequentBuyCount, 0);
  await harness.engine.processSwap(event('next-1', 2));
  await harness.engine.processSwap(event('next-1', 2));
  session = harness.engine.listSessions()[0];
  assert.ok(session);
  assert.equal(session.subsequentBuyCount, 1);
  await harness.engine.processSwap(event('own', 3, 'wallet'));
  assert.equal(onlySession(harness.engine).subsequentBuyCount, 1);
  await harness.engine.processSwap(event('next-2', 4));
  session = harness.engine.listSessions()[0];
  assert.ok(session);
  assert.equal(session.status, 'CLOSED');
  assert.equal(session.subsequentBuyCount, 2);
});

void test('un échec de vente fait passer la session en MANUAL_REVIEW', async () => {
  const harness = makeHarness({ target: 1, sellFails: true });
  await harness.engine.registerPool(pool);
  await harness.engine.processSwap(event('first', 1));
  await harness.engine.processSwap(event('next', 2));
  assert.equal(onlySession(harness.engine).status, 'MANUAL_REVIEW');
  assert.match(onlySession(harness.engine).rejectionReason ?? '', /Échec de vente/u);
});

void test('une session d’attente expirée passe à EXPIRED', async () => {
  const harness = makeHarness({ target: 2, sellFails: false });
  await harness.engine.registerPool(pool);
  const session = harness.engine.listSessions()[0];
  assert.ok(session);
  session.expiresAtMs = Date.now() - 1;
  await harness.engine.processSwap(event('late', 1));
  assert.equal(session.status, 'EXPIRED');
});

void test('reprend un BUY_PENDING depuis un trade simulé sans refaire un achat', async () => {
  const harness = makeHarness({ target: 2, sellFails: false });
  const session = makeSession('BUY_PENDING');
  harness.sessionRepo.active.push(session);
  harness.tradeRepo.records.set(`${session.id}:BUY`, makeTrade(session, 'BUY'));
  await harness.engine.restore();
  assert.equal(onlySession(harness.engine).status, 'HOLDING');
  assert.equal(harness.buyCalls.value, 0);
  harness.engine.stop();
});

function makeHarness(options: { target: number; sellFails: boolean }) {
  const sessionRepo = new MemorySessionRepository();
  const swapRepo = new MemorySwapRepository();
  const tradeRepo = new MemoryTradeRepository();
  const buyCalls = { value: 0 };
  const venue = { readPoolRuntimeState: async () => ({ pool:'pool',statusBits:0,swapsEnabled:true,openTimeUnix:0n,tokenVaultBalanceRaw:1n,wsolVaultBalanceRaw:1n,observedSlot:1n }) } as any;
  const risk = { analyze: async () => ({ id:'risk',verdict:'ALLOW',score:100 }) } as any;
  const executor = {
    buy: async () => { buyCalls.value += 1; return { mode:'paper',amountInLamports:1n,amountOutTokenRaw:2n,quotedOutTokenRaw:2n,cursor:{slot:2n,transactionIndex:-1,instructionIndex:-1,innerInstructionIndex:null},confirmedAtMs:Date.now(),simulation:{ok:true,error:null,logs:[],unitsConsumed:null,replacementBlockhash:null} }; },
    sell: async () => { if (options.sellFails) throw new Error('vente impossible'); return { mode:'paper',amountInTokenRaw:2n,amountOutLamports:1n,quotedOutLamports:1n,confirmedAtMs:Date.now(),simulation:{ok:true,error:null,logs:[],unitsConsumed:null,replacementBlockhash:null} }; },
  } as any;
  const config = { targetBuysAfterEntry:options.target,poolMonitorTtlMinutes:90,maxConcurrentPositions:1 } as AppConfig;
  const logger = { info(){}, warn(){}, error(){}, debug(){} } as any;
  const reportRepo = { latestBySession: async () => null } as any;
  const engine = new SessionEngine(venue,risk,executor,{address:'wallet'} as any,sessionRepo as any,swapRepo as any,tradeRepo as any,reportRepo,config,logger);
  return { engine, sessionRepo, tradeRepo, buyCalls };
}

class MemorySessionRepository {
  active: TokenSession[] = [];
  async save(session: TokenSession){ const i=this.active.findIndex(x=>x.id===session.id); if(i>=0)this.active[i]=session;else this.active.push(session); }
  async findByPool(address:string){ return this.active.find(x=>x.pool.pool===address)??null; }
  async loadActive(){ return this.active; }
  async countOpenPositions(){ return this.active.filter(x=>['BUY_PENDING','HOLDING','SELL_PENDING','MANUAL_REVIEW'].includes(x.status)).length; }
}
class MemorySwapRepository {
  claimed = new Set<string>();
  async claim(e:SwapEvent){ if(this.claimed.has(e.id))return false;this.claimed.add(e.id);return true; }
  async markProcessed(){} async markFailed(){}
}
class MemoryTradeRepository {
  records=new Map<string,TradeRecord>();
  async findByIdempotencyKey(k:string){return this.records.get(k)??null;}
}
function makeSession(status: TokenSession['status']): TokenSession {
  return { id:'raydium-cpmm:pool',pool,metadata:null,status,subsequentBuyCount:0,targetBuysAfterEntry:2,countedBuyEventIds:[],sellAttempts:0,createdAtMs:1,updatedAtMs:1,expiresAtMs:Date.now()+100000 };
}
function makeTrade(session:TokenSession,side:'BUY'|'SELL'):TradeRecord{
  return {id:`${session.id}:${side}`,idempotencyKey:`${session.id}:${side}`,sessionId:session.id,pool:'pool',tokenMint:'token',side,mode:'paper',status:'SIMULATED',amountInRaw:1n,amountOutRaw:2n,quotedOutRaw:2n,payload:{simulation:{ok:true,error:null,logs:[],unitsConsumed:null,replacementBlockhash:null}},createdAtMs:1,updatedAtMs:2};
}

function onlySession(engine: SessionEngine): TokenSession {
  const session = engine.listSessions()[0];
  assert.ok(session);
  return session;
}
