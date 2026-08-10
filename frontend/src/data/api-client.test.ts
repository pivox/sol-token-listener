// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { MINT, launchSummary, success } from '../../tests/fixtures/api.js';
import {
  ApiContractError,
  ApiHttpError,
  ApiNetworkError,
  createApiClient,
} from './api-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('bounded GET-only API client', () => {
  it('uses explicit GET requests, JSON accept headers, and opaque cursor encoding', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success([launchSummary], 'next')));
    const client = createApiClient({ apiBaseUrl: 'https://api.example/v1/', fetchFn });

    await expect(client.listLaunches({ limit: 25, cursor: 'opaque/+?=' })).resolves.toEqual({
      items: [launchSummary], nextCursor: 'next',
    });

    const [input, init] = fetchFn.mock.calls[0] ?? [];
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).href).toBe('https://api.example/v1/api/v1/launches?limit=25&cursor=opaque%2F%2B%3F%3D');
    expect(init).toMatchObject({ method: 'GET', headers: { Accept: 'application/json' } });
    expect(init).not.toHaveProperty('body');
    expect(init).not.toHaveProperty('credentials', 'include');
  });

  it('encodes launch routes and validates mints before performing I/O', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success({ ...launchSummary, creator: MINT })));
    const client = createApiClient({ apiBaseUrl: 'https://api.example', fetchFn });

    await expect(client.getLaunch('not/a/mint')).rejects.toBeInstanceOf(ApiContractError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('maps stable API failures without exposing response bodies', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      apiVersion: 'v1',
      error: { code: 'INVALID_CURSOR', message: 'The cursor is invalid', correlationId: 'request-a' },
    }, 400));
    const client = createApiClient({ apiBaseUrl: 'https://api.example', fetchFn });

    const error = await client.listLaunches({ cursor: 'bad' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error).toMatchObject({ status: 400, code: 'INVALID_CURSOR', correlationId: 'request-a', retryable: false });
    expect(error).not.toHaveProperty('body');
  });

  it('rejects oversized, malformed, and contract-invalid successful responses', async () => {
    const oversized = createApiClient({
      apiBaseUrl: 'https://api.example',
      maxResponseBytes: 32,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(33))),
    });
    await expect(oversized.getHealth()).rejects.toBeInstanceOf(ApiContractError);

    const malformed = createApiClient({
      apiBaseUrl: 'https://api.example',
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response('{')),
    });
    await expect(malformed.getHealth()).rejects.toBeInstanceOf(ApiContractError);

    const invalid = createApiClient({
      apiBaseUrl: 'https://api.example',
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success({ status: 'GREAT' }))),
    });
    const error = await invalid.getHealth().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiContractError);
    expect(error).toMatchObject({ route: '/api/v1/health' });
    expect((error as ApiContractError).issues.length).toBeLessThanOrEqual(8);
  });

  it('propagates caller aborts and converts timeout aborts to retryable network errors', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const reason = init.signal?.reason;
        reject(reason instanceof Error ? reason : new Error('Request aborted'));
      }, { once: true });
    }));
    const client = createApiClient({ apiBaseUrl: 'https://api.example', fetchFn, timeoutMs: 5 });
    await expect(client.getHealth()).rejects.toMatchObject({ name: 'ApiNetworkError', retryable: true });

    const controller = new AbortController();
    controller.abort(new DOMException('caller stopped', 'AbortError'));
    await expect(client.getHealth({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(ApiNetworkError).toBeDefined();
  });
});
