import assert from 'node:assert/strict';
import test from 'node:test';
import { DefaultFastEntryService } from '../src/application/fast-entry.service.js';
import { FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW } from '../src/domain/fast-entry.js';
import type { PaperExecutionQuote } from '../src/domain/paper-trading.js';
import type { PaperQuoteRequest } from '../src/ports/paper-quote-router.js';

const SOL = 'So11111111111111111111111111111111111111112';
const envelope = { envelopeId: 'env-1', perBuyQuoteAmountRaw: 100n };
const NOW = 1_700_000_000_000;

function launchOf(mint: string, over: Record<string, unknown> = {}): never {
  return {
    mint, quoteMint: SOL, quoteDecimals: 9, quoteTokenProgram: 'spl-token',
    creator: 'c', createSlot: 1n, createBlockTimeMs: null, launchEvent: { observedAtMs: NOW - 1_000 },
    creatorSoldInCreate: false, ...over,
  } as never;
}

function quote(
  inputMint: string, outputMint: string, amountInRaw: bigint,
  amountOutRaw: bigint, minimumAmountOutRaw: bigint,
): PaperExecutionQuote {
  return {
    id: `${inputMint}-${outputMint}`, inputMint, outputMint, amountInRaw, amountOutRaw,
    minimumAmountOutRaw, feesRaw: 0n, slippageBps: 100n, priceImpactBps: 0n,
    observedAtMs: 1_700_000_000_000, observedSlot: 1n,
  };
}

function setup(opts: {
  launches?: Record<string, unknown>;
  env?: typeof envelope | null;
  quoteFn?: (r: PaperQuoteRequest) => Promise<PaperExecutionQuote>;
  readThrows?: string;
  max?: bigint;
  recorded?: 'RECORDED' | 'ALREADY_DECIDED';
} = {}) {
  const calls = { rejections: [] as any[], buys: [] as any[], quotes: [] as PaperQuoteRequest[],
    decisions: [] as any[], errors: [] as any[] };
  const service = new DefaultFastEntryService({
    repository: {
      readLaunchForSignature: async (mint: string) => {
        if (opts.readThrows === mint) throw new TypeError('boom');
        return (opts.launches ?? { M: launchOf('M') })[mint] as never ?? null;
      },
      readActiveEnvelope: async () => (opts.env === undefined ? envelope : opts.env),
      recordRejection: async (i: unknown) => { calls.rejections.push(i); return opts.recorded ?? 'RECORDED'; },
      recordBuy: async (i: unknown) => {
        calls.buys.push(i);
        return opts.recorded === 'ALREADY_DECIDED' ? { kind: 'ALREADY_DECIDED' } : { kind: 'RECORDED', intentId: 'i' };
      },
    } as never,
    quotes: {
      quote: async (r) => {
        calls.quotes.push(r);
        if (opts.quoteFn) return opts.quoteFn(r);
        return r.side === 'BUY'
          ? quote(SOL, r.mint, r.amountInRaw, 95n, 90n)
          : quote(r.mint, SOL, r.amountInRaw, 91n, 89n);
      },
    },
    maximumRoundTripLossBps: opts.max ?? 1_100n,
    now: () => NOW,
    onDecision: (e) => calls.decisions.push(e),
    onError: (e) => calls.errors.push(e),
  });
  return { service, calls };
}

void test('not the create: skipped, nothing written', async () => {
  const { service, calls } = setup({ launches: {} });
  await service.onObserved('sig', ['M']);
  assert.equal(calls.rejections.length + calls.buys.length + calls.quotes.length, 0);
  assert.equal(calls.decisions.length, 0);
});

void test('each precheck reason is recorded without quoting', async () => {
  const cases: [string, Record<string, unknown>, typeof envelope | null][] = [
    ['UNSUPPORTED_QUOTE_MINT', { quoteMint: 'USDC' }, envelope],
    ['CREATOR_ALREADY_SOLD', { creatorSoldInCreate: true }, envelope],
    ['NO_ENVELOPE_CAPACITY', {}, null],
  ];
  for (const [reason, over, env] of cases) {
    const { service, calls } = setup({ launches: { M: launchOf('M', over) }, env });
    await service.onObserved('sig', ['M']);
    assert.equal(calls.quotes.length, 0);
    assert.equal(calls.rejections.length, 1);
    assert.equal(calls.rejections[0].reason, reason);
    assert.equal(calls.rejections[0].buyQuote, null);
    assert.equal(calls.decisions[0].reason, reason);
  }
});

void test('quote error records QUOTE_UNAVAILABLE without retry', async () => {
  const { service, calls } = setup({ quoteFn: async () => { throw new Error('rpc'); } });
  await service.onObserved('sig', ['M']);
  assert.equal(calls.quotes.length, 1);
  assert.equal(calls.rejections[0].reason, 'QUOTE_UNAVAILABLE');
  assert.equal(calls.rejections[0].buyQuote, null);
  assert.equal(calls.rejections[0].envelopeId, 'env-1');
});

void test('reverse quote error keeps the buy quote', async () => {
  const { service, calls } = setup({
    quoteFn: async (r) => {
      if (r.side === 'SELL') throw new Error('rpc');
      return quote(SOL, r.mint, r.amountInRaw, 95n, 90n);
    },
  });
  await service.onObserved('sig', ['M']);
  assert.equal(calls.quotes.length, 2);
  assert.equal(calls.rejections[0].reason, 'QUOTE_UNAVAILABLE');
  assert.equal(calls.rejections[0].buyQuote.amountOutRaw, 95n);
});

void test('loss exceeded is rejected with quotes and loss', async () => {
  const { service, calls } = setup({ max: 1_099n });
  await service.onObserved('sig', ['M']);
  assert.equal(calls.buys.length, 0);
  assert.equal(calls.rejections[0].reason, 'ROUND_TRIP_LOSS_EXCEEDED');
  assert.equal(calls.rejections[0].roundTripLossBps, 1_100n);
  assert.notEqual(calls.rejections[0].reverseQuote, null);
  assert.equal(calls.decisions[0].lossBps, '1100');
});

void test('BUY sends the right quote requests and records the buy', async () => {
  const { service, calls } = setup();
  await service.onObserved('sig', ['M']);
  assert.deepEqual(calls.quotes.map((request) => [request.side, request.amountInRaw, request.slippageBps]), [
    ['BUY', 100n, 1_000n],
    ['SELL', 90n, 1_000n],
  ]);
  assert.equal(calls.rejections.length, 0);
  assert.equal(calls.buys.length, 1);
  assert.equal(calls.buys[0].roundTripLossBps, 1_100n);
  assert.deepEqual(
    { ...calls.decisions[0], durationMs: 0 },
    { mint: 'M', decision: 'BUY', reason: null, lossBps: '1100', durationMs: 0 },
  );
});

void test('a repository throw goes to onError and the next mint is processed', async () => {
  const { service, calls } = setup({
    launches: { A: launchOf('A'), B: launchOf('B') },
    readThrows: 'A',
  });
  await service.onObserved('sig', ['A', 'B']);
  assert.deepEqual(calls.errors, [{ mint: 'A', errorName: 'TypeError' }]);
  assert.equal(calls.buys.length, 1);
  assert.equal(calls.buys[0].launch.mint, 'B');
});

void test('onObserved resolves even when everything fails', async () => {
  const { service } = setup({ readThrows: 'M' });
  await assert.doesNotReject(service.onObserved('sig', ['M']));
});

void test('a create first observed more than 15 s ago is skipped', async () => {
  const { service, calls } = setup({ launches: { M: launchOf('M', { launchEvent: { observedAtMs: NOW - 15_001 } }) } });
  await service.onObserved('sig', ['M']);
  assert.equal(calls.rejections.length + calls.buys.length + calls.quotes.length, 0);
});

void test('a decision lost to a concurrent writer is not reported', async () => {
  const rejected = setup({ env: null, recorded: 'ALREADY_DECIDED' });
  await rejected.service.onObserved('sig', ['M']);
  assert.equal(rejected.calls.rejections.length, 1);
  assert.equal(rejected.calls.decisions.length, 0);
  const bought = setup({ recorded: 'ALREADY_DECIDED' });
  await bought.service.onObserved('sig', ['M']);
  assert.equal(bought.calls.buys.length, 1);
  assert.equal(bought.calls.decisions.length, 0);
});

function probeSetup(opts: {
  launches?: Record<string, unknown>;
  env?: typeof envelope | null;
  quoteFn?: (r: PaperQuoteRequest) => Promise<PaperExecutionQuote>;
  probe?: 'RECORDED' | 'SKIPPED';
} = {}) {
  const clock = { now: NOW };
  const calls = { rejections: [] as any[], buys: [] as any[], probes: [] as any[],
    quotes: [] as PaperQuoteRequest[], probeEvents: [] as any[], errors: [] as any[] };
  const service = new DefaultFastEntryService({
    repository: {
      readLaunchForSignature: async (mint: string) => (opts.launches ?? {
        M: launchOf('M'), N: launchOf('N', { launchEvent: { observedAtMs: NOW + 599_000 } }),
        O: launchOf('O', { launchEvent: { observedAtMs: NOW + 599_000 } }),
      })[mint] as never ?? null,
      readActiveEnvelope: async () => (opts.env === undefined ? null : opts.env),
      recordRejection: async (i: unknown) => { calls.rejections.push(i); return 'RECORDED'; },
      recordBuy: async (i: unknown) => { calls.buys.push(i); return { kind: 'RECORDED', intentId: 'i' }; },
      recordProbe: async (i: unknown) => {
        calls.probes.push(i);
        return opts.probe === 'SKIPPED' ? { kind: 'SKIPPED' } : { kind: 'RECORDED', intentId: 'p' };
      },
    } as never,
    quotes: {
      quote: async (r) => {
        calls.quotes.push(r);
        if (opts.quoteFn) return opts.quoteFn(r);
        return quote(SOL, r.mint, r.amountInRaw, 95n, 90n);
      },
    },
    maximumRoundTripLossBps: 1_100n,
    probe: { intervalMs: 600_000 },
    now: () => clock.now,
    onProbe: (e) => calls.probeEvents.push(e),
    onError: (e) => calls.errors.push(e),
  });
  return { service, calls, clock };
}

void test('probe disabled by default: no envelope means no quote and no probe', async () => {
  const { service, calls } = setup({ env: null });
  await service.onObserved('sig', ['M']);
  assert.equal(calls.quotes.length, 0);
  assert.equal(calls.rejections[0].reason, 'NO_ENVELOPE_CAPACITY');
});

void test('probe enabled without an envelope: rejection kept, one minimal BUY quote, one probe', async () => {
  const { service, calls } = probeSetup();
  await service.onObserved('sig', ['M']);
  assert.equal(calls.rejections.length, 1);
  assert.equal(calls.rejections[0].reason, 'NO_ENVELOPE_CAPACITY');
  assert.deepEqual(calls.quotes.map((r) => [r.mint, r.side, r.amountInRaw, r.slippageBps]), [
    ['M', 'BUY', FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW, 1_000n],
  ]);
  assert.equal(calls.probes.length, 1);
  assert.equal(calls.probes[0].launch.mint, 'M');
  assert.equal(calls.probes[0].decidedAtMs, NOW);
  assert.equal(calls.probes[0].intervalMs, 600_000);
  assert.equal(calls.probes[0].buyQuote.amountInRaw, FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW);
  assert.deepEqual(calls.probeEvents, [{ mint: 'M', outcome: 'RECORDED' }]);
  assert.equal(calls.buys.length, 0);
});

void test('probe is rate limited to one attempt per interval, quote failures included', async () => {
  const { service, calls, clock } = probeSetup({
    quoteFn: async (r) => {
      if (r.mint === 'M') throw new Error('rpc');
      return quote(SOL, r.mint, r.amountInRaw, 95n, 90n);
    },
  });
  await service.onObserved('sig', ['M']);
  assert.equal(calls.quotes.length, 1);
  assert.equal(calls.probes.length, 0);
  assert.deepEqual(calls.probeEvents, [{ mint: 'M', outcome: 'QUOTE_UNAVAILABLE' }]);
  clock.now = NOW + 599_999;
  await service.onObserved('sig', ['N']);
  assert.equal(calls.quotes.length, 1);
  clock.now = NOW + 600_000;
  await service.onObserved('sig', ['O']);
  assert.equal(calls.quotes.length, 2);
  assert.equal(calls.probes.length, 1);
  assert.equal(calls.probes[0].launch.mint, 'O');
  assert.equal(calls.rejections.length, 3);
  assert.equal(calls.errors.length, 0);
});

void test('probe never runs with an envelope or for another precheck rejection', async () => {
  const withEnvelope = probeSetup({ env: envelope });
  await withEnvelope.service.onObserved('sig', ['M']);
  assert.equal(withEnvelope.calls.probes.length, 0);
  assert.deepEqual(withEnvelope.calls.quotes.map((r) => r.amountInRaw), [100n, 90n]);

  const sold = probeSetup({ launches: { M: launchOf('M', { creatorSoldInCreate: true }) } });
  await sold.service.onObserved('sig', ['M']);
  assert.equal(sold.calls.quotes.length + sold.calls.probes.length, 0);
  assert.equal(sold.calls.rejections[0].reason, 'CREATOR_ALREADY_SOLD');
});

void test('a probe skipped by the database is reported as SKIPPED', async () => {
  const { service, calls } = probeSetup({ probe: 'SKIPPED' });
  await service.onObserved('sig', ['M']);
  assert.equal(calls.probes.length, 1);
  assert.deepEqual(calls.probeEvents, [{ mint: 'M', outcome: 'SKIPPED' }]);
});
