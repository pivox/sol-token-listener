import { PublicKey, type LogsCallback } from '@solana/web3.js';
import bs58 from 'bs58';
import type { TransactionNotification } from '../../domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../../markets/pumpswap/constants.js';
import type { TransactionInboxRepository } from '../../ports/transaction-inbox-repository.js';

export const PROGRAM_SUBSCRIBER_COMMITMENT = 'processed' as const;
export const MAX_PROGRAM_LOG_SIGNATURE_LENGTH = 88;

export type ProgramSubscriberState =
  | 'STARTING'
  | 'RUNNING'
  | 'DEGRADED'
  | 'STOPPING'
  | 'STOPPED';

export type ProgramSubscriberErrorStage =
  | 'lifecycle'
  | 'subscribe'
  | 'notification'
  | 'enqueue'
  | 'unsubscribe';

export type ProgramLogsCallback = LogsCallback;

export interface ProgramLogsConnection {
  onLogs(
    filter: PublicKey,
    callback: ProgramLogsCallback,
    commitment: typeof PROGRAM_SUBSCRIBER_COMMITMENT,
  ): unknown;
  watchSubscriptionState(id: number, callback: (state: string) => void): () => void;
  removeOnLogsListener(id: number): Promise<void>;
}

export type ProgramSubscriberRepository = Pick<TransactionInboxRepository, 'enqueue'>;

export interface ProgramSubscriberOptions {
  readonly now?: () => number;
  readonly subscriptionAckTimeoutMs?: number;
  readonly programIds?: readonly string[];
}

export interface ProgramSubscriberMetrics {
  readonly eventsReceived: number;
  readonly enqueuesCompleted: number;
}

export class ProgramSubscriberError extends Error {
  public constructor(
    public readonly stage: ProgramSubscriberErrorStage,
    public readonly failureCount = 1,
  ) {
    super('Program subscriber operation failed.');
    this.name = 'ProgramSubscriberError';
    Object.freeze(this);
  }
}

const PROGRAM_IDS = Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID] as const);

export class SolanaProgramSubscriber {
  private readonly now: () => number;
  private readonly subscriptionAckTimeoutMs: number;
  private readonly programIds: readonly string[];
  private readonly listenerIds: number[] = [];
  private readonly stateWatchers: (() => void)[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private accepting = false;
  private permanentlyClosed = false;
  private currentState: ProgramSubscriberState = 'STOPPED';
  private currentError: ProgramSubscriberError | null = null;
  private eventsReceived = 0;
  private enqueuesCompleted = 0;

  public constructor(
    private readonly connection: ProgramLogsConnection,
    private readonly repository: ProgramSubscriberRepository,
    options: ProgramSubscriberOptions = {},
  ) {
    const now = clockOption(options);
    this.now = now ?? Date.now;
    this.subscriptionAckTimeoutMs = ackTimeoutOption(options);
    const programIds = options.programIds ?? PROGRAM_IDS;
    if (programIds.length === 0 || new Set(programIds).size !== programIds.length) {
      throw new TypeError('Program subscriber program list is invalid.');
    }
    this.programIds = Object.freeze([...programIds]);
  }

  public get state(): ProgramSubscriberState {
    return this.currentState;
  }

  public get lastError(): ProgramSubscriberError | null {
    return this.currentError;
  }

  public metrics(): ProgramSubscriberMetrics {
    return Object.freeze({
      eventsReceived: this.eventsReceived,
      enqueuesCompleted: this.enqueuesCompleted,
    });
  }

  public async drainDurableEnqueues(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  public start(): Promise<void> {
    if (this.permanentlyClosed || this.currentState === 'STOPPING') {
      return Promise.reject(new ProgramSubscriberError('lifecycle'));
    }
    if (!this.accepting && this.listenerIds.length > 0) {
      return Promise.reject(new ProgramSubscriberError('lifecycle'));
    }
    if (this.currentState === 'RUNNING' || this.currentState === 'DEGRADED') {
      return Promise.resolve();
    }
    if (this.startPromise !== null) return this.startPromise;

    this.currentState = 'STARTING';
    const operation = this.installListeners();
    this.startPromise = operation;
    void operation.then(
      () => { if (this.startPromise === operation) this.startPromise = null; },
      () => { if (this.startPromise === operation) this.startPromise = null; },
    );
    return operation;
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.permanentlyClosed = true;
    this.accepting = false;
    this.currentState = 'STOPPING';
    const operation = this.performClose();
    this.closePromise = operation;
    void operation.then(
      () => { if (this.closePromise === operation) this.closePromise = null; },
      () => { if (this.closePromise === operation) this.closePromise = null; },
    );
    return operation;
  }

  private async installListeners(): Promise<void> {
    const installed: number[] = [];
    const watchers: (() => void)[] = [];
    const acknowledged = new Set<number>();
    try {
      for (const programId of this.programIds) {
        const listenerId = this.connection.onLogs(
          new PublicKey(programId),
          (notification, context) => { this.receive(programId, notification, context); },
          PROGRAM_SUBSCRIBER_COMMITMENT,
        );
        if (!validListenerId(listenerId) || installed.includes(listenerId)) {
          throw new ProgramSubscriberError('subscribe');
        }
        installed.push(listenerId);
        const unwatch = this.connection.watchSubscriptionState(listenerId, (state) => {
          if (state === 'subscribed') {
            acknowledged.add(listenerId);
          } else if (acknowledged.has(listenerId) && this.accepting) {
            this.accepting = false;
            this.currentState = 'DEGRADED';
            this.currentError = new ProgramSubscriberError('subscribe');
          }
        });
        if (typeof unwatch !== 'function') throw new ProgramSubscriberError('subscribe');
        watchers.push(unwatch);
      }
      this.accepting = true;
      await this.waitForAcknowledgements(installed, acknowledged);
    } catch {
      this.accepting = false;
      watchers.forEach((unwatch) => { unwatch(); });
      const failedIds = await removeListeners(this.connection, installed);
      this.listenerIds.push(...failedIds);
      this.currentState = failedIds.length === 0 ? 'STOPPED' : 'DEGRADED';
      const error = new ProgramSubscriberError('subscribe', failedIds.length + 1);
      this.currentError = error;
      throw error;
    }

    if (this.permanentlyClosed) {
      const failedIds = await removeListeners(this.connection, installed);
      this.listenerIds.push(...failedIds);
      this.currentState = failedIds.length === 0 ? 'STOPPED' : 'DEGRADED';
      if (failedIds.length > 0) {
        const error = new ProgramSubscriberError('unsubscribe', failedIds.length);
        this.currentError = error;
        throw error;
      }
      return;
    }

    this.listenerIds.push(...installed);
    this.stateWatchers.push(...watchers);
    this.accepting = true;
    this.currentState = 'RUNNING';
    this.currentError = null;
  }

  private async waitForAcknowledgements(
    installed: readonly number[],
    acknowledged: ReadonlySet<number>,
  ): Promise<void> {
    const deadline = Date.now() + this.subscriptionAckTimeoutMs;
    while (installed.some((id) => !acknowledged.has(id))) {
      if (this.permanentlyClosed || this.currentState === 'DEGRADED') {
        throw new ProgramSubscriberError('subscribe');
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new ProgramSubscriberError('subscribe');
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remainingMs, 10)));
    }
  }

  private receive(programId: string, value: unknown, context: unknown): void {
    if (!this.accepting) return;
    let notification: TransactionNotification | null;
    try {
      notification = snapshotNotification(programId, value, context, this.readNow());
    } catch {
      this.report('notification');
      return;
    }
    this.eventsReceived += 1;
    if (notification === null) return;

    const task = Promise.resolve()
      .then(async () => {
        await this.repository.enqueue(notification);
        this.enqueuesCompleted += 1;
      })
      .catch(() => { this.report('enqueue'); });
    this.inFlight.add(task);
    void task.then(() => { this.inFlight.delete(task); });
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new ProgramSubscriberError('notification');
    }
    return value;
  }

  private report(stage: Extract<ProgramSubscriberErrorStage, 'notification' | 'enqueue'>): void {
    const error = new ProgramSubscriberError(stage);
    this.currentError = error;
    if (!this.permanentlyClosed) this.currentState = 'DEGRADED';
  }

  private async performClose(): Promise<void> {
    const starting = this.startPromise;
    if (starting !== null) {
      try {
        await starting;
      } catch {
        // Startup owns cleanup and reports its own stable error.
      }
    }

    const ids = this.listenerIds.splice(0);
    this.stateWatchers.splice(0).forEach((unwatch) => { unwatch(); });
    const failedIds = await removeListeners(this.connection, ids);
    this.listenerIds.push(...failedIds);
    await Promise.all([...this.inFlight]);
    this.currentState = failedIds.length === 0 ? 'STOPPED' : 'DEGRADED';
    if (failedIds.length > 0) {
      const error = new ProgramSubscriberError('unsubscribe', failedIds.length);
      this.currentError = error;
      throw error;
    }
  }
}

export function snapshotNotification(
  programId: string,
  value: unknown,
  context: unknown,
  observedAtMs: number,
): TransactionNotification | null {
  const record = objectRecord(value);
  const signature = dataProperty(record, 'signature');
  const failure = dataProperty(record, 'err');
  const contextRecord = objectRecord(context);
  const slot = dataProperty(contextRecord, 'slot');
  if (!validSignature(signature)
    || typeof slot !== 'number'
    || !Number.isSafeInteger(slot)
    || slot < 0
    || Object.is(slot, -0)) {
    throw new ProgramSubscriberError('notification');
  }
  if (failure !== null) return null;
  return Object.freeze({
    signature,
    slot: BigInt(slot),
    source: 'WEBSOCKET',
    programIds: Object.freeze([programId]),
    confirmationStatus: PROGRAM_SUBSCRIBER_COMMITMENT,
    observedAtMs,
  });
}

function objectRecord(value: unknown): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProgramSubscriberError('notification');
  }
  return value;
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    throw new ProgramSubscriberError('notification');
  }
  return descriptor.value as unknown;
}

function validSignature(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROGRAM_LOG_SIGNATURE_LENGTH
    || Buffer.byteLength(value, 'utf8') > MAX_PROGRAM_LOG_SIGNATURE_LENGTH) {
    return false;
  }
  try {
    const decoded = bs58.decode(value);
    return decoded.byteLength === 64 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

function validListenerId(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

async function removeListeners(
  connection: ProgramLogsConnection,
  ids: readonly number[],
): Promise<readonly number[]> {
  const results = await Promise.allSettled(ids.map(async (id) => {
    await connection.removeOnLogsListener(id);
  }));
  return Object.freeze(ids.filter((_, index) => results[index]?.status === 'rejected'));
}

function clockOption(options: ProgramSubscriberOptions): (() => number) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'now');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError('Program subscriber options are invalid.');
  }
  const value: unknown = descriptor.value;
  if (value === undefined) return undefined;
  if (!isClock(value)) throw new TypeError('Program subscriber clock is invalid.');
  return value;
}

function ackTimeoutOption(options: ProgramSubscriberOptions): number {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(options, 'subscriptionAckTimeoutMs');
    if (descriptor === undefined) return 15_000;
    if (!('value' in descriptor) || descriptor.enumerable !== true) throw new TypeError('invalid');
    const value: unknown = descriptor.value;
    if (value === undefined) return 15_000;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 60_000) {
      throw new TypeError('invalid');
    }
    return value;
  } catch {
    throw new TypeError('Program subscriber acknowledgement timeout is invalid.');
  }
}

function isClock(value: unknown): value is () => number {
  return typeof value === 'function';
}
