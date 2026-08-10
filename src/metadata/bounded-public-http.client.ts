import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type {
  PublicHttpClient,
  PublicHttpFailureReason,
  PublicHttpResult,
} from '../ports/public-http-client.js';

export interface BoundedPublicHttpClientOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly maxConcurrency: number;
  readonly maxPerHostConcurrency: 1;
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface PublicHttpTransportRequest {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly signal: AbortSignal;
  readonly headers: Readonly<Record<string, string>>;
}

export interface PublicHttpTransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
  readonly discard?: () => void;
}

export type PublicHttpTransport = (
  request: PublicHttpTransportRequest,
) => Promise<PublicHttpTransportResponse>;

const DEFAULT_OPTIONS: BoundedPublicHttpClientOptions = Object.freeze({
  timeoutMs: 5_000,
  maxBytes: 1_000_000,
  maxRedirects: 3,
  maxConcurrency: 8,
  maxPerHostConcurrency: 1,
});

export class BoundedPublicHttpClient implements PublicHttpClient {
  readonly #global: Semaphore;
  readonly #byHost = new Map<string, Semaphore>();

  public constructor(
    private readonly transport: PublicHttpTransport = nodePublicHttpTransport,
    private readonly resolveHost: HostResolver = resolveHostAddresses,
    private readonly options: BoundedPublicHttpClientOptions = DEFAULT_OPTIONS,
  ) {
    validateOptions(options);
    this.#global = new Semaphore(options.maxConcurrency);
  }

  public get retainedHostCount(): number {
    return this.#byHost.size;
  }

  public async get(
    input: string,
    acceptedContentTypes: readonly string[],
  ): Promise<PublicHttpResult> {
    const accepted = normalizeAcceptedTypes(acceptedContentTypes);
    let current: URL;
    try {
      current = new URL(input);
    } catch {
      return failure('URL_INVALID', false);
    }
    const initialValidation = validateUrl(current);
    if (initialValidation !== null) return initialValidation;

    for (let redirectCount = 0; redirectCount <= this.options.maxRedirects; redirectCount += 1) {
      const destination = await this.#destination(current);
      if (destination.status === 'FAILED') return destination;
      const response = await this.#request(current, destination.address, destination.family);
      if (response.status === 'FAILED') return response;
      try {
        const statusCode = response.value.statusCode;
        if (statusCode >= 300 && statusCode < 400) {
          discard(response.value);
          if (redirectCount === this.options.maxRedirects) {
            return failure('REDIRECT_LIMIT_EXCEEDED', false);
          }
          const location = header(response.value.headers, 'location');
          if (location === null) return failure('REDIRECT_INVALID', false);
          try {
            current = new URL(location, current);
          } catch {
            return failure('REDIRECT_INVALID', false);
          }
          const redirectValidation = validateUrl(current);
          if (redirectValidation !== null) return redirectValidation;
          continue;
        }

        if (statusCode < 200 || statusCode >= 300) {
          discard(response.value);
          return failure('HTTP_STATUS_INVALID', isRetryableStatus(statusCode));
        }
        const contentType = mediaType(header(response.value.headers, 'content-type'));
        if (contentType === null || !accepted.has(contentType)) {
          discard(response.value);
          return failure('CONTENT_TYPE_UNSUPPORTED', false);
        }
        const declaredLength = contentLength(header(response.value.headers, 'content-length'));
        if (declaredLength !== null && declaredLength > this.options.maxBytes) {
          discard(response.value);
          return failure('CONTENT_TOO_LARGE', false);
        }
        let body: Uint8Array | null;
        try {
          body = await readBody(response.value.body, this.options.maxBytes, response.signal);
        } catch {
          return response.signal.aborted
            ? failure('TIMEOUT', true)
            : failure('NETWORK_FAILED', true);
        }
        if (body === null) {
          discard(response.value);
          return failure('CONTENT_TOO_LARGE', false);
        }
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(body);
        } catch {
          return failure('UTF8_INVALID', false);
        }
        return Object.freeze({
          status: 'SUCCEEDED' as const,
          finalUrl: current.toString(),
          httpStatus: statusCode,
          contentType,
          redirectCount,
          body,
        });
      } finally {
        response.finish();
      }
    }
    return failure('REDIRECT_LIMIT_EXCEEDED', false);
  }

  async #destination(url: URL): Promise<Destination | FailedResult> {
    const hostname = normalizedHostname(url.hostname);
    const directFamily = isIP(hostname);
    let addresses: readonly string[];
    if (directFamily !== 0) {
      addresses = [hostname];
    } else {
      try {
        addresses = await this.resolveHost(hostname);
      } catch {
        return failure('DNS_FAILED', true);
      }
    }
    if (addresses.length === 0) return failure('DNS_FAILED', true);
    const normalized = addresses.map(normalizedHostname);
    if (normalized.some((address) => !isPublicIp(address))) {
      return failure('UNSAFE_DESTINATION', false);
    }
    const address = normalized[0];
    const family = address === undefined ? 0 : isIP(address);
    if (address === undefined || (family !== 4 && family !== 6)) {
      return failure('UNSAFE_DESTINATION', false);
    }
    return Object.freeze({ status: 'RESOLVED' as const, address, family });
  }

  async #request(url: URL, address: string, family: 4 | 6): Promise<RequestResult> {
    const hostname = normalizedHostname(url.hostname).toLowerCase();
    const hostSemaphore = this.#hostSemaphore(hostname);
    const releaseHostLease = await hostSemaphore.acquire();
    const releaseHost = (): void => {
      releaseHostLease();
      if (hostSemaphore.idle && this.#byHost.get(hostname) === hostSemaphore) {
        this.#byHost.delete(hostname);
      }
    };
    const releaseGlobal = await this.#global.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.options.timeoutMs);
    const finish = once(() => {
      clearTimeout(timer);
      releaseGlobal();
      releaseHost();
    });
    try {
      const value = await abortable(this.transport(Object.freeze({
        url: new URL(url.toString()),
        address,
        family,
        signal: controller.signal,
        headers: Object.freeze({
          accept: '*/*',
          'accept-encoding': 'identity',
          'user-agent': 'sol-token-listener/observe',
        }),
      })), controller.signal);
      return Object.freeze({
        status: 'SUCCEEDED' as const,
        value,
        signal: controller.signal,
        finish,
      });
    } catch (error: unknown) {
      finish();
      return controller.signal.aborted || isTimeoutError(error)
        ? failure('TIMEOUT', true)
        : failure('NETWORK_FAILED', true);
    }
  }

  #hostSemaphore(hostname: string): Semaphore {
    const current = this.#byHost.get(hostname);
    if (current !== undefined) return current;
    const created = new Semaphore(this.options.maxPerHostConcurrency);
    this.#byHost.set(hostname, created);
    return created;
  }
}

type FailedResult = Extract<PublicHttpResult, { readonly status: 'FAILED' }>;
type Destination = Readonly<{ status: 'RESOLVED'; address: string; family: 4 | 6 }>;
type RequestResult = FailedResult | Readonly<{
  status: 'SUCCEEDED';
  value: PublicHttpTransportResponse;
  signal: AbortSignal;
  finish: () => void;
}>;

class Semaphore {
  #available: number;
  readonly #waiters: ((release: () => void) => void)[] = [];

  public constructor(private readonly capacity: number) {
    this.#available = capacity;
  }

  public get idle(): boolean {
    return this.#available === this.capacity && this.#waiters.length === 0;
  }

  public acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#release());
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next === undefined) this.#available += 1;
      else next(this.#release());
    };
  }
}

export const nodePublicHttpTransport: PublicHttpTransport = async (input) => {
  const request = input.url.protocol === 'https:' ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    method: 'GET',
    agent: false,
    signal: input.signal,
    headers: input.headers,
    lookup(_hostname, _options, callback) {
      callback(null, input.address, input.family);
    },
  };
  return await new Promise<PublicHttpTransportResponse>((resolve, reject) => {
    const outbound = request(input.url, options, (response: IncomingMessage) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      resolve(Object.freeze({
        statusCode: response.statusCode ?? 500,
        headers: Object.freeze(headers),
        body: response,
        discard: () => response.destroy(),
      }));
    });
    outbound.once('error', reject);
    outbound.end();
  });
};

async function resolveHostAddresses(hostname: string): Promise<readonly string[]> {
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
}

function validateUrl(url: URL): FailedResult | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return failure('SCHEME_UNSUPPORTED', false);
  }
  if (url.username !== '' || url.password !== '' || url.hostname === '') {
    return failure('UNSAFE_DESTINATION', false);
  }
  return null;
}

function validateOptions(options: BoundedPublicHttpClientOptions): void {
  positiveInteger(options.timeoutMs, 'timeoutMs');
  positiveInteger(options.maxBytes, 'maxBytes');
  positiveInteger(options.maxConcurrency, 'maxConcurrency');
  if (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0) {
    throw new RangeError('maxRedirects must be a non-negative safe integer.');
  }
  const maxPerHostConcurrency: unknown = options.maxPerHostConcurrency;
  if (maxPerHostConcurrency !== 1) {
    throw new RangeError('maxPerHostConcurrency must be 1.');
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function normalizeAcceptedTypes(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('At least one accepted content type is required.');
  }
  const normalized = values.map((value) => {
    if (typeof value !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(value)) {
      throw new TypeError('Accepted content type is invalid.');
    }
    return value.toLowerCase();
  });
  return new Set(normalized);
}

function normalizedHostname(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const numeric = ipv4Number(address);
    return numeric !== null && !IPV4_DENY.some(([network, bits]) => inIpv4Cidr(numeric, network, bits));
  }
  if (family === 6) {
    const numeric = ipv6Number(address);
    return numeric !== null && !IPV6_DENY.some(([network, bits]) => inIpv6Cidr(numeric, network, bits));
  }
  return false;
}

const IPV4_DENY: readonly (readonly [string, number])[] = Object.freeze([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]);

const IPV6_DENY: readonly (readonly [string, number])[] = Object.freeze([
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8],
]);

function ipv4Number(address: string): number | null {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return octets.reduce((total, part) => total * 256 + part, 0);
}

function inIpv4Cidr(address: number, network: string, bits: number): boolean {
  const base = ipv4Number(network);
  if (base === null) return true;
  const divisor = 2 ** (32 - bits);
  return Math.floor(address / divisor) === Math.floor(base / divisor);
}

function ipv6Number(address: string): bigint | null {
  let normalized = address.toLowerCase();
  const zone = normalized.indexOf('%');
  if (zone >= 0) normalized = normalized.slice(0, zone);
  const mappedIndex = normalized.lastIndexOf(':');
  if (normalized.includes('.') && mappedIndex >= 0) {
    const ipv4 = ipv4Number(normalized.slice(mappedIndex + 1));
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, mappedIndex)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : halves[0]?.split(':') ?? [];
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1]?.split(':') ?? [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = [...left, ...new Array<string>(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  return parts.reduce((total, part) => (total << 16n) + BigInt(`0x${part}`), 0n);
}

function inIpv6Cidr(address: bigint, network: string, bits: number): boolean {
  const base = ipv6Number(network);
  if (base === null) return true;
  const shift = BigInt(128 - bits);
  return address >> shift === base >> shift;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

function mediaType(value: string | null): string | null {
  if (value === null) return null;
  const type = value.split(';', 1)[0]?.trim().toLowerCase();
  return type === undefined || type === '' ? null : type;
}

function contentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

async function readBody(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const item = await abortable(iterator.next(), signal);
      if (item.done) break;
      const chunk = item.value;
      if (!(chunk instanceof Uint8Array)) return null;
      total += chunk.byteLength;
      if (total > maxBytes) return null;
      chunks.push(chunk);
    }
  } finally {
    if (signal.aborted) await iterator.return?.();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('ABORTED'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(new Error('ABORTED')); };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error('Public HTTP operation failed.'));
      },
    );
  });
}

function once(action: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    action();
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function discard(response: PublicHttpTransportResponse): void {
  try { response.discard?.(); } catch { /* bounded failure wins */ }
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor !== undefined && 'value' in descriptor
    && (descriptor.value === 'ABORT_ERR' || descriptor.value === 'ETIMEDOUT');
}

function failure(reason: PublicHttpFailureReason, retryable: boolean): FailedResult {
  return Object.freeze({ status: 'FAILED' as const, reason, retryable });
}
