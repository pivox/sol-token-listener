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
  QualificationEngine,
  defaultQualificationRuleSet,
} from '../src/qualification/qualification-engine.js';

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
  const qualification = new QualificationEngine(defaultQualificationRuleSet).evaluate({
    evaluatedAtMs: 1,
    signals: {
      imageValid: true,
      socialCrossLinkConfirmed: true,
      creatorHasNotSold: true,
    },
    blockers: [],
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

class MemoryPaperRepository implements PaperTradingRepository {
  public readonly positions = new Map<string, PaperPosition>();
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
        _event: PaperPositionOpenedEventV1,
      ) => {
        this.positions.set(position.id, position);
        this.writeCount += 1;
      },
      updateClosed: async (
        position: PaperPosition,
        _trade: PaperTrade,
        _event: PaperPositionClosedEventV1,
      ) => {
        this.positions.set(position.id, position);
        this.writeCount += 1;
      },
    });
  }
}
