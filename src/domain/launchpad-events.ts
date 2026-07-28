import {
  createDeterministicChainEventId,
  type TypedDomainEvent,
} from './events.js';
import type {
  ChainCursor,
  LaunchpadTrade,
  LaunchParameterObject,
  LaunchParameterValue,
  ObservedChainTransaction,
  QuoteAsset,
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

export class UnsupportedLaunchParameterValueError extends Error {
  public constructor(public readonly path: string) {
    super(`Unsupported launch parameter value at ${path}`);
    this.name = 'UnsupportedLaunchParameterValueError';
  }
}

export function createTokenLaunchDetectedEvent(
  input: EventFactoryContext & { readonly launch: TokenLaunch },
): TokenLaunchDetectedEventV1 {
  const launch = snapshotTokenLaunch(input.launch);
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
  const trade = snapshotLaunchpadTrade(input.trade);
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

function snapshotTokenLaunch(launch: TokenLaunch): TokenLaunch {
  return freezeSnapshot({
    mint: launch.mint,
    creator: launch.creator,
    tokenProgram: launch.tokenProgram,
    quoteAssets: freezeSnapshot(launch.quoteAssets.map(snapshotQuoteAsset)),
    launchpad: launch.launchpad,
    createdAt: snapshotChainCursor(launch.createdAt),
    parameters: snapshotLaunchParameterObject(launch.parameters, 'parameters', new WeakSet()),
  });
}

function snapshotLaunchpadTrade(trade: LaunchpadTrade): LaunchpadTrade {
  return freezeSnapshot({
    id: trade.id,
    launchMint: trade.launchMint,
    kind: trade.kind,
    trader: trade.trader,
    baseAmountRaw: trade.baseAmountRaw,
    quoteAmountRaw: trade.quoteAmountRaw,
    quoteAsset: snapshotQuoteAsset(trade.quoteAsset),
    cursor: snapshotChainCursor(trade.cursor),
  });
}

function snapshotChainCursor(cursor: ChainCursor): ChainCursor {
  return freezeSnapshot({
    slot: cursor.slot,
    transactionIndex: cursor.transactionIndex,
    instructionIndex: cursor.instructionIndex,
    innerInstructionIndex: cursor.innerInstructionIndex,
  });
}

function snapshotQuoteAsset(quoteAsset: QuoteAsset): QuoteAsset {
  return freezeSnapshot({
    mint: quoteAsset.mint,
    decimals: quoteAsset.decimals,
    tokenProgram: quoteAsset.tokenProgram,
  });
}

function snapshotLaunchParameterObject(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): LaunchParameterObject {
  if (!isPlainObject(value)) throw new UnsupportedLaunchParameterValueError(path);
  if (ancestors.has(value)) throw new UnsupportedLaunchParameterValueError(path);
  ancestors.add(value);
  const snapshot: Record<string, LaunchParameterValue> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    snapshot[key] = snapshotLaunchParameterValue(nestedValue, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
  return freezeSnapshot(snapshot);
}

function snapshotLaunchParameterValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): LaunchParameterValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new UnsupportedLaunchParameterValueError(path);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new UnsupportedLaunchParameterValueError(path);
    ancestors.add(value);
    const snapshot = value.map((nestedValue, index) =>
      snapshotLaunchParameterValue(nestedValue, `${path}[${index}]`, ancestors));
    ancestors.delete(value);
    return freezeSnapshot(snapshot);
  }
  if (isPlainObject(value)) return snapshotLaunchParameterObject(value, path, ancestors);
  throw new UnsupportedLaunchParameterValueError(path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeSnapshot<T>(value: T): T {
  if (typeof value === 'object' && value !== null) Object.freeze(value);
  return value;
}
