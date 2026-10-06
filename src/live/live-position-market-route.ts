import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import type { CanonicalMarketPool } from '../domain/market.js';
import type { CanonicalPaperVenueReader, CanonicalPaperVenueState } from '../paper/paper-quote-router.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import { poolPda } from '../markets/pumpswap/official-sdk.js';
import type { LivePositionRecord, LivePositionMarketRoute, PostgresLivePositionRepository } from './postgres-live-position-repository.js';

export type LivePositionMarketResolution =
  | { readonly state: 'BONDING_CURVE'; readonly pool: null; readonly route: LivePositionMarketRoute }
  | { readonly state: 'WAITING_FOR_POOL' | 'RETRY_EXHAUSTED' | 'UNKNOWN'; readonly pool: null; readonly route: LivePositionMarketRoute }
  | { readonly state: 'PUMPSWAP'; readonly pool: CanonicalMarketPool; readonly route: LivePositionMarketRoute };

/** Resolves the persisted canonical venue and stores bounded post-migration retries per position. */
export class LivePositionMarketResolver {
  public constructor(
    private readonly venues: CanonicalPaperVenueReader,
    private readonly positions: Pick<PostgresLivePositionRepository, 'getMarketRoute' | 'recordMarketRoute'>,
    private readonly maximumPoolChecks = 5,
  ) {
    if (!Number.isSafeInteger(maximumPoolChecks) || maximumPoolChecks < 1 || maximumPoolChecks > 20) {
      throw new TypeError('PumpSwap pool check bound must be between 1 and 20.');
    }
  }

  public async resolve(position: LivePositionRecord): Promise<LivePositionMarketResolution> {
    const previous = await this.positions.getMarketRoute(position.positionId);
    if(previous?.state==='RETRY_EXHAUSTED'){
      return Object.freeze({state:'RETRY_EXHAUSTED',pool:null,route:previous});
    }
    const attempts = previous?.attempts ?? 0;
    let venue:CanonicalPaperVenueState;
    try{venue=await this.venues.read(position.mint);}
    catch(error){
      const reason=error instanceof Error?error.message:'unknown RPC read failure';
      return this.save(position,'UNKNOWN',null,attempts,`direct market resolution failed: ${reason}`);
    }
    if (venue.mint !== position.mint) return this.save(position, 'UNKNOWN', null, attempts, 'venue mint mismatch');
    if(venue.resolutionError!==undefined&&venue.resolutionError!==null){
      return this.save(position,'UNKNOWN',null,attempts,venue.resolutionError,venue);
    }
    const curve = venue.bondingCurve;
    if (curve?.active === true && !curve.complete && !venue.migrationObserved && venue.pumpSwap === null) {
      return this.save(position, 'BONDING_CURVE', null, attempts, null,venue);
    }
    if (venue.pumpSwap?.active === true) {
      const pool = venue.pumpSwap.pool;
      if (isSupportedCanonicalPool(pool, position)) {
        return this.save(position, 'PUMPSWAP', pool, attempts, null,venue);
      }
      return this.save(position, 'UNKNOWN', null, attempts, 'canonical pool does not match supported position pair',venue);
    }
    if (curve?.complete === true || venue.migrationObserved) {
      const budget=previous?.retryBudget??this.maximumPoolChecks;
      if (attempts >= budget) {
        return this.save(position, 'RETRY_EXHAUSTED', null, attempts, 'bounded pool discovery expired; operator reconciliation required',venue);
      }
      const nextAttempts=attempts+1;
      const exhausted=nextAttempts>=budget;
      return this.save(position, exhausted?'RETRY_EXHAUSTED':'WAITING_FOR_POOL', null, nextAttempts,
        exhausted?'bounded pool discovery expired; operator reconciliation required':'curve migrated or complete; canonical pool not yet available',venue);
    }
    return this.save(position, 'UNKNOWN', null, attempts, 'bonding curve state is unavailable or contradictory',venue);
  }

  /** Explicit operator-reviewed restart of a bounded pool watch after expiry. */
  public async resumeAfterOperatorReview(position:LivePositionRecord, additionalChecks:number):Promise<LivePositionMarketResolution>{
    if(!Number.isSafeInteger(additionalChecks)||additionalChecks<1||additionalChecks>20)throw new TypeError('Operator pool retry budget must be between 1 and 20.');
    const previous=await this.positions.getMarketRoute(position.positionId);
    if(previous?.state!=='RETRY_EXHAUSTED')throw new Error('Operator recovery requires an exhausted persisted pool route.');
    const history=[...(previous.retryHistory??[]),{state:previous.state,attempts:previous.attempts,error:previous.lastError,at:new Date().toISOString()}];
    const generation=(previous.retryGeneration??0)+1;
    await this.positions.recordMarketRoute({positionId:position.positionId,state:'WAITING_FOR_POOL',
      poolAddress:null,attempts:0,lastError:`operator requested ${additionalChecks} additional bounded pool checks`,
      retryGeneration:generation,retryBudget:additionalChecks,retryHistory:history});
    let result:LivePositionMarketResolution|null=null;
    for(let check=0;check<additionalChecks;check+=1){
      result=await this.resolve(position);
      if(result.state!=='WAITING_FOR_POOL')return result;
      if(check+1<additionalChecks)await new Promise<void>((resolve)=>setTimeout(resolve,250));
    }
    if(result===null)throw new Error('Operator pool recheck did not execute.');
    return result;
  }

  private async save(
    position: LivePositionRecord,
    state: LivePositionMarketRoute['state'],
    pool: CanonicalMarketPool | null,
    attempts: number,
    error: string | null,
    venue?:CanonicalPaperVenueState,
  ): Promise<LivePositionMarketResolution> {
    const previous=await this.positions.getMarketRoute(position.positionId);
    const retryGeneration=previous?.retryGeneration??0;
    const retryBudget=previous?.retryBudget??this.maximumPoolChecks;
    const retryHistory=[...(previous?.retryHistory??[]),{state,attempts,error,at:new Date().toISOString()}];
    const route = Object.freeze({ positionId: position.positionId, state,
      poolAddress: pool?.address ?? null, attempts, lastError: error,
      retryGeneration,retryBudget,retryHistory,
      resolutionSource:venue?.resolutionSource??this.venues.resolutionSource??'LOCAL_INDEX',
      resolutionSlot:venue?.resolutionSlot??venue?.headSlot??null,
      resolutionAtMs:venue?.resolutionAtMs??Date.now(),
      resolutionEvidence:pool===null?null:Object.freeze({
        address:pool.address,programId:pool.programId,index:pool.index,creator:pool.creator,baseMint:pool.baseMint,
        quoteMint:pool.quoteAsset.mint,quoteTokenProgram:pool.quoteAsset.tokenProgram,baseTokenProgram:pool.baseTokenProgram,
        baseVault:pool.baseVault,quoteVault:pool.quoteVault,cashback:venue?.pumpSwapCashback??null,
        slot:(venue?.resolutionSlot??venue?.headSlot??0n).toString(),source:venue?.resolutionSource??this.venues.resolutionSource??'LOCAL_INDEX',
      }) });
    await this.positions.recordMarketRoute(route);
    if (pool !== null) return Object.freeze({ state: 'PUMPSWAP', pool, route });
    if (state === 'PUMPSWAP') throw new Error('PumpSwap route requires its canonical pool.');
    return Object.freeze({ state, pool: null, route });
  }
}

function isSupportedCanonicalPool(pool: CanonicalMarketPool, position: LivePositionRecord): boolean {
  const baseTokenProgram = position.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID
    : position.tokenProgram === TOKEN_PROGRAM_ID.toBase58() ? TOKEN_PROGRAM_ID : null;
  const poolKind: unknown = pool.baseTokenProgram;
  const poolTokenProgram = poolKind === 'TOKEN_2022' ? TOKEN_2022_PROGRAM_ID
    : poolKind === 'SPL_TOKEN' ? TOKEN_PROGRAM_ID : null;
  if (baseTokenProgram === null || poolTokenProgram === null || !baseTokenProgram.equals(poolTokenProgram)
    || pool.market !== 'pumpswap' || pool.programId !== PUMPSWAP_PROGRAM_ID
    || pool.index !== 0 || pool.baseMint !== position.mint
    || pool.quoteAsset.mint !== NATIVE_MINT.toBase58()
    || pool.quoteAsset.decimals !== 9 || pool.quoteAsset.tokenProgram !== 'SPL_TOKEN'
    || (pool.confirmationStatus !== 'confirmed' && pool.confirmationStatus !== 'finalized')) return false;
  try {
    const poolKey=poolPda(0, new PublicKey(pool.creator), new PublicKey(pool.baseMint),new PublicKey(pool.quoteAsset.mint));
    return poolKey.toBase58() === pool.address
      && getAssociatedTokenAddressSync(new PublicKey(pool.baseMint),poolKey,true,baseTokenProgram).toBase58()===pool.baseVault
      && getAssociatedTokenAddressSync(new PublicKey(pool.quoteAsset.mint),poolKey,true,TOKEN_PROGRAM_ID).toBase58()===pool.quoteVault;
  } catch { return false; }
}
