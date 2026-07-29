import type { ApiErrorCode } from './errors.js';
import type { DomainEventType } from '../domain/events.js';
import type { LaunchStatus } from '../domain/launch-status.js';
import type { PaperPositionStatus } from '../domain/paper-trading.js';
import type {
  QualificationEvidenceStatus,
  QualificationSignalKey,
  QualificationVerdict,
} from '../domain/qualification.js';
import type { QualificationReasonCode } from '../domain/qualification-reasons.js';
import type { ChainConfirmationStatus } from '../domain/types.js';

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
  readonly social: ApiSocial;
  readonly holders: ApiHolders;
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
  readonly blockers: readonly ApiQualificationBlocker[];
  readonly verdict: QualificationVerdict;
  readonly evaluatedAt: string;
}

export interface ApiQualificationRuleset {
  readonly id: string;
  readonly version: number;
  readonly status: 'UNVALIDATED_RULE_SET';
  readonly minimumTotalScore: number;
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

export interface ApiSocial {
  readonly status: 'NOT_AVAILABLE';
  readonly links: readonly [];
  readonly evidence: readonly [];
}

export interface ApiHolders {
  readonly status: 'NOT_AVAILABLE';
  readonly snapshots: readonly [];
  readonly clusters: readonly [];
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
}

export interface ApiHealth {
  readonly status: 'OK' | 'DEGRADED';
  readonly observedAt: string;
  readonly postgresql: ApiHealthDependency;
  readonly http: ApiHealthDependency;
  readonly pipeline: ApiPipelineHealth;
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
}

export interface ApiCheckpoints {
  readonly launchpad: string | null;
  readonly market: string | null;
}

export interface ApiHeartbeat {
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly lastHttpSlot: string | null;
  readonly lastWebsocketSlot: string | null;
  readonly lastFinalizedSlot: string | null;
  readonly lastSignature: string | null;
  readonly pendingTransactions: number;
  readonly activeSessions: number;
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
