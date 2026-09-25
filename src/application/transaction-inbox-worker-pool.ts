import type { TransactionInboxWorkerState } from './transaction-inbox-worker.js';

export interface TransactionInboxWorkerPoolMember {
  readonly state: TransactionInboxWorkerState;
  start(): Promise<void>;
  close(): Promise<void>;
}

export class TransactionInboxWorkerPoolError extends Error {
  public constructor(public readonly stage: 'start' | 'close') {
    super('Transaction inbox worker pool operation failed.');
    this.name = 'TransactionInboxWorkerPoolError';
    Object.freeze(this);
  }
}

export class TransactionInboxWorkerPool {
  private readonly members: readonly TransactionInboxWorkerPoolMember[];
  private started = false;
  private startFailed = false;
  private closing = false;
  private closed = false;
  private closeFailed = false;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  public constructor(members: readonly TransactionInboxWorkerPoolMember[]) {
    if (members.length < 1 || members.length > 4) {
      throw new TypeError('Transaction inbox worker pool size is invalid.');
    }
    this.members = [...members];
  }

  public get state(): TransactionInboxWorkerState {
    if (this.closing && !this.closed) return 'STOPPING';
    if (this.closed) {
      return this.closeFailed || this.members.some((member) => member.state !== 'STOPPED')
        ? 'DEGRADED'
        : 'STOPPED';
    }
    if (!this.started) return 'STOPPED';
    if (this.startFailed) return 'DEGRADED';
    return this.members.every((member) => member.state === 'RUNNING') ? 'RUNNING' : 'DEGRADED';
  }

  public start(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.startPromise !== null) return this.startPromise;
    this.started = true;
    this.startPromise = this.performStart();
    return this.startPromise;
  }

  private async performStart(): Promise<void> {
    const results = await Promise.allSettled(this.members.map(async (member) => member.start()));
    if (results.some((result) => result.status === 'rejected')) {
      this.startFailed = true;
      throw new TransactionInboxWorkerPoolError('start');
    }
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    const results = await Promise.allSettled(this.members.map(async (member) => member.close()));
    this.closed = true;
    if (results.some((result) => result.status === 'rejected')) {
      this.closeFailed = true;
      throw new TransactionInboxWorkerPoolError('close');
    }
  }
}
