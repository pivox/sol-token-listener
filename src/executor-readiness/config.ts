import { isAbsolute, normalize } from 'node:path';
import { isProxy } from 'node:util/types';
import { PublicKey } from '@solana/web3.js';

export interface ExecutionReadinessConfig {
  readonly databaseUrl: string;
  readonly cluster: 'mainnet-beta';
  readonly httpRpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly providerId: string;
  readonly walletPublicKey: string;
  readonly generationNumber: number;
  readonly evidencePublicKeyBase64: string;
  readonly providerEvidencePath: string;
  readonly maximumSlotLag: number;
  readonly rpcTimeoutMs: number;
}

const FORBIDDEN_ENVIRONMENT_KEY = /(?:PRIVATE_KEY|KEYPAIR|MNEMONIC|RECOVERY_PHRASE|LIVE_TRADING_ENABLED|EXECUTOR_MODE)/u;

export class ExecutionReadinessConfigError extends TypeError {
  public readonly code = 'INVALID_EXECUTION_READINESS_CONFIG' as const;
  public constructor() {
    super('Invalid execution readiness configuration.');
    this.name = 'ExecutionReadinessConfigError';
  }
}

export function parseExecutionReadinessConfig(input: unknown): ExecutionReadinessConfig {
  try {
    if (!isEnvironment(input)) throw invalid();
    for (const key of Object.keys(input)) {
      if (FORBIDDEN_ENVIRONMENT_KEY.test(key)) throw invalid();
    }
    const databaseUrl = postgresUrl(value(input, 'DATABASE_URL'));
    const cluster = exactMainnet(value(input, 'SOLANA_CLUSTER'));
    const httpRpcUrl = httpsUrl(value(input, 'SOLANA_HTTP_RPC_URL'));
    const expectedGenesisHash = publicKey(value(input, 'SOLANA_EXPECTED_GENESIS_HASH'));
    const providerId = patterned(value(input, 'EXECUTOR_RPC_PROVIDER_ID'),
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u, 256);
    const walletPublicKey = publicKey(value(input, 'EXECUTOR_PUBLIC_KEY'));
    const generationNumber = decimalInteger(value(input,
      'EXECUTOR_WALLET_GENERATION_NUMBER'), 1, 2_147_483_647);
    const evidencePublicKeyBase64 = canonicalBase64(value(input,
      'EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64'), 256);
    const providerEvidencePath = absolutePath(value(input,
      'EXECUTOR_PROVIDER_EVIDENCE_PATH'));
    const maximumSlotLag = decimalInteger(value(input,
      'EXECUTOR_READINESS_MAX_SLOT_LAG'), 0, 8);
    const rpcTimeoutMs = decimalInteger(value(input, 'EXECUTOR_RPC_TIMEOUT_MS'), 100, 30_000);
    return Object.freeze({ databaseUrl, cluster, httpRpcUrl, expectedGenesisHash,
      providerId, walletPublicKey, generationNumber, evidencePublicKeyBase64,
      providerEvidencePath, maximumSlotLag, rpcTimeoutMs });
  } catch {
    throw invalid();
  }
}

function isEnvironment(value: unknown): value is Record<string, string | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isProxy(value);
}

function value(environment: Record<string, string | undefined>, key: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (!descriptor?.enumerable || !('value' in descriptor)
    || typeof descriptor.value !== 'string') throw invalid();
  return descriptor.value;
}

function bounded(value: string, maximumBytes: number): string {
  if (value.length === 0 || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > maximumBytes) throw invalid();
  return value;
}

function patterned(value: string, pattern: RegExp, maximumBytes: number): string {
  const result = bounded(value, maximumBytes);
  if (!pattern.test(result)) throw invalid();
  return result;
}

function publicKey(value: string): string {
  const result = bounded(value, 64);
  if (new PublicKey(result).toBase58() !== result) throw invalid();
  return result;
}

function exactMainnet(value: string): 'mainnet-beta' {
  if (value !== 'mainnet-beta') throw invalid();
  return value;
}

function httpsUrl(value: string): string {
  const result = bounded(value, 4_096);
  const url = new URL(result);
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0
    || url.hash.length > 0 || url.href !== result) throw invalid();
  return result;
}

function postgresUrl(value: string): string {
  const result = bounded(value, 4_096);
  const url = new URL(result);
  if ((url.protocol !== 'postgresql:' && url.protocol !== 'postgres:')
    || url.hostname.length === 0 || url.hash.length > 0) throw invalid();
  return result;
}

function absolutePath(value: string): string {
  const result = bounded(value, 4_096);
  if (!isAbsolute(result) || normalize(result) !== result || result.includes('\0')) throw invalid();
  return result;
}

function canonicalBase64(value: string, maximumBytes: number): string {
  const result = bounded(value, Math.ceil(maximumBytes / 3) * 4 + 4);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(result)) throw invalid();
  const decoded = Buffer.from(result, 'base64');
  if (decoded.length === 0 || decoded.length > maximumBytes
    || decoded.toString('base64') !== result) throw invalid();
  return result;
}

function decimalInteger(value: string, minimum: number, maximum: number): number {
  const result = bounded(value, 32);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(result)) throw invalid();
  const parsed = Number(result);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw invalid();
  return parsed;
}

function invalid(): ExecutionReadinessConfigError {
  return new ExecutionReadinessConfigError();
}

