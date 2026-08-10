import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { AppConfig } from '../config/env.js';
import type { DomainEvent } from '../domain/events.js';
import { assertValidChainCursor } from '../domain/cursor.js';
import type {
  QualificationConditionEvidence,
  QualificationReport,
  QualificationScore,
} from '../domain/qualification.js';
import {
  PaperTradingError,
  type ClosePaperPositionCommand,
  type OpenPaperPositionCommand,
  type PaperExecutionQuote,
  type PaperPosition,
  type PaperPositionClosedEventV1,
  type PaperPositionOpenedEventV1,
  type PaperTrade,
} from '../domain/paper-trading.js';
import {
  assertValidNullableTimestampMs,
  assertValidTimestampMs,
} from '../domain/timestamp.js';
import type {
  PaperTradingRepository,
  PaperTradingTransaction,
} from '../ports/paper-trading-repository.js';
import { stringifyJson } from '../utils/json.js';
import { calculateRoundTrip, validatePaperQuote } from './paper-math.js';

interface Clock {
  readonly now: () => number;
}

type PaperTradingConfig = Pick<
  AppConfig,
  'executionMode' | 'paperQuoteMintAllowlist' | 'dataRetentionHours'
>;

export class PaperTradingEngine {
  public constructor(
    private readonly config: PaperTradingConfig,
    private readonly repository: PaperTradingRepository,
    private readonly clock: Clock = { now: Date.now },
  ) {
    if (!Number.isSafeInteger(config.dataRetentionHours) || config.dataRetentionHours <= 0) {
      throw new RangeError('dataRetentionHours doit être un entier positif sûr.');
    }
  }

  public async open(command: OpenPaperPositionCommand): Promise<PaperPosition> {
    this.requirePaperMode();
    const snapshot = snapshotOpenCommand(command);
    validateOpenCommand(snapshot, this.config.paperQuoteMintAllowlist);
    const roundTrip = calculateRoundTrip(snapshot.buyQuote, snapshot.reverseSellQuote);
    if (roundTrip.lossBps > snapshot.maximumRoundTripLossBps) {
      throw new PaperTradingError(
        'ROUND_TRIP_LOSS_EXCEEDED',
        `Perte aller-retour ${roundTrip.lossBps} bps supérieure au plafond.`,
      );
    }
    const positionId = hashId('paper_position', [
      snapshot.mint,
      snapshot.strategy.id,
      snapshot.strategy.version,
      snapshot.trigger.id,
    ]);
    const openCommandHash = hashValue('paper_open_command', {
      ...snapshot,
      trigger: snapshot.trigger.id,
    });
    const openedAtMs = this.clock.now();
    assertValidTimestampMs('occurredAtMs', openedAtMs);

    return this.repository.transact(async (transaction) => {
      const existing = await transaction.findPosition(positionId);
      if (existing !== null) {
        return this.reconcileOpenReplay(
          transaction,
          existing,
          openCommandHash,
          snapshot.trigger,
        );
      }
      const active = await transaction.findActivePosition(snapshot.mint, snapshot.strategy);
      if (active !== null) {
        if (active.id === positionId && active.openCommandHash === openCommandHash) {
          return this.reconcileOpenReplay(
            transaction,
            active,
            openCommandHash,
            snapshot.trigger,
          );
        }
        conflict();
      }
      const terminalReplay = await transaction.findPosition(positionId);
      if (terminalReplay !== null) {
        return this.reconcileOpenReplay(
          transaction,
          terminalReplay,
          openCommandHash,
          snapshot.trigger,
        );
      }
      rejectOrphanedTrigger(snapshot.trigger);
      const tradeId = hashId('paper_trade', [positionId, 'BUY']);
      const trade = freeze({
        id: tradeId,
        positionId,
        side: 'BUY',
        quote: snapshot.buyQuote,
        fillAmountOutRaw: snapshot.buyQuote.minimumAmountOutRaw,
        reason: 'QUALIFIED_ENTRY',
        createdAtMs: openedAtMs,
        payloadVersion: 1,
      } satisfies PaperTrade);
      const position = freeze({
        id: positionId,
        mint: snapshot.mint,
        quoteAsset: snapshot.quoteAsset,
        strategy: snapshot.strategy,
        status: 'PAPER_HOLDING',
        baseFilledRaw: roundTrip.baseFilledRaw,
        remainingBaseRaw: roundTrip.baseFilledRaw,
        quoteCostRaw: roundTrip.quoteCostRaw,
        quoteProceedsRaw: null,
        grossPnlQuoteRaw: null,
        netPnlQuoteRaw: null,
        roundTripLossBps: roundTrip.lossBps,
        entryTradeId: tradeId,
        exitTradeId: null,
        openCommandHash,
        closeCommandHash: null,
        triggerEventId: snapshot.trigger.id,
        openedAtMs,
        closedAtMs: null,
        purgeAfterMs: null,
        payloadVersion: 1,
      } satisfies PaperPosition);
      await transaction.insertOpened(
        position,
        trade,
        createPaperEvent('PaperPositionOpened', position, trade, snapshot.trigger),
      );
      return position;
    });
  }

  public async close(command: ClosePaperPositionCommand): Promise<PaperPosition> {
    this.requirePaperMode();
    const snapshot = snapshotCloseCommand(command);
    validatePaperQuote(snapshot.sellQuote);
    const closeCommandHash = hashValue('paper_close_command', {
      ...snapshot,
      trigger: snapshot.trigger.id,
    });
    const closedAtMs = this.clock.now();
    assertValidTimestampMs('occurredAtMs', closedAtMs);

    return this.repository.transact(async (transaction) => {
      const current = await transaction.findPosition(snapshot.positionId);
      if (current === null) {
        throw new PaperTradingError('POSITION_NOT_FOUND', 'Position paper introuvable.');
      }
      if (current.status !== 'PAPER_HOLDING') {
        if (current.closeCommandHash !== closeCommandHash) conflict();
        if (current.exitTradeId === null) conflict();
        await transaction.reconcileEventConfirmation(
          paperEventId(
            'PaperPositionClosed',
            current.id,
            current.exitTradeId,
            snapshot.trigger.id,
          ),
          snapshot.trigger,
        );
        if (snapshot.trigger.confirmationStatus === 'orphaned') {
          return this.retract(transaction, current);
        }
        return current;
      }
      validateCloseCommand(snapshot, current);
      const tradeId = hashId('paper_trade', [current.id, 'SELL']);
      const trade = freeze({
        id: tradeId,
        positionId: current.id,
        side: 'SELL',
        quote: snapshot.sellQuote,
        fillAmountOutRaw: snapshot.sellQuote.minimumAmountOutRaw,
        reason: snapshot.reason,
        createdAtMs: closedAtMs,
        payloadVersion: 1,
      } satisfies PaperTrade);
      const retentionMs = this.config.dataRetentionHours * 60 * 60 * 1_000;
      const position = freeze({
        ...current,
        status: 'PAPER_CLOSED',
        remainingBaseRaw: 0n,
        quoteProceedsRaw: snapshot.sellQuote.minimumAmountOutRaw,
        grossPnlQuoteRaw: snapshot.sellQuote.amountOutRaw - current.quoteCostRaw,
        netPnlQuoteRaw: snapshot.sellQuote.minimumAmountOutRaw - current.quoteCostRaw,
        exitTradeId: tradeId,
        closeCommandHash,
        closedAtMs,
        purgeAfterMs: closedAtMs + retentionMs,
      } satisfies PaperPosition);
      await transaction.updateClosed(
        position,
        trade,
        createPaperEvent('PaperPositionClosed', position, trade, snapshot.trigger),
      );
      return position;
    });
  }

  private async reconcileOpenReplay(
    transaction: PaperTradingTransaction,
    position: PaperPosition,
    openCommandHash: string,
    trigger: DomainEvent,
  ): Promise<PaperPosition> {
    if (position.openCommandHash !== openCommandHash) conflict();
    await transaction.reconcileEventConfirmation(
      paperEventId(
        'PaperPositionOpened',
        position.id,
        position.entryTradeId,
        trigger.id,
      ),
      trigger,
    );
    if (trigger.confirmationStatus === 'orphaned') {
      return this.retract(transaction, position);
    }
    return position;
  }

  private async retract(
    transaction: PaperTradingTransaction,
    current: PaperPosition,
  ): Promise<PaperPosition> {
    if (current.status === 'PAPER_RETRACTED') return current;
    const terminalAtMs = this.clock.now();
    assertValidTimestampMs('occurredAtMs', terminalAtMs);
    const retentionMs = this.config.dataRetentionHours * 60 * 60 * 1_000;
    const position = freeze({
      ...current,
      status: 'PAPER_RETRACTED',
      closedAtMs: current.closedAtMs ?? terminalAtMs,
      purgeAfterMs: terminalAtMs + retentionMs,
    } satisfies PaperPosition);
    await transaction.retractPosition(position);
    return position;
  }

  private requirePaperMode(): void {
    if (this.config.executionMode !== 'paper') {
      throw new PaperTradingError(
        'PAPER_MODE_DISABLED',
        'Le paper trading est désactivé en mode observe.',
      );
    }
  }
}

function validateOpenCommand(
  command: OpenPaperPositionCommand,
  allowlist: readonly string[],
): void {
  if (command.mint.trim() === '' || command.trigger.mint !== command.mint) invalidQuote('mint');
  if (command.strategy.id.trim() === '' || !Number.isSafeInteger(command.strategy.version) || command.strategy.version <= 0) {
    invalidQuote('strategy');
  }
  if (command.qualification.blockers.length > 0) {
    throw new PaperTradingError('QUALIFICATION_BLOCKED', 'La qualification contient un blocker.');
  }
  if (command.qualification.verdict !== 'QUALIFIED') {
    throw new PaperTradingError('QUALIFICATION_NOT_ACCEPTED', 'Le lancement n’est pas qualifié.');
  }
  if (!allowlist.includes(command.quoteAsset.mint)) {
    throw new PaperTradingError('QUOTE_MINT_NOT_ALLOWED', 'Quote mint non autorisé en paper V1.');
  }
  if (command.buyQuote.inputMint !== command.quoteAsset.mint || command.buyQuote.outputMint !== command.mint) {
    invalidQuote('buyQuote');
  }
  if (command.maximumRoundTripLossBps < 0n || command.maximumRoundTripLossBps > 10_000n) {
    invalidQuote('maximumRoundTripLossBps');
  }
}

function validateCloseCommand(
  command: ClosePaperPositionCommand,
  position: PaperPosition,
): void {
  rejectOrphanedTrigger(command.trigger);
  if (command.trigger.mint !== position.mint) invalidQuote('trigger.mint');
  if (command.reason.trim() === '') invalidQuote('reason');
  if (
    command.sellQuote.inputMint !== position.mint
    || command.sellQuote.outputMint !== position.quoteAsset.mint
    || command.sellQuote.amountInRaw !== position.remainingBaseRaw
  ) {
    invalidQuote('sellQuote');
  }
}

function rejectOrphanedTrigger(trigger: DomainEvent): void {
  if (trigger.confirmationStatus === 'orphaned') {
    throw new PaperTradingError(
      'TRIGGER_ORPHANED',
      'Un événement orphaned ne peut pas déclencher une action paper.',
    );
  }
}

function snapshotOpenCommand(command: OpenPaperPositionCommand): OpenPaperPositionCommand {
  return freeze({
    mint: command.mint,
    quoteAsset: freeze({
      mint: command.quoteAsset.mint,
      decimals: command.quoteAsset.decimals,
      tokenProgram: command.quoteAsset.tokenProgram,
    }),
    strategy: freeze({
      id: command.strategy.id,
      version: command.strategy.version,
    }),
    trigger: snapshotTrigger(command.trigger),
    qualification: snapshotQualification(command.qualification),
    buyQuote: snapshotQuote(command.buyQuote),
    reverseSellQuote: snapshotQuote(command.reverseSellQuote),
    maximumRoundTripLossBps: command.maximumRoundTripLossBps,
  });
}

function snapshotCloseCommand(command: ClosePaperPositionCommand): ClosePaperPositionCommand {
  return freeze({
    positionId: command.positionId,
    trigger: snapshotTrigger(command.trigger),
    sellQuote: snapshotQuote(command.sellQuote),
    reason: command.reason,
  });
}

function snapshotQuote(quote: PaperExecutionQuote): PaperExecutionQuote {
  return freeze({
    id: quote.id,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    amountInRaw: quote.amountInRaw,
    amountOutRaw: quote.amountOutRaw,
    minimumAmountOutRaw: quote.minimumAmountOutRaw,
    feesRaw: quote.feesRaw,
    slippageBps: quote.slippageBps,
    priceImpactBps: quote.priceImpactBps,
    observedAtMs: quote.observedAtMs,
    observedSlot: quote.observedSlot,
  });
}

function snapshotQualification(report: QualificationReport): QualificationReport {
  const score = (value: QualificationScore): QualificationScore => freeze({
    score: value.score,
    maximum: value.maximum,
  });
  return freeze({
    ruleSet: freeze({
      id: report.ruleSet.id,
      version: report.ruleSet.version,
      status: report.ruleSet.status,
      fingerprint: report.ruleSet.fingerprint,
      minimumTotalScore: report.ruleSet.minimumTotalScore,
    }),
    scores: freeze({
      preparation: score(report.scores.preparation),
      socialAuthenticity: score(report.scores.socialAuthenticity),
      onchainHealth: score(report.scores.onchainHealth),
      total: score(report.scores.total),
    }),
    evidence: freeze(report.evidence.map((item) => freeze({
      signal: item.signal,
      dimension: item.dimension,
      status: item.status,
      required: item.required,
      weight: item.weight,
      message: item.message,
    }))),
    conditions: freeze(report.conditions.map((item) => freeze({
      code: item.code,
      mode: item.mode,
      status: item.status,
      observed: snapshotConditionRecord(
        item.observed,
        conditionRecordKeys(item, 'observed'),
        observedConditionValueIsValid,
      ),
      thresholds: snapshotConditionRecord(
        item.thresholds,
        conditionRecordKeys(item, 'thresholds'),
        thresholdConditionValueIsValid,
      ),
      message: item.message,
    }))),
    blockers: freeze(report.blockers.map((item) => freeze({
      code: item.code,
      message: item.message,
    }))),
    verdict: report.verdict,
    evaluatedAtMs: report.evaluatedAtMs,
  });
}

function snapshotConditionRecord<T>(
  value: unknown,
  expectedKeys: readonly string[],
  validValue: (key: string, candidate: unknown) => boolean,
): Readonly<Record<string, T>> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || isProxy(value)
  ) throw new TypeError('Qualification condition records must be plain objects.');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError('Qualification condition records must be plain objects.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(descriptors, key))) {
    throw new TypeError('Qualification condition record keys are invalid.');
  }
  const result: Record<string, T> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable || !validValue(key, descriptor.value)) {
      throw new TypeError('Qualification condition records must contain enumerable data values.');
    }
    result[key] = descriptor.value as T;
  }
  return freeze(result);
}

type ConditionValueValidator = (value: unknown) => boolean;

const OBSERVED_CONDITION_VALUE_VALIDATORS: Readonly<Record<string, ConditionValueValidator>> = Object.freeze({
  top1HolderBps: isNullableBasisPoints,
  top5HoldersBps: isNullableBasisPoints,
  top10HoldersBps: isNullableBasisPoints,
  maximumRelatedClusterBps: isNullableBasisPoints,
  maximumSharedFunderCount: isNullableSharedFunderCount,
  buySimulationSucceeded: isNullableBoolean,
  sellQuoteAvailable: isNullableBoolean,
  roundTripLossBps: isNullableBasisPoints,
});

const THRESHOLD_CONDITION_VALUE_VALIDATORS: Readonly<Record<string, ConditionValueValidator>> = Object.freeze({
  maximumTop1Bps: isNullableBasisPoints,
  maximumTop5Bps: isNullableBasisPoints,
  maximumTop10Bps: isNullableBasisPoints,
  maximumClusterBps: isNullableBasisPoints,
  minimumSharedFunders: isNullableMinimumSharedFunders,
  maximumRoundTripLossBps: isNullableBasisPoints,
});

function observedConditionValueIsValid(key: string, value: unknown): boolean {
  return OBSERVED_CONDITION_VALUE_VALIDATORS[key]?.(value) ?? false;
}

function thresholdConditionValueIsValid(key: string, value: unknown): boolean {
  return THRESHOLD_CONDITION_VALUE_VALIDATORS[key]?.(value) ?? false;
}

function isNullableBasisPoints(value: unknown): boolean {
  return value === null || (typeof value === 'bigint' && value >= 0n && value <= 10_000n);
}

function isNullableSharedFunderCount(value: unknown): boolean {
  return value === null || isSafeInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function isNullableMinimumSharedFunders(value: unknown): boolean {
  return value === null || isSafeInteger(value, 1, 10_000);
}

function isNullableBoolean(value: unknown): boolean {
  return value === null || typeof value === 'boolean';
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= minimum
    && value <= maximum;
}

function conditionRecordKeys(
  condition: QualificationConditionEvidence,
  kind: 'observed' | 'thresholds',
): readonly string[] {
  if (condition.status === 'DISABLED') return EMPTY_CONDITION_RECORD_KEYS;
  switch (condition.code) {
    case 'HOLDER_CONCENTRATION_EXCEEDED':
      return kind === 'observed' ? HOLDER_OBSERVED_KEYS : HOLDER_THRESHOLD_KEYS;
    case 'RELATED_WALLET_CLUSTER_EXCEEDED':
      return kind === 'observed' ? RELATED_OBSERVED_KEYS : RELATED_THRESHOLD_KEYS;
    case 'SHARED_FUNDER_CLUSTER':
      return kind === 'observed' ? SHARED_FUNDER_OBSERVED_KEYS : SHARED_FUNDER_THRESHOLD_KEYS;
    case 'BUY_SIMULATION_FAILED':
      return kind === 'observed' ? BUY_SIMULATION_OBSERVED_KEYS : EMPTY_CONDITION_RECORD_KEYS;
    case 'SELL_QUOTE_UNAVAILABLE':
      return kind === 'observed' ? SELL_QUOTE_OBSERVED_KEYS : EMPTY_CONDITION_RECORD_KEYS;
    case 'ROUND_TRIP_LOSS_EXCEEDED':
      return kind === 'observed' ? ROUND_TRIP_OBSERVED_KEYS : ROUND_TRIP_THRESHOLD_KEYS;
    default:
      return EMPTY_CONDITION_RECORD_KEYS;
  }
}

const EMPTY_CONDITION_RECORD_KEYS = Object.freeze([] as string[]);
const HOLDER_OBSERVED_KEYS = Object.freeze(['top1HolderBps', 'top5HoldersBps', 'top10HoldersBps']);
const HOLDER_THRESHOLD_KEYS = Object.freeze(['maximumTop1Bps', 'maximumTop5Bps', 'maximumTop10Bps']);
const RELATED_OBSERVED_KEYS = Object.freeze(['maximumRelatedClusterBps']);
const RELATED_THRESHOLD_KEYS = Object.freeze(['maximumClusterBps']);
const SHARED_FUNDER_OBSERVED_KEYS = Object.freeze(['maximumSharedFunderCount']);
const SHARED_FUNDER_THRESHOLD_KEYS = Object.freeze(['minimumSharedFunders']);
const BUY_SIMULATION_OBSERVED_KEYS = Object.freeze(['buySimulationSucceeded']);
const SELL_QUOTE_OBSERVED_KEYS = Object.freeze(['sellQuoteAvailable']);
const ROUND_TRIP_OBSERVED_KEYS = Object.freeze(['roundTripLossBps']);
const ROUND_TRIP_THRESHOLD_KEYS = Object.freeze(['maximumRoundTripLossBps']);

function snapshotTrigger(trigger: DomainEvent): DomainEvent {
  assertValidChainCursor(trigger.cursor);
  assertValidNullableTimestampMs('blockchainTimeMs', trigger.blockchainTimeMs);
  assertValidTimestampMs('observedAtMs', trigger.observedAtMs);
  return freeze({
    ...trigger,
    cursor: freeze({ ...trigger.cursor }),
    payload: freeze({ ...trigger.payload }),
  });
}

function createPaperEvent(
  type: 'PaperPositionOpened',
  position: PaperPosition,
  trade: PaperTrade,
  trigger: DomainEvent,
): PaperPositionOpenedEventV1;
function createPaperEvent(
  type: 'PaperPositionClosed',
  position: PaperPosition,
  trade: PaperTrade,
  trigger: DomainEvent,
): PaperPositionClosedEventV1;
function createPaperEvent(
  type: 'PaperPositionOpened' | 'PaperPositionClosed',
  position: PaperPosition,
  trade: PaperTrade,
  trigger: DomainEvent,
): PaperPositionOpenedEventV1 | PaperPositionClosedEventV1 {
  return freeze({
    id: paperEventId(type, position.id, trade.id, trigger.id),
    type,
    mint: position.mint,
    source: 'paper-trading',
    program: trigger.program,
    signature: trigger.signature,
    cursor: trigger.cursor,
    confirmationStatus: trigger.confirmationStatus,
    blockchainTimeMs: trigger.blockchainTimeMs,
    observedAtMs: trigger.observedAtMs,
    payloadVersion: 1,
    payload: freeze({ position, trade }),
  });
}

function paperEventId(
  type: 'PaperPositionOpened' | 'PaperPositionClosed',
  positionId: string,
  tradeId: string,
  triggerId: string,
): string {
  return hashId('evt', [type, positionId, tradeId, triggerId]);
}

function hashId(namespace: string, parts: readonly (string | number)[]): string {
  return hashValue(namespace, parts);
}

function hashValue(namespace: string, value: unknown): string {
  return `${namespace}_${createHash('sha256')
    .update(namespace)
    .update('\u001f')
    .update(stringifyJson(value))
    .digest('hex')}`;
}

function invalidQuote(field: string): never {
  throw new PaperTradingError('QUOTE_INVALID', `Commande paper invalide: ${field}.`);
}

function conflict(): never {
  throw new PaperTradingError('POSITION_CONFLICT', 'Commande contradictoire pour la position paper.');
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) Object.freeze(value);
  return value;
}
