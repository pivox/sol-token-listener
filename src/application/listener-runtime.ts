import type { RpcProviderId } from '../domain/rpc-provider.js';
import type { ListenerRuntimeState } from '../domain/transaction-ingestion.js';
import type { ListenerRuntime } from '../ports/listener-runtime.js';
import type { ApiProjectionPipelineState } from '../storage/api-projection.repository.js';

export type ListenerRuntimeFailureStage =
  | 'supervisor-start'
  | 'worker-start'
  | 'paper-worker-start'
  | 'social-worker-start'
  | 'reconciler-start'
  | 'heartbeat-start'
  | 'startup-timeout'
  | 'supervisor-close'
  | 'supervisor-timeout'
  | 'paper-worker-close'
  | 'paper-worker-timeout'
  | 'social-worker-close'
  | 'social-worker-timeout'
  | 'reconciler-close'
  | 'reconciler-timeout'
  | 'worker-close'
  | 'worker-timeout'
  | 'heartbeat-stop'
  | 'heartbeat-timeout';

export interface ListenerRuntimeFailure {
  readonly stage: ListenerRuntimeFailureStage;
  readonly errorName: 'ListenerDependencyError' | 'ListenerTimeoutError';
}

export class ListenerRuntimeError extends Error {
  public readonly failures: readonly ListenerRuntimeFailure[];

  public constructor(failures: readonly ListenerRuntimeFailure[]) {
    super('Solana listener runtime operation failed.');
    this.name = 'ListenerRuntimeError';
    this.failures = Object.freeze(failures.map((entry) => Object.freeze({ ...entry })));
    Object.freeze(this);
  }
}

interface RuntimeComponent {
  start(): Promise<void>;
  close(): Promise<void>;
  state(): ListenerRuntimeState;
}

interface RuntimeSupervisor extends RuntimeComponent {
  activeProviderId(): RpcProviderId | null;
}

interface RuntimeHeartbeat {
  start(): Promise<void>;
  stop(state: 'STOPPED'): Promise<void>;
  state(): ListenerRuntimeState;
}

export interface ListenerRuntimeDependencies {
  readonly supervisor: RuntimeSupervisor;
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
  | 'supervisor'
  | 'worker'
  | 'paperWorker'
  | 'socialWorker'
  | 'reconciler'
  | 'heartbeat';

const CLEANUP_ORDER: readonly ActiveRuntimeResource[] = Object.freeze([
  'supervisor',
  'paperWorker',
  'socialWorker',
  'reconciler',
  'worker',
  'heartbeat',
]);

export class SolanaListenerRuntime implements ListenerRuntime {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly activeResources = new Set<ActiveRuntimeResource>();
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
      return Promise.reject(new ListenerRuntimeError([failure('supervisor-start')]));
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
        httpAvailable: true,
        pumpfun: 'STOPPED',
        pumpswap: 'STOPPED',
        qualification: 'STOPPED',
        paperDecision: 'STOPPED',
        social: 'STOPPED',
      });
    }
    if (this.currentState !== 'RUNNING') {
      return Object.freeze({
        httpAvailable: true,
        pumpfun: 'DEGRADED',
        pumpswap: 'DEGRADED',
        qualification: 'DEGRADED',
        paperDecision: 'DEGRADED',
        social: 'DEGRADED',
      });
    }

    let chain: 'RUNNING' | 'DEGRADED' = 'DEGRADED';
    let paperDecision: ApiProjectionPipelineState['paperDecision'] = 'DEGRADED';
    let social: ApiProjectionPipelineState['social'] = 'DEGRADED';
    try {
      chain = this.chainComponentStates().every((state) => state === 'RUNNING')
        ? 'RUNNING'
        : 'DEGRADED';
      paperDecision = projectionComponentState(this.dependencies.paperWorker.state());
      social = projectionComponentState(this.dependencies.socialWorker.state());
    } catch {
      // A hostile or failing component stays degraded without exposing its error.
    }
    return Object.freeze({
      httpAvailable: true,
      pumpfun: chain,
      pumpswap: chain,
      qualification: chain,
      paperDecision,
      social,
    });
  }

  private async performStart(): Promise<void> {
    let stage: ListenerRuntimeFailureStage = 'supervisor-start';
    try {
      await this.startComponent('supervisor');
      stage = 'worker-start';
      await this.startComponent('worker');
      stage = 'reconciler-start';
      await this.startComponent('reconciler');
      stage = 'paper-worker-start';
      await this.startComponent('paperWorker');
      stage = 'social-worker-start';
      await this.startComponent('socialWorker');
      stage = 'heartbeat-start';
      await this.startComponent('heartbeat');
      this.started = true;
      this.currentState = 'RUNNING';
    } catch {
      const failures: ListenerRuntimeFailure[] = [failure(stage)];
      const deadlineMs = Date.now() + this.options.shutdownTimeoutMs;
      await this.cleanupActive(deadlineMs, failures);
      this.started = false;
      this.currentState = 'DEGRADED';
      throw new ListenerRuntimeError(failures);
    }
  }

  private async startComponent(resource: ActiveRuntimeResource): Promise<void> {
    if (resource === 'heartbeat') await this.dependencies.heartbeat.start();
    else await this.dependencies[resource].start();
    this.activeResources.add(resource);
    this.assertStartOpen();
  }

  private async performClose(): Promise<void> {
    const deadlineMs = Date.now() + this.options.shutdownTimeoutMs;
    const failures: ListenerRuntimeFailure[] = [];
    const starting = this.startPromise;
    if (starting !== null) {
      const startupResult = await settleUntil(starting, deadlineMs);
      if (startupResult === 'timeout') failures.push(timeoutFailure('startup-timeout'));
    }
    await this.cleanupActive(deadlineMs, failures);
    this.started = false;
    this.currentState = failures.length === 0 ? 'STOPPED' : 'DEGRADED';
    if (failures.length > 0) throw new ListenerRuntimeError(failures);
  }

  private async cleanupActive(
    deadlineMs: number,
    failures: ListenerRuntimeFailure[],
  ): Promise<void> {
    for (const resource of CLEANUP_ORDER) {
      if (!this.activeResources.has(resource)) continue;
      const result = await settleUntil(this.closeResource(resource), deadlineMs);
      if (result === 'complete') {
        this.activeResources.delete(resource);
        continue;
      }
      failures.push(result === 'timeout'
        ? timeoutFailure(timeoutStage(resource))
        : failure(closeStage(resource)));
    }
  }

  private closeResource(resource: ActiveRuntimeResource): Promise<void> {
    return invoke(() => resource === 'heartbeat'
      ? this.dependencies.heartbeat.stop('STOPPED')
      : this.dependencies[resource].close());
  }

  private componentStates(): readonly ListenerRuntimeState[] {
    return [
      this.dependencies.supervisor.state(),
      this.dependencies.worker.state(),
      this.dependencies.reconciler.state(),
      this.dependencies.paperWorker.state(),
      this.dependencies.socialWorker.state(),
      this.dependencies.heartbeat.state(),
    ];
  }

  private chainComponentStates(): readonly ListenerRuntimeState[] {
    return [
      this.dependencies.supervisor.state(),
      this.dependencies.worker.state(),
      this.dependencies.reconciler.state(),
      this.dependencies.heartbeat.state(),
    ];
  }

  private assertStartOpen(): void {
    if (this.permanentlyClosed) throw new Error('Listener startup was closed.');
  }
}

function projectionComponentState(
  state: ListenerRuntimeState,
): 'RUNNING' | 'STOPPED' | 'DEGRADED' {
  return state === 'RUNNING' ? 'RUNNING' : state === 'STOPPED' ? 'STOPPED' : 'DEGRADED';
}

function closeStage(resource: ActiveRuntimeResource): ListenerRuntimeFailureStage {
  if (resource === 'supervisor') return 'supervisor-close';
  if (resource === 'paperWorker') return 'paper-worker-close';
  if (resource === 'socialWorker') return 'social-worker-close';
  if (resource === 'reconciler') return 'reconciler-close';
  if (resource === 'worker') return 'worker-close';
  return 'heartbeat-stop';
}

function timeoutStage(resource: ActiveRuntimeResource): ListenerRuntimeFailureStage {
  if (resource === 'supervisor') return 'supervisor-timeout';
  if (resource === 'paperWorker') return 'paper-worker-timeout';
  if (resource === 'socialWorker') return 'social-worker-timeout';
  if (resource === 'reconciler') return 'reconciler-timeout';
  if (resource === 'worker') return 'worker-timeout';
  return 'heartbeat-timeout';
}

function invoke(operation: () => Promise<void>): Promise<void> {
  try {
    return operation();
  } catch {
    return Promise.reject(new Error('Listener cleanup failed.'));
  }
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
