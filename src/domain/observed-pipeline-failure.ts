import { isProxy } from 'node:util/types';
import type { IngestionFailure } from './transaction-ingestion.js';
import { inheritTrustedTerminalAttribution } from './terminal-attribution.js';

import {
  OBSERVED_PIPELINE_STAGES, OBSERVED_PIPELINE_ORIGIN_CODES,
  type ObservedPipelineOriginCode,
} from './observed-pipeline-taxonomy.js';
export {
  OBSERVED_PIPELINE_STAGES, OBSERVED_PIPELINE_ORIGIN_CODES,
  type ObservedPipelineStage, type ObservedPipelineOriginCode,
} from './observed-pipeline-taxonomy.js';

const stages = new Set<string>(OBSERVED_PIPELINE_STAGES);
const codes = new Set<string>(OBSERVED_PIPELINE_ORIGIN_CODES);
const trustedOrigins = new WeakMap<object, Exclude<ObservedPipelineOriginCode, 'UNKNOWN'>>();
const decoderQuarantineErrorNames = new Set<string>([
  'ObservedPipelineFailure.v1.launchpad_observation.PUMP_SCHEMA_UNSUPPORTED',
  'ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_TRUNCATED',
]);

/** @internal Authority-bearing registration, used only by the internal decoder factories. */
export function registerInternalDecodingFailure(error: Error, code: unknown): void {
  if (typeof code === 'string' && code !== 'UNKNOWN' && codes.has(code)) {
    trustedOrigins.set(error, code as Exclude<ObservedPipelineOriginCode, 'UNKNOWN'>);
  }
}

/** Exact identity only: no prototype, property, cause-chain or proxy inspection. */
export function trustedObservedPipelineOrigin(value: unknown): Exclude<ObservedPipelineOriginCode, 'UNKNOWN'> | null {
  return typeof value === 'object' && value !== null ? trustedOrigins.get(value) ?? null : null;
}

/** @internal Wrapping can only preserve authority already present on the exact cause. */
export function inheritObservedPipelineOrigin(wrapper: object, cause: unknown): void {
  if (isProxy(wrapper)) return;
  const code = trustedObservedPipelineOrigin(cause);
  if (code !== null) trustedOrigins.set(wrapper, code);
  inheritTrustedTerminalAttribution(wrapper, cause);
}

export function assertValidObservedPipelineFailure(errorName: string, retryable: boolean): void {
  const [name, version, stage, code, extra] = errorName.split('.');
  if (name !== 'ObservedPipelineFailure' || version !== 'v1'
    || stage === undefined || code === undefined || extra !== undefined
    || !codes.has(code) || retryable !== (code === 'UNKNOWN')
    || (stage === 'unclassified' ? code !== 'UNKNOWN' : !stages.has(stage))) {
    throw new TypeError('Ingestion pipeline failure must match the v1 taxonomy.');
  }
}

/** Classifies an already validated durable failure; never accepts runtime error objects. */
export function isDecoderQuarantineFailure(value: IngestionFailure): boolean;
export function isDecoderQuarantineFailure(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || !Object.isFrozen(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3
    || !Object.hasOwn(value, 'code')
    || !Object.hasOwn(value, 'errorName')
    || !Object.hasOwn(value, 'retryable')) return false;
  for (const key of keys) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return record.code === 'PIPELINE_STAGE_FAILED'
    && record.retryable === false
    && typeof record.errorName === 'string'
    && decoderQuarantineErrorNames.has(record.errorName);
}
