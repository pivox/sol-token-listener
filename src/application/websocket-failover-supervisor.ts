import { isProxy } from 'node:util/types';
import type { StrictCatchUpScanResult } from './strict-catch-up-scanner.js';
import { PromotedProviderSelector } from './promoted-provider-selector.js';
import {
  PersistentWebSocketHealthReporter,
} from './websocket-health-reporter.js';
import {
  assertValidWebSocketHealthSnapshot,
  type WebSocketHealthSnapshot,
} from '../domain/websocket-health.js';
import type {
  ListenerRuntimeState,
  TransactionNotification,
} from '../domain/transaction-ingestion.js';
import {
  RPC_PROVIDER_IDS,
  isRpcProviderId,
  type RpcProviderId,
} from '../domain/rpc-provider.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import type {
  WebSocketHealthRepository,
  WebSocketHealthTransition,
} from '../ports/websocket-health-repository.js';
import type {
  RpcProviderCatalog,
  RpcProviderPair,
} from '../solana/rpc/rpc-provider-catalog.js';
import type {
  openWsProgramSession,
  WsProgramNotification,
  WsProgramSession,
} from '../solana/rpc/ws-program-session.js';

export const WEBSOCKET_FRONTIER_INTERVAL_MS = 30_000;
export const WEBSOCKET_BACKOFF_BASE_MS = 1_000;
export const WEBSOCKET_BACKOFF_CAP_MS = 60_000;

export interface WebSocketFailoverScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface WebSocketFailoverSupervisorOptions {
  readonly now: () => number;
  readonly random: () => number;
  readonly scheduler: WebSocketFailoverScheduler;
}

export interface WebSocketFailoverSupervisorDependencies {
  readonly providers: RpcProviderCatalog;
  readonly health: Pick<WebSocketHealthRepository, 'beginOwner'>;
  readonly reporter: PersistentWebSocketHealthReporter;
  readonly promoted: PromotedProviderSelector;
  readonly openSession: typeof openWsProgramSession;
  readonly runStrictScan: (
    providerId: RpcProviderId,
    signal: AbortSignal,
  ) => Promise<StrictCatchUpScanResult>;
}

export class WebSocketFailoverSupervisorError extends Error {
  public constructor(public readonly stage: 'owner' | 'transition' | 'schedule' | 'cleanup') {
    super('WebSocket failover supervisor operation failed.');
    this.name = 'WebSocketFailoverSupervisorError';
    Object.freeze(this);
  }
}

interface ScheduledHandle {
  readonly value: unknown;
}

interface SessionRecord {
  readonly providerId: RpcProviderId;
  readonly sessionGeneration: bigint;
  readonly session: WsProgramSession;
  readonly controller: AbortController;
}

interface ValidatedReporter {
  startTouch(snapshot: WebSocketHealthSnapshot): void;
  transition: PersistentWebSocketHealthReporter['transition'];
  observe: PersistentWebSocketHealthReporter['observe'];
  stop: PersistentWebSocketHealthReporter['stop'];
}

interface ValidatedPromotedSelector {
  promote: PromotedProviderSelector['promote'];
  clear: PromotedProviderSelector['clear'];
  activeProviderId: PromotedProviderSelector['activeProviderId'];
}

interface ValidatedDependencies {
  readonly providers: RpcProviderCatalog;
  readonly health: Pick<WebSocketHealthRepository, 'beginOwner'>;
  readonly reporter: ValidatedReporter;
  readonly promoted: ValidatedPromotedSelector;
  readonly openSession: typeof openWsProgramSession;
  readonly runStrictScan: WebSocketFailoverSupervisorDependencies['runStrictScan'];
}

export class WebSocketFailoverSupervisor {
  readonly #dependencies: ValidatedDependencies;
  readonly #options: WebSocketFailoverSupervisorOptions;
  #snapshot: WebSocketHealthSnapshot | null = null;
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #loopHandle: ScheduledHandle | null = null;
  #periodicHandle: ScheduledHandle | null = null;
  #loopPromise: Promise<void> | null = null;
  #candidateAbort: AbortController | null = null;
  #candidate: SessionRecord | null = null;
  #incumbent: SessionRecord | null = null;
  #currentState: ListenerRuntimeState = 'STOPPED';
  #currentProviderId: RpcProviderId | null = null;
  #permanentlyClosed = false;

  public constructor(
    dependencies: WebSocketFailoverSupervisorDependencies,
    options: WebSocketFailoverSupervisorOptions,
  ) {
    try {
      this.#dependencies = dependenciesFrom(dependencies);
      this.#options = optionsFrom(options);
    } catch {
      throw configurationError();
    }
  }

  public start(): Promise<void> {
    if (this.#startPromise === null) {
      this.#startPromise = this.#permanentlyClosed
        ? Promise.reject(new WebSocketFailoverSupervisorError('cleanup'))
        : this.#performStart();
    }
    return this.#startPromise;
  }

  public close(): Promise<void> {
    if (this.#closePromise === null) this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  public state(): ListenerRuntimeState {
    return this.#currentState;
  }

  public activeProviderId(): RpcProviderId | null {
    return this.#currentProviderId;
  }

  async #performStart(): Promise<void> {
    let snapshot: WebSocketHealthSnapshot;
    try {
      snapshot = await this.#dependencies.health.beginOwner({ candidateProviderId: 'primary' });
      assertValidWebSocketHealthSnapshot(snapshot);
      if (snapshot.supervision !== 'ACTIVE'
        || snapshot.phase !== 'CONNECTING'
        || snapshot.ownerGeneration === 0n
        || snapshot.candidateProviderId !== 'primary'
        || snapshot.candidateSessionGeneration === null) throw new TypeError();
    } catch {
      this.#currentState = 'DEGRADED';
      throw new WebSocketFailoverSupervisorError('owner');
    }
    this.#snapshot = snapshot;
    let touchStarted = false;
    try {
      this.#dependencies.reporter.startTouch(snapshot);
      touchStarted = true;
      this.#snapshot = await this.#transitionToWaiting(snapshot);
    } catch {
      this.#currentState = 'DEGRADED';
      if (touchStarted) await this.#stopReporterAfterStartFailure();
      throw new WebSocketFailoverSupervisorError('transition');
    }
    this.#currentState = 'STARTING';
    try {
      this.#scheduleRecovery();
    } catch {
      this.#currentState = 'DEGRADED';
      await this.#stopReporterAfterStartFailure();
      throw new WebSocketFailoverSupervisorError('schedule');
    }
  }

  async #stopReporterAfterStartFailure(): Promise<void> {
    try {
      await this.#dependencies.reporter.stop(() => Promise.resolve());
    } catch {
      // The original startup stage remains the stable public failure.
    }
  }

  async #transitionToWaiting(snapshot: WebSocketHealthSnapshot): Promise<WebSocketHealthSnapshot> {
    const input: WebSocketHealthTransition = {
      ownerGeneration: snapshot.ownerGeneration,
      expectedRevision: snapshot.revision,
      phase: 'WAITING_FOR_ACKS',
      providerId: null,
      activeSessionGeneration: null,
      candidateProviderId: snapshot.candidateProviderId,
      candidateSessionGeneration: snapshot.candidateSessionGeneration,
      acknowledged: false,
      disconnectReasonCode: null,
      recoveryStatus: 'REQUIRED',
      recoveryReasonCode: snapshot.recovery.reasonCode ?? 'STARTUP',
    };
    const next = await this.#dependencies.reporter.transition(input);
    assertTransitionResult(snapshot, input, next);
    return next;
  }

  #scheduleRecovery(): void {
    let scheduled: ScheduledHandle | null = null;
    const value = this.#options.scheduler.schedule(() => {
      if (scheduled === null || this.#loopHandle !== scheduled) return;
      this.#loopHandle = null;
      if (this.#permanentlyClosed || this.#loopPromise !== null) return;
      const operation = this.#recoverPrimary();
      this.#loopPromise = operation;
      void operation.then(
        () => { this.#finishRecovery(operation, false); },
        () => { this.#finishRecovery(operation, true); },
      );
    }, 0);
    scheduled = Object.freeze({ value });
    this.#loopHandle = scheduled;
  }

  async #recoverPrimary(): Promise<void> {
    const snapshot = this.#snapshot;
    if (snapshot?.candidateProviderId !== 'primary'
      || snapshot.candidateSessionGeneration === null
      || this.#isPermanentlyClosed()) return;
    const providerId = snapshot.candidateProviderId;
    const ownerGeneration = snapshot.ownerGeneration;
    const sessionGeneration = snapshot.candidateSessionGeneration;
    const endpoint = providerPairFrom(
      this.#dependencies.providers.resolve(providerId),
      providerId,
    );
    const controller = new AbortController();
    this.#candidateAbort = controller;
    let openedSession: WsProgramSession | null = null;
    const session = await this.#dependencies.openSession(
      Object.freeze({ id: providerId, url: endpoint.websocketUrl }),
      (value) => this.#notification(
        value,
        ownerGeneration,
        sessionGeneration,
        controller,
        openedSession,
      ),
      controller.signal,
    );
    openedSession = session;
    if (this.#isPermanentlyClosed() || this.#candidateAbort !== controller) return;
    const candidate: SessionRecord = Object.freeze({
      providerId,
      sessionGeneration,
      session,
      controller,
    });
    this.#candidate = candidate;
    void session.completion.then(
      () => { this.#completeSession(candidate); },
      () => { this.#completeSession(candidate); },
    );

    await this.#transition({
      phase: 'ACKNOWLEDGED',
      providerId: null,
      activeSessionGeneration: null,
      candidateProviderId: providerId,
      candidateSessionGeneration: sessionGeneration,
      acknowledged: true,
      disconnectReasonCode: null,
      recoveryStatus: 'REQUIRED',
      recoveryReasonCode: snapshot.recovery.reasonCode ?? 'STARTUP',
    });
    if (this.#candidate !== candidate || this.#isPermanentlyClosed()) return;
    await this.#transition({
      phase: 'RECOVERING',
      providerId: null,
      activeSessionGeneration: null,
      candidateProviderId: providerId,
      candidateSessionGeneration: sessionGeneration,
      acknowledged: true,
      disconnectReasonCode: null,
      recoveryStatus: 'IN_PROGRESS',
      recoveryReasonCode: snapshot.recovery.reasonCode ?? 'STARTUP',
    });
    if (this.#candidate !== candidate || this.#isPermanentlyClosed()) return;
    await this.#dependencies.runStrictScan(providerId, controller.signal);
    if (this.#candidate !== candidate || this.#isPermanentlyClosed()
      || controller.signal.aborted) return;
    await this.#transition({
      phase: 'RUNNING',
      providerId,
      activeSessionGeneration: sessionGeneration,
      candidateProviderId: null,
      candidateSessionGeneration: null,
      acknowledged: true,
      disconnectReasonCode: null,
      recoveryStatus: 'RECOVERED',
      recoveryReasonCode: snapshot.recovery.reasonCode ?? 'STARTUP',
    });
    if (this.#candidate !== candidate || this.#isPermanentlyClosed()) return;
    this.#incumbent = candidate;
    this.#candidate = null;
    this.#candidateAbort = null;
    this.#currentProviderId = providerId;
    this.#currentState = 'RUNNING';
    this.#dependencies.promoted.promote(providerId);
    this.#armPeriodicFrontier();
  }

  async #transition(
    input: Omit<
      Parameters<PersistentWebSocketHealthReporter['transition']>[0],
      'ownerGeneration' | 'expectedRevision'
    >,
  ): Promise<void> {
    const snapshot = this.#snapshot;
    if (snapshot === null) throw new WebSocketFailoverSupervisorError('transition');
    let next: WebSocketHealthSnapshot;
    try {
      const transitionInput: WebSocketHealthTransition = {
        ownerGeneration: snapshot.ownerGeneration,
        expectedRevision: snapshot.revision,
        ...input,
      };
      next = await this.#dependencies.reporter.transition(transitionInput);
      assertTransitionResult(snapshot, transitionInput, next);
    } catch {
      throw new WebSocketFailoverSupervisorError('transition');
    }
    this.#snapshot = next;
  }

  #notification(
    value: WsProgramNotification,
    ownerGeneration: bigint,
    sessionGeneration: bigint,
    controller: AbortController,
    openedSession: WsProgramSession | null,
  ): Promise<void> {
    if (this.#permanentlyClosed || this.#candidateAbort !== controller) return Promise.resolve();
    if (openedSession !== null
      && this.#candidate?.session !== openedSession
      && this.#incumbent?.session !== openedSession) return Promise.resolve();
    const notification: TransactionNotification = Object.freeze({
      signature: value.signature,
      slot: value.slot,
      source: 'WEBSOCKET',
      programIds: Object.freeze([
        value.program === 'pumpfun' ? PUMP_PROGRAM_ID : PUMPSWAP_PROGRAM_ID,
      ]),
      confirmationStatus: 'confirmed',
      observedAtMs: this.#options.now(),
    });
    return this.#dependencies.reporter.observe(
      notification,
      ownerGeneration,
      sessionGeneration,
    );
  }

  #completeSession(record: SessionRecord): void {
    if (this.#permanentlyClosed) return;
    if (this.#candidate === record) {
      this.#candidate = null;
      if (this.#candidateAbort === record.controller) this.#candidateAbort = null;
      record.controller.abort();
      return;
    }
    if (this.#incumbent === record) {
      this.#incumbent = null;
      this.#currentProviderId = null;
      this.#currentState = 'DEGRADED';
    }
  }

  #finishRecovery(operation: Promise<void>, failed: boolean): void {
    if (this.#loopPromise === operation) this.#loopPromise = null;
    if (failed && !this.#permanentlyClosed) this.#currentState = 'DEGRADED';
  }

  #isPermanentlyClosed(): boolean {
    return this.#permanentlyClosed;
  }

  #armPeriodicFrontier(): void {
    if (this.#permanentlyClosed || this.#periodicHandle !== null) return;
    let scheduled: ScheduledHandle | null = null;
    const value = this.#options.scheduler.schedule(() => {
      if (scheduled !== null && this.#periodicHandle === scheduled) {
        this.#periodicHandle = null;
      }
    }, WEBSOCKET_FRONTIER_INTERVAL_MS);
    scheduled = Object.freeze({ value });
    this.#periodicHandle = scheduled;
  }

  async #performClose(): Promise<void> {
    this.#permanentlyClosed = true;
    this.#currentState = 'STOPPING';
    const handle = this.#loopHandle;
    this.#loopHandle = null;
    const periodic = this.#periodicHandle;
    this.#periodicHandle = null;
    this.#candidateAbort?.abort();
    this.#candidateAbort = null;
    this.#candidate = null;
    this.#incumbent = null;
    const activeProviderId = this.#currentProviderId;
    this.#currentProviderId = null;
    if (activeProviderId !== null) {
      try {
        this.#dependencies.promoted.clear(activeProviderId);
      } catch {
        this.#currentState = 'DEGRADED';
        throw new WebSocketFailoverSupervisorError('cleanup');
      }
    }
    for (const scheduled of [handle, periodic]) {
      if (scheduled === null) continue;
      try {
        this.#options.scheduler.cancel(scheduled.value);
      } catch {
        this.#currentState = 'DEGRADED';
        throw new WebSocketFailoverSupervisorError('cleanup');
      }
    }
    this.#currentState = 'STOPPED';
    await Promise.resolve();
  }
}

function dependenciesFrom(value: unknown): ValidatedDependencies {
  const dependencies = exactOwnData(value, [
    'providers',
    'health',
    'reporter',
    'promoted',
    'openSession',
    'runStrictScan',
  ]);
  const providersValue = dependencies.providers;
  const healthValue = dependencies.health;
  const reporterValue = dependencies.reporter;
  const promotedValue = dependencies.promoted;
  const openSession = dependencies.openSession;
  const runStrictScan = dependencies.runStrictScan;
  if (!objectValue(providersValue)
    || !objectValue(healthValue)
    || !(reporterValue instanceof PersistentWebSocketHealthReporter)
    || isProxy(reporterValue)
    || !(promotedValue instanceof PromotedProviderSelector)
    || isProxy(promotedValue)
    || typeof openSession !== 'function'
    || isProxy(openSession)
    || typeof runStrictScan !== 'function'
    || isProxy(runStrictScan)) throw new TypeError();

  const ids = providerIdsFrom(ownDataValue(providersValue, 'ids'));
  const resolve = dataMethod<RpcProviderCatalog['resolve']>(providersValue, 'resolve');
  const beginOwner = dataMethod<WebSocketHealthRepository['beginOwner']>(
    healthValue,
    'beginOwner',
  );
  const startTouch = dataMethod<PersistentWebSocketHealthReporter['startTouch']>(
    reporterValue,
    'startTouch',
  );
  const transition = dataMethod<PersistentWebSocketHealthReporter['transition']>(
    reporterValue,
    'transition',
  );
  const observe = dataMethod<PersistentWebSocketHealthReporter['observe']>(
    reporterValue,
    'observe',
  );
  const stop = dataMethod<PersistentWebSocketHealthReporter['stop']>(
    reporterValue,
    'stop',
  );
  const promote = dataMethod<PromotedProviderSelector['promote']>(
    promotedValue,
    'promote',
  );
  const clear = dataMethod<PromotedProviderSelector['clear']>(
    promotedValue,
    'clear',
  );
  const activeProviderId = dataMethod<PromotedProviderSelector['activeProviderId']>(
    promotedValue,
    'activeProviderId',
  );
  const dependencyReceiver = objectReceiver(value);

  return Object.freeze({
    providers: Object.freeze({
      ids,
      resolve(id: RpcProviderId): RpcProviderPair {
        return Reflect.apply(resolve, providersValue, [id]);
      },
    }),
    health: Object.freeze({
      beginOwner(input: Parameters<WebSocketHealthRepository['beginOwner']>[0]) {
        return Reflect.apply(beginOwner, healthValue, [input]);
      },
    }),
    reporter: Object.freeze({
      startTouch(snapshot: WebSocketHealthSnapshot): void {
        Reflect.apply(startTouch, reporterValue, [snapshot]);
      },
      transition(input: Parameters<PersistentWebSocketHealthReporter['transition']>[0]) {
        return Reflect.apply(transition, reporterValue, [input]);
      },
      observe(
        notification: Parameters<PersistentWebSocketHealthReporter['observe']>[0],
        ownerGeneration: bigint,
        sessionGeneration: bigint,
      ) {
        return Reflect.apply(observe, reporterValue, [
          notification,
          ownerGeneration,
          sessionGeneration,
        ]);
      },
      stop(cleanup: Parameters<PersistentWebSocketHealthReporter['stop']>[0]) {
        return Reflect.apply(stop, reporterValue, [cleanup]);
      },
    }),
    promoted: Object.freeze({
      promote(providerId: RpcProviderId): void {
        Reflect.apply(promote, promotedValue, [providerId]);
      },
      clear(providerId: RpcProviderId): void {
        Reflect.apply(clear, promotedValue, [providerId]);
      },
      activeProviderId(): RpcProviderId | null {
        return Reflect.apply(activeProviderId, promotedValue, []);
      },
    }),
    openSession(
      endpoint: Parameters<typeof openWsProgramSession>[0],
      observeNotification: Parameters<typeof openWsProgramSession>[1],
      signal: Parameters<typeof openWsProgramSession>[2],
    ) {
      return Reflect.apply(openSession, dependencyReceiver, [
        endpoint,
        observeNotification,
        signal,
      ]) as ReturnType<typeof openWsProgramSession>;
    },
    runStrictScan(providerId: RpcProviderId, signal: AbortSignal) {
      return Reflect.apply(runStrictScan, dependencyReceiver, [
        providerId,
        signal,
      ]) as Promise<StrictCatchUpScanResult>;
    },
  });
}

function assertTransitionResult(
  previous: WebSocketHealthSnapshot,
  input: WebSocketHealthTransition,
  value: unknown,
): asserts value is WebSocketHealthSnapshot {
  assertValidWebSocketHealthSnapshot(value);
  if (value.ownerGeneration !== previous.ownerGeneration
    || value.revision !== previous.revision + 1n
    || value.phase !== input.phase
    || value.providerId !== input.providerId
    || value.activeSessionGeneration !== input.activeSessionGeneration
    || value.candidateProviderId !== input.candidateProviderId
    || value.candidateSessionGeneration !== input.candidateSessionGeneration
    || (value.acknowledgedAtMs !== null) !== input.acknowledged
    || value.recovery.status !== input.recoveryStatus
    || value.recovery.reasonCode !== input.recoveryReasonCode) throw new TypeError();
}

function optionsFrom(value: unknown): WebSocketFailoverSupervisorOptions {
  const options = exactOwnData(value, ['now', 'random', 'scheduler']);
  const now = options.now;
  const random = options.random;
  const schedulerValue = options.scheduler;
  if (typeof now !== 'function' || isProxy(now)
    || typeof random !== 'function' || isProxy(random)
    || !objectValue(schedulerValue)) {
    throw new TypeError();
  }
  const scheduler = exactOwnData(schedulerValue, ['schedule', 'cancel']);
  if (typeof scheduler.schedule !== 'function' || isProxy(scheduler.schedule)
    || typeof scheduler.cancel !== 'function' || isProxy(scheduler.cancel)) {
    throw new TypeError();
  }
  const optionsReceiver = value as object;
  const schedule = scheduler.schedule as WebSocketFailoverScheduler['schedule'];
  const cancel = scheduler.cancel as WebSocketFailoverScheduler['cancel'];
  const readNow = (): number => {
    const result: unknown = Reflect.apply(now, optionsReceiver, []);
    if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) {
      throw new TypeError();
    }
    return result;
  };
  const readRandom = (): number => {
    const result: unknown = Reflect.apply(random, optionsReceiver, []);
    if (typeof result !== 'number' || !Number.isFinite(result) || result < 0 || result >= 1) {
      throw new TypeError();
    }
    return result;
  };
  readNow();
  readRandom();
  return Object.freeze({
    now(): number {
      try { return readNow(); } catch { throw configurationError(); }
    },
    random(): number {
      try { return readRandom(); } catch { throw configurationError(); }
    },
    scheduler: Object.freeze({
      schedule(callback: () => void, delayMs: number): unknown {
        return Reflect.apply(schedule, schedulerValue, [callback, delayMs]);
      },
      cancel(handle: unknown): void {
        Reflect.apply(cancel, schedulerValue, [handle]);
      },
    }),
  });
}

function providerIdsFrom(value: unknown): readonly RpcProviderId[] {
  if (!Array.isArray(value) || isProxy(value) || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length: unknown = lengthDescriptor !== undefined && 'value' in lengthDescriptor
    ? lengthDescriptor.value as unknown : undefined;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1
    || length > RPC_PROVIDER_IDS.length) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) throw new TypeError();
  const ids: RpcProviderId[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const id: unknown = descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
      ? descriptor.value as unknown : undefined;
    if (!isRpcProviderId(id) || id !== RPC_PROVIDER_IDS[index]) throw new TypeError();
    ids.push(id);
  }
  return Object.freeze(ids);
}

function providerPairFrom(value: unknown, expectedId: RpcProviderId): RpcProviderPair {
  try {
    const pair = exactOwnData(value, ['id', 'httpUrl', 'websocketUrl']);
    if (pair.id !== expectedId || typeof pair.httpUrl !== 'string'
      || typeof pair.websocketUrl !== 'string') throw new TypeError();
    return Object.freeze({
      id: expectedId,
      httpUrl: pair.httpUrl,
      websocketUrl: pair.websocketUrl,
    });
  } catch {
    throw configurationError();
  }
}

type UnknownMethod = (...parameters: never[]) => unknown;

// The return-only type binds a descriptor snapshot without invoking the method.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function dataMethod<TMethod extends UnknownMethod>(value: object, key: string): TMethod {
  let cursor: object | null = value;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function'
        || isProxy(descriptor.value)) throw new TypeError();
      return descriptor.value as TMethod;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new TypeError();
}

function objectReceiver(value: unknown): object {
  if (!objectValue(value)) throw new TypeError();
  return value;
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError();
  }
  return descriptor.value;
}

function exactOwnData(value: unknown, expectedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!objectValue(value)) throw new TypeError();
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
    throw new TypeError();
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError();
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function objectValue(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isProxy(value);
}

function configurationError(): TypeError {
  const error = new TypeError('WebSocket failover supervisor configuration is invalid.');
  Object.freeze(error);
  return error;
}
