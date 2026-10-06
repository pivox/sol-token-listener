// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { liveOverview, success } from '../../tests/fixtures/api.js';
import { ApiContractError, ApiHttpError } from './api-client.js';
import { createOperatorClient } from './operator-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('operator client', () => {
  it('sends the bearer token on a GET and returns the overview with its cursor', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success(liveOverview, 'next')));
    const client = createOperatorClient({
      operatorApiBaseUrl: 'http://127.0.0.1:3100', token: 'secret-token', fetchFn,
    });

    const page = await client.getLiveOverview({ limit: 50, cursor: 'opaque/+=' });

    expect(page.nextCursor).toBe('next');
    expect(page.overview.history[0]?.realizedLamports).toBe('-4205');
    const [input, init] = fetchFn.mock.calls[0] ?? [];
    expect((input as URL).href).toBe('http://127.0.0.1:3100/operator/v1/live/overview?limit=50&cursor=opaque%2F%2B%3D');
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer secret-token' },
    });
    expect(init).not.toHaveProperty('body');
  });

  it('maps a 401 to an HTTP error carrying the status and never exposes the token', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      apiVersion: 'v1', error: { code: 'UNAUTHORIZED', message: 'A valid operator token is required' },
    }, 401));
    const client = createOperatorClient({
      operatorApiBaseUrl: 'http://127.0.0.1:3100', token: 'secret-token', fetchFn,
    });

    const error = await client.getLiveOverview().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED', retryable: false });
    expect(JSON.stringify(error)).not.toContain('secret-token');
  });

  it('rejects an overview whose amounts are not decimal strings', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success({
      ...liveOverview, totals: { ...liveOverview.totals, realizedLamports: -4205 },
    })));
    const client = createOperatorClient({
      operatorApiBaseUrl: 'http://127.0.0.1:3100', token: 'secret-token', fetchFn,
    });

    await expect(client.getLiveOverview()).rejects.toBeInstanceOf(ApiContractError);
  });

  it('accepts an overview without an active wallet', async () => {
    const empty = {
      availability: 'NOT_AVAILABLE', wallet: null, balance: null, open: [], history: [],
      totals: { realizedLamports: '0', unrealizedLamports: '0', openCount: 0, positionsWithoutPnl: 0 },
    };
    const client = createOperatorClient({
      operatorApiBaseUrl: 'http://127.0.0.1:3100', token: 'secret-token',
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(success(empty))),
    });

    expect((await client.getLiveOverview()).overview.availability).toBe('NOT_AVAILABLE');
  });
});
