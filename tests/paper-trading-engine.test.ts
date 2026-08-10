import assert from 'node:assert/strict';
import test from 'node:test';
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
import { PaperTradingEngine } from '../src/paper/paper-trading-engine.js';
import {
  createDefaultQualificationRuleSet,
  QualificationEngine,
} from '../src/qualification/qualification-engine.js';
import { reconcileConfirmationStatus } from '../src/domain/confirmation-status.js';
import type { ChainConfirmationStatus } from '../src/domain/types.js';

void test('refuse le mode observe sans écriture', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'observe');

  await assert.rejects(engine.open(openCommand()), hasCode('PAPER_MODE_DISABLED'));
  assert.equal(repository.writeCount, 0);
});

void test('ouvre une position au fill conservateur et rejoue sans doublon', async () => {
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
  const command = openCommand();

  await assert.rejects(
    makeEngine(repository, 'paper').open({
      ...command,
      qualification: { ...command.qualification, verdict: 'WATCHLISTED' },
    }),
    hasCode('QUALIFICATION_NOT_ACCEPTED'),
  );
  assert.equal(repository.writeCount, 0);
});

void test('refuse une qualification bloquée même marquée QUALIFIED', async () => {
  const repository = new MemoryPaperRepository();
  const command = openCommand();

  await assert.rejects(
    makeEngine(repository, 'paper').open({
      ...command,
      qualification: {
        ...command.qualification,
        blockers: [{
          code: 'CREATOR_EARLY_SELL',
          message: 'Condition éliminatoire active.',
        }],
      },
    }),
    hasCode('QUALIFICATION_BLOCKED'),
  );
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

void test('binds the profile fingerprint and calibrated condition evidence into open idempotency', async () => {
  const fingerprintRepository = new MemoryPaperRepository();
  const fingerprintEngine = makeEngine(fingerprintRepository, 'paper');
  const fingerprintCommand = openCommand();
  await fingerprintEngine.open(fingerprintCommand);
  await assert.rejects(fingerprintEngine.open({
    ...fingerprintCommand,
    qualification: {
      ...fingerprintCommand.qualification,
      ruleSet: { ...fingerprintCommand.qualification.ruleSet, fingerprint: 'b'.repeat(64) },
    },
  }), hasCode('POSITION_CONFLICT'));

  const conditionRepository = new MemoryPaperRepository();
  const conditionEngine = makeEngine(conditionRepository, 'paper');
  const conditionCommand = openCommand();
  await conditionEngine.open(conditionCommand);
  const conditions = conditionCommand.qualification.conditions;
  await assert.rejects(conditionEngine.open({
    ...conditionCommand,
    qualification: {
      ...conditionCommand.qualification,
      conditions: conditions.map((item) => item.code === 'ROUND_TRIP_LOSS_EXCEEDED'
        ? { ...item, observed: { ...item.observed, roundTripLossBps: 3_001n } }
        : item),
    },
  }), hasCode('POSITION_CONFLICT'));
  assert.equal(fingerprintRepository.writeCount, 1);
  assert.equal(conditionRepository.writeCount, 1);
});

void test('replays calibrated condition maps with a different key order', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const command = openCommand();
  const first = await engine.open(command);
  const replay = await engine.open({
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
  });

  assert.equal(replay.id, first.id);
  assert.equal(repository.writeCount, 1);
});

void test('preserves the historical calibrated qualification command hash', async () => {
  const repository = new MemoryPaperRepository();
  const engine = makeEngine(repository, 'paper');
  const command = openCommand();
  const first = await engine.open(command);

  assert.equal(
    first.openCommandHash,
    'paper_open_command_04adf7b1775782bd2c2a8978237cb1b653158fbf0dd4d9ca4f5e7484445971d0',
  );
  const replay = await engine.open({
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
  });
  assert.equal(replay.id, first.id);
});

void test('rejects invalid numeric calibrated condition values instead of replaying null', async () => {
  for (const value of [NaN, Infinity, -Infinity, 1.5, -0]) {
    const observedRepository = new MemoryPaperRepository();
    const observedEngine = makeEngine(observedRepository, 'paper');
    const observedCommand = openCommand();
    await observedEngine.open(observedCommand);
    await assert.rejects(
      observedEngine.open(withHolderConditionValue(observedCommand, 'observed', value)),
      /Qualification condition records must contain enumerable data values/u,
    );
    assert.equal(observedRepository.writeCount, 1);

    const thresholdRepository = new MemoryPaperRepository();
    const thresholdEngine = makeEngine(thresholdRepository, 'paper');
    const thresholdCommand = openCommand();
    await thresholdEngine.open(thresholdCommand);
    await assert.rejects(
      thresholdEngine.open(withHolderConditionValue(thresholdCommand, 'thresholds', value)),
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
    const engine = makeEngine(repository, 'paper');
    const command = openCommand();
    await engine.open(command);
    await assert.rejects(
      engine.open(withConditionValue(command, code, record, key, value)),
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
): PaperTradingEngine {
  return new PaperTradingEngine(
    {
      executionMode,
      paperQuoteMintAllowlist: ['SOL'],
      dataRetentionHours: 4,
    },
    repository,
    { now: () => 1_000 },
  );
}

function openCommand(): OpenPaperPositionCommand {
  const qualification = new QualificationEngine(createDefaultQualificationRuleSet(60)).evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
    },
    blockers: [],
    calibrationFacts: null,
  });
  return {
    mint: 'MINT',
    quoteAsset: { mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' },
    strategy: { id: 'momentum-controlled', version: 1 },
    trigger: trigger('QualificationUpdated'),
    qualification,
    buyQuote: quote('buy', 'SOL', 'MINT', 100n, 95n, 90n),
    reverseSellQuote: quote('reverse', 'MINT', 'SOL', 90n, 91n, 89n),
    maximumRoundTripLossBps: 1_100n,
  };
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
