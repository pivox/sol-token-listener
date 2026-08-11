// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { RuntimeConfigError, loadRuntimeConfig } from './runtime-config.js';

function response(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers });
}

describe('loadRuntimeConfig', () => {
  it('loads and normalizes an absolute public HTTP API URL', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({
      apiBaseUrl: 'https://api.example.test/base/',
    })));

    await expect(loadRuntimeConfig(fetchFn)).resolves.toEqual({
      apiBaseUrl: 'https://api.example.test/base',
    });
    expect(fetchFn).toHaveBeenCalledWith('/config.json', expect.objectContaining({
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    }));
  });

  it.each([
    ['relative URL', '/api'],
    ['credentials', 'https://user:password@api.example.test'],
    ['query', 'https://api.example.test?secret=value'],
    ['fragment', 'https://api.example.test/#fragment'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/plain,unsafe'],
    ['surrounding whitespace', ' https://api.example.test'],
  ])('rejects %s before returning configuration', async (_label, apiBaseUrl) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({ apiBaseUrl })));

    await expect(loadRuntimeConfig(fetchFn)).rejects.toMatchObject({
      name: 'RuntimeConfigError',
      code: 'CONFIG_INVALID',
    });
  });

  it('rejects additive config fields so secrets cannot be silently ignored', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({
      apiBaseUrl: 'https://api.example.test',
      privateKey: 'must-not-be-accepted',
    })));

    await expect(loadRuntimeConfig(fetchFn)).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it('rejects failed, malformed, and oversized responses with stable codes', async () => {
    const failed = vi.fn<typeof fetch>().mockResolvedValue(response('unavailable', 503));
    await expect(loadRuntimeConfig(failed)).rejects.toMatchObject({ code: 'CONFIG_UNAVAILABLE' });

    const malformed = vi.fn<typeof fetch>().mockResolvedValue(response('{'));
    await expect(loadRuntimeConfig(malformed)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    const oversized = vi.fn<typeof fetch>().mockResolvedValue(response(
      JSON.stringify({ apiBaseUrl: `https://api.example.test/${'a'.repeat(9_000)}` }),
      200,
      { 'content-length': '9050' },
    ));
    await expect(loadRuntimeConfig(oversized)).rejects.toMatchObject({ code: 'CONFIG_TOO_LARGE' });
  });

  it('propagates caller cancellation as a stable unavailable result', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(controller.signal.reason);

    await expect(loadRuntimeConfig(fetchFn, controller.signal)).rejects.toMatchObject({
      code: 'CONFIG_UNAVAILABLE',
    });
  });
});
