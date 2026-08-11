import { describe, expect, it } from 'vitest';
import { rejectNonReadOnlyApiMethod } from './vite-read-only-api-proxy.js';

class RecordingResponse {
  public statusCode = 200;
  public readonly headers = new Map<string, string>();
  public endCalls = 0;

  public setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  public end(): void {
    this.endCalls += 1;
  }
}

describe('rejectNonReadOnlyApiMethod', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('allows %s without touching the response', (method) => {
    const response = new RecordingResponse();

    expect(rejectNonReadOnlyApiMethod({ method }, response)).toBe(false);
    expect(response).toEqual(new RecordingResponse());
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'get', '', undefined])(
    'rejects %s locally with the exact read-only contract',
    (method) => {
      const response = new RecordingResponse();

      expect(rejectNonReadOnlyApiMethod({ method }, response)).toBe(true);
      expect(response.statusCode).toBe(405);
      expect(response.headers).toEqual(new Map([['Allow', 'GET, HEAD, OPTIONS']]));
      expect(response.endCalls).toBe(1);
    },
  );
});
