import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiRouter, type ApiRouter } from './api-router.js';
import { SseSession, type SseSessionOptions } from './sse-session.js';
import type { ApiEventStreamRepository } from '../../ports/api-event-stream-repository.js';
import type { ApiProjectionRepository } from '../../ports/api-projection-repository.js';

const DEFAULT_SSE_BATCH_SIZE = 100;

export interface ApiServerLogContext {
  readonly event: 'api.request_failed';
  readonly route: string;
  readonly method: string;
  readonly correlationId: string;
  readonly errorName: string;
}

export interface ApiServerOptions {
  readonly host: string;
  readonly port: number;
  readonly projections: ApiProjectionRepository;
  readonly stream: ApiEventStreamRepository;
  readonly now?: () => number;
  readonly defaultLimit?: number;
  readonly maximumLimit?: number;
  readonly sseBatchSize?: number;
  readonly ssePollMs?: number;
  readonly sseHeartbeatMs?: number;
  readonly correlationId?: () => string;
  readonly logError?: (context: ApiServerLogContext) => void;
  readonly createServer?: (handler: (request: IncomingMessage, response: ServerResponse) => void) => Server;
  readonly createRouter?: (options: Parameters<typeof createApiRouter>[0]) => ApiRouter;
  readonly createSseSession?: (options: SseSessionOptions) => SseSession;
}

export interface ApiListeningAddress {
  readonly host: string;
  readonly port: number;
}

export class ApiServer {
  private readonly server: Server;
  private readonly router: ApiRouter;
  private readonly sessions = new Set<SseSession>();
  private readonly host: string;
  private readonly port: number;
  private readonly logError: ((context: ApiServerLogContext) => void) | undefined;
  private listenCalled = false;
  private listenPromise: Promise<ApiListeningAddress> | null = null;
  private closePromise: Promise<void> | null = null;
  private closing = false;

  public constructor(options: ApiServerOptions) {
    assertOptions(options);
    this.host = options.host;
    this.port = options.port;
    this.logError = options.logError;
    const createSession = options.createSseSession ?? ((sessionOptions: SseSessionOptions): SseSession => new SseSession(sessionOptions));
    const routerFactory = options.createRouter ?? createApiRouter;
    this.router = routerFactory({
      projections: options.projections,
      stream: options.stream,
      now: options.now ?? Date.now,
      defaultLimit: options.defaultLimit ?? 50,
      maximumLimit: options.maximumLimit ?? 200,
      correlationId: options.correlationId ?? defaultCorrelationId,
      logError: (context, error) => {
        safeLog(options.logError, {
          event: 'api.request_failed', ...context, errorName: errorName(error),
        });
      },
      sse: {
        batchSize: options.sseBatchSize ?? DEFAULT_SSE_BATCH_SIZE,
        pollIntervalMs: options.ssePollMs ?? 1_000,
        heartbeatIntervalMs: options.sseHeartbeatMs ?? 15_000,
        createSession: (sessionOptions) => {
          if (this.closing) {
            endFailedResponse(sessionOptions.response);
            return new SseSession({ ...sessionOptions, onClosed: (): void => undefined });
          }
          const session = createSession({
            ...sessionOptions,
            onClosed: (closed) => { this.sessions.delete(closed); },
          });
          this.sessions.add(session);
          return session;
        },
      },
    });
    const createNodeServer = options.createServer ?? createServer;
    this.server = createNodeServer(this.handleRequest);
  }

  public get activeSessionCount(): number { return this.sessions.size; }

  public listen(): Promise<ApiListeningAddress> {
    if (this.closePromise !== null) return Promise.reject(new Error('API server has been closed.'));
    if (this.listenCalled) return Promise.reject(new Error('API server is already listening.'));
    this.listenCalled = true;
    const listening = new Promise<ApiListeningAddress>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('API server did not expose a TCP listening address.'));
          return;
        }
        const tcpAddress: AddressInfo = address;
        resolve({ host: tcpAddress.address, port: tcpAddress.port });
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    this.listenPromise = listening;
    return listening;
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    if (!this.server.listening && this.listenPromise !== null) {
      try { await this.listenPromise; } catch { return; }
    }
    if (!this.server.listening) return;
    const stoppedAccepting = new Promise<void>((resolve, reject) => {
      this.server.close((error) => { if (error === undefined) resolve(); else reject(error); });
    });
    const closeSessions = Promise.all([...this.sessions].map(async (session) => session.close('SERVER')));
    this.server.closeIdleConnections();
    await closeSessions;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    this.server.closeIdleConnections();
    await stoppedAccepting;
  }

  private readonly handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    void Promise.resolve().then(() => {
      if (this.closing) {
        endFailedResponse(response);
        return undefined;
      }
      return this.router(request, response);
    }).catch((error: unknown) => {
      safeLog(this.logError, {
        event: 'api.request_failed', route: 'unknown', method: safeMethod(request.method),
        correlationId: 'unavailable', errorName: errorName(error),
      });
      endFailedResponse(response);
    });
  };
}

function assertOptions(options: ApiServerOptions): void {
  if (options.host.length === 0 || !Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new TypeError('API server host and port are invalid.');
  }
}

function defaultCorrelationId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_.-]{1,128}$/u.test(error.name) ? error.name : 'UnknownError';
}

function safeMethod(method: string | undefined): string {
  return method !== undefined && /^[A-Z]+$/u.test(method) ? method : 'UNKNOWN';
}

function safeLog(logError: ((context: ApiServerLogContext) => void) | undefined, context: ApiServerLogContext): void {
  try { logError?.(context); } catch { /* diagnostics cannot interrupt cleanup */ }
}

function endFailedResponse(response: ServerResponse): void {
  if (response.writableEnded || response.destroyed) return;
  try { response.end(); } catch { try { response.destroy(); } catch { /* peer has already gone away */ } }
}
