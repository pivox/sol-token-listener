import { z } from 'zod';

const CONFIG_PATH = '/config.json';
const CONFIG_MAX_BYTES = 8_192;
const CONFIG_TIMEOUT_MS = 5_000;

const runtimeConfigSchema = z.object({
  apiBaseUrl: z.string().min(1).max(2_048),
}).strict();

export interface RuntimeConfig {
  readonly apiBaseUrl: string;
}

export type RuntimeConfigErrorCode =
  | 'CONFIG_UNAVAILABLE'
  | 'CONFIG_TOO_LARGE'
  | 'CONFIG_INVALID';

export class RuntimeConfigError extends Error {
  public constructor(public readonly code: RuntimeConfigErrorCode) {
    super('La configuration publique du front-end est indisponible ou invalide.');
    this.name = 'RuntimeConfigError';
  }
}

export async function loadRuntimeConfig(
  fetchFn: typeof fetch,
  signal?: AbortSignal,
  // Node-based callers do not necessarily expose the browser-only Location global.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  currentOrigin = globalThis.location?.origin,
): Promise<RuntimeConfig> {
  const timeoutSignal = AbortSignal.timeout(CONFIG_TIMEOUT_MS);
  const requestSignal = signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal]);
  let response: Response;
  try {
    response = await fetchFn(CONFIG_PATH, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: requestSignal,
    });
  } catch {
    throw new RuntimeConfigError('CONFIG_UNAVAILABLE');
  }
  if (!response.ok) throw new RuntimeConfigError('CONFIG_UNAVAILABLE');
  assertContentLength(response.headers.get('content-length'));
  const body = await readBoundedText(response);
  let decoded: unknown;
  try {
    decoded = JSON.parse(body) as unknown;
  } catch {
    throw new RuntimeConfigError('CONFIG_INVALID');
  }
  const parsed = runtimeConfigSchema.safeParse(decoded);
  if (!parsed.success) throw new RuntimeConfigError('CONFIG_INVALID');
  return Object.freeze({ apiBaseUrl: normalizeApiBaseUrl(parsed.data.apiBaseUrl, currentOrigin) });
}

function assertContentLength(value: string | null): void {
  if (value === null) return;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new RuntimeConfigError('CONFIG_INVALID');
  const length = BigInt(value);
  if (length > BigInt(CONFIG_MAX_BYTES)) throw new RuntimeConfigError('CONFIG_TOO_LARGE');
}

async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let result = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > CONFIG_MAX_BYTES) throw new RuntimeConfigError('CONFIG_TOO_LARGE');
      result += decoder.decode(chunk.value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error;
    throw new RuntimeConfigError('CONFIG_INVALID');
  } finally {
    reader.releaseLock();
  }
}

function normalizeApiBaseUrl(value: string, currentOrigin: string | undefined): string {
  if (value === '/') return normalizeOrigin(currentOrigin);
  if (value.trim() !== value) throw new RuntimeConfigError('CONFIG_INVALID');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeConfigError('CONFIG_INVALID');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) throw new RuntimeConfigError('CONFIG_INVALID');
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '');
  return `${url.origin}${pathname}`;
}

function normalizeOrigin(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() !== value) throw new RuntimeConfigError('CONFIG_INVALID');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeConfigError('CONFIG_INVALID');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) throw new RuntimeConfigError('CONFIG_INVALID');
  return url.origin;
}
