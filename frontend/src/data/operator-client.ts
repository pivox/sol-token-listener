import { createJsonRequester } from './api-client.js';
import type { PageInput } from './api-client.js';
import { operatorLiveOverviewEnvelopeSchema } from './operator-schemas.js';
import type { OperatorLiveOverview } from './operator-schemas.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface OperatorOverviewPage {
  readonly overview: OperatorLiveOverview;
  readonly nextCursor: string | null;
}

export interface OperatorClient {
  getLiveOverview(input?: PageInput): Promise<OperatorOverviewPage>;
}

export interface OperatorClientOptions {
  readonly operatorApiBaseUrl: string;
  readonly token: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Same bounded GET-only transport as the public client, plus the operator bearer token. */
export function createOperatorClient(options: OperatorClientOptions): OperatorClient {
  const request = createJsonRequester({
    apiBaseUrl: options.operatorApiBaseUrl,
    fetchFn: options.fetchFn ?? fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    headers: { Accept: 'application/json', Authorization: `Bearer ${options.token}` },
  });
  return Object.freeze({
    async getLiveOverview(input: PageInput = {}): Promise<OperatorOverviewPage> {
      const query = new URLSearchParams();
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      if (input.cursor !== undefined) query.set('cursor', input.cursor);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      const envelope = await request(
        `/operator/v1/live/overview${suffix}`, operatorLiveOverviewEnvelopeSchema, input.signal,
      );
      return { overview: envelope.data, nextCursor: envelope.meta.nextCursor };
    },
  });
}
