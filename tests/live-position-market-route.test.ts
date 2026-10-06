import assert from 'node:assert/strict';
import test from 'node:test';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { NATIVE_MINT } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import type { CanonicalMarketPool } from '../src/domain/market.js';
import type { CanonicalPaperVenueState } from '../src/paper/paper-quote-router.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { poolPda } from '../src/markets/pumpswap/official-sdk.js';
import type { LivePositionRecord, LivePositionMarketRoute } from '../src/live/postgres-live-position-repository.js';
import { LivePositionMarketResolver } from '../src/live/live-position-market-route.js';

void test('live route resolver distinguishes curve, bounded migration wait, retry expiry and canonical pool', async () => {
  const routes = new Map<string, LivePositionMarketRoute>();
  let venueReads=0;
  let venue: CanonicalMarketVenue = {
    mint: position.mint, bondingCurve: { active: true, complete: false }, migrationObserved: false,
    pumpSwap: null, headSlot: 10n,
  };
  const resolver = new LivePositionMarketResolver({ read: async () => { venueReads+=1;return venue; } }, {
    getMarketRoute: async (id) => routes.get(id) ?? null,
    recordMarketRoute: async (route) => { routes.set(route.positionId, route); },
  }, 2);

  assert.equal((await resolver.resolve(position)).state, 'BONDING_CURVE');
  venue = { ...venue, bondingCurve: { active: false, complete: true }, migrationObserved: true };
  assert.equal((await resolver.resolve(position)).state, 'WAITING_FOR_POOL');
  assert.equal((await resolver.resolve(position)).state, 'RETRY_EXHAUSTED');
  const readsAtExhaustion=venueReads;
  assert.equal((await resolver.resolve(position)).state,'RETRY_EXHAUSTED');
  assert.equal(venueReads,readsAtExhaustion,'restart does not silently spend/reset an exhausted budget');
  venue = { ...venue, pumpSwap: { active: true, pool: canonicalPool() } };
  assert.equal((await resolver.resolve(position)).state, 'RETRY_EXHAUSTED', 'exhaustion stops unbounded polling');
  const resumed = await resolver.resumeAfterOperatorReview(position, 2);
  assert.equal(resumed.state, 'PUMPSWAP');
  assert.equal(resumed.route.retryGeneration, 1);
  assert.equal(resumed.route.retryBudget, 2);
  assert.ok((resumed.route.retryHistory?.length ?? 0) >= 4, 'the exhausted attempt history remains durable when an operator supplies a new budget');
});

void test('live route resolver accepts only the canonical PumpSwap pool for the held SPL/wSOL pair', async () => {
  const routes = new Map<string, LivePositionMarketRoute>();
  const resolver = new LivePositionMarketResolver({ read: async () => ({
    mint: position.mint, bondingCurve: { active: false, complete: true }, migrationObserved: true,
    pumpSwap: { active: true, pool: canonicalPool() }, headSlot: 20n,
  }) }, {
    getMarketRoute: async (id) => routes.get(id) ?? null,
    recordMarketRoute: async (route) => { routes.set(route.positionId, route); },
  });
  assert.equal((await resolver.resolve(position)).state, 'PUMPSWAP');
  const wrong = { ...canonicalPool(), quoteAsset: { mint: key(30).toBase58(), decimals: 6, tokenProgram: 'SPL_TOKEN' as const } };
  const unsupported = new LivePositionMarketResolver({ read: async () => ({
    mint: position.mint, bondingCurve: { active: false, complete: true }, migrationObserved: true,
    pumpSwap: { active: true, pool: wrong }, headSlot: 20n,
  }) }, {
    getMarketRoute: async () => null,
    recordMarketRoute: async (route) => { routes.set(route.positionId, route); },
  });
  assert.equal((await unsupported.resolve(position)).state, 'UNKNOWN');
});

void test('live route resolver admits Token-2022 only when pool base Program matches the persisted position', async () => {
  const token2022Position={...position,tokenProgram:TOKEN_2022_PROGRAM_ID.toBase58()};
  const pool=canonicalPool('TOKEN_2022');
  const resolver=new LivePositionMarketResolver({read:async()=>({mint:position.mint,bondingCurve:{active:false,complete:true},
    migrationObserved:true,pumpSwap:{active:true,pool},headSlot:25n})},{getMarketRoute:async()=>null,recordMarketRoute:async()=>undefined});
  assert.equal((await resolver.resolve(token2022Position)).state,'PUMPSWAP');
  const mismatched=new LivePositionMarketResolver({read:async()=>({mint:position.mint,bondingCurve:{active:false,complete:true},
    migrationObserved:true,pumpSwap:{active:true,pool:canonicalPool('SPL_TOKEN')},headSlot:25n})},{getMarketRoute:async()=>null,recordMarketRoute:async()=>undefined});
  assert.equal((await mismatched.resolve(token2022Position)).state,'UNKNOWN');
});

type CanonicalMarketVenue = CanonicalPaperVenueState;
const position: LivePositionRecord = {
  positionId:'position',sessionId:'session',candidateId:'candidate',wallet:key(19).toBase58(),
  mint:key(20).toBase58(),tokenProgram:TOKEN_PROGRAM_ID.toBase58(),entryCursor:{slot:1n,transactionIndex:0,instructionIndex:0,innerInstructionIndex:null},
  externalBuyTarget:1,countedExternalBuyIds:[],status:'OPEN',walletTokenPreRaw:0n,acquiredRaw:100n,remainingRaw:100n,
  buySignature:'buy-signature',sellSignature:null,
};
function canonicalPool(baseTokenProgram:'SPL_TOKEN'|'TOKEN_2022'='SPL_TOKEN'): CanonicalMarketPool {
  const base=new PublicKey(position.mint);const quote=NATIVE_MINT;const creator=key(21);
  const baseProgram=baseTokenProgram==='TOKEN_2022'?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
  return { address:poolPda(0,creator,base,quote).toBase58(),market:'pumpswap',programId:PUMPSWAP_PROGRAM_ID,
    baseMint:base.toBase58(),quoteAsset:{mint:quote.toBase58(),decimals:9,tokenProgram:'SPL_TOKEN'},index:0,
    creator:creator.toBase58(),
    baseVault:getAssociatedTokenAddressSync(base,poolPda(0,creator,base,quote),true,baseProgram).toBase58(),
    quoteVault:getAssociatedTokenAddressSync(quote,poolPda(0,creator,base,quote),true).toBase58(),lpMint:key(24).toBase58(),
    baseTokenProgram,activatedAt:{slot:2n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:null},
    confirmationStatus:'finalized'};
}
function key(seed:number):PublicKey{return new PublicKey(Uint8Array.from({length:32},(_,i)=>(seed+i)%256));}
