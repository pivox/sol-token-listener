import type { ServerResponse } from 'node:http';
import { encodeStreamCursor, MAX_CURSOR_SEQUENCE } from '../../api/cursor.js';
import { toApiJson, type ApiDomainEvent } from '../../api/contracts.js';
import { ApiEventStreamCursorExpiredError, type ApiEventStreamRepository, type ApiStreamRevision } from '../../ports/api-event-stream-repository.js';
import { stringifyJson } from '../../utils/json.js';

export const MAX_SSE_BATCH_SIZE = 1_000;
export const MAX_SSE_INTERVAL_MS = 86_400_000;
export const MAX_SSE_TERMINAL_DRAIN_MS = 100;

export type SseCloseReason = 'CLIENT' | 'SERVER' | 'ERROR';
export type SseTimer = ReturnType<typeof setTimeout> | number;
export type SseSchedule = (callback: () => void, delayMs: number) => SseTimer;
export type SseCancel = (handle: SseTimer) => void;

export interface SseSessionOptions {
  readonly stream: ApiEventStreamRepository;
  readonly response: ServerResponse;
  readonly startAfter: bigint;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly schedule: SseSchedule;
  readonly cancel: SseCancel;
  readonly onClosed: (session: SseSession) => void;
}

export class SseSession {
  private readonly stream: ApiEventStreamRepository;
  private readonly response: ServerResponse;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly schedule: SseSchedule;
  private readonly cancel: SseCancel;
  private readonly onClosed: (session: SseSession) => void;
  private lastSequence: bigint;
  private pollTimer: SseTimer | null = null;
  private heartbeatTimer: SseTimer | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;
  private started = false;
  private closedNotified = false;
  private closing: Promise<void> | null = null;
  private pendingDrainAbort: (() => void) | null = null;

  public constructor(options: SseSessionOptions) {
    assertOptions(options);
    this.stream = options.stream;
    this.response = options.response;
    this.lastSequence = options.startAfter;
    this.batchSize = options.batchSize;
    this.pollIntervalMs = options.pollIntervalMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.schedule = options.schedule;
    this.cancel = options.cancel;
    this.onClosed = options.onClosed;
  }

  public start(): boolean {
    if (this.started || this.closed) return false;
    if (!this.isWritable()) {
      this.abandon();
      return false;
    }
    this.started = true;
    this.response.on('close', this.onClientClose);
    this.response.on('error', this.onClientClose);
    if (!this.isWritable()) {
      this.abandon();
      return false;
    }
    this.response.writeHead(200, SSE_HEADERS);
    this.response.flushHeaders();
    if (!this.isWritable()) {
      this.abandon();
      return false;
    }
    this.schedulePoll(0);
    this.scheduleHeartbeat();
    return true;
  }

  public close(reason: SseCloseReason): Promise<void> {
    return this.closeWithError(reason, 'DEPENDENCY_UNAVAILABLE');
  }

  private closeWithError(
    reason: SseCloseReason,
    errorCode: 'DEPENDENCY_UNAVAILABLE' | 'EVENT_CURSOR_EXPIRED',
  ): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closed = true;
    this.clearTimers();
    this.response.off('close', this.onClientClose);
    this.response.off('error', this.onClientClose);
    this.interruptPendingDrain();
    this.closing = this.enqueue(async () => {
      if (reason === 'CLIENT') return;
      let terminalDrained = false;
      try {
        terminalDrained = reason === 'SERVER'
          ? await this.writeFrame('event: server_shutdown\ndata: {"apiVersion":"v1"}\n\n', true)
          : await this.writeFrame(errorFrame(errorCode), true);
      } finally {
        this.endResponse();
        if (!terminalDrained) this.destroyResponse();
      }
    }).catch(() => {
      // A peer can disappear while a best-effort terminal frame is queued.
    }).then(() => {
      this.notifyClosed();
    });
    if (reason === 'CLIENT') {
      this.closing = this.closing.then(() => { this.notifyClosed(); });
    }
    return this.closing;
  }

  private readonly onClientClose = (): void => { void this.close('CLIENT'); };

  private schedulePoll(delayMs: number): void {
    if (this.closed) return;
    this.pollTimer = this.schedule(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
  }

  private scheduleHeartbeat(): void {
    if (this.closed) return;
    this.heartbeatTimer = this.schedule(() => {
      this.heartbeatTimer = null;
      void this.heartbeat();
    }, this.heartbeatIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    try {
      const revisions = await this.stream.readAfter(this.lastSequence, this.batchSize);
      if (this.isClosed()) return;
      if (revisions.length > this.batchSize) throw new TypeError('Stream batch exceeds the configured limit');
      assertIncreasingRevisions(revisions, this.lastSequence);
      for (const revision of revisions) {
        await this.enqueue(async () => {
          if (this.closed) return;
          if (await this.writeFrame(eventFrame(revision))) this.lastSequence = revision.sequence;
        });
      }
      if (!this.isClosed()) this.schedulePoll(this.pollIntervalMs);
    } catch (error) {
      if (this.isClosed()) return;
      await this.closeWithError(
        'ERROR',
        error instanceof ApiEventStreamCursorExpiredError ? 'EVENT_CURSOR_EXPIRED' : 'DEPENDENCY_UNAVAILABLE',
      );
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.enqueue(async () => {
        if (!this.closed) await this.writeFrame(': heartbeat\n\n');
      });
      if (!this.closed) this.scheduleHeartbeat();
    } catch {
      if (!this.closed) await this.close('ERROR');
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(operation, operation);
    this.writeTail = next.catch(() => undefined);
    return next;
  }

  private async writeFrame(frame: string, terminal = false): Promise<boolean> {
    if (this.closed && !terminal) return false;
    if (!this.isWritable()) {
      if (terminal) return false;
      throw new Error('SSE response is not writable');
    }
    const accepted = this.response.write(frame);
    if (accepted) return true;
    return this.waitForDrain(terminal);
  }

  private waitForDrain(terminal: boolean): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = (): void => {
        this.response.off('drain', onDrain);
        this.response.off('close', onClosed);
        this.response.off('error', onError);
        if (timeout !== undefined) clearTimeout(timeout);
        if (this.pendingDrainAbort === abort) this.pendingDrainAbort = null;
      };
      const settle = (drained: boolean, error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve(drained); else reject(error);
      };
      const abort = (): void => { settle(false, new Error('SSE drain interrupted')); };
      const onDrain = (): void => { settle(true); };
      const onClosed = (): void => {
        if (terminal) settle(false); else settle(false, new Error('SSE peer closed'));
      };
      const onError = (): void => {
        if (terminal) settle(false); else settle(false, new Error('SSE response failed'));
      };
      this.pendingDrainAbort = abort;
      this.response.once('drain', onDrain);
      this.response.once('close', onClosed);
      this.response.once('error', onError);
      if (terminal) timeout = setTimeout(() => { settle(false); }, MAX_SSE_TERMINAL_DRAIN_MS);
    });
  }

  private clearTimers(): void {
    if (this.pollTimer !== null) this.cancel(this.pollTimer);
    if (this.heartbeatTimer !== null) this.cancel(this.heartbeatTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    try { this.onClosed(this); } catch { /* observer errors cannot revive a session */ }
  }

  private interruptPendingDrain(): void {
    this.pendingDrainAbort?.();
  }

  private abandon(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.response.off('close', this.onClientClose);
    this.response.off('error', this.onClientClose);
    this.interruptPendingDrain();
    this.notifyClosed();
  }

  private isWritable(): boolean { return !this.response.writableEnded && !this.response.destroyed; }

  private endResponse(): void {
    if (!this.response.writableEnded) {
      try { this.response.end(); } catch { /* peer disappeared during terminal cleanup */ }
    }
  }

  private destroyResponse(): void {
    if (this.response.destroyed) return;
    try { this.response.destroy(); } catch { /* terminal cleanup is best effort */ }
  }

  private isClosed(): boolean { return this.closed; }
}

export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'access-control-allow-origin': '*',
});

function assertOptions(options: SseSessionOptions): void {
  if (options.startAfter < 0n || options.startAfter > MAX_CURSOR_SEQUENCE) throw new TypeError('SSE start sequence is invalid');
  assertPositiveBounded(options.batchSize, MAX_SSE_BATCH_SIZE, 'SSE batch size');
  assertPositiveBounded(options.pollIntervalMs, MAX_SSE_INTERVAL_MS, 'SSE poll interval');
  assertPositiveBounded(options.heartbeatIntervalMs, MAX_SSE_INTERVAL_MS, 'SSE heartbeat interval');
}

function assertPositiveBounded(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new TypeError(`${name} is invalid`);
}

function eventFrame(revision: ApiStreamRevision): string {
  if (revision.sequence <= 0n || revision.sequence > MAX_CURSOR_SEQUENCE) throw new TypeError('SSE sequence is invalid');
  assertSafeEventType(revision.event.type);
  const data = stringifyJson(toApiJson(revision.event));
  return `id: ${encodeStreamCursor(revision.sequence)}\nevent: ${revision.event.type}\n${dataLines(data)}\n`;
}

function assertIncreasingRevisions(revisions: readonly ApiStreamRevision[], after: bigint): void {
  let previous = after;
  for (const revision of revisions) {
    if (revision.sequence <= previous) throw new TypeError('Stream revisions must be strictly increasing');
    previous = revision.sequence;
  }
}

function errorFrame(code: 'DEPENDENCY_UNAVAILABLE' | 'EVENT_CURSOR_EXPIRED'): string {
  const data = stringifyJson({ apiVersion: 'v1', error: { code } });
  return `event: stream_error\n${dataLines(data)}\n`;
}

function dataLines(data: string): string {
  return data.split(/\r\n|\r|\n/u).map((line) => `data: ${line}\n`).join('');
}

function assertSafeEventType(type: ApiDomainEvent['type']): void {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(type)) throw new TypeError('SSE event type is invalid');
}
