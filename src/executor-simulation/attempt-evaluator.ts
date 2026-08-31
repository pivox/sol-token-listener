import { createHash } from 'node:crypto';
import {
  AccountLayout,
  getAssociatedTokenAddressSync,
  MintLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import {
  createExecutionSimulationArtifactDraft,
  EXECUTION_SIMULATION_EVALUATOR_VERSION,
  EXECUTION_SIMULATION_SPECIFICATION_VERSION,
  type ExecutionSimulationFailureCode,
  type ExecutionSimulationArtifactDraftV1,
} from '../domain/execution-simulation.js';
import type { ExecutionIntentReasonCode } from '../domain/execution-intent.js';
import type { SimulationOnlyExecutorConfig } from '../executor/config.js';
import {
  DEFAULT_PUBLIC_KEY,
  PUMP_PROGRAM_ID,
  WSOL_MINT,
} from '../launchpads/pumpfun/constants.js';
import {
  bondingCurvePda,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_SDK,
  type BondingCurve,
  type Global,
} from '../launchpads/pumpfun/official-sdk.js';
import type { CanonicalMarketPool, MarketReserves } from '../domain/market.js';
import {
  decodePumpSwapFeeState,
  UnsupportedPumpSwapTokenExtensionError,
} from '../markets/pumpswap/pumpswap-fee-state.js';
import {
  computeEffectiveQuoteReservesRaw,
  createPumpSwapQuote,
  SellQuoteUnavailableError,
} from '../markets/pumpswap/pumpswap-quote.provider.js';
import { decodePumpSwapPoolAccount } from '../markets/pumpswap/pool-account-decoder.js';
import {
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  poolV2Pda,
  userVolumeAccumulatorPda,
} from '../markets/pumpswap/official-sdk.js';
import type { ClaimedExecutionIntent } from '../ports/execution-intent-repository.js';
import type {
  ExecutionAccountSnapshot,
  ExecutionAddressDiscovery,
  ExecutionDiscoveryMarketGateway,
  ExecutionGenesisEvidence,
  ExecutionRpcAccount,
} from '../ports/execution-market-gateway.js';
import type { ReadonlyAccountSnapshot } from '../ports/market-rpc-reader.js';
import type {
  ExecutionSimulationGatewayStage,
  ExecutionSimulationPartialEvidenceV1,
} from '../ports/execution-simulation-gateway.js';
import type {
  ExecutionVenuePool,
  ExecutionVenueRepository,
} from '../ports/execution-venue-repository.js';
import { BuildReceiptAuthority } from './build-receipt.js';
import {
  ExecutionBuildPolicyError,
} from './build-plan.js';
import {
  buildPumpFunPlan,
  type PumpFunBuildQuoteV1,
  type PumpFunBuildRequestV1,
} from './pumpfun-adapter.js';
import {
  computePumpFunExecutionQuote,
  PumpFunExecutionQuoteError,
} from './pumpfun-quote.js';
import {
  buildPumpSwapPlan,
  type PumpSwapBuildQuoteV1,
  type PumpSwapExactSlotSnapshotV1,
  type PumpSwapRawMintDecodedV1,
} from './pumpswap-adapter.js';
import {
  isExecutionProviderSessionError,
  type ProviderAffineSessionConfig,
} from './provider-session.js';
import {
  isInternalExecutionSimulationGatewayError,
  SolanaSimulationGateway,
} from './solana-simulation-gateway.js';
import {
  ExecutionVenueRouter,
  ExecutionVenueRoutingError,
} from './venue-router.js';

export type ExecutionAttemptRenewBoundary =
  | 'BEFORE_CANONICAL_SNAPSHOT'
  | 'BEFORE_SIMULATION';

export interface ExecutionAttemptEvaluationContext {
  readonly claim: ClaimedExecutionIntent;
  readonly attempt: Readonly<{
    readonly intentId: string;
    readonly attemptNumber: number;
    readonly startedAtMs: number;
  }>;
}

export interface ExecutionAttemptEvaluator {
  readonly evaluate: (
    context: ExecutionAttemptEvaluationContext,
    signal: AbortSignal,
    renew: (boundary: ExecutionAttemptRenewBoundary) => Promise<void>,
  ) => Promise<ExecutionSimulationArtifactDraftV1>;
}

export type ExecutionAttemptEvaluatorErrorCode = 'OPERATION_ABORTED';

export class ExecutionAttemptEvaluatorError extends Error {
  public constructor(public readonly code: ExecutionAttemptEvaluatorErrorCode) {
    super('Execution attempt evaluation interrupted.');
    this.name = 'ExecutionAttemptEvaluatorError';
  }
}

const INTERNAL_ERRORS = new WeakSet<ExecutionAttemptEvaluatorError>();

export function isInternalExecutionAttemptEvaluatorError(
  error: unknown,
  code?: ExecutionAttemptEvaluatorErrorCode,
): error is ExecutionAttemptEvaluatorError {
  return error instanceof ExecutionAttemptEvaluatorError
    && INTERNAL_ERRORS.has(error)
    && (code === undefined || sameCode(error.code, code));
}

function sameCode(left: string, right: string): boolean { return left === right; }

export interface ExecutionAttemptEvaluatorDependencies {
  readonly config: SimulationOnlyExecutorConfig;
  readonly venues: ExecutionVenueRepository;
  readonly sessionFactory: (
    config: ProviderAffineSessionConfig,
  ) => ExecutionDiscoveryMarketGateway;
  readonly clock?: () => number;
}

type EvaluationStage = 'PROVIDER' | 'QUOTE' | 'ROUTE' | 'BUILD' | 'FENCE' | 'SIMULATION';

interface EvaluationState {
  stage: EvaluationStage;
  renewalsCompleted: 0 | 1 | 2;
  session: ExecutionDiscoveryMarketGateway | null;
  genesis: ExecutionGenesisEvidence | null;
  venue: ExecutionQuoteV1['venue'] | null;
  quote: ExecutionQuoteV1 | null;
  snapshotFingerprint: string | null;
  snapshotSlot: bigint | null;
}

class QuoteTerminalError extends Error {
  public constructor(public readonly reason: Extract<ExecutionIntentReasonCode,
    | 'QUOTE_STALE'
    | 'SELL_QUOTE_UNAVAILABLE'
    | 'MINIMUM_AMOUNT_OUT_VIOLATED'>) {
    super('Execution quote rejected.');
    this.name = 'QuoteTerminalError';
  }
}

export function createExecutionAttemptEvaluator(
  dependencies: ExecutionAttemptEvaluatorDependencies,
): ExecutionAttemptEvaluator {
  return Object.freeze({
    evaluate: async (
      context: ExecutionAttemptEvaluationContext,
      signal: AbortSignal,
      renew: (boundary: ExecutionAttemptRenewBoundary) => Promise<void>,
    ) => evaluateAttempt(
      dependencies, context, signal, renew,
    ),
  });
}

async function evaluateAttempt(
  dependencies: ExecutionAttemptEvaluatorDependencies,
  context: ExecutionAttemptEvaluationContext,
  signal: AbortSignal,
  renew: (boundary: ExecutionAttemptRenewBoundary) => Promise<void>,
): Promise<ExecutionSimulationArtifactDraftV1> {
  const receiptAuthority = new BuildReceiptAuthority();
  const state: EvaluationState = {
    stage: 'PROVIDER', renewalsCompleted: 0,
    session: null, genesis: null, venue: null, quote: null,
    snapshotFingerprint: null, snapshotSlot: null,
  };
  try {
    return await evaluateAttemptCore(
      dependencies, context, signal, renew, receiptAuthority, state,
    );
  } catch (error) {
    const draft = failureArtifactOrThrow(dependencies, context, signal, state, error);
    await completeTerminalRenewals(renew, signal, state);
    return draft;
  }
}

async function evaluateAttemptCore(
  dependencies: ExecutionAttemptEvaluatorDependencies,
  context: ExecutionAttemptEvaluationContext,
  signal: AbortSignal,
  renew: (boundary: ExecutionAttemptRenewBoundary) => Promise<void>,
  receiptAuthority: BuildReceiptAuthority,
  state: EvaluationState,
): Promise<ExecutionSimulationArtifactDraftV1> {
  requireActive(signal);
  const intent = context.claim.intent;
  const config = dependencies.config;
  const session = dependencies.sessionFactory(Object.freeze({
    providerId: config.providerId,
    httpRpcUrl: config.httpRpcUrl,
    expectedGenesisHash: config.expectedGenesisHash,
    timeoutMs: config.rpcTimeoutMs,
    maxCalls: config.maxRpcCallsPerAttempt,
    maxSnapshotSlotLag: config.snapshotMaxSlotLag,
  }));
  state.session = session;
  const genesis = await session.verifyGenesis(signal);
  state.genesis = genesis;
  const mint = new PublicKey(intent.mint);
  const curveAddress = bondingCurvePda(mint).toBase58();
  const discovery = await session.readAddressDiscovery(
    Object.freeze([curveAddress, intent.mint]), signal,
  );
  state.stage = 'QUOTE';
  const discovered = discoveryState(discovery, intent.mint);
  state.stage = 'ROUTE';
  const route = await new ExecutionVenueRouter(dependencies.venues).route(Object.freeze({
    side: intent.side,
    venuePolicy: intent.venuePolicy,
    mint: intent.mint,
    quoteMint: intent.quoteMint,
    quoteTokenProgram: intent.quoteTokenProgram,
    quoteDecimals: intent.quoteDecimals,
  }), Object.freeze({
    mint: intent.mint,
    normalizedQuoteMint: discovered.normalizedQuoteMint,
    complete: discovered.curve.complete,
    exists: true,
    bondingCurveAddress: curveAddress,
    ownerProgramId: PUMP_PROGRAM_ID,
  }));
  state.venue = route.venue;
  state.stage = 'FENCE';
  await renewAndRecord(renew, 'BEFORE_CANONICAL_SNAPSHOT', signal, state);
  if (route.venue === 'PUMP_SWAP') {
    return evaluatePumpSwap(
      dependencies,
      receiptAuthority,
      context,
      signal,
      renew,
      session,
      genesis,
      discovered,
      route.pool,
      discovery,
      state,
    );
  }
  const addresses = pumpFunFinalAddresses(intent.mint, config.executorPublicKey, discovered.baseTokenProgram);
  state.stage = 'PROVIDER';
  const snapshot = await session.readAccountSnapshot(addresses, signal);
  state.stage = 'QUOTE';
  const observedAtMs = now(dependencies.clock);
  const snapshotFingerprint = fingerprintSnapshot(snapshot);
  state.snapshotFingerprint = snapshotFingerprint;
  state.snapshotSlot = snapshot.slot;
  validateSnapshotProgression(discovery, snapshot, config.snapshotMaxSlotLag);
  const final = pumpFunFinalState(snapshot, intent.mint, discovered);
  const amountInRaw = intent.side === 'BUY' ? intent.quoteAmountRaw : intent.baseAmountRaw;
  if (amountInRaw === null) throw new TypeError('Invalid execution intent amount.');
  const computation = computePumpFunExecutionQuote({
    mint: intent.mint,
    quoteMint: intent.quoteMint,
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    side: intent.side,
    amountInRaw,
    slippageBps: config.slippageBps,
    accounts: Object.freeze([
      requiredAccount(snapshot, 0), requiredAccount(snapshot, 1),
      requiredAccount(snapshot, 3), requiredAccount(snapshot, 2),
    ]),
  });
  if (intent.side === 'BUY' && !computation.reverseSellAvailable) {
    throw quoteTerminal('SELL_QUOTE_UNAVAILABLE');
  }
  const protectedAmountOutRaw = maximum(
    intent.minimumAmountOutRaw,
    computation.minimumAmountOutRaw,
  );
  if (protectedAmountOutRaw > computation.expectedAmountOutRaw) {
    throw quoteTerminal('MINIMUM_AMOUNT_OUT_VIOLATED');
  }
  const expiresAtMs = checkedExpiry(observedAtMs, config.quoteMaxAgeMs);
  const quote = executionQuote(Object.freeze({
    payloadVersion: 1,
    venue: 'PUMP_FUN',
    providerId: session.providerId,
    mint: intent.mint,
    quoteMint: intent.quoteMint,
    baseTokenProgram: computation.baseTokenProgram,
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    side: intent.side,
    amountInRaw,
    expectedAmountOutRaw: computation.expectedAmountOutRaw,
    protectedAmountOutRaw,
    feesRaw: computation.feesRaw,
    slippageBps: config.slippageBps,
    snapshotSlot: snapshot.slot,
    observedAtMs,
    expiresAtMs,
    snapshotFingerprint,
  }));
  state.quote = quote;
  requireFresh(quote, intent.expiresAtMs, now(dependencies.clock));
  state.stage = 'BUILD';
  const plan = await buildPumpFunPlan(pumpFunBuildRequest(
    quote,
    config.executorPublicKey,
    final,
    snapshot,
  ));
  state.stage = 'FENCE';
  await renewAndRecord(renew, 'BEFORE_SIMULATION', signal, state);
  state.stage = 'QUOTE';
  requireFresh(quote, intent.expiresAtMs, now(dependencies.clock));
  const gateway = new SolanaSimulationGateway(session, receiptAuthority, Object.freeze({
    maxTransactionBytes: 1_232,
    maxComputeUnits: config.maxComputeUnits,
    maxFeeLamports: config.maxFeeLamports,
    maxFeePayerLamportDebit: config.maxFeePayerLamportDebit,
  }));
  state.stage = 'SIMULATION';
  const evidence = await gateway.simulate(Object.freeze({
    plan,
    snapshot,
    receipt: receiptAuthority.issue(plan, snapshot),
  }), signal);
  requireFresh(quote, intent.expiresAtMs, now(dependencies.clock));
  return successArtifact(
    context,
    config,
    genesis,
    quote,
    evidence,
    session.usage().rpcCallsUsed,
  );
}

async function evaluatePumpSwap(
  dependencies: ExecutionAttemptEvaluatorDependencies,
  receiptAuthority: BuildReceiptAuthority,
  context: ExecutionAttemptEvaluationContext,
  signal: AbortSignal,
  renew: (boundary: ExecutionAttemptRenewBoundary) => Promise<void>,
  session: ExecutionDiscoveryMarketGateway,
  genesis: ExecutionGenesisEvidence,
  discovered: DiscoveredPumpFunState,
  poolProof: ExecutionVenuePool,
  discovery: ExecutionAddressDiscovery,
  state: EvaluationState,
): Promise<ExecutionSimulationArtifactDraftV1> {
  const intent = context.claim.intent;
  const config = dependencies.config;
  const addresses = pumpSwapFinalAddresses(
    poolProof,
    config.executorPublicKey,
    discovered.baseTokenProgram,
  );
  state.stage = 'PROVIDER';
  const snapshot = await session.readAccountSnapshot(addresses, signal);
  state.stage = 'QUOTE';
  const observedAtMs = now(dependencies.clock);
  const snapshotFingerprint = fingerprintSnapshot(snapshot);
  state.snapshotFingerprint = snapshotFingerprint;
  state.snapshotSlot = snapshot.slot;
  validateSnapshotProgression(discovery, snapshot, config.snapshotMaxSlotLag);
  validateFinalPumpSwapCurve(snapshot, intent.mint, discovered);
  const canonicalPool = canonicalMarketPool(poolProof);
  const readonlyAccounts = snapshot.accounts.map((account) => account === null
    ? null
    : readonlySnapshot(account, snapshot.slot));
  const feeState = decodePumpSwapFeeState(
    Object.freeze([
      readonlyAccounts[0] ?? null,
      readonlyAccounts[1] ?? null,
      readonlyAccounts[3] ?? null,
      readonlyAccounts[2] ?? null,
    ]),
    canonicalPool,
  );
  const poolState = decodePumpSwapPoolAccount(requiredReadonly(readonlyAccounts, 2));
  const baseVaultAmountRaw = tokenAmount(requiredAccount(snapshot, 5));
  const quoteVaultAmountRaw = tokenAmount(requiredAccount(snapshot, 6));
  const reserves: MarketReserves = Object.freeze({
    pool: poolProof.poolAddress,
    baseReservesRaw: baseVaultAmountRaw,
    quoteVaultAmountRaw,
    virtualQuoteReservesRaw: poolState.virtualQuoteReservesRaw,
    effectiveQuoteReservesRaw: computeEffectiveQuoteReservesRaw(
      quoteVaultAmountRaw,
      poolState.virtualQuoteReservesRaw,
    ),
    observedSlot: snapshot.slot,
    observedAtMs,
  });
  const amountInRaw = intent.baseAmountRaw;
  if (amountInRaw === null) throw new TypeError('Invalid PumpSwap SELL amount.');
  const marketQuote = createPumpSwapQuote(Object.freeze({
    pool: canonicalPool,
    reserves,
    inputMint: intent.mint,
    amountInRaw,
    slippageBps: config.slippageBps,
  }), feeState, observedAtMs);
  const protectedAmountOutRaw = maximum(
    intent.minimumAmountOutRaw,
    marketQuote.minimumAmountOutRaw,
  );
  if (protectedAmountOutRaw > marketQuote.amountOutRaw) {
    throw quoteTerminal('MINIMUM_AMOUNT_OUT_VIOLATED');
  }
  const quote = executionQuote(Object.freeze({
    payloadVersion: 1,
    venue: 'PUMP_SWAP',
    providerId: session.providerId,
    mint: intent.mint,
    quoteMint: intent.quoteMint,
    baseTokenProgram: discovered.baseTokenProgram,
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    side: 'SELL',
    amountInRaw,
    expectedAmountOutRaw: marketQuote.amountOutRaw,
    protectedAmountOutRaw,
    feesRaw: marketQuote.feesRaw,
    slippageBps: config.slippageBps,
    snapshotSlot: snapshot.slot,
    observedAtMs,
    expiresAtMs: checkedExpiry(observedAtMs, config.quoteMaxAgeMs),
    snapshotFingerprint,
  }));
  state.quote = quote;
  requireFresh(quote, intent.expiresAtMs, now(dependencies.clock));
  state.stage = 'BUILD';
  const plan = await buildPumpSwapPlan(Object.freeze({
    quote: pumpSwapBuildQuote(quote),
    user: config.executorPublicKey,
    poolProof,
    snapshot: pumpSwapBuildSnapshot(snapshot),
  }));
  state.stage = 'FENCE';
  await renewAndRecord(renew, 'BEFORE_SIMULATION', signal, state);
  state.stage = 'QUOTE';
  requireFresh(quote, intent.expiresAtMs, now(dependencies.clock));
  const gateway = new SolanaSimulationGateway(session, receiptAuthority, Object.freeze({
    maxTransactionBytes: 1_232,
    maxComputeUnits: config.maxComputeUnits,
    maxFeeLamports: config.maxFeeLamports,
    maxFeePayerLamportDebit: config.maxFeePayerLamportDebit,
  }));
  state.stage = 'SIMULATION';
  const evidence = await gateway.simulate(Object.freeze({
    plan,
    snapshot,
    receipt: receiptAuthority.issue(plan, snapshot),
  }), signal);
  requireFresh(quote, intent.expiresAtMs, now(dependencies.clock));
  return successArtifact(
    context,
    config,
    genesis,
    quote,
    evidence,
    session.usage().rpcCallsUsed,
  );
}

function pumpSwapFinalAddresses(
  pool: ExecutionVenuePool,
  userValue: string,
  baseTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022',
): readonly string[] {
  const user = new PublicKey(userValue);
  const mint = new PublicKey(pool.baseMint);
  const tokenProgram = baseTokenProgram === 'SPL_TOKEN' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const volume = userVolumeAccumulatorPda(user);
  return Object.freeze([
    GLOBAL_CONFIG_PDA.toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(),
    pool.poolAddress, pool.baseMint, pool.quoteMint, pool.baseVault, pool.quoteVault,
    user.toBase58(), getAssociatedTokenAddressSync(mint, user, true, tokenProgram).toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID).toBase58(),
    volume.toBase58(), getAssociatedTokenAddressSync(NATIVE_MINT, volume, true, TOKEN_PROGRAM_ID).toBase58(),
    poolV2Pda(mint).toBase58(), bondingCurvePda(mint).toBase58(),
  ]);
}

function validateFinalPumpSwapCurve(
  snapshot: ExecutionAccountSnapshot,
  mint: string,
  discovered: DiscoveredPumpFunState,
): void {
  const mintAccount = requiredAccount(snapshot, 3);
  const curveAccount = requiredAccount(snapshot, 13);
  const curve = decodeCurve(curveAccount);
  const expectedProgram = discovered.baseTokenProgram === 'SPL_TOKEN'
    ? TOKEN_PROGRAM_ID.toBase58() : TOKEN_2022_PROGRAM_ID.toBase58();
  if (mintAccount.address !== mint || mintAccount.owner !== expectedProgram
    || mintAccount.executable
    || curveAccount.address !== bondingCurvePda(new PublicKey(mint)).toBase58()
    || curveAccount.owner !== PUMP_PROGRAM_ID || curveAccount.executable
    || !discovered.curve.complete || !curve.complete
    || curve.quoteMint.toBase58() !== discovered.curve.quoteMint.toBase58()) {
    throw new TypeError('PumpSwap discovery drift.');
  }
}

function canonicalMarketPool(value: ExecutionVenuePool): CanonicalMarketPool {
  return Object.freeze({
    address: value.poolAddress,
    market: value.market,
    programId: value.programId,
    baseMint: value.baseMint,
    quoteAsset: Object.freeze({
      mint: value.quoteMint,
      decimals: value.quoteDecimals,
      tokenProgram: value.quoteTokenProgram,
    }),
    index: value.poolIndex,
    creator: value.creator,
    baseVault: value.baseVault,
    quoteVault: value.quoteVault,
    lpMint: value.lpMint,
    baseTokenProgram: value.baseTokenProgram,
    confirmationStatus: value.poolConfirmationStatus,
    activatedAt: Object.freeze({
      slot: value.activatedSlot,
      transactionIndex: value.transactionIndex,
      instructionIndex: value.instructionIndex,
      innerInstructionIndex: value.innerInstructionIndex,
    }),
  });
}

function pumpSwapBuildQuote(quote: ExecutionQuoteV1): PumpSwapBuildQuoteV1 {
  if (quote.venue !== 'PUMP_SWAP' || quote.side !== 'SELL') {
    throw new TypeError('Invalid PumpSwap build quote.');
  }
  return Object.freeze({
    payloadVersion: 1,
    venue: 'PUMP_SWAP',
    side: 'SELL',
    mint: quote.mint,
    quoteMint: quote.quoteMint,
    baseTokenProgram: quote.baseTokenProgram,
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    amountInRaw: quote.amountInRaw,
    expectedAmountOutRaw: quote.expectedAmountOutRaw,
    protectedAmountOutRaw: quote.protectedAmountOutRaw,
    snapshotSlot: quote.snapshotSlot,
    quoteFingerprint: quote.quoteFingerprint,
    snapshotFingerprint: quote.snapshotFingerprint,
  });
}

function pumpSwapBuildSnapshot(snapshot: ExecutionAccountSnapshot): PumpSwapExactSlotSnapshotV1 {
  return Object.freeze({
    slot: snapshot.slot,
    globalConfig: rawBuildAccount(requiredAccount(snapshot, 0)),
    feeConfig: rawBuildAccount(requiredAccount(snapshot, 1)),
    pool: rawBuildAccount(requiredAccount(snapshot, 2)),
    baseMint: mintBuildAccount(requiredAccount(snapshot, 3)),
    quoteMint: mintBuildAccount(requiredAccount(snapshot, 4)),
    baseVault: tokenBuildAccount(snapshot, 5),
    quoteVault: tokenBuildAccount(snapshot, 6),
    userBaseTokenAccount: tokenBuildAccount(snapshot, 8),
    userQuoteTokenAccount: tokenBuildAccount(snapshot, 9),
    userVolumeAccumulator: tokenBuildAccount(snapshot, 10),
    userVolumeQuoteTokenAccount: tokenBuildAccount(snapshot, 11),
    poolV2: tokenBuildAccount(snapshot, 12),
  });
}

function rawBuildAccount(account: ExecutionRpcAccount): Readonly<{
  readonly address: string;
  readonly ownerProgramId: string;
  readonly dataBase64: string;
}> {
  return Object.freeze({
    address: account.address,
    ownerProgramId: account.owner,
    dataBase64: account.dataBase64,
  });
}

function mintBuildAccount(account: ExecutionRpcAccount): Readonly<{
  readonly address: string;
  readonly ownerProgramId: string;
  readonly dataBase64: string;
  readonly decoded: PumpSwapRawMintDecodedV1;
}> {
  const data = Buffer.from(account.dataBase64, 'base64');
  if (data.length < MintLayout.span) throw new TypeError('Truncated mint.');
  const raw = MintLayout.decode(data.subarray(0, MintLayout.span));
  return Object.freeze({
    ...rawBuildAccount(account),
    decoded: Object.freeze({
      mintAuthorityOption: raw.mintAuthorityOption,
      mintAuthority: raw.mintAuthority.toBase58(),
      supplyRaw: raw.supply,
      decimals: raw.decimals,
      isInitialized: raw.isInitialized,
      freezeAuthorityOption: raw.freezeAuthorityOption,
      freezeAuthority: raw.freezeAuthority.toBase58(),
    }),
  });
}

function tokenBuildAccount(
  snapshot: ExecutionAccountSnapshot,
  index: number,
): PumpSwapExactSlotSnapshotV1['baseVault'] {
  const address = snapshot.addresses[index];
  const account = snapshot.accounts[index];
  if (address === undefined || account === undefined) throw new TypeError('Invalid token snapshot index.');
  return Object.freeze(account === null
    ? { address, exists: false, ownerProgramId: null, dataBase64: null }
    : { address, exists: true, ownerProgramId: account.owner, dataBase64: account.dataBase64 });
}

function tokenAmount(account: ExecutionRpcAccount): bigint {
  const data = Buffer.from(account.dataBase64, 'base64');
  if (data.length < AccountLayout.span) throw new TypeError('Truncated token account.');
  return AccountLayout.decode(data.subarray(0, AccountLayout.span)).amount;
}

function requiredReadonly(
  accounts: readonly (ReadonlyAccountSnapshot | null)[],
  index: number,
): ReadonlyAccountSnapshot {
  const account = accounts[index];
  if (account === undefined || account === null) throw new TypeError('Missing readonly account.');
  return account;
}

export interface ExecutionQuoteV1 {
  readonly payloadVersion: 1;
  readonly venue: 'PUMP_FUN' | 'PUMP_SWAP';
  readonly providerId: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly baseTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022';
  readonly quoteTokenProgram: 'SPL_TOKEN';
  readonly quoteDecimals: 9;
  readonly side: 'BUY' | 'SELL';
  readonly amountInRaw: bigint;
  readonly expectedAmountOutRaw: bigint;
  readonly protectedAmountOutRaw: bigint;
  readonly feesRaw: bigint;
  readonly slippageBps: bigint;
  readonly snapshotSlot: bigint;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly snapshotFingerprint: string;
  readonly quoteFingerprint: string;
}

type QuoteWithoutFingerprint = Omit<ExecutionQuoteV1, 'quoteFingerprint'>;

function executionQuote(value: QuoteWithoutFingerprint): ExecutionQuoteV1 {
  const quoteFingerprint = hash([
    'execution-quote-v1', String(value.payloadVersion), value.venue, value.providerId,
    value.mint, value.quoteMint, value.baseTokenProgram, value.quoteTokenProgram,
    String(value.quoteDecimals), value.side, value.amountInRaw.toString(10),
    value.expectedAmountOutRaw.toString(10), value.protectedAmountOutRaw.toString(10),
    value.feesRaw.toString(10), value.slippageBps.toString(10),
    value.snapshotSlot.toString(10), String(value.observedAtMs), String(value.expiresAtMs),
    value.snapshotFingerprint,
  ]);
  return Object.freeze({ ...value, quoteFingerprint });
}

interface DiscoveredPumpFunState {
  readonly curve: BondingCurve;
  readonly normalizedQuoteMint: string;
  readonly baseTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022';
}

function discoveryState(
  discovery: ExecutionAddressDiscovery,
  mint: string,
): DiscoveredPumpFunState {
  const curveAddress = bondingCurvePda(new PublicKey(mint)).toBase58();
  if (discovery.addresses.length !== 2
    || discovery.addresses[0] !== curveAddress
    || discovery.addresses[1] !== mint) throw new TypeError('Invalid discovery response.');
  const curveAccount = requiredAccount(discovery, 0);
  const mintAccount = requiredAccount(discovery, 1);
  if (curveAccount.address !== curveAddress || mintAccount.address !== mint
    || curveAccount.owner !== PUMP_PROGRAM_ID || curveAccount.executable) {
    throw new TypeError('Invalid bonding curve discovery.');
  }
  const baseTokenProgram = mintAccount.owner === TOKEN_PROGRAM_ID.toBase58()
    ? 'SPL_TOKEN' as const
    : mintAccount.owner === TOKEN_2022_PROGRAM_ID.toBase58()
      ? 'TOKEN_2022' as const
      : null;
  if (baseTokenProgram === null || mintAccount.executable) throw new TypeError('Invalid mint discovery.');
  const curve = decodeCurve(curveAccount);
  const quoteMint = curve.quoteMint.toBase58();
  return Object.freeze({
    curve,
    normalizedQuoteMint: quoteMint === DEFAULT_PUBLIC_KEY ? WSOL_MINT : quoteMint,
    baseTokenProgram,
  });
}

function pumpFunFinalAddresses(
  mintValue: string,
  userValue: string,
  baseTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022',
): readonly string[] {
  const mint = new PublicKey(mintValue);
  const user = new PublicKey(userValue);
  const tokenProgram = baseTokenProgram === 'SPL_TOKEN' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  return Object.freeze([
    GLOBAL_PDA.toBase58(), PUMP_FEE_CONFIG_PDA.toBase58(), mint.toBase58(),
    bondingCurvePda(mint).toBase58(), user.toBase58(),
    getAssociatedTokenAddressSync(mint, user, true, tokenProgram).toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID).toBase58(),
  ]);
}

function pumpFunFinalState(
  snapshot: ExecutionAccountSnapshot,
  mint: string,
  discovered: DiscoveredPumpFunState,
): Readonly<{ readonly global: Global; readonly curve: BondingCurve }> {
  const mintAccount = requiredAccount(snapshot, 2);
  const curveAccount = requiredAccount(snapshot, 3);
  const curve = decodeCurve(curveAccount);
  const expectedProgram = discovered.baseTokenProgram === 'SPL_TOKEN'
    ? TOKEN_PROGRAM_ID.toBase58() : TOKEN_2022_PROGRAM_ID.toBase58();
  if (mintAccount.address !== mint || mintAccount.owner !== expectedProgram
    || mintAccount.executable
    || curveAccount.address !== bondingCurvePda(new PublicKey(mint)).toBase58()
    || curveAccount.owner !== PUMP_PROGRAM_ID || curveAccount.executable
    || curve.complete !== discovered.curve.complete
    || curve.quoteMint.toBase58() !== discovered.curve.quoteMint.toBase58()) {
    throw new TypeError('Pump.fun discovery drift.');
  }
  return Object.freeze({ global: decodeGlobal(requiredAccount(snapshot, 0)), curve });
}

function pumpFunBuildRequest(
  quote: ExecutionQuoteV1,
  user: string,
  state: Readonly<{ readonly global: Global; readonly curve: BondingCurve }>,
  snapshot: ExecutionAccountSnapshot,
): PumpFunBuildRequestV1 {
  if (quote.venue !== 'PUMP_FUN' || state.curve.complete) throw new TypeError('Inactive Pump.fun venue.');
  const baseAccount = snapshot.accounts[5];
  const baseAddress = snapshot.addresses[5];
  if (baseAddress === undefined) throw new TypeError('Missing user base address.');
  const buildQuote: PumpFunBuildQuoteV1 = Object.freeze({
    payloadVersion: 1, venue: 'PUMP_FUN', side: quote.side, mint: quote.mint,
    quoteMint: quote.quoteMint, baseTokenProgram: quote.baseTokenProgram,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    amountInRaw: quote.amountInRaw, expectedAmountOutRaw: quote.expectedAmountOutRaw,
    protectedAmountOutRaw: quote.protectedAmountOutRaw, snapshotSlot: quote.snapshotSlot,
    quoteFingerprint: quote.quoteFingerprint, snapshotFingerprint: quote.snapshotFingerprint,
  });
  return Object.freeze({
    quote: buildQuote,
    user,
    curve: Object.freeze({
      mint: quote.mint,
      address: bondingCurvePda(new PublicKey(quote.mint)).toBase58(),
      ownerProgramId: PUMP_PROGRAM_ID,
      exists: true,
      complete: false,
      creator: state.curve.creator.toBase58(),
      isMayhemMode: state.curve.isMayhemMode,
    }),
    userBaseTokenAccount: Object.freeze({
      address: baseAddress,
      exists: baseAccount !== null && baseAccount !== undefined,
    }),
    recipients: Object.freeze({
      feeRecipient: state.global.feeRecipient.toBase58(),
      feeRecipients: Object.freeze(state.global.feeRecipients.map((value) => value.toBase58())),
      reservedFeeRecipient: state.global.reservedFeeRecipient.toBase58(),
      reservedFeeRecipients: Object.freeze(state.global.reservedFeeRecipients.map((value) => value.toBase58())),
      buybackFeeRecipients: Object.freeze(state.global.buybackFeeRecipients.map((value) => value.toBase58())),
    }),
  });
}

function successArtifact(
  context: ExecutionAttemptEvaluationContext,
  config: SimulationOnlyExecutorConfig,
  genesis: ExecutionGenesisEvidence,
  quote: ExecutionQuoteV1,
  evidence: Awaited<ReturnType<SolanaSimulationGateway['simulate']>>,
  rpcCallsUsed: number,
): ExecutionSimulationArtifactDraftV1 {
  const intent = context.claim.intent;
  return createExecutionSimulationArtifactDraft({
    intentId: intent.id,
    attemptNumber: context.attempt.attemptNumber,
    intentStateRevision: intent.stateRevision,
    strategyId: intent.strategyId,
    strategyVersion: intent.strategyVersion,
    decisionFingerprint: intent.decisionFingerprint,
    resultKind: 'SUCCESS',
    effectiveVenue: quote.venue,
    providerId: quote.providerId,
    executorPublicKey: config.executorPublicKey,
    expectedGenesisHash: config.expectedGenesisHash,
    observedGenesisHash: genesis.observedGenesisHash,
    configurationFingerprint: configurationFingerprint(config),
    quoteFingerprint: quote.quoteFingerprint,
    snapshotFingerprint: evidence.snapshotFingerprint,
    buildFingerprint: evidence.buildFingerprint,
    messageHash: evidence.messageHash,
    blockhash: evidence.blockhash,
    lastValidBlockHeight: evidence.lastValidBlockHeight,
    blockhashContextSlot: evidence.blockhashContextSlot,
    snapshotSlot: quote.snapshotSlot,
    feeContextSlot: evidence.feeContextSlot,
    simulationSlot: evidence.simulationSlot,
    amountInRaw: quote.amountInRaw,
    expectedAmountOutRaw: quote.expectedAmountOutRaw,
    protectedAmountOutRaw: quote.protectedAmountOutRaw,
    feesRaw: quote.feesRaw,
    estimatedFeeLamports: evidence.estimatedFeeLamports,
    simulatedFeePayerLamportDebit: evidence.simulatedFeePayerLamportDebit,
    unitsConsumed: evidence.unitsConsumed,
    simulatedBaseDeltaRaw: evidence.simulatedBaseDeltaRaw,
    simulatedQuoteDeltaRaw: evidence.simulatedQuoteDeltaRaw,
    rpcCallsUsed,
    rpcCallsLimit: config.maxRpcCallsPerAttempt,
    quoteStatus: 'SUCCEEDED',
    buildStatus: 'SUCCEEDED',
    simulationStatus: 'SUCCEEDED',
    failureStage: null,
    failureCode: null,
    terminalReasonCode: 'INTENT_SUCCEEDED',
    logsFingerprint: evidence.logsFingerprint,
    logsLineCount: evidence.logsLineCount,
  });
}

function failureArtifactOrThrow(
  dependencies: ExecutionAttemptEvaluatorDependencies,
  context: ExecutionAttemptEvaluationContext,
  signal: AbortSignal,
  state: EvaluationState,
  error: unknown,
): ExecutionSimulationArtifactDraftV1 {
  if (signal.aborted && (
    isInternalExecutionAttemptEvaluatorError(error, 'OPERATION_ABORTED')
    || (isExecutionProviderSessionError(error) && error.code === 'OPERATION_ABORTED')
    || (isInternalExecutionSimulationGatewayError(error) && error.code === 'OPERATION_ABORTED')
  )) throw aborted();
  if (state.stage === 'FENCE') throw error;

  if (isExecutionProviderSessionError(error)) {
    if (error.code === 'INVALID_INPUT' || error.code === 'OPERATION_ABORTED') throw error;
    const observedGenesis = error.genesisEvidence?.observedGenesisHash
      ?? state.genesis?.observedGenesisHash ?? null;
    if (error.code === 'GENESIS_MISMATCH') {
      return failureArtifact(dependencies, context, state, {
        resultKind: 'PROVIDER_FAILED', failureStage: 'PROVIDER', failureCode: error.code,
        terminalReasonCode: 'GENESIS_MISMATCH', observedGenesisHash: observedGenesis,
      });
    }
    return failureArtifact(dependencies, context, state, {
      resultKind: 'PROVIDER_FAILED', failureStage: 'PROVIDER', failureCode: error.code,
      terminalReasonCode: error.code === 'RPC_RESPONSE_INVALID'
        ? 'EXECUTION_EVIDENCE_INVALID' : 'EXECUTION_PROVIDER_FAILED',
      observedGenesisHash: observedGenesis,
    });
  }

  if (state.stage === 'ROUTE') {
    if (!(error instanceof ExecutionVenueRoutingError)) throw error;
    if (error.code === 'EXECUTION_EVIDENCE_INVALID') {
      return quoteFailure(dependencies, context, state, 'RPC_RESPONSE_INVALID', 'EXECUTION_EVIDENCE_INVALID');
    }
    return quoteFailure(dependencies, context, state, 'QUOTE_REJECTED', error.code);
  }
  if (error instanceof QuoteTerminalError) {
    return quoteFailure(dependencies, context, state, 'QUOTE_REJECTED', error.reason);
  }
  if (error instanceof PumpFunExecutionQuoteError) {
    return error.code === 'EXECUTION_EVIDENCE_INVALID'
      ? quoteFailure(dependencies, context, state, 'RPC_RESPONSE_INVALID', 'EXECUTION_EVIDENCE_INVALID')
      : quoteFailure(dependencies, context, state, 'QUOTE_REJECTED', error.code);
  }
  if (error instanceof SellQuoteUnavailableError) {
    return quoteFailure(
      dependencies, context, state, 'QUOTE_REJECTED', 'SELL_QUOTE_UNAVAILABLE',
    );
  }
  if (error instanceof UnsupportedPumpSwapTokenExtensionError) {
    return quoteFailure(
      dependencies, context, state, 'QUOTE_REJECTED', 'UNSUPPORTED_TOKEN_EXTENSION',
    );
  }
  if (state.stage === 'QUOTE' && error instanceof Error) {
    return quoteFailure(
      dependencies, context, state, 'RPC_RESPONSE_INVALID', 'EXECUTION_EVIDENCE_INVALID',
    );
  }
  if (state.stage === 'BUILD' && error instanceof ExecutionBuildPolicyError) {
    return failureArtifact(dependencies, context, state, {
      resultKind: 'BUILD_FAILED', failureStage: 'BUILD',
      failureCode: 'BUILD_POLICY_REJECTED', terminalReasonCode: 'EXECUTION_BUILD_FAILED',
    });
  }
  if (isInternalExecutionSimulationGatewayError(error)) {
    if (error.code === 'INVALID_INPUT' || error.code === 'OPERATION_ABORTED') throw error;
    return gatewayFailure(dependencies, context, state, error.stage, error.code, error.evidence);
  }
  throw error;
}

function quoteFailure(
  dependencies: ExecutionAttemptEvaluatorDependencies,
  context: ExecutionAttemptEvaluationContext,
  state: EvaluationState,
  failureCode: ExecutionSimulationFailureCode,
  terminalReasonCode: ExecutionIntentReasonCode,
): ExecutionSimulationArtifactDraftV1 {
  return failureArtifact(dependencies, context, state, {
    resultKind: 'QUOTE_FAILED', failureStage: 'QUOTE', failureCode, terminalReasonCode,
  });
}

function gatewayFailure(
  dependencies: ExecutionAttemptEvaluatorDependencies,
  context: ExecutionAttemptEvaluationContext,
  state: EvaluationState,
  stage: ExecutionSimulationGatewayStage,
  failureCode: Exclude<ExecutionSimulationFailureCode, 'GENESIS_MISMATCH' | 'QUOTE_REJECTED'>,
  evidence: ExecutionSimulationPartialEvidenceV1,
): ExecutionSimulationArtifactDraftV1 {
  const resultKind = stage === 'BUILD' ? 'BUILD_FAILED'
    : stage === 'BLOCKHASH' ? 'BLOCKHASH_FAILED'
      : stage === 'FEE' ? 'FEE_FAILED' : 'SIMULATION_FAILED';
  const terminalReasonCode: ExecutionIntentReasonCode = failureCode === 'SIMULATION_PROGRAM_ERROR'
    ? context.claim.intent.side === 'BUY' ? 'BUY_SIMULATION_FAILED' : 'SELL_SIMULATION_FAILED'
    : failureCode === 'BUILD_POLICY_REJECTED' ? 'EXECUTION_BUILD_FAILED'
      : failureCode === 'RPC_RESPONSE_INVALID' || failureCode === 'SIMULATION_EVIDENCE_INVALID'
        ? 'EXECUTION_EVIDENCE_INVALID' : 'EXECUTION_PROVIDER_FAILED';
  return failureArtifact(dependencies, context, state, {
    resultKind, failureStage: stage, failureCode, terminalReasonCode, evidence,
  });
}

interface FailureArtifactInput {
  readonly resultKind: 'PROVIDER_FAILED' | 'QUOTE_FAILED' | 'BUILD_FAILED'
    | 'BLOCKHASH_FAILED' | 'FEE_FAILED' | 'SIMULATION_FAILED';
  readonly failureStage: 'PROVIDER' | 'QUOTE' | ExecutionSimulationGatewayStage;
  readonly failureCode: ExecutionSimulationFailureCode;
  readonly terminalReasonCode: ExecutionIntentReasonCode;
  readonly observedGenesisHash?: string | null;
  readonly evidence?: ExecutionSimulationPartialEvidenceV1;
}

function failureArtifact(
  dependencies: ExecutionAttemptEvaluatorDependencies,
  context: ExecutionAttemptEvaluationContext,
  state: EvaluationState,
  failure: FailureArtifactInput,
): ExecutionSimulationArtifactDraftV1 {
  const config = dependencies.config;
  const intent = context.claim.intent;
  const quote = state.quote;
  const evidence = failure.evidence;
  const quoteSucceeded = failure.resultKind !== 'PROVIDER_FAILED'
    && failure.resultKind !== 'QUOTE_FAILED';
  const buildSucceeded = failure.resultKind === 'BLOCKHASH_FAILED'
    || failure.resultKind === 'FEE_FAILED' || failure.resultKind === 'SIMULATION_FAILED';
  const blockhashSucceeded = failure.resultKind === 'FEE_FAILED'
    || failure.resultKind === 'SIMULATION_FAILED';
  const feeSucceeded = failure.resultKind === 'SIMULATION_FAILED';
  const snapshotFingerprint = quoteSucceeded ? quote?.snapshotFingerprint ?? null
    : failure.resultKind === 'QUOTE_FAILED' ? state.snapshotFingerprint : null;
  const snapshotSlot = quoteSucceeded ? quote?.snapshotSlot ?? null
    : failure.resultKind === 'QUOTE_FAILED' ? state.snapshotSlot : null;
  return createExecutionSimulationArtifactDraft({
    intentId: intent.id,
    attemptNumber: context.attempt.attemptNumber,
    intentStateRevision: intent.stateRevision,
    strategyId: intent.strategyId,
    strategyVersion: intent.strategyVersion,
    decisionFingerprint: intent.decisionFingerprint,
    resultKind: failure.resultKind,
    effectiveVenue: failure.resultKind === 'PROVIDER_FAILED' ? null : state.venue,
    providerId: state.session?.providerId ?? config.providerId,
    executorPublicKey: config.executorPublicKey,
    expectedGenesisHash: config.expectedGenesisHash,
    observedGenesisHash: failure.observedGenesisHash
      ?? state.genesis?.observedGenesisHash ?? null,
    configurationFingerprint: configurationFingerprint(config),
    quoteFingerprint: quoteSucceeded ? quote?.quoteFingerprint ?? null : null,
    snapshotFingerprint,
    buildFingerprint: buildSucceeded ? evidence?.buildFingerprint ?? null : null,
    messageHash: blockhashSucceeded ? evidence?.messageHash ?? null : null,
    blockhash: blockhashSucceeded ? evidence?.blockhash ?? null : null,
    lastValidBlockHeight: blockhashSucceeded ? evidence?.lastValidBlockHeight ?? null : null,
    blockhashContextSlot: blockhashSucceeded ? evidence?.blockhashContextSlot ?? null : null,
    snapshotSlot,
    feeContextSlot: feeSucceeded ? evidence?.feeContextSlot ?? null : null,
    simulationSlot: failure.resultKind === 'SIMULATION_FAILED'
      ? evidence?.simulationSlot ?? null : null,
    amountInRaw: quoteSucceeded ? quote?.amountInRaw ?? null : null,
    expectedAmountOutRaw: quoteSucceeded ? quote?.expectedAmountOutRaw ?? null : null,
    protectedAmountOutRaw: quoteSucceeded ? quote?.protectedAmountOutRaw ?? null : null,
    feesRaw: quoteSucceeded ? quote?.feesRaw ?? null : null,
    estimatedFeeLamports: feeSucceeded ? evidence?.estimatedFeeLamports ?? null : null,
    simulatedFeePayerLamportDebit: failure.resultKind === 'SIMULATION_FAILED'
      ? evidence?.simulatedFeePayerLamportDebit ?? null : null,
    unitsConsumed: failure.resultKind === 'SIMULATION_FAILED' ? evidence?.unitsConsumed ?? null : null,
    simulatedBaseDeltaRaw: failure.resultKind === 'SIMULATION_FAILED'
      ? evidence?.simulatedBaseDeltaRaw ?? null : null,
    simulatedQuoteDeltaRaw: failure.resultKind === 'SIMULATION_FAILED'
      ? evidence?.simulatedQuoteDeltaRaw ?? null : null,
    rpcCallsUsed: state.session?.usage().rpcCallsUsed ?? 0,
    rpcCallsLimit: config.maxRpcCallsPerAttempt,
    quoteStatus: quoteSucceeded ? 'SUCCEEDED' : 'FAILED',
    buildStatus: buildSucceeded ? 'SUCCEEDED'
      : failure.resultKind === 'BUILD_FAILED' ? 'FAILED' : 'NOT_RUN',
    simulationStatus: failure.resultKind === 'SIMULATION_FAILED' ? 'FAILED' : 'NOT_RUN',
    failureStage: failure.failureStage,
    failureCode: failure.failureCode,
    terminalReasonCode: failure.terminalReasonCode,
    logsFingerprint: failure.resultKind === 'SIMULATION_FAILED'
      ? evidence?.logsFingerprint ?? null : null,
    logsLineCount: failure.resultKind === 'SIMULATION_FAILED'
      ? evidence?.logsLineCount ?? null : null,
  });
}

function requiredAccount(
  value: Pick<ExecutionAccountSnapshot, 'accounts'>,
  index: number,
): ExecutionRpcAccount {
  const account = value.accounts[index];
  if (account === undefined || account === null) throw new TypeError('Missing execution account.');
  return account;
}

function readonlySnapshot(account: ExecutionRpcAccount, slot: bigint): ReadonlyAccountSnapshot {
  return Object.freeze({
    address: account.address,
    owner: account.owner,
    data: Buffer.from(account.dataBase64, 'base64'),
    lamports: account.lamports,
    slot,
  });
}

function decodeCurve(account: ExecutionRpcAccount): BondingCurve {
  return PUMP_SDK.decodeBondingCurve(accountInfo(account));
}

function decodeGlobal(account: ExecutionRpcAccount): Global {
  return PUMP_SDK.decodeGlobal(accountInfo(account));
}

function accountInfo(account: ExecutionRpcAccount): AccountInfo<Buffer> {
  if (account.lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Invalid SDK lamports.');
  return {
    data: Buffer.from(account.dataBase64, 'base64'),
    executable: account.executable,
    lamports: Number(account.lamports),
    owner: new PublicKey(account.owner),
    rentEpoch: 0,
  };
}

function fingerprintSnapshot(snapshot: ExecutionAccountSnapshot): string {
  const segments = ['execution-snapshot-v1', snapshot.slot.toString(10)];
  for (let index = 0; index < snapshot.addresses.length; index += 1) {
    const address = snapshot.addresses[index];
    const account = snapshot.accounts[index];
    if (address === undefined || account === undefined) throw new TypeError('Invalid snapshot.');
    if (account === null) segments.push(address, 'ABSENT');
    else segments.push(
      address, 'PRESENT', account.owner, account.lamports.toString(10),
      createHash('sha256').update(Buffer.from(account.dataBase64, 'base64')).digest('hex'),
    );
  }
  return hash(segments);
}

function configurationFingerprint(config: SimulationOnlyExecutorConfig): string {
  const allowlist = [...config.quoteMintAllowlist].sort((left, right) => left.localeCompare(right));
  return hash([
    'execution-simulation-config-v1', EXECUTION_SIMULATION_SPECIFICATION_VERSION,
    String(EXECUTION_SIMULATION_EVALUATOR_VERSION), config.providerId,
    config.executorPublicKey, config.expectedGenesisHash, ...allowlist,
    String(config.quoteMaxAgeMs), config.slippageBps.toString(10),
    String(config.snapshotMaxSlotLag), '1232', config.maxComputeUnits.toString(10),
    config.maxFeeLamports.toString(10), config.maxFeePayerLamportDebit.toString(10),
    config.maxPriorityFeeLamports.toString(10), String(config.rpcTimeoutMs),
    String(config.maxRpcCallsPerAttempt),
  ]);
}

function hash(segments: readonly string[]): string {
  const digest = createHash('sha256');
  for (const segment of segments) {
    const bytes = Buffer.from(segment, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length).update(bytes);
  }
  return digest.digest('hex');
}

function maximum(left: bigint, right: bigint): bigint { return left > right ? left : right; }

function checkedExpiry(observedAtMs: number, maxAgeMs: number): number {
  const result = observedAtMs + maxAgeMs;
  if (!Number.isSafeInteger(result)) throw new TypeError('Invalid quote expiry.');
  return result;
}

function requireFresh(
  quote: ExecutionQuoteV1,
  intentExpiresAtMs: number,
  currentMs: number,
): void {
  if (currentMs > quote.expiresAtMs || currentMs >= intentExpiresAtMs) {
    throw quoteTerminal('QUOTE_STALE');
  }
}

function validateSnapshotProgression(
  discovery: ExecutionAddressDiscovery,
  snapshot: ExecutionAccountSnapshot,
  maximumLag: number,
): void {
  const lag = snapshot.slot - discovery.slot;
  if (lag < 0n || lag > BigInt(maximumLag)) {
    throw new TypeError('Invalid discovery to snapshot progression.');
  }
}

function quoteTerminal(reason: QuoteTerminalError['reason']): QuoteTerminalError {
  return new QuoteTerminalError(reason);
}

function now(clock: (() => number) | undefined): number {
  const value = (clock ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid evaluator clock.');
  return value;
}

async function renewBoundary(
  renew: (boundary: ExecutionAttemptRenewBoundary) => Promise<void>,
  boundary: ExecutionAttemptRenewBoundary,
  signal: AbortSignal,
): Promise<void> {
  requireActive(signal);
  await renew(boundary);
  requireActive(signal);
}

async function renewAndRecord(
  renew: (boundary: ExecutionAttemptRenewBoundary) => Promise<void>,
  boundary: ExecutionAttemptRenewBoundary,
  signal: AbortSignal,
  state: EvaluationState,
): Promise<void> {
  await renewBoundary(renew, boundary, signal);
  state.renewalsCompleted = boundary === 'BEFORE_CANONICAL_SNAPSHOT' ? 1 : 2;
}

async function completeTerminalRenewals(
  renew: (boundary: ExecutionAttemptRenewBoundary) => Promise<void>,
  signal: AbortSignal,
  state: EvaluationState,
): Promise<void> {
  state.stage = 'FENCE';
  if (state.renewalsCompleted === 0) {
    await renewAndRecord(renew, 'BEFORE_CANONICAL_SNAPSHOT', signal, state);
  }
  if (state.renewalsCompleted === 1) {
    await renewAndRecord(renew, 'BEFORE_SIMULATION', signal, state);
  }
}

function requireActive(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) throw new TypeError('Invalid execution attempt signal.');
  if (signal.aborted) throw aborted();
}

function aborted(): ExecutionAttemptEvaluatorError {
  const error = new ExecutionAttemptEvaluatorError('OPERATION_ABORTED');
  INTERNAL_ERRORS.add(error);
  return error;
}
