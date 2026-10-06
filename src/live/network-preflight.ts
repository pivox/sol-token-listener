export type PreflightMethod = 'getGenesisHash' | 'getVersion' | 'getSlot';
export type PreflightCallStatus = 'OK' | 'TRANSPORT_ERROR' | 'HTTP_REJECTED' | 'INVALID_JSON' | 'JSON_RPC_ERROR' | 'RPC_NULL' | 'METADATA_ABSENT';

export interface PreflightCall {
  readonly method: PreflightMethod;
  readonly status: PreflightCallStatus;
  readonly httpStatus: number | null;
  readonly result: unknown;
  readonly error: Readonly<{ name: string; code: string | null; message: string }> | null;
}

export interface NetworkPreflightReport {
  readonly status: 'PASS' | 'BLOCKED';
  readonly endpoint: '[REDACTED]';
  readonly expectedGenesisHash: string;
  readonly observedGenesisHash: string | null;
  readonly calls: readonly PreflightCall[];
  readonly requestCount: number;
  readonly maxRequests: 3;
  readonly timeoutMs: 5_000;
}

export interface NetworkPreflightDependencies {
  readonly request: (endpoint: URL, method: PreflightMethod, timeoutMs: number) => Promise<unknown>;
}

const METHODS: readonly PreflightMethod[] = Object.freeze(['getGenesisHash', 'getVersion', 'getSlot']);
const TIMEOUT_MS = 5_000;

/** Three sequential read-only JSON-RPC calls. No retries, subscription, wallet or transaction path. */
export async function runNetworkPreflight(
  endpointValue: string,
  expectedGenesisHash: string,
  dependencies: NetworkPreflightDependencies = { request: defaultRequest },
): Promise<NetworkPreflightReport> {
  const endpoint = parseEndpoint(endpointValue);
  if (expectedGenesisHash.length === 0 || expectedGenesisHash !== expectedGenesisHash.trim()) {
    throw new TypeError('Expected genesis hash is required.');
  }
  const calls: PreflightCall[] = [];
  let observedGenesisHash: string | null = null;
  for (const method of METHODS) {
    let response: unknown;
    try {
      response = await dependencies.request(endpoint, method, TIMEOUT_MS);
    } catch (error) {
      calls.push({ method, status: 'TRANSPORT_ERROR', httpStatus: null, result: null, error: safeError(error) });
      break;
    }
    const call = classifyResponse(method, response);
    calls.push(call);
    if (call.status !== 'OK') break;
    if (method === 'getGenesisHash') {
      observedGenesisHash = typeof call.result === 'string' ? call.result : null;
      if (observedGenesisHash !== expectedGenesisHash) break;
    }
    if (method === 'getVersion' && (typeof call.result !== 'object' || call.result === null
      || typeof (call.result as Record<string, unknown>)['solana-core'] !== 'string')) break;
    if (method === 'getSlot' && (!Number.isSafeInteger(call.result) || Number(call.result) < 0)) break;
  }
  const complete = calls.length === METHODS.length
    && calls.every((call) => call.status === 'OK')
    && observedGenesisHash === expectedGenesisHash;
  return Object.freeze({
    status: complete ? 'PASS' : 'BLOCKED',
    endpoint: '[REDACTED]',
    expectedGenesisHash,
    observedGenesisHash,
    calls: Object.freeze(calls),
    requestCount: calls.length,
    maxRequests: 3,
    timeoutMs: TIMEOUT_MS,
  });
}

function classifyResponse(method: PreflightMethod, response: unknown): PreflightCall {
  const envelope = record(response);
  const httpStatusValue = envelope?.httpStatus;
  const httpStatus = Number.isSafeInteger(httpStatusValue) && Number(httpStatusValue) >= 100 && Number(httpStatusValue) <= 599
    ? Number(httpStatusValue)
    : null;
  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
    return { method, status: 'HTTP_REJECTED', httpStatus, result: null, error: errorValue('HttpError', `HTTP ${String(httpStatus)}`) };
  }
  if (envelope === null || !Object.prototype.hasOwnProperty.call(envelope, 'body')) {
    return { method, status: 'METADATA_ABSENT', httpStatus, result: null, error: null };
  }
  const body = typeof envelope.body === 'string' ? safeJsonParse(envelope.body) : envelope.body;
  if (body === INVALID_JSON) return { method, status: 'INVALID_JSON', httpStatus, result: null, error: errorValue('SyntaxError', 'RPC response was not valid JSON.') };
  const rpc = record(body);
  if (rpc === null) return { method, status: 'METADATA_ABSENT', httpStatus, result: null, error: null };
  const rpcError = record(rpc.error);
  if (rpcError !== null) {
    const code = typeof rpcError.code === 'number' && Number.isSafeInteger(rpcError.code) ? String(rpcError.code) : null;
    const message = typeof rpcError.message === 'string' ? sanitize(rpcError.message) : 'JSON-RPC returned an error.';
    return { method, status: 'JSON_RPC_ERROR', httpStatus, result: null, error: { name: 'JsonRpcError', code, message } };
  }
  if (!Object.prototype.hasOwnProperty.call(rpc, 'result') || rpc.result === null) {
    return { method, status: 'RPC_NULL', httpStatus, result: null, error: null };
  }
  return { method, status: 'OK', httpStatus, result: rpc.result, error: null };
}

async function defaultRequest(endpoint: URL, method: PreflightMethod, timeoutMs: number): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  return { httpStatus: response.status, body };
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new TypeError('Live RPC endpoint is invalid.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new TypeError('Live RPC preflight requires an HTTPS endpoint without URL userinfo.');
  }
  return endpoint;
}

const INVALID_JSON = Symbol('INVALID_JSON');
function safeJsonParse(value: string): unknown | typeof INVALID_JSON {
  try { return JSON.parse(value) as unknown; } catch { return INVALID_JSON; }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeError(error: unknown): NonNullable<PreflightCall['error']> {
  const name = error instanceof Error && /^[A-Za-z0-9_.-]{1,64}$/u.test(error.name) ? error.name : 'NetworkError';
  const message = error instanceof Error ? sanitize(error.message) : 'Network request failed.';
  const cause = error instanceof Error ? error.cause : null;
  const causeRecord = record(cause);
  const code = typeof causeRecord?.code === 'string' && /^[A-Z0-9_]{2,32}$/u.test(causeRecord.code)
    ? causeRecord.code
    : null;
  const causeMessage = cause instanceof Error ? sanitize(cause.message)
    : typeof causeRecord?.message === 'string' ? sanitize(causeRecord.message) : null;
  return {
    name,
    code,
    message: [message, causeMessage, code === null ? null : `cause.code=${code}`]
      .filter((part): part is string => part !== null && part.length > 0).join('; '),
  };
}

function errorValue(name: string, message: string): NonNullable<PreflightCall['error']> {
  return { name, code: null, message: sanitize(message) };
}

function sanitize(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, (url) => {
      try { return `${new URL(url).protocol}//[REDACTED]`; } catch { return '[REDACTED_URL]'; }
    })
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .replace(/\b(api[-_]?key|access[-_]?token|token|secret|password)\s*[:=]\s*[^\s&;,]+/giu, '$1=[REDACTED]')
    .slice(0, 500);
}
