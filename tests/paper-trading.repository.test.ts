import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PaperPosition,
  PaperPositionClosedEventV1,
  PaperPositionOpenedEventV1,
  PaperTrade,
} from '../src/domain/paper-trading.js';
import { PostgresPaperTradingRepository } from '../src/storage/paper-trading.repository.js';
import { toJsonValue } from '../src/utils/json.js';

void test('persiste position, trade et événement dans une transaction', async () => {
  const client = new RecordingClient();
  const repository = new PostgresPaperTradingRepository({
    connect: async () => client,
  });

  await repository.transact(async (transaction) => {
    await transaction.insertOpened(position(), trade(), event());
  });

  assert.deepEqual(client.commands, [
    'BEGIN',
    'INSERT paper_positions',
    'INSERT paper_trades',
    'INSERT domain_events',
    'COMMIT',
  ]);
  assert.equal(client.released, true);
  assert.equal(client.values.flat().some((value) => typeof value === 'bigint'), false);
});

void test('persiste et relit la lignée de stratégie sans casser les anciennes positions', async () => {
  const lineagePosition: PaperPosition = {
    ...position(),strategySessionId:'paper-session',qualificationReportId:'report',candidateId:'candidate',
  };
  const writer = new RecordingClient();
  const repository = new PostgresPaperTradingRepository({ connect:async () => writer });
  await repository.transact(async (transaction) => {
    await transaction.insertOpened(lineagePosition, trade(), event());
  });
  assert.deepEqual(writer.values[1]?.slice(-3), ['paper-session','report','candidate']);

  const reader = new RecordingClient(false, [{ payload:toJsonValue(lineagePosition) }]);
  const readRepository = new PostgresPaperTradingRepository({ connect:async () => reader });
  const decoded = await readRepository.transact(async (transaction) => transaction.findPosition('position'));
  assert.equal(decoded?.strategySessionId, 'paper-session');
  assert.equal(decoded?.qualificationReportId, 'report');
  assert.equal(decoded?.candidateId, 'candidate');
});

void test('rollback si l’événement ne peut pas être persisté', async () => {
  const client = new RecordingClient(true);
  const repository = new PostgresPaperTradingRepository({
    connect: async () => client,
  });

  await assert.rejects(repository.transact(async (transaction) => {
    await transaction.insertOpened(position(), trade(), event());
  }), /event failure/u);

  assert.equal(client.commands.at(-1), 'ROLLBACK');
  assert.equal(client.commands.includes('COMMIT'), false);
  assert.equal(client.released, true);
});

void test('sérialise les ouvertures concurrentes pour une stratégie et un mint', async () => {
  const client = new RecordingClient();
  const repository = new PostgresPaperTradingRepository({
    connect: async () => client,
  });

  await repository.transact(async (transaction) => (
    transaction.findActivePosition('MINT', { id: 'strategy', version: 1 })
  ));

  assert.match(
    client.texts[1] ?? '',
    /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/u,
  );
  assert.deepEqual(client.values[1], ['MINT\u001fstrategy\u001f1']);
});

void test('rend les événements paper purgeables à la fermeture', async () => {
  const client = new RecordingClient();
  const repository = new PostgresPaperTradingRepository({
    connect: async () => client,
  });

  await repository.transact(async (transaction) => {
    await transaction.updateClosed(closedPosition(), sellTrade(), closedEvent());
  });

  assert.deepEqual(client.commands, [
    'BEGIN',
    'UPDATE paper_positions',
    'INSERT paper_trades',
    'UPDATE domain_events',
    'INSERT domain_events',
    'COMMIT',
  ]);
  assert.deepEqual(client.values[3]?.slice(0, 1), ['position']);
  assert.equal(client.values[3]?.[1] instanceof Date, true);
  assert.equal(client.values[3]?.[2] instanceof Date, true);
  assert.equal(client.values[4]?.[15] instanceof Date, true);
  assert.equal(client.values[4]?.[16] instanceof Date, true);
});

void test('réconcilie durablement la finalité d’un événement paper', async () => {
  const client = new RecordingClient(false, [{ confirmation_status: 'confirmed' }]);
  const repository = new PostgresPaperTradingRepository({
    connect: async () => client,
  });

  await repository.transact(async (transaction) => {
    await transaction.reconcileEventConfirmation('event', {
      ...event(),
      confirmationStatus: 'finalized',
      observedAtMs: 2,
    });
  });

  assert.deepEqual(client.commands, [
    'BEGIN',
    'SELECT domain_events',
    'UPDATE domain_events',
    'COMMIT',
  ]);
  assert.equal(client.values[2]?.[1], 'finalized');
});

void test('termine une projection paper rétractée sans inventer de trade', async () => {
  const client = new RecordingClient();
  const repository = new PostgresPaperTradingRepository({
    connect: async () => client,
  });
  const retracted: PaperPosition = {
    ...position(),
    status: 'PAPER_RETRACTED',
    closedAtMs: 1_000,
    purgeAfterMs: 14_401_000,
  };

  await repository.transact(async (transaction) => {
    await transaction.retractPosition(retracted);
  });

  assert.deepEqual(client.commands, [
    'BEGIN',
    'UPDATE paper_positions',
    'UPDATE domain_events',
    'COMMIT',
  ]);
});

void test('refuse un payload de position corrompu', async () => {
  const client = new RecordingClient(false, [{ payload: { id: 'position' } }]);
  const repository = new PostgresPaperTradingRepository({
    connect: async () => client,
  });

  await assert.rejects(
    repository.transact(async (transaction) => transaction.findPosition('position')),
    /Payload paper position invalide/u,
  );
  assert.equal(client.commands.at(-1), 'ROLLBACK');
});

void test('refuse les invariants financiers corrompus relus en base', async () => {
  const corruptions: readonly PaperPosition[] = [
    { ...position(), baseFilledRaw: -1n },
    { ...position(), quoteCostRaw: -1n },
    { ...position(), roundTripLossBps: 10_001n },
    { ...position(), strategy: { ...position().strategy, version: 0 } },
    { ...position(), quoteAsset: { ...position().quoteAsset, decimals: 256 } },
    {
      ...position(),
      status: 'PAPER_CLOSED',
      closedAtMs: null,
      purgeAfterMs: null,
    },
    {
      ...position(),
      status: 'PAPER_RETRACTED',
      closedAtMs: null,
      purgeAfterMs: null,
    },
  ];

  for (const corrupted of corruptions) {
    const client = new RecordingClient(false, [{
      payload: toJsonValue(corrupted),
    }]);
    const repository = new PostgresPaperTradingRepository({
      connect: async () => client,
    });
    await assert.rejects(
      repository.transact(async (transaction) => transaction.findPosition('position')),
      /Payload paper position invalide/u,
    );
  }
});

function position(): PaperPosition {
  return {
    id: 'position', mint: 'MINT',
    quoteAsset: { mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' },
    strategy: { id: 'strategy', version: 1 },
    status: 'PAPER_HOLDING',
    baseFilledRaw: 90n, remainingBaseRaw: 90n, quoteCostRaw: 100n,
    quoteProceedsRaw: null, grossPnlQuoteRaw: null, netPnlQuoteRaw: null,
    roundTripLossBps: 1_000n, entryTradeId: 'trade', exitTradeId: null,
    openCommandHash: 'open-hash', closeCommandHash: null,
    triggerEventId: 'trigger', openedAtMs: 1, closedAtMs: null,
    purgeAfterMs: null, payloadVersion: 1,
  };
}

function closedPosition(): PaperPosition {
  return {
    ...position(),
    status: 'PAPER_CLOSED',
    remainingBaseRaw: 0n,
    quoteProceedsRaw: 115n,
    grossPnlQuoteRaw: 20n,
    netPnlQuoteRaw: 15n,
    exitTradeId: 'sell-trade',
    closeCommandHash: 'close-hash',
    closedAtMs: 1_000,
    purgeAfterMs: 14_401_000,
  };
}

function trade(): PaperTrade {
  return {
    id: 'trade', positionId: 'position', side: 'BUY',
    quote: {
      id: 'quote', inputMint: 'SOL', outputMint: 'MINT',
      amountInRaw: 100n, amountOutRaw: 95n, minimumAmountOutRaw: 90n,
      feesRaw: 1n, slippageBps: 100n, priceImpactBps: 50n,
      observedAtMs: 1, observedSlot: 1n,
    },
    fillAmountOutRaw: 90n, reason: 'QUALIFIED_ENTRY',
    createdAtMs: 1, payloadVersion: 1,
  };
}

function sellTrade(): PaperTrade {
  return {
    ...trade(),
    id: 'sell-trade',
    side: 'SELL',
    quote: {
      ...trade().quote,
      id: 'sell-quote',
      inputMint: 'MINT',
      outputMint: 'SOL',
      amountInRaw: 90n,
      amountOutRaw: 120n,
      minimumAmountOutRaw: 115n,
    },
    fillAmountOutRaw: 115n,
    reason: 'MAX_HOLD_DURATION',
    createdAtMs: 1_000,
  };
}

function event(): PaperPositionOpenedEventV1 {
  return {
    id: 'event', type: 'PaperPositionOpened', mint: 'MINT',
    source: 'paper-trading', program: 'pump', signature: 'signature',
    cursor: {
      slot: 1n, transactionIndex: 0, instructionIndex: 0,
      innerInstructionIndex: null,
    },
    confirmationStatus: 'confirmed', blockchainTimeMs: 1, observedAtMs: 1,
    payloadVersion: 1, payload: { position: position(), trade: trade() },
  };
}

function closedEvent(): PaperPositionClosedEventV1 {
  return {
    ...event(),
    id: 'closed-event',
    type: 'PaperPositionClosed',
    observedAtMs: 1_000,
    payload: { position: closedPosition(), trade: sellTrade() },
  };
}

class RecordingClient {
  public readonly commands: string[] = [];
  public readonly texts: string[] = [];
  public readonly values: unknown[][] = [];
  public released = false;

  public constructor(
    private readonly failEvent = false,
    private readonly selectRows: readonly unknown[] = [],
  ) {}

  public async query(text: string, values?: readonly unknown[]) {
    const command = classify(text);
    this.commands.push(command);
    this.texts.push(text);
    this.values.push([...(values ?? [])]);
    if (this.failEvent && command === 'INSERT domain_events') throw new Error('event failure');
    return {
      rows: command.startsWith('SELECT') ? this.selectRows : [],
      rowCount: 0, command: '', oid: 0, fields: [],
    };
  }

  public release(): void {
    this.released = true;
  }
}

function classify(sql: string): string {
  const normalized = sql.trim().replace(/\s+/gu, ' ');
  if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
    return normalized;
  }
  const match = /^(?:INSERT INTO|UPDATE|SELECT .* FROM) ([a-z_]+)/iu.exec(normalized);
  const operation = normalized.startsWith('SELECT')
    ? 'SELECT'
    : normalized.startsWith('UPDATE') ? 'UPDATE' : 'INSERT';
  return `${operation} ${match?.[1] ?? 'unknown'}`;
}
