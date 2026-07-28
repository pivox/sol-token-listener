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
  TokenLaunchDetectedPayloadV1,
  1
>;

export type BondingCurveTradeObservedEventV1 = TypedDomainEvent<
  'BondingCurveTradeObserved',
  BondingCurveTradeObservedPayloadV1,
  1
>;

export type LaunchpadObservationEventV1 =
  | TokenLaunchDetectedEventV1
  | BondingCurveTradeObservedEventV1;

interface EventFactoryContext {
  readonly source: string;
  readonly program: string;
  readonly transaction: ObservedChainTransaction;
}

export function createTokenLaunchDetectedEvent(
  input: EventFactoryContext & { readonly launch: TokenLaunch },
): TokenLaunchDetectedEventV1 {
  const launch = createImmutableSnapshot(input.launch);
  const { transaction } = input;
  const type = 'TokenLaunchDetected';
  const cursor = launch.createdAt;
  return freezeSnapshot({
    id: createDeterministicChainEventId({
      type,
      mint: launch.mint,
      source: input.source,
      program: input.program,
      signature: transaction.signature,
      cursor,
    }),
    type,
    mint: launch.mint,
    source: input.source,
    program: input.program,
    signature: transaction.signature,
    cursor,
    confirmationStatus: transaction.confirmationStatus,
    blockchainTimeMs: transaction.blockTimeMs,
    observedAtMs: transaction.observedAtMs,
    payloadVersion: 1,
    payload: { launch },
  });
}

export function createBondingCurveTradeObservedEvent(
  input: EventFactoryContext & {
    readonly trade: LaunchpadTrade;
  },
): BondingCurveTradeObservedEventV1 {
  const trade = createImmutableSnapshot(input.trade);
  const { transaction } = input;
  const type = 'BondingCurveTradeObserved';
  const cursor = trade.cursor;
  return freezeSnapshot({
    id: createDeterministicChainEventId({
      type,
      mint: trade.launchMint,
      source: input.source,
      program: input.program,
      signature: transaction.signature,
      cursor,
    }),
    type,
    mint: trade.launchMint,
    source: input.source,
    program: input.program,
    signature: transaction.signature,
    cursor,
    confirmationStatus: transaction.confirmationStatus,
    blockchainTimeMs: transaction.blockTimeMs,
    observedAtMs: transaction.observedAtMs,
    payloadVersion: 1,
    payload: { trade },
  });
}

function createImmutableSnapshot<T>(value: T): T {
  return freezeSnapshot(structuredClone(value));
}

function freezeSnapshot<T>(value: T): T {
  freezeObjectGraph(value, new WeakSet());
  return value;
}

function freezeObjectGraph(value: unknown, frozen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || frozen.has(value)) return;
  frozen.add(value);
  for (const nestedValue of Object.values(value)) {
    freezeObjectGraph(nestedValue, frozen);
  }
  Object.freeze(value);
}
