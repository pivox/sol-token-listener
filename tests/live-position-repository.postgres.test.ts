import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { PostgresLiveOrderJournal } from '../src/live/postgres-live-order-journal.js';
import { PostgresLivePositionRepository } from '../src/live/postgres-live-position-repository.js';
import { LivePositionMarketResolver } from '../src/live/live-position-market-route.js';
import { integrationPool } from './helpers/live-application-process.js';
import type { CanonicalPaperVenueState } from '../src/paper/paper-quote-router.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;

void test('Postgres live positions persist and apply each signature once across repository restart', async (context) => {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('LIVE_TEST_DATABASE_URL is not configured for an isolated disposable PostgreSQL instance');
    return;
  }
  const schema = `live_position_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(await readFile(new URL('../migrations/016_live_order_journal.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/017_live_positions.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/018_live_position_market_route.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/019_live_position_market_route_recovery.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/020_live_position_market_resolution.sql', import.meta.url), 'utf8'));
    const journal = new PostgresLiveOrderJournal(pool);
    await journal.prepare(order('buy-order', 'BUY'));
    const firstRepository = new PostgresLivePositionRepository(pool);
    const opened = await firstRepository.applyBuy(fill('buy-order', 'buy-signature', known(500n, 1_500n)));
    assert.equal(opened.status, 'OPEN');
    assert.equal(opened.walletTokenPreRaw, 500n);
    assert.equal(opened.acquiredRaw, 1_000n);
    assert.equal(opened.remainingRaw, 1_000n);
    assert.deepEqual(await firstRepository.applyBuy(fill('buy-order', 'buy-signature', known(500n, 1_500n))), opened);
    await firstRepository.recordMarketRoute({positionId:'position-1',state:'WAITING_FOR_POOL',poolAddress:null,attempts:2,lastError:'pool absent',
      retryGeneration:1,retryBudget:3,retryHistory:[{state:'RETRY_EXHAUSTED',attempts:5,error:'pool absent',at:'2026-10-04T12:00:00.000Z'}]});

    // Simulate process restart: create new repository object and reload from PostgreSQL.
    const afterRestart = new PostgresLivePositionRepository(pool);
    assert.deepEqual(await afterRestart.get('position-1'), opened);
    assert.deepEqual(await afterRestart.getMarketRoute('position-1'), {
      positionId:'position-1',state:'WAITING_FOR_POOL',poolAddress:null,attempts:2,lastError:'pool absent',
      retryGeneration:1,retryBudget:3,retryHistory:[{state:'RETRY_EXHAUSTED',attempts:5,error:'pool absent',at:'2026-10-04T12:00:00.000Z'}],
      resolutionSource:null,resolutionSlot:null,resolutionAtMs:null,resolutionEvidence:null,
    });

    await journal.prepare(order('sell-order-1', 'SELL'));
    const unresolvedSell = await afterRestart.applySell(fill('sell-order-1', 'sell-signature-1', { status: 'UNKNOWN', reason: 'TOKEN_BALANCES_MISSING' }));
    assert.equal(unresolvedSell.status, 'RECONCILIATION_REQUIRED');
    const partial = await afterRestart.applySell(fill('sell-order-1', 'sell-signature-1', known(1_500n, 900n)));
    assert.equal(partial.status, 'OPEN');
    assert.equal(partial.remainingRaw, 400n);
    assert.deepEqual(await afterRestart.applySell(fill('sell-order-1', 'sell-signature-1', known(1_500n, 900n))), partial);

    await journal.prepare(order('sell-order-2', 'SELL'));
    const closed = await afterRestart.applySell(fill('sell-order-2', 'sell-signature-2', known(900n, 500n)));
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.remainingRaw, 0n);
    assert.equal((await afterRestart.listActive('wallet-1')).length, 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

void test('confirmed buy with missing token balances is retained unresolved, never as a zero or open position', async (context) => {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('LIVE_TEST_DATABASE_URL is not configured for an isolated disposable PostgreSQL instance');
    return;
  }
  const schema = `live_position_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(await readFile(new URL('../migrations/016_live_order_journal.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/017_live_positions.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/018_live_position_market_route.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/019_live_position_market_route_recovery.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/020_live_position_market_resolution.sql', import.meta.url), 'utf8'));
    await new PostgresLiveOrderJournal(pool).prepare(order('buy-unknown', 'BUY'));
    const repository = new PostgresLivePositionRepository(pool);
    const position = await repository.applyBuy(fill('buy-unknown', 'buy-unknown-signature', { status: 'UNKNOWN', reason: 'TOKEN_BALANCES_MISSING' }));
    assert.equal(position.status, 'RECONCILIATION_REQUIRED');
    assert.equal(position.acquiredRaw, null);
    assert.equal(position.remainingRaw, null);
    assert.equal((await repository.listActive('wallet-1')).length, 1);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

void test('operator pool recheck keeps exhausted budget across repository restart and adds an explicit generation', async (context) => {
  if(databaseUrl===undefined||databaseUrl.trim()===''){context.skip('LIVE_TEST_DATABASE_URL is not configured for an isolated disposable PostgreSQL instance');return;}
  const schema=`live_position_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:databaseUrl});const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    for(const migration of ['016_live_order_journal.sql','017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql'])
      await pool.query(await readFile(new URL(`../migrations/${migration}`,import.meta.url),'utf8'));
    const journal=new PostgresLiveOrderJournal(pool);const positions=new PostgresLivePositionRepository(pool);
    const testPool=integrationPool();
    const wallet=PublicKey.default.toBase58();
    await journal.prepare({orderId:'operator-buy',wallet,positionId:'operator-position',side:'BUY',
      intent:{mint:testPool.baseMint},validity:{blockhash:PublicKey.default.toBase58()}});
    const opened=await positions.applyBuy({orderId:'operator-buy',positionId:'operator-position',sessionId:'operator-session',
      candidateId:'operator-candidate',wallet,mint:testPool.baseMint,tokenProgram:TOKEN_PROGRAM_ID.toBase58(),
      entryCursor:{slot:1n,transactionIndex:0,instructionIndex:0,innerInstructionIndex:null},externalBuyTarget:1,
      signature:'operator-buy-signature',tokenBalance:{status:'KNOWN',owner:wallet,mint:testPool.baseMint,
        preAmountRaw:0n,postAmountRaw:500n,deltaRaw:500n}});
    let poolAvailable=false;let reads=0;
    const venues={read:async(mint:string):Promise<CanonicalPaperVenueState>=>{reads+=1;return {mint,
      bondingCurve:{active:false,complete:true},migrationObserved:true,
      pumpSwap:poolAvailable?{active:true,pool:testPool}:null,headSlot:BigInt(reads)};}};
    const firstProcess=new LivePositionMarketResolver(venues,positions,2);
    assert.equal((await firstProcess.resolve(opened)).state,'WAITING_FOR_POOL');
    assert.equal((await firstProcess.resolve(opened)).state,'RETRY_EXHAUSTED');
    const exhaustedReads=reads;
    const secondProcessPositions=new PostgresLivePositionRepository(pool);
    const secondProcess=new LivePositionMarketResolver(venues,secondProcessPositions,2);
    assert.equal((await secondProcess.resolve(opened)).state,'RETRY_EXHAUSTED');
    assert.equal(reads,exhaustedReads,'a process restart cannot silently poll/reset an exhausted route');
    const lease=await journal.acquireWalletLock(wallet);
    try{
      await assert.rejects(journal.acquireWalletLock(wallet),/already has an executor/u);
      poolAvailable=true;
      const resumed=await secondProcess.resumeAfterOperatorReview(opened,3);
      assert.equal(resumed.state,'PUMPSWAP');
      const route=await secondProcessPositions.getMarketRoute(opened.positionId);
      assert.equal(route?.retryGeneration,1);assert.equal(route?.retryBudget,3);assert.equal(route?.poolAddress,testPool.address);
      assert.ok((route?.retryHistory?.length??0)>=3,'prior attempts remain in the route history after operator rearm');
    }finally{await lease.release();}
  }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});

function order(orderId: string, side: 'BUY' | 'SELL') {
  return { orderId, wallet: 'wallet-1', positionId: 'position-1', side,
    intent: { mint: 'mint-1' }, validity: { blockhash: 'blockhash-1' } } as const;
}
function fill(orderId: string, signature: string, tokenBalance: ReturnType<typeof known> | { status: 'UNKNOWN'; reason: 'TOKEN_BALANCES_MISSING' }) {
  return { orderId,positionId:'position-1',sessionId:'session-1',candidateId:'candidate-1',
    wallet:'wallet-1',mint:'mint-1',tokenProgram:'token-program-1',
    entryCursor:{slot:10n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:null},
    externalBuyTarget:1,
    signature,tokenBalance } as const;
}
function known(preAmountRaw: bigint, postAmountRaw: bigint) {
  return { status:'KNOWN' as const,owner:'wallet-1',mint:'mint-1',preAmountRaw,postAmountRaw,deltaRaw:postAmountRaw-preAmountRaw };
}
