import { createHash } from 'node:crypto';
import { assertValidChainCursor } from './cursor.js';
import type { ChainConfirmationStatus, ChainCursor } from './types.js';

export const DOMAIN_EVENT_TYPES = [
  'TokenLaunchDetected',
  'TokenMetadataResolved',
  'TokenMetadataFailed',
  'SocialEvidenceCollected',
  'CreatorProfileUpdated',
  'WalletClusterDetected',
  'BondingCurveTradeObserved',
  'BondingCurveStateUpdated',
  'BondingCurveCompleted',
  'QualificationUpdated',
  'PaperPositionOpened',
  'PaperPositionUpdated',
  'PaperPositionClosed',
  'MigrationObserved',
  'PumpSwapPoolActivated',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export interface DomainEvent<TPayload extends object = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly type: DomainEventType;
  readonly mint: string;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTimeMs: number | null;
  readonly observedAtMs: number;
  readonly payloadVersion: number;
  readonly payload: TPayload;
}

export type TypedDomainEvent<
  TType extends DomainEventType,
  TPayload extends object,
  TPayloadVersion extends number,
> = Omit<DomainEvent<TPayload>, 'type' | 'payloadVersion'> & {
  readonly type: TType;
  readonly payloadVersion: TPayloadVersion;
};

export interface ChainEventIdentity {
  readonly type: string;
  readonly mint: string;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
}

export function createDeterministicChainEventId(identity: ChainEventIdentity): string {
  const { cursor } = identity;
  assertValidChainCursor(cursor);
  const canonical = JSON.stringify([
    identity.type,
    identity.mint,
    identity.source,
    identity.program,
    identity.signature,
    cursor.slot.toString(),
    cursor.transactionIndex.toString(),
    cursor.instructionIndex.toString(),
    cursor.innerInstructionIndex === null ? 'outer' : cursor.innerInstructionIndex.toString(),
  ]);
  return `evt_${createHash('sha256').update(canonical).digest('hex')}`;
}
