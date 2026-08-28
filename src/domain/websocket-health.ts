import { isProxy } from 'node:util/types';
import { isRpcProviderId, type RpcProviderId } from './rpc-provider.js';

export const WEBSOCKET_HEALTH_PHASES = Object.freeze([
  'STOPPED',
  'CONNECTING',
  'WAITING_FOR_ACKS',
  'ACKNOWLEDGED',
  'RECOVERING',
  'RUNNING',
  'DEGRADED',
  'UNRECOVERABLE',
  'STOPPING',
] as const);

export const WEBSOCKET_RECOVERY_STATUSES = Object.freeze([
  'NOT_REQUIRED',
  'REQUIRED',
  'IN_PROGRESS',
  'RECOVERED',
  'FAILED',
] as const);

export const WEBSOCKET_DISCONNECT_REASON_CODES = Object.freeze([
  'SETUP_TIMEOUT',
  'ABORTED',
  'SOCKET_ERROR',
  'REMOTE_CLOSE',
  'PROTOCOL_INVALID',
  'NOTIFICATION_FAILED',
  'CLEANUP_FAILED',
  'UNEXPECTED_RESTART',
] as const);

export const WEBSOCKET_RECOVERY_REASON_CODES = Object.freeze([
  'STARTUP',
  'UNEXPECTED_RESTART',
  'SESSION_FAILURE',
  'RPC_UNAVAILABLE',
  'CHECKPOINT_CONFLICT',
  'CATCH_UP_WINDOW_EXCEEDED',
] as const);

export const WEBSOCKET_HEALTH_SUPERVISION_STATES = Object.freeze([
  'INACTIVE',
  'ACTIVE',
] as const);

export const PUBLIC_WEBSOCKET_HEALTH_STATES = Object.freeze([
  'STOPPED',
  'CONNECTING',
  'ACKNOWLEDGED',
  'RECOVERING',
  'DEGRADED',
] as const);

export const WEBSOCKET_HEALTH_PAYLOAD_VERSION = 1 as const;
export const WEBSOCKET_HEALTH_STALE_AFTER_MS = 30_000;
export const MAX_WEBSOCKET_HEALTH_GENERATION = 9_223_372_036_854_775_807n;
export const MAX_WEBSOCKET_HEALTH_SLOT = 10n ** 78n - 1n;
export const MAX_WEBSOCKET_HEALTH_TIMESTAMP_MS = 8_640_000_000_000_000;

export type WebSocketHealthPhase = (typeof WEBSOCKET_HEALTH_PHASES)[number];
export type WebSocketRecoveryStatus = (typeof WEBSOCKET_RECOVERY_STATUSES)[number];
export type WebSocketDisconnectReasonCode =
  (typeof WEBSOCKET_DISCONNECT_REASON_CODES)[number];
export type WebSocketRecoveryReasonCode =
  (typeof WEBSOCKET_RECOVERY_REASON_CODES)[number];
export type WebSocketHealthSupervision =
  (typeof WEBSOCKET_HEALTH_SUPERVISION_STATES)[number];
export type PublicWebSocketHealthState =
  (typeof PUBLIC_WEBSOCKET_HEALTH_STATES)[number];

export interface WebSocketHealthObservation {
  readonly observedAtMs: number;
  readonly slot: bigint;
}

export interface WebSocketHealthDisconnect {
  readonly occurredAtMs: number;
  readonly reasonCode: WebSocketDisconnectReasonCode;
}

export interface WebSocketHealthRecovery {
  readonly status: WebSocketRecoveryStatus;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly reasonCode: WebSocketRecoveryReasonCode | null;
}

export interface WebSocketHealthSnapshot {
  readonly payloadVersion: typeof WEBSOCKET_HEALTH_PAYLOAD_VERSION;
  readonly supervision: WebSocketHealthSupervision;
  readonly ownerGeneration: bigint;
  readonly revision: bigint;
  readonly activeSessionGeneration: bigint | null;
  readonly candidateSessionGeneration: bigint | null;
  readonly providerId: RpcProviderId | null;
  readonly candidateProviderId: RpcProviderId | null;
  readonly phase: WebSocketHealthPhase;
  readonly acknowledgedAtMs: number | null;
  readonly lastObservation: WebSocketHealthObservation | null;
  readonly disconnect: WebSocketHealthDisconnect | null;
  readonly recovery: WebSocketHealthRecovery;
  readonly heartbeatAtMs: number | null;
  readonly updatedAtMs: number;
  readonly evidencePurgeAfterMs: number | null;
}

export class WebSocketHealthValidationError extends TypeError {
  public constructor() {
    super('Invalid WebSocket health snapshot.');
    this.name = 'WebSocketHealthValidationError';
  }
}

const SNAPSHOT_KEYS = Object.freeze([
  'payloadVersion',
  'supervision',
  'ownerGeneration',
  'revision',
  'activeSessionGeneration',
  'candidateSessionGeneration',
  'providerId',
  'candidateProviderId',
  'phase',
  'acknowledgedAtMs',
  'lastObservation',
  'disconnect',
  'recovery',
  'heartbeatAtMs',
  'updatedAtMs',
  'evidencePurgeAfterMs',
] as const);

const OBSERVATION_KEYS = Object.freeze(['observedAtMs', 'slot'] as const);
const DISCONNECT_KEYS = Object.freeze(['occurredAtMs', 'reasonCode'] as const);
const RECOVERY_KEYS = Object.freeze([
  'status', 'startedAtMs', 'completedAtMs', 'reasonCode',
] as const);

export function publicWebSocketState(phase: WebSocketHealthPhase): PublicWebSocketHealthState {
  switch (phase) {
    case 'STOPPED': return 'STOPPED';
    case 'CONNECTING':
    case 'WAITING_FOR_ACKS': return 'CONNECTING';
    case 'ACKNOWLEDGED':
    case 'RUNNING': return 'ACKNOWLEDGED';
    case 'RECOVERING': return 'RECOVERING';
    case 'DEGRADED':
    case 'UNRECOVERABLE':
    case 'STOPPING': return 'DEGRADED';
    default: throw invalid();
  }
}

export function createWebSocketHealthSnapshot(input: unknown): WebSocketHealthSnapshot {
  try {
    return snapshotFrom(input, false);
  } catch {
    throw invalid();
  }
}

export function assertValidWebSocketHealthSnapshot(
  value: unknown,
): asserts value is WebSocketHealthSnapshot {
  try {
    void snapshotFrom(value, true);
  } catch {
    throw invalid();
  }
}

function snapshotFrom(value: unknown, requireFrozen: boolean): WebSocketHealthSnapshot {
  if (isObject(value) && isProxy(value)) throw invalid();
  if (requireFrozen && !Object.isFrozen(value)) throw invalid();
  const record = ownEnumerableDataRecord(value, SNAPSHOT_KEYS);
  if (record.payloadVersion !== WEBSOCKET_HEALTH_PAYLOAD_VERSION) throw invalid();
  const supervision = supervisionFrom(record.supervision);
  const ownerGeneration = generationFrom(record.ownerGeneration, true);
  const revision = generationFrom(record.revision, true);
  const activeSessionGeneration = nullableSessionGenerationFrom(record.activeSessionGeneration);
  const candidateSessionGeneration = nullableSessionGenerationFrom(record.candidateSessionGeneration);
  const providerId = nullableProviderIdFrom(record.providerId);
  const candidateProviderId = nullableProviderIdFrom(record.candidateProviderId);
  const phase = phaseFrom(record.phase);
  const acknowledgedAtMs = nullableTimestampFrom(record.acknowledgedAtMs);
  const lastObservation = nullableObservationFrom(record.lastObservation, requireFrozen);
  const disconnect = nullableDisconnectFrom(record.disconnect, requireFrozen);
  const recovery = recoveryFrom(record.recovery, requireFrozen);
  const heartbeatAtMs = nullableTimestampFrom(record.heartbeatAtMs);
  const updatedAtMs = timestampFrom(record.updatedAtMs);
  const evidencePurgeAfterMs = nullableTimestampFrom(record.evidencePurgeAfterMs);

  assertPair(providerId, activeSessionGeneration);
  assertPair(candidateProviderId, candidateSessionGeneration);
  if (activeSessionGeneration !== null
    && candidateSessionGeneration !== null
    && activeSessionGeneration === candidateSessionGeneration) throw invalid();
  assertSupervision(
    supervision,
    ownerGeneration,
    revision,
    phase,
    providerId,
    activeSessionGeneration,
    candidateProviderId,
    candidateSessionGeneration,
    acknowledgedAtMs,
    lastObservation,
    disconnect,
    recovery,
    heartbeatAtMs,
    evidencePurgeAfterMs,
  );
  assertPhase(
    phase,
    providerId,
    activeSessionGeneration,
    candidateProviderId,
    candidateSessionGeneration,
    acknowledgedAtMs,
  );

  return Object.freeze({
    payloadVersion: WEBSOCKET_HEALTH_PAYLOAD_VERSION,
    supervision,
    ownerGeneration,
    revision,
    activeSessionGeneration,
    candidateSessionGeneration,
    providerId,
    candidateProviderId,
    phase,
    acknowledgedAtMs,
    lastObservation,
    disconnect,
    recovery,
    heartbeatAtMs,
    updatedAtMs,
    evidencePurgeAfterMs,
  });
}

function nullableObservationFrom(
  value: unknown,
  requireFrozen: boolean,
): WebSocketHealthObservation | null {
  if (value === null) return null;
  if (isObject(value) && isProxy(value)) throw invalid();
  if (requireFrozen && !Object.isFrozen(value)) throw invalid();
  const record = ownEnumerableDataRecord(value, OBSERVATION_KEYS);
  return Object.freeze({
    observedAtMs: timestampFrom(record.observedAtMs),
    slot: slotFrom(record.slot),
  });
}

function nullableDisconnectFrom(
  value: unknown,
  requireFrozen: boolean,
): WebSocketHealthDisconnect | null {
  if (value === null) return null;
  if (isObject(value) && isProxy(value)) throw invalid();
  if (requireFrozen && !Object.isFrozen(value)) throw invalid();
  const record = ownEnumerableDataRecord(value, DISCONNECT_KEYS);
  return Object.freeze({
    occurredAtMs: timestampFrom(record.occurredAtMs),
    reasonCode: disconnectReasonFrom(record.reasonCode),
  });
}

function recoveryFrom(value: unknown, requireFrozen: boolean): WebSocketHealthRecovery {
  if (isObject(value) && isProxy(value)) throw invalid();
  if (requireFrozen && !Object.isFrozen(value)) throw invalid();
  const record = ownEnumerableDataRecord(value, RECOVERY_KEYS);
  const status = recoveryStatusFrom(record.status);
  const startedAtMs = nullableTimestampFrom(record.startedAtMs);
  const completedAtMs = nullableTimestampFrom(record.completedAtMs);
  const reasonCode = nullableRecoveryReasonFrom(record.reasonCode);
  if (completedAtMs !== null && startedAtMs !== null && completedAtMs < startedAtMs) {
    throw invalid();
  }
  switch (status) {
    case 'NOT_REQUIRED':
      if (startedAtMs !== null || completedAtMs !== null || reasonCode !== null) throw invalid();
      break;
    case 'REQUIRED':
      if (startedAtMs !== null || completedAtMs !== null || reasonCode === null) throw invalid();
      break;
    case 'IN_PROGRESS':
      if (startedAtMs === null || completedAtMs !== null || reasonCode === null) throw invalid();
      break;
    case 'RECOVERED':
    case 'FAILED':
      if (startedAtMs === null || completedAtMs === null || reasonCode === null) throw invalid();
      break;
  }
  return Object.freeze({ status, startedAtMs, completedAtMs, reasonCode });
}

function assertSupervision(
  supervision: WebSocketHealthSupervision,
  ownerGeneration: bigint,
  revision: bigint,
  phase: WebSocketHealthPhase,
  providerId: RpcProviderId | null,
  activeSessionGeneration: bigint | null,
  candidateProviderId: RpcProviderId | null,
  candidateSessionGeneration: bigint | null,
  acknowledgedAtMs: number | null,
  lastObservation: WebSocketHealthObservation | null,
  disconnect: WebSocketHealthDisconnect | null,
  recovery: WebSocketHealthRecovery,
  heartbeatAtMs: number | null,
  evidencePurgeAfterMs: number | null,
): void {
  if (supervision === 'ACTIVE') {
    if (ownerGeneration === 0n) throw invalid();
    return;
  }
  if (ownerGeneration !== 0n
    || revision !== 0n
    || phase !== 'STOPPED'
    || providerId !== null
    || activeSessionGeneration !== null
    || candidateProviderId !== null
    || candidateSessionGeneration !== null
    || acknowledgedAtMs !== null
    || lastObservation !== null
    || disconnect !== null
    || recovery.status !== 'NOT_REQUIRED'
    || heartbeatAtMs !== null
    || evidencePurgeAfterMs !== null) throw invalid();
}

function assertPhase(
  phase: WebSocketHealthPhase,
  providerId: RpcProviderId | null,
  activeSessionGeneration: bigint | null,
  candidateProviderId: RpcProviderId | null,
  candidateSessionGeneration: bigint | null,
  acknowledgedAtMs: number | null,
): void {
  const active = providerId !== null && activeSessionGeneration !== null;
  const candidate = candidateProviderId !== null && candidateSessionGeneration !== null;
  switch (phase) {
    case 'STOPPED':
      if (active || candidate || acknowledgedAtMs !== null) throw invalid();
      return;
    case 'CONNECTING':
    case 'WAITING_FOR_ACKS':
      if (!candidate || acknowledgedAtMs !== null) throw invalid();
      return;
    case 'ACKNOWLEDGED':
    case 'RECOVERING':
      if (!candidate || acknowledgedAtMs === null) throw invalid();
      return;
    case 'RUNNING':
      if (!active || candidate || acknowledgedAtMs === null) throw invalid();
      return;
    case 'DEGRADED':
    case 'UNRECOVERABLE':
    case 'STOPPING':
      if (acknowledgedAtMs !== null && !active && !candidate) throw invalid();
      return;
  }
}

function ownEnumerableDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
      throw invalid();
    }
    const prototype: object | null = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length) throw invalid();
    const result: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      if (!keys.includes(key)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw invalid();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw invalid();
  }
}

function generationFrom(value: unknown, allowZero: boolean): bigint {
  if (typeof value !== 'bigint'
    || value < (allowZero ? 0n : 1n)
    || value > MAX_WEBSOCKET_HEALTH_GENERATION) throw invalid();
  return value;
}

function nullableSessionGenerationFrom(value: unknown): bigint | null {
  if (value === null) return null;
  return generationFrom(value, false);
}

function slotFrom(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_WEBSOCKET_HEALTH_SLOT) {
    throw invalid();
  }
  return value;
}

function timestampFrom(value: unknown): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) > MAX_WEBSOCKET_HEALTH_TIMESTAMP_MS
    || Object.is(value, -0)) throw invalid();
  return value as number;
}

function nullableTimestampFrom(value: unknown): number | null {
  if (value === null) return null;
  return timestampFrom(value);
}

function nullableProviderIdFrom(value: unknown): RpcProviderId | null {
  if (value === null) return null;
  if (!isRpcProviderId(value)) throw invalid();
  return value;
}

function supervisionFrom(value: unknown): WebSocketHealthSupervision {
  if (value !== 'INACTIVE' && value !== 'ACTIVE') throw invalid();
  return value;
}

function phaseFrom(value: unknown): WebSocketHealthPhase {
  if (!(WEBSOCKET_HEALTH_PHASES as readonly unknown[]).includes(value)) throw invalid();
  return value as WebSocketHealthPhase;
}

function recoveryStatusFrom(value: unknown): WebSocketRecoveryStatus {
  if (!(WEBSOCKET_RECOVERY_STATUSES as readonly unknown[]).includes(value)) throw invalid();
  return value as WebSocketRecoveryStatus;
}

function disconnectReasonFrom(value: unknown): WebSocketDisconnectReasonCode {
  if (!(WEBSOCKET_DISCONNECT_REASON_CODES as readonly unknown[]).includes(value)) throw invalid();
  return value as WebSocketDisconnectReasonCode;
}

function nullableRecoveryReasonFrom(value: unknown): WebSocketRecoveryReasonCode | null {
  if (value === null) return null;
  if (!(WEBSOCKET_RECOVERY_REASON_CODES as readonly unknown[]).includes(value)) throw invalid();
  return value as WebSocketRecoveryReasonCode;
}

function assertPair(providerId: RpcProviderId | null, generation: bigint | null): void {
  if ((providerId === null) !== (generation === null)) throw invalid();
}

function invalid(): WebSocketHealthValidationError {
  return new WebSocketHealthValidationError();
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
