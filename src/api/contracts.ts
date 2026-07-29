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

export type ApiJsonPrimitive = string | number | boolean | null;
export interface ApiJsonObject {
  readonly [key: string]: ApiJsonValue;
}
export type ApiJsonValue =
  | ApiJsonPrimitive
  | readonly ApiJsonValue[]
  | ApiJsonObject;

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
  readonly payload: ApiJsonValue;
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
  readonly payload: ApiJsonValue;
}

export interface ApiSseCursor {
  readonly slot: string;
  readonly transactionIndex: string;
  readonly instructionIndex: string;
  readonly innerInstructionIndex: string | null;
}

export function toApiJson(value: unknown): ApiJsonValue {
  return convertToApiJson(value, new Set<object>());
}

function convertToApiJson(value: unknown, ancestors: Set<object>): ApiJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('API JSON numbers must be safe integers');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported API JSON value: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError('API JSON values must not contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('API JSON arrays must not be sparse');
      }
      return Object.freeze(value.map((item) => convertToApiJson(item, ancestors)));
    }
    if (!isPlainObject(value)) throw new TypeError('API JSON objects must be plain objects');
    const result = Object.create(null) as Record<string, ApiJsonValue>;
    for (const key of Object.keys(value)) {
      Object.defineProperty(result, key, {
        value: convertToApiJson(value[key], ancestors),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
}
