import type { ListenerRuntimeState } from '../domain/transaction-ingestion.js';
import type { ListenerRuntime } from '../ports/listener-runtime.js';
import type { ApiProjectionPipelineState } from '../storage/api-projection.repository.js';

export type ListenerRuntimeFailureStage =
  | 'rpc-health'
  | 'scanner-scan'
  | 'subscriber-start'
  | 'worker-start'
  | 'paper-worker-start'
  | 'social-worker-start'
  | 'reconciler-start'
  | 'heartbeat-start'
  | 'startup-timeout'
  | 'subscriber-close'
  | 'scanner-close'
  | 'reconciler-close'
  | 'worker-close'
  | 'worker-timeout'
  | 'paper-worker-close'
  | 'paper-worker-timeout'
  | 'social-worker-close'
  | 'social-worker-timeout'
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
  readonly paperWorker: RuntimeComponent;
  readonly socialWorker: RuntimeComponent;
  readonly reconciler: RuntimeComponent;
  readonly heartbeat: RuntimeHeartbeat;
}

export interface ListenerRuntimeOptions {
  readonly shutdownTimeoutMs: number;
}

type ActiveRuntimeResource =
  | 'subscriber' | 'worker' | 'paperWorker' | 'socialWorker' | 'reconciler' | 'heartbeat';

export class SolanaListenerRuntime implements ListenerRuntime {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly activeResources = new Set<ActiveRuntimeResource>();
  private scannerNeedsClose = false;
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
    void operation.catch(() => {
      if (this.closePromise === operation) this.closePromise = null;
    });
    return operation;
  }

  public state(): ListenerRuntimeState {
    if (this.currentState !== 'RUNNING') return this.currentState;
    try {
      return this.componentStates().every((state) => state === 'RUNNING')
        ? 'RUNNING'
        : 'DEGRADED';
    } catch {
      return 'DEGRADED';
    }
  }

  public pipelineState(): ApiProjectionPipelineState {
    if (this.currentState === 'STOPPED') {
      return Object.freeze({
        httpAvailable: true, pumpfun: 'STOPPED', pumpswap: 'STOPPED',
        qualification: 'STOPPED', paperDecision: 'STOPPED', social: 'STOPPED',
      });
    }
    if (this.currentState !== 'RUNNING') {
      return Object.freeze({
        httpAvailable: true, pumpfun: 'DEGRADED', pumpswap: 'DEGRADED',
        qualification: 'DEGRADED', paperDecision: 'DEGRADED', social: 'DEGRADED',
      });
    }
    let chain: 'RUNNING' | 'DEGRADED' = 'DEGRADED';
    let social: ApiProjectionPipelineState['social'] = 'DEGRADED';
    let paperDecision: ApiProjectionPipelineState['paperDecision'] = 'DEGRADED';
    try {
      chain = this.chainComponentStates().every((state) => state === 'RUNNING')
        ? 'RUNNING' : 'DEGRADED';
      const socialState = this.dependencies.socialWorker.state();
      social = socialState === 'RUNNING'
        ? 'RUNNING'
        : socialState === 'STOPPED' ? 'STOPPED' : 'DEGRADED';
      const paperState = this.dependencies.paperWorker.state();
      paperDecision = paperState === 'RUNNING'
        ? 'RUNNING'
        : paperState === 'STOPPED' ? 'STOPPED' : 'DEGRADED';
    } catch {
      // The failing projection stays DEGRADED without leaking the component error.
    }
    return Object.freeze({
      httpAvailable: true, pumpfun: chain, pumpswap: chain, qualification: chain, paperDecision, social,
    });
  }

  private async performStart(): Promise<void> {
    const started: ActiveRuntimeResource[] = [];
    let stage: ListenerRuntimeFailureStage = 'rpc-health';
    try {
      await this.dependencies.rpc.checkHealth();
      this.assertStartOpen();
      stage = 'scanner-scan';
      await this.dependencies.scanner.scan();
      this.assertStartOpen();
      stage = 'subscriber-start';
      await this.dependencies.subscriber.start();
      started.push('subscriber');
      this.activeResources.add('subscriber');
      this.assertStartOpen();
      stage = 'scanner-scan';
      await this.dependencies.scanner.scan();
      this.assertStartOpen();
      stage = 'worker-start';
      await this.dependencies.worker.start();
      started.push('worker');
      this.activeResources.add('worker');
      this.assertStartOpen();
      stage = 'paper-worker-start';
      await this.dependencies.paperWorker.start();
      started.push('paperWorker');
      this.activeResources.add('paperWorker');
      this.assertStartOpen();
      stage = 'social-worker-start';
      await this.dependencies.socialWorker.start();
      started.push('socialWorker');
      this.activeResources.add('socialWorker');
      this.assertStartOpen();
      stage = 'reconciler-start';
      await this.dependencies.reconciler.start();
      started.push('reconciler');
      this.activeResources.add('reconciler');
      this.assertStartOpen();
      stage = 'heartbeat-start';
      await this.dependencies.heartbeat.start();
      started.push('heartbeat');
      this.activeResources.add('heartbeat');
      this.assertStartOpen();
      this.scannerNeedsClose = true;
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
    started: readonly ActiveRuntimeResource[],
    failures: ListenerRuntimeFailure[],
  ): Promise<void> {
    for (let index = started.length - 1; index >= 0; index -= 1) {
      const component = started[index];
      if (component === undefined) continue;
      const closeStage = component === 'heartbeat'
        ? 'heartbeat-stop'
        : component === 'socialWorker'
          ? 'social-worker-close'
          : component === 'paperWorker'
            ? 'paper-worker-close'
            : `${component}-close` as ListenerRuntimeFailureStage;
      try {
        if (component === 'heartbeat') await this.dependencies.heartbeat.stop('STOPPED');
        else await this.dependencies[component].close();
        this.activeResources.delete(component);
      } catch {
        failures.push(failure(closeStage));
      }
    }
  }

  private async performClose(): Promise<void> {
    const deadlineMs = Date.now() + this.options.shutdownTimeoutMs;
    const failures: ListenerRuntimeFailure[] = [];
    const starting = this.startPromise;
    let startupTimedOut = false;
    if (starting !== null) {
      const result = await settleUntil(starting, deadlineMs);
      if (result === 'timeout') {
        startupTimedOut = true;
        failures.push(timeoutFailure('startup-timeout'));
      }
    }
    if (!this.started
      && !startupTimedOut
      && this.activeResources.size === 0
      && !this.scannerNeedsClose) {
      this.currentState = 'STOPPED';
      return;
    }

    const cleanup: {
      readonly resource: ActiveRuntimeResource | 'scanner';
      readonly stage: Extract<ListenerRuntimeFailureStage,
      'subscriber-close' | 'scanner-close' | 'reconciler-close' | 'worker-close'
      | 'paper-worker-close' | 'social-worker-close'>;
      readonly operation: Promise<void>;
    }[] = [];
    const paperWorkerClosing = startupTimedOut || this.activeResources.has('paperWorker')
      ? invoke(() => this.dependencies.paperWorker.close())
      : null;
    const socialWorkerClosing = startupTimedOut || this.activeResources.has('socialWorker')
      ? invoke(() => this.dependencies.socialWorker.close())
      : null;
    const workerClosing = startupTimedOut || this.activeResources.has('worker')
      ? invoke(() => this.dependencies.worker.close())
      : null;
    if (startupTimedOut || this.activeResources.has('subscriber')) {
      cleanup.push({
        resource: 'subscriber',
        stage: 'subscriber-close',
        operation: invoke(() => this.dependencies.subscriber.close()),
      });
    }
    if (startupTimedOut || this.scannerNeedsClose) {
      cleanup.push({
        resource: 'scanner',
        stage: 'scanner-close',
        operation: invoke(() => this.dependencies.scanner.close()),
      });
    }
    if (startupTimedOut || this.activeResources.has('reconciler')) {
      cleanup.push({
        resource: 'reconciler',
        stage: 'reconciler-close',
        operation: invoke(() => this.dependencies.reconciler.close()),
      });
    }
    if (workerClosing !== null) {
      cleanup.push({
        resource: 'worker',
        stage: 'worker-close',
        operation: workerClosing,
      });
    }
    if (socialWorkerClosing !== null) {
      cleanup.unshift({
        resource: 'socialWorker',
        stage: 'social-worker-close',
        operation: socialWorkerClosing,
      });
    }
    if (paperWorkerClosing !== null) {
      cleanup.unshift({
        resource: 'paperWorker',
        stage: 'paper-worker-close',
        operation: paperWorkerClosing,
      });
    }
    const results = await Promise.all(cleanup.map(async (item) => Object.freeze({
      resource: item.resource,
      stage: item.stage,
      result: await settleUntil(item.operation, deadlineMs),
    })));
    for (const result of results) {
      if (result.result === 'complete') {
        if (result.resource === 'scanner') this.scannerNeedsClose = false;
        else this.activeResources.delete(result.resource);
      } else if (result.result === 'failed') {
        if (result.resource === 'scanner') this.scannerNeedsClose = true;
        else this.activeResources.add(result.resource);
        failures.push(failure(result.stage));
      }
      if (result.result === 'timeout') {
        if (result.resource === 'scanner') this.scannerNeedsClose = true;
        else this.activeResources.add(result.resource);
        failures.push(timeoutFailure(
          result.stage === 'worker-close'
            ? 'worker-timeout'
            : result.stage === 'paper-worker-close'
              ? 'paper-worker-timeout'
              : result.stage === 'social-worker-close' ? 'social-worker-timeout' : result.stage,
        ));
      }
    }

    if (startupTimedOut || this.activeResources.has('heartbeat')) {
      const heartbeatResult = await settleUntil(
        invoke(() => this.dependencies.heartbeat.stop('STOPPED')),
        deadlineMs,
      );
      if (heartbeatResult === 'complete') this.activeResources.delete('heartbeat');
      if (heartbeatResult === 'failed') {
        this.activeResources.add('heartbeat');
        failures.push(failure('heartbeat-stop'));
      }
      if (heartbeatResult === 'timeout') {
        this.activeResources.add('heartbeat');
        failures.push(timeoutFailure('heartbeat-stop'));
      }
    }
    this.started = false;
    this.currentState = failures.length === 0 ? 'STOPPED' : 'DEGRADED';
    if (failures.length > 0) throw new ListenerRuntimeError(failures);
  }

  private componentStates(): readonly ListenerRuntimeState[] {
    return [
      this.dependencies.scanner.state(),
      this.dependencies.subscriber.state(),
      this.dependencies.worker.state(),
      this.dependencies.paperWorker.state(),
      this.dependencies.socialWorker.state(),
      this.dependencies.reconciler.state(),
      this.dependencies.heartbeat.state(),
    ];
  }

  private chainComponentStates(): readonly ListenerRuntimeState[] {
    return [
      this.dependencies.scanner.state(),
      this.dependencies.subscriber.state(),
      this.dependencies.worker.state(),
      this.dependencies.reconciler.state(),
      this.dependencies.heartbeat.state(),
    ];
  }

  private assertStartOpen(): void {
    if (this.permanentlyClosed) throw new Error('Listener startup was closed.');
  }
}

function invoke(operation: () => Promise<void>): Promise<void> {
  try { return operation(); } catch { return Promise.reject(new Error('Listener cleanup failed.')); }
}

async function settleUntil(
  operation: Promise<unknown>,
  deadlineMs: number,
): Promise<'complete' | 'failed' | 'timeout'> {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  const timeout = new Promise<'timeout'>((resolve) => {
    timer.handle = setTimeout(() => { resolve('timeout'); }, remainingMs);
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

function timeoutFailure(stage: ListenerRuntimeFailureStage): ListenerRuntimeFailure {
  return Object.freeze({ stage, errorName: 'ListenerTimeoutError' });
}
