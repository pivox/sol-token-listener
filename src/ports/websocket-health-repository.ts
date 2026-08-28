import type { RpcProviderId } from '../domain/rpc-provider.js';
import type {
  WebSocketDisconnectReasonCode,
  WebSocketHealthPhase,
  WebSocketHealthSnapshot,
  WebSocketRecoveryReasonCode,
  WebSocketRecoveryStatus,
} from '../domain/websocket-health.js';

export const WEBSOCKET_HEALTH_REPOSITORY_ERROR_CODES = Object.freeze([
  'ACTIVE_INSTANCE',
  'STALE_OWNER',
  'STALE_REVISION',
  'GENERATION_EXHAUSTED',
  'STATE_CONFLICT',
  'DEPENDENCY_FAILED',
] as const);

export type WebSocketHealthRepositoryErrorCode =
  (typeof WEBSOCKET_HEALTH_REPOSITORY_ERROR_CODES)[number];

export interface WebSocketHealthBeginOwner {
  readonly candidateProviderId: RpcProviderId;
}

export interface WebSocketHealthTransition {
  readonly ownerGeneration: bigint;
  readonly expectedRevision: bigint;
  readonly phase: WebSocketHealthPhase;
  readonly providerId: RpcProviderId | null;
  readonly activeSessionGeneration: bigint | null;
  readonly candidateProviderId: RpcProviderId | null;
  readonly candidateSessionGeneration: bigint | null;
  readonly acknowledged: boolean;
  readonly disconnectReasonCode: WebSocketDisconnectReasonCode | null;
  readonly recoveryStatus: WebSocketRecoveryStatus;
  readonly recoveryReasonCode: WebSocketRecoveryReasonCode | null;
}

export interface WebSocketHealthObservation {
  readonly ownerGeneration: bigint;
  readonly sessionGeneration: bigint;
  readonly slot: bigint;
}

export interface WebSocketHealthRepository {
  read(): Promise<WebSocketHealthSnapshot>;
  beginOwner(input: WebSocketHealthBeginOwner): Promise<WebSocketHealthSnapshot>;
  transition(input: WebSocketHealthTransition): Promise<WebSocketHealthSnapshot>;
  touch(ownerGeneration: bigint): Promise<void>;
  recordObservation(input: WebSocketHealthObservation):
    Promise<'RECORDED' | 'STALE_SESSION'>;
}
