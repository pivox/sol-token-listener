import { isProxy } from 'node:util/types';
import { assertExecutionIntent } from '../domain/execution-intent.js';
import type {
  ExecutionBuyAdmissionInputV1,
  ExecutionBuyAdmissionResultV1,
  ExecutionRiskRepository,
} from '../ports/execution-risk-repository.js';

const INPUT_KEYS = Object.freeze([
  'payloadVersion', 'intent', 'policy', 'generationId', 'walletSnapshot',
  'providerSnapshot', 'allEndpointsUnavailable', 'nowMs',
] as const);
const DATE_MAX_MS = 8_640_000_000_000_000;

export class ExecutionAdmissionValidationError extends TypeError {
  public constructor() {
    super('Invalid execution admission input.');
    this.name = 'ExecutionAdmissionValidationError';
  }
}

export class ExecutionAdmissionService {
  public constructor(private readonly repository: ExecutionRiskRepository) {}

  public admit(input: unknown): Promise<ExecutionBuyAdmissionResultV1> {
    try {
      const row = exactRecord(input);
      if (row.payloadVersion !== 1) throw new TypeError();
      assertExecutionIntent(row.intent);
      const intent = row.intent;
      if (intent.side !== 'BUY' || intent.status !== 'PENDING'
        || intent.quoteAmountRaw === null || intent.baseAmountRaw !== null) throw new TypeError();
      if (!plainDataObject(row.policy) || !plainDataObject(row.walletSnapshot)
        || !plainDataObject(row.providerSnapshot)) throw new TypeError();
      const policy = row.policy as unknown as ExecutionBuyAdmissionInputV1['policy'];
      const walletSnapshot = row.walletSnapshot as unknown as ExecutionBuyAdmissionInputV1['walletSnapshot'];
      const providerSnapshot = row.providerSnapshot as unknown as ExecutionBuyAdmissionInputV1['providerSnapshot'];
      if (typeof row.generationId !== 'string'
        || row.generationId !== walletSnapshot.generationId
        || walletSnapshot.providerId !== providerSnapshot.providerId
        || typeof row.allEndpointsUnavailable !== 'boolean'
        || !validTimestamp(row.nowMs)
        || row.nowMs < intent.requestedAtMs
        || row.nowMs >= intent.expiresAtMs) throw new TypeError();
      return this.repository.admitBuy(Object.freeze({
        payloadVersion: 1,
        intent,
        policy,
        generationId: row.generationId,
        walletSnapshot,
        providerSnapshot,
        allEndpointsUnavailable: row.allEndpointsUnavailable,
        nowMs: row.nowMs,
      }));
    } catch (error) {
      if (error instanceof ExecutionAdmissionValidationError) throw error;
      if (error instanceof TypeError) throw new ExecutionAdmissionValidationError();
      throw error;
    }
  }
}

function exactRecord(value: unknown): Record<(typeof INPUT_KEYS)[number], unknown> {
  if (!plainObject(value)) throw new TypeError();
  const keys = Object.keys(value).sort();
  const expected = [...INPUT_KEYS].sort();
  if (keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])) throw new TypeError();
  for (const key of INPUT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) throw new TypeError();
  }
  return value;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function plainDataObject(value: unknown): value is Record<string, unknown> {
  if (!plainObject(value)) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= DATE_MAX_MS;
}
