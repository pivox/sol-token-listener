import { createHash } from 'node:crypto';
import { PublicKey, type AccountInfo, type TransactionInstruction } from '@solana/web3.js';
import type { PaperDecisionResult, PaperDecisionSnapshot } from '../ports/paper-decision-repository.js';
import type { ValidatedExternalBuysStrategy } from '../application/validated-external-buys.strategy.js';
import type { TradingCandidateV1 } from '../domain/trading-candidate.js';
import type { ChainCursor } from '../domain/types.js';
import type { PumpFunQuoteAndState, PumpFunPaperQuoteProvider } from '../paper/pumpfun-paper-quote.provider.js';
import { createPumpFunBondingCurveInstructions } from './pumpfun-bonding-curve-instructions.js';
import type { LiveExecutionResult, LiveTransactionExecutor } from './live-transaction-executor.js';
import type { PostgresLiveOrderJournal, ConfirmedLiveOrderNeedingFill, UnresolvedLiveOrder } from './postgres-live-order-journal.js';
import type { LivePositionFillInput, LivePositionRecord, PostgresLivePositionRepository } from './postgres-live-position-repository.js';
import type { LivePolicy } from './live-policy.js';
import type { LiveTokenBalanceReconciliation } from './live-token-reconciliation.js';
import type { LivePositionMarketResolution, LivePositionMarketResolver } from './live-position-market-route.js';
import type { PumpSwapLiveSellAdapter } from './pumpswap-live-sell-adapter.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { assessLiveTokenEligibility } from './live-token-eligibility.js';

export interface LiveDecisionControllerDependencies {
  readonly policy: LivePolicy;
  readonly externalBuyTarget: number;
  readonly minimumConfirmation: 'confirmed'|'finalized';
  readonly maximumQuoteAgeMs: number;
  readonly executor: LiveTransactionExecutor;
  readonly journal: PostgresLiveOrderJournal;
  readonly positions: PostgresLivePositionRepository;
  readonly quotes: PumpFunPaperQuoteProvider;
  readonly strategy: ValidatedExternalBuysStrategy;
  readonly readAssociatedTokenAccount: (mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) => Promise<AccountInfo<Buffer> | null>;
  readonly now: () => number;
  readonly marketResolver?: LivePositionMarketResolver;
  readonly pumpSwapSales?: PumpSwapLiveSellAdapter;
  readonly onAdmissionRejected?: (decision: Readonly<{ candidateId: string; mint: string; reason: string; stateSlot: string; receivedAtMs: number }>) => void;
}

/** Application adapter from persisted listener decisions to the selected live strategy. */
export class LiveDecisionController {
  private restored=false;
  private criticalAmbiguity=false;
  private acceptingEntries=true;
  private tail:Promise<void>=Promise.resolve();

  public constructor(private readonly dependencies:LiveDecisionControllerDependencies){}

  public async restore():Promise<void>{
    const wallet=this.dependencies.policy.expectedWallet;
    for(const order of await this.dependencies.journal.listUnresolved(wallet)){
      const result=await this.dependencies.executor.resume(order);
      if(result.status==='CONFIRMED')await this.applyExecution(order,result);
      else if(result.status==='UNKNOWN')this.criticalAmbiguity=true;
    }
    for(const order of await this.dependencies.journal.listConfirmedNeedingFill(wallet)){
      await this.applyStoredConfirmation(order);
    }
    const active=await this.dependencies.positions.listActive(wallet);
    if(active.some((position)=>position.status==='RECONCILIATION_REQUIRED'))this.criticalAmbiguity=true;
    if(this.dependencies.marketResolver!==undefined){
      for(const position of active){
        const route=await this.dependencies.marketResolver.resolve(position);
        if(route.state==='UNKNOWN'||route.state==='RETRY_EXHAUSTED')this.criticalAmbiguity=true;
      }
    }
    if((await this.dependencies.journal.listUnresolved(wallet)).length>0)this.criticalAmbiguity=true;
    this.restored=true;
  }

  public stopEntries():void{this.acceptingEntries=false;}
  public allowEntries():void{this.acceptingEntries=true;}
  public get blockedByAmbiguity():boolean{return this.criticalAmbiguity;}

  public consume(result:PaperDecisionResult,snapshot:PaperDecisionSnapshot):Promise<void>{
    const operation=this.tail.then(()=>this.consumeOnce(result,snapshot));
    this.tail=operation.then(()=>undefined,()=>undefined);
    return operation;
  }

  private async consumeOnce(result:PaperDecisionResult,snapshot:PaperDecisionSnapshot):Promise<void>{
    if(!this.restored)throw new Error('Live controller must restore before consuming listener decisions.');
    const wallet=this.dependencies.policy.expectedWallet;
    const positions=await this.dependencies.positions.listActive(wallet);
    if(positions.length>1)throw new Error('Live wallet has more than one active position.');
    const position=positions[0]??null;
    if(position!==null){
      if(position.status!=='OPEN'||position.remainingRaw===null||position.mint!==result.candidate.mint)return;
      if((await this.dependencies.journal.listUnresolved(wallet)).some((order)=>order.positionId===position.positionId)){
        this.criticalAmbiguity=true;return;
      }
      const route=this.dependencies.marketResolver===undefined
        ? null : await this.dependencies.marketResolver.resolve(position);
      if(route!==null&&route.state!=='BONDING_CURVE'&&route.state!=='PUMPSWAP')return;
      const evaluation=this.dependencies.strategy.evaluateLiveExternalBuys({
        candidate:result.candidate,creator:snapshot.launch.creator,
        launchTrades:snapshot.activeLaunchTrades,marketTrades:snapshot.activeMarketTrades,
        entryCursor:position.entryCursor,minimumConfirmation:this.dependencies.minimumConfirmation,
        countedTradeIds:position.countedExternalBuyIds,externalBuyTarget:position.externalBuyTarget,
      });
      const updated=await this.dependencies.positions.recordExternalBuyEvents(
        position.positionId,evaluation.newlyCountedTradeIds,position.externalBuyTarget,
      );
      if(evaluation.targetReached&&updated.status==='OPEN'&&updated.remainingRaw!==null){
        await this.sell(result.candidate,updated,route);
      }
      return;
    }
    if(!this.acceptingEntries||this.criticalAmbiguity||result.candidate.state!=='ELIGIBLE')return;
    if((await this.dependencies.journal.listUnresolved(wallet)).length>0){this.criticalAmbiguity=true;return;}
    // One BUY is the durable first-session limit; closed positions do not reset it.
    if(await this.dependencies.journal.countBuyOrders(wallet)>0)return;
    await this.buy(result.candidate,snapshot.launch.tokenProgram);
  }

  private async buy(candidate:TradingCandidateV1,baseTokenProgram:string):Promise<void>{
    const now=this.dependencies.now();
    if(candidate.buyQuote===null||candidate.eligibleUntilMs===null||candidate.eligibleUntilMs<=now)return;
    if(candidate.strategy.id!=='validated-external-buys'||candidate.strategy.version!==1){
      throw new Error('Live command supports only validated-external-buys v1.');
    }
    if((baseTokenProgram!=='SPL_TOKEN'&&baseTokenProgram!=='TOKEN_2022')||candidate.quoteAsset.mint!==NATIVE_MINT.toBase58()
      ||candidate.quoteAsset.decimals!==9||candidate.quoteAsset.tokenProgram!=='SPL_TOKEN'){
      return;
    }
    if(candidate.quoteAsset.mint!==candidate.buyQuote.inputMint||candidate.buyQuote.outputMint!==candidate.mint
      ||this.dependencies.policy.buyAmountLamports>this.dependencies.policy.maxExposureLamports){
      throw new Error('Live candidate does not match the bounded BUY policy.');
    }
    const quoteAndState=await this.dependencies.quotes.quoteAndState({
      mint:candidate.mint,quoteAsset:candidate.quoteAsset,side:'BUY',
      amountInRaw:this.dependencies.policy.buyAmountLamports,
      slippageBps:BigInt(this.dependencies.policy.maxSlippageBps),
    });
    this.assertFresh(candidate,quoteAndState,now);
    const decodedProgramKind = quoteAndState.tokenProgram.equals(TOKEN_PROGRAM_ID) ? 'SPL_TOKEN'
      : quoteAndState.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'TOKEN_2022' : 'UNSUPPORTED';
    if (baseTokenProgram !== decodedProgramKind && baseTokenProgram !== quoteAndState.tokenProgram.toBase58()) return;
    const admission = assessLiveTokenEligibility({
      mint: candidate.mint, quoteMint: candidate.quoteAsset.mint,
      quoteTokenProgram: candidate.quoteAsset.tokenProgram,
      nowMs: this.dependencies.now(), maximumAgeMs: this.dependencies.maximumQuoteAgeMs,
      evidence: quoteAndState.admissionEvidence,
    });
    if (admission.status !== 'ACCEPTED') {
      this.dependencies.onAdmissionRejected?.(Object.freeze({candidateId:candidate.id,mint:candidate.mint,
        reason:admission.reason,stateSlot:admission.evidence.slot.toString(),receivedAtMs:admission.evidence.receivedAtMs}));
      return;
    }
    const session=this.dependencies.strategy.prepare(candidate,{
      externalBuyTarget:this.dependencies.externalBuyTarget,
      minimumConfirmation:this.dependencies.minimumConfirmation,nowMs:now,
    });
    if(session===null)throw new Error('ValidatedExternalBuysStrategy refused the live candidate.');
    const positionId=`live_position_${hash([candidate.id,this.dependencies.policy.expectedWallet])}`;
    const instructions=await this.buildInstructions('BUY',quoteAndState,this.dependencies.policy.expectedWallet);
    const orderId=`live_buy_${hash([positionId,String(this.dependencies.policy.buyAmountLamports)])}`;
    const execution=await this.execute({
      candidate,positionId,sessionId:session.id,orderId,side:'BUY',instructions,
      amountRaw:this.dependencies.policy.buyAmountLamports,maximumTokenRaw:quoteAndState.quote.amountOutRaw,
      remainingRaw:0n,entryCursor:candidate.asOf.cursor,externalBuyTarget:this.dependencies.externalBuyTarget,
      tokenProgram:quoteAndState.tokenProgram.toBase58(),
      market:'pumpfun',poolAddress:null,
      admission: {
        profileId: admission.profileId,
        characteristics: admission.characteristics,
        evidence: { ...admission.evidence, slot: admission.evidence.slot.toString() },
      },
    });
    if(execution.status!=='CONFIRMED'){this.criticalAmbiguity=true;return;}
    const position=await this.dependencies.positions.applyBuy({
      orderId,positionId,sessionId:session.id,candidateId:candidate.id,wallet:this.dependencies.policy.expectedWallet,
      mint:candidate.mint,tokenProgram:quoteAndState.tokenProgram.toBase58(),signature:execution.signature,
      entryCursor:candidate.asOf.cursor,externalBuyTarget:this.dependencies.externalBuyTarget,
      tokenBalance:execution.tokenBalance??unknownBalance(),
    });
    if(position.status==='RECONCILIATION_REQUIRED')this.criticalAmbiguity=true;
    else if(this.dependencies.marketResolver!==undefined)await this.dependencies.marketResolver.resolve(position);
  }

  private async sell(candidate:TradingCandidateV1,position:LivePositionRecord,route:LivePositionMarketResolution|null):Promise<void>{
    const amount=position.remainingRaw;
    if(position.status!=='OPEN'||amount===null||amount<=0n)return;
    let instructions:readonly TransactionInstruction[];
    let market:'pumpfun'|'pumpswap'='pumpfun';
    let poolAddress:string|null=null;
    let poolCoinCreator:string|null=null;
    let poolBaseVault:string|null=null;
    let poolQuoteVault:string|null=null;
    let cashback=false;
    let buybackFeeRecipient:string|null=null;
    let buybackFeeRecipientTokenAccount:string|null=null;
    if(route?.state==='PUMPSWAP'){
      const adapter=this.dependencies.pumpSwapSales;
      if(adapter===undefined)throw new Error('PumpSwap sell adapter is not installed in the live composition.');
      const plan=await adapter.plan({pool:route.pool,user:new PublicKey(position.wallet),amountInRaw:amount,
        slippageBps:BigInt(this.dependencies.policy.maxSlippageBps)});
      const now=this.dependencies.now();
      if(plan.quote.observedAtMs>now||now-plan.quote.observedAtMs>this.dependencies.maximumQuoteAgeMs
        ||plan.quote.stateReceivedAtMs===null||plan.quote.stateReceivedAtMs===undefined
        ||plan.quote.stateReceivedAtMs>now||plan.quote.observedSlot<=0n){
        throw new Error('PumpSwap live quote is stale or has unknown fee/state freshness.');
      }
      instructions=plan.instructions;market='pumpswap';poolAddress=plan.pool.address;
      cashback=plan.cashback;
      poolCoinCreator=plan.coinCreator;poolBaseVault=plan.pool.baseVault;poolQuoteVault=plan.pool.quoteVault;
      buybackFeeRecipient=plan.buybackFeeRecipient;buybackFeeRecipientTokenAccount=plan.buybackFeeRecipientTokenAccount;
    }else{
      const quoteAndState=await this.dependencies.quotes.quoteAndState({
        mint:position.mint,quoteAsset:candidate.quoteAsset,side:'SELL',amountInRaw:amount,
        slippageBps:BigInt(this.dependencies.policy.maxSlippageBps),
      });
      this.assertFresh(candidate,quoteAndState,this.dependencies.now());
      // Re-resolve immediately before construction: a migration observed after
      // a bonding-curve quote must route through PumpSwap, never reuse that quote.
      const current=await this.dependencies.marketResolver?.resolve(position);
      if(current!==undefined&&current.state!=='BONDING_CURVE'){
        if(current.state!=='PUMPSWAP')return;
        return this.sell(candidate,position,current);
      }
      instructions=await this.buildInstructions('SELL',quoteAndState,position.wallet);
      cashback=quoteAndState.admissionEvidence.isCashbackCoin===true;
    }
    const orderId=`live_sell_${hash([position.positionId,String(amount),market,poolAddress??''])}`;
    const execution=await this.execute({
      candidate,positionId:position.positionId,sessionId:position.sessionId,orderId,side:'SELL',instructions,
      amountRaw:amount,maximumTokenRaw:amount,remainingRaw:amount,entryCursor:position.entryCursor,
      externalBuyTarget:position.externalBuyTarget,tokenProgram:position.tokenProgram,market,poolAddress,
      poolCoinCreator,poolBaseVault,poolQuoteVault,
      buybackFeeRecipient,buybackFeeRecipientTokenAccount,
      cashback,
    });
    if(execution.status!=='CONFIRMED'){this.criticalAmbiguity=true;return;}
    const updated=await this.dependencies.positions.applySell({
      orderId,positionId:position.positionId,sessionId:position.sessionId,candidateId:position.candidateId,wallet:position.wallet,
      mint:position.mint,tokenProgram:position.tokenProgram,signature:execution.signature,entryCursor:position.entryCursor,
      externalBuyTarget:position.externalBuyTarget,tokenBalance:execution.tokenBalance??unknownBalance(),
    });
    if(updated.status==='RECONCILIATION_REQUIRED')this.criticalAmbiguity=true;
  }

  private async execute(input:{candidate:TradingCandidateV1;positionId:string;sessionId:string;orderId:string;side:'BUY'|'SELL';instructions:readonly TransactionInstruction[];amountRaw:bigint;maximumTokenRaw:bigint;remainingRaw:bigint;entryCursor:ChainCursor;externalBuyTarget:number;tokenProgram:string;market?:'pumpfun'|'pumpswap';poolAddress?:string|null;poolCoinCreator?:string|null;poolBaseVault?:string|null;poolQuoteVault?:string|null;buybackFeeRecipient?:string|null;buybackFeeRecipientTokenAccount?:string|null;admission?:Readonly<Record<string,unknown>>;cashback?:boolean}):Promise<LiveExecutionResult>{
    const wallet=this.dependencies.policy.expectedWallet;
    const intent={
      mint:input.candidate.mint,sessionId:input.sessionId,candidateId:input.candidate.id,
      tokenProgram:input.tokenProgram,externalBuyTarget:input.externalBuyTarget,
      market:input.market??'pumpfun',poolAddress:input.poolAddress??null,
      quoteMint:input.candidate.quoteAsset.mint,
      poolCoinCreator:input.poolCoinCreator??null,poolBaseVault:input.poolBaseVault??null,
      poolQuoteVault:input.poolQuoteVault??null,
      admission:input.admission??null,
      cashback:input.cashback??false,
      buybackFeeRecipient:input.buybackFeeRecipient??null,
      buybackFeeRecipientTokenAccount:input.buybackFeeRecipientTokenAccount??null,
      entryCursor:{slot:input.entryCursor.slot.toString(),transactionIndex:input.entryCursor.transactionIndex,
        instructionIndex:input.entryCursor.instructionIndex,innerInstructionIndex:input.entryCursor.innerInstructionIndex},
    };
    const allowedAccounts=new Set<string>([wallet]);
    for(const instruction of input.instructions){
      allowedAccounts.add(instruction.programId.toBase58());
      for(const key of instruction.keys)allowedAccounts.add(key.pubkey.toBase58());
    }
    return this.dependencies.executor.execute({
      order:{orderId:input.orderId,wallet,positionId:input.positionId,side:input.side,intent,
        validity:{sourceEventId:input.candidate.asOf.eventId}},
      instructions:input.instructions,allowedAccounts,
      maxSpendRaw:input.side==='BUY'?this.dependencies.policy.buyAmountLamports:0n,
      maxTokenAmountRaw:input.maximumTokenRaw,positionRemainingRaw:input.remainingRaw,
    });
  }

  private async buildInstructions(side:'BUY'|'SELL',state:PumpFunQuoteAndState,wallet:string):Promise<readonly TransactionInstruction[]>{
    const owner=new PublicKey(wallet);
    const ata=await this.dependencies.readAssociatedTokenAccount(state.mint,owner,state.tokenProgram);
    return createPumpFunBondingCurveInstructions({side,quoteAndState:state,associatedUserAccountInfo:ata,user:owner});
  }

  private assertFresh(candidate:TradingCandidateV1,state:PumpFunQuoteAndState,now:number):void{
    const quote=state.quote;
    if(quote.observedAtMs>now||now-quote.observedAtMs>this.dependencies.maximumQuoteAgeMs
      ||quote.observedSlot!==state.stateSlot||state.mint.toBase58()!==candidate.mint){
      throw new Error('Live quote is stale or inconsistent with the listener candidate.');
    }
  }

  private async applyExecution(order:UnresolvedLiveOrder,result:LiveExecutionResult):Promise<void>{
    if(result.status!=='CONFIRMED')return;
    const fill=fillFromOrder(order,result.signature,result.tokenBalance??unknownBalance());
    if(order.side==='BUY')await this.dependencies.positions.applyBuy(fill);
    else await this.dependencies.positions.applySell(fill);
  }

  private async applyStoredConfirmation(order:ConfirmedLiveOrderNeedingFill):Promise<void>{
    const signature=order.signature;
    if(signature===null)throw new Error('Confirmed live order awaiting fill has no signature.');
    const fill=fillFromOrder(order,signature,parseStoredBalance(order.transactionMetadata.tokenBalance));
    if(order.side==='BUY')await this.dependencies.positions.applyBuy(fill);
    else await this.dependencies.positions.applySell(fill);
  }
}

export function fillFromOrder(order:UnresolvedLiveOrder|ConfirmedLiveOrderNeedingFill,signature:string,tokenBalance:LiveTokenBalanceReconciliation):LivePositionFillInput{
  const intent=order.intent;
  const text=(key:string):string=>{const value=intent[key];if(typeof value!=='string'||value.length===0)throw new Error(`Persisted order ${key} is missing.`);return value;};
  const cursor=intent.entryCursor;
  if(typeof cursor!=='object'||cursor===null||Array.isArray(cursor))throw new Error('Persisted entry cursor is malformed.');
  const record=cursor as Record<string,unknown>;
  const integer=(key:string):number=>{const value=record[key];if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('Persisted entry cursor is malformed.');return value;};
  const inner=record.innerInstructionIndex;
  if(inner!==null&&(!Number.isSafeInteger(inner)||typeof inner!=='number'||inner<0))throw new Error('Persisted entry cursor is malformed.');
  const target=intent.externalBuyTarget;
  if(typeof target!=='number'||!Number.isSafeInteger(target))throw new Error('Persisted strategy target is malformed.');
  return {orderId:order.orderId,positionId:order.positionId,sessionId:text('sessionId'),candidateId:text('candidateId'),
    wallet:order.wallet,mint:text('mint'),tokenProgram:text('tokenProgram'),externalBuyTarget:target,
    entryCursor:{slot:BigInt(String(record.slot)),transactionIndex:integer('transactionIndex'),
      instructionIndex:integer('instructionIndex'),innerInstructionIndex:inner},signature,tokenBalance};
}
export function parseStoredBalance(value:unknown):LiveTokenBalanceReconciliation{
  if(typeof value!=='object'||value===null)return unknownBalance();
  const record=value as Record<string,unknown>;
  if(record.status==='KNOWN'&&typeof record.owner==='string'&&typeof record.mint==='string'
    &&typeof record.preAmountRaw==='string'&&typeof record.postAmountRaw==='string'&&typeof record.deltaRaw==='string'){
    return {status:'KNOWN',owner:record.owner,mint:record.mint,preAmountRaw:BigInt(record.preAmountRaw),
      postAmountRaw:BigInt(record.postAmountRaw),deltaRaw:BigInt(record.deltaRaw)};
  }
  const allowed=['TRANSACTION_MISSING','EXECUTION_FAILED','METADATA_MISSING','TOKEN_BALANCES_MISSING','OWNER_OR_MINT_MISSING'] as const;
  const reason=allowed.find((value)=>value===record.reason)??'TOKEN_BALANCES_MISSING';
  return {status:'UNKNOWN',reason};
}
function unknownBalance():LiveTokenBalanceReconciliation{return {status:'UNKNOWN',reason:'TOKEN_BALANCES_MISSING'};}
function hash(parts:readonly string[]):string{return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,48);}
