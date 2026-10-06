import { isProxy } from 'node:util/types';

// The operator console API holds no wallet, signing, live-mode or arming capability.
const FORBIDDEN_KEY = /(?:PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|RECOVERY_PHRASE|LIVE_TRADING_ENABLED|EXECUTOR_MODE|ARMAMENT)/u;
const MINIMUM_TOKEN_LENGTH = 32;
const MAXIMUM_TOKEN_LENGTH = 256;

export interface OperatorApiConfig {
  readonly databaseUrl: string;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly allowedOrigin: string;
  readonly solanaHttpRpcUrl: string;
}

export class OperatorApiConfigError extends TypeError {
  public readonly code = 'INVALID_OPERATOR_API_CONFIG' as const;
  public constructor() {
    super('Invalid operator API configuration.');
    this.name = 'OperatorApiConfigError';
  }
}

export function parseOperatorApiConfig(input: unknown): OperatorApiConfig {
  try {
    if (!isEnvironment(input)) throw invalid();
    for (const key of Object.keys(input)) if (FORBIDDEN_KEY.test(key)) throw invalid();
    const token = required(input, 'OPERATOR_API_TOKEN');
    if (token.length < MINIMUM_TOKEN_LENGTH || token.length > MAXIMUM_TOKEN_LENGTH
      || !/^[\x21-\x7e]+$/u.test(token)) throw invalid();
    const host = optional(input, 'OPERATOR_API_HOST') ?? '127.0.0.1';
    if (!/^[A-Za-z0-9.-]{1,253}$/u.test(host)) throw invalid();
    const rawPort = optional(input, 'OPERATOR_API_PORT') ?? '3100';
    if (!/^[1-9]\d{0,4}$/u.test(rawPort) || Number(rawPort) > 65_535) throw invalid();
    return Object.freeze({
      databaseUrl: postgresUrl(required(input, 'OPERATOR_API_DATABASE_URL')),
      token,
      host,
      port: Number(rawPort),
      allowedOrigin: origin(required(input, 'OPERATOR_API_ALLOWED_ORIGIN')),
      solanaHttpRpcUrl: httpUrl(required(input, 'SOLANA_HTTP_RPC_URL')),
    });
  } catch { throw invalid(); }
}

function isEnvironment(value: unknown): value is Record<string, string | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isProxy(value);
}

function optional(environment: Record<string, string | undefined>, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)
    || typeof descriptor.value !== 'string') throw invalid();
  const value = descriptor.value;
  if (value.length === 0 || value.trim() !== value || value.includes('\0')) throw invalid();
  return value;
}

function required(environment: Record<string, string | undefined>, key: string): string {
  const value = optional(environment, key);
  if (value === undefined) throw invalid();
  return value;
}

function postgresUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'postgresql:' && url.protocol !== 'postgres:')
    || url.hostname.length === 0 || url.hash.length > 0) throw invalid();
  return value;
}

function httpUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hash.length > 0) throw invalid();
  return value;
}

function origin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) throw invalid();
  return value;
}

function invalid(): OperatorApiConfigError {
  return new OperatorApiConfigError();
}
