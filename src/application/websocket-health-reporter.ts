import { isProxy } from 'node:util/types';
import {
  assertValidWebSocketHealthSnapshot,
  MAX_WEBSOCKET_HEALTH_SLOT,
  type WebSocketHealthPhase,
  type WebSocketHealthSnapshot,
} from '../domain/websocket-health.js';
import type { TransactionNotification } from '../domain/transaction-ingestion.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';
import type {
  WebSocketHealthRepository,
  WebSocketHealthTransition,
} from '../ports/websocket-health-repository.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_SHUTDOWN_TIMEOUT_MS = 120_000;

export const WEBSOCKET_HEALTH_REPORTER_ERROR_CODES = Object.freeze([
  'STATE_CONFLICT',
  'TRANSITION_FAILED',
  'ENQUEUE_FAILED',
  'OBSERVATION_FAILED',
  'SHUTDOWN_TIMEOUT',
  'CLEANUP_FAILED',
] as const);

export type WebSocketHealthReporterErrorCode =
  (typeof WEBSOCKET_HEALTH_REPORTER_ERROR_CODES)[number];

export interface WebSocketHealthReporterScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface WebSocketHealthReporterOptions {
  readonly touchIntervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly scheduler?: WebSocketHealthReporterScheduler;
}

export class WebSocketHealthReporterError extends Error {
  public constructor(public readonly code: WebSocketHealthReporterErrorCode) {
    super('WebSocket health reporter operation failed.');
    this.name = 'WebSocketHealthReporterError';
    Object.freeze(this);
  }
}

const systemScheduler: WebSocketHealthReporterScheduler = Object.freeze({
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  cancel(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

export class PersistentWebSocketHealthReporter {
  private readonly touchIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly scheduler: WebSocketHealthReporterScheduler;
  private currentSnapshot: WebSocketHealthSnapshot | null = null;
  private currentPhase: WebSocketHealthPhase = 'STOPPED';
  private degraded = false;
  private touching = false;
  private touchOwnerGeneration: bigint | null = null;
  private touchTimer: unknown = null;
  private touchSequence = 0;
  private touchRequested = false;
  private touchInFlight: Promise<void> | null = null;
  private lifecycleTransitionTail: Promise<void> | null = null;
  private permanentlyClosed = false;
  private stopPromise: Promise<void> | null = null;

  public constructor(
    private readonly inbox: Pick<TransactionInboxRepository, 'enqueue'>,
    private readonly health: WebSocketHealthRepository,
    options: WebSocketHealthReporterOptions,
  ) {
    const validated = validateOptions(options);
    this.touchIntervalMs = validated.touchIntervalMs;
    this.shutdownTimeoutMs = validated.shutdownTimeoutMs;
    this.scheduler = validated.scheduler;
  }

  public state(): WebSocketHealthPhase {
    return this.degraded ? 'DEGRADED' : this.currentPhase;
  }

  public transition(input: WebSocketHealthTransition): Promise<WebSocketHealthSnapshot> {
    if (this.permanentlyClosed) return Promise.reject(reporterError('STATE_CONFLICT'));
    const predecessor = this.lifecycleTransitionTail;
    let releaseFence: () => void = () => undefined;
    const fence = new Promise<void>((resolve) => { releaseFence = resolve; });
    this.lifecycleTransitionTail = fence;
    return new Promise<WebSocketHealthSnapshot>((resolve, reject) => {
      const finish = (): void => {
        if (this.lifecycleTransitionTail === fence) this.lifecycleTransitionTail = null;
        releaseFence();
      };
      const start = (): void => {
        void this.persistTransition(input).then(
          (snapshot) => {
            finish();
            resolve(snapshot);
          },
          () => {
            finish();
            reject(reporterError('TRANSITION_FAILED'));
          },
        );
      };
      if (predecessor === null) start();
      else void predecessor.then(start);
    });
  }

  private persistTransition(input: WebSocketHealthTransition): Promise<WebSocketHealthSnapshot> {
    let persistence: Promise<WebSocketHealthSnapshot>;
    try {
      persistence = this.health.transition(input);
    } catch {
      this.degraded = true;
      return Promise.reject(reporterError('TRANSITION_FAILED'));
    }
    return Promise.resolve(persistence).then(
      (value) => {
        let snapshot: WebSocketHealthSnapshot;
        try {
          snapshot = validatedSnapshot(value, 'TRANSITION_FAILED');
        } catch {
          this.degraded = true;
          throw reporterError('TRANSITION_FAILED');
        }
        this.currentSnapshot = snapshot;
        this.currentPhase = snapshot.phase;
        if (!this.permanentlyClosed) this.degraded = false;
        return snapshot;
      },
      () => {
        this.degraded = true;
        throw reporterError('TRANSITION_FAILED');
      },
    );
  }

  public async observe(
    notification: TransactionNotification,
    ownerGeneration: bigint,
    sessionGeneration: bigint,
  ): Promise<void> {
    let slot: bigint;
    try {
      slot = notification.slot;
      if (typeof slot !== 'bigint' || slot < 0n || slot > MAX_WEBSOCKET_HEALTH_SLOT) {
        throw reporterError('OBSERVATION_FAILED');
      }
    } catch {
      this.degraded = true;
      throw reporterError('OBSERVATION_FAILED');
    }
    try {
      await this.inbox.enqueue(notification);
    } catch {
      this.degraded = true;
      throw reporterError('ENQUEUE_FAILED');
    }
    try {
      const result: unknown = await this.health.recordObservation({
        ownerGeneration,
        sessionGeneration,
        slot,
      });
      if (result !== 'RECORDED' && result !== 'STALE_SESSION') {
        throw reporterError('OBSERVATION_FAILED');
      }
    } catch {
      this.degraded = true;
      throw reporterError('OBSERVATION_FAILED');
    }
  }

  public startTouch(snapshotValue: WebSocketHealthSnapshot): void {
    if (this.permanentlyClosed || this.touching) throw reporterError('STATE_CONFLICT');
    const snapshot = validatedSnapshot(snapshotValue, 'STATE_CONFLICT');
    if (snapshot.supervision !== 'ACTIVE' || snapshot.ownerGeneration === 0n) {
      throw reporterError('STATE_CONFLICT');
    }
    this.currentSnapshot = snapshot;
    this.currentPhase = snapshot.phase;
    this.degraded = false;
    this.touchOwnerGeneration = snapshot.ownerGeneration;
    this.touching = true;
    if (!this.scheduleTouch()) {
      this.touching = false;
      throw reporterError('STATE_CONFLICT');
    }
  }

  public stop(cleanup: () => Promise<void>): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.permanentlyClosed = true;
    this.touching = false;
    this.touchRequested = false;
    this.touchSequence += 1;
    if (this.touchTimer !== null) {
      try {
        this.scheduler.cancel(this.touchTimer);
      } catch {
        this.degraded = true;
      }
      this.touchTimer = null;
    }
    const operation = this.performStop(
      cleanup,
      this.lifecycleTransitionTail,
      this.touchInFlight,
    );
    this.stopPromise = operation;
    return operation;
  }

  private scheduleTouch(): boolean {
    if (!this.touching || this.touchTimer !== null) return true;
    const sequence = ++this.touchSequence;
    try {
      this.touchTimer = this.scheduler.schedule(() => {
        if (!this.touching || sequence !== this.touchSequence) return;
        this.touchTimer = null;
        if (!this.scheduleTouch()) {
          this.touching = false;
          return;
        }
        this.requestTouch();
      }, this.touchIntervalMs);
      return true;
    } catch {
      this.degraded = true;
      return false;
    }
  }

  private requestTouch(): void {
    if (!this.touching) return;
    if (this.touchInFlight !== null) {
      this.touchRequested = true;
      return;
    }
    const ownerGeneration = this.touchOwnerGeneration;
    if (ownerGeneration === null) {
      this.degraded = true;
      return;
    }
    let dependency: Promise<void>;
    try {
      dependency = this.health.touch(ownerGeneration);
    } catch {
      dependency = Promise.reject(new Error());
    }
    const operation = Promise.resolve(dependency);
    this.touchInFlight = operation;
    void operation.then(
      () => { this.finishTouch(operation, false); },
      () => { this.finishTouch(operation, true); },
    );
  }

  private finishTouch(operation: Promise<void>, failed: boolean): void {
    if (this.touchInFlight === operation) this.touchInFlight = null;
    if (failed) this.degraded = true;
    if (!this.touching) return;
    if (this.touchRequested) {
      this.touchRequested = false;
      this.requestTouch();
      return;
    }
  }

  private async performStop(
    cleanup: () => Promise<void>,
    lifecycleFence: Promise<void> | null,
    pendingTouch: Promise<void> | null,
  ): Promise<void> {
    if (lifecycleFence !== null) {
      const lifecycleResult = await settleWithin(
        lifecycleFence,
        this.shutdownTimeoutMs,
        this.scheduler,
      );
      if (lifecycleResult !== 'complete') {
        this.degraded = true;
        throw reporterError(
          lifecycleResult === 'timeout' ? 'SHUTDOWN_TIMEOUT' : 'TRANSITION_FAILED',
        );
      }
    }
    const initial = this.currentSnapshot;
    if (initial === null) {
      this.degraded = true;
      throw reporterError('STATE_CONFLICT');
    }
    const stoppingResult = await this.boundedTransition(stopTransition(initial, 'STOPPING'));
    if (stoppingResult.kind !== 'complete') {
      this.degraded = true;
      throw reporterError(
        stoppingResult.kind === 'timeout' ? 'SHUTDOWN_TIMEOUT' : 'TRANSITION_FAILED',
      );
    }

    if (pendingTouch !== null) {
      const touchResult = await settleWithin(
        pendingTouch,
        this.shutdownTimeoutMs,
        this.scheduler,
      );
      if (touchResult !== 'complete') {
        this.degraded = true;
        throw reporterError(
          touchResult === 'timeout' ? 'SHUTDOWN_TIMEOUT' : 'CLEANUP_FAILED',
        );
      }
    }

    let cleanupOperation: Promise<void>;
    try {
      cleanupOperation = Promise.resolve(cleanup());
    } catch {
      cleanupOperation = Promise.reject(new Error());
    }
    const cleanupResult = await settleWithin(
      cleanupOperation,
      this.shutdownTimeoutMs,
      this.scheduler,
    );
    if (cleanupResult !== 'complete') {
      await this.persistCleanupFailure(stoppingResult.value);
      this.degraded = true;
      throw reporterError(
        cleanupResult === 'timeout' ? 'SHUTDOWN_TIMEOUT' : 'CLEANUP_FAILED',
      );
    }

    const stoppedResult = await this.boundedTransition(
      stopTransition(stoppingResult.value, 'STOPPED'),
    );
    if (stoppedResult.kind !== 'complete') {
      this.degraded = true;
      throw reporterError(
        stoppedResult.kind === 'timeout' ? 'SHUTDOWN_TIMEOUT' : 'TRANSITION_FAILED',
      );
    }
    this.currentSnapshot = stoppedResult.value;
    this.currentPhase = 'STOPPED';
    this.degraded = false;
  }

  private async persistCleanupFailure(snapshot: WebSocketHealthSnapshot): Promise<void> {
    const result = await this.boundedTransition(cleanupFailureTransition(snapshot));
    if (result.kind === 'complete') {
      this.currentSnapshot = result.value;
      this.currentPhase = 'DEGRADED';
    }
  }

  private boundedTransition(
    input: WebSocketHealthTransition,
  ): Promise<SettledValue<WebSocketHealthSnapshot>> {
    return settleValueWithin(
      this.persistTransition(input),
      this.shutdownTimeoutMs,
      this.scheduler,
    );
  }
}

type Settlement = 'complete' | 'failed' | 'timeout';
type SettledValue<TValue> =
  | Readonly<{ kind: 'complete'; value: TValue }>
  | Readonly<{ kind: 'failed' | 'timeout' }>;

async function settleWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
  scheduler: WebSocketHealthReporterScheduler,
): Promise<Settlement> {
  const result = await settleValueWithin(operation, timeoutMs, scheduler);
  return result.kind;
}

function settleValueWithin<TValue>(
  operation: Promise<TValue>,
  timeoutMs: number,
  scheduler: WebSocketHealthReporterScheduler,
): Promise<SettledValue<TValue>> {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutHandle: unknown;
    const finish = (result: SettledValue<TValue>): void => {
      if (settled) return;
      settled = true;
      try {
        scheduler.cancel(timeoutHandle);
      } catch {
        resolve(Object.freeze({ kind: 'failed' as const }));
        return;
      }
      resolve(result);
    };
    try {
      timeoutHandle = scheduler.schedule(() => {
        finish(Object.freeze({ kind: 'timeout' as const }));
      }, timeoutMs);
    } catch {
      resolve(Object.freeze({ kind: 'failed' as const }));
      return;
    }
    void operation.then(
      (value) => { finish(Object.freeze({ kind: 'complete' as const, value })); },
      () => { finish(Object.freeze({ kind: 'failed' as const })); },
    );
  });
}

function stopTransition(
  snapshot: WebSocketHealthSnapshot,
  phase: 'STOPPING' | 'STOPPED',
): WebSocketHealthTransition {
  return Object.freeze({
    ownerGeneration: snapshot.ownerGeneration,
    expectedRevision: snapshot.revision,
    phase,
    providerId: phase === 'STOPPED' ? null : snapshot.providerId,
    activeSessionGeneration: phase === 'STOPPED' ? null : snapshot.activeSessionGeneration,
    candidateProviderId: phase === 'STOPPED' ? null : snapshot.candidateProviderId,
    candidateSessionGeneration: phase === 'STOPPED'
      ? null
      : snapshot.candidateSessionGeneration,
    acknowledged: phase === 'STOPPED' ? false : snapshot.acknowledgedAtMs !== null,
    disconnectReasonCode: null,
    recoveryStatus: snapshot.recovery.status,
    recoveryReasonCode: snapshot.recovery.reasonCode,
  });
}

function cleanupFailureTransition(
  snapshot: WebSocketHealthSnapshot,
): WebSocketHealthTransition {
  return Object.freeze({
    ownerGeneration: snapshot.ownerGeneration,
    expectedRevision: snapshot.revision,
    phase: 'DEGRADED',
    providerId: snapshot.providerId,
    activeSessionGeneration: snapshot.activeSessionGeneration,
    candidateProviderId: snapshot.candidateProviderId,
    candidateSessionGeneration: snapshot.candidateSessionGeneration,
    acknowledged: snapshot.acknowledgedAtMs !== null,
    disconnectReasonCode: 'CLEANUP_FAILED',
    recoveryStatus: 'FAILED',
    recoveryReasonCode: 'SESSION_FAILURE',
  });
}

function validatedSnapshot(
  value: unknown,
  code: WebSocketHealthReporterErrorCode,
): WebSocketHealthSnapshot {
  try {
    assertValidWebSocketHealthSnapshot(value);
    return value;
  } catch {
    throw reporterError(code);
  }
}

function validateOptions(value: unknown): Readonly<{
  touchIntervalMs: number;
  shutdownTimeoutMs: number;
  scheduler: WebSocketHealthReporterScheduler;
}> {
  try {
    const options = exactOwnData(value, ['touchIntervalMs', 'shutdownTimeoutMs'], ['scheduler']);
    const touchIntervalMs = options.touchIntervalMs;
    const shutdownTimeoutMs = options.shutdownTimeoutMs;
    const scheduler = options.scheduler === undefined
      ? systemScheduler
      : schedulerFrom(options.scheduler);
    if (!Number.isSafeInteger(touchIntervalMs)
      || (touchIntervalMs as number) <= 0
      || (touchIntervalMs as number) > MAX_TIMER_DELAY_MS
      || !Number.isSafeInteger(shutdownTimeoutMs)
      || (shutdownTimeoutMs as number) <= 0
      || (shutdownTimeoutMs as number) > MAX_SHUTDOWN_TIMEOUT_MS) {
      throw new TypeError();
    }
    return Object.freeze({
      touchIntervalMs: touchIntervalMs as number,
      shutdownTimeoutMs: shutdownTimeoutMs as number,
      scheduler,
    });
  } catch {
    throw reporterError('STATE_CONFLICT');
  }
}

function schedulerFrom(value: unknown): WebSocketHealthReporterScheduler {
  const scheduler = exactOwnData(value, ['schedule', 'cancel']);
  if (typeof scheduler.schedule !== 'function' || typeof scheduler.cancel !== 'function') {
    throw new TypeError();
  }
  const receiver = value as object;
  const schedule = scheduler.schedule as WebSocketHealthReporterScheduler['schedule'];
  const cancel = scheduler.cancel as WebSocketHealthReporterScheduler['cancel'];
  return Object.freeze({
    schedule(callback: () => void, delayMs: number): unknown {
      return Reflect.apply(schedule, receiver, [callback, delayMs]);
    },
    cancel(handle: unknown): void {
      Reflect.apply(cancel, receiver, [handle]);
    },
  });
}

function exactOwnData(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw new TypeError();
  }
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  const allowedKeys = [...requiredKeys, ...optionalKeys];
  if (keys.length < requiredKeys.length || keys.length > allowedKeys.length
    || requiredKeys.some((key) => !keys.includes(key))
    || keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    throw new TypeError();
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of allowedKeys) {
    if (!keys.includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError();
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function reporterError(code: WebSocketHealthReporterErrorCode): WebSocketHealthReporterError {
  return new WebSocketHealthReporterError(code);
}
