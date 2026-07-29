import type { ApiErrorCode } from './errors.js';

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
  readonly meta: ApiMeta;
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
  };
}

export interface ApiPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type ApiAvailability<T> =
  | { readonly status: 'AVAILABLE'; readonly data: T }
  | { readonly status: 'NOT_AVAILABLE' };

export interface ApiLaunchSummary {
  readonly mint: string;
  readonly detectedAt: string;
  readonly detectedSlot: string;
  readonly status: string;
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
  readonly type: string;
  readonly occurredAt: string;
  readonly slot: string | null;
  readonly sequence: string | null;
  readonly details: Readonly<Record<string, ApiJsonValue>>;
}

export interface ApiQualification {
  readonly status: string;
  readonly score: number;
  readonly threshold: number;
  readonly reasons: readonly string[];
  readonly evaluatedAt: string;
}

export type ApiSocial =
  | {
      readonly status: 'AVAILABLE';
      readonly links: Readonly<Record<string, string>>;
      readonly evidence: readonly string[];
    }
  | {
      readonly status: 'NOT_AVAILABLE';
      readonly links: null;
      readonly evidence: readonly string[];
    };

export type ApiHolders =
  | {
      readonly status: 'AVAILABLE';
      readonly snapshots: readonly ApiHolderSnapshot[];
      readonly clusters: readonly ApiHolderCluster[];
    }
  | {
      readonly status: 'NOT_AVAILABLE';
      readonly snapshots: readonly [];
      readonly clusters: readonly [];
    };

export interface ApiHolderSnapshot {
  readonly observedAt: string;
  readonly holderCount: string;
  readonly topHolderPercentageBps: string | null;
}

export interface ApiHolderCluster {
  readonly label: string;
  readonly holderCount: string;
  readonly percentageBps: string;
}

export interface ApiPaperPosition {
  readonly id: string;
  readonly mint: string;
  readonly status: string;
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
  readonly dependencies: Readonly<Record<string, 'AVAILABLE' | 'UNAVAILABLE'>>;
}

export interface ApiSseEvent {
  readonly id: string;
  readonly sequence: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly data: ApiJsonValue;
}

export function toApiJson(value: unknown): ApiJsonValue {
  return convertToApiJson(value, new Set<object>());
}

function convertToApiJson(value: unknown, ancestors: Set<object>): ApiJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError('API JSON numbers must be safe integers');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported API JSON value: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError('API JSON values must not contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => convertToApiJson(item, ancestors)));
    }
    if (!isPlainObject(value)) throw new TypeError('API JSON objects must be plain objects');
    const result: Record<string, ApiJsonValue> = {};
    for (const key of Object.keys(value)) {
      result[key] = convertToApiJson(value[key], ancestors);
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
