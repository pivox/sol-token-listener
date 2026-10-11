export interface BoundedFetchOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

type Failure = 'RPC request timed out' | 'RPC request aborted' | 'RPC request failed'
  | 'RPC response exceeds size limit' | 'RPC redirect is not allowed' | 'RPC invalid response length';

/** Only fixed messages created here may escape; provider errors may contain RPC credentials. */
class BoundedFetchError extends Error {
  constructor(message: Failure) { super(message); this.name = 'BoundedFetchError'; }
}

function cancelBody(response: Response): void {
  if (response.body) void response.body.cancel().catch(() => undefined);
}

/**
 * Buffers the complete response under one deadline before resolving. In particular,
 * a successful fetch of headers does not release the deadline for a stalled body.
 * Suitable for the `fetch` option of @solana/web3.js Connection.
 */
export function createBoundedFetch(options: BoundedFetchOptions = {}): typeof globalThis.fetch {
  const implementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs >= 2 ** 31) throw new Error('Invalid bounded fetch timeout');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new Error('Invalid bounded fetch response limit');

  return async (input, init): Promise<Response> => {
    const signals = [init?.signal, input instanceof Request ? input.signal : undefined]
      .filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
    if (signals.some((signal) => signal.aborted)) throw new BoundedFetchError('RPC request aborted');

    const controller = new AbortController();
    const state: { failure: Failure | null } = { failure: null };
    let rejectAborted: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = (): void => { reject(new BoundedFetchError(state.failure ?? 'RPC request aborted')); };
      controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });
    const abortCaller = (): void => {
      state.failure ??= 'RPC request aborted';
      controller.abort();
    };
    for (const signal of signals) signal.addEventListener('abort', abortCaller, { once: true });
    const timer = setTimeout(() => {
      state.failure ??= 'RPC request timed out';
      controller.abort();
    }, timeoutMs);

    try {
      const receive = (async (): Promise<Response> => {
        const response = await implementation(input, { ...init, redirect: 'error', signal: controller.signal });
        if (controller.signal.aborted) {
          cancelBody(response);
          throw new BoundedFetchError(state.failure ?? 'RPC request aborted');
        }
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          cancelBody(response);
          throw new BoundedFetchError('RPC redirect is not allowed');
        }
        const declaredLength = response.headers.get('content-length');
        if (declaredLength !== null) {
          if (!/^[0-9]+$/.test(declaredLength)) {
            cancelBody(response);
            throw new BoundedFetchError('RPC invalid response length');
          }
          if (Number(declaredLength) > maxResponseBytes) {
            cancelBody(response);
            throw new BoundedFetchError('RPC response exceeds size limit');
          }
        }

        const chunks: Uint8Array[] = [];
        let length = 0;
        if (response.body) {
          const reader = response.body.getReader();
          const cancelReader = (): void => { void reader.cancel().catch(() => undefined); };
          controller.signal.addEventListener('abort', cancelReader, { once: true });
          try {
            let next = await reader.read();
            while (!next.done) {
              const value: unknown = next.value;
              if (!(value instanceof Uint8Array)) throw new BoundedFetchError('RPC request failed');
              length += value.byteLength;
              if (length > maxResponseBytes) throw new BoundedFetchError('RPC response exceeds size limit');
              chunks.push(value);
              next = await reader.read();
            }
          } catch (error) {
            cancelReader();
            throw error;
          } finally {
            controller.signal.removeEventListener('abort', cancelReader);
            reader.releaseLock();
          }
        }
        if (state.failure !== null) throw new BoundedFetchError(state.failure);
        const headers = new Headers(response.headers);
        // Native fetch already decompresses its body; preserve accurate metadata
        // for the new, fully buffered Response instead of the compressed wire size.
        headers.delete('content-encoding');
        headers.set('content-length', length.toString());
        return new Response(response.body === null ? null : Buffer.concat(chunks, length), {
          status: response.status, statusText: response.statusText, headers,
        });
      })();
      return await Promise.race([receive, aborted]);
    } catch (error) {
      controller.abort();
      if (state.failure !== null) throw new BoundedFetchError(state.failure);
      if (error instanceof BoundedFetchError) throw error;
      throw new BoundedFetchError('RPC request failed');
    } finally {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', abortCaller);
      if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted);
    }
  };
}
