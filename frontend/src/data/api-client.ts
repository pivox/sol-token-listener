import type { z } from 'zod';
import {
  apiFailureSchema,
  apiHealthEnvelopeSchema,
  apiHoldersEnvelopeSchema,
  apiLaunchDetailEnvelopeSchema,
  apiLaunchListEnvelopeSchema,
  apiPaperPositionListEnvelopeSchema,
  apiQualificationEnvelopeSchema,
  apiSocialEnvelopeSchema,
  apiTimelineEnvelopeSchema,
} from './api-schemas.js';
import type {
  ApiHealth,
  ApiHolders,
  ApiLaunchDetail,
  ApiLaunchSummary,
  ApiPaperPosition,
  ApiQualification,
  ApiSocial,
  ApiTimelineEntry,
} from './api-schemas.js';
import { ApiContractError, ApiHttpError, ApiNetworkError } from './api-errors.js';
import { isSolanaPublicKey } from './solana-address.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export { ApiContractError, ApiHttpError, ApiNetworkError } from './api-errors.js';

export interface PageInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface RequestInput {
  readonly signal?: AbortSignal;
}

export interface ApiPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface ApiClient {
  listLaunches(input?: PageInput): Promise<ApiPage<ApiLaunchSummary>>;
  getLaunch(mint: string, input?: RequestInput): Promise<ApiLaunchDetail>;
  listLaunchEvents(mint: string, input?: PageInput): Promise<ApiPage<ApiTimelineEntry>>;
  getLaunchRisk(mint: string, input?: RequestInput): Promise<ApiQualification | null>;
  getLaunchSocial(mint: string, input?: RequestInput): Promise<ApiSocial>;
  getLaunchHolders(mint: string, input?: RequestInput): Promise<ApiHolders>;
  listPaperPositions(input?: PageInput): Promise<ApiPage<ApiPaperPosition>>;
  getHealth(input?: RequestInput): Promise<ApiHealth>;
}

export interface ApiClientOptions {
  readonly apiBaseUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const baseUrl = `${options.apiBaseUrl.replace(/\/+$/u, '')}/`;

  async function request<T>(route: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    if (didAbort(signal)) throw signal?.reason;
    const requestController = new AbortController();
    const timeout = setTimeout(() => {
      requestController.abort(new DOMException('API request timed out', 'TimeoutError'));
    }, timeoutMs);
    const propagateAbort = (): void => {
      requestController.abort(signal?.reason);
    };
    signal?.addEventListener('abort', propagateAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await fetchFn(new URL(route.replace(/^\/+/, ''), baseUrl), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: requestController.signal,
        });
      } catch (error) {
        if (didAbort(signal)) throw signal?.reason;
        throw new ApiNetworkError(error);
      }

      let decoded: unknown;
      try {
        decoded = await readJson(response, route, maxResponseBytes);
      } catch (error) {
        if (didAbort(signal)) throw signal?.reason;
        if (requestController.signal.aborted) throw new ApiNetworkError(error);
        throw error;
      }
      if (!response.ok) {
        const failure = apiFailureSchema.safeParse(decoded);
        if (!failure.success) {
          throw new ApiHttpError(response.status, 'INTERNAL_ERROR', 'La requête API a échoué.');
        }
        throw new ApiHttpError(
          response.status,
          failure.data.error.code,
          failure.data.error.message,
          failure.data.error.correlationId,
        );
      }
      const parsed = schema.safeParse(decoded);
      if (!parsed.success) {
        throw new ApiContractError(route, parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
      }
      return parsed.data;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', propagateAbort);
    }
  }

  function pageRoute(route: string, input: PageInput = {}): string {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    if (input.cursor !== undefined) query.set('cursor', input.cursor);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return `${route}${suffix}`;
  }

  function mintRoute(mint: string, suffix = ''): string {
    if (!isSolanaPublicKey(mint)) throw new ApiContractError(suffix || '/api/v1/launches/:mint', ['mint: invalid']);
    return `/api/v1/launches/${encodeURIComponent(mint)}${suffix}`;
  }

  return Object.freeze({
    async listLaunches(input: PageInput = {}): Promise<ApiPage<ApiLaunchSummary>> {
      const envelope = await request(pageRoute('/api/v1/launches', input), apiLaunchListEnvelopeSchema, input.signal);
      return { items: envelope.data, nextCursor: envelope.meta.nextCursor };
    },
    async getLaunch(mint: string, input: RequestInput = {}): Promise<ApiLaunchDetail> {
      const route = mintRoute(mint);
      return (await request(route, apiLaunchDetailEnvelopeSchema, input.signal)).data;
    },
    async listLaunchEvents(mint: string, input: PageInput = {}): Promise<ApiPage<ApiTimelineEntry>> {
      const route = pageRoute(mintRoute(mint, '/events'), input);
      const envelope = await request(route, apiTimelineEnvelopeSchema, input.signal);
      return { items: envelope.data, nextCursor: envelope.meta.nextCursor };
    },
    async getLaunchRisk(mint: string, input: RequestInput = {}): Promise<ApiQualification | null> {
      return (await request(mintRoute(mint, '/risk'), apiQualificationEnvelopeSchema, input.signal)).data;
    },
    async getLaunchSocial(mint: string, input: RequestInput = {}): Promise<ApiSocial> {
      return (await request(mintRoute(mint, '/social'), apiSocialEnvelopeSchema, input.signal)).data;
    },
    async getLaunchHolders(mint: string, input: RequestInput = {}): Promise<ApiHolders> {
      return (await request(mintRoute(mint, '/holders'), apiHoldersEnvelopeSchema, input.signal)).data;
    },
    async listPaperPositions(input: PageInput = {}): Promise<ApiPage<ApiPaperPosition>> {
      const envelope = await request(pageRoute('/api/v1/paper-positions', input), apiPaperPositionListEnvelopeSchema, input.signal);
      return { items: envelope.data, nextCursor: envelope.meta.nextCursor };
    },
    async getHealth(input: RequestInput = {}): Promise<ApiHealth> {
      return (await request('/api/v1/health', apiHealthEnvelopeSchema, input.signal)).data;
    },
  });
}

function didAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function readJson(response: Response, route: string, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && BigInt(declaredLength) > BigInt(maximumBytes)) {
    throw new ApiContractError(route, ['response: too large']);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ApiContractError(route, ['response: empty']);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let consumed = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        consumed = true;
        break;
      }
      total += chunk.value.byteLength;
      if (total > maximumBytes) throw new ApiContractError(route, ['response: too large']);
      chunks.push(chunk.value);
    }
  } finally {
    if (!consumed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ApiContractError(route, ['response: malformed JSON']);
  }
}
