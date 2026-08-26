import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { AppConfig } from '../config/env.js';
import type { DomainEvent } from '../domain/events.js';
import { assertValidChainCursor } from '../domain/cursor.js';
import type {
  QualificationConditionEvidence,
  QualificationConditionPolicy,
  EffectiveQualificationProfile,
  QualificationReport,
  QualificationScore,
  QualificationSignalKey,
} from '../domain/qualification.js';
import {
  QUALIFICATION_CONDITION_MODES,
  QUALIFICATION_CONDITION_STATUSES,
} from '../domain/qualification.js';
import { QUALIFICATION_REASON_CODES } from '../domain/qualification-reasons.js';
import { assertValidEffectiveQualificationProfile } from '../qualification/qualification-profile.js';
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
import type { QualificationReportAuthority } from '../ports/qualification-report-authority.js';
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
    private readonly qualificationProfile: EffectiveQualificationProfile,
    private readonly qualificationReportAuthority: QualificationReportAuthority,
    private readonly clock: Clock = { now: Date.now },
  ) {
    if (!Number.isSafeInteger(config.dataRetentionHours) || config.dataRetentionHours <= 0) {
      throw new RangeError('dataRetentionHours doit être un entier positif sûr.');
    }
    assertValidEffectiveQualificationProfile(qualificationProfile);
  }

  public async open(command: OpenPaperPositionCommand): Promise<PaperPosition> {
    this.requirePaperMode();
    const qualification = command.qualification;
    const mint = command.mint;
    const trigger = snapshotTrigger(command.trigger);
    if (!this.qualificationReportAuthority.isAuthorized(qualification, {
      mint,
      triggerEventId: trigger.id,
    })) invalidQualification();
    const snapshot = snapshotOpenCommand(command, qualification, mint, trigger);
    validateOpenCommand(
      snapshot,
      this.config.paperQuoteMintAllowlist,
      this.qualificationProfile,
    );
    const roundTrip = calculateRoundTrip(snapshot.buyQuote, snapshot.reverseSellQuote);
    validateQualificationExecutionFacts(
      snapshot.qualification,
      roundTrip.lossBps,
      this.qualificationProfile,
    );
    if (roundTrip.lossBps > snapshot.maximumRoundTripLossBps) {
      roundTripLossExceeded(roundTrip.lossBps);
    }
    const positionId = hashId('paper_position', [
      snapshot.mint,
      snapshot.strategy.id,
      snapshot.strategy.version,
      snapshot.trigger.id,
    ]);
    const openCommandHashes = hashOpenCommand(snapshot);
    const openedAtMs = this.clock.now();
    assertValidTimestampMs('occurredAtMs', openedAtMs);

    return this.repository.transact(async (transaction) => {
      if(snapshot.expectedCurrentQualification!==undefined){
        await transaction.requireCurrentQualification(snapshot.expectedCurrentQualification);
      }
      const existing = await transaction.findPosition(positionId);
      if (existing !== null) {
        return this.reconcileOpenReplay(
          transaction,
          existing,
          openCommandHashes,
          snapshot.trigger,
          snapshot.entryDecisionAtMs ?? null,
          snapshot.entryDecisionJobId ?? null,
        );
      }
      const active = await transaction.findActivePosition(snapshot.mint, snapshot.strategy);
      if (active !== null) {
        if (active.id === positionId && matchesOpenCommandHash(active, openCommandHashes)) {
          return this.reconcileOpenReplay(
            transaction,
            active,
            openCommandHashes,
            snapshot.trigger,
            snapshot.entryDecisionAtMs ?? null,
            snapshot.entryDecisionJobId ?? null,
          );
        }
        conflict();
      }
      const terminalReplay = await transaction.findPosition(positionId);
      if (terminalReplay !== null) {
        return this.reconcileOpenReplay(
          transaction,
          terminalReplay,
          openCommandHashes,
          snapshot.trigger,
          snapshot.entryDecisionAtMs ?? null,
          snapshot.entryDecisionJobId ?? null,
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
        openCommandHash: openCommandHashes.current,
        closeCommandHash: null,
        triggerEventId: snapshot.trigger.id,
        entryDecisionAtMs: snapshot.entryDecisionAtMs ?? null,
        entryDecisionJobId: snapshot.entryDecisionJobId ?? null,
        closeEventId: null,
        exitTriggerAtMs: null,
        ...(snapshot.strategySessionId === undefined ? {} : {
          strategySessionId:snapshot.strategySessionId,
          qualificationReportId:snapshot.qualificationReportId,
          candidateId:snapshot.candidateId,
        }),
        openedAtMs,
        closedAtMs: null,
        purgeAfterMs: null,
        payloadVersion: 1,
      } satisfies PaperPosition);
      await transaction.insertOpened(
        position,
        trade,
        createPaperEvent('PaperPositionOpened', position, trade, snapshot.trigger),
        snapshot.entryDecisionAtMs ?? null,
        snapshot.entryDecisionJobId ?? null,
      );
      return position;
    });
  }

  public async reconcileOpen(command: OpenPaperPositionCommand): Promise<PaperPosition> {
    this.requirePaperMode();
    const snapshot = snapshotOpenCommand(
      command,command.qualification,command.mint,snapshotTrigger(command.trigger),
    );
    validateOpenCommand(
      snapshot,
      this.config.paperQuoteMintAllowlist,
      this.qualificationProfile,
    );
    const roundTrip = calculateRoundTrip(snapshot.buyQuote, snapshot.reverseSellQuote);
    validateQualificationExecutionFacts(
      snapshot.qualification,
      roundTrip.lossBps,
      this.qualificationProfile,
    );
    if (roundTrip.lossBps > snapshot.maximumRoundTripLossBps) {
      roundTripLossExceeded(roundTrip.lossBps);
    }
    const positionId = hashId('paper_position', [
      snapshot.mint,
      snapshot.strategy.id,
      snapshot.strategy.version,
      snapshot.trigger.id,
    ]);
    const openCommandHashes = hashOpenCommand(snapshot);
    return this.repository.transact(async (transaction) => {
      const existing = await transaction.findPosition(positionId);
      if (existing === null) {
        throw new PaperTradingError('POSITION_NOT_FOUND', 'Position paper introuvable.');
      }
      return this.reconcileOpenReplay(
        transaction,existing,openCommandHashes,snapshot.trigger,
        snapshot.entryDecisionAtMs ?? null,snapshot.entryDecisionJobId ?? null,
      );
    });
  }

  public async retract(positionId: string, triggerEvent: DomainEvent): Promise<PaperPosition> {
    this.requirePaperMode();
    const trigger = snapshotTrigger(triggerEvent);
    if (trigger.confirmationStatus !== 'orphaned') {
      throw new PaperTradingError(
        'TRIGGER_ORPHANED','La rétraction paper exige un événement orphaned.',
      );
    }
    return this.repository.transact(async (transaction) => {
      const current = await transaction.findPosition(positionId);
      if (current === null) {
        throw new PaperTradingError('POSITION_NOT_FOUND','Position paper introuvable.');
      }
      return this.retractPosition(transaction,current);
    });
  }

  public async close(command: ClosePaperPositionCommand): Promise<PaperPosition> {
    this.requirePaperMode();
    const snapshot = snapshotCloseCommand(command);
    validatePaperQuote(snapshot.sellQuote);
    const { exitTriggerAtMs:_exitTriggerAtMs,...stableSnapshot }=snapshot;
    void _exitTriggerAtMs;
    const closeCommandHash = hashValue('paper_close_command', {
      ...stableSnapshot,
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
        if (current.exitTriggerAtMs !== null
          && current.exitTriggerAtMs !== undefined
          && current.exitTriggerAtMs !== snapshot.exitTriggerAtMs) conflict();
        await transaction.reconcileEventConfirmation(
          current.closeEventId ?? paperEventId(
            'PaperPositionClosed',
            current.id,
            current.exitTradeId,
            snapshot.trigger.id,
          ),
          Object.freeze({
            ...snapshot.trigger,
            observedAtMs: current.exitTriggerAtMs ?? snapshot.trigger.observedAtMs,
          }),
        );
        if (snapshot.trigger.confirmationStatus === 'orphaned') {
          return this.retractPosition(transaction, current);
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
      const closeEventId = paperEventId(
        'PaperPositionClosed', current.id, trade.id, snapshot.trigger.id,
      );
      const position = freeze({
        ...current,
        status: 'PAPER_CLOSED',
        remainingBaseRaw: 0n,
        quoteProceedsRaw: snapshot.sellQuote.minimumAmountOutRaw,
        grossPnlQuoteRaw: snapshot.sellQuote.amountOutRaw - current.quoteCostRaw,
        netPnlQuoteRaw: snapshot.sellQuote.minimumAmountOutRaw - current.quoteCostRaw,
        exitTradeId: tradeId,
        closeCommandHash,
        closeEventId,
        exitTriggerAtMs: snapshot.exitTriggerAtMs ?? null,
        closedAtMs,
        purgeAfterMs: closedAtMs + retentionMs,
      } satisfies PaperPosition);
      await transaction.updateClosed(
        position,
        trade,
        createPaperEvent(
          'PaperPositionClosed', position, trade, snapshot.trigger,
          snapshot.exitTriggerAtMs ?? snapshot.trigger.observedAtMs,
        ),
        snapshot.exitTriggerAtMs ?? null,
      );
      return position;
    });
  }

  private async reconcileOpenReplay(
    transaction: PaperTradingTransaction,
    position: PaperPosition,
    openCommandHashes: OpenCommandHashes,
    trigger: DomainEvent,
    entryDecisionAtMs: number | null,
    entryDecisionJobId: string | null,
  ): Promise<PaperPosition> {
    if (!matchesOpenCommandHash(position, openCommandHashes)) conflict();
    if ((position.entryDecisionAtMs !== null && position.entryDecisionAtMs !== undefined)
      && (position.entryDecisionAtMs !== entryDecisionAtMs
        || position.entryDecisionJobId !== entryDecisionJobId)) conflict();
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
      return this.retractPosition(transaction, position);
    }
    return position;
  }

  private async retractPosition(
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

interface OpenCommandHashes {
  readonly current: string;
  readonly legacy: string;
}

function hashOpenCommand(command: OpenPaperPositionCommand): OpenCommandHashes {
  const {
    expectedCurrentQualification:_expectedCurrentQualification,
    entryDecisionAtMs:_entryDecisionAtMs,
    entryDecisionJobId:_entryDecisionJobId,
    ...stableCommand
  }=command;
  void _expectedCurrentQualification;
  void _entryDecisionAtMs;
  void _entryDecisionJobId;
  const current = {
    ...stableCommand,
    trigger: command.trigger.id,
  };
  return freeze({
    current: hashValue('paper_open_command', current),
    legacy: hashValue('paper_open_command', {
      ...current,
      qualification: legacyQualificationSnapshot(command.qualification),
    }),
  });
}

function legacyQualificationSnapshot(report: QualificationReport): unknown {
  // origin/main hashed the French evidence copy in rule declaration order.
  return {
    ruleSet: {
      id: report.ruleSet.id,
      version: report.ruleSet.version,
      status: report.ruleSet.status,
      minimumTotalScore: report.ruleSet.minimumTotalScore,
    },
    scores: report.scores,
    evidence: [...report.evidence].sort((left, right) => (
      legacyEvidenceIndex(left.signal) - legacyEvidenceIndex(right.signal)
    )).map((item) => ({
      ...item,
      message: LEGACY_QUALIFICATION_EVIDENCE_MESSAGES[item.signal] ?? item.message,
    })),
    blockers: report.blockers,
    verdict: report.verdict,
    evaluatedAtMs: report.evaluatedAtMs,
  };
}

function legacyEvidenceIndex(signal: QualificationSignalKey): number {
  const index = LEGACY_QUALIFICATION_EVIDENCE_ORDER.indexOf(signal);
  return index === -1 ? LEGACY_QUALIFICATION_EVIDENCE_ORDER.length : index;
}

const LEGACY_QUALIFICATION_EVIDENCE_MESSAGES: Readonly<Partial<Record<QualificationSignalKey, string>>> = Object.freeze({
  imageValid: 'Préparation visuelle du lancement valide.',
  socialCrossLinkConfirmed: 'Liens sociaux cohérents.',
  creatorHasNotSold: 'Aucune vente précoce du créateur.',
  reverseQuoteAvailable: 'Cotation inverse disponible.',
  externalBuyersObserved: 'Acheteurs externes observés.',
});

const LEGACY_QUALIFICATION_EVIDENCE_ORDER: readonly QualificationSignalKey[] = Object.freeze([
  'imageValid',
  'socialCrossLinkConfirmed',
  'creatorHasNotSold',
  'reverseQuoteAvailable',
  'externalBuyersObserved',
]);

function matchesOpenCommandHash(position: PaperPosition, hashes: OpenCommandHashes): boolean {
  return position.openCommandHash === hashes.current || position.openCommandHash === hashes.legacy;
}

function validateOpenCommand(
  command: OpenPaperPositionCommand,
  allowlist: readonly string[],
  qualificationProfile: EffectiveQualificationProfile,
): void {
  if (command.mint.trim() === '' || command.trigger.mint !== command.mint) invalidQuote('mint');
  if ((command.entryDecisionAtMs === undefined) !== (command.entryDecisionJobId === undefined)) {
    invalidQuote('entryDecision');
  }
  if (command.entryDecisionAtMs !== undefined) {
    assertValidTimestampMs('occurredAtMs', command.entryDecisionAtMs);
  }
  if (command.strategy.id.trim() === '' || !Number.isSafeInteger(command.strategy.version) || command.strategy.version <= 0) {
    invalidQuote('strategy');
  }
  const lineage = [command.strategySessionId,command.qualificationReportId,command.candidateId];
  if (
    lineage.some((value) => value !== undefined)
    && (lineage.some((value) => value === undefined)
      || lineage.some((value) => value?.trim() === ''))
  ) invalidQuote('paper lineage');
  if(
    command.strategySessionId!==undefined
    &&(
      command.expectedCurrentQualification?.mint!==command.mint
      ||command.expectedCurrentQualification.reportId!==command.qualificationReportId
      ||command.expectedCurrentQualification.qualificationEventId!==command.trigger.id
    )
  )invalidQuote('current qualification');
  validateQualificationReport(command.qualification, qualificationProfile);
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

function validateQualificationReport(
  report: QualificationReport,
  profile: EffectiveQualificationProfile,
): void {
  const reportStatus: unknown = report.ruleSet.status;
  if (
    report.ruleSet.id !== profile.id
    || report.ruleSet.version !== profile.version
    || reportStatus !== profile.status
    || report.ruleSet.fingerprint !== profile.fingerprint
    || report.ruleSet.minimumTotalScore !== profile.minimumTotalScore
  ) invalidQualification();
  if (report.conditions.length !== QUALIFICATION_REASON_CODES.length) invalidQualification();
  const policies = new Map(profile.conditionPolicies.map((policy) => [policy.code, policy]));
  const enforcedTriggers: string[] = [];
  for (let index = 0; index < QUALIFICATION_REASON_CODES.length; index += 1) {
    const condition = report.conditions[index];
    const policy = condition === undefined ? undefined : policies.get(condition.code);
    if (
      condition === undefined
      || condition.code !== QUALIFICATION_REASON_CODES[index]
      || policy === undefined
      || !QUALIFICATION_CONDITION_MODES.includes(condition.mode)
      || !QUALIFICATION_CONDITION_STATUSES.includes(condition.status)
      || (condition.mode === 'DISABLED') !== (condition.status === 'DISABLED')
      || condition.mode !== policy.mode
      || !matchesPolicyThresholds(condition, policy)
    ) invalidQualification();
    if (condition.mode === 'ENFORCED' && condition.status === 'TRIGGERED') {
      enforcedTriggers.push(condition.code);
    }
  }
  if (
    report.blockers.length !== enforcedTriggers.length
    || report.blockers.some((blocker, index) => blocker.code !== enforcedTriggers[index])
  ) invalidQualification();
  const verdict: unknown = report.verdict;
  if (
    (verdict !== 'QUALIFIED' && verdict !== 'WATCHLISTED' && verdict !== 'REJECTED')
    || (verdict === 'REJECTED') !== (enforcedTriggers.length > 0)
  ) invalidQualification();
}

function validateQualificationExecutionFacts(
  report: QualificationReport,
  roundTripLossBps: bigint,
  profile: EffectiveQualificationProfile,
): void {
  const conditions = new Map(report.conditions.map((condition) => [condition.code, condition]));
  const policies = new Map(profile.conditionPolicies.map((policy) => [policy.code, policy]));
  const buySimulation = conditions.get('BUY_SIMULATION_FAILED');
  const sellQuote = conditions.get('SELL_QUOTE_UNAVAILABLE');
  const roundTrip = conditions.get('ROUND_TRIP_LOSS_EXCEEDED');
  const buyPolicy = policies.get('BUY_SIMULATION_FAILED');
  const sellPolicy = policies.get('SELL_QUOTE_UNAVAILABLE');
  const roundTripPolicy = policies.get('ROUND_TRIP_LOSS_EXCEEDED');
  if (
    buyPolicy === undefined
    || sellPolicy === undefined
    || roundTripPolicy === undefined
  ) invalidQualification();
  if (buyPolicy.mode === 'ENFORCED' && buySimulation?.observed.buySimulationSucceeded !== true) {
    invalidQualification();
  }
  if (sellPolicy.mode === 'ENFORCED' && sellQuote?.observed.sellQuoteAvailable !== true) {
    invalidQualification();
  }
  if (roundTripPolicy.mode === 'ENFORCED') {
    if (roundTrip?.observed.roundTripLossBps !== roundTripLossBps) invalidQualification();
    const maximumRoundTripLossBps = roundTripPolicy.maximumRoundTripLossBps;
    if (maximumRoundTripLossBps === null) invalidQualification();
    if (roundTripLossBps > BigInt(maximumRoundTripLossBps)) {
      roundTripLossExceeded(roundTripLossBps);
    }
  }
}

function matchesPolicyThresholds(
  condition: QualificationConditionEvidence,
  policy: QualificationConditionPolicy,
): boolean {
  const expected = expectedPolicyThresholds(policy);
  const actualKeys = Object.keys(condition.thresholds);
  const expectedKeys = Object.keys(expected);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.is(condition.thresholds[key], expected[key]));
}

function expectedPolicyThresholds(
  policy: QualificationConditionPolicy,
): Readonly<Record<string, bigint | number | null>> {
  if (policy.mode === 'DISABLED') return EMPTY_CONDITION_THRESHOLDS;
  switch (policy.code) {
    case 'HOLDER_CONCENTRATION_EXCEEDED':
      return {
        maximumTop1Bps: nullableBigInt(policy.maximumTop1Bps),
        maximumTop5Bps: nullableBigInt(policy.maximumTop5Bps),
        maximumTop10Bps: nullableBigInt(policy.maximumTop10Bps),
      };
    case 'RELATED_WALLET_CLUSTER_EXCEEDED':
      return { maximumClusterBps: nullableBigInt(policy.maximumClusterBps) };
    case 'SHARED_FUNDER_CLUSTER':
      return { minimumSharedFunders: policy.minimumSharedFunders };
    case 'ROUND_TRIP_LOSS_EXCEEDED':
      return { maximumRoundTripLossBps: nullableBigInt(policy.maximumRoundTripLossBps) };
    default:
      return EMPTY_CONDITION_THRESHOLDS;
  }
}

function nullableBigInt(value: number | null): bigint | null {
  return value === null ? null : BigInt(value);
}

const EMPTY_CONDITION_THRESHOLDS: Readonly<Record<string, never>> = Object.freeze({});

function validateCloseCommand(
  command: ClosePaperPositionCommand,
  position: PaperPosition,
): void {
  rejectOrphanedTrigger(command.trigger);
  if (position.strategy.id === 'creation-entry-v1') {
    if (command.exitTriggerAtMs === undefined) invalidQuote('exitTriggerAtMs');
    assertValidTimestampMs('occurredAtMs', command.exitTriggerAtMs);
  }
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

function snapshotOpenCommand(
  command: OpenPaperPositionCommand,
  qualification: QualificationReport,
  mint: string,
  trigger: DomainEvent,
): OpenPaperPositionCommand {
  return freeze({
    mint,
    quoteAsset: freeze({
      mint: command.quoteAsset.mint,
      decimals: command.quoteAsset.decimals,
      tokenProgram: command.quoteAsset.tokenProgram,
    }),
    strategy: freeze({
      id: command.strategy.id,
      version: command.strategy.version,
    }),
    trigger,
    qualification: snapshotQualification(qualification),
    buyQuote: snapshotQuote(command.buyQuote),
    reverseSellQuote: snapshotQuote(command.reverseSellQuote),
    maximumRoundTripLossBps: command.maximumRoundTripLossBps,
    ...(command.entryDecisionAtMs === undefined ? {} : {
      entryDecisionAtMs: command.entryDecisionAtMs,
      entryDecisionJobId: command.entryDecisionJobId ?? '',
    }),
    ...(command.strategySessionId === undefined ? {} : {
      strategySessionId:command.strategySessionId,
      qualificationReportId:command.qualificationReportId,
      candidateId:command.candidateId,
      expectedCurrentQualification:freeze({
        mint:command.expectedCurrentQualification?.mint ?? '',
        reportId:command.expectedCurrentQualification?.reportId ?? '',
        qualificationEventId:command.expectedCurrentQualification?.qualificationEventId ?? '',
      }),
    }),
  });
}

function snapshotCloseCommand(command: ClosePaperPositionCommand): ClosePaperPositionCommand {
  return freeze({
    positionId: command.positionId,
    trigger: snapshotTrigger(command.trigger),
    sellQuote: snapshotQuote(command.sellQuote),
    reason: command.reason,
    ...(command.exitTriggerAtMs === undefined ? {} : {
      exitTriggerAtMs: command.exitTriggerAtMs,
    }),
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
  observedAtMs: number,
): PaperPositionClosedEventV1;
function createPaperEvent(
  type: 'PaperPositionOpened' | 'PaperPositionClosed',
  position: PaperPosition,
  trade: PaperTrade,
  trigger: DomainEvent,
  observedAtMs?: number,
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
    observedAtMs: observedAtMs ?? trigger.observedAtMs,
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

function invalidQualification(): never {
  throw new PaperTradingError(
    'QUALIFICATION_INVALID',
    'Rapport de qualification incohérent pour la commande paper.',
  );
}

function roundTripLossExceeded(lossBps: bigint): never {
  throw new PaperTradingError(
    'ROUND_TRIP_LOSS_EXCEEDED',
    `Perte aller-retour ${lossBps} bps supérieure au plafond.`,
  );
}

function conflict(): never {
  throw new PaperTradingError('POSITION_CONFLICT', 'Commande contradictoire pour la position paper.');
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) Object.freeze(value);
  return value;
}
