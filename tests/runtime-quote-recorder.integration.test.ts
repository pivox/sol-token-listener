import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CanonicalPaperQuoteRouter } from '../src/paper/paper-quote-router.js';
import { PumpFunPaperQuoteProvider } from '../src/paper/pumpfun-paper-quote.provider.js';
import { QuoteObservationRecorder } from '../src/telemetry/quote-recorder.js';
import { createQuoteObservationFileSink } from '../src/telemetry/quote-observation-file.js';
import { accounts, FakeReader, MINT, quoteAsset, SLOT } from './helpers/pumpfun-paper-quote-state.js';

void test('the canonical runtime SELL quote is recorded and replayable without any signing or transaction sender', async () => {
  const fixture = await accounts();
  const rpc = new FakeReader(fixture.snapshots);
  const tempDir = await mkdtemp(join(tmpdir(), 'runtime-quote-recorder-'));
  const filePath = join(tempDir, 'quotes.jsonl');
  const times = [1_000, 1_010, 1_020, 1_030];
  const clock = (): number => times.shift() ?? 1_030;
  const recorder = new QuoteObservationRecorder({
    enabled: true,
    append: createQuoteObservationFileSink(filePath),
  });
  const router = new CanonicalPaperQuoteRouter(
    { read: async (mint) => ({
      mint,
      bondingCurve: { active: true, complete: false },
      migrationObserved: false,
      pumpSwap: null,
      headSlot: SLOT,
    }) },
    new PumpFunPaperQuoteProvider(rpc, clock),
    { quote: async () => { throw new Error('PumpSwap must not be selected for an active bonding curve'); } },
    { maxAgeMs: 5_000, maxSlotLag: 2n, clock, quoteRecorder: recorder },
  );

  try {
    const quote = await router.quote({
      mint: MINT.toBase58(), quoteAsset, side: 'SELL', amountInRaw: 10_000n, slippageBps: 100n,
      observationContext: {
        sessionId: 'session-paper', positionId: 'position-paper', buyTradeId: 'buy-trade-paper',
        signalAtMs: 995, economicCostRaw: null, sellNetworkFeeEstimateRaw: null,
      },
    });
    router.recordDecision({
      sessionId: 'session-paper', positionId: 'position-paper', buyTradeId: 'buy-trade-paper',
      quoteId: quote.id, signalAtMs: 995, decisionAtMs: 1_015,
    });
    await recorder.flush();
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    const quoteLine = lines[0];
    const decisionLine = lines[1];
    assert.ok(quoteLine);
    assert.ok(decisionLine);
    const row = JSON.parse(quoteLine) as {
      schema: string; sessionId: string; positionId: string; mint: string; tokenAmountRaw: string;
      stateReceivedAtMs: number; stateSlot: string; quoteCalculatedAtMs: number; signalAtMs: number;
      availableAtMs: number; netPnlEstimateRaw: string | null; netPnlUnknownReasons: string[];
      amountOutRaw: string; feeTreatment: string;
    };
    const decision = JSON.parse(decisionLine) as {
      kind: string; signalAtMs: number; availableAtMs: number; decisionAtMs: number;
      availableAtDecision: boolean; causalStatus: string;
    };
    assert.equal(row.schema, 'quote_observation.v1');
    assert.equal(row.sessionId, 'session-paper');
    assert.equal(row.positionId, 'position-paper');
    assert.equal(row.mint, MINT.toBase58());
    assert.equal(row.tokenAmountRaw, '10000');
    assert.equal(row.stateReceivedAtMs, 1_000);
    assert.equal(row.stateSlot, SLOT.toString());
    assert.equal(row.quoteCalculatedAtMs, 1_010);
    assert.equal(row.signalAtMs, 995);
    assert.equal(row.availableAtMs, 1_020);
    assert.equal(row.netPnlEstimateRaw, null);
    assert.deepEqual(row.netPnlUnknownReasons, ['ECONOMIC_COST_UNKNOWN', 'SELL_NETWORK_FEE_UNKNOWN']);
    assert.equal(row.amountOutRaw, quote.amountOutRaw.toString());
    assert.equal(row.feeTreatment, 'INCLUDED_IN_MIN_OUT');
    assert.equal(decision.kind, 'decision');
    assert.equal(decision.signalAtMs, 995);
    assert.equal(decision.availableAtMs, 1_020);
    assert.equal(decision.decisionAtMs, 1_015);
    assert.equal(decision.availableAtDecision, false);
    assert.equal(decision.causalStatus, 'QUOTE_AVAILABLE_AFTER_DECISION');
    assert.equal(recorder.health().writeErrors, 0);
    assert.equal(recorder.health().dropped, 0);
    assert.equal(rpc.addresses.length, 4);
    assert.equal('sendTransaction' in rpc, false);
    assert.equal('signTransaction' in rpc, false);
  } finally {
    await recorder.flush();
    await rm(tempDir, { recursive: true, force: true });
  }
});

void test('the canonical quote records availability before the later decision without rewriting either timestamp', async () => {
  const fixture = await accounts();
  const rpc = new FakeReader(fixture.snapshots);
  const tempDir = await mkdtemp(join(tmpdir(), 'runtime-quote-causal-'));
  const filePath = join(tempDir, 'quotes.jsonl');
  const times = [2_000, 2_010, 2_020, 2_030];
  const clock = (): number => times.shift() ?? 2_030;
  const recorder = new QuoteObservationRecorder({ enabled: true, append: createQuoteObservationFileSink(filePath) });
  const router = new CanonicalPaperQuoteRouter(
    { read: async (mint) => ({ mint, bondingCurve: { active: true, complete: false }, migrationObserved: false, pumpSwap: null, headSlot: SLOT }) },
    new PumpFunPaperQuoteProvider(rpc, clock),
    { quote: async () => { throw new Error('unexpected PumpSwap quote'); } },
    { maxAgeMs: 5_000, maxSlotLag: 2n, clock, quoteRecorder: recorder },
  );
  try {
    const quote = await router.quote({
      mint: MINT.toBase58(), quoteAsset, side: 'SELL', amountInRaw: 10_000n, slippageBps: 100n,
      observationContext: { sessionId: 's', positionId: 'p', buyTradeId: 'b', signalAtMs: 1_990,
        economicCostRaw: '1000', sellNetworkFeeEstimateRaw: '25' },
    });
    router.recordDecision({ sessionId: 's', positionId: 'p', buyTradeId: 'b', quoteId: quote.id,
      signalAtMs: 1_990, decisionAtMs: 2_025 });
    await recorder.flush();
    const rows = (await readFile(filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const quoteRow = rows[0]; const decisionRow = rows[1];
    assert.ok(quoteRow); assert.ok(decisionRow);
    assert.equal(quoteRow.signalAtMs, 1_990);
    assert.equal(quoteRow.availableAtMs, 2_020);
    assert.equal(quoteRow.economicCostRaw, '1000');
    assert.equal(quoteRow.sellNetworkFeeEstimateRaw, '25');
    assert.equal(quoteRow.netPnlEstimateRaw, String(quote.minimumAmountOutRaw - 1_000n - 25n));
    assert.equal(decisionRow.availableAtMs, 2_020);
    assert.equal(decisionRow.decisionAtMs, 2_025);
    assert.equal(decisionRow.availableAtDecision, true);
    assert.equal(decisionRow.causalStatus, 'AVAILABLE_BEFORE_DECISION');
  } finally {
    await recorder.flush();
    await rm(tempDir, { recursive: true, force: true });
  }
});
