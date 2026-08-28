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
    await transaction.insertOpened(position(), trade(), event(), 500, 'job-open');
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
  assert.equal((client.values[1]?.at(-2) as Date).getTime(), 500);
  assert.equal(client.values[1]?.at(-1), 'job-open');
  assert.equal((client.values[2]?.at(-1) as Date).getTime(), 1);
});

void test('persiste et relit la lignée de stratégie sans casser les anciennes positions', async () => {
  const lineagePosition: PaperPosition = {
    ...position(),strategySessionId:'paper-session',qualificationReportId:'report',candidateId:'candidate',
  };
  const writer = new RecordingClient();
  const repository = new PostgresPaperTradingRepository({ connect:async () => writer });
  await repository.transact(async (transaction) => {
    await transaction.insertOpened(lineagePosition, trade(), event(), 500, 'job-open');
  });
  assert.deepEqual(writer.values[1]?.slice(-5, -2), ['paper-session','report','candidate']);

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
    await transaction.insertOpened(position(), trade(), event(), 500, 'job-open');
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

void test('locks and verifies the exact current qualification before paper writes',async()=>{
  const client=new RecordingClient(false,[
    {
      report_id:'report',source_event_id:'source',source_raw_event_id:'raw',
      event_id:'raw',signature:'signature',confirmation_status:'confirmed',
      processing_status:'PROCESSED',target_confirmation_status:'confirmed',
    },
  ]);
  const repository=new PostgresPaperTradingRepository({ connect:async()=>client });

  await repository.transact(async(transaction)=>{
    await transaction.requireCurrentQualification({
      mint:'MINT',reportId:'report',qualificationEventId:'qualification-event',
    });
  });

  assert.match(client.texts[1] ?? '',/qualification-projection:/u);
  assert.match(client.texts[1] ?? '',/pg_advisory_xact_lock/u);
  assert.match(client.texts[2] ?? '',/superseded_at IS NULL/u);
  assert.match(client.texts[2] ?? '',/purge_after > clock_timestamp\(\)/u);
  assert.match(client.texts[2] ?? '',/qualification_event_id/u);
  assert.match(client.texts[2] ?? '',/report\.confirmation_status <> 'orphaned'/u);
  assert.match(client.texts[2] ?? '',/event\.confirmation_status <> 'orphaned'/u);
  assert.match(client.texts[3] ?? '',/FROM raw_chain_events raw/u);
  assert.match(client.texts[3] ?? '',/raw\.event_id=\$1/u);
  assert.match(client.texts[3] ?? '',/raw\.confirmation_status <> 'orphaned'/u);
  assert.match(client.texts[3] ?? '',/FOR SHARE OF raw/u);
  assert.match(client.texts[4] ?? '',/FROM domain_events source/u);
  assert.match(client.texts[4] ?? '',/source\.event_id=\$1/u);
  assert.match(client.texts[4] ?? '',/source\.raw_event_id=\$2/u);
  assert.match(client.texts[4] ?? '',/source\.confirmation_status <> 'orphaned'/u);
  assert.match(client.texts[4] ?? '',/source\.type IN/u);
  assert.match(client.texts[4] ?? '',/raw\.source=source\.source/u);
  assert.match(client.texts[4] ?? '',/FOR SHARE OF source,raw/u);
  assert.match(client.texts[5] ?? '',/LIMIT \$3/u);
  assert.match(client.texts[5] ?? '',/COALESCE\(raw\.inner_instruction_index,-1\)/u);
  assert.match(client.texts[6] ?? '',/ORDER BY signature COLLATE "C"/u);
  assert.match(client.texts[6] ?? '',/FOR SHARE/u);
  assert.deepEqual(client.values[1],['MINT']);
  assert.deepEqual(client.values[2],['MINT','report','qualification-event']);
  assert.deepEqual(client.values[3],['raw','MINT']);
  assert.deepEqual(client.values[4],[
    'source','raw','MINT','report','qualification-event',
  ]);
  assert.deepEqual(client.values[5],['MINT','raw',4097]);
  assert.deepEqual(client.values[6],[['signature']]);
});

void test('rolls back a stale current qualification before paper writes',async()=>{
  const client=new RecordingClient();
  const repository=new PostgresPaperTradingRepository({ connect:async()=>client });

  await assert.rejects(repository.transact(async(transaction)=>{
    await transaction.requireCurrentQualification({
      mint:'MINT',reportId:'report',qualificationEventId:'qualification-event',
    });
    await transaction.insertOpened(position(),trade(),event(),null,null);
  }),hasCode('QUALIFICATION_NOT_CURRENT'));

  assert.equal(client.commands.includes('INSERT paper_positions'),false);
  assert.equal(client.commands.at(-1),'ROLLBACK');
});

void test('rend les événements paper purgeables à la fermeture', async () => {
  const client = new RecordingClient();
  const repository = new PostgresPaperTradingRepository({
    connect: async () => client,
  });

  await repository.transact(async (transaction) => {
    await transaction.updateClosed(closedPosition(), sellTrade(), closedEvent(), 900);
  });

  assert.deepEqual(client.commands, [
    'BEGIN',
    'INSERT domain_events',
    'UPDATE paper_positions',
    'INSERT paper_trades',
    'UPDATE domain_events',
    'COMMIT',
  ]);
  assert.equal(client.values[1]?.[12] instanceof Date, true);
  assert.deepEqual(client.values[4]?.slice(0, 1), ['position']);
  assert.equal(client.values[4]?.[1] instanceof Date, true);
  assert.equal(client.values[4]?.[2] instanceof Date, true);
  assert.equal(client.values[2]?.includes('closed-event'), true);
  assert.equal(client.values[2]?.some((value) => value instanceof Date && value.getTime() === 900), true);
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
      rows: command.startsWith('SELECT') || text.trimStart().startsWith('WITH')
        ? this.selectRows
        : [],
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

function hasCode(code:string):(error:unknown)=>boolean{
  return (error)=>(
    typeof error==='object'&&error!==null&&'code' in error&&error.code===code
  );
}
