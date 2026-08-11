import { isProxy } from 'node:util/types';

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

export const DEPLOYMENT_HEALTHCHECK_TIMEOUT_MS = 3_000;
export const DEPLOYMENT_HEALTHCHECK_MAX_BYTES = 65_536;

export type DeploymentHealthcheckCode =
  | 'HEALTHCHECK_URL_INVALID'
  | 'HEALTHCHECK_PORT_INVALID'
  | 'HEALTHCHECK_ARGUMENTS_INVALID'
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
  readonly requireOk?: boolean;
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
  let rejectDeadline: (error: DeploymentHealthcheckError) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = timers.setTimeout(() => {
    controller.abort();
    rejectDeadline(failure('HEALTHCHECK_TIMEOUT'));
  }, DEPLOYMENT_HEALTHCHECK_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    response = await raceDeadline(dependencies.fetch(url, Object.freeze({
      method: 'GET', headers: Object.freeze({ accept: 'application/json' }), redirect: 'error', signal: controller.signal,
    })), deadline);
    if (controller.signal.aborted) throw failure('HEALTHCHECK_TIMEOUT');
    const status = responseStatus(response);
    if (status !== 200) throw failure('HEALTHCHECK_HTTP_STATUS_INVALID');
    const declaredLength = responseContentLength(response);
    if (declaredLength !== null && declaredLength > DEPLOYMENT_HEALTHCHECK_MAX_BYTES) {
      throw failure('HEALTHCHECK_BODY_TOO_LARGE');
    }
    const body = await readBoundedResponseBody(response, deadline);
    const envelope = parseEnvelope(body);
    if (
      envelope.status !== 'OK'
      && (dependencies.requireOk === true || envelope.status !== 'DEGRADED')
    ) throw failure('HEALTHCHECK_UNHEALTHY');
    if (envelope.postgresql !== 'AVAILABLE') throw failure('HEALTHCHECK_UNHEALTHY');
  } catch (error: unknown) {
    const deadlineExpired = controller.signal.aborted;
    controller.abort();
    if (response !== undefined) cancelResponseBody(response);
    if (error instanceof DeploymentHealthcheckError) throw error;
    if (deadlineExpired) throw failure('HEALTHCHECK_TIMEOUT');
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

async function readBoundedResponseBody(response: Response, deadline: Promise<never>): Promise<Uint8Array> {
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
  let completed = false;
  let pendingRead: Promise<StreamReadResult> | undefined;
  let readPending = false;
  try {
    for (;;) {
      const read = Promise.resolve(reader.read());
      pendingRead = read;
      readPending = true;
      void read.then(
        () => { readPending = false; },
        () => { readPending = false; },
      );
      const item = await raceDeadline(read, deadline);
      pendingRead = undefined;
      readPending = false;
      if (item.done) { completed = true; break; }
      if (!(item.value instanceof Uint8Array)) throw failure('HEALTHCHECK_ENVELOPE_INVALID');
      total += item.value.byteLength;
      if (total > DEPLOYMENT_HEALTHCHECK_MAX_BYTES) throw failure('HEALTHCHECK_BODY_TOO_LARGE');
      chunks.push(item.value);
    }
  } finally {
    if (!completed) cancelReader(reader);
    if (pendingRead !== undefined && readPending) {
      void pendingRead.then(
        () => { releaseReader(reader); },
        () => { releaseReader(reader); },
      );
    } else {
      releaseReader(reader);
    }
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

async function raceDeadline<T>(operation: Promise<T>, deadline: Promise<never>): Promise<T> {
  const contained = Promise.resolve(operation).then(
    (value) => value,
    () => { throw failure('HEALTHCHECK_REQUEST_FAILED'); },
  );
  return await Promise.race([contained, deadline]);
}

function cancelResponseBody(response: Response): void {
  try {
    const body = response.body;
    if (body !== null) contain(body.cancel());
  } catch {
    // Cancellation is best effort and must never replace or delay the bounded failure.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { contain(reader.cancel()); } catch { /* bounded failure wins */ }
}

function contain(operation: Promise<unknown>): void {
  void Promise.resolve(operation).then(
    () => undefined,
    () => undefined,
  );
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { reader.releaseLock(); } catch { /* native stream cleanup is best effort */ }
}

function failure(code: DeploymentHealthcheckCode): DeploymentHealthcheckError {
  return new DeploymentHealthcheckError(code);
}
