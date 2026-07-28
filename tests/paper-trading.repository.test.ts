import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PaperPosition,
  PaperPositionOpenedEventV1,
  PaperTrade,
} from '../src/domain/paper-trading.js';
import { PostgresPaperTradingRepository } from '../src/storage/paper-trading.repository.js';

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

class RecordingClient {
  public readonly commands: string[] = [];
  public readonly values: unknown[][] = [];
  public released = false;

  public constructor(private readonly failEvent = false) {}

  public async query(text: string, values?: readonly unknown[]) {
    const command = classify(text);
    this.commands.push(command);
    this.values.push([...(values ?? [])]);
    if (this.failEvent && command === 'INSERT domain_events') throw new Error('event failure');
    return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
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
  return `${normalized.startsWith('SELECT') ? 'SELECT' : 'INSERT'} ${match?.[1] ?? 'unknown'}`;
}
