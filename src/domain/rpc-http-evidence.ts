import { types } from 'node:util';
import { isRpcProviderId, RPC_PROVIDER_IDS, type RpcProviderId } from './rpc-provider.js';

const EVIDENCE_FIELDS = ['version', 'overflowed', 'providers'] as const;
const PROVIDER_FIELDS = [
  'providerId', 'configured', 'attempts', 'http429Responses',
] as const;

type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

export interface RuntimeRpcHttpProviderEvidenceV1 {
  readonly providerId: RpcProviderId;
  readonly configured: boolean;
  readonly attempts: number;
  readonly http429Responses: number;
}

export interface RuntimeRpcHttpEvidenceV1 {
  readonly version: 1;
  readonly overflowed: boolean;
  readonly providers: readonly [
    RuntimeRpcHttpProviderEvidenceV1,
    RuntimeRpcHttpProviderEvidenceV1,
    RuntimeRpcHttpProviderEvidenceV1,
    RuntimeRpcHttpProviderEvidenceV1,
  ];
}

export function assertValidRuntimeRpcHttpEvidence(
  value: unknown,
): asserts value is RuntimeRpcHttpEvidenceV1 {
  const evidence = evidenceFields(value);
  if (evidence.version !== 1 || typeof evidence.overflowed !== 'boolean') invalid();
  const providers = providerEntries(evidence.providers);
  for (const [index, providerId] of RPC_PROVIDER_IDS.entries()) {
    const provider = providers[index];
    if (provider?.providerId !== providerId) invalid();
  }
}

export function createRuntimeRpcHttpEvidence(input: unknown): RuntimeRpcHttpEvidenceV1 {
  assertValidRuntimeRpcHttpEvidence(input);
  const evidence = input;
  const providers = evidence.providers.map((provider) => Object.freeze({
    providerId: provider.providerId,
    configured: provider.configured,
    attempts: provider.attempts,
    http429Responses: provider.http429Responses,
  }));
  return Object.freeze({
    version: 1,
    overflowed: evidence.overflowed,
    providers: Object.freeze(providers) as RuntimeRpcHttpEvidenceV1['providers'],
  });
}

function evidenceFields(value: unknown): Record<EvidenceField, unknown> {
  return fields(value, EVIDENCE_FIELDS, 'RPC HTTP evidence');
}

function providerEntries(value: unknown): readonly RuntimeRpcHttpProviderEvidenceV1[] {
  if (!Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length !== RPC_PROVIDER_IDS.length) {
    invalid();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== RPC_PROVIDER_IDS.length + 1
    || !keys.includes('length')
    || RPC_PROVIDER_IDS.some((_, index) => !keys.includes(String(index)))) {
    invalid();
  }
  const entries: RuntimeRpcHttpProviderEvidenceV1[] = [];
  for (let index = 0; index < RPC_PROVIDER_IDS.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)
      || descriptor.enumerable !== true) invalid();
    entries.push(providerFields(descriptor.value));
  }
  return entries;
}

function providerFields(value: unknown): RuntimeRpcHttpProviderEvidenceV1 {
  const fieldsValue = fields(value, PROVIDER_FIELDS, 'RPC HTTP evidence');
  const providerId = fieldsValue.providerId;
  const configured = fieldsValue.configured;
  const attempts = fieldsValue.attempts;
  const http429Responses = fieldsValue.http429Responses;
  if (!isRpcProviderId(providerId)
    || typeof configured !== 'boolean'
    || !safeCounter(attempts)
    || !safeCounter(http429Responses)
    || http429Responses > attempts
    || (!configured && (attempts !== 0 || http429Responses !== 0))) {
    invalid();
  }
  return {
    providerId,
    configured,
    attempts,
    http429Responses,
  };
}

function fields<Field extends string>(
  value: unknown,
  expected: readonly Field[],
  label: string,
): Record<Field, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expected.length
      || keys.some((key) => typeof key !== 'string'
        || !expected.some((expectedKey) => expectedKey === key))) invalid();
    const result = {} as Record<Field, unknown>;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) invalid();
      const descriptorValue: unknown = descriptor.value;
      result[key] = descriptorValue;
    }
    return result;
  } catch {
    throw new TypeError(`${label} is invalid.`);
  }
}

function safeCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalid(): never {
  throw new TypeError('RPC HTTP evidence is invalid.');
}
