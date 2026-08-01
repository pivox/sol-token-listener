import { isDeepStrictEqual } from 'node:util';
import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
} from '../domain/launchpad-events.js';
import type { LaunchpadObservationEventV1 } from '../domain/launchpad-events.js';
import type { LaunchpadEventBatchResult } from '../ports/launchpad-event-sink.js';
import type { LaunchpadProjectionReader } from '../ports/launchpad-projection-reader.js';
import { createSolanaObservedTransaction } from '../solana/rpc/observed-transaction.js';
import type { SolanaObservedTransaction } from '../solana/rpc/observed-transaction.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';
import {
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_STRING_BYTES,
  MAX_CANONICAL_JSON_TEXT_BYTES,
  stringifyJson,
} from '../utils/json.js';

export const MAX_OBSERVED_PIPELINE_ITEMS = 4_096;
const MAX_OBSERVED_PIPELINE_SNAPSHOT_NODES =
  MAX_OBSERVED_PIPELINE_ITEMS * 24;

export type ObservedPipelineStage =
  | 'create_observation'
  | 'load_tracked_mints'
  | 'launchpad_observation'
  | 'reload_active_events'
  | 'funding_observation'
  | 'participant_analytics'
  | 'wallet_graph'
  | 'pumpswap_observation';

export interface ObservedPipelineResult {
  readonly launchpadEventCount: number;
  readonly activeEventCount: number;
  readonly fundingAssessmentCount: number;
  readonly fundingEvidenceCount: number;
  readonly affectedMintCount: number;
  readonly participantAnalyticsCount: number;
  readonly walletGraphCount: number;
  readonly marketMigrationCount: number;
  readonly marketActivationCount: number;
}

export class ObservedPipelineError extends Error {
  public readonly code = 'PIPELINE_STAGE_FAILED' as const;

  public constructor(
    public readonly stage: ObservedPipelineStage,
    public readonly mint: string | null = null,
  ) {
    super(`Observed transaction pipeline failed during ${stage}.`);
    this.name = 'ObservedPipelineError';
  }
}

interface LaunchpadObserver {
  observe(
    transaction: SolanaObservedTransaction,
    trackedMints: ReadonlySet<string>,
  ): Promise<LaunchpadEventBatchResult>;
}

interface FundingObservationResult {
  readonly assessments: readonly unknown[];
  readonly evidence: readonly unknown[];
}

interface FundingObserver {
  observe(
    transaction: SolanaObservedTransaction,
    events: readonly Extract<
      LaunchpadObservationEventV1,
      { readonly type: 'BondingCurveTradeObserved' }
    >[],
  ): Promise<FundingObservationResult>;
}

interface MintProjectionRebuilder {
  rebuild(mint: string): Promise<unknown>;
}

interface MarketObservationResult {
  readonly migrations: readonly unknown[];
  readonly activations: readonly unknown[];
}

interface MarketObserver {
  processObserved(
    transaction: SolanaObservedTransaction,
  ): Promise<MarketObservationResult>;
}

export class ObservedTransactionPipeline {
  public constructor(
    private readonly reader: LaunchpadProjectionReader,
    private readonly launchpad: LaunchpadObserver,
    private readonly funding: FundingObserver,
    private readonly participants: MintProjectionRebuilder,
    private readonly graph: MintProjectionRebuilder,
    private readonly market: MarketObserver,
    private readonly clock: () => number = Date.now,
  ) {}

  public async process(
    transaction: NormalizedTransaction,
  ): Promise<ObservedPipelineResult> {
    const observed = await this.stage('create_observation', null, () =>
      createSolanaObservedTransaction(transaction, this.clock()));
    const trackedMints = await this.stage('load_tracked_mints', null, async () =>
      boundedMintSet(await this.reader.listTrackedMints()));
    const launchpad = await this.stage('launchpad_observation', null, async () =>
      snapshotLaunchpadResult(await this.launchpad.observe(observed, trackedMints)));
    const active = await this.stage('reload_active_events', null, async () =>
      snapshotActiveContext(
        await this.reader.listActiveEventsBySignature(observed.signature),
      ));
    const funding = await this.stage('funding_observation', null, async () =>
      snapshotNamedCounts(
        await this.funding.observe(observed, active.trades),
        ['assessments', 'evidence'],
      ));
    const affectedMints = await this.stage('reload_active_events', null, () =>
      affectedMintList(active.mints, launchpad.affectedMints));

    let participantAnalyticsCount = 0;
    let walletGraphCount = 0;
    for (const mint of affectedMints) {
      await this.stage('participant_analytics', mint, () =>
        this.participants.rebuild(mint));
      participantAnalyticsCount += 1;
    }
    for (const mint of affectedMints) {
      await this.stage('wallet_graph', mint, () => this.graph.rebuild(mint));
      walletGraphCount += 1;
    }

    const market = await this.stage('pumpswap_observation', null, async () =>
      snapshotNamedCounts(
        await this.market.processObserved(observed),
        ['migrations', 'activations'],
      ));
    return Object.freeze({
      launchpadEventCount: launchpad.eventCount,
      activeEventCount: active.events.length,
      fundingAssessmentCount: funding[0],
      fundingEvidenceCount: funding[1],
      affectedMintCount: affectedMints.length,
      participantAnalyticsCount,
      walletGraphCount,
      marketMigrationCount: market[0],
      marketActivationCount: market[1],
    });
  }

  private async stage<TResult>(
    stage: ObservedPipelineStage,
    mint: string | null,
    operation: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await operation();
    } catch {
      throw new ObservedPipelineError(stage, mint);
    }
  }
}

function boundedMintSet(values: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(snapshotMintIterable(values));
}

interface ActiveContext {
  readonly events: readonly LaunchpadObservationEventV1[];
  readonly trades: readonly Extract<
    LaunchpadObservationEventV1,
    { readonly type: 'BondingCurveTradeObserved' }
  >[];
  readonly mints: readonly string[];
}

function snapshotActiveContext(value: unknown): ActiveContext {
  const snapshot = deepSnapshot(value, 0, snapshotState());
  assertSerializedSnapshotBound(snapshot);
  if (!Array.isArray(snapshot)) throw new TypeError('active events must be an array');
  const byId = new Map<string, LaunchpadObservationEventV1>();
  const events: LaunchpadObservationEventV1[] = [];
  for (const valueEvent of snapshot) {
    const event = validatedEvent(valueEvent);
    const existing = byId.get(event.id);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, event)) {
        throw new TypeError('conflicting active event');
      }
      continue;
    }
    byId.set(event.id, event);
    events.push(event);
  }
  const frozenEvents = Object.freeze(events);
  const trades = Object.freeze(frozenEvents.filter(
    (event): event is Extract<
      LaunchpadObservationEventV1,
      { readonly type: 'BondingCurveTradeObserved' }
    > => event.type === 'BondingCurveTradeObserved',
  ));
  const mints = Object.freeze([...new Set(frozenEvents.map((event) => event.mint))]);
  return Object.freeze({ events: frozenEvents, trades, mints });
}

function affectedMintList(
  activeMints: readonly string[],
  launchpadAffectedMints: readonly string[],
): readonly string[] {
  const mints = new Set([
    ...activeMints,
    ...launchpadAffectedMints,
  ]);
  if (mints.size > MAX_OBSERVED_PIPELINE_ITEMS) throw new RangeError('too many affected mints');
  return Object.freeze([...mints].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0));
}

function snapshotLaunchpadResult(value: unknown): {
  readonly eventCount: number;
  readonly affectedMints: readonly string[];
} {
  const result = dataRecord(value, ['events', 'affectedMints']);
  return Object.freeze({
    eventCount: denseArrayLength(result.events),
    affectedMints: snapshotMintIterable(result.affectedMints),
  });
}

function snapshotMintIterable(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null) throw new TypeError('mints must be iterable');
  const method: unknown = Reflect.get(value, Symbol.iterator);
  if (typeof method !== 'function') throw new TypeError('mints must be iterable');
  const iterator: unknown = Reflect.apply(method, value, []);
  if (typeof iterator !== 'object' || iterator === null) throw new TypeError('invalid mint iterator');
  const next: unknown = Reflect.get(iterator, 'next');
  if (typeof next !== 'function') throw new TypeError('invalid mint iterator');
  const mints = new Set<string>();
  for (let visited = 0; visited <= MAX_OBSERVED_PIPELINE_ITEMS; visited += 1) {
    const step = dataRecord(Reflect.apply(next, iterator, []), ['value', 'done']);
    if (step.done === true) return Object.freeze([...mints]);
    if (step.done !== false || visited === MAX_OBSERVED_PIPELINE_ITEMS) {
      throw new RangeError('too many mints');
    }
    const mint = step.value;
    if (!isSafeMint(mint)) throw new TypeError('invalid mint');
    mints.add(mint);
  }
  throw new RangeError('too many mints');
}

function snapshotNamedCounts(
  value: unknown,
  fields: readonly [string, string],
): readonly [number, number] {
  const result = dataRecord(value, fields);
  return Object.freeze([
    denseArrayLength(result[fields[0]]),
    denseArrayLength(result[fields[1]]),
  ]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

interface SnapshotState {
  nodes: number;
  textBytes: number;
  readonly ancestors: WeakSet<object>;
  readonly memo: WeakMap<object, unknown>;
}

function snapshotState(): SnapshotState {
  return { nodes: 0, textBytes: 0, ancestors: new WeakSet(), memo: new WeakMap() };
}

function deepSnapshot(value: unknown, depth: number, state: SnapshotState): unknown {
  // A node is every visited value (containers and leaves). Property names and
  // array indexes are text-budget entries, not nodes.
  state.nodes += 1;
  if (state.nodes > MAX_OBSERVED_PIPELINE_SNAPSHOT_NODES) {
    throw new RangeError('snapshot too large');
  }
  if (depth > MAX_CANONICAL_JSON_DEPTH) throw new RangeError('snapshot too deep');
  if (typeof value === 'string') {
    accountText(value, state);
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    if (value.toString().replace(/^-/, '').length > 78) throw new RangeError('bigint too large');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('invalid number');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('invalid snapshot value');
  if (state.ancestors.has(value)) throw new TypeError('cyclic snapshot');
  const memoized = state.memo.get(value);
  if (memoized !== undefined) return memoized;
  const prototype: unknown = Reflect.getPrototypeOf(value);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new TypeError('invalid array prototype');
      const { length, descriptors } = arrayDescriptors(value);
      const result: unknown[] = [];
      state.memo.set(value, result);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[index];
        if (descriptor === undefined) throw new TypeError('sparse array');
        accountText(String(index), state);
        result.push(deepSnapshot(descriptor.value, depth + 1, state));
      }
      Object.freeze(result);
      state.memo.set(value, result);
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('invalid object prototype');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('symbols are invalid');
    const result: Record<string, unknown> = {};
    state.memo.set(value, result);
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError('invalid key');
      accountText(key, state);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('invalid property');
      }
      Object.defineProperty(result, key, {
        value: deepSnapshot(descriptor.value, depth + 1, state),
        enumerable: true,
      });
    }
    Object.freeze(result);
    state.memo.set(value, result);
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function assertSerializedSnapshotBound(value: unknown): void {
  const serialized = stringifyJson(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CANONICAL_JSON_TEXT_BYTES) {
    throw new RangeError('snapshot serialization too large');
  }
}

function arrayDescriptors(value: object): {
  readonly length: number;
  readonly descriptors: readonly PropertyDescriptor[];
} {
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > MAX_OBSERVED_PIPELINE_ITEMS
  ) throw new RangeError('invalid array length');
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1
    || keys.some((key) => typeof key === 'symbol')
    || !keys.includes('length')
  ) throw new TypeError('invalid array keys');
  const descriptors: PropertyDescriptor[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('invalid array item');
    }
    descriptors.push(descriptor);
  }
  return { length, descriptors };
}

function denseArrayLength(value: unknown): number {
  if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('result must be an array');
  }
  return arrayDescriptors(value).length;
}

function dataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('result must be an object');
  }
  const prototype: unknown = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('invalid result prototype');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) throw new TypeError('invalid result keys');
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('invalid result property');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function validatedEvent(value: unknown): LaunchpadObservationEventV1 {
  if (!isRecord(value)) throw new TypeError('invalid active event');
  const event = value as unknown as LaunchpadObservationEventV1;
  const eventType: unknown = value.type;
  const transaction = {
    signature: event.signature,
    confirmationStatus: event.confirmationStatus,
    blockTimeMs: event.blockchainTimeMs,
    observedAtMs: event.observedAtMs,
    cursor: {
      slot: event.cursor.slot,
      transactionIndex: event.cursor.transactionIndex,
    },
    raw: null,
  };
  let expected: LaunchpadObservationEventV1 | null = null;
  if (eventType === 'TokenLaunchDetected') {
    const launchEvent = event as Extract<
      LaunchpadObservationEventV1,
      { readonly type: 'TokenLaunchDetected' }
    >;
    expected = createTokenLaunchDetectedEvent({
      source: launchEvent.source,
      program: launchEvent.program,
      transaction,
      launch: launchEvent.payload.launch,
    });
  } else if (eventType === 'BondingCurveTradeObserved') {
    const tradeEvent = event as Extract<
      LaunchpadObservationEventV1,
      { readonly type: 'BondingCurveTradeObserved' }
    >;
    expected = createBondingCurveTradeObservedEvent({
      source: tradeEvent.source,
      program: tradeEvent.program,
      transaction,
      trade: tradeEvent.payload.trade,
    });
  }
  if (expected === null || !isDeepStrictEqual(expected, event)) {
    throw new TypeError('invalid active event');
  }
  return event;
}

function accountText(value: string, state: SnapshotState): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (
    bytes > MAX_CANONICAL_JSON_STRING_BYTES
    || state.textBytes + bytes > MAX_CANONICAL_JSON_TEXT_BYTES
  ) throw new RangeError('snapshot text too large');
  state.textBytes += bytes;
}

function isSafeMint(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/u.test(value);
}
