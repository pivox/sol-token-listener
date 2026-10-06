import type { ApiErrorCode } from './errors.js';
import type { RuntimeBlockHydrationAdmissionMetricsV1 } from '../domain/block-hydration-admission.js';
import type {
  RuntimeBlockHydrationMetricsV2,
  RuntimeBlockHydrationAdmissionMetricsV2,
  RuntimeOrdinaryRpcBudgetMetricsV2,
  RuntimeBlockResponseMemoryMetricsV2,
} from '../domain/two-group-hydration-evidence.js';
import type { DomainEventType } from '../domain/events.js';
import type { LaunchStatus } from '../domain/launch-status.js';
import type { PaperPositionStatus } from '../domain/paper-trading.js';
import type {
  QualificationEvidenceStatus,
  QualificationConditionMode,
  QualificationConditionStatus,
  QualificationSignalKey,
  QualificationVerdict,
} from '../domain/qualification.js';
import type { QualificationReasonCode } from '../domain/qualification-reasons.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import type { ListenerRuntimeState } from '../domain/transaction-ingestion.js';
import type {
  PublicWebSocketHealthState,
  WebSocketDisconnectReasonCode,
  WebSocketHealthPhase,
  WebSocketHealthSupervision,
  WebSocketRecoveryReasonCode,
  WebSocketRecoveryStatus,
} from '../domain/websocket-health.js';
import type { RpcProviderId } from '../domain/rpc-provider.js';
import type { RuntimeRpcHttpRoleEvidenceV1 } from '../domain/rpc-http-role-evidence.js';
import type { RuntimeBlockHydrationPhaseEvidenceV1 } from '../domain/block-hydration-phase-evidence.js';
import type { ScannerPhaseDiagnosticsV1 } from '../domain/scanner-phase-diagnostics.js';
import type {
  CreationExitReason,
  PaperDecisionReasonCode,
  PaperMinimumConfirmation,
  PaperStrategySessionState,
} from '../domain/paper-strategy.js';
import type { TradingCandidateState } from '../domain/trading-candidate.js';

export const API_VERSION = 'v1' as const;
export const MAX_API_JSON_DEPTH = 64;
export const MAX_API_JSON_NODES = 10_000;

export type ApiJsonPrimitive = string | number | boolean | null;
export interface ApiJsonObject {
  readonly [key: string]: ApiJsonValue;
}
export type ApiJsonValue =
  | ApiJsonPrimitive
  | readonly ApiJsonValue[]
  | ApiJsonObject;

declare const apiDomainPayloadBrand: unique symbol;
export type ApiDomainPayload = ApiJsonValue & {
  readonly [apiDomainPayloadBrand]: 'ApiDomainPayload';
};

export type ApiBlockHydrationAdmissionMetricsV1 = RuntimeBlockHydrationAdmissionMetricsV1;
export type ApiBlockHydrationMetricsV2 = RuntimeBlockHydrationMetricsV2;
export type ApiBlockHydrationAdmissionMetricsV2 = RuntimeBlockHydrationAdmissionMetricsV2;
export type ApiOrdinaryRpcBudgetMetricsV2 = RuntimeOrdinaryRpcBudgetMetricsV2;
export type ApiBlockResponseMemoryMetricsV2 = RuntimeBlockResponseMemoryMetricsV2;

export interface ApiMeta {
  readonly generatedAt: string;
  readonly nextCursor: string | null;
}

export interface ApiSuccess<T> {
  readonly apiVersion: typeof API_VERSION;
  readonly meta: ApiMeta;
  readonly data: T;
}

export interface ApiFailure {
  readonly apiVersion: typeof API_VERSION;
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly correlationId?: string;
  };
}

export interface ApiPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type ApiAvailability = 'AVAILABLE' | 'NOT_AVAILABLE';

export interface ApiLaunchSummary {
  readonly mint: string;
  readonly detectedAt: string;
  readonly detectedSlot: string;
  readonly status: LaunchStatus;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly quoteMint: string | null;
  readonly quoteDecimals: number | null;
  readonly marketCapQuote: string | null;
  readonly liquidityQuote: string | null;
  readonly qualificationSummary: ApiQualificationSummary | null;
  readonly candidate: ApiTradingCandidate | null;
  readonly paperStrategy: ApiPaperStrategyProgress | null;
}

export interface ApiLaunchDetail extends ApiLaunchSummary {
  readonly creator: string;
  readonly tokenProgram: string;
  readonly launchpad: string;
  readonly initialTokenAmount: string | null;
  readonly initialQuoteAmount: string | null;
  readonly reserveBase: string | null;
  readonly reserveQuote: string | null;
  readonly feeBps: string | null;
}

export interface ApiQualificationSummary {
  readonly verdict: QualificationVerdict;
  readonly scores: ApiQualificationScores;
  readonly blockerCodes: readonly QualificationReasonCode[];
  readonly evaluatedAt: string;
}

export interface ApiTradingCandidate {
  readonly id: string;
  readonly state: TradingCandidateState;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly qualificationReportId: string;
  readonly quoteMint: string;
  readonly quoteDecimals: number;
  readonly reasonCodes: readonly PaperDecisionReasonCode[];
  readonly eligibleUntil: string | null;
  readonly createdAt: string;
}

export interface ApiPaperStrategyProgress {
  readonly id: string;
  readonly state: PaperStrategySessionState;
  readonly reasonCode: PaperDecisionReasonCode;
  readonly pendingExitReason: CreationExitReason | null;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly positionId: string | null;
  readonly quoteMint: string;
  readonly externalBuyTarget: number;
  readonly externalBuyCount: number;
  readonly minimumConfirmation: PaperMinimumConfirmation;
  readonly updatedAt: string;
  readonly lastErrorCode: string | null;
  readonly lastErrorRetryable: boolean | null;
}

export interface ApiTimelineEntry {
  readonly id: string;
  readonly type: DomainEventType;
  readonly occurredAt: string;
  readonly slot: string | null;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly payloadVersion: number;
  readonly payload: ApiDomainPayload;
}

export interface ApiQualification {
  readonly ruleSet: ApiQualificationRuleset;
  readonly scores: ApiQualificationScores;
  readonly evidence: readonly ApiQualificationEvidence[];
  readonly conditions: readonly ApiQualificationCondition[];
  readonly blockers: readonly ApiQualificationBlocker[];
  readonly verdict: QualificationVerdict;
  readonly evaluatedAt: string;
}

export interface ApiQualificationRuleset {
  readonly id: string;
  readonly version: number;
  readonly status: 'UNVALIDATED_RULE_SET';
  readonly minimumTotalScore: number;
  readonly fingerprint: string | null;
}

export interface ApiQualificationCondition {
  readonly code: QualificationReasonCode;
  readonly mode: QualificationConditionMode;
  readonly status: QualificationConditionStatus;
  readonly observed: Readonly<Record<string, string | number | boolean | null>>;
  readonly thresholds: Readonly<Record<string, string | number | null>>;
  readonly message: string;
}

export interface ApiQualificationScores {
  readonly preparation: ApiQualificationScore;
  readonly socialAuthenticity: ApiQualificationScore;
  readonly onchainHealth: ApiQualificationScore;
  readonly total: ApiQualificationScore;
}

export interface ApiQualificationScore {
  readonly score: number;
  readonly maximum: number;
}

export interface ApiQualificationBlocker {
  readonly code: QualificationReasonCode;
  readonly message: string;
}

export interface ApiQualificationEvidence {
  readonly signal: QualificationSignalKey;
  readonly status: QualificationEvidenceStatus;
  readonly message: string;
}

export interface ApiPaperPosition {
  readonly id: string;
  readonly mint: string;
  readonly status: PaperPositionStatus;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly quoteMint: string;
  readonly quantity: string;
  readonly entryQuoteAmount: string;
  readonly exitQuoteAmount: string | null;
  readonly realizedPnlQuote: string | null;
  readonly estimatedFeesQuote: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly strategySessionId: string | null;
  readonly qualificationReportId: string | null;
  readonly candidateId: string | null;
  readonly externalBuyCount: number | null;
  readonly externalBuyTarget: number | null;
  readonly entryVenue: 'PUMP_FUN_BONDING_CURVE' | 'PUMPSWAP' | 'UNKNOWN';
  readonly reasonCodes: readonly PaperDecisionReasonCode[];
}

export interface ApiHealth {
  readonly status: 'OK' | 'DEGRADED';
  readonly observedAt: string;
  readonly postgresql: ApiHealthDependency;
  readonly http: ApiHealthDependency;
  readonly pipeline: ApiPipelineHealth;
  readonly qualification: ApiQualificationHealth;
  readonly paperDecisionJobs: ApiPaperDecisionJobHealth;
  readonly checkpoints: ApiCheckpoints;
  readonly heartbeat: ApiHeartbeat;
  readonly lagSlots: string | null;
}

export interface ApiHealthDependency {
  readonly status: 'AVAILABLE' | 'UNAVAILABLE';
}

export interface ApiPipelineHealth {
  readonly pumpfun: 'IDLE' | 'RUNNING' | 'DEGRADED' | 'STOPPED';
  readonly pumpswap: 'IDLE' | 'RUNNING' | 'DEGRADED' | 'STOPPED';
  readonly qualification: 'IDLE' | 'RUNNING' | 'DEGRADED' | 'STOPPED';
  readonly paperDecision: 'IDLE' | 'RUNNING' | 'DEGRADED' | 'STOPPED';
}

export interface ApiQualificationHealth {
  readonly currentCount: number;
  readonly lastSuccessAt: string | null;
}

export interface ApiPaperDecisionJobHealth {
  readonly pendingCount: number;
  readonly leasedCount: number;
  readonly retryableFailedCount: number;
  readonly exhaustedCount: number;
  readonly lastSuccessAt: string | null;
  readonly lastErrorCode: 'RPC_TRANSIENT' | 'QUOTE_UNAVAILABLE' | 'LEASE_EXPIRED' | 'DECISION_INVALID' | null;
}

export interface ApiCheckpoints {
  readonly launchpad: string | null;
  readonly market: string | null;
}

export interface ApiWebSocketHealth {
  readonly version: 1;
  readonly supervision: WebSocketHealthSupervision;
  readonly state: PublicWebSocketHealthState;
  readonly phase: WebSocketHealthPhase;
  readonly providerId: RpcProviderId | null;
  readonly candidateProviderId: RpcProviderId | null;
  readonly updatedAt: string | null;
  readonly heartbeatAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly lastObservation: Readonly<{
    readonly observedAt: string;
    readonly slot: string;
  }> | null;
  readonly disconnect: Readonly<{
    readonly occurredAt: string;
    readonly reasonCode: WebSocketDisconnectReasonCode;
  }> | null;
  readonly recovery: Readonly<{
    readonly status: WebSocketRecoveryStatus;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly reasonCode: WebSocketRecoveryReasonCode | null;
  }>;
}

export interface ApiHeartbeat {
  readonly runtimeState?: ListenerRuntimeState | null;
  readonly subscriberState?: ListenerRuntimeState | null;
  readonly scannerState?: ListenerRuntimeState | null;
  readonly workerState?: ListenerRuntimeState | null;
  readonly reconcilerState?: ListenerRuntimeState | null;
  readonly backlogCount?: number | null;
  readonly leasedCount?: number | null;
  readonly exhaustedCount?: number | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly lastHttpSlot: string | null;
  readonly lastWebsocketSlot: string | null;
  readonly lastFinalizedSlot: string | null;
  readonly lastSignature: null;
  readonly pendingTransactions: number | null;
  readonly activeSessions: number | null;
  readonly websocket: ApiWebSocketHealth;
  /** Optional only during rolling deployment from API V1 implementations predating issue #114. */
  readonly blockHydration?: ApiBlockHydrationMetricsV1 | ApiBlockHydrationMetricsV2 | null;
  /** Optional diagnostic sidecar; null until a physical block fetch has started. */
  readonly blockHydrationPhaseEvidence?: RuntimeBlockHydrationPhaseEvidenceV1 | null;
  readonly blockHydrationAdmission?: ApiBlockHydrationAdmissionMetricsV1 | ApiBlockHydrationAdmissionMetricsV2 | null;
  readonly ordinaryRpcBudget?: ApiOrdinaryRpcBudgetMetricsV2 | null;
  readonly blockResponseMemory?: ApiBlockResponseMemoryMetricsV2 | null;
  /** Optional during rolling deployment; null when admission metrics are absent. */
  readonly catchUpAdmission?: ApiCatchUpAdmissionMetricsV1 | null;
  /** Optional during rolling deployment; null when worker-admission metrics are absent. */
  readonly workerAdmission?: ApiWorkerAdmissionMetricsV1 | null;
  /** Optional during rolling deployment; null when the paired SQL clock is absent. */
  readonly workerAdmissionClock?: ApiWorkerAdmissionClockV1 | null;
  /** Optional during rolling deployment; null when RPC HTTP evidence is absent. */
  readonly rpcHttpEvidence?: ApiRpcHttpEvidenceV1 | null;
  /** Optional during rolling deployment; null when aggregate physical HTTP role evidence is absent. */
  readonly rpcHttpRoleEvidence?: RuntimeRpcHttpRoleEvidenceV1 | null;
  /** Optional during rolling deployment; null when first-processing evidence is absent. */
  readonly firstProcessingCanary?: ApiFirstProcessingCanaryEvidenceV1 | null;
  /** Optional during rolling deployment; null when decoder-quarantine evidence is absent. */
  readonly decoderQuarantine?: ApiDecoderQuarantineMetricsV1 | null;
  /** Optional during rolling deployment; null when no scanner phase evidence was recorded. */
  readonly scannerPhaseDiagnostics?: ScannerPhaseDiagnosticsV1 | null;
}

export interface ApiWorkerAdmissionClockV1 {
  readonly version: 1;
  readonly sampledAtMs: number;
}

export interface ApiWorkerAdmissionMetricsV1 {
  readonly version: 1;
  readonly enabled: boolean;
  readonly trackingWindowSeconds: number;
  readonly claimableBacklogCount: number;
  readonly classificationPendingCount: number;
  readonly oldestClassificationPendingAgeMs: number | null;
  readonly freshMintCount: number;
  readonly extendedMintCount: number;
  readonly demotedCount: number;
}

export interface ApiDecoderQuarantineMetricsV1 {
  readonly version: 1;
  readonly unresolvedCount: number;
}

export interface ApiFirstProcessingCanaryEvidenceV1 {
  readonly version: 1;
  readonly thresholdMs: 45_000;
  readonly cohortCapacity: 50_000;
  readonly cohortStartedAtMs: number;
  readonly cohortEndsAtMs: number;
  readonly sampledAtMs: number;
  readonly overflowed: boolean;
  readonly eligibleCount: number;
  readonly completedCount: number;
  readonly underThresholdCount: number;
  readonly atOrAboveThresholdCount: number;
  readonly pendingCount: number;
  readonly rightCensoredCount: number;
  readonly tailCensoredCount: number;
  readonly terminalCount: number;
  readonly unavailableCount: number;
  readonly invalidDurationCount: number;
  readonly p95Ms: number | null;
  readonly verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
}

export interface ApiRpcHttpEvidenceV1 {
  readonly version: 1;
  readonly overflowed: boolean;
  readonly providers: readonly [
    ApiRpcHttpProviderEvidenceV1,
    ApiRpcHttpProviderEvidenceV1,
    ApiRpcHttpProviderEvidenceV1,
    ApiRpcHttpProviderEvidenceV1,
  ];
}

export interface ApiRpcHttpProviderEvidenceV1 {
  readonly providerId: RpcProviderId;
  readonly configured: boolean;
  readonly attempts: number;
  readonly http429Responses: number;
}

export interface ApiCatchUpAdmissionMetricsV1 {
  readonly version: 1;
  readonly enabled: boolean;
  readonly providerId: RpcProviderId | null;
  readonly scanActive: boolean;
  readonly workerClaimReady: boolean;
  readonly actionableBacklogBySource: Readonly<{
    websocketOnly: number;
    catchUpOnly: number;
    websocketAndCatchUp: number;
  }>;
  readonly actionableBacklogByPriority: Readonly<{
    normal: number;
    launchCandidate: number;
    trackedTrade: number;
  }>;
  readonly deferredCount: number;
  readonly ignoredCount: number;
  readonly quarantinedCount: number;
}

export interface ApiBlockHydrationMetricsV1 {
  readonly version: 1;
  readonly enabled: boolean;
  readonly callerConcurrency: 1;
  readonly locates: number;
  readonly hits: number;
  readonly misses: number;
  readonly inFlightJoins: number;
  readonly fetches: number;
  readonly forcedRefreshes: number;
  readonly evictions: number;
  readonly oversizeBypasses: number;
  readonly fetchFailures: number;
  readonly epochInvalidations: number;
  readonly retainedEntries: number;
  readonly retainedBytes: number;
  readonly inFlightFetches: number;
  readonly queuedFetches: number;
  readonly queueDelayMs: Readonly<{ readonly last: number | null; readonly maximum: number | null }>;
}

export interface ApiSseEvent {
  readonly eventId: string;
  readonly type: DomainEventType;
  readonly mint: string;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly cursor: ApiSseCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTime: string | null;
  readonly observedAt: string;
  readonly payloadVersion: number;
  readonly payload: ApiDomainPayload;
}

export type ApiDomainEvent = ApiSseEvent;

export interface ApiSseCursor {
  readonly slot: string;
  readonly transactionIndex: string;
  readonly instructionIndex: string;
  readonly innerInstructionIndex: string | null;
}

export function toApiJson(value: unknown): ApiJsonValue {
  return convertToApiJson(value, { ancestors: new Set<object>(), nodes: 0 }, 0);
}

export function toApiDomainPayload(value: unknown): ApiDomainPayload {
  const converted = toApiJson(value);
  assertApiDomainPayload(converted, undefined);
  return converted as ApiDomainPayload;
}

interface JsonConversionState {
  readonly ancestors: Set<object>;
  nodes: number;
}

function convertToApiJson(
  value: unknown,
  state: JsonConversionState,
  depth: number,
): ApiJsonValue {
  if (depth > MAX_API_JSON_DEPTH) throw new RangeError('API JSON nesting exceeds the maximum depth');
  state.nodes += 1;
  if (state.nodes > MAX_API_JSON_NODES) throw new RangeError('API JSON exceeds the maximum node count');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('API JSON numbers must be safe integers');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported API JSON value: ${typeof value}`);
  }
  if (state.ancestors.has(value)) throw new TypeError('API JSON values must not contain cycles');
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return convertArrayToApiJson(value, state, depth);
    }
    if (!isPlainObject(value)) throw new TypeError('API JSON objects must be plain objects');
    return convertObjectToApiJson(value, state, depth);
  } finally {
    state.ancestors.delete(value);
  }
}

function convertArrayToApiJson(
  value: unknown[],
  state: JsonConversionState,
  depth: number,
): ApiJsonValue {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('API JSON arrays must use Array.prototype');
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError('API JSON arrays must not have symbol properties');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    throw new TypeError('API JSON arrays must have a data length property');
  }
  const length: unknown = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new TypeError('API JSON arrays must have a valid length');
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key !== 'length' && !isArrayIndex(key)) {
      throw new TypeError('API JSON arrays must not have custom properties');
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('API JSON arrays must not have accessor properties');
    }
  }
  const result: ApiJsonValue[] = new Array<ApiJsonValue>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined) throw new TypeError('API JSON arrays must not be sparse');
    if (!('value' in descriptor)) throw new TypeError('API JSON arrays must not have accessor properties');
    Object.defineProperty(result, index, {
      value: convertToApiJson(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Object.freeze(result);
}

function convertObjectToApiJson(
  value: Record<string, unknown>,
  state: JsonConversionState,
  depth: number,
): ApiJsonValue {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError('API JSON objects must not have symbol properties');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, ApiJsonValue> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('API JSON objects must not have accessor properties');
    }
    if (descriptor.enumerable) {
      Object.defineProperty(result, key, {
        value: convertToApiJson(descriptor.value, state, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return Object.freeze(result);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
}

function isArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < 4_294_967_295;
}

// These are structural metadata, never token amounts, prices, fees, reserves, or slots.
const API_DOMAIN_NUMBER_KEYS = new Set<string>([
  'index',
  'version',
  'payloadVersion',
  'decimals',
  'score',
  'maximum',
  'poolIndex',
  'transactionIndex',
  'instructionIndex',
  'innerInstructionIndex',
  'buyCount',
  'sellCount',
  'uniqueKnownBuyers',
  'uniqueExternalBuyers',
  'positivePositionCount',
  'unknownTraderTradeCount',
  'linkCount',
  'evidenceCount',
  'externalBuyCount',
  'externalBuyTarget',
]);

function assertApiDomainPayload(value: ApiJsonValue, key: string | undefined): void {
  if (typeof value === 'number') {
    if (key === undefined || !API_DOMAIN_NUMBER_KEYS.has(key)) {
      throw new TypeError('API domain payload numbers are not allowed for this key');
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (isApiJsonArray(value)) {
    for (const item of value) assertApiDomainPayload(item, undefined);
    return;
  }
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    assertApiDomainPayload(nestedValue, nestedKey);
  }
}

function isApiJsonArray(value: ApiJsonValue): value is readonly ApiJsonValue[] {
  return Array.isArray(value);
}
