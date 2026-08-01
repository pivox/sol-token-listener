import type { ListenerRuntimeState } from '../domain/transaction-ingestion.js';
import type { ListenerRuntime } from '../ports/listener-runtime.js';
import type { ApiProjectionPipelineState } from '../storage/api-projection.repository.js';

export type ListenerRuntimeFailureStage =
  | 'rpc-health'
  | 'scanner-scan'
  | 'subscriber-start'
  | 'worker-start'
  | 'reconciler-start'
  | 'heartbeat-start'
  | 'subscriber-close'
  | 'scanner-close'
  | 'reconciler-close'
  | 'worker-close'
  | 'worker-timeout'
  | 'heartbeat-stop';

export interface ListenerRuntimeFailure {
  readonly stage: ListenerRuntimeFailureStage;
  readonly errorName: 'ListenerDependencyError' | 'ListenerTimeoutError';
}

export class ListenerRuntimeError extends Error {
  public readonly failures: readonly ListenerRuntimeFailure[];

  public constructor(failures: readonly ListenerRuntimeFailure[]) {
    super('Solana listener runtime operation failed.');
    this.name = 'ListenerRuntimeError';
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
    Object.freeze(this);
  }
}

interface RuntimeComponent {
  start(): Promise<void>;
  close(): Promise<void>;
  state(): ListenerRuntimeState;
}

interface RuntimeScanner {
  scan(): Promise<unknown>;
  close(): Promise<void>;
  state(): ListenerRuntimeState;
}

interface RuntimeHeartbeat {
  start(): Promise<void>;
  stop(state: 'STOPPED'): Promise<void>;
  state(): ListenerRuntimeState;
}

export interface ListenerRuntimeDependencies {
  readonly rpc: { readonly checkHealth: () => Promise<unknown> };
  readonly scanner: RuntimeScanner;
  readonly subscriber: RuntimeComponent;
  readonly worker: RuntimeComponent;
  readonly reconciler: RuntimeComponent;
  readonly heartbeat: RuntimeHeartbeat;
}

export interface ListenerRuntimeOptions {
  readonly shutdownTimeoutMs: number;
}

export class SolanaListenerRuntime implements ListenerRuntime {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private started = false;
  private permanentlyClosed = false;

  public constructor(
    private readonly dependencies: ListenerRuntimeDependencies,
    private readonly options: ListenerRuntimeOptions,
  ) {
    if (!Number.isSafeInteger(options.shutdownTimeoutMs)
      || options.shutdownTimeoutMs <= 0
      || options.shutdownTimeoutMs > 120_000) {
      throw new TypeError('Listener shutdown timeout is invalid.');
    }
  }

  public start(): Promise<void> {
    if (this.permanentlyClosed) {
      return Promise.reject(new ListenerRuntimeError([failure('rpc-health')]));
    }
    if (this.started) return Promise.resolve();
    if (this.startPromise !== null) return this.startPromise;
    this.currentState = 'STARTING';
    const operation = this.performStart();
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
    this.currentState = 'STOPPING';
    const operation = this.performClose();
    this.closePromise = operation;
    return operation;
  }

  public state(): ListenerRuntimeState {
    if (this.currentState !== 'RUNNING') return this.currentState;
    return this.componentStates().some((state) => state === 'DEGRADED')
      ? 'DEGRADED'
      : 'RUNNING';
  }

  public pipelineState(): ApiProjectionPipelineState {
    const state = this.state();
    const pipeline = state === 'RUNNING'
      ? 'RUNNING'
      : state === 'STOPPED'
        ? 'STOPPED'
        : 'DEGRADED';
    return Object.freeze({ httpAvailable: true, pumpfun: pipeline, pumpswap: pipeline });
  }

  private async performStart(): Promise<void> {
    const started: ('subscriber' | 'worker' | 'reconciler' | 'heartbeat')[] = [];
    let stage: ListenerRuntimeFailureStage = 'rpc-health';
    try {
      await this.dependencies.rpc.checkHealth();
      stage = 'scanner-scan';
      await this.dependencies.scanner.scan();
      stage = 'subscriber-start';
      await this.dependencies.subscriber.start();
      started.push('subscriber');
      stage = 'worker-start';
      await this.dependencies.worker.start();
      started.push('worker');
      stage = 'reconciler-start';
      await this.dependencies.reconciler.start();
      started.push('reconciler');
      stage = 'heartbeat-start';
      await this.dependencies.heartbeat.start();
      started.push('heartbeat');
      this.started = true;
      this.currentState = 'RUNNING';
    } catch {
      const failures: ListenerRuntimeFailure[] = [failure(stage)];
      await this.rollbackStart(started, failures);
      this.currentState = 'DEGRADED';
      throw new ListenerRuntimeError(failures);
    }
  }

  private async rollbackStart(
    started: readonly ('subscriber' | 'worker' | 'reconciler' | 'heartbeat')[],
    failures: ListenerRuntimeFailure[],
  ): Promise<void> {
    for (let index = started.length - 1; index >= 0; index -= 1) {
      const component = started[index];
      if (component === undefined) continue;
      const closeStage = `${component}-${component === 'heartbeat' ? 'stop' : 'close'}` as ListenerRuntimeFailureStage;
      try {
        if (component === 'heartbeat') await this.dependencies.heartbeat.stop('STOPPED');
        else await this.dependencies[component].close();
      } catch {
        failures.push(failure(closeStage));
      }
    }
  }

  private async performClose(): Promise<void> {
    const starting = this.startPromise;
    if (starting !== null) {
      try { await starting; } catch { /* startup already rolled back */ }
    }
    if (!this.started) {
      this.currentState = 'STOPPED';
      return;
    }

    const failures: ListenerRuntimeFailure[] = [];
    let workerClosing: Promise<void>;
    try { workerClosing = this.dependencies.worker.close(); }
    catch { workerClosing = Promise.reject(new Error('worker close')); }
    const workerResultPromise = settleWithin(workerClosing, this.options.shutdownTimeoutMs);
    await capture(() => this.dependencies.subscriber.close(), 'subscriber-close', failures);
    await capture(() => this.dependencies.scanner.close(), 'scanner-close', failures);
    await capture(() => this.dependencies.reconciler.close(), 'reconciler-close', failures);
    const workerResult = await workerResultPromise;
    if (workerResult === 'timeout') failures.push(timeoutFailure());
    if (workerResult === 'failed') failures.push(failure('worker-close'));
    await capture(() => this.dependencies.heartbeat.stop('STOPPED'), 'heartbeat-stop', failures);
    this.started = false;
    this.currentState = failures.length === 0 ? 'STOPPED' : 'DEGRADED';
    if (failures.length > 0) throw new ListenerRuntimeError(failures);
  }

  private componentStates(): readonly ListenerRuntimeState[] {
    return [
      this.dependencies.scanner.state(),
      this.dependencies.subscriber.state(),
      this.dependencies.worker.state(),
      this.dependencies.reconciler.state(),
      this.dependencies.heartbeat.state(),
    ];
  }
}

async function capture(
  operation: () => Promise<void>,
  stage: ListenerRuntimeFailureStage,
  failures: ListenerRuntimeFailure[],
): Promise<void> {
  try { await operation(); } catch { failures.push(failure(stage)); }
}

async function settleWithin(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<'complete' | 'failed' | 'timeout'> {
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  const timeout = new Promise<'timeout'>((resolve) => {
    timer.handle = setTimeout(() => { resolve('timeout'); }, timeoutMs);
  });
  const settled: Promise<'complete' | 'failed'> = operation.then(
    () => 'complete',
    () => 'failed',
  );
  const result = await Promise.race([settled, timeout]);
  if (timer.handle !== undefined) clearTimeout(timer.handle);
  return result;
}

function failure(stage: ListenerRuntimeFailureStage): ListenerRuntimeFailure {
  return Object.freeze({ stage, errorName: 'ListenerDependencyError' });
}

function timeoutFailure(): ListenerRuntimeFailure {
  return Object.freeze({ stage: 'worker-timeout', errorName: 'ListenerTimeoutError' });
}
