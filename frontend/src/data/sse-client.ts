import { z } from 'zod';
import { apiSseEventSchema } from './api-schemas.js';
import type { ApiSseEvent } from './api-schemas.js';
import type { SseCursorStore } from './sse-cursor-store.js';
import { SseParser } from './sse-parser.js';

const MAXIMUM_RETRY_DELAY_MS = 30_000;
const DEFAULT_MINIMUM_RESYNC_MS = 250;

const streamErrorSchema = z.object({
  apiVersion: z.literal('v1'),
  error: z.object({
    code: z.enum(['DEPENDENCY_UNAVAILABLE', 'EVENT_CURSOR_EXPIRED']),
  }).loose(),
}).loose();

export type RealtimeState =
  | 'CONNECTING'
  | 'LIVE'
  | 'RECONNECTING'
  | 'RESYNCING'
  | 'DISCONNECTED'
  | 'STOPPED';

export interface RealtimeSnapshot {
  readonly state: RealtimeState;
  readonly lastEventAt: string | null;
  readonly retryAttempt: number;
  readonly errorCode: string | null;
}

export interface SseClient {
  start(): Promise<void>;
  stop(): void;
  getSnapshot(): RealtimeSnapshot;
  subscribe(listener: () => void): () => void;
  reconnectNow(): void;
  setOnline(online: boolean): void;
}

export interface SseClientOptions {
  readonly apiBaseUrl: string;
  readonly cursorStore: SseCursorStore;
  readonly acceptEvent: (event: ApiSseEvent) => Promise<void>;
  readonly resync: () => Promise<void>;
  readonly fetchFn?: typeof fetch;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancel?: (timer: unknown) => void;
  readonly random?: () => number;
  readonly now?: () => Date;
  readonly isOnline?: () => boolean;
  readonly minimumResyncMs?: number;
}

export function createSseClient(options: SseClientOptions): SseClient {
  const fetchFn = options.fetchFn ?? fetch;
  const schedule: NonNullable<SseClientOptions['schedule']> = options.schedule
    ?? ((callback, delayMs): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs));
  const cancel: NonNullable<SseClientOptions['cancel']> = options.cancel
    ?? ((timer): void => { clearTimeout(timer as ReturnType<typeof setTimeout>); });
  const random: NonNullable<SseClientOptions['random']> = options.random ?? Math.random;
  const now: NonNullable<SseClientOptions['now']> = options.now ?? ((): Date => new Date());
  const isOnline: NonNullable<SseClientOptions['isOnline']> = options.isOnline ?? ((): boolean => true);
  const minimumResyncMs = options.minimumResyncMs ?? DEFAULT_MINIMUM_RESYNC_MS;
  const listeners = new Set<() => void>();
  let snapshot: RealtimeSnapshot = Object.freeze({
    state: 'STOPPED', lastEventAt: null, retryAttempt: 0, errorCode: null,
  });
  let stopped = true;
  let activeController: AbortController | null = null;
  let retryTimer: unknown;
  let onlineOverride: boolean | null = null;

  const online = (): boolean => onlineOverride ?? isOnline();
  const isStopped = (): boolean => stopped;

  function publish(update: Partial<RealtimeSnapshot>): void {
    if (stopped && update.state !== 'STOPPED') return;
    snapshot = Object.freeze({ ...snapshot, ...update });
    for (const listener of listeners) listener();
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    if (!online()) {
      publish({ state: 'DISCONNECTED', errorCode: 'OFFLINE' });
      return;
    }
    const controller = new AbortController();
    activeController = controller;
    const cursor = options.cursorStore.read();
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (cursor !== null) headers['Last-Event-ID'] = cursor;
    let response: Response;
    try {
      response = await fetchFn(new URL('/api/v1/events', options.apiBaseUrl), {
        method: 'GET', headers, signal: controller.signal,
      });
    } catch {
      if (isStopped() || isAborted(controller)) return;
      scheduleReconnect('NETWORK_ERROR');
      return;
    }
    if (isStopped()) return;
    if (response.status === 409) {
      await resynchronize();
      return;
    }
    if (response.status === 400 || response.status === 406) {
      publish({ state: 'DISCONNECTED', errorCode: `HTTP_${String(response.status)}` });
      return;
    }
    if (!response.ok) {
      scheduleReconnect(`HTTP_${String(response.status)}`);
      return;
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      publish({ state: 'DISCONNECTED', errorCode: 'INVALID_CONTENT_TYPE' });
      return;
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
      scheduleReconnect('EMPTY_STREAM');
      return;
    }
    publish({ state: 'LIVE', retryAttempt: 0, errorCode: null });
    const parser = new SseParser();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const frame of parser.push(chunk.value)) {
          const shouldContinue = await acceptFrame(frame.id, frame.event, frame.data);
          if (!shouldContinue) return;
        }
      }
      parser.finish();
    } catch {
      if (isStopped() || isAborted(controller)) return;
      scheduleReconnect('STREAM_INVALID');
      return;
    } finally {
      reader.releaseLock();
    }
    if (!isStopped()) scheduleReconnect('STREAM_ENDED');
  }

  async function acceptFrame(id: string, eventName: string, data: string): Promise<boolean> {
    if (eventName === 'stream_error') {
      let decoded: unknown;
      try {
        decoded = JSON.parse(data) as unknown;
      } catch {
        scheduleReconnect('STREAM_ERROR_INVALID');
        return false;
      }
      const error = streamErrorSchema.safeParse(decoded);
      if (!error.success) {
        scheduleReconnect('STREAM_ERROR_INVALID');
        return false;
      }
      if (error.data.error.code === 'EVENT_CURSOR_EXPIRED') await resynchronize();
      else scheduleReconnect(error.data.error.code);
      return false;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(data) as unknown;
    } catch {
      scheduleReconnect('EVENT_JSON_INVALID');
      return false;
    }
    const parsed = apiSseEventSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.type !== eventName || id === '') {
      scheduleReconnect('EVENT_CONTRACT_INVALID');
      return false;
    }
    try {
      await options.acceptEvent(parsed.data);
    } catch {
      scheduleReconnect('INVALIDATION_FAILED');
      return false;
    }
    if (isStopped()) return false;
    options.cursorStore.save(id);
    publish({ lastEventAt: now().toISOString(), errorCode: null });
    return true;
  }

  async function resynchronize(): Promise<void> {
    if (isStopped()) return;
    const startedAt = Date.now();
    publish({ state: 'RESYNCING', errorCode: 'EVENT_CURSOR_EXPIRED' });
    options.cursorStore.clear();
    try {
      await options.resync();
    } catch {
      scheduleReconnect('RESYNC_FAILED');
      return;
    }
    const remaining = minimumResyncMs - (Date.now() - startedAt);
    if (remaining > 0) await wait(remaining);
    if (isStopped()) return;
    publish({ state: 'CONNECTING', retryAttempt: 0, errorCode: null });
    await connect();
  }

  function scheduleReconnect(errorCode: string): void {
    if (stopped || retryTimer !== undefined) return;
    if (!online()) {
      publish({ state: 'DISCONNECTED', errorCode: 'OFFLINE' });
      return;
    }
    const attempt = snapshot.retryAttempt + 1;
    const baseDelay = Math.min(500 * 2 ** (attempt - 1), MAXIMUM_RETRY_DELAY_MS);
    const delay = Math.round(baseDelay * (0.5 + random()));
    publish({ state: 'RECONNECTING', retryAttempt: attempt, errorCode });
    retryTimer = schedule(() => {
      retryTimer = undefined;
      if (stopped) return;
      void connect();
    }, delay);
  }

  const client: SseClient = {
    async start(): Promise<void> {
      if (!stopped) return;
      stopped = false;
      publish({ state: 'CONNECTING', retryAttempt: 0, errorCode: null });
      await connect();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      activeController?.abort();
      activeController = null;
      if (retryTimer !== undefined) cancel(retryTimer);
      retryTimer = undefined;
      publish({ state: 'STOPPED', retryAttempt: 0, errorCode: null });
    },
    getSnapshot(): RealtimeSnapshot { return snapshot; },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    },
    reconnectNow(): void {
      if (stopped || !online()) return;
      if (retryTimer !== undefined) cancel(retryTimer);
      retryTimer = undefined;
      activeController?.abort();
      publish({ state: 'CONNECTING', retryAttempt: 0, errorCode: null });
      void connect();
    },
    setOnline(isNowOnline: boolean): void {
      onlineOverride = isNowOnline;
      if (stopped) return;
      if (!isNowOnline) {
        activeController?.abort();
        if (retryTimer !== undefined) cancel(retryTimer);
        retryTimer = undefined;
        publish({ state: 'DISCONNECTED', errorCode: 'OFFLINE' });
        return;
      }
      this.reconnectNow();
    },
  };
  return Object.freeze(client);
}

function isAborted(controller: AbortController): boolean {
  return controller.signal.aborted;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });
}
