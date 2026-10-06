import { setTimeout as sleep } from 'node:timers/promises';
import { identity } from './journal.js';
import { classifyRpcTransaction, type RpcTransactionStatus } from './transaction-evidence.js';

export interface RpcRequestBudget { limit: number; used: number }
export interface RpcAttemptRecord {
  id: string; schema: 'transaction_evidence.v1'; kind: 'rpc_attempt'; signature: string; links: unknown;
  parameters: Record<string, unknown>; attempt: number; retrievedAt: number;
  status: RpcTransactionStatus | 'BUDGET_EXHAUSTED'; httpResponse: unknown; httpBodyRaw: string | null;
  httpStatus: number | null; timeoutMs: number | null;
  transportErrorCategory: string | null; transportErrorDetail: string | null;
  retryAfterRaw: string | null; retryAfterMs: number | null;
}
export interface CollectSignatureResult { status: RpcTransactionStatus | 'BUDGET_EXHAUSTED'; attempts: number; cacheHit: boolean; requestsUsed: number; retrievedAt: number | null; halted: boolean }
const terminal = new Set(['RESPONSE_AVAILABLE', 'RPC_NULL', 'VERSION_UNSUPPORTED', 'METADATA_ABSENT', 'EXECUTED_WITH_ERROR']);

/** Injected request function keeps retries/cache/budget testable without a network client. */
export async function collectGetTransaction(input: {
  signature: string; links: unknown; params: Record<string, unknown>; existingAttempts: readonly Record<string, unknown>[];
  retries: number; budget: RpcRequestBudget; requestTimeoutMs?: number;
  request(): Promise<{ response: unknown; rawBody?: string | null; httpStatus?: number | null; transportErrorCategory?: string | null;
    transportErrorDetail?: string | null; retryAfterRaw?: string | null; retryAfterMs?: number | null; halt?: boolean }>;
  append(record: RpcAttemptRecord): Promise<unknown>; clock?: () => number; wait?: (attempt: number) => Promise<unknown>;
  attemptStartNumber?: number;
}): Promise<CollectSignatureResult> {
  if (input.requestTimeoutMs !== undefined
    && (!Number.isSafeInteger(input.requestTimeoutMs) || input.requestTimeoutMs < 1 || input.requestTimeoutMs > 120_000)) {
    throw new RangeError('RPC request timeout is outside the bounded range.');
  }
  const clock = input.clock ?? Date.now;
  const cached = [...input.existingAttempts].reverse().find(row => row.signature === input.signature
    && JSON.stringify(row.parameters) === JSON.stringify(input.params) && terminal.has(String(row.status)));
  if (cached) return { status: String(cached.status) as RpcTransactionStatus, attempts: Number(cached.attempt ?? 0), cacheHit: true, requestsUsed: 0,
    retrievedAt: Number.isSafeInteger(cached.retrievedAt) ? Number(cached.retrievedAt) : null, halted: false };
  let status: RpcTransactionStatus | 'BUDGET_EXHAUSTED' = 'BUDGET_EXHAUSTED';
  let attempts = 0; let retrievedAt: number | null = null; let halted = false; const requestsBefore = input.budget.used;
  for (let attempt = 1; attempt <= input.retries + 1; attempt++) {
    if (input.budget.used >= input.budget.limit) break;
    input.budget.used++; attempts++;
    let response: unknown = null; let rawBody: string | null = null; let httpStatus: number | null = null; let transportErrorDetail: string | null = null;
    let transportErrorCategory: string | null = null; let retryAfterRaw: string | null = null; let retryAfterMs: number | null = null;
    try {
      const result = await input.request();
      response = sanitizeRpcResponse(result.response);
      rawBody = result.rawBody === undefined || result.rawBody === null ? null : redactSensitiveText(result.rawBody);
      httpStatus = result.httpStatus ?? null; transportErrorCategory = result.transportErrorCategory ?? null;
      retryAfterRaw = result.retryAfterRaw ?? null; retryAfterMs = result.retryAfterMs ?? null; halted = result.halt === true;
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UNKNOWN_ERROR';
      const message = error instanceof Error ? error.message : '';
      const cause = error instanceof Error ? error.cause : null;
      const causeMessage = cause instanceof Error ? cause.message : safeStringProperty(cause, 'message');
      const directCode = safeCode(error);
      const causeCode = safeCode(cause);
      const code = directCode ?? causeCode;
      transportErrorCategory = name === 'TimeoutError' || code === 'ETIMEDOUT' ? 'TIMEOUT' : 'NETWORK_ERROR';
      transportErrorDetail = [
        safeDiagnosticText(name),
        message.length === 0 ? null : `message=${safeDiagnosticText(message)}`,
        directCode === null ? null : `code=${directCode}`,
        causeMessage === null ? null : `cause=${safeDiagnosticText(causeMessage)}`,
        causeCode === null ? null : `cause.code=${causeCode}`,
      ].filter((part): part is string => part !== null).join(';');
      if (code !== null && ['EACCES', 'EPERM', 'ENETUNREACH', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND'].includes(code)) {
        transportErrorCategory = `NETWORK_ACCESS_REFUSED_${code}`; halted = true;
      }
    }
    retrievedAt = clock();
    status = transportErrorCategory === null ? classifyRpcTransaction(response).status : 'RPC_ERROR';
    const attemptNumber = (input.attemptStartNumber ?? 1) + attempts - 1;
    await input.append({ id: identity([input.signature, input.params, attemptNumber, retrievedAt]), schema: 'transaction_evidence.v1', kind: 'rpc_attempt',
      signature: input.signature, links: input.links, parameters: input.params, attempt: attemptNumber, retrievedAt, status, httpResponse: response,
      httpBodyRaw: rawBody, httpStatus, timeoutMs: input.requestTimeoutMs ?? null,
      transportErrorCategory, transportErrorDetail, retryAfterRaw, retryAfterMs });
    if (halted || terminal.has(status)) break;
    if (attempt <= input.retries && input.budget.used < input.budget.limit) await (input.wait ?? (n => sleep(250 * n)))(attempt);
  }
  return { status, attempts, cacheHit: false, requestsUsed: input.budget.used - requestsBefore, retrievedAt, halted };
}

function safeStringProperty(value: unknown, key: string): string | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function safeCode(value: unknown): string | null {
  const code = safeStringProperty(value, 'code');
  return code !== null && /^[A-Z0-9_]{2,32}$/u.test(code) ? code : null;
}

function safeDiagnosticText(value: string): string {
  return redactSensitiveText(value).slice(0, 500);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, (url) => {
      try { return `${new URL(url).protocol}//[REDACTED]`; } catch { return '[REDACTED_URL]'; }
    })
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .replace(/\b(api[-_]?key|access[-_]?token|token|secret|password)\s*[:=]\s*[^\s&;,]+/giu, '$1=[REDACTED]');
}

function sanitizeRpcResponse(value: unknown): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  const error = envelope.error;
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null || Array.isArray(error)) return value;
  const errorObject = error as Record<string, unknown>;
  if (typeof errorObject.message !== 'string') return value;
  return {
    ...envelope,
    error: { ...errorObject, message: safeDiagnosticText(errorObject.message) },
  };
}
