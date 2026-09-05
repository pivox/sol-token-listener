import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HeliusAdminUsageClient,
  HeliusProviderTransportError,
} from '../src/provider-evidence/helius-admin-client.js';

const PROJECT_ID = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';

void test('performs one authenticated non-redirecting Admin API request', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const client = new HeliusAdminUsageClient(1_000, async (url, init) => {
    if (typeof url !== 'string') throw new TypeError('Expected string URL.');
    calls.push({ url, init });
    return response('{}');
  });
  assert.deepEqual(await client.getProjectUsage(PROJECT_ID, 'secret-api-key',
    new AbortController().signal), {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url,
    `https://admin-api.helius.xyz/v0/admin/projects/${PROJECT_ID}/usage`);
  assert.equal(new Headers(calls[0]?.init?.headers).get('x-api-key'), 'secret-api-key');
  assert.equal(calls[0]?.init?.redirect, 'error');
});

void test('rejects 429, non-json, invalid JSON and oversized streamed bodies', async () => {
  for (const fetchMock of [
    async (): Promise<Response> => new Response('{}', { status: 429,
      headers: { 'content-type': 'application/json' } }),
    async (): Promise<Response> => new Response('{}', { status: 200,
      headers: { 'content-type': 'text/plain' } }),
    async (): Promise<Response> => response('{'),
  ]) {
    const client = new HeliusAdminUsageClient(1_000, fetchMock);
    await assert.rejects(client.getProjectUsage(PROJECT_ID, 'secret',
      new AbortController().signal), HeliusProviderTransportError);
  }

  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(40_000));
      controller.enqueue(new Uint8Array(40_000));
    },
    cancel() { cancelled = true; },
  });
  const oversized = new HeliusAdminUsageClient(1_000, async () => new Response(body, {
    headers: { 'content-type': 'application/json' },
  }));
  await assert.rejects(oversized.getProjectUsage(PROJECT_ID, 'secret',
    new AbortController().signal), HeliusProviderTransportError);
  assert.equal(cancelled, true);
});

function response(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}
