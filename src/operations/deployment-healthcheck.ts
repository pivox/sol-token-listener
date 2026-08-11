import { isProxy } from 'node:util/types';

export const DEPLOYMENT_HEALTHCHECK_TIMEOUT_MS = 3_000;
export const DEPLOYMENT_HEALTHCHECK_MAX_BYTES = 65_536;

export type DeploymentHealthcheckCode =
  | 'HEALTHCHECK_URL_INVALID'
  | 'HEALTHCHECK_PORT_INVALID'
  | 'HEALTHCHECK_REQUEST_FAILED'
  | 'HEALTHCHECK_TIMEOUT'
  | 'HEALTHCHECK_HTTP_STATUS_INVALID'
  | 'HEALTHCHECK_BODY_TOO_LARGE'
  | 'HEALTHCHECK_ENVELOPE_INVALID'
  | 'HEALTHCHECK_UNHEALTHY';

export class DeploymentHealthcheckError extends Error {
  public constructor(readonly code: DeploymentHealthcheckCode) {
    super(`Deployment healthcheck failed: ${code}.`);
    this.name = 'DeploymentHealthcheckError';
  }
}

export interface DeploymentHealthcheckTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface DeploymentHealthcheckDependencies {
  readonly fetch: typeof fetch;
  readonly timers?: DeploymentHealthcheckTimers;
}

const productionTimers: DeploymentHealthcheckTimers = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
});

export async function checkDeploymentHealth(
  input: string,
  dependencies: DeploymentHealthcheckDependencies,
): Promise<void> {
  const url = canonicalProbeUrl(input);
  const controller = new AbortController();
  const timers = dependencies.timers ?? productionTimers;
  const timer = timers.setTimeout(() => {
    controller.abort();
  }, DEPLOYMENT_HEALTHCHECK_TIMEOUT_MS);
  try {
    const response = await awaitWithAbort(dependencies.fetch(url, Object.freeze({
      method: 'GET', headers: Object.freeze({ accept: 'application/json' }), redirect: 'error', signal: controller.signal,
    })), controller.signal);
    if (controller.signal.aborted) throw failure('HEALTHCHECK_TIMEOUT');
    const status = responseStatus(response);
    if (status !== 200) throw failure('HEALTHCHECK_HTTP_STATUS_INVALID');
    const declaredLength = responseContentLength(response);
    if (declaredLength !== null && declaredLength > DEPLOYMENT_HEALTHCHECK_MAX_BYTES) {
      throw failure('HEALTHCHECK_BODY_TOO_LARGE');
    }
    const body = await readBoundedResponseBody(response, controller.signal);
    const envelope = parseEnvelope(body);
    if (envelope.status !== 'OK' && envelope.status !== 'DEGRADED') throw failure('HEALTHCHECK_UNHEALTHY');
    if (envelope.postgresql !== 'AVAILABLE') throw failure('HEALTHCHECK_UNHEALTHY');
  } catch (error: unknown) {
    if (error instanceof DeploymentHealthcheckError) throw error;
    if (controller.signal.aborted) throw failure('HEALTHCHECK_TIMEOUT');
    throw failure('HEALTHCHECK_REQUEST_FAILED');
  } finally {
    try { timers.clearTimeout(timer); } catch { /* A timer implementation cannot affect the probe result. */ }
  }
}

function canonicalProbeUrl(input: string): string {
  if (typeof input !== 'string') throw failure('HEALTHCHECK_URL_INVALID');
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/api\/v1\/health$/u.exec(input);
  if (match === null || !canonicalPort(match[1] ?? '')) throw failure('HEALTHCHECK_URL_INVALID');
  let url: URL;
  try { url = new URL(input); } catch { throw failure('HEALTHCHECK_URL_INVALID'); }
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/api/v1/health'
    || url.search !== ''
    || url.hash !== ''
  ) throw failure('HEALTHCHECK_URL_INVALID');
  return input;
}

function canonicalPort(value: string): boolean {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) return false;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function responseStatus(response: Response): number {
  try {
    const status: unknown = response.status;
    if (!Number.isSafeInteger(status)) throw new TypeError('invalid');
    return status as number;
  } catch {
    throw failure('HEALTHCHECK_ENVELOPE_INVALID');
  }
}

function responseContentLength(response: Response): number | null {
  try {
    const value = response.headers.get('content-length');
    if (value === null) return null;
    if (!/^[0-9]+$/u.test(value)) throw new TypeError('invalid');
    const length = Number(value);
    if (!Number.isSafeInteger(length)) throw new TypeError('invalid');
    return length;
  } catch {
    throw failure('HEALTHCHECK_ENVELOPE_INVALID');
  }
}

async function readBoundedResponseBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const body = response.body;
    if (body === null) throw new TypeError('missing');
    reader = body.getReader();
  } catch {
    throw failure('HEALTHCHECK_ENVELOPE_INVALID');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await awaitWithAbort(reader.read(), signal);
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw failure('HEALTHCHECK_ENVELOPE_INVALID');
      total += item.value.byteLength;
      if (total > DEPLOYMENT_HEALTHCHECK_MAX_BYTES) throw failure('HEALTHCHECK_BODY_TOO_LARGE');
      chunks.push(item.value);
    }
  } catch (error: unknown) {
    try { await reader.cancel(); } catch { /* bounded failure wins */ }
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* native stream cleanup is best effort */ }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseEnvelope(bytes: Uint8Array): Readonly<{
  status: unknown;
  postgresql: unknown;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw failure('HEALTHCHECK_ENVELOPE_INVALID');
  }
  const root = requiredRecord(parsed);
  if (requiredField(root, 'apiVersion') !== 'v1') throw failure('HEALTHCHECK_ENVELOPE_INVALID');
  const data = requiredRecord(requiredField(root, 'data'));
  const postgresql = requiredRecord(requiredField(data, 'postgresql'));
  return Object.freeze({ status: requiredField(data, 'status'), postgresql: requiredField(postgresql, 'status') });
}

function requiredRecord(value: unknown): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw failure('HEALTHCHECK_ENVELOPE_INVALID');
  }
  return value;
}

function requiredField(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw failure('HEALTHCHECK_ENVELOPE_INVALID'); }
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw failure('HEALTHCHECK_ENVELOPE_INVALID');
  }
  return descriptor.value;
}

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw failure('HEALTHCHECK_TIMEOUT');
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(failure('HEALTHCHECK_TIMEOUT')); };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      () => { signal.removeEventListener('abort', abort); reject(failure('HEALTHCHECK_REQUEST_FAILED')); },
    );
  });
}

function failure(code: DeploymentHealthcheckCode): DeploymentHealthcheckError {
  return new DeploymentHealthcheckError(code);
}
