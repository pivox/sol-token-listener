import { isAbsolute, normalize } from 'node:path';
import { isProxy } from 'node:util/types';

const FORBIDDEN_KEY = /(?:HELIUS_API_KEY$|PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|RECOVERY_PHRASE|WALLET|LIVE_TRADING_ENABLED|EXECUTOR_MODE|SOLANA_(?:HTTP|WS)_RPC_URL|DATABASE_URL)/u;

export interface HeliusProviderEvidenceConfig {
  readonly projectId: string;
  readonly apiKeyPath: string;
  readonly providerId: string;
  readonly privateKeyPath: string;
  readonly outputPath: string;
  readonly ttlMs: number;
  readonly timeoutMs: number;
}

export class HeliusProviderEvidenceConfigError extends TypeError {
  public readonly code = 'INVALID_HELIUS_PROVIDER_EVIDENCE_CONFIG' as const;
  public constructor() {
    super('Invalid Helius provider evidence configuration.');
    this.name = 'HeliusProviderEvidenceConfigError';
  }
}

export function parseHeliusProviderEvidenceConfig(input: unknown): HeliusProviderEvidenceConfig {
  try {
    if (!isEnvironment(input)) throw invalid();
    for (const key of Object.keys(input)) {
      if (FORBIDDEN_KEY.test(key) && key !== 'EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH') throw invalid();
    }
    const projectId = patterned(value(input, 'HELIUS_PROJECT_ID'),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      36);
    const apiKeyPath = absolutePath(value(input, 'HELIUS_API_KEY_PATH'));
    const providerId = patterned(value(input, 'EXECUTOR_RPC_PROVIDER_ID'),
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, 64);
    const privateKeyPath = absolutePath(value(input, 'EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH'));
    const outputPath = absolutePath(value(input, 'EXECUTOR_PROVIDER_EVIDENCE_PATH'));
    const ttlMs = decimalInteger(value(input, 'EXECUTOR_PROVIDER_EVIDENCE_TTL_MS'),
      30_000, 300_000);
    const timeoutMs = decimalInteger(value(input, 'EXECUTOR_PROVIDER_EVIDENCE_TIMEOUT_MS'),
      100, 30_000);
    if (new Set([apiKeyPath, privateKeyPath, outputPath]).size !== 3) throw invalid();
    return Object.freeze({ projectId, apiKeyPath, providerId, privateKeyPath,
      outputPath, ttlMs, timeoutMs });
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

function absolutePath(value: string): string {
  const result = bounded(value, 4_096);
  if (!isAbsolute(result) || normalize(result) !== result || result.includes('\0')) throw invalid();
  return result;
}

function decimalInteger(value: string, minimum: number, maximum: number): number {
  const result = bounded(value, 32);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(result)) throw invalid();
  const parsed = Number(result);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw invalid();
  return parsed;
}

function invalid(): HeliusProviderEvidenceConfigError {
  return new HeliusProviderEvidenceConfigError();
}
