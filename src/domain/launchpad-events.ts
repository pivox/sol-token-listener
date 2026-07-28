import {
  createDeterministicChainEventId,
  type TypedDomainEvent,
} from './events.js';
import type {
  LaunchpadTrade,
  ObservedChainTransaction,
  TokenLaunch,
} from './types.js';

export interface TokenLaunchDetectedPayloadV1 {
  readonly launch: TokenLaunch;
}

export interface BondingCurveTradeObservedPayloadV1 {
  readonly trade: LaunchpadTrade;
}

export type TokenLaunchDetectedEventV1 = TypedDomainEvent<
  'TokenLaunchDetected',
  TokenLaunchDetectedPayloadV1
>;

export type BondingCurveTradeObservedEventV1 = TypedDomainEvent<
  'BondingCurveTradeObserved',
  BondingCurveTradeObservedPayloadV1
>;

export type LaunchpadObservationEventV1 =
  | TokenLaunchDetectedEventV1
  | BondingCurveTradeObservedEventV1;

interface EventFactoryInput<T> {
  readonly source: string;
  readonly program: string;
  readonly transaction: ObservedChainTransaction;
  readonly value: T;
}

export function createTokenLaunchDetectedEvent(
  input: Omit<EventFactoryInput<TokenLaunch>, 'value'> & { readonly launch: TokenLaunch },
): TokenLaunchDetectedEventV1 {
  const { launch, transaction } = input;
  const type = 'TokenLaunchDetected';
  return {
    id: createDeterministicChainEventId({
      type,
      mint: launch.mint,
      source: input.source,
      program: input.program,
      signature: transaction.signature,
      cursor: launch.createdAt,
    }),
    type,
    mint: launch.mint,
    source: input.source,
    program: input.program,
    signature: transaction.signature,
    cursor: launch.createdAt,
    confirmationStatus: transaction.confirmationStatus,
    blockchainTimeMs: transaction.blockTimeMs,
    observedAtMs: transaction.observedAtMs,
    payloadVersion: 1,
    payload: { launch },
  };
}

export function createBondingCurveTradeObservedEvent(
  input: Omit<EventFactoryInput<LaunchpadTrade>, 'value'> & {
    readonly trade: LaunchpadTrade;
  },
): BondingCurveTradeObservedEventV1 {
  const { trade, transaction } = input;
  const type = 'BondingCurveTradeObserved';
  return {
    id: createDeterministicChainEventId({
      type,
      mint: trade.launchMint,
      source: input.source,
      program: input.program,
      signature: transaction.signature,
      cursor: trade.cursor,
    }),
    type,
    mint: trade.launchMint,
    source: input.source,
    program: input.program,
    signature: transaction.signature,
    cursor: trade.cursor,
    confirmationStatus: transaction.confirmationStatus,
    blockchainTimeMs: transaction.blockTimeMs,
    observedAtMs: transaction.observedAtMs,
    payloadVersion: 1,
    payload: { trade },
  };
}
