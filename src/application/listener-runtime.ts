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

export type ListenerRuntimeFailurePhase = 'startup' | 'startup-cleanup' | 'shutdown';

export interface ListenerRuntimeFailureDiagnostic extends ListenerRuntimeFailure {
  readonly phase: ListenerRuntimeFailurePhase;
  readonly cause?: unknown;
}

export class ListenerRuntimeError extends Error {
  public readonly failures: readonly ListenerRuntimeFailure[];
  public readonly diagnostics: readonly ListenerRuntimeFailureDiagnostic[];

  public constructor(failures: readonly ListenerRuntimeFailureDiagnostic[]) {
    super('Solana listener runtime operation failed.');
    this.name = 'ListenerRuntimeError';
    this.diagnostics = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
    this.failures = Object.freeze(failures.map(({ stage, errorName }) => Object.freeze({ stage, errorName })));
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
      return Promise.reject(new ListenerRuntimeError([failure('rpc-health', 'startup')]));
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
      stage = 'subscriber-start';
      await this.dependencies.subscriber.start();
      started.push('subscriber');
      this.activeResources.add('subscriber');
      this.assertStartOpen();
      stage = 'scanner-scan';
      await this.dependencies.scanner.scan();
      this.scannerNeedsClose = true;
      this.assertStartOpen();
      if (this.dependencies.subscriber.state() !== 'RUNNING') {
        throw new Error('Listener subscription degraded during startup catch-up.');
      }
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
      this.started = true;
      this.currentState = 'RUNNING';
    } catch (error) {
      const failures: ListenerRuntimeFailureDiagnostic[] = [failure(stage, 'startup', error)];
      if (this.scannerNeedsClose) {
        try {
          await this.dependencies.scanner.close();
          this.scannerNeedsClose = false;
        } catch (cleanupError) {
          failures.push(failure('scanner-close', 'startup-cleanup', cleanupError));
        }
      }
      await this.rollbackStart(started, failures);
      this.currentState = 'DEGRADED';
      throw new ListenerRuntimeError(failures);
    }
  }

  private async rollbackStart(
    started: readonly ActiveRuntimeResource[],
    failures: ListenerRuntimeFailureDiagnostic[],
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
      } catch (error) {
        failures.push(failure(closeStage, 'startup-cleanup', error));
      }
    }
  }

  private async performClose(): Promise<void> {
    const deadlineMs = Date.now() + this.options.shutdownTimeoutMs;
    const failures: ListenerRuntimeFailureDiagnostic[] = [];
    const starting = this.startPromise;
    let startupTimedOut = false;
    if (starting !== null) {
      const result = await settleUntil(starting, deadlineMs);
      if (result.status === 'timeout') {
        startupTimedOut = true;
        failures.push(timeoutFailure('startup-timeout', 'shutdown'));
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
      if (result.result.status === 'complete') {
        if (result.resource === 'scanner') this.scannerNeedsClose = false;
        else this.activeResources.delete(result.resource);
      } else if (result.result.status === 'failed') {
        if (result.resource === 'scanner') this.scannerNeedsClose = true;
        else this.activeResources.add(result.resource);
        failures.push(failure(result.stage, 'shutdown', result.result.error));
      }
      if (result.result.status === 'timeout') {
        if (result.resource === 'scanner') this.scannerNeedsClose = true;
        else this.activeResources.add(result.resource);
        failures.push(timeoutFailure(
          result.stage === 'worker-close'
            ? 'worker-timeout'
            : result.stage === 'paper-worker-close'
              ? 'paper-worker-timeout'
              : result.stage === 'social-worker-close' ? 'social-worker-timeout' : result.stage,
          'shutdown',
        ));
      }
    }

    if (startupTimedOut || this.activeResources.has('heartbeat')) {
      const heartbeatResult = await settleUntil(
        invoke(() => this.dependencies.heartbeat.stop('STOPPED')),
        deadlineMs,
      );
      if (heartbeatResult.status === 'complete') this.activeResources.delete('heartbeat');
      if (heartbeatResult.status === 'failed') {
        this.activeResources.add('heartbeat');
        failures.push(failure('heartbeat-stop', 'shutdown', heartbeatResult.error));
      }
      if (heartbeatResult.status === 'timeout') {
        this.activeResources.add('heartbeat');
        failures.push(timeoutFailure('heartbeat-stop', 'shutdown'));
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
  return Promise.resolve().then(operation);
}

async function settleUntil(
  operation: Promise<unknown>,
  deadlineMs: number,
): Promise<
  | Readonly<{ status: 'complete' }>
  | Readonly<{ status: 'failed'; error: unknown }>
  | Readonly<{ status: 'timeout' }>
> {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  const timeout = new Promise<Readonly<{ status: 'timeout' }>>((resolve) => {
    timer.handle = setTimeout(() => { resolve(Object.freeze({ status: 'timeout' })); }, remainingMs);
  });
  const settled = operation.then(
    () => Object.freeze({ status: 'complete' as const }),
    (error: unknown) => Object.freeze({ status: 'failed' as const, error }),
  );
  const result = await Promise.race([settled, timeout]);
  if (timer.handle !== undefined) clearTimeout(timer.handle);
  return result;
}

function failure(
  stage: ListenerRuntimeFailureStage,
  phase: ListenerRuntimeFailurePhase,
  cause?: unknown,
): ListenerRuntimeFailureDiagnostic {
  return Object.freeze({
    stage,
    phase,
    errorName: 'ListenerDependencyError',
    ...(cause === undefined ? {} : { cause }),
  });
}

function timeoutFailure(stage: ListenerRuntimeFailureStage, phase: ListenerRuntimeFailurePhase): ListenerRuntimeFailureDiagnostic {
  return Object.freeze({ stage, phase, errorName: 'ListenerTimeoutError' });
}
