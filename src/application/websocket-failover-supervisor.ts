import { isProxy } from 'node:util/types';
import bs58 from 'bs58';
import {
  StrictCatchUpAbortedError,
  StrictCatchUpScannerError,
  StrictCatchUpWindowExceededError,
  type StrictCatchUpScanResult,
} from './strict-catch-up-scanner.js';
import { PromotedProviderSelector } from './promoted-provider-selector.js';
import {
  PersistentWebSocketHealthReporter,
} from './websocket-health-reporter.js';
import {
  assertValidWebSocketHealthSnapshot,
  type WebSocketHealthSnapshot,
  type WebSocketRecoveryReasonCode,
} from '../domain/websocket-health.js';
import {
  assertValidTransactionNotification,
  type TransactionNotification,
  type ListenerRuntimeState,
} from '../domain/transaction-ingestion.js';
import {
  RPC_PROVIDER_IDS,
  isRpcProviderId,
  type RpcProviderId,
} from '../domain/rpc-provider.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import {
  WS_PROGRAM_SESSION_CLEANUP_TIMEOUT_MS,
  WsProgramSessionError,
} from '../solana/rpc/ws-program-session.js';
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
  WsProgramSessionCompletion,
  WsProgramSessionCompletionReason,
} from '../solana/rpc/ws-program-session.js';

export const WEBSOCKET_FRONTIER_INTERVAL_MS = 30_000;
export const WEBSOCKET_BACKOFF_BASE_MS = 1_000;
export const WEBSOCKET_BACKOFF_CAP_MS = 60_000;

export function equalJitterDelay(failedCycleCount: number, random: number): number {
  if (!Number.isSafeInteger(failedCycleCount) || failedCycleCount < 0
    || typeof random !== 'number' || !Number.isFinite(random)
    || random < 0 || random >= 1) {
    throw new TypeError('WebSocket recovery backoff input is invalid.');
  }
  const exponentialCap = Math.min(
    WEBSOCKET_BACKOFF_CAP_MS,
    WEBSOCKET_BACKOFF_BASE_MS * (2 ** Math.min(failedCycleCount, 30)),
  );
  return Math.floor(exponentialCap / 2 + random * exponentialCap / 2);
}

// The captured intrinsic is invoked only through Reflect.apply with an explicit receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const PROMISE_THEN = Promise.prototype.then;

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
  promotionFenced: boolean;
  queuedCompletion: WsProgramSessionCompletionReason | null;
  completed: boolean;
  closePromise: Promise<void> | null;
}

type ProviderAttemptResult =
  | Readonly<{ kind: 'promoted' }>
  | Readonly<{ kind: 'aborted' }>
  | Readonly<{
      kind: 'window';
      error: StrictCatchUpWindowExceededError;
      recoveryReason: 'CATCH_UP_WINDOW_EXCEEDED';
    }>
  | Readonly<{
      kind: 'transient';
      recoveryReason: WebSocketRecoveryReasonCode;
      disconnectReason: WebSocketHealthTransition['disconnectReasonCode'];
    }>;

const REJECTED_SESSION_COMPLETION_REASON: WsProgramSessionCompletionReason = 'PROTOCOL_INVALID';

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
  #periodicPromise: Promise<void> | null = null;
  #periodicAbort: AbortController | null = null;
  #loopPromise: Promise<void> | null = null;
  #candidateAbort: AbortController | null = null;
  #candidate: SessionRecord | null = null;
  #incumbent: SessionRecord | null = null;
  #currentState: ListenerRuntimeState = 'STOPPED';
  #currentProviderId: RpcProviderId | null = null;
  #touchStarted = false;
  #reporterStopPromise: Promise<void> | null = null;
  #permanentlyClosed = false;
  #failedCycleCount = 0;
  #lastPromotedProviderId: RpcProviderId | null = null;
  #pendingRecoveryReason: WebSocketRecoveryReasonCode = 'STARTUP';
  #unrecoverable = false;
  #recoveryRequested = false;
  #activeFailurePromise: Promise<void> | null = null;
  #transitionActive = false;
  readonly #transitionWaiters: (() => void)[] = [];
  #shutdownResourceFailed = false;

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
      if (this.#permanentlyClosed) throw new WebSocketFailoverSupervisorError('cleanup');
      this.#currentState = 'DEGRADED';
      throw new WebSocketFailoverSupervisorError('owner');
    }
    this.#assertStartupOpen();
    this.#snapshot = snapshot;
    try {
      this.#assertStartupOpen();
      this.#dependencies.reporter.startTouch(snapshot);
      this.#touchStarted = true;
      this.#assertStartupOpen();
      const waiting = await this.#transitionToWaiting(snapshot);
      this.#assertStartupOpen();
      this.#snapshot = waiting;
    } catch {
      if (this.#touchStarted) await this.#stopReporterAfterStartFailure();
      if (this.#permanentlyClosed) throw new WebSocketFailoverSupervisorError('cleanup');
      this.#currentState = 'DEGRADED';
      throw new WebSocketFailoverSupervisorError('transition');
    }
    this.#assertStartupOpen();
    this.#currentState = 'STARTING';
    try {
      this.#assertStartupOpen();
      this.#scheduleRecovery(0);
      this.#assertStartupOpen();
    } catch {
      await this.#stopReporterAfterStartFailure();
      if (this.#permanentlyClosed) throw new WebSocketFailoverSupervisorError('cleanup');
      this.#currentState = 'DEGRADED';
      throw new WebSocketFailoverSupervisorError('schedule');
    }
  }

  async #stopReporterAfterStartFailure(): Promise<void> {
    try {
      await this.#stopReporterOnce();
    } catch {
      // The original startup stage remains the stable public failure.
    }
  }

  #stopReporterOnce(fencedRecords: readonly SessionRecord[] = []): Promise<void> {
    if (!this.#touchStarted) return Promise.resolve();
    this.#reporterStopPromise ??= Promise.resolve().then(
      () => this.#dependencies.reporter.stop(
        () => this.#settleShutdownResources(fencedRecords),
      ),
    );
    return this.#reporterStopPromise;
  }

  #assertStartupOpen(): void {
    if (this.#permanentlyClosed) throw new WebSocketFailoverSupervisorError('cleanup');
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

  #scheduleRecovery(delayMs: number): void {
    let scheduled: ScheduledHandle | null = null;
    const value = this.#options.scheduler.schedule(() => {
      if (scheduled === null || this.#loopHandle !== scheduled) return;
      this.#loopHandle = null;
      if (this.#permanentlyClosed || this.#unrecoverable || this.#loopPromise !== null) return;
      this.#recoveryRequested = false;
      const operation = this.#runRecoveryCycle();
      this.#loopPromise = operation;
      void operation.then(
        () => { this.#finishRecovery(operation, false); },
        () => { this.#finishRecovery(operation, true); },
      );
    }, delayMs);
    scheduled = Object.freeze({ value });
    if (this.#permanentlyClosed) {
      this.#options.scheduler.cancel(value);
      return;
    }
    this.#loopHandle = scheduled;
  }

  async #runRecoveryCycle(): Promise<void> {
    if (this.#isPermanentlyClosed() || this.#unrecoverable) return;
    const ids = this.#providerCycleOrder();
    const windowErrors: StrictCatchUpWindowExceededError[] = [];
    let recoveryReason = this.#pendingRecoveryReason;
    let disconnectReason: WebSocketHealthTransition['disconnectReasonCode'] = null;

    for (const providerId of ids) {
      if (this.#isPermanentlyClosed()) return;
      let result: ProviderAttemptResult;
      try {
        result = await this.#attemptProvider(providerId, recoveryReason);
      } catch {
        result = Object.freeze({
          kind: 'transient',
          recoveryReason: 'RPC_UNAVAILABLE',
          disconnectReason: null,
        });
      }
      if (result.kind === 'promoted' || result.kind === 'aborted') return;
      recoveryReason = result.recoveryReason;
      if (result.kind === 'window') windowErrors.push(result.error);
      else if (result.disconnectReason !== null) disconnectReason = result.disconnectReason;
    }

    if (this.#isPermanentlyClosed()) return;
    const firstWindowError = windowErrors[0];
    if (windowErrors.length === ids.length
      && firstWindowError !== undefined
      && windowErrors.every((error) => firstWindowError.sameFrontier(error))) {
      await this.#becomeUnrecoverable();
      return;
    }
    this.#pendingRecoveryReason = recoveryReason;
    await this.#persistCycleDegraded(recoveryReason, disconnectReason);
    if (this.#isPermanentlyClosed()) return;
    const delay = equalJitterDelay(this.#failedCycleCount, this.#options.random());
    this.#failedCycleCount += 1;
    this.#scheduleRecovery(delay);
  }

  #providerCycleOrder(): readonly RpcProviderId[] {
    const ids = this.#dependencies.providers.ids;
    const lastIndex = this.#lastPromotedProviderId === null
      ? -1
      : ids.indexOf(this.#lastPromotedProviderId);
    if (lastIndex < 0) return ids;
    return Object.freeze([
      ...ids.slice(lastIndex + 1),
      ...ids.slice(0, lastIndex + 1),
    ]);
  }

  async #attemptProvider(
    providerId: RpcProviderId,
    recoveryReason: WebSocketRecoveryReasonCode,
  ): Promise<ProviderAttemptResult> {
    const prepared = await this.#prepareCandidate(providerId, recoveryReason);
    if (prepared === null || this.#isPermanentlyClosed()) return abortedAttempt();
    const { ownerGeneration, sessionGeneration } = prepared;
    let endpoint: RpcProviderPair;
    try {
      endpoint = providerPairFrom(this.#dependencies.providers.resolve(providerId), providerId);
    } catch (error) {
      return attemptFailureFrom(error);
    }
    const controller = new AbortController();
    this.#candidateAbort = controller;
    let openedSession: WsProgramSession | null = null;
    let opened: WsProgramSession;
    try {
      opened = await this.#dependencies.openSession(
        Object.freeze({ id: providerId, url: endpoint.websocketUrl }),
        (value) => this.#notification(
          value,
          providerId,
          ownerGeneration,
          sessionGeneration,
          controller,
          openedSession,
        ),
        controller.signal,
      );
    } catch (error) {
      controller.abort();
      if (this.#candidateAbort === controller) this.#candidateAbort = null;
      return this.#isPermanentlyClosed() ? abortedAttempt() : attemptFailureFrom(error);
    }
    if (this.#isPermanentlyClosed() || this.#candidateAbort !== controller) {
      controller.abort();
      try {
        const lateSession = sessionFrom(opened, providerId);
        const lateRecord: SessionRecord = {
          providerId,
          sessionGeneration,
          session: lateSession,
          controller,
          promotionFenced: false,
          queuedCompletion: null,
          completed: false,
          closePromise: null,
        };
        await this.#closeSession(lateRecord);
      } catch {
        this.#shutdownResourceFailed = true;
      }
      return abortedAttempt();
    }
    let session: WsProgramSession;
    try {
      session = sessionFrom(opened, providerId);
    } catch (error) {
      controller.abort();
      if (this.#candidateAbort === controller) this.#candidateAbort = null;
      return attemptFailureFrom(error);
    }
    openedSession = session;
    const candidate: SessionRecord = {
      providerId,
      sessionGeneration,
      session,
      controller,
      promotionFenced: false,
      queuedCompletion: null,
      completed: false,
      closePromise: null,
    };
    this.#candidate = candidate;
    try {
      void Reflect.apply(PROMISE_THEN, session.completion, [
        (completion: unknown): void => {
          this.#completeSession(candidate, completionReasonFrom(completion));
        },
        (): void => { this.#completeSession(candidate, REJECTED_SESSION_COMPLETION_REASON); },
      ]);
    } catch {
      const cleaned = await this.#cleanupCandidate(candidate);
      return cleaned ? attemptFailureFrom(configurationError()) : cleanupFailureAttempt();
    }

    try {
      await this.#transition({
        phase: 'ACKNOWLEDGED',
        ...this.#activeTransitionFields(),
        candidateProviderId: providerId,
        candidateSessionGeneration: sessionGeneration,
        acknowledged: true,
        disconnectReasonCode: null,
        recoveryStatus: 'REQUIRED',
        recoveryReasonCode: recoveryReason,
      });
      if (this.#candidate !== candidate || this.#isPermanentlyClosed()) {
        const result = completionAttemptFailure(candidate);
        const cleaned = await this.#cleanupCandidate(candidate);
        return this.#isPermanentlyClosed()
          ? abortedAttempt()
          : cleaned ? result : cleanupFailureAttempt();
      }
      await this.#transition({
        phase: 'RECOVERING',
        ...this.#activeTransitionFields(),
        candidateProviderId: providerId,
        candidateSessionGeneration: sessionGeneration,
        acknowledged: true,
        disconnectReasonCode: null,
        recoveryStatus: 'IN_PROGRESS',
        recoveryReasonCode: recoveryReason,
      });
      if (this.#candidate !== candidate || this.#isPermanentlyClosed()) {
        const result = completionAttemptFailure(candidate);
        const cleaned = await this.#cleanupCandidate(candidate);
        return this.#isPermanentlyClosed()
          ? abortedAttempt()
          : cleaned ? result : cleanupFailureAttempt();
      }
      try {
        await this.#dependencies.runStrictScan(providerId, controller.signal);
      } catch (error) {
        const cleaned = await this.#cleanupCandidate(candidate);
        return this.#isPermanentlyClosed()
          ? abortedAttempt()
          : cleaned ? strictScanFailureFrom(error, candidate) : cleanupFailureAttempt();
      }
      if (this.#candidate !== candidate || this.#isPermanentlyClosed()
        || controller.signal.aborted) {
        const result = completionAttemptFailure(candidate);
        const cleaned = await this.#cleanupCandidate(candidate);
        return this.#isPermanentlyClosed()
          ? abortedAttempt()
          : cleaned ? result : cleanupFailureAttempt();
      }
      candidate.promotionFenced = true;
      try {
        await this.#transition({
          phase: 'RUNNING',
          providerId,
          activeSessionGeneration: sessionGeneration,
          candidateProviderId: null,
          candidateSessionGeneration: null,
          acknowledged: true,
          disconnectReasonCode: null,
          recoveryStatus: 'RECOVERED',
          recoveryReasonCode: recoveryReason,
        });
      } catch (error) {
        this.#currentState = 'DEGRADED';
        const cleaned = await this.#cleanupCandidate(candidate);
        return cleaned ? attemptFailureFrom(error) : cleanupFailureAttempt();
      }
      if (this.#candidate !== candidate || this.#isPermanentlyClosed()) {
        const cleaned = await this.#cleanupCandidate(candidate);
        return this.#isPermanentlyClosed()
          ? abortedAttempt()
          : cleaned ? completionAttemptFailure(candidate) : cleanupFailureAttempt();
      }
      const previousIncumbent = this.#incumbent;
      this.#incumbent = candidate;
      this.#candidate = null;
      this.#candidateAbort = null;
      this.#currentProviderId = providerId;
      this.#currentState = 'RUNNING';
      this.#lastPromotedProviderId = providerId;
      this.#failedCycleCount = 0;
      this.#pendingRecoveryReason = recoveryReason;
      this.#dependencies.promoted.promote(providerId);
      const queuedCompletion = candidate.queuedCompletion;
      candidate.queuedCompletion = null;
      let previousCleanupFailed = false;
      try {
        if (queuedCompletion !== null) {
          await this.#degradePromotedSession(candidate, queuedCompletion);
        }
      } finally {
        if (previousIncumbent !== null && previousIncumbent !== candidate) {
          try {
            await this.#closeSession(previousIncumbent);
          } catch {
            previousCleanupFailed = true;
          }
        }
      }
      if (previousCleanupFailed) {
        await this.#degradeActiveIncumbent(
          candidate,
          'CLEANUP_FAILED',
          'SESSION_FAILURE',
        );
        return promotedAttempt();
      }
      if (queuedCompletion !== null) return promotedAttempt();
      this.#armPeriodicFrontier();
      return promotedAttempt();
    } catch (error) {
      const cleaned = await this.#cleanupCandidate(candidate);
      return this.#isPermanentlyClosed()
        ? abortedAttempt()
        : cleaned ? attemptFailureFrom(error) : cleanupFailureAttempt();
    }
  }

  async #prepareCandidate(
    providerId: RpcProviderId,
    recoveryReason: WebSocketRecoveryReasonCode,
  ): Promise<Readonly<{ ownerGeneration: bigint; sessionGeneration: bigint }> | null> {
    const snapshot = this.#snapshot;
    if (snapshot === null || this.#isPermanentlyClosed()) return null;
    if (snapshot.phase === 'WAITING_FOR_ACKS'
      && snapshot.candidateProviderId === providerId
      && snapshot.candidateSessionGeneration !== null) {
      return Object.freeze({
        ownerGeneration: snapshot.ownerGeneration,
        sessionGeneration: snapshot.candidateSessionGeneration,
      });
    }
    const sessionGeneration = snapshot.revision + 1n;
    await this.#transition({
      phase: 'CONNECTING',
      ...this.#activeTransitionFields(),
      candidateProviderId: providerId,
      candidateSessionGeneration: sessionGeneration,
      acknowledged: false,
      disconnectReasonCode: null,
      recoveryStatus: 'REQUIRED',
      recoveryReasonCode: recoveryReason,
    });
    if (this.#isPermanentlyClosed()) return null;
    await this.#transition({
      phase: 'WAITING_FOR_ACKS',
      ...this.#activeTransitionFields(),
      candidateProviderId: providerId,
      candidateSessionGeneration: sessionGeneration,
      acknowledged: false,
      disconnectReasonCode: null,
      recoveryStatus: 'REQUIRED',
      recoveryReasonCode: recoveryReason,
    });
    const latest = this.#snapshot;
    if (latest === null) return null;
    return Object.freeze({ ownerGeneration: latest.ownerGeneration, sessionGeneration });
  }

  #activeTransitionFields(): Readonly<{
    providerId: RpcProviderId | null;
    activeSessionGeneration: bigint | null;
  }> {
    const incumbent = this.#incumbent;
    return incumbent === null || incumbent.completed
      ? Object.freeze({ providerId: null, activeSessionGeneration: null })
      : Object.freeze({
          providerId: incumbent.providerId,
          activeSessionGeneration: incumbent.sessionGeneration,
        });
  }

  async #cleanupCandidate(record: SessionRecord): Promise<boolean> {
    if (this.#candidate === record) this.#candidate = null;
    if (this.#candidateAbort === record.controller) this.#candidateAbort = null;
    record.controller.abort();
    try {
      await this.#closeSession(record);
      return true;
    } catch {
      if (this.#permanentlyClosed) this.#shutdownResourceFailed = true;
      return false;
    }
  }

  #closeSession(record: SessionRecord): Promise<void> {
    record.closePromise ??= this.#performSessionClose(record);
    return record.closePromise;
  }

  async #performSessionClose(record: SessionRecord): Promise<void> {
    const controller = new AbortController();
    const closing = record.session.close(controller.signal);
    const immediateState: { outcome: 'pending' | 'complete' | 'failed' } = {
      outcome: 'pending',
    };
    void closing.then(
      () => { immediateState.outcome = 'complete'; },
      () => { immediateState.outcome = 'failed'; },
    );
    await Promise.resolve();
    await Promise.resolve();
    const immediate = closeOutcome(immediateState);
    if (immediate === 'complete') return;
    if (immediate === 'failed') throw new WebSocketFailoverSupervisorError('cleanup');

    const timeoutState: { scheduled: ScheduledHandle | null } = { scheduled: null };
    const timeout = new Promise<void>((_resolve, reject) => {
      const value = this.#options.scheduler.schedule(() => {
        controller.abort();
        reject(new WebSocketFailoverSupervisorError('cleanup'));
      }, WS_PROGRAM_SESSION_CLEANUP_TIMEOUT_MS);
      timeoutState.scheduled = Object.freeze({ value });
    });
    let failed = false;
    try {
      await Promise.race([closing, timeout]);
    } catch {
      controller.abort();
      failed = true;
    }
    const scheduled = timeoutState.scheduled;
    if (scheduled !== null) {
      try {
        this.#options.scheduler.cancel(scheduled.value);
      } catch {
        controller.abort();
        failed = true;
      }
    }
    if (failed) throw new WebSocketFailoverSupervisorError('cleanup');
  }

  async #persistCycleDegraded(
    recoveryReason: WebSocketRecoveryReasonCode,
    disconnectReason: WebSocketHealthTransition['disconnectReasonCode'],
  ): Promise<void> {
    await this.#transition({
      phase: 'DEGRADED',
      ...this.#activeTransitionFields(),
      candidateProviderId: null,
      candidateSessionGeneration: null,
      acknowledged: this.#activeTransitionFields().providerId !== null,
      disconnectReasonCode: disconnectReason,
      recoveryStatus: 'REQUIRED',
      recoveryReasonCode: recoveryReason,
    });
    this.#currentState = 'DEGRADED';
  }

  async #becomeUnrecoverable(): Promise<void> {
    this.#unrecoverable = true;
    this.#cancelPeriodicFrontier();
    const incumbent = this.#incumbent;
    if (incumbent?.completed === true) {
      this.#incumbent = null;
      try {
        await this.#closeSession(incumbent);
      } catch {
        // The fixed UNRECOVERABLE fence still prevents publication and retries.
      }
    }
    const active = this.#activeTransitionFields();
    const selectedProviderId = this.#dependencies.promoted.activeProviderId();
    this.#currentProviderId = null;
    if (selectedProviderId !== null) this.#dependencies.promoted.clear(selectedProviderId);
    try {
      await this.#transition({
        phase: 'UNRECOVERABLE',
        ...active,
        candidateProviderId: null,
        candidateSessionGeneration: null,
        acknowledged: active.providerId !== null,
        disconnectReasonCode: null,
        recoveryStatus: 'FAILED',
        recoveryReasonCode: 'CATCH_UP_WINDOW_EXCEEDED',
      });
    } catch (error) {
      this.#unrecoverable = false;
      throw error;
    }
    this.#currentState = 'DEGRADED';
  }

  async #transition(
    input: Omit<
      Parameters<PersistentWebSocketHealthReporter['transition']>[0],
      'ownerGeneration' | 'expectedRevision'
    >,
  ): Promise<void> {
    if (this.#transitionActive) {
      await new Promise<void>((resolve) => { this.#transitionWaiters.push(resolve); });
    } else {
      this.#transitionActive = true;
    }
    try {
      if (this.#permanentlyClosed) throw new WebSocketFailoverSupervisorError('cleanup');
      const snapshot = this.#snapshot;
      if (snapshot === null) throw new WebSocketFailoverSupervisorError('transition');
      const transitionInput: WebSocketHealthTransition = {
        ownerGeneration: snapshot.ownerGeneration,
        expectedRevision: snapshot.revision,
        ...input,
      };
      const next = await this.#dependencies.reporter.transition(transitionInput);
      assertTransitionResult(snapshot, transitionInput, next);
      this.#snapshot = next;
    } catch {
      throw new WebSocketFailoverSupervisorError('transition');
    } finally {
      const next = this.#transitionWaiters.shift();
      if (next === undefined) this.#transitionActive = false;
      else next();
    }
  }

  #notification(
    value: WsProgramNotification,
    providerId: RpcProviderId,
    ownerGeneration: bigint,
    sessionGeneration: bigint,
    controller: AbortController,
    openedSession: WsProgramSession | null,
  ): Promise<void> {
    if (this.#permanentlyClosed) return Promise.resolve();
    if (openedSession === null) {
      if (this.#candidateAbort !== controller) return Promise.resolve();
    } else {
      const record = this.#candidate?.session === openedSession
        ? this.#candidate
        : this.#incumbent?.session === openedSession ? this.#incumbent : null;
      if (record?.controller !== controller
        || controller.signal.aborted
        || record.providerId !== providerId
        || record.sessionGeneration !== sessionGeneration) return Promise.resolve();
    }
    let preliminary: TransactionNotification;
    try {
      const payload = exactOwnData(value, ['endpointId', 'program', 'signature', 'slot']);
      const programId = programIdFrom(payload.program);
      if (payload.endpointId !== providerId
        || programId === null
        || !isCanonicalWebSocketSignature(payload.signature)) throw new TypeError();
      preliminary = Object.freeze({
        signature: payload.signature,
        slot: payload.slot as bigint,
        source: 'WEBSOCKET',
        programIds: Object.freeze([programId]),
        confirmationStatus: 'confirmed',
        observedAtMs: 0,
      });
      assertValidTransactionNotification(preliminary);
    } catch {
      return Promise.reject(configurationError());
    }
    let notification: TransactionNotification;
    try {
      notification = Object.freeze({ ...preliminary, observedAtMs: this.#options.now() });
      assertValidTransactionNotification(notification);
    } catch {
      return Promise.reject(configurationError());
    }
    return this.#dependencies.reporter.observe(
      notification,
      ownerGeneration,
      sessionGeneration,
    );
  }

  #completeSession(record: SessionRecord, reason: WsProgramSessionCompletionReason): void {
    if (this.#permanentlyClosed) return;
    record.completed = true;
    if (this.#candidate === record) {
      if (record.promotionFenced) {
        record.queuedCompletion ??= reason;
        return;
      }
      record.queuedCompletion ??= reason;
      this.#invalidateCandidate(record);
      return;
    }
    if (this.#incumbent === record) {
      this.#currentState = 'DEGRADED';
      if (this.#activeFailurePromise !== null) return;
      const operation = this.#degradeIncumbent(record, reason);
      this.#activeFailurePromise = operation;
      void operation.then(
        () => {
          if (this.#activeFailurePromise === operation) this.#activeFailurePromise = null;
        },
        () => {
          if (this.#activeFailurePromise === operation) this.#activeFailurePromise = null;
        },
      );
    }
  }

  #invalidateCandidate(record: SessionRecord): void {
    if (this.#candidate === record) this.#candidate = null;
    if (this.#candidateAbort === record.controller) this.#candidateAbort = null;
    record.controller.abort();
  }

  async #degradePromotedSession(
    record: SessionRecord,
    completionReason: WsProgramSessionCompletionReason,
  ): Promise<void> {
    try {
      await this.#transition({
        phase: 'DEGRADED',
        providerId: record.providerId,
        activeSessionGeneration: record.sessionGeneration,
        candidateProviderId: null,
        candidateSessionGeneration: null,
        acknowledged: true,
        disconnectReasonCode: disconnectReasonFromCompletion(completionReason),
        recoveryStatus: 'REQUIRED',
        recoveryReasonCode: 'SESSION_FAILURE',
      });
    } catch (error) {
      this.#abandonPromotedSession(record);
      try { await this.#closeSession(record); } catch { /* fixed transition stage wins */ }
      if (!this.#permanentlyClosed) await this.#stopReporterAfterStartFailure();
      throw error;
    }
    this.#clearPromotedRecord(record);
    this.#requestRecovery('SESSION_FAILURE');
  }

  async #degradeIncumbent(
    record: SessionRecord,
    completionReason: WsProgramSessionCompletionReason,
  ): Promise<void> {
    return this.#degradeActiveIncumbent(
      record,
      disconnectReasonFromCompletion(completionReason),
      'SESSION_FAILURE',
    );
  }

  async #degradeActiveIncumbent(
    record: SessionRecord,
    disconnectReason: NonNullable<WebSocketHealthTransition['disconnectReasonCode']>,
    recoveryReason: WebSocketRecoveryReasonCode,
  ): Promise<void> {
    this.#cancelPeriodicFrontier();
    try {
      await this.#transition({
        phase: 'DEGRADED',
        providerId: record.providerId,
        activeSessionGeneration: record.sessionGeneration,
        candidateProviderId: this.#candidate?.providerId ?? null,
        candidateSessionGeneration: this.#candidate?.sessionGeneration ?? null,
        acknowledged: true,
        disconnectReasonCode: disconnectReason,
        recoveryStatus: 'REQUIRED',
        recoveryReasonCode: recoveryReason,
      });
    } catch (error) {
      this.#abandonPromotedSession(record);
      try { await this.#closeSession(record); } catch { /* fixed transition stage wins */ }
      if (!this.#permanentlyClosed) await this.#stopReporterAfterStartFailure();
      throw error;
    }
    if (this.#isPermanentlyClosed() || this.#incumbent !== record) return;
    this.#clearPromotedRecord(record);
    this.#requestRecovery(recoveryReason);
  }

  #clearPromotedRecord(record: SessionRecord): void {
    if (this.#currentProviderId === record.providerId) {
      this.#currentProviderId = null;
      this.#dependencies.promoted.clear(record.providerId);
    }
    if (!this.#permanentlyClosed) this.#currentState = 'DEGRADED';
  }

  #abandonPromotedSession(record: SessionRecord): void {
    record.controller.abort();
    if (this.#currentProviderId === record.providerId) {
      this.#currentProviderId = null;
      this.#dependencies.promoted.clear(record.providerId);
    }
    if (!this.#permanentlyClosed) this.#currentState = 'DEGRADED';
  }

  #finishRecovery(operation: Promise<void>, failed: boolean): void {
    if (this.#loopPromise === operation) this.#loopPromise = null;
    if (failed && !this.#permanentlyClosed) this.#currentState = 'DEGRADED';
    if (this.#recoveryRequested
      && !this.#permanentlyClosed
      && !this.#unrecoverable
      && this.#loopHandle === null
      && this.#loopPromise === null) this.#scheduleRecovery(0);
  }

  #requestRecovery(reason: WebSocketRecoveryReasonCode): void {
    if (this.#permanentlyClosed || this.#unrecoverable) return;
    this.#pendingRecoveryReason = reason;
    this.#recoveryRequested = true;
    this.#currentState = 'DEGRADED';
    if (this.#loopPromise !== null || this.#loopHandle !== null) return;
    this.#scheduleRecovery(0);
  }

  #isPermanentlyClosed(): boolean {
    return this.#permanentlyClosed;
  }

  #armPeriodicFrontier(): void {
    const incumbent = this.#incumbent;
    if (this.#permanentlyClosed
      || this.#currentState !== 'RUNNING'
      || incumbent === null
      || incumbent.completed
      || this.#currentProviderId !== incumbent.providerId
      || this.#periodicHandle !== null
      || this.#periodicPromise !== null) return;
    let scheduled: ScheduledHandle | null = null;
    const value = this.#options.scheduler.schedule(() => {
      if (scheduled === null || this.#periodicHandle !== scheduled) return;
      this.#periodicHandle = null;
      if (this.#permanentlyClosed
        || this.#periodicPromise !== null
        || this.#incumbent !== incumbent
        || this.#currentProviderId !== incumbent.providerId
        || this.#currentState !== 'RUNNING') return;
      const operation = this.#runPeriodicFrontier(incumbent);
      this.#periodicPromise = operation;
      void operation.then(
        () => {
          if (this.#periodicPromise === operation) this.#periodicPromise = null;
          this.#armPeriodicFrontier();
        },
        () => { if (this.#periodicPromise === operation) this.#periodicPromise = null; },
      );
    }, WEBSOCKET_FRONTIER_INTERVAL_MS);
    scheduled = Object.freeze({ value });
    if (this.#isPermanentlyClosed()) {
      try {
        this.#options.scheduler.cancel(value);
      } catch {
        this.#currentState = 'DEGRADED';
        throw new WebSocketFailoverSupervisorError('cleanup');
      }
      return;
    }
    this.#periodicHandle = scheduled;
  }

  async #runPeriodicFrontier(record: SessionRecord): Promise<void> {
    const controller = new AbortController();
    this.#periodicAbort = controller;
    try {
      await this.#dependencies.runStrictScan(record.providerId, controller.signal);
    } catch (error) {
      if (this.#periodicAbort === controller) this.#periodicAbort = null;
      if (this.#permanentlyClosed
        || controller.signal.aborted
        || this.#incumbent !== record
        || this.#currentState !== 'RUNNING') return;
      const failure = attemptFailureFrom(error);
      if (failure.kind === 'aborted' || failure.kind === 'promoted') return;
      const recoveryReason = failure.recoveryReason;
      const pending = this.#activeFailurePromise;
      if (pending !== null) {
        try { await pending; } catch { /* fixed degradation already handled */ }
        return;
      }
      const operation = this.#degradeActiveIncumbent(
        record,
        'UNEXPECTED_RESTART',
        recoveryReason,
      );
      this.#activeFailurePromise = operation;
      try {
        await operation;
      } finally {
        if (this.#activeFailurePromise === operation) this.#activeFailurePromise = null;
      }
      return;
    }
    if (this.#periodicAbort === controller) this.#periodicAbort = null;
    if (this.#permanentlyClosed
      || controller.signal.aborted
      || this.#incumbent !== record
      || this.#currentProviderId !== record.providerId
      || this.#currentState !== 'RUNNING') return;
  }

  #cancelPeriodicFrontier(): void {
    const scan = this.#periodicAbort;
    this.#periodicAbort = null;
    scan?.abort();
    const periodic = this.#periodicHandle;
    this.#periodicHandle = null;
    if (periodic === null) return;
    try {
      this.#options.scheduler.cancel(periodic.value);
    } catch {
      this.#currentState = 'DEGRADED';
    }
  }

  async #performClose(): Promise<void> {
    this.#permanentlyClosed = true;
    this.#currentState = 'STOPPING';
    let cleanupFailed = false;
    const fencedRecords = [this.#candidate, this.#incumbent]
      .filter((value): value is SessionRecord => value !== null);
    const handle = this.#loopHandle;
    this.#loopHandle = null;
    const periodic = this.#periodicHandle;
    this.#periodicHandle = null;
    const periodicAbort = this.#periodicAbort;
    this.#periodicAbort = null;
    periodicAbort?.abort();
    this.#candidateAbort?.abort();
    this.#candidate?.controller.abort();
    this.#currentProviderId = null;
    try {
      const selectedProviderId = this.#dependencies.promoted.activeProviderId();
      if (selectedProviderId !== null) this.#dependencies.promoted.clear(selectedProviderId);
    } catch {
      cleanupFailed = true;
    }
    for (const scheduled of [handle, periodic]) {
      if (scheduled === null) continue;
      try {
        this.#options.scheduler.cancel(scheduled.value);
      } catch {
        cleanupFailed = true;
      }
    }
    const starting = this.#startPromise;
    if (starting !== null) {
      try {
        await starting;
      } catch {
        // Startup observes the permanent fence and settles before close completes.
      }
    }
    if (this.#touchStarted) {
      try {
        await this.#stopReporterOnce(fencedRecords);
      } catch {
        cleanupFailed = true;
      }
    } else {
      try {
        await this.#settleShutdownResources(fencedRecords);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      this.#currentState = 'DEGRADED';
      throw new WebSocketFailoverSupervisorError('cleanup');
    }
    if (this.#shutdownResourceFailed) {
      this.#currentState = 'DEGRADED';
      throw new WebSocketFailoverSupervisorError('cleanup');
    }
    this.#candidateAbort = null;
    this.#candidate = null;
    this.#incumbent = null;
    this.#currentState = 'STOPPED';
  }

  async #settleShutdownResources(fencedRecords: readonly SessionRecord[]): Promise<void> {
    const records = uniqueSessionRecords([
      ...fencedRecords,
      ...(this.#candidate === null ? [] : [this.#candidate]),
      ...(this.#incumbent === null ? [] : [this.#incumbent]),
    ]);
    const operations: Promise<void>[] = records.map((record) => this.#closeSession(record));
    for (const pending of [
      this.#loopPromise,
      this.#periodicPromise,
      this.#activeFailurePromise,
    ]) {
      if (pending !== null) operations.push(pending);
    }
    const results = await Promise.allSettled(operations);
    const lateRecords = uniqueSessionRecords([
      ...(this.#candidate === null ? [] : [this.#candidate]),
      ...(this.#incumbent === null ? [] : [this.#incumbent]),
    ]).filter((record) => !records.includes(record));
    const lateResults = await Promise.allSettled(
      lateRecords.map((record) => this.#closeSession(record)),
    );
    if ([...results, ...lateResults].some(({ status }) => status === 'rejected')) {
      throw new WebSocketFailoverSupervisorError('cleanup');
    }
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

function uniqueSessionRecords(records: readonly SessionRecord[]): SessionRecord[] {
  const unique: SessionRecord[] = [];
  for (const record of records) {
    if (!unique.includes(record)) unique.push(record);
  }
  return unique;
}

function closeOutcome(state: Readonly<{
  outcome: 'pending' | 'complete' | 'failed';
}>): 'pending' | 'complete' | 'failed' {
  return state.outcome;
}

function assertTransitionResult(
  previous: WebSocketHealthSnapshot,
  input: WebSocketHealthTransition,
  value: unknown,
): asserts value is WebSocketHealthSnapshot {
  assertValidWebSocketHealthSnapshot(value);
  const expectedDisconnectReason = input.disconnectReasonCode
    ?? previous.disconnect?.reasonCode
    ?? null;
  const actualDisconnectReason = value.disconnect?.reasonCode ?? null;
  if (value.ownerGeneration !== previous.ownerGeneration
    || value.revision !== previous.revision + 1n
    || value.phase !== input.phase
    || value.providerId !== input.providerId
    || value.activeSessionGeneration !== input.activeSessionGeneration
    || value.candidateProviderId !== input.candidateProviderId
    || value.candidateSessionGeneration !== input.candidateSessionGeneration
    || (value.acknowledgedAtMs !== null) !== input.acknowledged
    || actualDisconnectReason !== expectedDisconnectReason
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

function sessionFrom(value: unknown, expectedProviderId: RpcProviderId): WsProgramSession {
  try {
    if (!objectValue(value) || !Object.isFrozen(value)) throw new TypeError();
    const session = exactOwnData(value, ['endpointId', 'completion', 'close']);
    const completion = session.completion;
    const close = session.close;
    if (session.endpointId !== expectedProviderId
      || !nativePromise(completion)
      || typeof close !== 'function'
      || isProxy(close)) throw new TypeError();
    const receiver = value;
    return Object.freeze({
      endpointId: expectedProviderId,
      completion: completion as Promise<WsProgramSessionCompletion>,
      close(signal: AbortSignal): Promise<void> {
        try {
          const result: unknown = Reflect.apply(close, receiver, [signal]);
          return nativePromise(result)
            ? result as Promise<void>
            : Promise.reject(configurationError());
        } catch {
          return Promise.reject(configurationError());
        }
      },
    });
  } catch {
    throw configurationError();
  }
}

function nativePromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object'
    && value !== null
    && !isProxy(value)
    && value instanceof Promise
    && Object.getPrototypeOf(value) === Promise.prototype
    && Object.getOwnPropertyDescriptor(value, 'then') === undefined;
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

function disconnectReasonFromCompletion(
  reason: WsProgramSessionCompletionReason,
): NonNullable<WebSocketHealthTransition['disconnectReasonCode']> {
  switch (reason) {
    case 'LOCAL_CLOSE': return 'UNEXPECTED_RESTART';
    case 'SOCKET_ERROR': return 'SOCKET_ERROR';
    case 'REMOTE_CLOSE': return 'REMOTE_CLOSE';
    case 'PROTOCOL_INVALID': return 'PROTOCOL_INVALID';
    case 'NOTIFICATION_FAILED': return 'NOTIFICATION_FAILED';
    case 'CLEANUP_FAILED': return 'CLEANUP_FAILED';
  }
}

function attemptFailureFrom(error: unknown): ProviderAttemptResult {
  if (error instanceof StrictCatchUpAbortedError) return nonShutdownAbortFailure();
  if (error instanceof StrictCatchUpScannerError) {
    return Object.freeze({
      kind: 'transient',
      recoveryReason: error.stage === 'checkpoint-cas'
        ? 'CHECKPOINT_CONFLICT'
        : 'RPC_UNAVAILABLE',
      disconnectReason: null,
    });
  }
  if (error instanceof WsProgramSessionError) {
    return Object.freeze({
      kind: 'transient',
      recoveryReason: error.reason === 'NOTIFICATION_FAILED'
        || error.reason === 'PROTOCOL_INVALID'
        ? 'SESSION_FAILURE'
        : 'RPC_UNAVAILABLE',
      disconnectReason: disconnectReasonFromSessionError(error),
    });
  }
  return Object.freeze({
    kind: 'transient',
    recoveryReason: 'RPC_UNAVAILABLE',
    disconnectReason: null,
  });
}

function strictScanFailureFrom(
  error: unknown,
  record: SessionRecord,
): ProviderAttemptResult {
  if (error instanceof StrictCatchUpAbortedError) return nonShutdownAbortFailure(record);
  if (error instanceof StrictCatchUpWindowExceededError) {
    return Object.freeze({
      kind: 'window',
      error,
      recoveryReason: 'CATCH_UP_WINDOW_EXCEEDED',
    });
  }
  return attemptFailureFrom(error);
}

function nonShutdownAbortFailure(record?: SessionRecord): ProviderAttemptResult {
  const completionReason = record?.queuedCompletion;
  return Object.freeze({
    kind: 'transient',
    recoveryReason: 'SESSION_FAILURE',
    disconnectReason: completionReason === null || completionReason === undefined
      ? 'ABORTED'
      : disconnectReasonFromCompletion(completionReason),
  });
}

function disconnectReasonFromSessionError(
  error: WsProgramSessionError,
): NonNullable<WebSocketHealthTransition['disconnectReasonCode']> {
  switch (error.reason) {
    case 'SETUP_TIMEOUT': return 'SETUP_TIMEOUT';
    case 'ABORTED': return 'ABORTED';
    case 'SOCKET_ERROR': return 'SOCKET_ERROR';
    case 'REMOTE_CLOSE': return 'REMOTE_CLOSE';
    case 'PROTOCOL_INVALID': return 'PROTOCOL_INVALID';
    case 'NOTIFICATION_FAILED': return 'NOTIFICATION_FAILED';
    case 'CLEANUP_FAILED': return 'CLEANUP_FAILED';
  }
}

function completionAttemptFailure(record: SessionRecord): ProviderAttemptResult {
  const reason = record.queuedCompletion ?? REJECTED_SESSION_COMPLETION_REASON;
  return Object.freeze({
    kind: 'transient',
    recoveryReason: 'SESSION_FAILURE',
    disconnectReason: disconnectReasonFromCompletion(reason),
  });
}

function cleanupFailureAttempt(): ProviderAttemptResult {
  return Object.freeze({
    kind: 'transient',
    recoveryReason: 'SESSION_FAILURE',
    disconnectReason: 'CLEANUP_FAILED',
  });
}

function abortedAttempt(): ProviderAttemptResult {
  return Object.freeze({ kind: 'aborted' });
}

function promotedAttempt(): ProviderAttemptResult {
  return Object.freeze({ kind: 'promoted' });
}

function completionReasonFrom(value: unknown): WsProgramSessionCompletionReason {
  try {
    if (!objectValue(value) || !Object.isFrozen(value)) throw new TypeError();
    const completion = exactOwnData(value, ['reason']);
    switch (completion.reason) {
      case 'LOCAL_CLOSE': return 'LOCAL_CLOSE';
      case 'SOCKET_ERROR': return 'SOCKET_ERROR';
      case 'REMOTE_CLOSE': return 'REMOTE_CLOSE';
      case 'PROTOCOL_INVALID': return 'PROTOCOL_INVALID';
      case 'NOTIFICATION_FAILED': return 'NOTIFICATION_FAILED';
      case 'CLEANUP_FAILED': return 'CLEANUP_FAILED';
      default: return 'PROTOCOL_INVALID';
    }
  } catch {
    return 'PROTOCOL_INVALID';
  }
}

function programIdFrom(value: unknown): string | null {
  switch (value) {
    case 'pumpfun': return PUMP_PROGRAM_ID;
    case 'pumpswap': return PUMPSWAP_PROGRAM_ID;
    default: return null;
  }
}

function isCanonicalWebSocketSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 88) return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.byteLength === 64 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

function configurationError(): TypeError {
  const error = new TypeError('WebSocket failover supervisor configuration is invalid.');
  Object.freeze(error);
  return error;
}
