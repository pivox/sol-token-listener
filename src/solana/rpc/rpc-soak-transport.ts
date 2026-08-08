import type { Commitment } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '../../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../../markets/pumpswap/constants.js';
import {
  RpcSoakSubscriptionError,
  RpcSoakTransportError,
  type RpcSoakObservation,
  type RpcSoakSubscription,
  type RpcSoakTransport,
} from './rpc-soak.js';

export interface RpcSoakFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type RpcSoakFetch = (input: string, init: RequestInit) => Promise<RpcSoakFetchResponse>;

export interface RpcSoakWebSocket {
  readonly readyState: number;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void;
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RpcSoakWebSocketFactory = (url: string) => RpcSoakWebSocket;

export interface SolanaRpcSoakTransportOptions {
  readonly httpRpcUrl: string;
  readonly websocketUrl: string;
  readonly commitment: Commitment;
  readonly fetch?: RpcSoakFetch;
  readonly createWebSocket?: RpcSoakWebSocketFactory;
}

export class RpcSoakWebsocketError extends RpcSoakSubscriptionError {
  public constructor(public readonly stage: 'subscribe' | 'cleanup') {
    super(stage === 'cleanup');
    this.name = 'RpcSoakWebsocketError';
    Object.freeze(this);
  }
}

const programs = Object.freeze([
  Object.freeze({ family: 'pumpfun' as const, address: PUMP_PROGRAM_ID, requestId: 1 }),
  Object.freeze({ family: 'pumpswap' as const, address: PUMPSWAP_PROGRAM_ID, requestId: 2 }),
]);

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

export class SolanaRpcSoakTransport implements RpcSoakTransport {
  private readonly httpRpcUrl: string;
  private readonly websocketUrl: string;
  private readonly commitment: Commitment;
  private readonly fetch: RpcSoakFetch;
  private readonly createWebSocket: RpcSoakWebSocketFactory;

  public constructor(options: SolanaRpcSoakTransportOptions) {
    requireEndpoint(options.httpRpcUrl, 'HTTP');
    requireEndpoint(options.websocketUrl, 'WebSocket');
    this.httpRpcUrl = options.httpRpcUrl;
    this.websocketUrl = options.websocketUrl;
    this.commitment = options.commitment;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.createWebSocket = options.createWebSocket
      ?? ((url: string): RpcSoakWebSocket => new WebSocket(url));
  }

  public async sampleHttpSlot(signal: AbortSignal): Promise<bigint> {
    let response: RpcSoakFetchResponse;
    try {
      response = await this.fetch(this.httpRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: this.commitment }],
        }),
        signal,
      });
    } catch {
      throw new RpcSoakTransportError('RPC_REQUEST_FAILED');
    }
    if (response.status === 429) throw new RpcSoakTransportError('RPC_RATE_LIMITED');
    if (!response.ok) throw new RpcSoakTransportError('RPC_REQUEST_FAILED');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RpcSoakTransportError('RPC_RESPONSE_INVALID');
    }
    const jsonrpc = ownData(payload, 'jsonrpc');
    const id = ownData(payload, 'id');
    const result = ownData(payload, 'result');
    if (jsonrpc !== '2.0' || id !== 1 || !validRpcInteger(result)) {
      throw new RpcSoakTransportError('RPC_RESPONSE_INVALID');
    }
    return BigInt(result);
  }

  public async subscribe(
    observe: (value: RpcSoakObservation) => void,
    signal: AbortSignal,
  ): Promise<RpcSoakSubscription> {
    let socket: RpcSoakWebSocket;
    try {
      socket = this.createWebSocket(this.websocketUrl);
    } catch {
      throw new RpcSoakWebsocketError('subscribe');
    }
    return establishWebSocketSession(socket, observe, signal);
  }
}

function establishWebSocketSession(
  socket: RpcSoakWebSocket,
  observe: (value: RpcSoakObservation) => void,
  setupSignal: AbortSignal,
): Promise<RpcSoakSubscription> {
  return new Promise((resolve, reject) => {
    const subscriptions = new Map<number, RpcSoakObservation['program']>();
    const acknowledgedRequests = new Set<number>();
    let setupSettled = false;
    let healthy = true;
    let intentionalClose = false;
    let setupFailurePending = false;
    let closePromise: Promise<void> | null = null;
    let resolveClose: (() => void) | null = null;
    let rejectClose: ((error: Error) => void) | null = null;

    const removeSetupAbort = (): void => {
      setupSignal.removeEventListener('abort', onSetupAbort);
    };
    const finishSetupFailure = (cleanupFailed: boolean): void => {
      if (setupSettled) return;
      setupSettled = true;
      removeSetupAbort();
      reject(new RpcSoakWebsocketError(cleanupFailed ? 'cleanup' : 'subscribe'));
    };
    const requestSetupClose = (): void => {
      if (setupSettled || setupFailurePending) return;
      setupFailurePending = true;
      intentionalClose = true;
      try {
        socket.close(1000, 'rpc-soak-setup');
      } catch {
        finishSetupFailure(true);
      }
    };
    const onSetupAbort = (): void => {
      requestSetupClose();
      finishSetupFailure(socket.readyState !== WEBSOCKET_CLOSED);
    };
    const onOpen = (): void => {
      try {
        for (const program of programs) {
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: program.requestId,
            method: 'logsSubscribe',
            params: [{ mentions: [program.address] }, { commitment: 'processed' }],
          }));
        }
      } catch {
        requestSetupClose();
      }
    };
    const onMessage = (event: unknown): void => {
      const payload = parseWebSocketPayload(event);
      if (payload === null) return;
      const responseId = ownData(payload, 'id');
      if (responseId === 1 || responseId === 2) {
        if (setupSettled || acknowledgedRequests.has(responseId)) {
          healthy = false;
          requestSetupClose();
          return;
        }
        const subscriptionId = ownData(payload, 'result');
        if (!validRpcInteger(subscriptionId)) {
          requestSetupClose();
          return;
        }
        const program = programs.find((entry) => entry.requestId === responseId);
        if (program === undefined || subscriptions.has(subscriptionId)) {
          requestSetupClose();
          return;
        }
        acknowledgedRequests.add(responseId);
        subscriptions.set(subscriptionId, program.family);
        if (acknowledgedRequests.size === programs.length) {
          setupSettled = true;
          removeSetupAbort();
          resolve(Object.freeze({
            health: (): 'HEALTHY' | 'FAILED' => (
              healthy && socket.readyState === WEBSOCKET_OPEN ? 'HEALTHY' : 'FAILED'
            ),
            close: (signal: AbortSignal): Promise<void> => {
              closePromise ??= closeWebSocket(signal);
              return closePromise;
            },
          }));
        }
        return;
      }
      const observation = readObservation(payload, subscriptions);
      if (observation !== null) observe(Object.freeze(observation));
    };
    const onError = (): void => {
      healthy = false;
      if (!setupSettled) requestSetupClose();
    };
    const onClose = (): void => {
      if (!intentionalClose) healthy = false;
      if (!setupSettled) {
        finishSetupFailure(false);
        return;
      }
      resolveClose?.();
      resolveClose = null;
      rejectClose = null;
    };
    const closeWebSocket = (signal: AbortSignal): Promise<void> => new Promise((closeResolve, closeReject) => {
      intentionalClose = true;
      resolveClose = closeResolve;
      rejectClose = closeReject;
      const abort = (): void => {
        try { socket.close(1000, 'rpc-soak-deadline'); } catch { /* fixed error below */ }
        rejectClose?.(new RpcSoakWebsocketError('cleanup'));
        resolveClose = null;
        rejectClose = null;
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      const previousResolve = resolveClose;
      resolveClose = (): void => {
        signal.removeEventListener('abort', abort);
        previousResolve();
      };
      try {
        if (socket.readyState === WEBSOCKET_CLOSED) resolveClose();
        else socket.close(1000, 'rpc-soak-complete');
      } catch {
        signal.removeEventListener('abort', abort);
        rejectClose(new RpcSoakWebsocketError('cleanup'));
      }
    });

    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    setupSignal.addEventListener('abort', onSetupAbort, { once: true });
    if (setupSignal.aborted) onSetupAbort();
  });
}

function readObservation(
  payload: unknown,
  subscriptions: ReadonlyMap<number, RpcSoakObservation['program']>,
): RpcSoakObservation | null {
  if (ownData(payload, 'method') !== 'logsNotification') return null;
  const params = ownData(payload, 'params');
  const subscriptionId = ownData(params, 'subscription');
  if (!validRpcInteger(subscriptionId)) return null;
  const program = subscriptions.get(subscriptionId);
  if (program === undefined) return null;
  const result = ownData(params, 'result');
  const context = ownData(result, 'context');
  const slot = ownData(context, 'slot');
  return validRpcInteger(slot) ? { program, slot: BigInt(slot) } : null;
}

function parseWebSocketPayload(event: unknown): unknown {
  let data: unknown;
  try {
    data = (event as { readonly data?: unknown }).data;
  } catch {
    return null;
  }
  if (typeof data !== 'string' || data.length > 1_048_576) return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable
      ? descriptor.value as unknown
      : undefined;
  } catch {
    return undefined;
  }
}

function validRpcInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function requireEndpoint(value: string, family: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`RPC soak ${family} configuration is invalid.`);
  }
}
