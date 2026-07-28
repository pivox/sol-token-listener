import test from 'node:test';
import assert from 'node:assert/strict';
import type { TokenSession, TradeRecord } from '../src/domain/types.js';
import { TradeExecutor } from '../src/execution/trade-executor.js';

const SESSION = {
  id: 'session-1',
  pool: {
    pool: 'pool-1',
    tokenMint: 'token-mint',
    tokenProgram: 'token-program',
    wsolMint: 'wsol-mint',
  },
  entry: {
    amountOutTokenRaw: 123n,
  },
} as unknown as TokenSession;

void test('utilise la quantité simulée de l’entrée pour une vente paper', async () => {
  let walletBalanceRead = false;
  let quotedAmount: bigint | null = null;
  const savedTrade: { value: TradeRecord | null } = { value: null };

  const executor = makeExecutor({
    simulationOk: true,
    onReadBalance: () => { walletBalanceRead = true; },
    onQuoteSell: (amount) => { quotedAmount = amount; },
    onSave: (trade) => { savedTrade.value = trade; },
  });

  const execution = await executor.sell(SESSION);

  assert.equal(walletBalanceRead, false);
  assert.equal(quotedAmount, 123n);
  assert.equal(execution.amountInTokenRaw, 123n);
  assert.equal(savedTrade.value?.mode, 'paper');
  assert.equal(savedTrade.value?.status, 'SIMULATED');
});

void test('conserve le mode paper lorsqu’une simulation échoue', async () => {
  const savedTrade: { value: TradeRecord | null } = { value: null };
  const executor = makeExecutor({
    simulationOk: false,
    onSave: (trade) => { savedTrade.value = trade; },
  });

  await assert.rejects(executor.sell(SESSION), /Simulation de vente échouée/);

  assert.equal(savedTrade.value?.mode, 'paper');
  assert.equal(savedTrade.value?.status, 'FAILED');
});

function makeExecutor(options: {
  simulationOk: boolean;
  onReadBalance?: () => void;
  onQuoteSell?: (amount: bigint) => void;
  onSave: (trade: TradeRecord) => void;
}): TradeExecutor {
  const venue = {
    readTokenBalance: async (..._args: unknown[]): Promise<bigint> => {
      options.onReadBalance?.();
      return 999n;
    },
    quoteSell: async (_pool: unknown, amount: bigint) => {
      options.onQuoteSell?.(amount);
      return {
        amountInRaw: amount,
        amountOutRaw: 456n,
        transferFeeRaw: 6n,
        observedSlot: 42n,
      };
    },
    buildSell: async (..._args: unknown[]) => ({ transaction: {} }),
  };
  const simulator = {
    simulate: async (..._args: unknown[]) => options.simulationOk
      ? { ok: true, unitsConsumed: 10n }
      : { ok: false, error: 'échec attendu' },
  };
  const queue = {
    enqueue: async <T>(_key: string, operation: () => Promise<T>): Promise<T> => operation(),
  };
  const trades = {
    save: async (trade: TradeRecord): Promise<void> => { options.onSave(trade); },
  };

  return new TradeExecutor(
    venue as never,
    { address: 'wallet-1' } as never,
    { executionMode: 'paper', buyAmountLamports: 100n } as never,
    simulator as never,
    {} as never,
    {} as never,
    queue as never,
    trades as never,
  );
}
