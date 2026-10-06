import { createBondingCurveTradeObservedEvent } from '../../src/domain/launchpad-events.js';
import { PaperDecisionWorker } from '../../src/application/paper-decision-worker.js';
import { TradingCandidateService } from '../../src/application/trading-candidate.service.js';
import { ValidatedExternalBuysStrategy } from '../../src/application/validated-external-buys.strategy.js';
import type { QualificationReport } from '../../src/domain/qualification.js';
import type { DomainEvent } from '../../src/domain/events.js';
import type { ChainCursor } from '../../src/domain/types.js';
import type {
  ClaimedPaperDecisionJob, PaperDecisionFailure, PaperDecisionJobInput, PaperDecisionQueueCounts,
  PaperDecisionRepository, PaperDecisionResult, PaperDecisionSnapshot,
} from '../../src/ports/paper-decision-repository.js';
import type { PaperExecutionQuote } from '../../src/domain/paper-trading.js';
import { startLiveApplication } from '../../src/application/live-application.js';
import { parseLiveRunArgs } from '../../src/cli/live-run.js';
import { LiveDecisionController } from '../../src/live/live-decision-controller.js';
import { KeypairLiveSigner, verifySerializedLiveTransaction } from '../../src/live/keypair-live-signer.js';
import { LiveTransactionExecutor, type LiveTransactionRpc, type LiveTransactionMeta } from '../../src/live/live-transaction-executor.js';
import { PostgresLiveOrderJournal } from '../../src/live/postgres-live-order-journal.js';
import { PostgresLivePositionRepository } from '../../src/live/postgres-live-position-repository.js';
import { PumpFunPaperQuoteProvider } from '../../src/paper/pumpfun-paper-quote.provider.js';
import { accounts, FakeReader, MINT, quoteAsset, NOW } from './pumpfun-paper-quote-state.js';
import { Keypair, PublicKey, VersionedTransaction, type AccountInfo } from '@solana/web3.js';
import pg from 'pg';
import { LivePositionMarketResolver } from '../../src/live/live-position-market-route.js';
import { PumpSwapDirectPoolVenueReader } from '../../src/live/pumpswap-direct-pool-resolver.js';
import { runLivePositionOperatorCli } from '../../src/cli/live-position-operator.js';
import { PumpSwapLiveSellAdapter } from '../../src/live/pumpswap-live-sell-adapter.js';
import { PUMPSWAP_PROGRAM_ID } from '../../src/markets/pumpswap/constants.js';
import { GLOBAL_CONFIG_PDA, OFFLINE_PUMP_AMM_PROGRAM, poolPda } from '../../src/markets/pumpswap/official-sdk.js';
import { pumpPoolAuthorityPda } from '../../src/launchpads/pumpfun/official-sdk.js';
import { PUMPSWAP_ACCOUNTS, PUMPSWAP_INSTRUCTIONS } from '../../src/markets/pumpswap/generated/pumpswap-idl.js';
import { AccountType, ExtensionType, getAssociatedTokenAddressSync, MintLayout, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { CanonicalMarketPool } from '../../src/domain/market.js';
import type { CanonicalPaperVenueState } from '../../src/paper/paper-quote-router.js';
import type { MarketRpcReader, ReadonlyAccountSnapshot } from '../../src/ports/market-rpc-reader.js';

const WALLET_SEED = new Uint8Array(32).fill(63);
const wallet = Keypair.fromSeed(WALLET_SEED);
const mint = MINT.toBase58();
const entryCursor: ChainCursor = Object.freeze({ slot: 10n, transactionIndex: 0, instructionIndex: 0, innerInstructionIndex: null });

export async function runLiveApplicationProcess(stage: 'buy-crash' | 'recover-sell' | 'migration-wait' | 'migrated-sell' | 'migrated-sell-crash' | 'recover-migrated-sell' | 'cashback-reject' | 'unknown-layout-reject' | 'token2022-migration-wait' | 'token2022-migrated-sell' | 'unsupported-extension-reject' | 'cashback-bonding-open' | 'cashback-bonding-sell' | 'cashback-migrated-sell' | 'direct-pool-exhausted' | 'direct-pool-operator-sell' | 'direct-pool-invalid' | 'stop-entries'): Promise<void> {
  const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;
  const schema = process.env.LIVE_TEST_SCHEMA;
  if (databaseUrl === undefined || schema === undefined || !/^live_(?:it|mig|cashback)_[a-f0-9]+$/u.test(schema)) {
    throw new Error('The isolated PostgreSQL test environment is required.');
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const isToken2022 = stage === 'token2022-migration-wait' || stage === 'token2022-migrated-sell' || stage==='unsupported-extension-reject';
  const directPoolStage=stage==='direct-pool-exhausted'||stage==='direct-pool-operator-sell'||stage==='direct-pool-invalid';
  const stopEntryStage=stage==='stop-entries';
  const sourceAccounts = await accounts({ isCashbackCoin: stage === 'cashback-reject' || stage === 'cashback-bonding-sell' || stage === 'cashback-migrated-sell',
    mintOwner: isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    ...(stage==='unsupported-extension-reject'?{token2022Extension:ExtensionType.TransferFeeConfig}:{}) });
  const snapshots = [...sourceAccounts.snapshots];
  if (stage === 'unknown-layout-reject') {
    const curveSnapshot=snapshots[2];
    if(curveSnapshot===undefined)throw new Error('The controlled curve snapshot is missing.');
    snapshots[2] = { ...curveSnapshot, data: Buffer.concat([Buffer.from(curveSnapshot.data), Buffer.from([0, 0])]) };
  }
  const marketAccounts = { ...sourceAccounts, snapshots };
  const liveQuotes = new PumpFunPaperQuoteProvider(new FakeReader(marketAccounts.snapshots), () => NOW);
  let pumpfunExitQuoteCount=0;
  const quoteAndState=liveQuotes.quoteAndState.bind(liveQuotes);
  liveQuotes.quoteAndState=async(request)=>{if(request.side==='SELL')pumpfunExitQuoteCount+=1;return quoteAndState(request);};
  const journal = new PostgresLiveOrderJournal(pool);
  const positions = new PostgresLivePositionRepository(pool);
  const mode = stage === 'buy-crash' || stage === 'migrated-sell-crash' ? 'crash-after-send' : 'confirmed';
  const restoredStage=stage==='recover-sell'||stage==='migrated-sell'||stage==='migrated-sell-crash'||stage==='recover-migrated-sell'||stage==='token2022-migrated-sell'||stage==='cashback-bonding-sell'||stage==='cashback-migrated-sell'||stage==='direct-pool-operator-sell';
  const priorBuySignature = restoredStage ? process.env.LIVE_TEST_CONFIRMED_BUY_SIGNATURE : null;
  const priorSellSignature = stage==='recover-migrated-sell'?process.env.LIVE_TEST_CONFIRMED_SELL_SIGNATURE:null;
  if (restoredStage && (priorBuySignature === null || priorBuySignature === undefined)) {
    throw new Error('The simulated RPC confirmation fixture must identify the submitted BUY signature.');
  }
  if(stage==='recover-migrated-sell'&&(priorSellSignature===null||priorSellSignature===undefined))throw new Error('The simulated RPC confirmation fixture must identify the submitted PumpSwap SELL signature.');
  const rpc = new IntegrationRpc(wallet.publicKey.toBase58(), mode, priorBuySignature ?? null,
    stage==='recover-sell'||stage==='migrated-sell'||stage==='migrated-sell-crash'||stage==='recover-migrated-sell'||stage==='token2022-migrated-sell'||stage==='cashback-bonding-sell'||stage==='cashback-migrated-sell'||stage==='direct-pool-operator-sell'?'SELL':'BUY',priorSellSignature??null);
  const executor = new LiveTransactionExecutor(rpc, journal, new KeypairLiveSigner(wallet), {
    commitment: 'confirmed', confirmationPolls: 1, delayMs: 0, maxPriorityFeeLamports: 0n,
    exitReserveLamports: 10_000_000n, maximumBalanceAgeMs: 5_000, now: () => NOW,
  });
  const strategy = new ValidatedExternalBuysStrategy(noPaperActions(), liveQuotes, { retentionMs: 14_400_000, clock: () => NOW });
  const migrating = stage === 'migration-wait' || stage === 'migrated-sell'||stage==='migrated-sell-crash'||stage==='recover-migrated-sell'||stage==='token2022-migration-wait'||stage==='token2022-migrated-sell'||stage==='cashback-migrated-sell'||directPoolStage;
  const pumpSwapFixture=directPoolStage?new PumpSwapFixtureReader(wallet.publicKey.toBase58(),false,false,stage==='direct-pool-invalid'):null;
  const migratedCurve=directPoolStage?await accounts({complete:true}):null;
  if(directPoolStage&&(pumpSwapFixture===null||migratedCurve===null))throw new Error('Direct pool fixture dependencies were not created.');
  const directReader=directPoolStage&&pumpSwapFixture!==null&&migratedCurve!==null
    ?new DirectPoolFixtureReader(migratedCurve.snapshots,pumpSwapFixture,stage!=='direct-pool-exhausted'):null;
  if(directPoolStage&&directReader===null)throw new Error('Direct pool reader fixture is unavailable.');
  const marketResolver = migrating ? new LivePositionMarketResolver(directPoolStage
    ?new PumpSwapDirectPoolVenueReader(requireDirectReader(directReader),()=>NOW,'confirmed') : {
    read: async (requestedMint): Promise<CanonicalPaperVenueState> => ({
      mint:requestedMint,bondingCurve:{active:false,complete:true},migrationObserved:true,
      pumpSwap:stage==='migrated-sell'||stage==='migrated-sell-crash'||stage==='recover-migrated-sell'||stage==='token2022-migrated-sell'||stage==='cashback-migrated-sell'?{active:true,pool:integrationPool(isToken2022?'TOKEN_2022':'SPL_TOKEN')}:null,headSlot:800n,
    }),
  },positions,directPoolStage?1:3) : undefined;
  const pumpSwapSales = stage === 'migrated-sell'||stage==='migrated-sell-crash'||stage==='recover-migrated-sell'||stage==='token2022-migrated-sell'||stage==='cashback-migrated-sell'
    ? new PumpSwapLiveSellAdapter(new PumpSwapFixtureReader(wallet.publicKey.toBase58(),isToken2022,stage==='cashback-migrated-sell'),()=>NOW)
    : directPoolStage?new PumpSwapLiveSellAdapter(requireDirectReader(directReader),()=>NOW):undefined;
  const policy = {
    cluster: 'mainnet-beta' as const, expectedGenesisHash: PublicKey.default.toBase58(),
    expectedWallet: wallet.publicKey.toBase58(), keypairFile: '/tmp/offline-fixture-key.json',
    buyAmountLamports: 1_000_000n, maxExposureLamports: 1_000_000n, maxLossLamports: 1_000_000n,
    exitReserveLamports: 100_000n, maxSlippageBps: 100, maxBuys: 1 as const,
    maxPriorityFeeLamports: 0n,
    maxConcurrentPositions: 1 as const, maxSessionSeconds: 60,
  };
  const controller = new LiveDecisionController({
    policy, externalBuyTarget: 1, minimumConfirmation: 'confirmed', maximumQuoteAgeMs: 10_000,
    executor, journal, positions, quotes: liveQuotes, strategy, now: () => NOW,
    ...(marketResolver===undefined?{}:{marketResolver}),
    ...(pumpSwapSales===undefined?{}:{pumpSwapSales}),
    readAssociatedTokenAccount: async (): Promise<AccountInfo<Buffer> | null> => null,
    onAdmissionRejected:(decision)=>process.stderr.write(`${JSON.stringify({type:'LIVE_BUY_REJECTED',...decision})}\n`),
  });
  if(stage==='direct-pool-operator-sell'){
    const position=(await positions.listActive(wallet.publicKey.toBase58()))[0];
    if(position===undefined)throw new Error('Operator recovery fixture has no durable open position.');
    const url=new URL(databaseUrl);url.searchParams.set('options',`-c search_path=${schema},public`);
    await runLivePositionOperatorCli(['recheck','--position',position.positionId,'--wallet',wallet.publicKey.toBase58(),'--additional-checks','1'],{
      LIVE_OPERATOR_DATABASE_URL:url.toString(),LIVE_OPERATOR_HTTP_RPC_URL:'https://offline.invalid',
    },{createReadTransport:()=>({transactions:{getSignatureStatuses:async()=>({context:{slot:800},value:[]}),getTransaction:async()=>null} as never,marketAccounts:requireDirectReader(directReader)})});
  }
  const repo = restoredStage
    ? new DecisionRepository([snapshot(true,isToken2022),snapshot(true,isToken2022)])
    : new DecisionRepository([snapshot(false,isToken2022)]);
  const worker = new PaperDecisionWorker(
    repo,
    { quote: async (request): Promise<PaperExecutionQuote> => request.side === 'BUY'
      ? quote('BUY', quoteAsset.mint, mint, request.amountInRaw, 100_000n, 99_000n)
      : quote('SELL', mint, quoteAsset.mint, request.amountInRaw, 1_000_000n, 990_000n) },
    { reauthorize: (projection) => ({
      reportId: projection.reportId, reportEventId: projection.qualificationEvent.id,
      evidenceFingerprint: projection.evidenceFingerprint,
      evaluation: { evaluatedAtMs: NOW, signals: {}, blockers: [], calibrationFacts: null },
      report: qualificationReport(), event: projection.qualificationEvent,
    }) },
    new TradingCandidateService({
      strategy: { id: 'validated-external-buys', version: 1 }, quoteMintAllowlist: [quoteAsset.mint],
      minimumConfirmation: 'confirmed', entryWindowMs: 60_000, maximumQuoteAgeMs: 10_000,
      maximumQuoteSlotLag: 0n, retentionMs: 14_400_000,
    }),
    strategy,
    {
      executionMode: 'observe', paperStrategyEnabled: false, liveCandidateFeedEnabled: true,
      onDecisionResult: async (result, source) => {
        try { await controller.consume(result, source); }
        catch(error){process.stderr.write(error instanceof Error?`${error.stack??error.message}\n`:'live integration controller failed\n');throw error;}
      },
      quoteMintAllowlist: [quoteAsset.mint], entryQuoteAmountRaw: 1_000_000n, slippageBps: 100n,
      externalBuyTarget: 1, minimumConfirmation: 'confirmed', maximumRoundTripLossBps: 3_000n,
      pollIntervalMs: 50, leaseMs: 1_000, renewalIntervalMs: 200, shutdownTimeoutMs: 1_000,
    },
    { schedule: () => Symbol('controlled-timer'), cancel: () => undefined, now: () => NOW },
  );
  const args = parseLiveRunArgs(restoredStage||stopEntryStage ? ['--stop-entries'] : []);
  if (args.stopEntries) controller.stopEntries();
  const app = await startLiveApplication(async () => ({
    controller,
    listener: {
      start: async () => {
        await worker.runOnce();
        if (restoredStage) await worker.runOnce();
      },
      close: async () => worker.close(),
    },
    acquireWalletLock: async () => journal.acquireWalletLock(wallet.publicKey.toBase58()),
    closePool: async () => pool.end(),
  }));
  await app.close();
  if (restoredStage || stopEntryStage || stage === 'cashback-reject' || stage === 'unknown-layout-reject' || stage==='unsupported-extension-reject') process.stdout.write(`LIVE_TEST_NEW_SENDS=${rpc.newSendCount}\n`);
  if (stage === 'migrated-sell'||stage==='migrated-sell-crash'||stage==='recover-migrated-sell'||stage==='token2022-migrated-sell'||stage==='cashback-migrated-sell'||stage==='direct-pool-operator-sell') process.stdout.write(`LIVE_TEST_PUMPSWAP_SELLS=${rpc.pumpSwapSellCount}\nLIVE_TEST_PUMPSWAP_AMOUNT=${rpc.pumpSwapSellAmount}\nLIVE_TEST_PUMPSWAP_MIN=${rpc.pumpSwapSellMinimum}\nLIVE_TEST_PUMPFUN_EXIT_QUOTES=${pumpfunExitQuoteCount}\nLIVE_TEST_CASHBACK_ACCOUNTS=${rpc.cashbackAccountCount}\n`);
}

class DecisionRepository implements PaperDecisionRepository {
  public constructor(private readonly snapshots: PaperDecisionSnapshot[]) {}
  public async enqueue(_input: PaperDecisionJobInput): Promise<void> {}
  public async claim(): Promise<ClaimedPaperDecisionJob | null> {
    const next = this.snapshots.shift();
    if (next === undefined) return null;
    return {
      jobId: `job-${this.snapshots.length}`, mint, sourceEventId: 'source-event', sourceRawEventId: 'raw-source',
      sourceConfirmationStatus: 'confirmed', inputFingerprint: 'f'.repeat(64), attempts: 1, maxAttempts: 3,
      leaseToken: `lease-${this.snapshots.length}`, leaseExpiresAtMs: NOW + 10_000,
    };
  }
  public async renew(_job: ClaimedPaperDecisionJob): Promise<boolean> { return true; }
  public async loadSnapshot(_job: ClaimedPaperDecisionJob): Promise<PaperDecisionSnapshot> {
    if (currentSnapshot === null) throw new Error('The controlled listener snapshot is missing.');
    return currentSnapshot;
  }
  public async stageDecision(_job: ClaimedPaperDecisionJob, _result: PaperDecisionResult): Promise<void> {}
  public async complete(_job: ClaimedPaperDecisionJob, _result: PaperDecisionResult): Promise<void> {}
  public async completeNoop(_job: ClaimedPaperDecisionJob): Promise<void> {}
  public async completeObsolete(_job: ClaimedPaperDecisionJob): Promise<void> {}
  public async fail(_job: ClaimedPaperDecisionJob, failure: PaperDecisionFailure): Promise<void> { throw new Error(`worker failed: ${failure.code}`); }
  public async counts(): Promise<PaperDecisionQueueCounts> { return { pending: 0, processing: 0, retryableFailed: 0, exhausted: 0 }; }
}

let currentSnapshot: PaperDecisionSnapshot | null = null;
function snapshot(withExternalBuy: boolean,isToken2022=false): PaperDecisionSnapshot {
  const qualificationEvent = domainEvent('QualificationUpdated', 'qualification-event', entryCursor);
  const launchEvent = domainEvent('TokenLaunchDetected', 'launch-event', Object.freeze({ slot: 8n, transactionIndex: 0, instructionIndex: 0, innerInstructionIndex: null }));
  const projection = {
    reportId: `qreport_${'a'.repeat(64)}`, sourceEventId: 'source-event', sourceRawEventId: 'raw-source',
    evidenceFingerprint: 'b'.repeat(64), qualificationEvent, evaluation: {}, report: qualificationReport(),
  };
  const trades = withExternalBuy ? [createBondingCurveTradeObservedEvent({
    source: 'pumpfun-listener', program: 'pump-program',
    transaction: { signature: 'fixture-external-buy-signature', confirmationStatus: 'confirmed', blockTimeMs: NOW,
      observedAtMs: NOW, cursor: { slot: 11n, transactionIndex: 0 }, raw: {} },
    trade: { id: 'external-buy-event-id', launchMint: mint, kind: 'BUY', trader: 'external-wallet',
      baseAmountRaw: 10n, quoteAmountRaw: 1n, quoteAsset, cursor: { slot: 11n, transactionIndex: 0, instructionIndex: 0, innerInstructionIndex: null } },
  })] : [];
  const value: PaperDecisionSnapshot = {
    mint, asOfEvent: launchEvent, canonicalLaunchActive: true, hasPaperLineage: false,
    launch: { mint, creator: 'creator-wallet', tokenProgram: isToken2022 ? 'TOKEN_2022' : 'SPL_TOKEN', quoteAssets: [quoteAsset],
      launchpad: 'pumpfun', createdAt: launchEvent.cursor, parameters: {} },
    metadata: null, social: null, creatorProfile: null, holderSnapshot: null, walletGraph: null,
    activeLaunchTrades: trades, activeMarketTrades: [],
    currentQualification: projection as never, currentCandidate: null, currentDecision: null,
    currentSession: null, activePosition: null,
  };
  currentSnapshot = value;
  return value;
}

function domainEvent(type: 'QualificationUpdated' | 'TokenLaunchDetected', id: string, cursor: ChainCursor): DomainEvent {
  return { id, type, mint, source: 'fixture-listener', program: 'pump-program', signature: id,
    cursor, confirmationStatus: 'confirmed', blockchainTimeMs: NOW, observedAtMs: NOW, payloadVersion: 1, payload: {} };
}
function qualificationReport(): QualificationReport {
  const score = { score: 100, maximum: 100 };
  return { ruleSet: { id: 'fixture-profile', version: 1, status: 'UNVALIDATED_RULE_SET', minimumTotalScore: 60,
    fingerprint: 'c'.repeat(64), rules: [] }, scores: { preparation: score, socialAuthenticity: score,
    onchainHealth: score, total: score }, evidence: [], conditions: [], blockers: [], verdict: 'QUALIFIED', evaluatedAtMs: NOW } as QualificationReport;
}
function quote(id: string, inputMint: string, outputMint: string, amountInRaw: bigint, amountOutRaw: bigint, minimumAmountOutRaw: bigint): PaperExecutionQuote {
  return { id, inputMint, outputMint, amountInRaw, amountOutRaw, minimumAmountOutRaw, feesRaw: 0n,
    slippageBps: 100n, priceImpactBps: 0n, observedAtMs: NOW, observedSlot: 123n };
}
function noPaperActions() {
  const forbidden = async (): Promise<never> => { throw new Error('Paper ledger effects are forbidden in this live integration.'); };
  return { open: forbidden, reconcileOpen: forbidden, close: forbidden, retract: forbidden };
}

class IntegrationRpc implements LiveTransactionRpc {
  private readonly signatures: string[] = [];
  public newSendCount = 0;
  public pumpSwapSellCount = 0;
  public pumpSwapSellAmount='0';
  public pumpSwapSellMinimum='0';
  public cashbackAccountCount=0;
  public constructor(
    private readonly owner: string,
    private readonly mode: 'confirmed' | 'crash-after-send',
    private readonly priorBuySignature: string | null,
    private readonly newSendSide:'BUY'|'SELL',
    private readonly priorSellSignature:string|null,
  ) {}
  public async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 500 };
  }
  public async getWalletBalance(wallet: string) {
    if (wallet !== this.owner) throw new Error('Unexpected wallet in offline fixture.');
    return { lamports: 1_000_000_000n, contextSlot: 700n, observedAtMs: NOW };
  }
  public async getMessageFee() { return { lamports: 5_000n, contextSlot: 700n, observedAtMs: NOW }; }
  public async getTokenAccountRentExemption(): Promise<bigint | null> { return 2_000_000n; }
  public async sendRawTransaction(bytes: Uint8Array): Promise<string> {
    const signature = verifySerializedLiveTransaction(bytes, this.owner);
    const message=VersionedTransaction.deserialize(bytes).message;
    for(const compiled of message.compiledInstructions){
      if(message.staticAccountKeys[compiled.programIdIndex]?.toBase58()===PUMPSWAP_PROGRAM_ID
        && compiled.data.length===24&&PUMPSWAP_INSTRUCTIONS.sell.discriminator.every((b,i)=>compiled.data[i]===b)){
        this.pumpSwapSellCount+=1;this.pumpSwapSellAmount=Buffer.from(compiled.data).readBigUInt64LE(8).toString();
        this.pumpSwapSellMinimum=Buffer.from(compiled.data).readBigUInt64LE(16).toString();
        const [accumulator]=PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'),new PublicKey(this.owner).toBuffer()],new PublicKey(PUMPSWAP_PROGRAM_ID));
        const accumulatorAta=getAssociatedTokenAddressSync(NATIVE_MINT,accumulator,true,TOKEN_PROGRAM_ID).toBase58();
        const keys=compiled.accountKeyIndexes.map((index)=>message.staticAccountKeys[index]?.toBase58()??'');
        const ataIndex=keys.indexOf(accumulatorAta);
        if(ataIndex>=0&&keys[ataIndex+1]===accumulator.toBase58())this.cashbackAccountCount=2;
      }
    }
    this.newSendCount += 1;
    this.signatures.push(signature);
    if (this.mode === 'crash-after-send') process.exit(77);
    return signature;
  }
  public async getSignatureStatus(signature: string) {
    if (signature !== this.priorBuySignature && signature!==this.priorSellSignature && !this.signatures.includes(signature)) return null;
    return { confirmationStatus: 'confirmed' as const, err: null };
  }
  public async getBlockHeight(): Promise<number> { return 400; }
  public async getTransaction(_signature: string): Promise<LiveTransactionMeta | null> {
    if (_signature !== this.priorBuySignature && _signature!==this.priorSellSignature && !this.signatures.includes(_signature)) return null;
    const side = _signature === this.priorBuySignature ? 'BUY' : this.newSendSide;
    const entry = { owner: this.owner, mint, uiTokenAmount: { amount: '12345' } };
    return { slot: side === 'BUY' ? 700 : 701, meta: {
      err: null, fee: 5_000, preBalances: [], postBalances: [],
      preTokenBalances: side === 'BUY' ? [] : [entry], postTokenBalances: side === 'BUY' ? [entry] : [],
    } };
  }
}

export function integrationPool(baseTokenProgram:'SPL_TOKEN'|'TOKEN_2022'='SPL_TOKEN'):CanonicalMarketPool{
  const base=new PublicKey(mint);const creator=pumpPoolAuthorityPda(base);const quote=NATIVE_MINT;
  const tokenProgram=baseTokenProgram==='TOKEN_2022'?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
  const address=poolPda(0,creator,base,quote);
  return {address:address.toBase58(),market:'pumpswap',programId:PUMPSWAP_PROGRAM_ID,baseMint:base.toBase58(),
    quoteAsset:{mint:quote.toBase58(),decimals:9,tokenProgram:'SPL_TOKEN'},index:0,creator:creator.toBase58(),
    baseVault:getAssociatedTokenAddressSync(base,address,true,tokenProgram).toBase58(),
    quoteVault:getAssociatedTokenAddressSync(quote,address,true,TOKEN_PROGRAM_ID).toBase58(),lpMint:key(20).toBase58(),
    baseTokenProgram,activatedAt:{slot:800n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:2},
    confirmationStatus:'finalized'};
}

function requireDirectReader(reader:DirectPoolFixtureReader|null):DirectPoolFixtureReader{
  if(reader===null)throw new Error('Direct pool fixture reader is missing.');
  return reader;
}

class PumpSwapFixtureReader {
  private readonly values:Map<string,ReadonlyAccountSnapshot>;
  public constructor(owner:string,token2022=false,cashback=false,invalidVault=false){
    const baseTokenProgram=token2022?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
    const pool=integrationPool(token2022?'TOKEN_2022':'SPL_TOKEN');const user=new PublicKey(owner);
    const baseAta=getAssociatedTokenAddressSync(new PublicKey(pool.baseMint),user,false,baseTokenProgram);
    const quoteAta=getAssociatedTokenAddressSync(NATIVE_MINT,user,false,TOKEN_PROGRAM_ID);
    const poolData=encodePool(pool,-500_000n,cashback);
    const globalData=encodeGlobalConfig();
    const mintData=Buffer.alloc(token2022?234:MintLayout.span);
    if(token2022){MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1_000_000_000_000n,
      decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},mintData);
      mintData[165]=AccountType.Mint;mintData.writeUInt16LE(ExtensionType.MetadataPointer,166);mintData.writeUInt16LE(64,168);
      new PublicKey(pool.baseMint).toBuffer().copy(mintData,202);
    }else{writeU64(mintData,36,1_000_000_000_000n);mintData[44]=6;mintData[45]=1;}
    const quoteMintData=Buffer.alloc(MintLayout.span);
    MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1_000_000_000_000n,decimals:9,
      isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},quoteMintData);
    const values=[
      account(pool.address,PUMPSWAP_PROGRAM_ID,poolData),
      account(pool.baseVault,baseTokenProgram.toBase58(),tokenAccount(pool.baseMint,pool.address,9_000_000_000n)),
      account(pool.quoteVault,TOKEN_PROGRAM_ID.toBase58(),tokenAccount(pool.quoteAsset.mint,pool.address,5_000_000_000n)),
      account(GLOBAL_CONFIG_PDA.toBase58(),PUMPSWAP_PROGRAM_ID,globalData),
      account(pool.baseMint,baseTokenProgram.toBase58(),mintData),
      account(pool.quoteAsset.mint,TOKEN_PROGRAM_ID.toBase58(),quoteMintData),
      account(baseAta.toBase58(),baseTokenProgram.toBase58(),tokenAccount(pool.baseMint,owner,12_345n)),
      account(quoteAta.toBase58(),TOKEN_PROGRAM_ID.toBase58(),tokenAccount(pool.quoteAsset.mint,owner,0n)),
    ];
    this.values=new Map(values.map((value)=>[value.address,value]));
    if(invalidVault)this.values.set(pool.baseVault,account(pool.baseVault,PUMPSWAP_PROGRAM_ID,tokenAccount(pool.baseMint,pool.address,9_000_000_000n)));
  }
  public async readAccountsAtSameSlot(addresses:readonly string[]):Promise<readonly (ReadonlyAccountSnapshot|null)[]>{
    return addresses.map((address)=>this.values.get(address)??null);
  }
}

class DirectPoolFixtureReader implements MarketRpcReader {
  private readonly source:ReadonlyMap<string,ReadonlyAccountSnapshot>;
  public constructor(snapshots:readonly ReadonlyAccountSnapshot[],private readonly swap:PumpSwapFixtureReader|null,private readonly poolAvailable:boolean){
    this.source=new Map(snapshots.map((value)=>[value.address,{...value,slot:800n}]));
  }
  public async readAccountsAtSameSlot(addresses:readonly string[]):Promise<readonly (ReadonlyAccountSnapshot|null)[]>{
    const swapAccounts=this.poolAvailable&&this.swap!==null?await this.swap.readAccountsAtSameSlot(addresses):[];
    const byAddress=new Map(swapAccounts.flatMap((value)=>value===null?[]:[[value.address,value] as const]));
    return addresses.map((address)=>this.source.get(address)??byAddress.get(address)??null);
  }
}

function account(address:string,owner:string,data:Buffer):ReadonlyAccountSnapshot{
  return {address,owner,data,lamports:1n,slot:800n};
}
function tokenAccount(mintAddress:string,authority:string,amount:bigint):Buffer{
  const data=Buffer.alloc(165);new PublicKey(mintAddress).toBuffer().copy(data,0);new PublicKey(authority).toBuffer().copy(data,32);writeU64(data,64,amount);data[108]=1;return data;
}
function encodePool(pool:CanonicalMarketPool,virtualQuote:bigint,cashback=false):Buffer{
  const data=Buffer.alloc(300);Buffer.from(PUMPSWAP_ACCOUNTS.Pool.discriminator).copy(data,0);let at=8;
  const bytes=(value:Uint8Array):void=>{Buffer.from(value).copy(data,at);at+=value.length;};
  bytes(Uint8Array.of(1));bytes(Uint8Array.of(0,0));
  for(const value of [new PublicKey(pool.creator),new PublicKey(pool.baseMint),new PublicKey(pool.quoteAsset.mint),new PublicKey(pool.lpMint),new PublicKey(pool.baseVault),new PublicKey(pool.quoteVault)])bytes(value.toBytes());
  bytes(Uint8Array.from(le(8,1000n)));bytes(key(8).toBytes());bytes(Uint8Array.of(0,cashback?1:0));bytes(Uint8Array.from(le(16,virtualQuote)));return data;
}
function encodeGlobalConfig():Buffer{
  const program=OFFLINE_PUMP_AMM_PROGRAM as unknown as {idl:{types:readonly {name:string;type:{fields:readonly {name:string;type:unknown}[]}}[]}};
  const definition=program.idl.types.find((type)=>type.name==='globalConfig');
  if(definition===undefined)throw new Error('Pinned PumpSwap SDK has no GlobalConfig IDL.');
  const values:Record<string,unknown>={admin:key(21),lpFeeBasisPoints:25n,protocolFeeBasisPoints:0n,disableFlags:0,
    protocolFeeRecipients:Array.from({length:8},(_,i)=>key(30+i)),coinCreatorFeeBasisPoints:0n,
    adminSetCoinCreatorAuthority:key(22),whitelistPda:key(23),reservedFeeRecipient:key(24),mayhemModeEnabled:false,
    reservedFeeRecipients:Array.from({length:7},(_,i)=>key(40+i)),isCashbackEnabled:false,
    buybackFeeRecipients:Array.from({length:8},(_,i)=>key(50+i)),buybackBasisPoints:0n,
    boostAuthority:key(60),boostEnabled:false};
  const data: number[]=[...PUMPSWAP_ACCOUNTS.GlobalConfig.discriminator];
  for(const field of definition.type.fields)data.push(...encodeIdl(field.type,values[field.name]));
  return Buffer.from(data);
}
function encodeIdl(type:unknown,value:unknown):number[]{
  if(type==='pubkey'&&value instanceof PublicKey)return [...value.toBytes()];
  if(type==='u8'||type==='u16'||type==='u64'||type==='u128')return le(type==='u8'?1:type==='u16'?2:type==='u64'?8:16,BigInt(value as bigint|number));
  if(type==='bool')return [value===true?1:0];
  if(typeof type==='object'&&type!==null&&'array'in type){const [child,length]=(type as {array:[unknown,number]}).array;const items=value as unknown[];if(items.length!==length)throw new Error('PumpSwap fixture fixed array has wrong length.');return items.flatMap((item)=>encodeIdl(child,item));}
  throw new Error(`Unsupported PumpSwap fixture IDL type ${JSON.stringify(type)}.`);
}
function writeU64(data:Buffer,offset:number,value:bigint):void{le(8,value).forEach((byte,index)=>{data[offset+index]=byte;});}
function le(width:number,value:bigint):number[]{let raw=value<0n?(1n<<BigInt(width*8))+value:value;return Array.from({length:width},()=>{const byte=Number(raw&255n);raw>>=8n;return byte;});}
function key(seed:number):PublicKey{return new PublicKey(Uint8Array.from({length:32},(_,index)=>(seed+index)%256));}

if (process.argv[1]?.endsWith('live-application-process.ts')) {
  const stage = process.env.LIVE_TEST_STAGE;
  if (stage !== 'buy-crash' && stage !== 'recover-sell' && stage!=='migration-wait' && stage!=='migrated-sell'
    && stage!=='cashback-reject' && stage!=='unknown-layout-reject' && stage!=='unsupported-extension-reject'
    && stage!=='token2022-migration-wait' && stage!=='token2022-migrated-sell'
    &&stage!=='migrated-sell-crash'&&stage!=='recover-migrated-sell'&&stage!=='cashback-bonding-open'
    &&stage!=='cashback-bonding-sell'&&stage!=='cashback-migrated-sell'
    &&stage!=='direct-pool-exhausted'&&stage!=='direct-pool-operator-sell'&&stage!=='direct-pool-invalid'&&stage!=='stop-entries') throw new Error('Unknown live integration stage.');
  await runLiveApplicationProcess(stage);
}
