import { PublicKey } from '@solana/web3.js';
import { PUMPSWAP_PROGRAM_ID } from '../../markets/pumpswap/constants.js';
import {
  PROGRAM_SUBSCRIBER_COMMITMENT,
  snapshotNotification,
  type ProgramLogsConnection,
  type ProgramSubscriberRepository,
} from './program-subscriber.js';

interface PoolListener {
  readonly id: number;
  readonly unwatch: () => void;
}

interface ListenerHealth {
  // web3 acknowledged the subscription at least once.
  subscribed: boolean;
  // Transient: the socket dropped after an acknowledgement; web3 resubscribes on its own.
  lost: boolean;
  // Sticky: an enqueue or notification parse failed; the listener is replaced at the next sync.
  failed: boolean;
}

type TrackedListener = PoolListener & ListenerHealth;

export interface PoolLogsSubscriberTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface PoolLogsSubscriberOptions {
  /** Upper bound close() waits for in-flight enqueues. Default 5 s. */
  readonly drainTimeoutMs?: number;
  readonly timer?: PoolLogsSubscriberTimer;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

const defaultTimer: PoolLogsSubscriberTimer = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

// One logsSubscribe(mentions: [pool]) per tracked pool. sync and close run on a single promise
// chain so they never interleave. A listener that merely loses its socket is left for web3 to
// resubscribe; one that fails an enqueue or a notification parse is removed at the next sync and
// re-added at the sync after. The finalized pool sweep recovers anything the WebSocket missed.
//
// Why the re-add is deferred: web3.js 1.98.4 keys subscriptions by hash([method, args]), so a new
// onLogs(pool) joins any existing entry for that pool. removeOnLogsListener normally awaits the
// server unsubscribe and the entry is deleted, but when the socket is flagged down (ws error before
// close) `_updateSubscriptions` returns early and the emptied entry stays 'subscribed'. A listener
// re-added at once would join it and never see a 'subscribed' transition, staying unhealthy.
export class PoolLogsSubscriber {
  private readonly listeners = new Map<string, TrackedListener>();
  private readonly inFlight = new Set<Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly drainTimeoutMs: number;
  private readonly timer: PoolLogsSubscriberTimer;

  public constructor(
    private readonly connection: ProgramLogsConnection,
    private readonly repository: ProgramSubscriberRepository,
    private readonly now: () => number = Date.now,
    options: PoolLogsSubscriberOptions = {},
  ) {
    const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1) {
      throw new TypeError('Pool logs subscriber drain timeout is invalid.');
    }
    this.drainTimeoutMs = drainTimeoutMs;
    this.timer = options.timer ?? defaultTimer;
  }

  public sync(pools: readonly string[]): Promise<void> {
    const wanted = new Set(pools);
    return this.enqueueOperation(async () => {
      if (this.closed) return;
      const removed = new Set<string>();
      for (const [pool, listener] of [...this.listeners]) {
        if (!wanted.has(pool) || listener.failed) {
          await this.remove(pool, listener);
          removed.add(pool);
        }
      }
      for (const pool of wanted) {
        // close() may have been requested while a removal above was awaited.
        if (this.isClosed()) return;
        // A pool removed by this sync is re-added at the next one (see the class comment).
        if (!this.listeners.has(pool) && !removed.has(pool)) await this.add(pool);
      }
    });
  }

  public isHealthy(pool: string): boolean {
    const listener = this.listeners.get(pool);
    return listener !== undefined && listener.subscribed && !listener.lost && !listener.failed;
  }

  public async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  public close(): Promise<void> {
    this.closed = true;
    return this.enqueueOperation(async () => {
      try {
        for (const [pool, listener] of [...this.listeners]) await this.remove(pool, listener);
      } finally {
        await this.boundedDrain();
      }
    });
  }

  // A hung enqueue (stalled store) must not block shutdown forever.
  private boundedDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      const handle = this.timer.schedule(resolve, this.drainTimeoutMs);
      void this.drain().then(() => {
        this.timer.cancel(handle);
        resolve();
      });
    });
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private enqueueOperation(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // Never throws: a pool that cannot be subscribed stays unhealthy and is retried at the next sync.
  private async add(pool: string): Promise<void> {
    const health: ListenerHealth = { subscribed: false, lost: false, failed: false };
    let id: number | null = null;
    try {
      const key = new PublicKey(pool);
      const rawId = this.connection.onLogs(
        key,
        (notification, context) => { this.receive(health, notification, context); },
        PROGRAM_SUBSCRIBER_COMMITMENT,
      );
      if (typeof rawId !== 'number' || !Number.isSafeInteger(rawId)) return;
      id = rawId;
      const unwatch = this.connection.watchSubscriptionState(rawId, (subscriptionState) => {
        if (subscriptionState === 'subscribed') {
          health.subscribed = true;
          health.lost = false;
        } else if (health.subscribed) {
          health.lost = true;
        }
      });
      if (typeof unwatch !== 'function') throw new TypeError('Pool log state watcher is invalid.');
      // The map entry and the callbacks share one health object.
      this.listeners.set(pool, Object.assign(health, { id: rawId, unwatch }));
    } catch {
      if (id !== null) await this.removeListenerQuietly(id);
    }
  }

  private async remove(pool: string, listener: PoolListener): Promise<void> {
    if (this.listeners.get(pool) === listener) this.listeners.delete(pool);
    try {
      listener.unwatch();
    } catch {
      // Unwatching is best effort.
    }
    await this.removeListenerQuietly(listener.id);
  }

  private async removeListenerQuietly(id: number): Promise<void> {
    try {
      await this.connection.removeOnLogsListener(id);
    } catch {
      // Best effort per pool: one failed unsubscribe must not block the others.
    }
  }

  private receive(health: ListenerHealth, value: unknown, context: unknown): void {
    if (this.closed) return;
    let notification;
    try {
      notification = snapshotNotification(PUMPSWAP_PROGRAM_ID, value, context, this.now());
    } catch {
      health.failed = true;
      return;
    }
    if (notification === null) return;
    // Events for a pool no longer tracked are still enqueued; the finalized sweep is the backstop.
    const task = Promise.resolve()
      .then(() => this.repository.enqueue(notification))
      .then(() => undefined, () => { health.failed = true; });
    this.inFlight.add(task);
    void task.then(() => { this.inFlight.delete(task); });
  }
}
