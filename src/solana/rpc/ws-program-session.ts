import { PUMP_PROGRAM_ID } from '../../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../../markets/pumpswap/constants.js';
import bs58 from 'bs58';
import type { RpcProviderId } from './rpc-provider-catalog.js';

export const WS_PROGRAM_SESSION_SETUP_TIMEOUT_MS = 10_000;
export const WS_PROGRAM_SESSION_CLEANUP_TIMEOUT_MS = 5_000;
export const MAX_WS_PROGRAM_SESSION_FRAME_BYTES = 1_048_576;

export type WsProgramEndpointId = RpcProviderId;
export type WsProgramFamily = 'pumpfun' | 'pumpswap';

export interface WsProgramEndpoint {
  readonly id: WsProgramEndpointId;
  readonly url: string;
}

export interface WsProgramNotification {
  readonly endpointId: WsProgramEndpointId;
  readonly program: WsProgramFamily;
  readonly signature: string;
  readonly slot: bigint;
}

export type WsProgramSessionErrorReason =
  | 'SETUP_TIMEOUT'
  | 'ABORTED'
  | 'SOCKET_ERROR'
  | 'REMOTE_CLOSE'
  | 'PROTOCOL_INVALID'
  | 'NOTIFICATION_FAILED'
  | 'CLEANUP_FAILED';

export class WsProgramSessionError extends Error {
  public constructor(public readonly reason: WsProgramSessionErrorReason) {
    super('Solana WebSocket program session failed.');
    this.name = 'WsProgramSessionError';
    Object.freeze(this);
  }
}

export type WsProgramSessionCompletionReason =
  | 'LOCAL_CLOSE'
  | 'SOCKET_ERROR'
  | 'REMOTE_CLOSE'
  | 'PROTOCOL_INVALID'
  | 'NOTIFICATION_FAILED'
  | 'CLEANUP_FAILED';

export interface WsProgramSessionCompletion {
  readonly reason: WsProgramSessionCompletionReason;
}

export interface WsProgramSession {
  readonly endpointId: WsProgramEndpointId;
  readonly completion: Promise<WsProgramSessionCompletion>;
  close(signal: AbortSignal): Promise<void>;
}

export interface WsProgramSessionWebSocket {
  readonly readyState: number;
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: unknown) => void,
  ): void;
  removeEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: unknown) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WsProgramSessionWebSocketFactory = (url: string) => WsProgramSessionWebSocket;

export interface WsProgramSessionScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface WsProgramSessionDependencies {
  readonly createWebSocket?: WsProgramSessionWebSocketFactory;
  readonly scheduler?: WsProgramSessionScheduler;
}

interface ProgramDefinition {
  readonly family: WsProgramFamily;
  readonly address: string;
  readonly subscribeRequestId: 1 | 2;
  readonly unsubscribeRequestId: 3 | 4;
}

const PROGRAMS: readonly ProgramDefinition[] = Object.freeze([
  Object.freeze({
    family: 'pumpfun', address: PUMP_PROGRAM_ID, subscribeRequestId: 1, unsubscribeRequestId: 3,
  }),
  Object.freeze({
    family: 'pumpswap', address: PUMPSWAP_PROGRAM_ID, subscribeRequestId: 2, unsubscribeRequestId: 4,
  }),
]);

const defaultScheduler: WsProgramSessionScheduler = Object.freeze({
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  cancel(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

export function openWsProgramSession(
  endpoint: WsProgramEndpoint,
  observe: (notification: WsProgramNotification) => Promise<void>,
  signal: AbortSignal,
  dependencies: WsProgramSessionDependencies = {},
): Promise<WsProgramSession> {
  const createWebSocket = dependencies.createWebSocket
    ?? ((url: string): WsProgramSessionWebSocket => new WebSocket(url));
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  let socket: WsProgramSessionWebSocket;
  try {
    socket = createWebSocket(endpoint.url);
  } catch {
    return Promise.reject(new WsProgramSessionError('SOCKET_ERROR'));
  }

  return new Promise((resolve, reject) => {
    const requests = new Map<number, ProgramDefinition>(
      PROGRAMS.map((program) => [program.subscribeRequestId, program]),
    );
    const subscriptions = new Map<number, WsProgramFamily>();
    let setupSettled = false;
    let setupFailureFinalized = false;
    let sessionOpened = false;
    let completionSettled = false;
    let socketClosed = socket.readyState === 3;
    let activeCloseFailed = false;
    let accepting = true;
    let timeout: unknown = null;
    let cleanupTimeout: unknown = null;
    let closePromise: Promise<void> | null = null;
    let resolveClose: (() => void) | null = null;
    let rejectClose: ((error: WsProgramSessionError) => void) | null = null;
    let closeSignal: AbortSignal | null = null;
    let awaitingLocalClose = false;
    let drainingObservers = false;
    const unsubscribeRequests = new Set<number>();
    const inFlight = new Set<Promise<void>>();
    let resolveSocketClosed!: () => void;
    const socketClosedCompletion = new Promise<void>((done) => {
      resolveSocketClosed = done;
    });
    if (socketClosed) resolveSocketClosed();
    let resolveCompletion!: (value: WsProgramSessionCompletion) => void;
    const completion = new Promise<WsProgramSessionCompletion>((done) => {
      resolveCompletion = done;
    });

    const removeListeners = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    const removeNonCloseListeners = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };
    const removeSetupResources = (): void => {
      if (timeout !== null) scheduler.cancel(timeout);
      timeout = null;
      signal.removeEventListener('abort', onAbort);
    };
    const removeCleanupResources = (): void => {
      if (cleanupTimeout !== null) scheduler.cancel(cleanupTimeout);
      cleanupTimeout = null;
      closeSignal?.removeEventListener('abort', onCleanupAbort);
      closeSignal = null;
    };
    const finalizeSetupFailure = (reason: WsProgramSessionErrorReason): void => {
      if (setupFailureFinalized) return;
      setupFailureFinalized = true;
      if (cleanupTimeout !== null) scheduler.cancel(cleanupTimeout);
      cleanupTimeout = null;
      removeListeners();
      reject(new WsProgramSessionError(reason));
    };
    const drainSetupFailure = (
      reason: WsProgramSessionErrorReason,
      socketCloseFailed: boolean,
    ): void => {
      const pending = [...inFlight];
      if (pending.length === 0 && (socketClosed || socketCloseFailed)) {
        finalizeSetupFailure(reason);
        return;
      }
      cleanupTimeout = scheduler.schedule(
        () => { finalizeSetupFailure('CLEANUP_FAILED'); },
        WS_PROGRAM_SESSION_CLEANUP_TIMEOUT_MS,
      );
      const closeCompleted = socketCloseFailed ? Promise.resolve() : socketClosedCompletion;
      void Promise.all([Promise.allSettled(pending), closeCompleted]).then(() => {
        finalizeSetupFailure(reason);
      });
    };
    const failSetup = (reason: WsProgramSessionErrorReason): void => {
      if (setupSettled) return;
      setupSettled = true;
      accepting = false;
      removeSetupResources();
      removeNonCloseListeners();
      let failureReason = reason;
      let socketCloseFailed = false;
      try { socket.close(1000, 'ws-program-setup'); } catch {
        failureReason = 'CLEANUP_FAILED';
        socketCloseFailed = true;
      }
      drainSetupFailure(failureReason, socketCloseFailed);
    };
    const failActive = (reason: WsProgramSessionCompletionReason): void => {
      if (completionSettled) return;
      completionSettled = true;
      accepting = false;
      removeSetupResources();
      removeNonCloseListeners();
      resolveCompletion(Object.freeze({ reason }));
      if (socketClosed) {
        removeListeners();
        return;
      }
      try { socket.close(1000, 'ws-program-failure'); } catch { activeCloseFailed = true; }
    };
    const finalizeLocalClose = (failed: boolean): void => {
      if (resolveClose === null && rejectClose === null) return;
      removeCleanupResources();
      removeListeners();
      accepting = false;
      if (!completionSettled) {
        completionSettled = true;
        resolveCompletion(Object.freeze({ reason: failed ? 'CLEANUP_FAILED' : 'LOCAL_CLOSE' }));
      }
      const complete = resolveClose;
      const failClose = rejectClose;
      resolveClose = null;
      rejectClose = null;
      if (failed) failClose?.(new WsProgramSessionError('CLEANUP_FAILED'));
      else complete?.();
    };
    const drainAndFinishLocalClose = (): void => {
      if (drainingObservers) return;
      drainingObservers = true;
      removeListeners();
      void Promise.allSettled([...inFlight]).then(() => {
        finalizeLocalClose(false);
      });
    };
    const forceCleanupFailure = (): void => {
      if (resolveClose === null && rejectClose === null) return;
      removeListeners();
      try { socket.close(1000, 'ws-program-cleanup'); } catch { /* fixed error below */ }
      finalizeLocalClose(true);
    };
    const onCleanupAbort = (): void => { forceCleanupFailure(); };
    const closeSession = (cleanupSignal: AbortSignal): Promise<void> => {
      if (closePromise !== null) return closePromise;
      const sessionAlreadyCompleted = completionSettled;
      accepting = false;
      closeSignal = cleanupSignal;
      closePromise = new Promise<void>((closeResolve, closeReject) => {
        resolveClose = closeResolve;
        rejectClose = closeReject;
      });
      cleanupSignal.addEventListener('abort', onCleanupAbort, { once: true });
      cleanupTimeout = scheduler.schedule(
        () => { forceCleanupFailure(); },
        WS_PROGRAM_SESSION_CLEANUP_TIMEOUT_MS,
      );
      if (cleanupSignal.aborted) {
        onCleanupAbort();
        return closePromise;
      }
      if (sessionAlreadyCompleted) {
        if (activeCloseFailed) forceCleanupFailure();
        else if (socketClosed) drainAndFinishLocalClose();
        return closePromise;
      }
      let sendFailed = false;
      for (const program of PROGRAMS) {
        const subscription = [...subscriptions.entries()]
          .find(([, family]) => family === program.family)?.[0];
        if (subscription === undefined) continue;
        unsubscribeRequests.add(program.unsubscribeRequestId);
        try {
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: program.unsubscribeRequestId,
            method: 'logsUnsubscribe',
            params: [subscription],
          }));
        } catch {
          sendFailed = true;
        }
      }
      if (sendFailed || unsubscribeRequests.size === 0) forceCleanupFailure();
      return closePromise;
    };
    const fail = (reason: WsProgramSessionErrorReason): void => {
      if (!sessionOpened) {
        failSetup(reason);
        return;
      }
      const completionReason: WsProgramSessionCompletionReason = reason === 'NOTIFICATION_FAILED'
        ? 'NOTIFICATION_FAILED'
        : reason === 'SOCKET_ERROR'
          ? 'SOCKET_ERROR'
          : reason === 'REMOTE_CLOSE'
            ? 'REMOTE_CLOSE'
            : 'PROTOCOL_INVALID';
      failActive(completionReason);
    };
    const onAbort = (): void => { failSetup('ABORTED'); };

    const onOpen = (): void => {
      for (const program of PROGRAMS) {
        try {
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: program.subscribeRequestId,
            method: 'logsSubscribe',
            params: [{ mentions: [program.address] }, { commitment: 'confirmed' }],
          }));
        } catch {
          failSetup('SOCKET_ERROR');
          return;
        }
      }
    };
    const onMessage = (event: unknown): void => {
      const payload = parsePayload(event);
      if (payload === null || ownData(payload, 'jsonrpc') !== '2.0') {
        if (closePromise !== null) forceCleanupFailure();
        else fail('PROTOCOL_INVALID');
        return;
      }
      const idField = ownField(payload, 'id');
      if (idField.found) {
        const id = idField.value;
        const resultField = ownField(payload, 'result');
        const errorField = ownField(payload, 'error');
        if (closePromise !== null) {
          if (!validRpcInteger(id)
            || !unsubscribeRequests.has(id)
            || !resultField.found
            || errorField.found
            || resultField.value !== true) {
            forceCleanupFailure();
            return;
          }
          unsubscribeRequests.delete(id);
          if (unsubscribeRequests.size === 0) {
            awaitingLocalClose = true;
            try { socket.close(1000, 'ws-program-complete'); } catch { forceCleanupFailure(); }
          }
          return;
        }
        if (!validRpcInteger(id)
          || !requests.has(id)
          || !resultField.found
          || errorField.found) {
          fail('PROTOCOL_INVALID');
          return;
        }
        const program = requests.get(id);
        const subscription = resultField.value;
        if (program === undefined
          || !validRpcInteger(subscription)
          || subscriptions.has(subscription)) {
          fail('PROTOCOL_INVALID');
          return;
        }
        requests.delete(id);
        subscriptions.set(subscription, program.family);
        if (requests.size === 0) {
          setupSettled = true;
          sessionOpened = true;
          removeSetupResources();
          socket.removeEventListener('open', onOpen);
          resolve(Object.freeze({
            endpointId: endpoint.id,
            completion,
            close: closeSession,
          }));
        }
        return;
      }
      if (ownData(payload, 'method') !== 'logsNotification') {
        fail('PROTOCOL_INVALID');
        return;
      }
      const params = ownData(payload, 'params');
      const subscription = ownData(params, 'subscription');
      if (!validRpcInteger(subscription)) {
        fail('PROTOCOL_INVALID');
        return;
      }
      const program = subscriptions.get(subscription);
      if (program === undefined) {
        fail('PROTOCOL_INVALID');
        return;
      }
      const result = ownData(params, 'result');
      const value = ownData(result, 'value');
      const context = ownData(result, 'context');
      const signature = ownData(value, 'signature');
      const failure = ownField(value, 'err');
      const slot = ownData(context, 'slot');
      if (!failure.found) {
        fail('PROTOCOL_INVALID');
        return;
      }
      if (failure.value !== null) return;
      if (!accepting) return;
      if (!validSignature(signature) || !validRpcInteger(slot)) {
        fail('PROTOCOL_INVALID');
        return;
      }
      let task: Promise<void>;
      try {
        task = observe(Object.freeze({
          endpointId: endpoint.id,
          program,
          signature,
          slot: BigInt(slot),
        }));
      } catch {
        fail('NOTIFICATION_FAILED');
        return;
      }
      inFlight.add(task);
      void task.then(
        () => { inFlight.delete(task); },
        () => {
          inFlight.delete(task);
          if (closePromise !== null) forceCleanupFailure();
          else fail('NOTIFICATION_FAILED');
        },
      );
    };
    const onError = (): void => {
      if (closePromise !== null) forceCleanupFailure();
      else fail('SOCKET_ERROR');
    };
    const onClose = (): void => {
      socketClosed = true;
      resolveSocketClosed();
      if (setupSettled && !sessionOpened) {
        removeListeners();
        return;
      }
      if (closePromise !== null) {
        if (awaitingLocalClose || completionSettled) drainAndFinishLocalClose();
        else forceCleanupFailure();
        return;
      }
      if (completionSettled) {
        removeListeners();
        return;
      }
      fail('REMOTE_CLOSE');
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    timeout = scheduler.schedule(
      () => { failSetup('SETUP_TIMEOUT'); },
      WS_PROGRAM_SESSION_SETUP_TIMEOUT_MS,
    );
    if (signal.aborted) onAbort();
  });
}

function parsePayload(event: unknown): unknown {
  const data = ownData(event, 'data');
  if (typeof data !== 'string'
    || Buffer.byteLength(data, 'utf8') > MAX_WS_PROGRAM_SESSION_FRAME_BYTES) return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function ownData(value: unknown, key: string): unknown {
  const field = ownField(value, key);
  return field.found ? field.value : undefined;
}

function ownField(
  value: unknown,
  key: string,
): Readonly<{ found: false }> | Readonly<{ found: true; value: unknown }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { found: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable
      ? { found: true, value: descriptor.value as unknown }
      : { found: false };
  } catch {
    return { found: false };
  }
}

function validRpcInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function validSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 88) return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.byteLength === 64 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}
