import { createHash } from 'node:crypto';
import { createDeterministicDerivedEventId, type DomainEvent } from '../domain/events.js';
import type { PaperStrategySessionV1 } from '../domain/paper-strategy.js';
import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import type { ListenerRuntimeState } from '../domain/transaction-ingestion.js';
import type { QuoteAsset } from '../domain/types.js';
import type {
  ClaimedPaperDecisionJob,
  PaperDecisionFailure,
  PaperDecisionRepository,
  PaperDecisionResult,
  PaperDecisionSnapshot,
} from '../ports/paper-decision-repository.js';
import { PaperQuoteError, type PaperQuoteRouter } from '../ports/paper-quote-router.js';
import { canonicalStringifyJson } from '../utils/json.js';
import type {
  QualificationRebuildInput,
  RebuiltQualification,
} from './qualification-rebuild.service.js';
import type {
  TradingCandidateResult,
  TradingCandidateService,
} from './trading-candidate.service.js';
import type {
  ExternalBuysStrategyResult,
  ValidatedExternalBuysStrategy,
} from './validated-external-buys.strategy.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface PaperDecisionWorkerOptions {
  readonly executionMode: 'observe' | 'paper';
  readonly paperStrategyEnabled: boolean;
  readonly quoteMintAllowlist: readonly string[];
  readonly entryQuoteAmountRaw: bigint;
  readonly slippageBps: bigint;
  readonly externalBuyTarget: number;
  readonly minimumConfirmation: 'confirmed' | 'finalized';
  readonly maximumRoundTripLossBps: bigint;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly renewalIntervalMs: number;
  readonly shutdownTimeoutMs: number;
}

export interface PaperDecisionWorkerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  now(): number;
}

export type PaperDecisionRunResult =
  | Readonly<{ kind: 'idle' | 'closed' }>
  | Readonly<{ kind: 'completed' | 'failed' | 'lease-lost'; jobId: string }>;

export class PaperDecisionWorkerError extends Error {
  public constructor(public readonly stage: 'claim' | 'snapshot' | 'stage' | 'complete' | 'fail' | 'clock') {
    super('Paper decision worker operation failed.');
    this.name = 'PaperDecisionWorkerError';
  }
}

interface QualificationRebuilder {
  rebuild(input: QualificationRebuildInput): RebuiltQualification;
}

interface CandidateBuilder {
  create(
    input: Parameters<TradingCandidateService['create']>[0],
  ): TradingCandidateResult | Promise<TradingCandidateResult>;
}

interface StrategyActions {
  prepare: ValidatedExternalBuysStrategy['prepare'];
  open: ValidatedExternalBuysStrategy['open'];
  reconcile: ValidatedExternalBuysStrategy['reconcile'];
}

const systemScheduler: PaperDecisionWorkerScheduler = Object.freeze({
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  },
  cancel(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now:Date.now,
});

export class PaperDecisionWorker {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private scheduledHandle: unknown = null;
  private inFlight: Promise<void> | null = null;
  private runTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private activeLease: PaperLeaseGuard | null = null;
  private started = false;
  private permanentlyClosed = false;

  public constructor(
    private readonly repository: PaperDecisionRepository,
    private readonly quotes: PaperQuoteRouter,
    private readonly qualification: QualificationRebuilder,
    private readonly candidates: CandidateBuilder,
    private readonly strategy: StrategyActions,
    private readonly options: PaperDecisionWorkerOptions,
    private readonly scheduler: PaperDecisionWorkerScheduler = systemScheduler,
  ) {
    validateOptions(options);
  }

  public get state(): ListenerRuntimeState { return this.currentState; }

  public start(): Promise<void> {
    if (this.permanentlyClosed || this.started) return Promise.resolve();
    this.started=true;
    this.currentState='STARTING';
    this.scheduleNext(0);
    this.currentState='RUNNING';
    return Promise.resolve();
  }

  public runOnce(): Promise<PaperDecisionRunResult> {
    const operation=this.runTail.then(() => this.performRunOnce());
    this.runTail=operation.then(() => undefined,() => undefined);
    return operation;
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.permanentlyClosed=true;
    this.started=false;
    this.currentState='STOPPING';
    if (this.scheduledHandle !== null) {
      this.scheduler.cancel(this.scheduledHandle);
      this.scheduledHandle=null;
    }
    this.closePromise=this.finishClose();
    return this.closePromise;
  }

  private async performRunOnce(): Promise<PaperDecisionRunResult> {
    if (this.permanentlyClosed) return Object.freeze({ kind:'closed' as const });
    let job: ClaimedPaperDecisionJob | null;
    try {
      job=await this.repository.claim({ leaseMs:this.options.leaseMs,nowMs:this.readNow() });
    } catch {
      this.currentState='DEGRADED';
      throw new PaperDecisionWorkerError('claim');
    }
    if (job === null) return Object.freeze({ kind:'idle' as const });
    const lease=new PaperLeaseGuard(
      job,this.repository,this.scheduler,this.options.leaseMs,
      this.options.renewalIntervalMs,() => this.readNow(),
    );
    this.activeLease=lease;
    lease.start();

    let snapshot: PaperDecisionSnapshot;
    try {
      snapshot=await this.repository.loadSnapshot(job);
    } catch {
      return this.fail(job,lease,'RPC_TRANSIENT',true,null);
    }

    const paperEnabled=this.options.executionMode === 'paper' && this.options.paperStrategyEnabled;
    if (
      paperEnabled
      && snapshot.currentSession !== null
      && snapshot.currentSession.state !== 'BUY_PENDING'
    ) return this.reconcileExisting(job,lease,snapshot);

    const quoteAsset=snapshot.launch.quoteAssets.find((asset) => (
      this.options.quoteMintAllowlist.includes(asset.mint)
    )) ?? null;
    let buyQuote: PaperExecutionQuote | null | undefined;
    let reverseSellQuote: PaperExecutionQuote | null | undefined;
    let quoteFailure: PaperQuoteError | null = null;
    if (paperEnabled && quoteAsset !== null) {
      try {
        buyQuote=await this.quotes.quote({
          mint:snapshot.mint,quoteAsset,side:'BUY',
          amountInRaw:this.options.entryQuoteAmountRaw,slippageBps:this.options.slippageBps,
        });
        reverseSellQuote=await this.quotes.quote({
          mint:snapshot.mint,quoteAsset,side:'SELL',
          amountInRaw:buyQuote.minimumAmountOutRaw,slippageBps:this.options.slippageBps,
        });
      } catch (error: unknown) {
        quoteFailure=error instanceof PaperQuoteError
          ? error
          : new PaperQuoteError('QUOTE_STATE_INCONSISTENT','Paper quote failed.');
        if (buyQuote === undefined) buyQuote=null;
        else reverseSellQuote=null;
      }
    }
    const upstreamConditions = quoteAsset === null
      ? Object.freeze([Object.freeze({ code:'UNSUPPORTED_QUOTE_MINT' as const,triggered:true })])
      : Object.freeze([Object.freeze({ code:'UNSUPPORTED_QUOTE_MINT' as const,triggered:false })]);
    let rebuilt: RebuiltQualification;
    let candidateResult: TradingCandidateResult;
    try {
      rebuilt=this.qualification.rebuild({
        snapshot,buyQuote,reverseSellQuote,upstreamConditions,
      });
      candidateResult=await this.candidates.create({
        snapshot,report:rebuilt.report,reportId:rebuilt.reportId,
        qualificationEvent:rebuilt.event,evidenceFingerprint:rebuilt.evidenceFingerprint,
        quoteAsset:quoteAsset ?? snapshot.launch.quoteAssets[0] ?? fallbackQuoteAsset(),
        buyQuote:buyQuote ?? null,reverseSellQuote:reverseSellQuote ?? null,
        nowMs:this.readNow(),
      });
    } catch {
      return this.fail(job,lease,'DECISION_INVALID',false,null);
    }
    const base=decision(rebuilt,candidateResult,null,null,[],'NONE');
    if (quoteFailure !== null) {
      return this.fail(job,lease,'QUOTE_UNAVAILABLE',quoteFailure.retryable,base);
    }
    if (!paperEnabled || candidateResult.candidate.state !== 'ELIGIBLE') {
      return this.complete(job,lease,base);
    }

    const session=snapshot.currentSession;
    if (session === null || session.state === 'BUY_PENDING') {
      const pending=session ?? this.strategy.prepare(candidateResult.candidate, {
        externalBuyTarget:this.options.externalBuyTarget,
        minimumConfirmation:this.options.minimumConfirmation,nowMs:this.readNow(),
      });
      if (pending === null) return this.complete(job,lease,base);
      const pendingEvent=sessionEvent(pending,rebuilt.event);
      const staged=decision(rebuilt,candidateResult,pending,pendingEvent,[],'OPEN');
      if (!await lease.checkpoint()) return this.leaseLost(job,lease);
      try {
        await this.repository.stageDecision(job,staged);
      } catch {
        return this.fail(job,lease,'RPC_TRANSIENT',true,staged);
      }
      if (!await lease.checkpoint()) return this.leaseLost(job,lease);
      let opened: ExternalBuysStrategyResult;
      try {
        opened=await this.strategy.open({
          candidate:candidateResult.candidate,session:pending,
          qualification:rebuilt.report,qualificationEvent:rebuilt.event,
          maximumRoundTripLossBps:this.options.maximumRoundTripLossBps,
        });
      } catch {
        return this.fail(job,lease,'DECISION_INVALID',false,staged);
      }
      return this.complete(job,lease,decision(
        rebuilt,candidateResult,opened.session,opened.sessionEvent,
        opened.countedExternalBuys,opened.requestedAction,
      ));
    }
    return this.fail(job,lease,'DECISION_INVALID',false,base);
  }

  private async reconcileExisting(
    job: ClaimedPaperDecisionJob,
    lease: PaperLeaseGuard,
    snapshot: PaperDecisionSnapshot,
  ): Promise<PaperDecisionRunResult> {
    const session=snapshot.currentSession;
    const candidate=snapshot.currentCandidate;
    const persisted=snapshot.currentDecision;
    if (session === null || candidate === null || persisted === null) {
      return this.fail(job,lease,'DECISION_INVALID',false,null);
    }
    const context: RebuiltQualification=Object.freeze({
      reportId:persisted.reportId,reportEventId:persisted.qualificationEvent.id,
      evidenceFingerprint:persisted.evidenceFingerprint,
      evaluation:Object.freeze({
        evaluatedAtMs:persisted.report.evaluatedAtMs,signals:Object.freeze({}),
        blockers:Object.freeze([]),calibrationFacts:null,
      }),report:persisted.report,event:persisted.qualificationEvent,
    });
    const candidateResult:TradingCandidateResult=Object.freeze({
      candidate,event:persisted.candidateEvent,
    });
    if (['PAPER_CLOSED','PAPER_RETRACTED','MANUAL_REVIEW'].includes(session.state)) {
      return this.complete(job,lease,decision(
        context,candidateResult,session,sessionEvent(session,persisted.candidateEvent),[],'NONE',
      ));
    }
    if (snapshot.activePosition === null || session.candidateId !== candidate.id) {
      const now=this.readNow();
      const manual=Object.freeze({
        ...session,state:'MANUAL_REVIEW' as const,reasonCode:'RECONCILIATION_REQUIRED' as const,
        lastError:Object.freeze({
          code:'POSITION_NOT_FOUND',message:'Active paper position or candidate is unavailable.',retryable:false,
        }),updatedAtMs:now,purgeAfterMs:now+14_400_000,
      });
      const terminal=decision(
        context,candidateResult,manual,sessionEvent(manual,persisted.candidateEvent),[],'NONE',
      );
      return this.fail(job,lease,'DECISION_INVALID',false,terminal);
    }
    let reconciled:ExternalBuysStrategyResult;
    try {
      const staged=decision(
        context,candidateResult,session,sessionEvent(session,persisted.candidateEvent),[],'NONE',
      );
      if (!await lease.checkpoint()) return await this.leaseLost(job,lease);
      await this.repository.stageDecision(job,staged);
      reconciled=await this.strategy.reconcile({
        candidate,session,position:snapshot.activePosition,creator:snapshot.launch.creator,
        launchTrades:snapshot.activeLaunchTrades,marketTrades:snapshot.activeMarketTrades,
        nowMs:this.readNow(),
      });
    } catch (error:unknown) {
      const retryable=error instanceof PaperQuoteError&&error.retryable;
      return this.fail(
        job,lease,retryable?'QUOTE_UNAVAILABLE':'DECISION_INVALID',retryable,null,
      );
    }
    return this.complete(job,lease,decision(
      context,candidateResult,reconciled.session,reconciled.sessionEvent,
      reconciled.countedExternalBuys,reconciled.requestedAction,
    ));
  }

  private async complete(
    job: ClaimedPaperDecisionJob,
    lease: PaperLeaseGuard,
    value: PaperDecisionResult,
  ): Promise<PaperDecisionRunResult> {
    if (!await this.finishLease(lease)) return Object.freeze({ kind:'lease-lost' as const,jobId:job.jobId });
    try { await this.repository.complete(job,value); }
    catch { this.currentState='DEGRADED';throw new PaperDecisionWorkerError('complete'); }
    return Object.freeze({ kind:'completed' as const,jobId:job.jobId });
  }

  private async fail(
    job: ClaimedPaperDecisionJob,
    lease: PaperLeaseGuard,
    code: PaperDecisionFailure['code'],
    retryable: boolean,
    terminalResult: PaperDecisionResult | null,
  ): Promise<PaperDecisionRunResult> {
    if (!await this.finishLease(lease)) return Object.freeze({ kind:'lease-lost' as const,jobId:job.jobId });
    try {
      await this.repository.fail(job,Object.freeze({ code,retryable,terminalResult }));
    } catch { this.currentState='DEGRADED';throw new PaperDecisionWorkerError('fail'); }
    return Object.freeze({ kind:'failed' as const,jobId:job.jobId });
  }

  private async leaseLost(job: ClaimedPaperDecisionJob, lease: PaperLeaseGuard): Promise<PaperDecisionRunResult> {
    await this.finishLease(lease);
    return Object.freeze({ kind:'lease-lost' as const,jobId:job.jobId });
  }

  private async finishLease(lease: PaperLeaseGuard): Promise<boolean> {
    const owned=await lease.finish();
    if (this.activeLease === lease) this.activeLease=null;
    return owned;
  }

  private scheduleNext(delayMs:number):void {
    if (this.permanentlyClosed || !this.started || this.scheduledHandle !== null) return;
    this.scheduledHandle=this.scheduler.schedule(() => {
      this.scheduledHandle=null;
      const operation=this.tick();this.inFlight=operation;
      void operation.finally(() => { if (this.inFlight === operation) this.inFlight=null; });
    },delayMs);
  }

  private async tick():Promise<void> {
    try { await this.runOnce(); } catch { this.currentState='DEGRADED'; }
    if (!this.permanentlyClosed && this.started) this.scheduleNext(this.options.pollIntervalMs);
  }

  private async finishClose():Promise<void> {
    const completed=await settleWithin(this.inFlight ?? this.runTail,this.options.shutdownTimeoutMs);
    if (!completed) { this.activeLease?.abandon();this.activeLease=null; }
    this.currentState=completed?'STOPPED':'DEGRADED';
  }

  private readNow():number {
    let value:number;
    try { value=this.scheduler.now(); }
    catch { this.currentState='DEGRADED';throw new PaperDecisionWorkerError('clock'); }
    if (!Number.isSafeInteger(value)||value<0||Object.is(value,-0)) {
      this.currentState='DEGRADED';throw new PaperDecisionWorkerError('clock');
    }
    return value;
  }
}

class PaperLeaseGuard {
  private handle:unknown=null;
  private renewing:Promise<void>|null=null;
  private stopped=false;
  private abandoned=false;
  private stillOwned=true;
  public constructor(
    private readonly job:ClaimedPaperDecisionJob,
    private readonly repository:PaperDecisionRepository,
    private readonly scheduler:PaperDecisionWorkerScheduler,
    private readonly leaseMs:number,
    private readonly renewalIntervalMs:number,
    private readonly now:()=>number,
  ) {}
  public get owned():boolean { return this.stillOwned; }
  public start():void { this.schedule(); }
  public async checkpoint():Promise<boolean> {
    if(this.renewing!==null)await this.renewing;
    return this.stillOwned;
  }
  public async finish():Promise<boolean> {
    this.stopped=true;
    if(this.handle!==null){this.scheduler.cancel(this.handle);this.handle=null;}
    if(this.renewing!==null)await this.renewing;
    return this.stillOwned;
  }
  public abandon():void {
    this.abandoned=true;this.stopped=true;this.stillOwned=false;
    if(this.handle!==null){this.scheduler.cancel(this.handle);this.handle=null;}
  }
  private schedule():void {
    if(this.stopped||!this.stillOwned)return;
    this.handle=this.scheduler.schedule(() => {
      this.handle=null;const operation=this.renew();this.renewing=operation;
      void operation.finally(()=>{if(this.renewing===operation)this.renewing=null;});
    },this.renewalIntervalMs);
  }
  private async renew():Promise<void> {
    try {
      const renewed=await this.repository.renew(this.job,this.now(),this.leaseMs);
      if(!this.abandoned)this.stillOwned=renewed;
    } catch { this.stillOwned=false; }
    if(!this.stopped&&this.stillOwned)this.schedule();
  }
}

function decision(
  rebuilt:RebuiltQualification,
  candidate:TradingCandidateResult,
  session:PaperStrategySessionV1|null,
  sessionEvent:DomainEvent|null,
  countedExternalBuys:PaperDecisionResult['countedExternalBuys'],
  requestedAction:PaperDecisionResult['requestedAction'],
):PaperDecisionResult {
  return Object.freeze({
    report:rebuilt.report,qualificationEvent:rebuilt.event,candidate:candidate.candidate,
    candidateEvent:candidate.event,session,sessionEvent,
    countedExternalBuys:Object.freeze([...countedExternalBuys]),requestedAction,
  });
}

function sessionEvent(session:PaperStrategySessionV1,trigger:DomainEvent):DomainEvent {
  const id=createDeterministicDerivedEventId({
    type:'PaperStrategySessionUpdated',mint:session.mint,source:'paper-decision',
    program:trigger.program,signature:trigger.signature,cursor:trigger.cursor,
    qualifier:`${session.id}:${hash(canonicalStringifyJson(session))}`,
  });
  return Object.freeze({
    id,type:'PaperStrategySessionUpdated',mint:session.mint,source:'paper-decision',
    program:trigger.program,signature:trigger.signature,cursor:trigger.cursor,
    confirmationStatus:trigger.confirmationStatus,blockchainTimeMs:trigger.blockchainTimeMs,
    observedAtMs:session.updatedAtMs,payloadVersion:1,payload:Object.freeze({ session }),
  });
}

function fallbackQuoteAsset(): QuoteAsset {
  return Object.freeze({ mint:'UNSUPPORTED',decimals:0,tokenProgram:'SPL_TOKEN' as const });
}

function validateOptions(options:PaperDecisionWorkerOptions):void {
  if(
    options.quoteMintAllowlist.length===0
    || options.entryQuoteAmountRaw<=0n
    || options.slippageBps<0n||options.slippageBps>10_000n
    || !Number.isSafeInteger(options.externalBuyTarget)||options.externalBuyTarget<1||options.externalBuyTarget>1_000
    || options.maximumRoundTripLossBps<0n||options.maximumRoundTripLossBps>10_000n
  )throw new TypeError('Paper decision worker strategy options are invalid.');
  for(const [name,value] of [
    ['pollIntervalMs',options.pollIntervalMs],['leaseMs',options.leaseMs],
    ['renewalIntervalMs',options.renewalIntervalMs],['shutdownTimeoutMs',options.shutdownTimeoutMs],
  ] as const){
    if(!Number.isSafeInteger(value)||value<=0||value>MAX_TIMER_DELAY_MS)throw new RangeError(`${name} is invalid.`);
  }
  if(options.renewalIntervalMs>=options.leaseMs)throw new RangeError('Paper lease renewal must precede expiry.');
  if(options.paperStrategyEnabled&&options.executionMode!=='paper')throw new TypeError('Paper strategy requires paper mode.');
}

async function settleWithin(promise:Promise<void>,timeoutMs:number):Promise<boolean>{
  let handle!:ReturnType<typeof setTimeout>;
  try{return await Promise.race([
    promise.then(()=>true,()=>true),
    new Promise<boolean>((resolve)=>{handle=setTimeout(()=>{ resolve(false); },timeoutMs);}),
  ]);}finally{clearTimeout(handle);}
}

function hash(value:string):string{return createHash('sha256').update(value).digest('hex');}
