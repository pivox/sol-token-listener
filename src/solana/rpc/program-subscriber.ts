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
  removeOnLogsListener(id: number): Promise<void>;
}

export type ProgramSubscriberRepository = Pick<TransactionInboxRepository, 'enqueue'>;

export interface ProgramSubscriberOptions {
  readonly now?: () => number;
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
  private readonly listenerIds: number[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private accepting = false;
  private permanentlyClosed = false;
  private currentState: ProgramSubscriberState = 'STOPPED';
  private currentError: ProgramSubscriberError | null = null;

  public constructor(
    private readonly connection: ProgramLogsConnection,
    private readonly repository: ProgramSubscriberRepository,
    options: ProgramSubscriberOptions = {},
  ) {
    const now = clockOption(options);
    this.now = now ?? Date.now;
  }

  public get state(): ProgramSubscriberState {
    return this.currentState;
  }

  public get lastError(): ProgramSubscriberError | null {
    return this.currentError;
  }

  public start(): Promise<void> {
    if (this.permanentlyClosed || this.currentState === 'STOPPING') {
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
    return operation;
  }

  private async installListeners(): Promise<void> {
    const installed: number[] = [];
    try {
      for (const programId of PROGRAM_IDS) {
        const listenerId = this.connection.onLogs(
          new PublicKey(programId),
          (notification, context) => { this.receive(programId, notification, context); },
          PROGRAM_SUBSCRIBER_COMMITMENT,
        );
        if (!validListenerId(listenerId) || installed.includes(listenerId)) {
          throw new ProgramSubscriberError('subscribe');
        }
        installed.push(listenerId);
      }
    } catch {
      this.accepting = false;
      const cleanupFailures = await removeListeners(this.connection, installed);
      this.currentState = 'STOPPED';
      const error = new ProgramSubscriberError('subscribe', cleanupFailures + 1);
      this.currentError = error;
      throw error;
    }

    if (this.permanentlyClosed) {
      const cleanupFailures = await removeListeners(this.connection, installed);
      this.currentState = 'STOPPED';
      if (cleanupFailures > 0) {
        const error = new ProgramSubscriberError('unsubscribe', cleanupFailures);
        this.currentError = error;
        throw error;
      }
      return;
    }

    this.listenerIds.push(...installed);
    this.accepting = true;
    this.currentState = 'RUNNING';
    this.currentError = null;
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
    if (notification === null) return;

    const task = Promise.resolve()
      .then(async () => { await this.repository.enqueue(notification); })
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
    const cleanupFailures = await removeListeners(this.connection, ids);
    await Promise.all([...this.inFlight]);
    this.currentState = 'STOPPED';
    if (cleanupFailures > 0) {
      const error = new ProgramSubscriberError('unsubscribe', cleanupFailures);
      this.currentError = error;
      throw error;
    }
  }
}

function snapshotNotification(
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
): Promise<number> {
  const results = await Promise.allSettled(ids.map(async (id) => {
    await connection.removeOnLogsListener(id);
  }));
  return results.filter((result) => result.status === 'rejected').length;
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

function isClock(value: unknown): value is () => number {
  return typeof value === 'function';
}
