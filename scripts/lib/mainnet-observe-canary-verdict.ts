import { types } from 'node:util';
import {
  createFirstProcessingCanaryEvidence,
  type RuntimeFirstProcessingCanaryEvidenceV1,
} from '../../src/domain/first-processing-canary.js';

export type MainnetObserveCanaryVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export const MAINNET_OBSERVE_CANARY_GATE_NAMES = [
  'runtime', 'http429', 'backlog', 'terminalFailures', 'idempotence', 'retention',
  'decoderQuarantine', 'firstProcessing', 'blockHydration', 'catchUpAdmission',
  'providerAffinity', 'rss', 'pumpswap', 'finality', 'versionsAndFreshReplay',
  'shutdown', 'cleanup',
] as const;

export type MainnetObserveCanaryGateName =
  (typeof MAINNET_OBSERVE_CANARY_GATE_NAMES)[number];

export interface MainnetObserveCanaryGateResultV1 {
  readonly verdict: MainnetObserveCanaryVerdict;
  readonly reasonCode: string;
}

export interface MainnetObserveCanaryResultV1 {
  readonly schemaVersion: 'mainnet-observe-canary-result.v1';
  readonly commit: string | null;
  readonly overallVerdict: MainnetObserveCanaryVerdict;
  readonly gates: Readonly<Record<MainnetObserveCanaryGateName,
  MainnetObserveCanaryGateResultV1>>;
}

const SNAPSHOT_NAMES = ['T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP'] as const;
const HEALTH_STATUSES = ['OK', 'DEGRADED'] as const;
const PIPELINE_STATES = ['IDLE', 'RUNNING', 'DEGRADED', 'STOPPED'] as const;
const RUNTIME_STATES = ['STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED'] as const;
const WEBSOCKET_PHASES = [
  'STOPPED', 'CONNECTING', 'WAITING_FOR_ACKS', 'ACKNOWLEDGED', 'RECOVERING',
  'RUNNING', 'DEGRADED', 'UNRECOVERABLE', 'STOPPING',
] as const;
const RECOVERY_STATUSES = ['NOT_REQUIRED', 'REQUIRED', 'IN_PROGRESS', 'RECOVERED', 'FAILED'] as const;
const RECOVERY_REASON_CODES = [
  'STARTUP', 'UNEXPECTED_RESTART', 'SESSION_FAILURE', 'RPC_UNAVAILABLE',
  'CHECKPOINT_CONFLICT', 'CATCH_UP_WINDOW_EXCEEDED',
] as const;
type SnapshotName = (typeof SNAPSHOT_NAMES)[number];
type VersionCounts = Readonly<{ legacy: number; v0: number; v1: number }>;

interface Admission {
  readonly version: 1;
  readonly enabled: boolean;
  readonly providerId: string | null;
  readonly scanActive: boolean;
  readonly workerClaimReady: boolean;
  readonly source: Readonly<Record<'websocketOnly' | 'catchUpOnly' | 'websocketAndCatchUp', number>>;
  readonly priority: Readonly<Record<'normal' | 'launchCandidate' | 'trackedTrade', number>>;
}

interface Hydration {
  readonly version: 1;
  readonly enabled: boolean;
  readonly callerConcurrency: number;
  readonly fetches: number;
  readonly oversizeBypasses: number;
  readonly fetchFailures: number;
  readonly epochInvalidations: number;
  readonly retainedEntries: number;
  readonly retainedBytes: number;
  readonly inFlightFetches: number;
  readonly queuedFetches: number;
}

interface RpcProvider {
  readonly providerId: string;
  readonly configured: boolean;
  readonly attempts: number;
  readonly http429Responses: number;
}

interface RpcEvidence {
  readonly version: 1;
  readonly overflowed: boolean;
  readonly providers: readonly RpcProvider[];
}

interface Snapshot {
  readonly observedAtMs: number;
  readonly status: string;
  readonly pipelinePumpfun: string;
  readonly pipelinePumpswap: string;
  readonly runtimeState: string;
  readonly subscriberState: string;
  readonly scannerState: string;
  readonly workerState: string;
  readonly reconcilerState: string;
  readonly backlogCount: number;
  readonly leasedCount: number;
  readonly websocket: Readonly<{
    phase: string;
    providerId: string | null;
    recoveryStatus: string;
    recoveryReasonCode: string;
  }>;
  readonly catchUpAdmission: Admission;
  readonly blockHydration: Hydration;
  readonly rpcHttpEvidence: RpcEvidence;
  readonly decoderQuarantine: Readonly<{ version: 1; unresolvedCount: number }>;
  readonly inbox: Readonly<{
    total: number;
    distinctSignatures: number;
    exhausted: number;
    quarantined: number;
    overlapCount: number;
    finalityContradictions: number;
    replayReceiptViolations: number;
    admissionReceiptViolations: number;
    terminalRetentionViolations: number;
  }>;
  readonly rssBytes: number;
}

interface StoppedHeartbeat {
  readonly runtimeState: string;
  readonly subscriberState: string;
  readonly scannerState: string;
  readonly workerState: string;
  readonly reconcilerState: string;
  readonly backlogCount: number;
  readonly leasedCount: number;
  readonly catchUpAdmission: Admission;
  readonly blockHydration: Hydration;
  readonly rpcHttpEvidence: RpcEvidence;
  readonly firstProcessingCanary: RuntimeFirstProcessingCanaryEvidenceV1;
}

interface FinalityDiagnostic {
  readonly event: 'listener.finality_reconciler_degraded' | 'listener.finality_reconciler_recovered';
  readonly phase: 'DEGRADED' | 'RECOVERED';
  readonly reasonCode: string | null;
  readonly degradedAtMs: number;
  readonly observedAtMs: number;
}

interface TerminalGroup {
  readonly processingStatus: 'FAILED' | 'QUARANTINED';
  readonly reasonCode: string | null;
  readonly errorCode: string | null;
  readonly count: number;
}

interface CanaryInput {
  readonly commit: string;
  readonly snapshots: Readonly<Record<SnapshotName, Snapshot>>;
  readonly stoppedHeartbeat: StoppedHeartbeat;
  readonly finalityDiagnostics: readonly FinalityDiagnostic[];
  readonly providerMixingEvidenceCount: number;
  readonly terminalEvidence: Readonly<{
    baseline: Readonly<{ exhausted: number; quarantined: number }>;
    final: Readonly<{ exhausted: number; quarantined: number }>;
    groups: readonly TerminalGroup[];
  }>;
  readonly postStopActionableCount: number;
  readonly versionReplayProof: Readonly<{
    freshDatabase: boolean;
    observed: VersionCounts;
    normalized: VersionCounts;
    persisted: VersionCounts;
  }>;
  readonly rssLimitBytes: number;
  readonly cleanupComplete: boolean;
}

class InvalidEvidence extends Error {}

export function evaluateMainnetObserveCanary(input: unknown): MainnetObserveCanaryResultV1 {
  let evidence: CanaryInput;
  try {
    evidence = parseInput(input);
  } catch {
    return result(null, allGates('INCONCLUSIVE', 'INVALID_EVIDENCE'));
  }
  const gates: Record<MainnetObserveCanaryGateName, MainnetObserveCanaryGateResultV1> = {
    runtime: evaluateRuntime(evidence),
    http429: evaluateHttp429(evidence),
    backlog: evaluateBacklog(evidence),
    terminalFailures: evaluateTerminal(evidence),
    idempotence: evaluateIdempotence(evidence),
    retention: evaluateRetention(evidence),
    decoderQuarantine: evaluateDecoder(evidence),
    firstProcessing: gate(evidence.stoppedHeartbeat.firstProcessingCanary.verdict,
      `FIRST_PROCESSING_${evidence.stoppedHeartbeat.firstProcessingCanary.verdict}`),
    blockHydration: evaluateHydration(evidence),
    catchUpAdmission: evaluateAdmission(evidence),
    providerAffinity: evaluateAffinity(evidence),
    rss: evaluateRss(evidence),
    pumpswap: evaluatePumpSwap(evidence),
    finality: evaluateFinality(evidence),
    versionsAndFreshReplay: evaluateVersions(evidence),
    shutdown: evaluateShutdown(evidence),
    cleanup: evidence.cleanupComplete ? gate('PASS', 'CLEANUP_COMPLETE')
      : gate('FAIL', 'CLEANUP_INCOMPLETE'),
  };
  return result(evidence.commit, gates);
}

function evaluateRuntime(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  const snapshots = orderedSnapshots(input);
  if (!strictlyIncreasing(snapshots.map((snapshot) => snapshot.observedAtMs))) {
    return gate('INCONCLUSIVE', 'RUNTIME_TIMELINE_INVALID');
  }
  const final = input.snapshots.FINAL_PRESTOP;
  if (final.websocket.recoveryStatus === 'IN_PROGRESS'
    || final.websocket.recoveryReasonCode === 'RPC_UNAVAILABLE'
    || final.websocket.phase === 'RECOVERING'
    || final.subscriberState === 'DEGRADED'
    || final.scannerState === 'DEGRADED') {
    return gate('FAIL', 'RUNTIME_RECOVERY_UNRESOLVED');
  }
  if (snapshots.some((snapshot) => snapshot.runtimeState !== 'RUNNING'
    || snapshot.workerState !== 'RUNNING')) return gate('FAIL', 'RUNTIME_COMPONENT_NOT_RUNNING');
  if (snapshots.some((snapshot) => snapshot.status !== 'OK'
    || snapshot.subscriberState !== 'RUNNING' || snapshot.scannerState !== 'RUNNING')) {
    return gate('FAIL', 'RUNTIME_COMPONENT_DEGRADED');
  }
  return gate('PASS', 'RUNTIME_HEALTHY');
}

function evaluateHttp429(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  const snapshots = orderedSnapshots(input);
  const rpcSnapshots = [...snapshots.map((snapshot) => snapshot.rpcHttpEvidence),
    input.stoppedHeartbeat.rpcHttpEvidence];
  if (rpcSnapshots.some((rpcEvidence) => rpcEvidence.overflowed)) {
    return gate('INCONCLUSIVE', 'RPC_COUNTER_OVERFLOW');
  }
  const firstEvidence = rpcSnapshots[0];
  if (firstEvidence === undefined) return gate('INCONCLUSIVE', 'RPC_COUNTERS_INCOHERENT');
  const ids = firstEvidence.providers.map((provider) => provider.providerId);
  for (let index = 1; index < rpcSnapshots.length; index += 1) {
    const previousEvidence = rpcSnapshots[index - 1];
    const currentEvidence = rpcSnapshots[index];
    if (previousEvidence === undefined || currentEvidence === undefined) {
      return gate('INCONCLUSIVE', 'RPC_COUNTERS_INCOHERENT');
    }
    const previous = previousEvidence.providers;
    const current = currentEvidence.providers;
    if (current.length !== previous.length
      || !sameStrings(ids, current.map((provider) => provider.providerId))
      || previous.some((provider, providerIndex) => {
        const next = current[providerIndex];
        return next !== undefined && (provider.configured !== next.configured
          || provider.attempts > next.attempts
          || provider.http429Responses > next.http429Responses);
      })) return gate('INCONCLUSIVE', 'RPC_COUNTERS_INCOHERENT');
  }
  const first = firstEvidence.providers;
  const last = input.stoppedHeartbeat.rpcHttpEvidence.providers;
  const attemptDelta = sum(last.map((provider, index) => provider.attempts - (first[index]?.attempts ?? 0)));
  const responseDelta = sum(last.map((provider, index) => provider.http429Responses
    - (first[index]?.http429Responses ?? 0)));
  if (attemptDelta === null || responseDelta === null || attemptDelta <= 0) {
    return gate('INCONCLUSIVE', 'RPC_TRAFFIC_INSUFFICIENT');
  }
  return responseDelta > 0 ? gate('FAIL', 'RPC_HTTP_429_OBSERVED') : gate('PASS', 'RPC_HTTP_429_NONE');
}

function evaluateBacklog(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  return nonIncreasing(orderedSnapshots(input).map((snapshot) => snapshot.backlogCount))
    ? gate('PASS', 'BACKLOG_NON_GROWING') : gate('FAIL', 'BACKLOG_GREW');
}

function evaluateTerminal(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  const { baseline, final, groups } = input.terminalEvidence;
  if (final.exhausted < baseline.exhausted || final.quarantined < baseline.quarantined) {
    return gate('INCONCLUSIVE', 'TERMINAL_COUNTER_RESET');
  }
  const exhaustedDelta = final.exhausted - baseline.exhausted;
  const quarantinedDelta = final.quarantined - baseline.quarantined;
  if (exhaustedDelta > 0) return gate('FAIL', 'TERMINAL_RETRIES_EXHAUSTED');
  const grouped = sum(groups.map((group) => group.count));
  if (grouped === null || grouped !== exhaustedDelta + quarantinedDelta
    || groups.some((group) => group.reasonCode === null || group.errorCode === null)) {
    return exhaustedDelta + quarantinedDelta > 0
      ? gate('INCONCLUSIVE', 'TERMINAL_GROUPS_INCOMPLETE') : gate('PASS', 'TERMINAL_NONE');
  }
  return grouped > 0 ? gate('FAIL', 'TERMINAL_FAILURES_OBSERVED') : gate('PASS', 'TERMINAL_NONE');
}

function evaluateIdempotence(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  return orderedSnapshots(input).every((snapshot) => snapshot.inbox.total
    === snapshot.inbox.distinctSignatures && snapshot.inbox.admissionReceiptViolations === 0)
    ? gate('PASS', 'IDEMPOTENCE_CONFIRMED') : gate('FAIL', 'IDEMPOTENCE_VIOLATION');
}

function evaluateRetention(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  return orderedSnapshots(input).every((snapshot) => snapshot.inbox.terminalRetentionViolations === 0)
    ? gate('PASS', 'RETENTION_CONFIRMED') : gate('FAIL', 'RETENTION_VIOLATION');
}

function evaluateDecoder(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  return orderedSnapshots(input).every((snapshot) => snapshot.decoderQuarantine.unresolvedCount === 0)
    ? gate('PASS', 'DECODER_QUARANTINE_EMPTY') : gate('FAIL', 'DECODER_QUARANTINE_UNRESOLVED');
}

function evaluateHydration(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  const snapshots = orderedSnapshots(input);
  if (snapshots.some((snapshot) => !snapshot.blockHydration.enabled
    || snapshot.blockHydration.callerConcurrency !== 1 || snapshot.blockHydration.queuedFetches > 1
    || snapshot.blockHydration.inFlightFetches > 1)) {
    return gate('INCONCLUSIVE', 'BLOCK_HYDRATION_CONTRACT_INVALID');
  }
  const first = snapshots[0];
  const last = snapshots[3];
  const fetchDelta = last.blockHydration.fetches - first.blockHydration.fetches;
  const failureDelta = last.blockHydration.fetchFailures - first.blockHydration.fetchFailures;
  const oversizeDelta = last.blockHydration.oversizeBypasses - first.blockHydration.oversizeBypasses;
  const elapsedSeconds = (last.observedAtMs - first.observedAtMs) / 1_000;
  if (fetchDelta <= 0 || failureDelta < 0 || oversizeDelta < 0 || elapsedSeconds <= 0) {
    return gate('INCONCLUSIVE', 'BLOCK_HYDRATION_COUNTERS_INCOHERENT');
  }
  if (failureDelta > 0 || oversizeDelta > 1 || fetchDelta / elapsedSeconds > 4) {
    return gate('FAIL', 'BLOCK_HYDRATION_LIMIT_EXCEEDED');
  }
  return gate('PASS', 'BLOCK_HYDRATION_WITHIN_LIMITS');
}

function evaluateAdmission(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  for (const snapshot of orderedSnapshots(input)) {
    const admission = snapshot.catchUpAdmission;
    if (!admission.enabled) return gate('INCONCLUSIVE', 'ADMISSION_DISABLED');
    if ((admission.scanActive || admission.workerClaimReady) && admission.providerId === null) {
      return gate('INCONCLUSIVE', 'ADMISSION_PROVIDER_MISSING');
    }
    if (partitionTotal(admission.source) !== snapshot.backlogCount
      || partitionTotal(admission.priority) !== snapshot.backlogCount) {
      return gate('INCONCLUSIVE', 'ADMISSION_PARTITIONS_INCOHERENT');
    }
    if (admission.providerId !== snapshot.websocket.providerId) {
      return gate('INCONCLUSIVE', 'ADMISSION_PROVIDER_INCOHERENT');
    }
  }
  return gate('PASS', 'ADMISSION_PROVIDER_AFFINE');
}

function evaluateAffinity(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  if (input.providerMixingEvidenceCount > 0) return gate('FAIL', 'PROVIDER_MIXING_OBSERVED');
  const snapshots = orderedSnapshots(input);
  if (!nonDecreasing(snapshots.map((snapshot) => snapshot.blockHydration.epochInvalidations))) {
    return gate('INCONCLUSIVE', 'EPOCH_COUNTER_RESET');
  }
  const ids = snapshots.map((snapshot) => snapshot.catchUpAdmission.providerId);
  if (ids.some((id) => id === null)) return gate('INCONCLUSIVE', 'AFFINITY_PROVIDER_MISSING');
  return ids.every((id) => id === ids[0]) ? gate('PASS', 'PROVIDER_AFFINITY_STABLE')
    : gate('INCONCLUSIVE', 'PROVIDER_SWITCH_UNPROVEN');
}

function evaluateRss(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  return input.snapshots.T_PLUS_5.rssBytes <= input.rssLimitBytes
    && input.snapshots.FINAL_PRESTOP.rssBytes <= input.rssLimitBytes
    ? gate('PASS', 'RSS_WITHIN_LIMIT') : gate('FAIL', 'RSS_LIMIT_EXCEEDED');
}

function evaluatePumpSwap(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  return orderedSnapshots(input).every((snapshot) => snapshot.pipelinePumpswap === 'IDLE')
    ? gate('PASS', 'PUMPSWAP_ISOLATED') : gate('FAIL', 'PUMPSWAP_NOT_ISOLATED');
}

function evaluateFinality(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  const snapshots = orderedSnapshots(input);
  if (snapshots.some((snapshot) => snapshot.reconcilerState !== 'RUNNING')) {
    return gate('FAIL', 'FINALITY_RECONCILER_NOT_RUNNING');
  }
  const finalInbox = input.snapshots.FINAL_PRESTOP.inbox;
  if (finalInbox.finalityContradictions > 0 || finalInbox.replayReceiptViolations > 0) {
    return gate('FAIL', 'FINALITY_CONTRADICTION');
  }
  if (finalInbox.overlapCount <= 0) return gate('INCONCLUSIVE', 'FINALITY_OVERLAP_MISSING');
  let open: FinalityDiagnostic | null = null;
  let lastObservedAtMs = -1;
  for (const diagnostic of input.finalityDiagnostics) {
    if (diagnostic.observedAtMs < lastObservedAtMs) {
      return gate('INCONCLUSIVE', 'FINALITY_DIAGNOSTICS_UNPAIRABLE');
    }
    lastObservedAtMs = diagnostic.observedAtMs;
    if (diagnostic.event === 'listener.finality_reconciler_degraded') {
      if (diagnostic.phase !== 'DEGRADED' || diagnostic.reasonCode === null || open !== null
        || diagnostic.observedAtMs !== diagnostic.degradedAtMs) {
        return gate('INCONCLUSIVE', 'FINALITY_DIAGNOSTICS_UNPAIRABLE');
      }
      open = diagnostic;
    } else {
      if (diagnostic.phase !== 'RECOVERED' || diagnostic.reasonCode !== null
        || diagnostic.degradedAtMs !== open?.degradedAtMs
        || diagnostic.observedAtMs < diagnostic.degradedAtMs) {
        return gate('INCONCLUSIVE', 'FINALITY_DIAGNOSTICS_UNPAIRABLE');
      }
      if (diagnostic.observedAtMs >= input.snapshots.T0.observedAtMs) {
        return gate('FAIL', 'FINALITY_INCIDENT_DURING_CANARY');
      }
      open = null;
    }
  }
  return open === null ? gate('PASS', 'FINALITY_HEALTHY') : gate('FAIL', 'FINALITY_INCIDENT_OPEN');
}

function evaluateVersions(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  const proof = input.versionReplayProof;
  const observed = [proof.observed.legacy, proof.observed.v0, proof.observed.v1];
  const normalized = [proof.normalized.legacy, proof.normalized.v0, proof.normalized.v1];
  const persisted = [proof.persisted.legacy, proof.persisted.v0, proof.persisted.v1];
  return proof.freshDatabase && observed.every((value) => value > 0)
    && persisted.every((value) => value > 0) && observed.every((value, index) => value === normalized[index])
    ? gate('PASS', 'VERSIONS_REPLAY_CONFIRMED') : gate('FAIL', 'VERSIONS_REPLAY_INCOMPLETE');
}

function evaluateShutdown(input: CanaryInput): MainnetObserveCanaryGateResultV1 {
  const stopped = input.stoppedHeartbeat;
  if ([stopped.runtimeState, stopped.subscriberState, stopped.scannerState,
    stopped.workerState, stopped.reconcilerState].some((state) => state !== 'STOPPED')
    || stopped.leasedCount !== 0 || stopped.catchUpAdmission.scanActive
    || stopped.catchUpAdmission.workerClaimReady || stopped.catchUpAdmission.providerId !== null
    || stopped.blockHydration.queuedFetches !== 0 || stopped.blockHydration.inFlightFetches !== 0
    || stopped.blockHydration.retainedEntries !== 0 || stopped.blockHydration.retainedBytes !== 0) {
    return gate('FAIL', 'SHUTDOWN_RESIDUAL_WORK');
  }
  if (partitionTotal(stopped.catchUpAdmission.source) !== stopped.backlogCount
    || partitionTotal(stopped.catchUpAdmission.priority) !== stopped.backlogCount
    || input.postStopActionableCount !== stopped.backlogCount) {
    return gate('INCONCLUSIVE', 'SHUTDOWN_DURABLE_COUNTS_INCOHERENT');
  }
  return gate('PASS', 'SHUTDOWN_CLEAN_WITH_DURABLE_BACKLOG');
}

function parseInput(value: unknown): CanaryInput {
  const input = exactObject(value, [
    'schemaVersion', 'commit', 'snapshots', 'stoppedHeartbeat', 'finalityDiagnostics',
    'providerMixingEvidenceCount', 'terminalEvidence', 'postStopActionableCount',
    'versionReplayProof', 'rssLimitBytes', 'cleanupComplete',
  ]);
  if (input.schemaVersion !== 'mainnet-observe-canary-input.v1'
    || typeof input.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(input.commit)) invalid();
  const sourceSnapshots = exactObject(input.snapshots, SNAPSHOT_NAMES);
  const snapshots = Object.freeze({ T0: parseSnapshot(sourceSnapshots.T0),
    T_PLUS_5: parseSnapshot(sourceSnapshots.T_PLUS_5),
    T_PLUS_15: parseSnapshot(sourceSnapshots.T_PLUS_15),
    FINAL_PRESTOP: parseSnapshot(sourceSnapshots.FINAL_PRESTOP) });
  const terminal = exactObject(input.terminalEvidence, ['baseline', 'final', 'groups']);
  const proof = exactObject(input.versionReplayProof,
    ['freshDatabase', 'observed', 'normalized', 'persisted']);
  return Object.freeze({
    commit: input.commit, snapshots, stoppedHeartbeat: parseStopped(input.stoppedHeartbeat),
    finalityDiagnostics: Object.freeze(exactArray(input.finalityDiagnostics).map(parseFinality)),
    providerMixingEvidenceCount: integer(input.providerMixingEvidenceCount),
    terminalEvidence: Object.freeze({ baseline: parseTerminalCounts(terminal.baseline),
      final: parseTerminalCounts(terminal.final),
      groups: Object.freeze(exactArray(terminal.groups).map(parseTerminalGroup)) }),
    postStopActionableCount: integer(input.postStopActionableCount),
    versionReplayProof: Object.freeze({ freshDatabase: bool(proof.freshDatabase),
      observed: parseVersionCounts(proof.observed), normalized: parseVersionCounts(proof.normalized),
      persisted: parseVersionCounts(proof.persisted) }),
    rssLimitBytes: positiveInteger(input.rssLimitBytes), cleanupComplete: bool(input.cleanupComplete),
  });
}

function parseSnapshot(value: unknown): Snapshot {
  const input = exactObject(value, [
    'observedAtMs', 'status', 'pipelinePumpfun', 'pipelinePumpswap', 'runtimeState',
    'subscriberState', 'scannerState', 'workerState', 'reconcilerState', 'backlogCount',
    'leasedCount', 'websocket', 'catchUpAdmission', 'blockHydration', 'rpcHttpEvidence',
    'decoderQuarantine', 'inbox', 'rssBytes',
  ]);
  const websocket = exactObject(input.websocket,
    ['phase', 'providerId', 'recoveryStatus', 'recoveryReasonCode']);
  const decoder = exactObject(input.decoderQuarantine, ['version', 'unresolvedCount']);
  if (decoder.version !== 1) invalid();
  const inbox = exactObject(input.inbox, [
    'total', 'distinctSignatures', 'exhausted', 'quarantined', 'overlapCount',
    'finalityContradictions', 'replayReceiptViolations', 'admissionReceiptViolations',
    'terminalRetentionViolations',
  ]);
  return Object.freeze({
    observedAtMs: integer(input.observedAtMs), status: enumeration(input.status, HEALTH_STATUSES),
    pipelinePumpfun: enumeration(input.pipelinePumpfun, PIPELINE_STATES),
    pipelinePumpswap: enumeration(input.pipelinePumpswap, PIPELINE_STATES),
    runtimeState: enumeration(input.runtimeState, RUNTIME_STATES),
    subscriberState: enumeration(input.subscriberState, RUNTIME_STATES),
    scannerState: enumeration(input.scannerState, RUNTIME_STATES),
    workerState: enumeration(input.workerState, RUNTIME_STATES),
    reconcilerState: enumeration(input.reconcilerState, RUNTIME_STATES),
    backlogCount: integer(input.backlogCount),
    leasedCount: integer(input.leasedCount),
    websocket: Object.freeze({ phase: enumeration(websocket.phase, WEBSOCKET_PHASES),
      providerId: nullableProviderId(websocket.providerId),
      recoveryStatus: enumeration(websocket.recoveryStatus, RECOVERY_STATUSES),
      recoveryReasonCode: enumeration(websocket.recoveryReasonCode, RECOVERY_REASON_CODES) }),
    catchUpAdmission: parseAdmission(input.catchUpAdmission), blockHydration: parseHydration(input.blockHydration),
    rpcHttpEvidence: parseRpc(input.rpcHttpEvidence),
    decoderQuarantine: Object.freeze({ version: 1, unresolvedCount: integer(decoder.unresolvedCount) }),
    inbox: Object.freeze({ total: integer(inbox.total), distinctSignatures: integer(inbox.distinctSignatures),
      exhausted: integer(inbox.exhausted), quarantined: integer(inbox.quarantined),
      overlapCount: integer(inbox.overlapCount), finalityContradictions: integer(inbox.finalityContradictions),
      replayReceiptViolations: integer(inbox.replayReceiptViolations),
      admissionReceiptViolations: integer(inbox.admissionReceiptViolations),
      terminalRetentionViolations: integer(inbox.terminalRetentionViolations) }),
    rssBytes: integer(input.rssBytes),
  });
}

function parseStopped(value: unknown): StoppedHeartbeat {
  const input = exactObject(value, [
    'runtimeState', 'subscriberState', 'scannerState', 'workerState', 'reconcilerState',
    'backlogCount', 'leasedCount', 'catchUpAdmission', 'blockHydration', 'rpcHttpEvidence',
    'firstProcessingCanary',
  ]);
  return Object.freeze({ runtimeState: enumeration(input.runtimeState, RUNTIME_STATES),
    subscriberState: enumeration(input.subscriberState, RUNTIME_STATES),
    scannerState: enumeration(input.scannerState, RUNTIME_STATES),
    workerState: enumeration(input.workerState, RUNTIME_STATES),
    reconcilerState: enumeration(input.reconcilerState, RUNTIME_STATES),
    backlogCount: integer(input.backlogCount),
    leasedCount: integer(input.leasedCount), catchUpAdmission: parseAdmission(input.catchUpAdmission),
    blockHydration: parseHydration(input.blockHydration),
    rpcHttpEvidence: parseRpc(input.rpcHttpEvidence),
    firstProcessingCanary: createFirstProcessingCanaryEvidence(input.firstProcessingCanary) });
}

function parseAdmission(value: unknown): Admission {
  const input = exactObject(value,
    ['version', 'enabled', 'providerId', 'scanActive', 'workerClaimReady', 'source', 'priority']);
  if (input.version !== 1) invalid();
  const source = exactObject(input.source, ['websocketOnly', 'catchUpOnly', 'websocketAndCatchUp']);
  const priority = exactObject(input.priority, ['normal', 'launchCandidate', 'trackedTrade']);
  return Object.freeze({ version: 1, enabled: bool(input.enabled),
    providerId: nullableProviderId(input.providerId), scanActive: bool(input.scanActive),
    workerClaimReady: bool(input.workerClaimReady),
    source: Object.freeze({ websocketOnly: integer(source.websocketOnly),
      catchUpOnly: integer(source.catchUpOnly), websocketAndCatchUp: integer(source.websocketAndCatchUp) }),
    priority: Object.freeze({ normal: integer(priority.normal),
      launchCandidate: integer(priority.launchCandidate), trackedTrade: integer(priority.trackedTrade) }) });
}

function parseHydration(value: unknown): Hydration {
  const input = exactObject(value, [
    'version', 'enabled', 'callerConcurrency', 'fetches', 'oversizeBypasses', 'fetchFailures',
    'epochInvalidations', 'retainedEntries', 'retainedBytes', 'inFlightFetches', 'queuedFetches',
  ]);
  if (input.version !== 1) invalid();
  return Object.freeze({ version: 1, enabled: bool(input.enabled),
    callerConcurrency: integer(input.callerConcurrency), fetches: integer(input.fetches),
    oversizeBypasses: integer(input.oversizeBypasses), fetchFailures: integer(input.fetchFailures),
    epochInvalidations: integer(input.epochInvalidations), retainedEntries: integer(input.retainedEntries),
    retainedBytes: integer(input.retainedBytes), inFlightFetches: integer(input.inFlightFetches),
    queuedFetches: integer(input.queuedFetches) });
}

function parseRpc(value: unknown): RpcEvidence {
  const input = exactObject(value, ['version', 'overflowed', 'providers']);
  if (input.version !== 1) invalid();
  const providers = exactArray(input.providers).map((provider) => {
    const fields = exactObject(provider, ['providerId', 'configured', 'attempts', 'http429Responses']);
    return Object.freeze({ providerId: providerId(fields.providerId), configured: bool(fields.configured),
      attempts: integer(fields.attempts), http429Responses: integer(fields.http429Responses) });
  });
  if (providers.length === 0 || new Set(providers.map((provider) => provider.providerId)).size !== providers.length) invalid();
  return Object.freeze({ version: 1, overflowed: bool(input.overflowed), providers: Object.freeze(providers) });
}

function parseFinality(value: unknown): FinalityDiagnostic {
  const input = exactObject(value, ['event', 'phase', 'reasonCode', 'degradedAtMs', 'observedAtMs']);
  if (input.event !== 'listener.finality_reconciler_degraded'
    && input.event !== 'listener.finality_reconciler_recovered') invalid();
  if (input.phase !== 'DEGRADED' && input.phase !== 'RECOVERED') invalid();
  return Object.freeze({ event: input.event, phase: input.phase,
    reasonCode: nullableCode(input.reasonCode), degradedAtMs: integer(input.degradedAtMs),
    observedAtMs: integer(input.observedAtMs) });
}

function parseTerminalGroup(value: unknown): TerminalGroup {
  const input = exactObject(value, ['processingStatus', 'reasonCode', 'errorCode', 'count']);
  if (input.processingStatus !== 'FAILED' && input.processingStatus !== 'QUARANTINED') invalid();
  return Object.freeze({ processingStatus: input.processingStatus,
    reasonCode: nullableCode(input.reasonCode), errorCode: nullableCode(input.errorCode),
    count: integer(input.count) });
}

function parseTerminalCounts(value: unknown): Readonly<{ exhausted: number; quarantined: number }> {
  const input = exactObject(value, ['exhausted', 'quarantined']);
  return Object.freeze({ exhausted: integer(input.exhausted), quarantined: integer(input.quarantined) });
}

function parseVersionCounts(value: unknown): VersionCounts {
  const input = exactObject(value, ['legacy', 'v0', 'v1']);
  return Object.freeze({ legacy: integer(input.legacy), v0: integer(input.v0), v1: integer(input.v1) });
}

function exactObject<const K extends readonly string[]>(value: unknown, keys: K): Record<K[number], unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string'
      || !keys.includes(key))) invalid();
    const result = {} as Record<K[number], unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalid();
      result[key as K[number]] = descriptor.value as unknown;
    }
    return result;
  } catch (error) {
    if (error instanceof InvalidEvidence) throw error;
    invalid();
  }
}

function exactArray(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (ownKeys.some((key) => typeof key !== 'string')) invalid();
    const stringKeys = ownKeys as string[];
    if (stringKeys.length !== value.length
      || stringKeys.some((key, index) => key !== String(index))) invalid();
    return Object.freeze(stringKeys.map((key) => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalid();
      return descriptor.value as unknown;
    }));
  } catch (error) {
    if (error instanceof InvalidEvidence) throw error;
    invalid();
  }
}

function allGates(verdict: MainnetObserveCanaryVerdict, reasonCode: string):
Readonly<Record<MainnetObserveCanaryGateName, MainnetObserveCanaryGateResultV1>> {
  return Object.freeze(Object.fromEntries(MAINNET_OBSERVE_CANARY_GATE_NAMES.map((name) =>
    [name, gate(verdict, reasonCode)])) as unknown as
    Record<MainnetObserveCanaryGateName, MainnetObserveCanaryGateResultV1>);
}

function result(commit: string | null,
  gates: Readonly<Record<MainnetObserveCanaryGateName, MainnetObserveCanaryGateResultV1>>):
MainnetObserveCanaryResultV1 {
  const frozenGates = Object.freeze(Object.fromEntries(MAINNET_OBSERVE_CANARY_GATE_NAMES.map((name) =>
    [name, gates[name]])) as unknown as Record<MainnetObserveCanaryGateName, MainnetObserveCanaryGateResultV1>);
  return Object.freeze({ schemaVersion: 'mainnet-observe-canary-result.v1', commit,
    overallVerdict: aggregateVerdict(MAINNET_OBSERVE_CANARY_GATE_NAMES.map((name) => frozenGates[name].verdict)),
    gates: frozenGates });
}

function aggregateVerdict(values: readonly MainnetObserveCanaryVerdict[]): MainnetObserveCanaryVerdict {
  if (values.includes('FAIL')) return 'FAIL';
  if (values.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PASS';
}

function gate(verdict: MainnetObserveCanaryVerdict, reasonCode: string): MainnetObserveCanaryGateResultV1 {
  return Object.freeze({ verdict, reasonCode });
}

function orderedSnapshots(input: CanaryInput): readonly [Snapshot, Snapshot, Snapshot, Snapshot] {
  return [input.snapshots.T0, input.snapshots.T_PLUS_5, input.snapshots.T_PLUS_15,
    input.snapshots.FINAL_PRESTOP];
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  const parsed = integer(value);
  if (parsed === 0) invalid();
  return parsed;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function code(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) invalid();
  return value;
}

function enumeration<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid();
  return value;
}

function nullableCode(value: unknown): string | null {
  return value === null ? null : code(value);
}

function providerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(value)) invalid();
  return value;
}

function nullableProviderId(value: unknown): string | null {
  return value === null ? null : providerId(value);
}

function partitionTotal(partition: Readonly<Record<string, number>>): number | null {
  return sum(Object.values(partition));
}

function sum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function strictlyIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));
}

function nonIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value <= (values[index - 1] ?? value));
}

function nonDecreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value >= (values[index - 1] ?? value));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(): never {
  throw new InvalidEvidence('Mainnet observe canary evidence is invalid.');
}
