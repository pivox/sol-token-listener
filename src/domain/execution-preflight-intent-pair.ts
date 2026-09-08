import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  createExecutionIntentDraft,
  type ExecutionIntentDraftV1,
} from './execution-intent.js';
import { canonicalStringifyJson } from '../utils/json.js';

const PAYLOAD_VERSION = 1 as const;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const TARGET_DRAFT_KEYS = Object.freeze([
  'id',
  'payloadVersion',
  'logicalOrderKey',
  'strategyId',
  'strategyVersion',
  'positionId',
  'candidateId',
  'logicalCommandId',
  'mint',
  'side',
  'venuePolicy',
  'quoteMint',
  'quoteTokenProgram',
  'quoteDecimals',
  'quoteAmountRaw',
  'baseAmountRaw',
  'minimumAmountOutRaw',
  'decisionEventId',
  'decisionFingerprint',
  'requestedAtMs',
  'expiresAtMs',
] as const);

const TARGET_INPUT_KEYS = Object.freeze(TARGET_DRAFT_KEYS.slice(3));

export interface ExecutionPreflightIntentPairDraftV1 {
  readonly payloadVersion: 1;
  readonly pairId: string;
  readonly pairFingerprint: string;
  readonly targetIntentId: string;
  readonly simulationIntent: ExecutionIntentDraftV1;
  readonly decisionEventId: string;
  readonly decisionFingerprint: string;
  readonly expiresAtMs: number;
}

export class ExecutionPreflightIntentPairValidationError extends TypeError {
  public constructor() {
    super('Invalid execution preflight intent pair.');
    this.name = 'ExecutionPreflightIntentPairValidationError';
  }
}

export function createExecutionPreflightIntentPairDraft(
  targetDraft: unknown,
): ExecutionPreflightIntentPairDraftV1 {
  try {
    const target = targetDraftFrom(targetDraft);
    assertSupportedTarget(target);
    const logicalCommandId = `execution_preflight_probe_${hashLengthPrefixed([
      'execution-preflight-simulation-probe-command-v1',
      target.id,
    ])}`;
    const simulationIntent = createExecutionIntentDraft(Object.freeze({
      strategyId: target.strategyId,
      strategyVersion: target.strategyVersion,
      positionId: target.positionId,
      candidateId: target.candidateId,
      logicalCommandId,
      mint: target.mint,
      side: target.side,
      venuePolicy: target.venuePolicy,
      quoteMint: target.quoteMint,
      quoteTokenProgram: target.quoteTokenProgram,
      quoteDecimals: target.quoteDecimals,
      quoteAmountRaw: target.quoteAmountRaw,
      baseAmountRaw: target.baseAmountRaw,
      minimumAmountOutRaw: target.minimumAmountOutRaw,
      decisionEventId: target.decisionEventId,
      decisionFingerprint: target.decisionFingerprint,
      requestedAtMs: target.requestedAtMs,
      expiresAtMs: target.expiresAtMs,
    }));
    if (
      simulationIntent.id === target.id
      || simulationIntent.logicalCommandId === target.logicalCommandId
      || simulationIntent.logicalOrderKey === target.logicalOrderKey
    ) throw invalid();
    const pairId = `execution_preflight_intent_pair_${hashLengthPrefixed([
      'execution-preflight-intent-pair-v1',
      target.id,
      simulationIntent.id,
      target.decisionEventId,
      target.decisionFingerprint,
      String(target.expiresAtMs),
    ])}`;
    const pairFingerprint = createHash('sha256').update(canonicalStringifyJson(Object.freeze({
      payloadVersion: PAYLOAD_VERSION,
      pairId,
      targetIntentId: target.id,
      simulationIntentId: simulationIntent.id,
      decisionEventId: target.decisionEventId,
      decisionFingerprint: target.decisionFingerprint,
      expiresAtMs: target.expiresAtMs,
    })), 'utf8').digest('hex');
    return Object.freeze({
      payloadVersion: PAYLOAD_VERSION,
      pairId,
      pairFingerprint,
      targetIntentId: target.id,
      simulationIntent,
      decisionEventId: target.decisionEventId,
      decisionFingerprint: target.decisionFingerprint,
      expiresAtMs: target.expiresAtMs,
    });
  } catch {
    throw invalid();
  }
}

function targetDraftFrom(value: unknown): ExecutionIntentDraftV1 {
  if (!isFrozenObject(value)) throw invalid();
  const record = exactRecord(value, TARGET_DRAFT_KEYS);
  const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of TARGET_INPUT_KEYS) input[key] = record[key];
  const rebuilt = createExecutionIntentDraft(Object.freeze(input));
  if (
    record.id !== rebuilt.id
    || record.payloadVersion !== rebuilt.payloadVersion
    || record.logicalOrderKey !== rebuilt.logicalOrderKey
  ) throw invalid();
  return rebuilt;
}

function assertSupportedTarget(target: ExecutionIntentDraftV1): void {
  if (
    target.strategyId !== 'creation-entry-v1'
    || target.strategyVersion !== 1
    || target.candidateId === null
    || !/^paper_open_[a-f0-9]{64}$/u.test(target.logicalCommandId)
    || target.logicalOrderKey !== target.logicalCommandId
    || target.side !== 'BUY'
    || target.venuePolicy !== 'PUMP_FUN_ONLY'
    || target.quoteMint !== WSOL_MINT
    || target.quoteTokenProgram !== 'SPL_TOKEN'
    || target.quoteDecimals !== 9
  ) throw invalid();
}

function exactRecord<const Keys extends readonly string[]>(
  value: object,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) throw invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  return result as Readonly<Record<Keys[number], unknown>>;
}

function hashLengthPrefixed(values: readonly string[]): string {
  const chunks: Buffer[] = [];
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

function isFrozenObject(value: unknown): value is object {
  return typeof value === 'object'
    && value !== null
    && !isProxy(value)
    && Object.isFrozen(value);
}

function invalid(): ExecutionPreflightIntentPairValidationError {
  return new ExecutionPreflightIntentPairValidationError();
}
