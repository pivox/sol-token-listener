// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { MINT, sseEvent } from '../../tests/fixtures/api.js';
import type { SseCursorStore } from './sse-cursor-store.js';
import { createSseClient } from './sse-client.js';

function streamResponse(frames: string, status = 200): Response {
  return new Response(frames, {
    status,
    headers: { 'content-type': status === 200 ? 'text/event-stream; charset=utf-8' : 'application/json' },
  });
}

function cursorStore(initial: string | null = null): SseCursorStore & { saved: string[]; cleared: number } {
  let value = initial;
  return {
    storageKey: 'test', saved: [], cleared: 0,
    read: () => value,
    save(cursor): void { value = cursor; this.saved.push(cursor); },
    clear(): void { value = null; this.cleared += 1; },
  };
}

const eventFrame = (id = 'transport-a'): string => `id: ${id}\nevent: QualificationUpdated\ndata: ${JSON.stringify({ ...sseEvent, mint: MINT })}\n\n`;

describe('resumable SSE lifecycle', () => {
  it('sends the saved cursor and commits the transport id only after accepted invalidation', async () => {
    const store = cursorStore('transport-old');
    const accepted: string[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(eventFrame()));
    const client = createSseClient({
      apiBaseUrl: 'https://api.example/gateway', fetchFn, cursorStore: store,
      acceptEvent: async (event) => { accepted.push(event.eventId); },
      resync: async () => undefined,
      schedule: () => 1,
      cancel: () => undefined,
    });
    await client.start();

    expect(fetchFn).toHaveBeenCalledWith(new URL('https://api.example/gateway/api/v1/events'), expect.objectContaining({
      method: 'GET', headers: { Accept: 'text/event-stream', 'Last-Event-ID': 'transport-old' },
    }));
    expect(accepted).toEqual([sseEvent.eventId]);
    expect(store.saved).toEqual(['transport-a']);
    expect(client.getSnapshot()).toMatchObject({ state: 'RECONNECTING', lastEventAt: expect.any(String) });
    client.stop();
  });

  it('does not commit a cursor when validation or invalidation fails', async () => {
    const invalidStore = cursorStore();
    const invalid = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: invalidStore,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(streamResponse('id:x\nevent:QualificationUpdated\ndata:{}\n\n')),
      acceptEvent: async () => undefined, resync: async () => undefined,
      schedule: () => 1, cancel: () => undefined,
    });
    await invalid.start();
    expect(invalidStore.saved).toEqual([]);

    const rejectedStore = cursorStore();
    const rejected = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: rejectedStore,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(streamResponse(eventFrame())),
      acceptEvent: async () => { throw new Error('invalidation failed'); },
      resync: async () => undefined, schedule: () => 1, cancel: () => undefined,
    });
    await rejected.start();
    expect(rejectedStore.saved).toEqual([]);
    invalid.stop(); rejected.stop();
  });

  it('cancels an open response body after a terminal frame error', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('id:x\nevent:QualificationUpdated\ndata:{}\n\n'));
      },
      cancel,
    });
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: cursorStore(),
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      })),
      acceptEvent: async () => undefined, resync: async () => undefined,
      schedule: () => 1, cancel: () => undefined,
    });
    await client.start();
    expect(cancel).toHaveBeenCalledOnce();
    client.stop();
  });

  it('accepts finality revisions sharing a domain id when transport ids differ', async () => {
    const store = cursorStore();
    const acceptEvent = vi.fn(async () => undefined);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(eventFrame('transport-a') + eventFrame('transport-b')));
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', fetchFn, cursorStore: store, acceptEvent,
      resync: async () => undefined, schedule: () => 1, cancel: () => undefined,
    });
    await client.start();
    expect(acceptEvent).toHaveBeenCalledTimes(2);
    expect(store.saved).toEqual(['transport-a', 'transport-b']);
    client.stop();
  });

  it('clears an expired cursor, resynchronizes, and reconnects without the header', async () => {
    const store = cursorStore('expired');
    const resync = vi.fn(async () => undefined);
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse(JSON.stringify({ apiVersion: 'v1', error: { code: 'EVENT_CURSOR_EXPIRED', message: 'expired' } }), 409))
      .mockResolvedValueOnce(streamResponse(''));
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', fetchFn, cursorStore: store, resync,
      acceptEvent: async () => undefined, schedule: () => 1, cancel: () => undefined,
      minimumResyncMs: 0,
    });
    await client.start();
    await Promise.resolve();

    expect(store.cleared).toBe(1);
    expect(resync).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toEqual({ Accept: 'text/event-stream' });
    client.stop();
  });

  it('recovers from a rejected persisted cursor but keeps cursor-free 400 terminal', async () => {
    const store = cursorStore('corrupt');
    const resync = vi.fn(async () => undefined);
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse('{}', 400))
      .mockResolvedValueOnce(streamResponse(''));
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: store, fetchFn, resync,
      acceptEvent: async () => undefined, schedule: () => 1, cancel: () => undefined,
      minimumResyncMs: 0,
    });
    await client.start();
    await vi.waitFor(() => { expect(fetchFn).toHaveBeenCalledTimes(2); });
    expect(store.cleared).toBe(1);
    expect(resync).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toEqual({ Accept: 'text/event-stream' });
    client.stop();

    const terminal = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: cursorStore(),
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(streamResponse('{}', 400)),
      acceptEvent: async () => undefined, resync: async () => undefined,
      schedule: () => 1, cancel: () => undefined,
    });
    await terminal.start();
    expect(terminal.getSnapshot()).toMatchObject({ state: 'DISCONNECTED', errorCode: 'HTTP_400' });
    terminal.stop();
  });

  it('handles a post-header cursor-expiry terminal frame', async () => {
    const store = cursorStore('expired');
    const resync = vi.fn(async () => undefined);
    const expiryFrame = 'event: stream_error\ndata: {"apiVersion":"v1","error":{"code":"EVENT_CURSOR_EXPIRED"}}\n\n';
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse(expiryFrame))
      .mockResolvedValueOnce(streamResponse(''));
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', fetchFn, cursorStore: store, resync,
      acceptEvent: async () => undefined, schedule: () => 1, cancel: () => undefined,
      minimumResyncMs: 0,
    });
    await client.start();
    expect(store.cleared).toBe(1);
    expect(resync).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toEqual({ Accept: 'text/event-stream' });
    client.stop();
  });

  it('keeps resynchronization single-flight when connectivity changes', async () => {
    let finishResync: (() => void) | undefined;
    const resync = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { finishResync = resolve; });
      })
      .mockResolvedValueOnce(undefined);
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse('{}', 409))
      .mockResolvedValueOnce(streamResponse(''));
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: cursorStore('expired'), fetchFn, resync,
      acceptEvent: async () => undefined, schedule: () => 1, cancel: () => undefined,
      minimumResyncMs: 0,
    });
    const started = client.start();
    await vi.waitFor(() => { expect(resync).toHaveBeenCalledOnce(); });
    client.setOnline(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    finishResync?.();
    await started;
    await vi.waitFor(() => { expect(fetchFn).toHaveBeenCalledTimes(2); });
    await vi.waitFor(() => { expect(resync).toHaveBeenCalledTimes(2); });
    client.stop();
  });

  it('retries a failed HTTP resync before opening a cursorless stream', async () => {
    const scheduled: (() => void)[] = [];
    const resync = vi.fn()
      .mockRejectedValueOnce(new Error('refetch failed'))
      .mockResolvedValue(undefined);
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse('{}', 409))
      .mockResolvedValueOnce(streamResponse(''));
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: cursorStore('expired'), fetchFn, resync,
      acceptEvent: async () => undefined,
      schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
      cancel: () => undefined, minimumResyncMs: 0,
    });
    await client.start();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(client.getSnapshot()).toMatchObject({ state: 'RESYNCING', errorCode: 'RESYNC_FAILED' });
    scheduled[0]?.();
    await vi.waitFor(() => { expect(fetchFn).toHaveBeenCalledTimes(2); });
    await vi.waitFor(() => { expect(resync).toHaveBeenCalledTimes(3); });
    client.stop();
  });

  it('retries the initial resync after an offline interval instead of skipping to high-water', async () => {
    const resync = vi.fn()
      .mockRejectedValueOnce(new Error('refetch failed'))
      .mockResolvedValue(undefined);
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse('{}', 409))
      .mockResolvedValueOnce(streamResponse(''));
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: cursorStore('expired'), fetchFn, resync,
      acceptEvent: async () => undefined, schedule: () => 1, cancel: () => undefined,
      minimumResyncMs: 0,
    });
    await client.start();
    client.setOnline(false);
    client.setOnline(true);
    await vi.waitFor(() => { expect(resync).toHaveBeenCalledTimes(3); });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it('performs the closing HTTP refresh after the cursorless stream baseline', async () => {
    const order: string[] = [];
    const fetchFn = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => { order.push('fetch-expired'); return streamResponse('{}', 409); })
      .mockImplementationOnce(async () => { order.push('fetch-baseline'); return streamResponse(eventFrame()); });
    const resync = vi.fn(async () => { order.push('resync'); });
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: cursorStore('expired'), fetchFn, resync,
      acceptEvent: async () => { order.push('accept-event'); },
      schedule: () => 1, cancel: () => undefined, minimumResyncMs: 0,
    });
    await client.start();
    await vi.waitFor(() => { expect(order).toContain('accept-event'); });
    expect(order).toEqual(['fetch-expired', 'resync', 'fetch-baseline', 'resync', 'accept-event']);
    client.stop();
  });

  it('does not let an aborted connection regress the saved cursor', async () => {
    let releaseFirst: (() => void) | undefined;
    const acceptEvent = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      })
      .mockResolvedValueOnce(undefined);
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse(eventFrame('transport-old')))
      .mockResolvedValueOnce(streamResponse(eventFrame('transport-new')));
    const store = cursorStore();
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: store, fetchFn, acceptEvent,
      resync: async () => undefined, schedule: () => 1, cancel: () => undefined,
    });
    const first = client.start();
    await vi.waitFor(() => { expect(acceptEvent).toHaveBeenCalledOnce(); });
    client.reconnectNow();
    await vi.waitFor(() => { expect(store.saved).toEqual(['transport-new']); });
    releaseFirst?.();
    await first;
    expect(store.saved).toEqual(['transport-new']);
    client.stop();
  });

  it('stops on deterministic HTTP errors and backs off on transient failures', async () => {
    const scheduled: (() => void)[] = [];
    const terminal = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: cursorStore(),
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(streamResponse('{}', 406)),
      acceptEvent: async () => undefined, resync: async () => undefined,
      schedule: (callback) => { scheduled.push(callback); return scheduled.length; }, cancel: () => undefined,
    });
    await terminal.start();
    expect(terminal.getSnapshot()).toMatchObject({ state: 'DISCONNECTED', errorCode: 'HTTP_406' });
    expect(scheduled).toHaveLength(0);

    const transient = createSseClient({
      apiBaseUrl: 'https://api.example', cursorStore: cursorStore(),
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(streamResponse('{}', 503)),
      acceptEvent: async () => undefined, resync: async () => undefined,
      schedule: (callback, delay) => { scheduled.push(callback); expect(delay).toBeGreaterThanOrEqual(250); return scheduled.length; },
      cancel: () => undefined, random: () => 0,
    });
    await transient.start();
    expect(transient.getSnapshot()).toMatchObject({ state: 'RECONNECTING', retryAttempt: 1, errorCode: 'HTTP_503' });
    terminal.stop(); transient.stop();
  });

  it('aborts active reads and becomes immutable after stop', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('stopped', 'AbortError')); }, { once: true });
      });
    });
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', fetchFn, cursorStore: cursorStore(),
      acceptEvent: async () => undefined, resync: async () => undefined,
    });
    const started = client.start();
    await Promise.resolve();
    client.stop();
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(client.getSnapshot().state).toBe('STOPPED');
    await started;
  });

  it('pauses while offline and reconnects when connectivity returns', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(''));
    const client = createSseClient({
      apiBaseUrl: 'https://api.example', fetchFn, cursorStore: cursorStore(),
      acceptEvent: async () => undefined, resync: async () => undefined,
      isOnline: () => false, schedule: () => 1, cancel: () => undefined,
    });
    await client.start();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(client.getSnapshot()).toMatchObject({ state: 'DISCONNECTED', errorCode: 'OFFLINE' });
    client.setOnline(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledOnce();
    client.stop();
  });
});
