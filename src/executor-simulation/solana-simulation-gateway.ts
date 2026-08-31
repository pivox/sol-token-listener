import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import bs58 from 'bs58';
import {
  AccountLayout,
  AccountState,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { MessageV0 } from '@solana/web3.js';
import {
  inspectUnsignedBuildPlan,
  InstructionInspectionError,
} from './instruction-inspector.js';
import type { BuildReceiptAuthority } from './build-receipt.js';
import { isExecutionProviderSessionError, type ExecutionProviderSessionErrorCode } from './provider-session.js';
import type {
  ExpectedBuildAccountV1,
  NormalizedInstructionV1,
  UnsignedBuildPlanV1,
  UnsignedBuildIdentityV1,
} from './build-plan.js';
import {
  bondingCurvePda,
  GLOBAL_PDA,
  PUMP_FEE_PROGRAM_ID as PUMP_FUN_FEE_PROGRAM_ID,
  PUMP_FEE_CONFIG_PDA,
  PUMP_PROGRAM_ID,
} from '../launchpads/pumpfun/official-sdk.js';
import {
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID as PUMP_SWAP_FEE_PROGRAM_ID,
  poolV2Pda,
  userVolumeAccumulatorPda,
} from '../markets/pumpswap/official-sdk.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import type {
  ExecutionAccountSnapshot,
  ExecutionMarketGateway,
  ExecutionRpcAccount,
  ExecutionUnsignedSimulationResult,
} from '../ports/execution-market-gateway.js';
import type {
  ExecutionSimulationEvidenceV1,
  ExecutionSimulationGateway,
  ExecutionSimulationGatewayErrorCode,
  ExecutionSimulationGatewayLimitsV1,
  ExecutionSimulationGatewayRequestV1,
  ExecutionSimulationGatewayStage,
  ExecutionSimulationPartialEvidenceV1,
} from '../ports/execution-simulation-gateway.js';

const REQUEST_KEYS = Object.freeze(['plan', 'snapshot', 'receipt'] as const);
const SNAPSHOT_KEYS = Object.freeze(['providerId', 'slot', 'addresses', 'accounts'] as const);
const ACCOUNT_KEYS = Object.freeze([
  'address', 'lamports', 'owner', 'executable', 'rentEpoch', 'space', 'dataBase64',
] as const);
const RESULT_KEYS = Object.freeze([
  'providerId', 'contextSlot', 'failureKind', 'logs', 'unitsConsumed', 'accounts',
  'innerInstructions',
] as const);
const LIMIT_KEYS = Object.freeze([
  'maxTransactionBytes', 'maxComputeUnits', 'maxFeeLamports', 'maxFeePayerLamportDebit',
] as const);
const U64_MAX = (1n << 64n) - 1n;
const MAX_LOG_LINES = 256;
const MAX_LOG_BYTES = 1_024;
const MAX_SNAPSHOT_DATA_BYTES = 4 * 1_024 * 1_024;
const ALLOWED_INNER_PROGRAMS = new Set([
  PublicKey.default.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), PUMP_PROGRAM_ID.toBase58(), PUMP_FUN_FEE_PROGRAM_ID.toBase58(),
  PUMPSWAP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID.toBase58(), PUMP_SWAP_FEE_PROGRAM_ID.toBase58(),
]);
const INTERNAL_GATEWAY_ERRORS = new WeakSet<ExecutionSimulationGatewayError>();

export class ExecutionSimulationGatewayError extends Error {
  public constructor(
    public readonly stage: ExecutionSimulationGatewayStage,
    public readonly code: ExecutionSimulationGatewayErrorCode,
    public readonly evidence: ExecutionSimulationPartialEvidenceV1,
  ) {
    super('Unsigned execution simulation failed.');
    this.name = 'ExecutionSimulationGatewayError';
  }

}
class SimulationOperationAbortedError extends Error {}

interface ValidatedLimits {
  readonly maxTransactionBytes: number;
  readonly maxComputeUnits: bigint;
  readonly maxFeeLamports: bigint;
  readonly maxFeePayerLamportDebit: bigint;
}

interface ValidatedSnapshot {
  readonly providerId: string;
  readonly slot: bigint;
  readonly addresses: readonly string[];
  readonly accounts: readonly (ExecutionRpcAccount | null)[];
  readonly fingerprint: string;
}

interface RequiredSimulationAccounts {
  readonly feePayer: string;
  readonly base: string;
  readonly quote: string;
}

/**
 * Compiles and simulates an inspected build plan without creating, loading or
 * accepting signing material. The only transaction bytes leave this boundary
 * through the narrow provider port and are never returned or retained.
 */
export class SolanaSimulationGateway implements ExecutionSimulationGateway {
  private readonly limits: ValidatedLimits;

  public constructor(
    private readonly provider: ExecutionMarketGateway,
    private readonly receiptAuthority: BuildReceiptAuthority,
    limitsValue: ExecutionSimulationGatewayLimitsV1,
  ) {
    this.limits = limitsFrom(limitsValue);
  }

  public async simulate(
    inputValue: ExecutionSimulationGatewayRequestV1,
    signal: AbortSignal,
  ): Promise<ExecutionSimulationEvidenceV1> {
    let partial = emptyEvidence();
    let stage: ExecutionSimulationGatewayStage = 'BUILD';
    try {
      validateSignal(signal);
      let input: Readonly<Record<string, unknown>>;
      try {
        input = record(inputValue, REQUEST_KEYS);
        if (!this.receiptAuthority.consume(
          input.receipt,
          input.plan as UnsignedBuildPlanV1,
          input.snapshot as ExecutionAccountSnapshot,
        )) throw new Error();
      } catch { throw failure('BUILD', 'SIMULATION_EVIDENCE_INVALID', partial); }
      const inspected = inspectUnsignedBuildPlan(input.plan as never);
      if (!this.provider.ownsAccountSnapshot(input.snapshot as ExecutionAccountSnapshot)) {
        throw failure('BUILD', 'SIMULATION_EVIDENCE_INVALID', partial);
      }
      let snapshot: ValidatedSnapshot;
      try {
        snapshot = snapshotFrom(input.snapshot, inspected);
      } catch {
        throw failure('BUILD', 'SIMULATION_EVIDENCE_INVALID', partial);
      }
      partial = Object.freeze({ ...partial, snapshotFingerprint: snapshot.fingerprint });
      partial = Object.freeze({ ...partial, buildFingerprint: buildFingerprint(inspected.feePayer, inspected.instructions) });
      if (snapshot.providerId !== this.provider.providerId
        || inspected.identity.snapshotSlot !== snapshot.slot
        || inspected.identity.snapshotFingerprint !== snapshot.fingerprint) {
        throw failure('BUILD', 'SIMULATION_EVIDENCE_INVALID', partial);
      }
      const requestedAccounts = simulationAccounts(input.plan, inspected.feePayer);
      stage = 'BLOCKHASH';
      const blockhash = await this.provider.getLatestBlockhash(snapshot.slot, signal);
      if (blockhash.providerId !== snapshot.providerId || !publicKey(blockhash.blockhash)
        || !u64(blockhash.contextSlot) || !u64(blockhash.lastValidBlockHeight)
        || blockhash.contextSlot < snapshot.slot) {
        throw failure('BLOCKHASH', 'RPC_RESPONSE_INVALID', partial);
      }
      const message = new TransactionMessage({
        payerKey: new PublicKey(inspected.feePayer),
        recentBlockhash: blockhash.blockhash,
        instructions: inspected.instructions.map(toInstruction),
      }).compileToV0Message([]);
      assertCompiledMessage(message, inspected.feePayer, inspected.instructions, blockhash.blockhash);
      const messageBytes = message.serialize();
      partial = Object.freeze({
        ...partial,
        messageHash: sha256(Buffer.from(messageBytes)),
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
        blockhashContextSlot: blockhash.contextSlot,
      });
      const transaction = new VersionedTransaction(message);
      const transactionBytes = transaction.serialize();
      if (transactionBytes.length > this.limits.maxTransactionBytes || transaction.signatures.length !== 1
        || transaction.signatures[0]?.length !== 64
        || !transaction.signatures[0].every((byte) => byte === 0)) {
        throw failure('BUILD', 'BUILD_POLICY_REJECTED', partial);
      }
      stage = 'FEE';
      const fee = await this.provider.getFeeForMessage(toBase64(messageBytes), snapshot.slot, signal);
      if (fee.providerId !== snapshot.providerId || !u64(fee.contextSlot)
        || fee.contextSlot < snapshot.slot || fee.feeLamports === null
        || !u64(fee.feeLamports) || fee.feeLamports > this.limits.maxFeeLamports) {
        throw failure('FEE', 'SIMULATION_EVIDENCE_INVALID', partial);
      }
      partial = Object.freeze({ ...partial, feeContextSlot: fee.contextSlot, estimatedFeeLamports: fee.feeLamports });
      stage = 'SIMULATION';
      const simulation = await this.provider.simulateUnsignedTransaction(Object.freeze({
        transactionBase64: toBase64(transactionBytes), snapshotSlot: snapshot.slot,
        accountAddresses: Object.freeze([requestedAccounts.feePayer, requestedAccounts.base, requestedAccounts.quote]),
      }), signal);
      const rawSimulation = record(simulation, RESULT_KEYS);
      validateSimulationEnvelope(
        rawSimulation, requestedAccounts,
        new Set(message.staticAccountKeys.map((key) => key.toBase58())),
        inspected.instructions.length,
        snapshot.providerId, blockhash.contextSlot,
      );
      if (rawSimulation.failureKind === 'PROGRAM_ERROR') {
        throw failure('SIMULATION', 'SIMULATION_PROGRAM_ERROR', partial);
      }
      if (rawSimulation.failureKind !== null) throw failure('SIMULATION', 'RPC_RESPONSE_INVALID', partial);
      const result = simulationEvidence(
        simulation, snapshot, requestedAccounts, inspected, blockhash.contextSlot,
        fee.feeLamports, this.limits,
      );
      return Object.freeze({
        outcome: 'SUCCESS', snapshotFingerprint: required(partial.snapshotFingerprint),
        buildFingerprint: required(partial.buildFingerprint),
        messageHash: required(partial.messageHash), blockhash: required(partial.blockhash),
        lastValidBlockHeight: required(partial.lastValidBlockHeight),
        blockhashContextSlot: required(partial.blockhashContextSlot),
        feeContextSlot: fee.contextSlot, estimatedFeeLamports: fee.feeLamports,
        simulationSlot: result.simulationSlot, simulatedFeePayerLamportDebit: result.feePayerDebit,
        unitsConsumed: result.unitsConsumed, simulatedBaseDeltaRaw: result.baseDelta,
        simulatedQuoteDeltaRaw: result.quoteDelta, logsFingerprint: result.logsFingerprint,
        logsLineCount: result.logsLineCount,
      });
    } catch (error) {
      if (error instanceof ExecutionSimulationGatewayError && INTERNAL_GATEWAY_ERRORS.has(error)) throw error;
      if (error instanceof InstructionInspectionError) {
        throw failure('BUILD', 'BUILD_POLICY_REJECTED', partial);
      }
      if (error instanceof SimulationOperationAbortedError) {
        throw failure(stage, 'OPERATION_ABORTED', partial);
      }
      if (isExecutionProviderSessionError(error)) {
        throw failure(stage, providerErrorCode(error.code), partial);
      }
      throw failure(stage, 'RPC_RESPONSE_INVALID', partial);
    }
  }
}

function simulationEvidence(
  value: ExecutionUnsignedSimulationResult,
  snapshot: ValidatedSnapshot,
  requested: RequiredSimulationAccounts,
  inspected: Readonly<{
    readonly side: 'BUY' | 'SELL';
    readonly allowsMissingUserBaseAta: boolean;
    readonly identity: UnsignedBuildIdentityV1;
    readonly amounts: Readonly<{ readonly amountInRaw: bigint; readonly protectedAmountOutRaw: bigint }>;
  }>,
  blockhashSlot: bigint,
  estimatedFee: bigint,
  limits: ValidatedLimits,
): Readonly<{
  readonly simulationSlot: bigint;
  readonly feePayerDebit: bigint;
  readonly unitsConsumed: bigint;
  readonly baseDelta: bigint;
  readonly quoteDelta: bigint;
  readonly logsFingerprint: string;
  readonly logsLineCount: number;
}> {
  const result = record(value, RESULT_KEYS);
  if (result.providerId !== snapshot.providerId || !u64(result.contextSlot)
    || result.contextSlot < blockhashSlot || result.failureKind !== null
    || !u64(result.unitsConsumed) || result.unitsConsumed > limits.maxComputeUnits) rejectEvidence();
  const logs = logsFrom(result.logs);
  const accounts = accountResultFrom(result.accounts, requested);
  // The provider snapshot is the only causal pre-state. The returned order is
  // fixed by the request and deliberately not inferred from provider data.
  const prePayer = lookupAccount(snapshot, requested.feePayer);
  const preBase = lookupAccount(snapshot, requested.base);
  const preQuote = lookupAccount(snapshot, requested.quote);
  const postPayer = requiredAccount(accounts, 0);
  const postBase = requiredAccount(accounts, 1);
  const postQuote = requiredAccount(accounts, 2);
  if (prePayer === null || postPayer === null || postBase === null
    || (preBase === null && !inspected.allowsMissingUserBaseAta)) rejectEvidence();
  validateSystemPayer(prePayer, requested.feePayer);
  validateSystemPayer(postPayer, requested.feePayer);
  const payerDebit = prePayer.lamports > postPayer.lamports ? prePayer.lamports - postPayer.lamports : 0n;
  if (payerDebit > limits.maxFeePayerLamportDebit) rejectEvidence();
  const baseProgram = inspected.identity.baseTokenProgram === 'SPL_TOKEN'
    ? TOKEN_PROGRAM_ID.toBase58() : TOKEN_2022_PROGRAM_ID.toBase58();
  const baseDelta = tokenAmount(postBase, requested.base, inspected.identity.mint, requested.feePayer, baseProgram, false)
    - tokenAmount(preBase, requested.base, inspected.identity.mint, requested.feePayer, baseProgram, false);
  // SOL wealth includes the payer and every user-owned account which can be
  // closed by the allowed plan. This cancels ATA rent on a BUY creation and a
  // terminal WSOL close, rather than misclassifying recoverable rent as flow.
  void tokenAmount(preQuote, requested.quote, NATIVE_MINT.toBase58(), requested.feePayer, TOKEN_PROGRAM_ID.toBase58(), true);
  void tokenAmount(postQuote, requested.quote, NATIVE_MINT.toBase58(), requested.feePayer, TOKEN_PROGRAM_ID.toBase58(), true);
  const quoteDelta = liquidLamports(postPayer, postBase, postQuote)
    - liquidLamports(prePayer, preBase, preQuote) + estimatedFee;
  if ((inspected.side === 'SELL' && (baseDelta !== -inspected.amounts.amountInRaw
    || quoteDelta < inspected.amounts.protectedAmountOutRaw))
    || (inspected.side === 'BUY' && (quoteDelta >= 0n
      || baseDelta < inspected.amounts.protectedAmountOutRaw
      || -quoteDelta > inspected.amounts.amountInRaw))) {
    rejectEvidence();
  }
  return Object.freeze({
    simulationSlot: result.contextSlot, feePayerDebit: payerDebit,
    unitsConsumed: result.unitsConsumed, baseDelta, quoteDelta,
    logsFingerprint: sha256(lengthPrefixedUtf8(['execution-simulation-logs-v1', ...logs])),
    logsLineCount: logs.length,
  });
}

function simulationAccounts(planValue: unknown, feePayer: string): RequiredSimulationAccounts {
  const plan = record(planValue, ['payloadVersion', 'venue', 'side', 'feePayer', 'identity', 'amounts', 'expectedAccounts', 'policyEvidence', 'instructions']);
  const accounts = frozenArray(plan.expectedAccounts, 2, 9);
  const byRole = new Map<string, string>();
  for (const value of accounts) {
    const item = record(value, ['role', 'address']);
    if (typeof item.role !== 'string' || typeof item.address !== 'string' || byRole.has(item.role)) rejectEvidence();
    byRole.set(item.role, publicKey(item.address));
  }
  const base = byRole.get('USER_BASE_ATA');
  const quote = byRole.get('USER_QUOTE_ATA');
  if (base === undefined || quote === undefined) rejectEvidence();
  return Object.freeze({ feePayer, base, quote });
}

function snapshotFrom(
  value: unknown,
  inspected: Readonly<{ readonly venue: 'PUMP_FUN' | 'PUMP_SWAP'; readonly side: 'BUY' | 'SELL'; readonly feePayer: string; readonly identity: UnsignedBuildIdentityV1; readonly expectedAccounts: readonly ExpectedBuildAccountV1[]; readonly allowsMissingUserBaseAta: boolean; readonly allowsMissingUserQuoteAta: boolean; readonly requiresPumpSwapCashback: boolean; readonly requiresPumpSwapPoolV2: boolean }> ,
): ValidatedSnapshot {
  const input = record(value, SNAPSHOT_KEYS);
  if (typeof input.providerId !== 'string' || input.providerId.length < 1 || input.providerId.length > 128
    || !u64(input.slot)) rejectEvidence();
  const addresses = frozenArray(input.addresses, 1, 100).map((address) => publicKey(address));
  if (new Set(addresses).size !== addresses.length) rejectEvidence();
  const values = frozenArray(input.accounts, addresses.length, addresses.length);
  let aggregateDataBytes = 0;
  const accounts = values.map((candidate, index): ExecutionRpcAccount | null => {
    if (candidate === null) return null;
    const account = record(candidate, ACCOUNT_KEYS);
    const address = addresses[index];
    if (address === undefined || account.address !== address || !u64(account.lamports)
      || typeof account.owner !== 'string' || !publicKey(account.owner) || typeof account.executable !== 'boolean'
      || (account.rentEpoch !== null && !u64(account.rentEpoch))
      || (account.space !== null && !u64(account.space)) || typeof account.dataBase64 !== 'string') rejectEvidence();
    const data = canonicalBase64(account.dataBase64);
    aggregateDataBytes += Buffer.from(data, 'base64').length;
    if (aggregateDataBytes > MAX_SNAPSHOT_DATA_BYTES) rejectEvidence();
    return Object.freeze({
      address, lamports: account.lamports, owner: publicKey(account.owner), executable: account.executable,
      rentEpoch: account.rentEpoch, space: account.space, dataBase64: data,
    });
  });
  const snapshot = Object.freeze({ providerId: input.providerId, slot: input.slot, addresses: Object.freeze(addresses), accounts: Object.freeze(accounts) });
  validateCanonicalSnapshot(snapshot, inspected);
  return Object.freeze({ ...snapshot, fingerprint: snapshotFingerprint(snapshot) });
}

function validateCanonicalSnapshot(
  snapshot: Readonly<{ readonly addresses: readonly string[]; readonly accounts: readonly (ExecutionRpcAccount | null)[] }> ,
  inspected: Readonly<{ readonly venue: 'PUMP_FUN' | 'PUMP_SWAP'; readonly side: 'BUY' | 'SELL'; readonly feePayer: string; readonly identity: UnsignedBuildIdentityV1; readonly expectedAccounts: readonly ExpectedBuildAccountV1[]; readonly allowsMissingUserBaseAta: boolean; readonly allowsMissingUserQuoteAta: boolean; readonly requiresPumpSwapCashback: boolean; readonly requiresPumpSwapPoolV2: boolean }>,
): void {
  if (inspected.venue === 'PUMP_SWAP') {
    validatePumpSwapSnapshot(snapshot, inspected);
    return;
  }
  const mint = new PublicKey(inspected.identity.mint);
  const curve = bondingCurvePda(mint).toBase58();
  const base = getAssociatedTokenAddressSync(
    new PublicKey(inspected.identity.mint), new PublicKey(inspected.feePayer), true,
    inspected.identity.baseTokenProgram === 'SPL_TOKEN' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
  ).toBase58();
  const quote = getAssociatedTokenAddressSync(
    NATIVE_MINT, new PublicKey(inspected.feePayer), true, TOKEN_PROGRAM_ID,
  ).toBase58();
  const expected = [
    GLOBAL_PDA.toBase58(), PUMP_FEE_CONFIG_PDA.toBase58(), inspected.identity.mint, curve,
    inspected.feePayer, base, quote,
  ];
  if (snapshot.addresses.length !== expected.length
    || expected.some((address, index) => snapshot.addresses[index] !== address)) rejectEvidence();
  // A Pump.fun SELL requires both ATA accounts. BUY may intentionally create
  // the base ATA, but all program/mint/curve/payer evidence is mandatory.
  if (snapshot.accounts.slice(0, 5).some((account) => account === null)) rejectEvidence();
  if ((snapshot.accounts[5] === null && !inspected.allowsMissingUserBaseAta)
    || (inspected.side === 'SELL' && snapshot.accounts[5] === null)) {
    rejectEvidence();
  }
}

function validatePumpSwapSnapshot(
  snapshot: Readonly<{ readonly addresses: readonly string[]; readonly accounts: readonly (ExecutionRpcAccount | null)[] }>,
  inspected: Readonly<{ readonly feePayer: string; readonly identity: UnsignedBuildIdentityV1; readonly expectedAccounts: readonly ExpectedBuildAccountV1[]; readonly allowsMissingUserQuoteAta: boolean; readonly requiresPumpSwapCashback: boolean; readonly requiresPumpSwapPoolV2: boolean }>,
): void {
  const roles = new Map(inspected.expectedAccounts.map((item) => [item.role, item.address]));
  const required = (role: string): string => {
    const value = roles.get(role);
    if (value === undefined) rejectEvidence();
    return value;
  };
  const expected = [
    GLOBAL_CONFIG_PDA.toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(),
    required('POOL'), inspected.identity.mint, NATIVE_MINT.toBase58(),
    required('POOL_BASE_VAULT'), required('POOL_QUOTE_VAULT'), inspected.feePayer,
    required('USER_BASE_ATA'), required('USER_QUOTE_ATA'),
    userVolumeAccumulatorPda(new PublicKey(inspected.feePayer)).toBase58(),
    getAssociatedTokenAddressSync(
      NATIVE_MINT, userVolumeAccumulatorPda(new PublicKey(inspected.feePayer)), true, TOKEN_PROGRAM_ID,
    ).toBase58(),
    poolV2Pda(new PublicKey(inspected.identity.mint)).toBase58(),
  ];
  if (snapshot.addresses.length !== expected.length
    || expected.some((address, index) => snapshot.addresses[index] !== address)
    || snapshot.accounts.slice(0, 9).some((account) => account === null)) rejectEvidence();
  // The plan can explicitly announce the sole optional WSOL ATA. All other
  // PumpSwap policy accounts are mandatory at the causal slot.
  const quoteAccount = snapshot.accounts[9];
  if (quoteAccount === null && !inspected.allowsMissingUserQuoteAta) {
    rejectEvidence();
  }
  if ((inspected.requiresPumpSwapCashback
      && (snapshot.accounts[10] === null || snapshot.accounts[11] === null))
    || (inspected.requiresPumpSwapPoolV2 && snapshot.accounts[12] === null)) rejectEvidence();
}

function accountResultFrom(value: unknown, requested: RequiredSimulationAccounts): readonly (ExecutionRpcAccount | null)[] {
  const values = frozenArray(value, 3, 3);
  const addresses = [requested.feePayer, requested.base, requested.quote];
  return Object.freeze(values.map((candidate, index): ExecutionRpcAccount | null => {
    if (candidate === null) return null;
    const account = record(candidate, ACCOUNT_KEYS);
    const address = addresses[index];
    if (address === undefined || account.address !== address || !u64(account.lamports)
      || typeof account.owner !== 'string' || !publicKey(account.owner)
      || typeof account.executable !== 'boolean' || (account.rentEpoch !== null && !u64(account.rentEpoch))
      || (account.space !== null && !u64(account.space)) || typeof account.dataBase64 !== 'string') rejectEvidence();
    return Object.freeze({
      address, lamports: account.lamports, owner: publicKey(account.owner), executable: account.executable,
      rentEpoch: account.rentEpoch, space: account.space, dataBase64: canonicalBase64(account.dataBase64),
    });
  }));
}

function tokenAmount(
  account: ExecutionRpcAccount | null,
  expectedAddress: string,
  expectedMint: string,
  expectedHolder: string,
  expectedProgram: string,
  expectedNative: boolean,
): bigint {
  if (account === null) return 0n;
  if (account.address !== expectedAddress || account.owner !== expectedProgram
    || account.executable || account.space === null || account.space < BigInt(AccountLayout.span)) rejectEvidence();
  const data = Buffer.from(account.dataBase64, 'base64');
  if (data.length < AccountLayout.span || account.space !== BigInt(data.length)) rejectEvidence();
  try {
    const decoded = AccountLayout.decode(data.subarray(0, AccountLayout.span));
    if (!decoded.mint.equals(new PublicKey(expectedMint)) || !decoded.owner.equals(new PublicKey(expectedHolder))
      || decoded.state !== AccountState.Initialized
      || decoded.isNativeOption !== (expectedNative ? 1 : 0)
      || (expectedNative && decoded.isNative === 0n)) {
      rejectEvidence();
    }
    return decoded.amount;
  } catch { rejectEvidence(); }
}

function validateSystemPayer(account: ExecutionRpcAccount, address: string): void {
  if (account.address !== address || account.owner !== PublicKey.default.toBase58()
    || account.executable || account.space !== 0n || account.dataBase64 !== '') rejectEvidence();
}
function liquidLamports(
  payer: ExecutionRpcAccount,
  base: ExecutionRpcAccount | null,
  quote: ExecutionRpcAccount | null,
): bigint { return payer.lamports + (base?.lamports ?? 0n) + (quote?.lamports ?? 0n); }

function lookupAccount(snapshot: ValidatedSnapshot, address: string): ExecutionRpcAccount | null {
  const index = snapshot.addresses.indexOf(address);
  if (index < 0) rejectEvidence();
  const account = snapshot.accounts[index];
  if (account === undefined) rejectEvidence();
  return account;
}
function requiredAccount(
  accounts: readonly (ExecutionRpcAccount | null)[],
  index: number,
): ExecutionRpcAccount | null {
  const account = accounts[index];
  if (account === undefined) rejectEvidence();
  return account;
}

function toInstruction(instruction: NormalizedInstructionV1): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.address), isSigner: account.isSigner, isWritable: account.isWritable,
    })),
    data: Buffer.from(instruction.dataBase64, 'base64'),
  });
}

function assertCompiledMessage(
  message: MessageV0,
  feePayer: string,
  instructions: readonly NormalizedInstructionV1[],
  blockhash: string,
): void {
  if (message.recentBlockhash !== blockhash || message.addressTableLookups.length !== 0
    || message.header.numRequiredSignatures !== 1
    || !message.staticAccountKeys[0]?.equals(new PublicKey(feePayer))
    || message.compiledInstructions.length !== instructions.length) rejectEvidence();
  const expectedKeys = new Map<string, { signer: boolean; writable: boolean }>([
    [feePayer, { signer: true, writable: true }],
  ]);
  for (const instruction of instructions) {
    expectedKeys.set(instruction.programId, expectedKeys.get(instruction.programId) ?? { signer: false, writable: false });
    for (const account of instruction.accounts) {
      const current = expectedKeys.get(account.address) ?? { signer: false, writable: false };
      expectedKeys.set(account.address, {
        signer: current.signer || account.isSigner,
        writable: current.writable || account.isWritable,
      });
    }
  }
  if (message.staticAccountKeys.length !== expectedKeys.size
    || message.staticAccountKeys.some((key, index) => {
      const signer = index < message.header.numRequiredSignatures;
      const writable = signer ? index < message.header.numRequiredSignatures - message.header.numReadonlySignedAccounts
        : index < message.staticAccountKeys.length - message.header.numReadonlyUnsignedAccounts;
      const expected = expectedKeys.get(key.toBase58()) ?? { signer: !signer, writable: !writable };
      return expected.signer !== signer || expected.writable !== writable;
    })) rejectEvidence();
  for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex += 1) {
    const expected = instructions[instructionIndex];
    const actual = message.compiledInstructions[instructionIndex];
    if (expected === undefined || actual === undefined || actual.programIdIndex >= message.staticAccountKeys.length
      || message.staticAccountKeys[actual.programIdIndex]?.toBase58() !== expected.programId
      || !Buffer.from(actual.data).equals(Buffer.from(expected.dataBase64, 'base64'))
      || actual.accountKeyIndexes.length !== expected.accounts.length) rejectEvidence();
    for (let accountIndex = 0; accountIndex < expected.accounts.length; accountIndex += 1) {
      const expectedAccount = expected.accounts[accountIndex];
      const keyIndex = actual.accountKeyIndexes[accountIndex];
      if (expectedAccount === undefined || keyIndex === undefined || keyIndex >= message.staticAccountKeys.length
        || message.staticAccountKeys[keyIndex]?.toBase58() !== expectedAccount.address
      ) rejectEvidence();
    }
  }
}

function buildFingerprint(feePayer: string, instructions: readonly NormalizedInstructionV1[]): string {
  const segments = ['execution-build-v1', feePayer];
  for (const instruction of instructions) {
    segments.push(instruction.programId);
    for (const account of instruction.accounts) {
      segments.push(account.address, account.isSigner ? 'SIGNER' : 'NOT_SIGNER', account.isWritable ? 'WRITABLE' : 'READONLY');
    }
    segments.push(sha256(Buffer.from(instruction.dataBase64, 'base64')));
  }
  return sha256(lengthPrefixedUtf8(segments));
}

function snapshotFingerprint(snapshot: Readonly<{
  readonly slot: bigint;
  readonly addresses: readonly string[];
  readonly accounts: readonly (ExecutionRpcAccount | null)[];
}>): string {
  const segments = ['execution-snapshot-v1', snapshot.slot.toString(10)];
  for (let index = 0; index < snapshot.addresses.length; index += 1) {
    const address = snapshot.addresses[index];
    const account = snapshot.accounts[index];
    if (address === undefined || account === undefined) rejectEvidence();
    if (account === null) segments.push(address, 'ABSENT');
    else segments.push(address, 'PRESENT', account.owner, account.lamports.toString(10), sha256(Buffer.from(account.dataBase64, 'base64')));
  }
  return sha256(lengthPrefixedUtf8(segments));
}

function logsFrom(value: unknown): readonly string[] {
  const logs = frozenArray(value, 0, MAX_LOG_LINES).map((line) => {
    if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_LOG_BYTES) rejectEvidence();
    return line;
  });
  return Object.freeze(logs);
}

function validateSimulationEnvelope(
  result: Readonly<Record<string, unknown>>,
  requested: RequiredSimulationAccounts,
  staticAccounts: ReadonlySet<string>,
  instructionCount: number,
  expectedProviderId: string,
  minimumContextSlot: bigint,
): void {
  if (result.providerId !== expectedProviderId || !u64(result.contextSlot) || result.contextSlot < minimumContextSlot
    || (result.failureKind !== null && result.failureKind !== 'PROGRAM_ERROR'
      && result.failureKind !== 'BLOCKHASH_NOT_FOUND')) rejectEvidence();
  if (result.logs !== null) logsFrom(result.logs);
  if (result.accounts !== null) accountResultFrom(result.accounts, requested);
  innerInstructionsFrom(result.innerInstructions, staticAccounts, instructionCount);
  if (result.unitsConsumed !== null && !u64(result.unitsConsumed)) rejectEvidence();
}

function innerInstructionsFrom(
  value: unknown,
  staticAccounts: ReadonlySet<string> = new Set(),
  instructionCount = 4,
): void {
  if (value === null) return;
  const groups = frozenArray(value, 0, 64);
  let total = 0;
  const groupIndexes = new Set<number>();
  for (const candidate of groups) {
    const group = record(candidate, ['index', 'instructions']);
    if (typeof group.index !== 'number' || !Number.isSafeInteger(group.index) || group.index < 0
      || group.index >= instructionCount || groupIndexes.has(group.index)) {
      rejectEvidence();
    }
    groupIndexes.add(group.index);
    const instructions = frozenArray(group.instructions, 0, 256);
    total += instructions.length;
    if (total > 256) rejectEvidence();
    for (const item of instructions) {
      const instruction = record(item, ['kind', 'programId', 'accounts', 'data', 'stackHeight']);
      const stackHeight = instruction.stackHeight;
      const programId = typeof instruction.programId === 'string' ? publicKey(instruction.programId) : null;
      if (instruction.kind !== 'PARTIALLY_DECODED'
        || programId === null || !ALLOWED_INNER_PROGRAMS.has(programId) || !staticAccounts.has(programId)
        || instruction.accounts === null || !canonicalBase58(instruction.data)
        || (stackHeight !== null && (typeof stackHeight !== 'number' || !Number.isSafeInteger(stackHeight)
          || stackHeight < 0 || stackHeight > 16))) rejectEvidence();
      const addresses = frozenArray(instruction.accounts, 0, 64);
      for (const address of addresses) {
        const account = publicKey(address);
        if (!staticAccounts.has(account)) rejectEvidence();
      }
    }
  }
}

function canonicalBase58(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048
    || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(value)) return false;
  try { return bs58.encode(bs58.decode(value)) === value; } catch { return false; }
}

function limitsFrom(value: ExecutionSimulationGatewayLimitsV1): ValidatedLimits {
  const input = record(value, LIMIT_KEYS);
  if (typeof input.maxTransactionBytes !== 'number' || !Number.isSafeInteger(input.maxTransactionBytes)
    || input.maxTransactionBytes < 1 || input.maxTransactionBytes > 1_232
    || !positiveU64(input.maxComputeUnits) || !u64(input.maxFeeLamports)
    || !u64(input.maxFeePayerLamportDebit)) throw new TypeError('Invalid simulation limits.');
  return Object.freeze({
    maxTransactionBytes: input.maxTransactionBytes, maxComputeUnits: input.maxComputeUnits,
    maxFeeLamports: input.maxFeeLamports, maxFeePayerLamportDebit: input.maxFeePayerLamportDebit,
  });
}

function emptyEvidence(): ExecutionSimulationPartialEvidenceV1 {
  return Object.freeze({
    snapshotFingerprint: null, buildFingerprint: null, messageHash: null, blockhash: null, lastValidBlockHeight: null,
    blockhashContextSlot: null, feeContextSlot: null, estimatedFeeLamports: null,
    simulationSlot: null, simulatedFeePayerLamportDebit: null, unitsConsumed: null,
    simulatedBaseDeltaRaw: null, simulatedQuoteDeltaRaw: null, logsFingerprint: null,
    logsLineCount: null,
  });
}

function failure(
  stage: ExecutionSimulationGatewayStage,
  code: ExecutionSimulationGatewayErrorCode,
  evidence: ExecutionSimulationPartialEvidenceV1,
): ExecutionSimulationGatewayError {
  const safe = { ...evidence } as ExecutionSimulationPartialEvidenceV1 & { toJSON?: () => unknown };
  Object.defineProperty(safe, 'toJSON', {
    enumerable: false,
    value: () => Object.fromEntries(Object.entries(evidence).map(([key, value]) => [
      key, typeof value === 'bigint' ? value.toString(10) : value,
    ])),
  });
  const error = new ExecutionSimulationGatewayError(stage, code, Object.freeze(safe));
  INTERNAL_GATEWAY_ERRORS.add(error);
  return error;
}
function rejectEvidence(): never { throw new Error('Invalid simulation evidence.'); }
function required<T>(value: T | null): T { if (value === null) rejectEvidence(); return value; }
function u64(value: unknown): value is bigint { return typeof value === 'bigint' && value >= 0n && value <= U64_MAX; }
function positiveU64(value: unknown): value is bigint { return u64(value) && value > 0n; }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function lengthPrefixedUtf8(values: readonly string[]): Buffer { return Buffer.concat(values.flatMap((value) => { const bytes = Buffer.from(value, 'utf8'); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return [length, bytes]; })); }
function validateSignal(value: unknown): asserts value is AbortSignal {
  if (!(value instanceof AbortSignal)) rejectEvidence();
  if (value.aborted) throw new SimulationOperationAbortedError();
}

function record(value: unknown, expected: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)
    || !Object.isFrozen(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) rejectEvidence();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== expected.length
    || [...keys as string[]].sort().some((key, index) => key !== [...expected].sort()[index])) rejectEvidence();
  const output: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) rejectEvidence();
    output[key] = descriptor.value;
  }
  return output;
}

function frozenArray(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || isProxy(value) || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) rejectEvidence();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key === 'symbol')) rejectEvidence();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) rejectEvidence();
    result.push(descriptor.value);
  }
  return result;
}

function publicKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44
    || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(value)) rejectEvidence();
  const key = new PublicKey(value);
  if (key.toBase58() !== value) rejectEvidence();
  return value;
}

function canonicalBase64(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1_398_104
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) rejectEvidence();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) rejectEvidence();
  return value;
}
function toBase64(value: Uint8Array): string { return Buffer.from(value).toString('base64'); }
function providerErrorCode(value: ExecutionProviderSessionErrorCode): ExecutionSimulationGatewayErrorCode {
  switch (value) {
    case 'RPC_RATE_LIMITED': return 'RPC_RATE_LIMITED';
    case 'RPC_TIMEOUT': return 'RPC_TIMEOUT';
    case 'RPC_UNAVAILABLE': return 'RPC_UNAVAILABLE';
    case 'RPC_RESPONSE_INVALID': return 'RPC_RESPONSE_INVALID';
    case 'OPERATION_ABORTED': return 'OPERATION_ABORTED';
    case 'INVALID_INPUT':
    case 'GENESIS_MISMATCH': return 'SIMULATION_EVIDENCE_INVALID';
  }
}
