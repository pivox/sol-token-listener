import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  EffectiveQualificationProfile,
  QualificationEvaluationInput,
  QualificationReport,
} from '../src/domain/qualification.js';
import type {
  ClosePaperPositionCommand,
  OpenPaperPositionCommand,
  PaperExecutionQuote,
  PaperPosition,
  PaperPositionClosedEventV1,
  PaperPositionOpenedEventV1,
  PaperTrade,
} from '../src/domain/paper-trading.js';
import type {
  PaperTradingRepository,
  PaperTradingTransaction,
} from '../src/ports/paper-trading-repository.js';
import type { QualificationReportAuthority } from '../src/ports/qualification-report-authority.js';
import { PaperTradingEngine } from '../src/paper/paper-trading-engine.js';
import {
  createDefaultQualificationRuleSet,
  QualificationEngine,
} from '../src/qualification/qualification-engine.js';
import { parseQualificationProfile } from '../src/qualification/qualification-profile.js';
import { reconcileConfirmationStatus } from '../src/domain/confirmation-status.js';
import type { ChainConfirmationStatus } from '../src/domain/types.js';

// Golden captured by executing this file's exact open-command fixture with origin/main.
const LEGACY_OPEN_COMMAND_HASH = 'paper_open_command_553d5ff67f95f9b3779d79d66fabc2f19a019d43b33e45933ed69522d2568ab5';
const TEST_QUALIFICATION_PROFILE = createDefaultQualificationRuleSet(60);
const TEST_QUALIFICATION_AUTHORITY = new QualificationEngine(TEST_QUALIFICATION_PROFILE);
const OPEN_CALIBRATION_FACTS = Object.freeze({
  top1HolderBps: null,
  top5HoldersBps: null,
  top10HoldersBps: null,
  maximumRelatedClusterBps: null,
  maximumSharedFunderCount: null,
  buySimulationSucceeded: true,
  sellQuoteAvailable: true,
  roundTripLossBps: 1_100n,
  upstreamConditions: Object.freeze([]),
});

void test('refuse le mode observe sans écriture', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'observe');

  await assert.rejects(engine.open(openCommand()), hasCode('PAPER_MODE_DISABLED'));
  assert.equal(repository.writeCount, 0);
});

void test('ouvre avec le rapport exact produit par l’autorité et rejoue sans doublon', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const command = openCommand();

  const first = await engine.open(command);
  const replay = await engine.open(command);

  assert.equal(first.status, 'PAPER_HOLDING');
  assert.equal(first.baseFilledRaw, 90n);
  assert.equal(first.quoteCostRaw, 100n);
  assert.equal(first.roundTripLossBps, 1_100n);
  assert.equal(replay.id, first.id);
  assert.equal(repository.writeCount, 1);
  assert.deepEqual([...repository.eventStatuses.values()], ['confirmed']);
});

void test('rejoue la même commande après montée de finalité sans conflit', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const command = openCommand();

  const first = await engine.open(command);
  const replay = await engine.open({
    ...command,
    trigger: {
      ...command.trigger,
      confirmationStatus: 'finalized',
      observedAtMs: 2,
    },
  });

  assert.equal(replay.id, first.id);
  assert.equal(repository.writeCount, 1);
  assert.deepEqual([...repository.eventStatuses.values()], ['finalized']);
});

void test('rejoue une ouverture identique devenue visible après le verrou', async () => {
  const seedRepository = new MemoryPaperRepository();
  const command = openCommand();
  const existing = await makeEngine(seedRepository, 'paper').open(command);
  const concurrentRepository = new ConcurrentReplayRepository(existing);

  const replay = await makeEngine(concurrentRepository, 'paper').open(command);

  assert.equal(replay.id, existing.id);
  assert.equal(concurrentRepository.writeCount, 0);
});

void test('rejoue une position déjà terminale devenue visible après le verrou', async () => {
  const seedRepository = new MemoryPaperRepository();
  const command = openCommand();
  const opened = await makeEngine(seedRepository, 'paper').open(command);
  const terminal = await makeEngine(seedRepository, 'paper').close(
    closeCommand(opened.id),
  );
  const concurrentRepository = new TerminalReplayRepository(terminal);

  const replay = await makeEngine(concurrentRepository, 'paper').open(command);

  assert.equal(replay.id, terminal.id);
  assert.equal(replay.status, 'PAPER_CLOSED');
  assert.equal(concurrentRepository.writeCount, 0);
});

void test('refuse une qualification non acceptée', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand(TEST_QUALIFICATION_AUTHORITY, {
    signals: {
      imageValid: false,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
    },
  });

  await assert.rejects(
    makeEngine(repository, 'paper').open(command),
    hasCode('QUALIFICATION_NOT_ACCEPTED'),
  );
  assert.equal(repository.writeCount, 0);
});

void test('refuse une qualification cohérente mais bloquée', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand(TEST_QUALIFICATION_AUTHORITY, {
    blockers: ['CREATOR_EARLY_SELL'],
  });

  await assert.rejects(
    makeEngine(repository, 'paper').open(command),
    hasCode('QUALIFICATION_BLOCKED'),
  );
  assert.equal(repository.writeCount, 0);
});

void test('rejects incomplete, duplicate, reordered, and invalid qualification conditions', async () => {
  const command = openCommand();
  const conditions = command.qualification.conditions;
  const [firstCondition, secondCondition] = conditions;
  if (firstCondition === undefined || secondCondition === undefined) throw new Error('Qualification fixture is incomplete.');
  const candidates: readonly (typeof conditions)[] = [
    conditions.slice(1),
    [...conditions.slice(0, -1), firstCondition],
    [secondCondition, firstCondition, ...conditions.slice(2)],
    conditions.map((item, index) => index === 0 ? { ...item, code: 'NOT_A_REASON' } : item) as unknown as typeof conditions,
    conditions.map((item, index) => index === 0 ? { ...item, mode: 'INVALID' } : item) as unknown as typeof conditions,
    conditions.map((item, index) => index === 0 ? { ...item, status: 'INVALID' } : item) as unknown as typeof conditions,
    conditions.map((item, index) => index === 0 ? { ...item, status: 'DISABLED' } : item),
  ];

  for (const invalidConditions of candidates) {
    const repository = new MemoryPaperRepository();
    const qualification = { ...command.qualification, conditions: invalidConditions };
    await assert.rejects(makeEngine(
      repository,
      'paper',
      TEST_QUALIFICATION_PROFILE,
      exactReportsAuthority(qualification),
    ).open({
      ...command,
      qualification,
    }), hasCode('QUALIFICATION_INVALID'));
    assert.equal(repository.writeCount, 0);
  }
});

void test('rejects qualification condition, blocker, and verdict inconsistencies before writing', async () => {
  const command = openCommand();
  const triggeredConditions = command.qualification.conditions.map((item) => item.code === 'CREATOR_EARLY_SELL'
    ? { ...item, status: 'TRIGGERED' as const }
    : item);
  const blocker = { code: 'CREATOR_EARLY_SELL' as const, message: 'Condition éliminatoire active.' };
  const candidates = [
    { ...command.qualification, conditions: triggeredConditions },
    { ...command.qualification, blockers: [blocker], verdict: 'REJECTED' as const },
    { ...command.qualification, conditions: triggeredConditions, verdict: 'REJECTED' as const },
    { ...command.qualification, conditions: triggeredConditions, blockers: [blocker] },
  ];

  for (const qualification of candidates) {
    const repository = new MemoryPaperRepository();
    await assert.rejects(makeEngine(
      repository,
      'paper',
      TEST_QUALIFICATION_PROFILE,
      exactReportsAuthority(qualification),
    ).open({
      ...command,
      qualification,
    }), hasCode('QUALIFICATION_INVALID'));
    assert.equal(repository.writeCount, 0);
  }
});

void test('accepts a coherent triggered report-only condition without inventing a blocker', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand(TEST_QUALIFICATION_AUTHORITY, {
    blockers: ['MINT_SOCIAL_MISMATCH'],
  });
  const position = await makeEngine(repository, 'paper').open(command);

  assert.equal(position.status, 'PAPER_HOLDING');
  assert.equal(repository.writeCount, 1);
});

void test('rejects an identical cloned qualification report before writing', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand();

  await assert.rejects(makeEngine(repository, 'paper').open({
    ...command,
    qualification: structuredClone(command.qualification),
  }), hasCode('QUALIFICATION_INVALID'));
  assert.equal(repository.writeCount, 0);
});

void test('rejects an authorized report reused for another mint or trigger before writing', async () => {
  const command = openCommand();
  const candidates: readonly OpenPaperPositionCommand[] = [
    {
      ...command,
      mint: 'OTHER_MINT',
      trigger: { ...command.trigger, mint: 'OTHER_MINT' },
      buyQuote: { ...command.buyQuote, outputMint: 'OTHER_MINT' },
      reverseSellQuote: { ...command.reverseSellQuote, inputMint: 'OTHER_MINT' },
    },
    {
      ...command,
      trigger: { ...command.trigger, id: 'trigger:other' },
    },
  ];

  for (const candidate of candidates) {
    const repository = new MemoryPaperRepository();
    await assert.rejects(
      makeEngine(repository, 'paper').open(candidate),
      hasCode('QUALIFICATION_INVALID'),
    );
    assert.equal(repository.writeCount, 0);
  }
});

void test('rejects quotes whose recomputed loss differs from the authorized report', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand();

  await assert.rejects(makeEngine(repository, 'paper').open({
    ...command,
    reverseSellQuote: { ...command.reverseSellQuote, minimumAmountOutRaw: 88n },
    maximumRoundTripLossBps: 2_000n,
  }), hasCode('QUALIFICATION_INVALID'));
  assert.equal(repository.writeCount, 0);
});

void test('requires successful buy simulation and an available reverse quote', async () => {
  const command = openCommand();
  const cases = [
    ['BUY_SIMULATION_FAILED', 'buySimulationSucceeded'],
    ['SELL_QUOTE_UNAVAILABLE', 'sellQuoteAvailable'],
  ] as const;

  for (const [code, observedKey] of cases) {
    const repository = new MemoryPaperRepository();
    const qualification = {
      ...command.qualification,
      conditions: command.qualification.conditions.map((item) => item.code === code
        ? { ...item, observed: { [observedKey]: false } }
        : item),
    };
    const engine = makeEngine(
      repository,
      'paper',
      TEST_QUALIFICATION_PROFILE,
      exactReportsAuthority(qualification),
    );

    await assert.rejects(engine.open({ ...command, qualification }), hasCode('QUALIFICATION_INVALID'));
    assert.equal(repository.writeCount, 0);
  }
});

void test('enforces the trusted profile round-trip ceiling independently of the command', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand();
  const qualification = {
    ...command.qualification,
    conditions: command.qualification.conditions.map((item) => {
      switch (item.code) {
        case 'BUY_SIMULATION_FAILED':
          return { ...item, status: 'PASSED' as const, observed: { buySimulationSucceeded: true } };
        case 'SELL_QUOTE_UNAVAILABLE':
          return { ...item, status: 'PASSED' as const, observed: { sellQuoteAvailable: true } };
        case 'ROUND_TRIP_LOSS_EXCEEDED':
          return { ...item, status: 'PASSED' as const, observed: { roundTripLossBps: 3_100n } };
        default:
          return item;
      }
    }),
  };
  const engine = makeEngine(
    repository,
    'paper',
    TEST_QUALIFICATION_PROFILE,
    exactReportsAuthority(qualification),
  );

  await assert.rejects(engine.open({
    ...command,
    qualification,
    reverseSellQuote: { ...command.reverseSellQuote, minimumAmountOutRaw: 69n },
    maximumRoundTripLossBps: 4_000n,
  }), hasCode('ROUND_TRIP_LOSS_EXCEEDED'));
  assert.equal(repository.writeCount, 0);
});

void test('does not turn report-only execution policies into paper blockers', async () => {
  const repository = new MemoryPaperRepository();
  const profile = reportOnlyExecutionProfile();
  const authority = new QualificationEngine(profile);
  const command = openCommand(authority, {
    calibrationFacts: Object.freeze({
      ...OPEN_CALIBRATION_FACTS,
      buySimulationSucceeded: false,
      sellQuoteAvailable: false,
      roundTripLossBps: 3_100n,
    }),
  });
  const engine = makeEngine(repository, 'paper', profile, authority);

  const position = await engine.open({
    ...command,
    reverseSellQuote: { ...command.reverseSellQuote, minimumAmountOutRaw: 69n },
    maximumRoundTripLossBps: 4_000n,
  });

  assert.equal(position.status, 'PAPER_HOLDING');
  assert.equal(repository.writeCount, 1);
});

void test('rejects a cloned coherent rejected report before writing', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand(TEST_QUALIFICATION_AUTHORITY, {
    blockers: ['CREATOR_EARLY_SELL'],
  });

  await assert.rejects(makeEngine(repository, 'paper').open({
    ...command,
    qualification: structuredClone(command.qualification),
  }), hasCode('QUALIFICATION_INVALID'));
  assert.equal(repository.writeCount, 0);
});

void test('rejects a verdict-only watchlisted clone before writing', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand();

  await assert.rejects(makeEngine(repository, 'paper').open({
    ...command,
    qualification: { ...command.qualification, verdict: 'WATCHLISTED' },
  }), hasCode('QUALIFICATION_INVALID'));
  assert.equal(repository.writeCount, 0);
});

void test('rejects evidence and score clones before writing', async () => {
  const command = openCommand();
  const candidates = [
    {
      ...command.qualification,
      evidence: command.qualification.evidence.map((item, index) => index === 0
        ? { ...item, message: 'Forged evidence.' }
        : item),
    },
    {
      ...command.qualification,
      scores: {
        ...command.qualification.scores,
        total: { ...command.qualification.scores.total, score: 100 },
      },
    },
  ];

  for (const qualification of candidates) {
    const repository = new MemoryPaperRepository();
    await assert.rejects(makeEngine(repository, 'paper').open({
      ...command,
      qualification,
    }), hasCode('QUALIFICATION_INVALID'));
    assert.equal(repository.writeCount, 0);
  }
});

void test('rejects an enforced condition downgraded to report-only before writing', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand();
  const qualification = {
    ...command.qualification,
    conditions: command.qualification.conditions.map((item) => item.code === 'CREATOR_EARLY_SELL'
      ? { ...item, mode: 'REPORT_ONLY' as const, status: 'TRIGGERED' as const }
      : item),
  };

  await assert.rejects(makeEngine(
    repository,
    'paper',
    TEST_QUALIFICATION_PROFILE,
    exactReportsAuthority(qualification),
  ).open({
    ...command,
    qualification,
  }), hasCode('QUALIFICATION_INVALID'));
  assert.equal(repository.writeCount, 0);
});

void test('rejects a report from a different effective profile before writing', async () => {
  const repository = new MemoryPaperRepository();
  const foreignProfile = createDefaultQualificationRuleSet(59);
  const foreignAuthority = new QualificationEngine(foreignProfile);

  await assert.rejects(
    makeEngine(
      repository,
      'paper',
      TEST_QUALIFICATION_PROFILE,
      foreignAuthority,
    ).open(openCommand(foreignAuthority)),
    hasCode('QUALIFICATION_INVALID'),
  );
  assert.equal(repository.writeCount, 0);
});

void test('rejects condition thresholds that differ from the trusted profile before writing', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand();
  const qualification = {
    ...command.qualification,
    conditions: command.qualification.conditions.map((item) => item.code === 'ROUND_TRIP_LOSS_EXCEEDED'
      ? { ...item, thresholds: { maximumRoundTripLossBps: 2_999n } }
      : item),
  };

  await assert.rejects(makeEngine(
    repository,
    'paper',
    TEST_QUALIFICATION_PROFILE,
    exactReportsAuthority(qualification),
  ).open({
    ...command,
    qualification,
  }), hasCode('QUALIFICATION_INVALID'));
  assert.equal(repository.writeCount, 0);
});

void test('refuse un quote mint hors allowlist SOL initiale', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand();

  await assert.rejects(
    makeEngine(repository, 'paper').open({
      ...command,
      quoteAsset: { ...command.quoteAsset, mint: 'USDC' },
    }),
    hasCode('QUOTE_MINT_NOT_ALLOWED'),
  );
  assert.equal(repository.writeCount, 0);
});

void test('refuse une perte aller-retour au-dessus du plafond', async () => {
  const repository = new MemoryPaperRepository();

  await assert.rejects(
    makeEngine(repository, 'paper').open({
      ...openCommand(),
      maximumRoundTripLossBps: 1_099n,
    }),
    hasCode('ROUND_TRIP_LOSS_EXCEEDED'),
  );
  assert.equal(repository.writeCount, 0);
});

void test('refuse un événement déclencheur orphaned', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand();
  await assert.rejects(
    makeEngine(repository, 'paper').open({
      ...command,
      trigger: { ...command.trigger, confirmationStatus: 'orphaned' },
    }),
    hasCode('TRIGGER_ORPHANED'),
  );
  assert.equal(repository.writeCount, 0);
});

void test('refuse un curseur ou temps déclencheur non canonique', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand();

  await assert.rejects(
    makeEngine(repository, 'paper').open({
      ...command,
      trigger: { ...command.trigger, observedAtMs: -1 },
    }),
    /Invalid observedAtMs timestamp/u,
  );
  await assert.rejects(
    makeEngine(repository, 'paper').open({
      ...command,
      trigger: {
        ...command.trigger,
        cursor: { ...command.trigger.cursor, instructionIndex: -1 },
      },
    }),
    /Invalid chain cursor instructionIndex/u,
  );
  assert.equal(repository.writeCount, 0);
});

void test('rétracte une position si son déclencheur devient orphaned', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const command = openCommand();
  await engine.open(command);

  const retracted = await engine.open({
    ...command,
    trigger: { ...command.trigger, confirmationStatus: 'orphaned' },
  });

  assert.equal(retracted.status, 'PAPER_RETRACTED');
  assert.equal(retracted.purgeAfterMs, 14_401_000);
  assert.equal(
    [...repository.positions.values()].some((position) => (
      position.status === 'PAPER_HOLDING'
    )),
    false,
  );
  assert.deepEqual([...repository.eventStatuses.values()], ['orphaned']);
});

void test('refuse un replay d’ouverture contradictoire sans second trade', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const command = openCommand();
  await engine.open(command);

  await assert.rejects(
    engine.open({
      ...command,
      buyQuote: { ...command.buyQuote, feesRaw: 2n },
    }),
    hasCode('POSITION_CONFLICT'),
  );
  assert.equal(repository.writeCount, 1);
});

void test('replays only the exact origin-main open-command hash for a pre-calibration position', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const command = openCommand();
  const current = await engine.open(command);
  const legacy = Object.freeze({ ...current, openCommandHash: LEGACY_OPEN_COMMAND_HASH });
  repository.positions.set(current.id, legacy);

  const replay = await engine.open(command);

  assert.equal(replay.openCommandHash, LEGACY_OPEN_COMMAND_HASH);
  assert.equal(repository.writeCount, 1);
  await assert.rejects(engine.open({
    ...command,
    buyQuote: { ...command.buyQuote, feesRaw: 2n },
  }), hasCode('POSITION_CONFLICT'));
  await assert.rejects(engine.open({
    ...command,
    qualification: {
      ...command.qualification,
      ruleSet: {
        ...command.qualification.ruleSet,
        minimumTotalScore: command.qualification.ruleSet.minimumTotalScore + 1,
      },
    },
  }), hasCode('QUALIFICATION_INVALID'));
  assert.equal(repository.writeCount, 1);
});

void test('binds the profile fingerprint and calibrated condition evidence into open idempotency', async () => {
  const fingerprintRepository = new MemoryPaperRepository();
  const fingerprintCommand = openCommand();
  const fingerprintQualification = {
    ...fingerprintCommand.qualification,
    ruleSet: { ...fingerprintCommand.qualification.ruleSet, fingerprint: 'b'.repeat(64) },
  };
  const fingerprintEngine = makeEngine(
    fingerprintRepository,
    'paper',
    TEST_QUALIFICATION_PROFILE,
    exactReportsAuthority(fingerprintCommand.qualification, fingerprintQualification),
  );
  await fingerprintEngine.open(fingerprintCommand);
  await assert.rejects(fingerprintEngine.open({
    ...fingerprintCommand,
    qualification: fingerprintQualification,
  }), hasCode('QUALIFICATION_INVALID'));

  const conditionRepository = new MemoryPaperRepository();
  const conditionCommand = openCommand();
  const conditions = conditionCommand.qualification.conditions;
  const conflictingQualification = {
    ...conditionCommand.qualification,
    conditions: conditions.map((item) => item.code === 'HOLDER_CONCENTRATION_EXCEEDED'
      ? { ...item, observed: { ...item.observed, top1HolderBps: 1n } }
      : item),
  };
  const conditionEngine = makeEngine(
    conditionRepository,
    'paper',
    TEST_QUALIFICATION_PROFILE,
    exactReportsAuthority(conditionCommand.qualification, conflictingQualification),
  );
  await conditionEngine.open(conditionCommand);
  await assert.rejects(conditionEngine.open({
    ...conditionCommand,
    qualification: conflictingQualification,
  }), hasCode('POSITION_CONFLICT'));
  assert.equal(fingerprintRepository.writeCount, 1);
  assert.equal(conditionRepository.writeCount, 1);
});

void test('rejects reconstructed calibrated condition maps with a different key order', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const command = openCommand();
  const first = await engine.open(command);
  await assert.rejects(engine.open({
    ...command,
    qualification: {
      ...command.qualification,
      conditions: command.qualification.conditions.map((item) => item.code === 'HOLDER_CONCENTRATION_EXCEEDED'
        ? {
          ...item,
          observed: reverseRecord(item.observed),
          thresholds: reverseRecord(item.thresholds),
        }
        : item),
    },
  }), hasCode('QUALIFICATION_INVALID'));

  assert.equal(first.status, 'PAPER_HOLDING');
  assert.equal(repository.writeCount, 1);
});

void test('preserves the historical calibrated qualification command hash', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const command = openCommand();
  const first = await engine.open(command);

  assert.equal(
    first.openCommandHash,
    'paper_open_command_5fc05d1b9538825fdb6173fc08330eabc2d71800d666236e87e64ea678504d77',
  );
  assert.notEqual(first.openCommandHash, LEGACY_OPEN_COMMAND_HASH);
  const replay = await engine.open(command);
  assert.equal(replay.id, first.id);
});

void test('rejects invalid numeric calibrated condition values instead of replaying null', async () => {
  for (const value of [NaN, Infinity, -Infinity, 1.5, -0]) {
    const observedRepository = new MemoryPaperRepository();
    const observedCommand = openCommand();
    const invalidObservedCommand = withHolderConditionValue(observedCommand, 'observed', value);
    const observedEngine = makeEngine(
      observedRepository,
      'paper',
      TEST_QUALIFICATION_PROFILE,
      exactReportsAuthority(
        observedCommand.qualification,
        invalidObservedCommand.qualification,
      ),
    );
    await observedEngine.open(observedCommand);
    await assert.rejects(
      observedEngine.open(invalidObservedCommand),
      /Qualification condition records must contain enumerable data values/u,
    );
    assert.equal(observedRepository.writeCount, 1);

    const thresholdRepository = new MemoryPaperRepository();
    const thresholdCommand = openCommand();
    const invalidThresholdCommand = withHolderConditionValue(thresholdCommand, 'thresholds', value);
    const thresholdEngine = makeEngine(
      thresholdRepository,
      'paper',
      TEST_QUALIFICATION_PROFILE,
      exactReportsAuthority(
        thresholdCommand.qualification,
        invalidThresholdCommand.qualification,
      ),
    );
    await thresholdEngine.open(thresholdCommand);
    await assert.rejects(
      thresholdEngine.open(invalidThresholdCommand),
      /Qualification condition records must contain enumerable data values/u,
    );
    assert.equal(thresholdRepository.writeCount, 1);
  }
});

void test('rejects cross-type and out-of-range calibrated condition fields', async () => {
  const cases = [
    ['HOLDER_CONCENTRATION_EXCEEDED', 'observed', 'top1HolderBps', 1],
    ['HOLDER_CONCENTRATION_EXCEEDED', 'observed', 'top1HolderBps', true],
    ['SHARED_FUNDER_CLUSTER', 'observed', 'maximumSharedFunderCount', 1n],
    ['SHARED_FUNDER_CLUSTER', 'observed', 'maximumSharedFunderCount', -1],
    ['SHARED_FUNDER_CLUSTER', 'thresholds', 'minimumSharedFunders', 10_001],
    ['BUY_SIMULATION_FAILED', 'observed', 'buySimulationSucceeded', 1],
    ['ROUND_TRIP_LOSS_EXCEEDED', 'observed', 'roundTripLossBps', 1],
  ] as const;
  for (const [code, record, key, value] of cases) {
    const repository = new MemoryPaperRepository();
    const command = openCommand();
    const invalidCommand = withConditionValue(command, code, record, key, value);
    const engine = makeEngine(
      repository,
      'paper',
      TEST_QUALIFICATION_PROFILE,
      exactReportsAuthority(command.qualification, invalidCommand.qualification),
    );
    await engine.open(command);
    await assert.rejects(
      engine.open(invalidCommand),
      /Qualification condition records must contain enumerable data values/u,
    );
    assert.equal(repository.writeCount, 1);
  }
});

void test('ferme entièrement et calcule le PnL conservateur', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const opened = await engine.open(openCommand());

  const closed = await engine.close(closeCommand(opened.id));
  const replay = await engine.close(closeCommand(opened.id));

  assert.equal(closed.status, 'PAPER_CLOSED');
  assert.equal(closed.remainingBaseRaw, 0n);
  assert.equal(closed.quoteProceedsRaw, 115n);
  assert.equal(closed.grossPnlQuoteRaw, 20n);
  assert.equal(closed.netPnlQuoteRaw, 15n);
  assert.equal(closed.purgeAfterMs, 14_401_000);
  assert.equal(replay.id, closed.id);
  assert.equal(repository.writeCount, 2);
});

void test('refuse un replay de fermeture contradictoire sans second trade', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const opened = await engine.open(openCommand());
  await engine.close(closeCommand(opened.id));

  await assert.rejects(
    engine.close({
      ...closeCommand(opened.id),
      reason: 'CREATOR_EARLY_SELL',
    }),
    hasCode('POSITION_CONFLICT'),
  );
  assert.equal(repository.writeCount, 2);
});

void test('rétracte une clôture si son déclencheur devient orphaned', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const opened = await engine.open(openCommand());
  const command = closeCommand(opened.id);
  await engine.close(command);

  const retracted = await engine.close({
    ...command,
    trigger: { ...command.trigger, confirmationStatus: 'orphaned' },
  });

  assert.equal(retracted.status, 'PAPER_RETRACTED');
  assert.equal(repository.writeCount, 3);
  assert.deepEqual(
    [...repository.eventStatuses.values()],
    ['confirmed', 'orphaned'],
  );
});

function makeEngine(
  repository: PaperTradingRepository,
  executionMode: 'observe' | 'paper',
  profile: EffectiveQualificationProfile = TEST_QUALIFICATION_PROFILE,
  authority: QualificationReportAuthority = TEST_QUALIFICATION_AUTHORITY,
): PaperTradingEngine {
  return new PaperTradingEngine(
    {
      executionMode,
      paperQuoteMintAllowlist: ['SOL'],
      dataRetentionHours: 4,
    },
    repository,
    profile,
    authority,
    { now: () => 1_000 },
  );
}

function openCommand(
  authority: QualificationEngine = TEST_QUALIFICATION_AUTHORITY,
  input: Partial<QualificationEvaluationInput> = {},
): OpenPaperPositionCommand {
  const triggerEvent = trigger('QualificationUpdated');
  const qualification = authority.evaluateAuthorized({
    mint: 'MINT',
    triggerEventId: triggerEvent.id,
  }, {
    evaluatedAtMs: input.evaluatedAtMs ?? 1,
    signals: input.signals ?? {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
    },
    blockers: input.blockers ?? [],
    calibrationFacts: input.calibrationFacts ?? OPEN_CALIBRATION_FACTS,
  });
  return {
    mint: 'MINT',
    quoteAsset: { mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' },
    strategy: { id: 'momentum-controlled', version: 1 },
    trigger: triggerEvent,
    qualification,
    buyQuote: quote('buy', 'SOL', 'MINT', 100n, 95n, 90n),
    reverseSellQuote: quote('reverse', 'MINT', 'SOL', 90n, 91n, 89n),
    maximumRoundTripLossBps: 1_100n,
  };
}

function exactReportsAuthority(
  ...reports: readonly QualificationReport[]
): QualificationReportAuthority {
  const authorized = new WeakSet<QualificationReport>(reports);
  return Object.freeze({
    isAuthorized: (candidate: unknown): candidate is QualificationReport => (
      typeof candidate === 'object'
      && candidate !== null
      && authorized.has(candidate as QualificationReport)
    ),
  });
}

function reportOnlyExecutionProfile(): EffectiveQualificationProfile {
  const raw = JSON.parse(readFileSync(
    new URL('../config/qualification/pumpfun-v1-unvalidated.json', import.meta.url),
    'utf8',
  )) as { conditionPolicies: Record<string, unknown>[] };
  const executionCodes = new Set([
    'BUY_SIMULATION_FAILED',
    'SELL_QUOTE_UNAVAILABLE',
    'ROUND_TRIP_LOSS_EXCEEDED',
  ]);
  raw.conditionPolicies = raw.conditionPolicies.map((policy) => ({
    ...policy,
    ...(executionCodes.has(String(policy.code)) ? { mode: 'REPORT_ONLY' } : {}),
  }));
  return parseQualificationProfile(deepFreeze(raw), null);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function closeCommand(positionId: string): ClosePaperPositionCommand {
  return {
    positionId,
    trigger: trigger('BondingCurveTradeObserved'),
    sellQuote: quote('sell', 'MINT', 'SOL', 90n, 120n, 115n),
    reason: 'MAX_HOLD_DURATION',
  };
}

function trigger(type: 'QualificationUpdated' | 'BondingCurveTradeObserved') {
  return {
    id: `trigger:${type}`,
    type,
    mint: 'MINT',
    source: 'pumpfun',
    program: 'pump-program',
    signature: 'signature',
    cursor: {
      slot: 1n,
      transactionIndex: 0,
      instructionIndex: 0,
      innerInstructionIndex: null,
    },
    confirmationStatus: 'confirmed' as const,
    blockchainTimeMs: 1,
    observedAtMs: 1,
    payloadVersion: 1,
    payload: {},
  };
}

function quote(
  id: string,
  inputMint: string,
  outputMint: string,
  amountInRaw: bigint,
  amountOutRaw: bigint,
  minimumAmountOutRaw: bigint,
): PaperExecutionQuote {
  return {
    id,
    inputMint,
    outputMint,
    amountInRaw,
    amountOutRaw,
    minimumAmountOutRaw,
    feesRaw: 1n,
    slippageBps: 100n,
    priceImpactBps: 50n,
    observedAtMs: 1,
    observedSlot: 1n,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code
  );
}

function reverseRecord<T extends bigint | number | boolean | null>(
  record: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).reverse()) as Record<string, T>;
}

function withHolderConditionValue(
  command: OpenPaperPositionCommand,
  record: 'observed' | 'thresholds',
  value: number,
): OpenPaperPositionCommand {
  return {
    ...command,
    qualification: {
      ...command.qualification,
      conditions: command.qualification.conditions.map((item) => {
        if (item.code !== 'HOLDER_CONCENTRATION_EXCEEDED') return item;
        return record === 'observed'
          ? { ...item, observed: { ...item.observed, top1HolderBps: value } }
          : { ...item, thresholds: { ...item.thresholds, maximumTop1Bps: value } };
      }),
    },
  };
}

function withConditionValue(
  command: OpenPaperPositionCommand,
  code: OpenPaperPositionCommand['qualification']['conditions'][number]['code'],
  record: 'observed' | 'thresholds',
  key: string,
  value: unknown,
): OpenPaperPositionCommand {
  return {
    ...command,
    qualification: {
      ...command.qualification,
      conditions: command.qualification.conditions.map((item) => {
        if (item.code !== code) return item;
        return record === 'observed'
          ? { ...item, observed: { ...item.observed, [key]: value } as typeof item.observed }
          : { ...item, thresholds: { ...item.thresholds, [key]: value } as typeof item.thresholds };
      }),
    },
  };
}

class MemoryPaperRepository implements PaperTradingRepository {
  public readonly positions = new Map<string, PaperPosition>();
  public readonly eventStatuses = new Map<string, ChainConfirmationStatus>();
  public writeCount = 0;

  public async transact<T>(
    operation: (transaction: PaperTradingTransaction) => Promise<T>,
  ): Promise<T> {
    return operation({
      findPosition: async (id) => this.positions.get(id) ?? null,
      findActivePosition: async (mint, strategy) => (
        [...this.positions.values()].find((position) => (
          position.mint === mint
          && position.strategy.id === strategy.id
          && position.strategy.version === strategy.version
          && position.status === 'PAPER_HOLDING'
        )) ?? null
      ),
      insertOpened: async (
        position: PaperPosition,
        _trade: PaperTrade,
        event: PaperPositionOpenedEventV1,
      ) => {
        this.positions.set(position.id, position);
        this.eventStatuses.set(event.id, event.confirmationStatus);
        this.writeCount += 1;
      },
      updateClosed: async (
        position: PaperPosition,
        _trade: PaperTrade,
        event: PaperPositionClosedEventV1,
      ) => {
        this.positions.set(position.id, position);
        this.eventStatuses.set(event.id, event.confirmationStatus);
        this.writeCount += 1;
      },
      reconcileEventConfirmation: async (eventId, trigger) => {
        const current = this.eventStatuses.get(eventId);
        if (current === undefined) throw new Error('paper event missing');
        if (reconcileConfirmationStatus(current, trigger.confirmationStatus) === 'update') {
          this.eventStatuses.set(eventId, trigger.confirmationStatus);
        }
      },
      retractPosition: async (position) => {
        this.positions.set(position.id, position);
        this.writeCount += 1;
      },
    });
  }
}

class ConcurrentReplayRepository implements PaperTradingRepository {
  public writeCount = 0;

  public constructor(private readonly active: PaperPosition) {}

  public async transact<T>(
    operation: (transaction: PaperTradingTransaction) => Promise<T>,
  ): Promise<T> {
    return operation({
      findPosition: async () => null,
      findActivePosition: async () => this.active,
      insertOpened: async () => {
        this.writeCount += 1;
      },
      updateClosed: async () => {
        this.writeCount += 1;
      },
      reconcileEventConfirmation: async () => undefined,
      retractPosition: async () => {
        this.writeCount += 1;
      },
    });
  }
}

class TerminalReplayRepository implements PaperTradingRepository {
  public writeCount = 0;
  private positionReadCount = 0;

  public constructor(private readonly terminal: PaperPosition) {}

  public async transact<T>(
    operation: (transaction: PaperTradingTransaction) => Promise<T>,
  ): Promise<T> {
    return operation({
      findPosition: async () => {
        this.positionReadCount += 1;
        return this.positionReadCount === 1 ? null : this.terminal;
      },
      findActivePosition: async () => null,
      insertOpened: async () => {
        this.writeCount += 1;
      },
      updateClosed: async () => {
        this.writeCount += 1;
      },
      reconcileEventConfirmation: async () => undefined,
      retractPosition: async () => {
        this.writeCount += 1;
      },
    });
  }
}
