import { createHash } from 'node:crypto';
import { compareCursors } from '../domain/cursor.js';
import { createDeterministicDerivedEventId, type DomainEvent } from '../domain/events.js';
import type { PaperStrategySession } from '../domain/paper-strategy.js';
import { PaperTradingError,type PaperExecutionQuote } from '../domain/paper-trading.js';
import type { ListenerRuntimeState } from '../domain/transaction-ingestion.js';
import type { QuoteAsset } from '../domain/types.js';
import type { CanonicalQualificationProjection } from '../ports/qualification-projection-repository.js';
import type {
  ClaimedPaperDecisionJob,
  PaperDecisionFailure,
  PaperDecisionRepository,
  PaperDecisionResult,
  PaperDecisionSnapshot,
} from '../ports/paper-decision-repository.js';
import { PaperQuoteError, type PaperQuoteRouter } from '../ports/paper-quote-router.js';
import { canonicalStringifyJson } from '../utils/json.js';
import type { RebuiltQualification } from './qualification-rebuild.service.js';
import type {
  TradingCandidateResult,
  TradingCandidateService,
} from './trading-candidate.service.js';
import type {
  ExternalBuysStrategyResult,
  ValidatedExternalBuysStrategy,
} from './validated-external-buys.strategy.js';
import type {
  CreationEntryStrategyResult,
  CreationEntryV1Strategy,
} from './creation-entry-v1.strategy.js';

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
  readonly manualKillSwitch: boolean;
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
  reauthorize(projection: CanonicalQualificationProjection): RebuiltQualification;
}

interface CandidateBuilder {
  create(
    input: Parameters<TradingCandidateService['create']>[0],
  ): TradingCandidateResult | Promise<TradingCandidateResult>;
}

type StrategyActions = Pick<ValidatedExternalBuysStrategy,
'prepare' | 'open' | 'recoverOpen' | 'reconcile' | 'reconcileSource' | 'reconcileEvidence'
> | Pick<CreationEntryV1Strategy,
'prepare' | 'open' | 'recoverOpen' | 'reconcile' | 'reconcileSource' | 'reconcileEvidence'
>;

type StrategyResult = ExternalBuysStrategyResult | CreationEntryStrategyResult;

export interface PaperDecisionStrategyRegistry {
  readonly kind: 'paper-decision-strategy-registry';
  readonly activeStrategyId: 'validated-external-buys' | 'creation-entry-v1';
  readonly legacy: ValidatedExternalBuysStrategy;
  readonly creation: CreationEntryV1Strategy;
}

type StrategyProvider = StrategyActions | PaperDecisionStrategyRegistry;

export function createPaperDecisionStrategyRegistry(input: Readonly<{
  activeStrategyId: PaperDecisionStrategyRegistry['activeStrategyId'];
  legacy: ValidatedExternalBuysStrategy;
  creation: CreationEntryV1Strategy;
}>): PaperDecisionStrategyRegistry {
  return Object.freeze({ kind:'paper-decision-strategy-registry', ...input });
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
  private activeSessionsWoken = false;

  public constructor(
    private readonly repository: PaperDecisionRepository,
    private readonly quotes: PaperQuoteRouter,
    private readonly qualification: QualificationRebuilder,
    private readonly candidates: CandidateBuilder,
    private readonly strategy: StrategyProvider,
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
    if (this.options.manualKillSwitch && !this.activeSessionsWoken) {
      try {
        await this.repository.enqueueActiveSessions(this.readNow());
        this.activeSessionsWoken=true;
      } catch {
        this.currentState='DEGRADED';
        throw new PaperDecisionWorkerError('claim');
      }
    }
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
    ) return this.reconcileExisting(job,lease,snapshot);

    const persisted=snapshot.currentQualification;
    if (persisted === null) {
      if (
        !snapshot.canonicalLaunchActive
        && snapshot.currentCandidate === null
        && snapshot.currentDecision === null
        && snapshot.currentSession === null
        && snapshot.activePosition === null
      ) return snapshot.hasPaperLineage
        ? this.completeObsolete(job,lease)
        : this.completeNoop(job,lease);
      return this.fail(job,lease,'RPC_TRANSIENT',true,null);
    }

    let rebuilt:RebuiltQualification;
    try {
      rebuilt=authorizedQualification(this.qualification.reauthorize(persisted),persisted);
    } catch {
      return this.fail(job,lease,'DECISION_INVALID',false,null);
    }

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
    let candidateResult: TradingCandidateResult;
    try {
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
      const pending=session ?? activeStrategy(this.strategy).prepare(candidateResult.candidate, {
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
      let opened: StrategyResult;
      try {
        opened=await openStrategy(this.strategy, {
          candidate:candidateResult.candidate,session:pending,
          qualification:rebuilt.report,qualificationEvent:rebuilt.event,
          maximumRoundTripLossBps:this.options.maximumRoundTripLossBps,
          entryDecisionAtMs:job.createdAtMs,
          entryDecisionJobId:job.jobId,
        });
      } catch (error:unknown) {
        if(isQualificationNotCurrent(error)){
          return this.fail(job,lease,'RPC_TRANSIENT',true,null);
        }
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
    const decisionSnapshot=snapshot.currentDecision;
    if (session === null || candidate === null || decisionSnapshot === null) {
      return this.fail(job,lease,'DECISION_INVALID',false,null);
    }
    let context:RebuiltQualification;
    try {
      context=authorizedQualification(
        this.qualification.reauthorize(decisionSnapshot.qualification),
        decisionSnapshot.qualification,
      );
    } catch {
      return this.fail(job,lease,'DECISION_INVALID',false,null);
    }
    const candidateResult:TradingCandidateResult=Object.freeze({
      candidate,event:decisionSnapshot.candidateEvent,
    });
    if (
      ['PAPER_CLOSED','PAPER_RETRACTED','MANUAL_REVIEW'].includes(session.state)
      && (
        snapshot.asOfEvent.confirmationStatus !== 'orphaned'
        || session.state === 'PAPER_RETRACTED'
      )
    ) {
      return this.complete(job,lease,decision(
        context,candidateResult,session,sessionEvent(session,decisionSnapshot.candidateEvent),[],'NONE',
      ));
    }
    if(
      session.state==='BUY_PENDING'
      &&snapshot.activePosition===null
      &&snapshot.asOfEvent.confirmationStatus!=='orphaned'
    ){
      let qualificationIsCurrent=false;
      if(snapshot.currentQualification!==null){
        try{
          this.qualification.reauthorize(snapshot.currentQualification);
          qualificationIsCurrent=canonicalStringifyJson(snapshot.currentQualification)
            ===canonicalStringifyJson(decisionSnapshot.qualification);
        }catch{
          qualificationIsCurrent=false;
        }
      }
      if(!qualificationIsCurrent){
        return this.fail(job,lease,'RPC_TRANSIENT',true,null);
      }
      const staged=decision(
        context,candidateResult,session,sessionEvent(session,decisionSnapshot.candidateEvent),[],'OPEN',
      );
      if(!await lease.checkpoint())return this.leaseLost(job,lease);
      try{await this.repository.stageDecision(job,staged);}
      catch{return this.fail(job,lease,'RPC_TRANSIENT',true,staged);}
      if(!await lease.checkpoint())return this.leaseLost(job,lease);
      let opened:StrategyResult;
      try{
        opened=await openStrategy(this.strategy, {
          candidate,session,qualification:context.report,qualificationEvent:context.event,
          maximumRoundTripLossBps:this.options.maximumRoundTripLossBps,
          entryDecisionAtMs:job.createdAtMs,
          entryDecisionJobId:job.jobId,
        });
      }catch(error:unknown){
        if(isQualificationNotCurrent(error)){
          return this.fail(job,lease,'RPC_TRANSIENT',true,null);
        }
        return this.fail(job,lease,'DECISION_INVALID',false,staged);
      }
      return this.complete(job,lease,decision(
        context,candidateResult,opened.session,opened.sessionEvent,
        opened.countedExternalBuys,opened.requestedAction,
      ));
    }
    if (snapshot.activePosition === null || session.candidateId !== candidate.id) {
      const terminal=manualReviewDecision(
        context,candidateResult,session,decisionSnapshot.candidateEvent,this.readNow(),
      );
      return this.fail(job,lease,'DECISION_INVALID',false,terminal);
    }
    let reconciled:StrategyResult;
    try {
      const staged=decision(
        context,candidateResult,session,sessionEvent(session,decisionSnapshot.candidateEvent),[],'NONE',
      );
      if (!await lease.checkpoint()) return await this.leaseLost(job,lease);
      await this.repository.stageDecision(job,staged);
      if (!await lease.checkpoint()) return await this.leaseLost(job,lease);
      if (snapshot.asOfEvent.confirmationStatus === 'orphaned') {
        reconciled=snapshot.asOfEvent.type === 'TokenLaunchDetected'
          || compareCursors(candidate.asOf.cursor,snapshot.asOfEvent.cursor) === 0
          ? await reconcileStrategySource(this.strategy, {
            candidate,session,qualification:context.report,
            qualificationEvent:context.event,
            maximumRoundTripLossBps:this.options.maximumRoundTripLossBps,
          })
          : await reconcileStrategyEvidence(this.strategy, {
            candidate,session,position:snapshot.activePosition,
            creator:snapshot.launch.creator,launchTrades:snapshot.activeLaunchTrades,
            marketTrades:snapshot.activeMarketTrades,orphanedEvent:snapshot.asOfEvent,
            nowMs:this.readNow(),
          });
      } else if (session.state === 'BUY_PENDING') {
        reconciled=await recoverOpenStrategy(this.strategy, {
          candidate,session,qualification:context.report,
          qualificationEvent:context.event,
          maximumRoundTripLossBps:this.options.maximumRoundTripLossBps,
        });
      } else {
        reconciled=await reconcileStrategy(this.strategy, {
          candidate,session,position:snapshot.activePosition,creator:snapshot.launch.creator,
          launchTrades:snapshot.activeLaunchTrades,marketTrades:snapshot.activeMarketTrades,
          nowMs:this.readNow(),contextEvent:decisionSnapshot.candidateEvent,
        });
      }
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

  private async completeNoop(
    job: ClaimedPaperDecisionJob,
    lease: PaperLeaseGuard,
  ): Promise<PaperDecisionRunResult> {
    if (!await this.finishLease(lease)) {
      return Object.freeze({ kind:'lease-lost' as const,jobId:job.jobId });
    }
    try { await this.repository.completeNoop(job); }
    catch { this.currentState='DEGRADED';throw new PaperDecisionWorkerError('complete'); }
    return Object.freeze({ kind:'completed' as const,jobId:job.jobId });
  }

  private async completeObsolete(
    job: ClaimedPaperDecisionJob,
    lease: PaperLeaseGuard,
  ): Promise<PaperDecisionRunResult> {
    if (!await this.finishLease(lease)) {
      return Object.freeze({ kind:'lease-lost' as const,jobId:job.jobId });
    }
    try { await this.repository.completeObsolete(job); }
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

type LegacyOpenInput = Parameters<ValidatedExternalBuysStrategy['open']>[0];
type CreationOpenInput = Parameters<CreationEntryV1Strategy['open']>[0];
type LegacyReconcileInput = Parameters<ValidatedExternalBuysStrategy['reconcile']>[0];
type CreationReconcileInput = Parameters<CreationEntryV1Strategy['reconcile']>[0];
type LegacySourceInput = Parameters<ValidatedExternalBuysStrategy['reconcileSource']>[0];
type CreationSourceInput = Parameters<CreationEntryV1Strategy['reconcileSource']>[0];
type LegacyEvidenceInput = Parameters<ValidatedExternalBuysStrategy['reconcileEvidence']>[0];
type CreationEvidenceInput = Parameters<CreationEntryV1Strategy['reconcileEvidence']>[0];
type AnyOpenInput = Omit<LegacyOpenInput, 'session'> & Readonly<{
  session: PaperStrategySession;
  entryDecisionAtMs?: number;
  entryDecisionJobId?: string;
}>;
type AnyReconcileInput = Omit<LegacyReconcileInput, 'session'> & Readonly<{
  session: PaperStrategySession;
  contextEvent?: DomainEvent;
}>;
type AnySourceInput = Omit<LegacySourceInput, 'session'> & Readonly<{
  session: PaperStrategySession;
}>;
type AnyEvidenceInput = Omit<LegacyEvidenceInput, 'session'> & Readonly<{
  session: PaperStrategySession;
}>;

function creationStrategy(
  strategy: StrategyActions,
): Pick<CreationEntryV1Strategy,
'open' | 'recoverOpen' | 'reconcile' | 'reconcileSource' | 'reconcileEvidence'
> {
  return strategy as Pick<CreationEntryV1Strategy,
  'open' | 'recoverOpen' | 'reconcile' | 'reconcileSource' | 'reconcileEvidence'
  >;
}

function isStrategyRegistry(value: StrategyProvider): value is PaperDecisionStrategyRegistry {
  return 'kind' in value;
}

function activeStrategy(provider: StrategyProvider): StrategyActions {
  if (!isStrategyRegistry(provider)) return provider;
  return provider.activeStrategyId === 'creation-entry-v1'
    ? provider.creation
    : provider.legacy;
}

function sessionStrategy(
  provider: StrategyProvider,
  session: PaperStrategySession,
): StrategyActions {
  if (!isStrategyRegistry(provider)) return provider;
  if (session.payloadVersion === 2) {
    return provider.creation;
  }
  if (session.strategy.id === 'validated-external-buys') {
    return provider.legacy;
  }
  throw new TypeError('Persisted paper session strategy is unsupported.');
}

function legacyStrategy(
  strategy: StrategyActions,
): Pick<ValidatedExternalBuysStrategy,
'open' | 'recoverOpen' | 'reconcile' | 'reconcileSource' | 'reconcileEvidence'
> {
  return strategy as Pick<ValidatedExternalBuysStrategy,
  'open' | 'recoverOpen' | 'reconcile' | 'reconcileSource' | 'reconcileEvidence'
  >;
}

function openStrategy(
  strategy: StrategyProvider,
  input: AnyOpenInput,
): Promise<StrategyResult> {
  const selected = sessionStrategy(strategy, input.session);
  return input.session.payloadVersion === 2
    ? creationStrategy(selected).open(input as CreationOpenInput)
    : legacyStrategy(selected).open(input as LegacyOpenInput);
}

function recoverOpenStrategy(
  strategy: StrategyProvider,
  input: AnyOpenInput,
): Promise<StrategyResult> {
  const selected = sessionStrategy(strategy, input.session);
  return input.session.payloadVersion === 2
    ? creationStrategy(selected).recoverOpen(input as CreationOpenInput)
    : legacyStrategy(selected).recoverOpen(input as LegacyOpenInput);
}

function reconcileStrategy(
  strategy: StrategyProvider,
  input: AnyReconcileInput,
): Promise<StrategyResult> {
  const selected = sessionStrategy(strategy, input.session);
  return input.session.payloadVersion === 2
    ? creationStrategy(selected).reconcile(input as CreationReconcileInput)
    : legacyStrategy(selected).reconcile(input as LegacyReconcileInput);
}

function reconcileStrategySource(
  strategy: StrategyProvider,
  input: AnySourceInput,
): Promise<StrategyResult> {
  const selected = sessionStrategy(strategy, input.session);
  return input.session.payloadVersion === 2
    ? creationStrategy(selected).reconcileSource(input as CreationSourceInput)
    : legacyStrategy(selected).reconcileSource(input as LegacySourceInput);
}

function reconcileStrategyEvidence(
  strategy: StrategyProvider,
  input: AnyEvidenceInput,
): Promise<StrategyResult> {
  const selected = sessionStrategy(strategy, input.session);
  return input.session.payloadVersion === 2
    ? creationStrategy(selected).reconcileEvidence(input as CreationEvidenceInput)
    : legacyStrategy(selected).reconcileEvidence(input as LegacyEvidenceInput);
}

function decision(
  rebuilt:RebuiltQualification,
  candidate:TradingCandidateResult,
  session:PaperStrategySession|null,
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

function authorizedQualification(
  authorized:RebuiltQualification,
  persisted:CanonicalQualificationProjection,
):RebuiltQualification {
  return Object.freeze({
    reportId:persisted.reportId,
    reportEventId:persisted.qualificationEvent.id,
    evidenceFingerprint:persisted.evidenceFingerprint,
    evaluation:authorized.evaluation,
    report:authorized.report,
    event:persisted.qualificationEvent,
  });
}

function isQualificationNotCurrent(error:unknown):boolean{
  return error instanceof PaperTradingError&&error.code==='QUALIFICATION_NOT_CURRENT';
}

function manualReviewDecision(
  qualification:RebuiltQualification,
  candidate:TradingCandidateResult,
  session:PaperStrategySession,
  candidateEvent:DomainEvent,
  nowMs:number,
):PaperDecisionResult{
  const manual=Object.freeze({
    ...session,state:'MANUAL_REVIEW' as const,reasonCode:'RECONCILIATION_REQUIRED' as const,
    lastError:Object.freeze({
      code:'POSITION_NOT_FOUND',message:'Active paper position or candidate is unavailable.',retryable:false,
    }),updatedAtMs:nowMs,purgeAfterMs:nowMs+14_400_000,
  });
  return decision(
    qualification,candidate,manual,sessionEvent(manual,candidateEvent),[],'NONE',
  );
}

function sessionEvent(session:PaperStrategySession,trigger:DomainEvent):DomainEvent {
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
