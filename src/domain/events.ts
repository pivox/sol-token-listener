import { createHash } from 'node:crypto';
import { assertValidChainCursor } from './cursor.js';
import type { ChainConfirmationStatus, ChainCursor } from './types.js';

export const DOMAIN_EVENT_TYPES = [
  'TokenLaunchDetected',
  'TokenMetadataResolved',
  'TokenMetadataFailed',
  'SocialEvidenceCollected',
  'CreatorProfileUpdated',
  'HolderDistributionUpdated',
  'WalletClusterDetected',
  'BondingCurveTradeObserved',
  'BondingCurveStateUpdated',
  'BondingCurveCompleted',
  'QualificationUpdated',
  'TradingCandidateUpdated',
  'PaperStrategySessionUpdated',
  'PaperExternalBuyCounted',
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

export function createDeterministicDerivedEventId(input: Readonly<{
  type: DomainEventType;
  mint: string;
  source: string;
  program: string;
  signature: string;
  cursor: ChainCursor;
  qualifier: string;
}>): string {
  if (
    typeof input.qualifier !== 'string'
    || input.qualifier === ''
    || Buffer.byteLength(input.qualifier, 'utf8') > 16_384
  ) throw new TypeError('Derived event qualifier is invalid.');
  const chainId = createDeterministicChainEventId(input);
  const canonical = JSON.stringify([chainId, input.qualifier]);
  return `evt_${createHash('sha256').update(canonical).digest('hex')}`;
}
