const HELIUS_ADMIN_ORIGIN = 'https://admin-api.helius.xyz';
const MAX_RESPONSE_BYTES = 65_536;

export class HeliusProviderTransportError extends Error {
  public readonly code = 'HELIUS_PROVIDER_TRANSPORT_FAILED' as const;
  public constructor() {
    super('Helius provider usage request failed.');
    this.name = 'HeliusProviderTransportError';
  }
}

export class HeliusAdminUsageClient {
  public constructor(
    private readonly timeoutMs: number,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public async getProjectUsage(
    projectId: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100
        || this.timeoutMs > 30_000 || signal.aborted
        || !/^[0-9a-f-]{36}$/u.test(projectId)
        || apiKey.length === 0 || apiKey.length > 512 || /\s/u.test(apiKey)) throw new TypeError();
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
      const response = await this.fetchImplementation(
        `${HELIUS_ADMIN_ORIGIN}/v0/admin/projects/${projectId}/usage`,
        Object.freeze({
          method: 'GET',
          headers: Object.freeze({ accept: 'application/json', 'x-api-key': apiKey }),
          redirect: 'error' as const,
          signal: requestSignal,
        }),
      );
      if (response.status !== 200
        || response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
        await response.body?.cancel();
        throw new TypeError();
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)
        || Number(contentLength) > MAX_RESPONSE_BYTES)) {
        await response.body?.cancel();
        throw new TypeError();
      }
      const bytes = await readBoundedBody(response);
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new HeliusProviderTransportError();
    }
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new TypeError();
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read() as Readonly<{
        done: boolean;
        value?: Uint8Array;
      }>;
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) throw new TypeError();
      length += chunk.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TypeError();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
