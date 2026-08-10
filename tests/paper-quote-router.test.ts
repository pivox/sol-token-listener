import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonicalMarketPool, MarketQuote, MarketQuoteRequest } from '../src/domain/market.js';
import type { PaperExecutionQuote } from '../src/domain/paper-trading.js';
import type { PaperQuoteRequest, PaperQuoteRouter } from '../src/ports/paper-quote-router.js';
import {
  CanonicalPaperQuoteRouter,
  type CanonicalPaperVenueReader,
  type CanonicalPaperVenueState,
} from '../src/paper/paper-quote-router.js';
import { PaperQuoteError } from '../src/ports/paper-quote-router.js';

const MINT = 'So11111111111111111111111111111111111111112';
const QUOTE = '11111111111111111111111111111111';
const NOW = 10_000;
const request: PaperQuoteRequest = Object.freeze({
  mint: MINT,
  quoteAsset: Object.freeze({ mint: QUOTE, decimals: 9, tokenProgram: 'SPL_TOKEN' }),
  side: 'BUY',
  amountInRaw: 1_000n,
  slippageBps: 100n,
});

void test('routes an active curve exclusively to Pump.fun', async () => {
  const pump = new FakePumpQuote(paperQuote({ observedAtMs: 9_000, observedSlot: 99n }));
  const market = new FakePumpSwapMarket();
  const router = route(activeCurve(), pump, market);

  const quote = await router.quote(request);

  assert.equal(quote.id, 'paper-quote');
  assert.equal(pump.calls, 1);
  assert.equal(market.calls, 0);
});

void test('routes a completed curve with one canonical active pool exclusively to PumpSwap', async () => {
  const pump = new FakePumpQuote(paperQuote());
  const market = new FakePumpSwapMarket(marketQuote({ observedAtMs: 9_000, observedSlot: 99n }));
  const router = route(completedWithPool(), pump, market);

  const quote = await router.quote(request);

  assert.equal(quote.id, 'market-quote');
  assert.equal(quote.amountOutRaw, 900n);
  assert.equal(pump.calls, 0);
  assert.equal(market.calls, 1);
  assert.equal(market.lastRequest?.inputMint, QUOTE);
  assert.equal(market.lastRequest?.pool.address, 'pool');
});

void test('marks an announced migration without an active pool as retryable', async () => {
  const router = route({
    ...activeCurve(),
    bondingCurve: { active: false, complete: true },
    migrationObserved: true,
  });
  await assert.rejects(router.quote(request), (error: unknown) => {
    assert.ok(error instanceof PaperQuoteError);
    assert.equal(error.code, 'VENUE_MIGRATION_PENDING');
    assert.equal(error.retryable, true);
    return true;
  });
});

void test('fails closed before quoting when Pump.fun and PumpSwap are both active', async () => {
  const pump = new FakePumpQuote(paperQuote());
  const market = new FakePumpSwapMarket();
  const router = route({
    ...completedWithPool(),
    bondingCurve: { active: true, complete: false },
  }, pump, market);
  await assert.rejects(router.quote(request), (error: unknown) => {
    assert.ok(error instanceof PaperQuoteError);
    assert.equal(error.code, 'QUOTE_STATE_INCONSISTENT');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(pump.calls, 0);
  assert.equal(market.calls, 0);
});

void test('rejects quotes stale by time or head-slot lag', async () => {
  for (const quote of [
    paperQuote({ observedAtMs: 4_999, observedSlot: 99n }),
    paperQuote({ observedAtMs: 9_000, observedSlot: 89n }),
  ]) {
    const router = route(activeCurve(), new FakePumpQuote(quote));
    await assert.rejects(router.quote(request), (error: unknown) => {
      assert.ok(error instanceof PaperQuoteError);
      assert.equal(error.code, 'QUOTE_STALE');
      assert.equal(error.retryable, true);
      return true;
    });
  }
});

void test('fails closed when the selected venue returns a contradictory quote', async () => {
  const router = route(activeCurve(), new FakePumpQuote(paperQuote({ inputMint: MINT })));
  await assert.rejects(router.quote(request), (error: unknown) => {
    assert.ok(error instanceof PaperQuoteError);
    assert.equal(error.code, 'QUOTE_STATE_INCONSISTENT');
    return true;
  });
});

function route(
  state: CanonicalPaperVenueState,
  pump: FakePumpQuote = new FakePumpQuote(paperQuote()),
  market: FakePumpSwapMarket = new FakePumpSwapMarket(),
): CanonicalPaperQuoteRouter {
  const reader: CanonicalPaperVenueReader = { read: async () => state };
  return new CanonicalPaperQuoteRouter(reader, pump, market, {
    maxAgeMs: 5_000,
    maxSlotLag: 10n,
    clock: () => NOW,
  });
}

function activeCurve(): CanonicalPaperVenueState {
  return Object.freeze({
    mint: MINT,
    bondingCurve: Object.freeze({ active: true, complete: false }),
    migrationObserved: false,
    pumpSwap: null,
    headSlot: 100n,
  });
}

function completedWithPool(): CanonicalPaperVenueState {
  return Object.freeze({
    mint: MINT,
    bondingCurve: Object.freeze({ active: false, complete: true }),
    migrationObserved: true,
    pumpSwap: Object.freeze({ active: true, pool: canonicalPool() }),
    headSlot: 100n,
  });
}

function canonicalPool(): CanonicalMarketPool {
  return Object.freeze({
    address: 'pool', market: 'pumpswap', programId: 'program', baseMint: MINT,
    quoteAsset: request.quoteAsset, index: 0, creator: 'creator', baseVault: 'base-vault',
    quoteVault: 'quote-vault', lpMint: 'lp-mint', baseTokenProgram: 'SPL_TOKEN',
    confirmationStatus: 'confirmed',
    activatedAt: Object.freeze({ slot: 90n, transactionIndex: 0, instructionIndex: 0, innerInstructionIndex: null }),
  });
}

class FakePumpQuote implements PaperQuoteRouter {
  public calls = 0;

  public constructor(private readonly result: PaperExecutionQuote) {}

  public async quote(): Promise<PaperExecutionQuote> {
    this.calls += 1;
    return this.result;
  }
}

class FakePumpSwapMarket {
  public calls = 0;
  public lastRequest: MarketQuoteRequest | null = null;

  public constructor(private readonly result: MarketQuote = marketQuote()) {}

  public async quote(value: MarketQuoteRequest): Promise<MarketQuote> {
    this.calls += 1;
    this.lastRequest = value;
    return this.result;
  }
}

function paperQuote(overrides: Partial<PaperExecutionQuote> = {}): PaperExecutionQuote {
  return Object.freeze({
    id: 'paper-quote', inputMint: QUOTE, outputMint: MINT, amountInRaw: 1_000n,
    amountOutRaw: 900n, minimumAmountOutRaw: 891n, feesRaw: 10n,
    slippageBps: 100n, priceImpactBps: 100n, observedAtMs: 9_000,
    observedSlot: 99n, ...overrides,
  });
}

function marketQuote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return Object.freeze({
    id: 'market-quote', pool: 'pool', inputMint: QUOTE, outputMint: MINT,
    amountInRaw: 1_000n, amountOutRaw: 900n, minimumAmountOutRaw: 891n,
    feesRaw: 10n, slippageBps: 100n, priceImpactBps: 100n,
    observedAtMs: 9_000, observedSlot: 99n, ...overrides,
  });
}
