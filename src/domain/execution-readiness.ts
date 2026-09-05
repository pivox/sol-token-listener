import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { PublicKey } from '@solana/web3.js';
import type { WalletGenerationDraftV1 } from '../ports/execution-risk-repository.js';

const GENERATION_INPUT_KEYS = Object.freeze([
  'walletPublicKey', 'cluster', 'genesisHash', 'generation',
] as const);
const MANIFEST_INPUT_KEYS = Object.freeze([
  'generationId', 'walletPublicKey', 'cluster', 'providerId',
  'walletSnapshotId', 'walletSnapshotFingerprint', 'providerSnapshotId',
  'providerSnapshotFingerprint', 'walletLamports', 'tokenBalanceCount',
  'observedAtMs', 'expiresAtMs',
] as const);
const DATE_MAX_MS = 8_640_000_000_000_000;
const U64_MAX = 18_446_744_073_709_551_615n;

export interface ExecutionReadinessManifestV1 {
  readonly schemaVersion: 'execution-readiness-bootstrap.v1';
  readonly state: 'READINESS_EVIDENCE_COLLECTED';
  readonly generationId: string;
  readonly walletPublicKey: string;
  readonly cluster: 'mainnet-beta';
  readonly providerId: string;
  readonly walletSnapshotId: string;
  readonly walletSnapshotFingerprint: string;
  readonly providerSnapshotId: string;
  readonly providerSnapshotFingerprint: string;
  readonly walletLamports: string;
  readonly tokenBalanceCount: number;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly canaryStatus: 'CANARY_NOT_STARTED';
  readonly paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED';
}

export class ExecutionReadinessValidationError extends TypeError {
  public readonly code = 'INVALID_EXECUTION_READINESS_INPUT' as const;
  public constructor() {
    super('Invalid execution readiness input.');
    this.name = 'ExecutionReadinessValidationError';
  }
}

export function createExecutionWalletGeneration(input: unknown): WalletGenerationDraftV1 {
  try {
    const row = exactFrozenRecord(input, GENERATION_INPUT_KEYS);
    const walletPublicKey = publicKey(row.walletPublicKey);
    const cluster = clusterValue(row.cluster);
    const genesisHash = publicKey(row.genesisHash);
    const generation = integer(row.generation, 1, 2_147_483_647);
    const generationId = `execution_wallet_generation_${hashLengthPrefixed([
      'execution-wallet-generation-v1', walletPublicKey, cluster, genesisHash,
      generation.toString(),
    ])}`;
    return Object.freeze({ generationId, payloadVersion: 1, walletPublicKey, cluster,
      genesisHash, generation });
  } catch {
    throw invalid();
  }
}

export function createExecutionReadinessManifest(input: unknown): ExecutionReadinessManifestV1 {
  try {
    const row = exactFrozenRecord(input, MANIFEST_INPUT_KEYS);
    const observedAtMs = timestamp(row.observedAtMs);
    const expiresAtMs = timestamp(row.expiresAtMs);
    if (expiresAtMs < observedAtMs) throw invalid();
    return Object.freeze({
      schemaVersion: 'execution-readiness-bootstrap.v1',
      state: 'READINESS_EVIDENCE_COLLECTED',
      generationId: patterned(row.generationId,
        /^execution_wallet_generation_[0-9a-f]{64}$/u, 96),
      walletPublicKey: publicKey(row.walletPublicKey),
      cluster: mainnetCluster(row.cluster),
      providerId: patterned(row.providerId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u, 256),
      walletSnapshotId: patterned(row.walletSnapshotId,
        /^execution_wallet_snapshot_[0-9a-f]{64}$/u, 96),
      walletSnapshotFingerprint: fingerprint(row.walletSnapshotFingerprint),
      providerSnapshotId: patterned(row.providerSnapshotId,
        /^execution_provider_usage_[0-9a-f]{64}$/u, 96),
      providerSnapshotFingerprint: fingerprint(row.providerSnapshotFingerprint),
      walletLamports: unsignedBigint(row.walletLamports).toString(),
      tokenBalanceCount: integer(row.tokenBalanceCount, 0, 2_147_483_647),
      observedAtMs,
      expiresAtMs,
      canaryStatus: 'CANARY_NOT_STARTED',
      paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
    });
  } catch {
    throw invalid();
  }
}

function exactFrozenRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || isProxy(value) || !Object.isFrozen(value)) throw invalid();
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length
    || own.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  return result as Readonly<Record<Keys[number], unknown>>;
}

function publicKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) throw invalid();
  if (new PublicKey(value).toBase58() !== value) throw invalid();
  return value;
}

function clusterValue(value: unknown): 'mainnet-beta' | 'devnet' | 'testnet' {
  if (value !== 'mainnet-beta' && value !== 'devnet' && value !== 'testnet') throw invalid();
  return value;
}

function mainnetCluster(value: unknown): 'mainnet-beta' {
  if (value !== 'mainnet-beta') throw invalid();
  return value;
}

function patterned(value: unknown, pattern: RegExp, maximumBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes
    || !pattern.test(value)) throw invalid();
  return value;
}

function fingerprint(value: unknown): string {
  return patterned(value, /^[0-9a-f]{64}$/u, 64);
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum
    || (value as number) > maximum) throw invalid();
  return value as number;
}

function timestamp(value: unknown): number {
  return integer(value, 0, DATE_MAX_MS);
}

function unsignedBigint(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw invalid();
  return value;
}

function hashLengthPrefixed(values: readonly string[]): string {
  const digest = createHash('sha256');
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    digest.update(String(bytes.length));
    digest.update(':');
    digest.update(bytes);
  }
  return digest.digest('hex');
}

function invalid(): ExecutionReadinessValidationError {
  return new ExecutionReadinessValidationError();
}

