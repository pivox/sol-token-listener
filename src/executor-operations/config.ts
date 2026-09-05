import { isAbsolute, normalize } from 'node:path';
import { isProxy } from 'node:util/types';
import { PublicKey } from '@solana/web3.js';
import type { ExecutionLivePhase } from '../domain/execution-safety-qualification.js';

const SECRET_KEYS = Object.freeze([
  'EXECUTOR_PRIVATE_KEY', 'EXECUTOR_SECRET_KEY', 'EXECUTOR_KEYPAIR',
  'EXECUTOR_KEYPAIR_PATH', 'SOLANA_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY_BASE58',
  'EXECUTOR_EVIDENCE_PRIVATE_KEY', 'EXECUTOR_EVIDENCE_PRIVATE_KEY_BASE64',
  'EXECUTOR_EVIDENCE_SIGNING_KEY',
  'SOLANA_SECRET_KEY', 'SOLANA_KEYPAIR', 'SOLANA_KEYPAIR_PATH',
  'WALLET_PRIVATE_KEY', 'WALLET_KEYPAIR', 'WALLET_KEYPAIR_PATH', 'ANCHOR_WALLET',
] as const);

export interface ExecutionOperationsConfig {
  readonly databaseUrl: string;
  readonly generationId: string;
  readonly walletPublicKey: string;
  readonly genesisHash: string;
  readonly providerId: string;
  readonly buildHash: string;
  readonly configurationFingerprint: string;
  readonly strategyFingerprint: string;
  readonly phase: ExecutionLivePhase;
  readonly operatorId: string;
  readonly evidencePath: string;
  readonly evidencePublicKeyBase64: string;
}

export interface ExecutionCanaryArmConfig extends ExecutionOperationsConfig {
  readonly canaryEvidencePath: string;
  readonly runtimeQuoteMaxAgeMs: number;
  readonly runtimeSlippageBps: bigint;
  readonly runtimeSnapshotMaxSlotLag: number;
  readonly runtimeMaxComputeUnits: bigint;
  readonly runtimeMaxFeeLamports: bigint;
  readonly runtimeMaxFeePayerLamportDebit: bigint;
  readonly runtimeMaxRpcCallsPerAttempt: number;
  readonly runtimeLeaseMs: number;
}

export class ExecutionOperationsConfigError extends Error {
  public readonly code = 'INVALID_EXECUTION_OPERATIONS_CONFIG' as const;

  public constructor() {
    super('Invalid execution operations configuration.');
    this.name = 'ExecutionOperationsConfigError';
  }
}

export function parseExecutionOperationsConfig(
  input: unknown,
): ExecutionOperationsConfig {
  try {
    if (!isEnvironment(input)) throw invalid();
    const environment = input;
    for (const key of SECRET_KEYS) {
      if (Object.getOwnPropertyDescriptor(environment, key) !== undefined) throw invalid();
    }
    const liveEnabled = environmentValue(environment, 'LIVE_TRADING_ENABLED');
    if (liveEnabled !== undefined && liveEnabled !== 'false') throw invalid();
    const mode = environmentValue(environment, 'EXECUTOR_MODE');
    if (mode !== undefined && mode !== 'dry-run' && mode !== 'simulation-only') throw invalid();
    const databaseUrl = boundedText(environmentValue(environment, 'DATABASE_URL'), 4_096);
    const generationId = patterned(
      environmentValue(environment, 'EXECUTOR_WALLET_GENERATION_ID'),
      /^execution_wallet_generation_[0-9a-f]{64}$/u,
      96,
    );
    const walletPublicKey = publicKey(environmentValue(environment, 'EXECUTOR_PUBLIC_KEY'));
    const genesisHash = publicKey(environmentValue(environment, 'SOLANA_EXPECTED_GENESIS_HASH'));
    const providerId = patterned(
      environmentValue(environment, 'EXECUTOR_RPC_PROVIDER_ID'),
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
      64,
    );
    const buildHash = fingerprint(environmentValue(environment, 'EXECUTOR_BUILD_HASH'));
    const configurationFingerprint = fingerprint(
      environmentValue(environment, 'EXECUTOR_CONFIGURATION_FINGERPRINT'),
    );
    const strategyFingerprint = fingerprint(
      environmentValue(environment, 'EXECUTOR_STRATEGY_FINGERPRINT'),
    );
    const phase = phaseFrom(environmentValue(environment, 'EXECUTOR_ACTIVATION_PHASE'));
    const operatorId = patterned(
      environmentValue(environment, 'EXECUTOR_OPERATOR_ID'),
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
      64,
    );
    const evidencePath = absolutePath(
      environmentValue(environment, 'EXECUTOR_PREFLIGHT_EVIDENCE_PATH'),
    );
    const evidencePublicKeyBase64 = canonicalBase64(
      environmentValue(environment, 'EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64'),
      256,
    );
    return Object.freeze({
      databaseUrl, generationId, walletPublicKey, genesisHash, providerId,
      buildHash, configurationFingerprint, strategyFingerprint, phase, operatorId,
      evidencePath, evidencePublicKeyBase64,
    });
  } catch {
    throw invalid();
  }
}

export function parseExecutionCanaryArmConfig(input: unknown): ExecutionCanaryArmConfig {
  try {
    const base = parseExecutionOperationsConfig(input);
    if (base.phase !== 'CANARY' || !isEnvironment(input)) throw invalid();
    const canaryEvidencePath = absolutePath(
      environmentValue(input, 'EXECUTOR_CANARY_EVIDENCE_PATH'),
    );
    const runtimeQuoteMaxAgeMs = decimalInteger(
      environmentValue(input, 'EXECUTOR_QUOTE_MAX_AGE_MS'), 1, 60_000,
    );
    const runtimeSlippageBps = decimalBigint(
      environmentValue(input, 'EXECUTOR_SLIPPAGE_BPS'), 0n, 10_000n,
    );
    const runtimeSnapshotMaxSlotLag = decimalInteger(
      environmentValue(input, 'EXECUTOR_SNAPSHOT_MAX_SLOT_LAG'), 0, 128,
    );
    const runtimeMaxComputeUnits = decimalBigint(
      environmentValue(input, 'EXECUTOR_MAX_COMPUTE_UNITS'), 1n, 1_400_000n,
    );
    const runtimeMaxFeeLamports = decimalBigint(
      environmentValue(input, 'EXECUTOR_MAX_FEE_LAMPORTS'), 0n, 10_000_000n,
    );
    const runtimeMaxFeePayerLamportDebit = decimalBigint(
      environmentValue(input, 'EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT'), 0n, 10_000_000_000n,
    );
    const runtimeMaxRpcCallsPerAttempt = decimalInteger(
      environmentValue(input, 'EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT'), 12, 16,
    );
    const runtimeLeaseMs = decimalInteger(
      environmentValue(input, 'EXECUTOR_LEASE_MS'), 3_000, 120_000,
    );
    return Object.freeze({ ...base, canaryEvidencePath, runtimeQuoteMaxAgeMs,
      runtimeSlippageBps, runtimeSnapshotMaxSlotLag, runtimeMaxComputeUnits,
      runtimeMaxFeeLamports, runtimeMaxFeePayerLamportDebit,
      runtimeMaxRpcCallsPerAttempt, runtimeLeaseMs });
  } catch {
    throw invalid();
  }
}

function environmentValue(
  environment: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)
    || (descriptor.value !== undefined && typeof descriptor.value !== 'string')) throw invalid();
  return descriptor.value as string | undefined;
}

function boundedText(value: string | undefined, maximumBytes: number): string {
  if (value === undefined) throw invalid();
  if (value.trim() !== value || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes) throw invalid();
  return value;
}

function isEnvironment(value: unknown): value is Record<string, string | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isProxy(value);
}

function patterned(
  value: string | undefined,
  pattern: RegExp,
  maximumBytes: number,
): string {
  const parsed = boundedText(value, maximumBytes);
  if (!pattern.test(parsed)) throw invalid();
  return parsed;
}

function fingerprint(value: string | undefined): string {
  return patterned(value, /^[0-9a-f]{64}$/u, 64);
}

function publicKey(value: string | undefined): string {
  const parsed = boundedText(value, 64);
  if (new PublicKey(parsed).toBase58() !== parsed) throw invalid();
  return parsed;
}

function phaseFrom(value: string | undefined): ExecutionLivePhase {
  if (value !== 'CANARY' && value !== 'MICRO_LIVE' && value !== 'PILOT') throw invalid();
  return value;
}

function absolutePath(value: string | undefined): string {
  const parsed = boundedText(value, 4_096);
  if (!isAbsolute(parsed) || normalize(parsed) !== parsed || parsed.includes('\0')) throw invalid();
  return parsed;
}

function canonicalBase64(value: string | undefined, maximumBytes: number): string {
  const parsed = boundedText(value, Math.ceil(maximumBytes / 3) * 4 + 4);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(parsed)) throw invalid();
  const decoded = Buffer.from(parsed, 'base64');
  if (decoded.length === 0 || decoded.length > maximumBytes
    || decoded.toString('base64') !== parsed) throw invalid();
  return parsed;
}

function decimalInteger(value: string | undefined, minimum: number, maximum: number): number {
  const parsed = boundedText(value, 32);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(parsed)) throw invalid();
  const number = Number(parsed);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw invalid();
  return number;
}

function decimalBigint(value: string | undefined, minimum: bigint, maximum: bigint): bigint {
  const parsed = boundedText(value, 32);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(parsed)) throw invalid();
  const number = BigInt(parsed);
  if (number < minimum || number > maximum) throw invalid();
  return number;
}

function invalid(): ExecutionOperationsConfigError {
  return new ExecutionOperationsConfigError();
}
