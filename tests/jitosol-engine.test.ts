import assert from 'node:assert/strict';
import test from 'node:test';
import { JitoBotEngine } from '../src/jitosol/engine.js';
import { parseJitoBotConfig } from '../src/jitosol/config.js';
import type { ActionKind, JitoBotConfig, JitoGateway, JournalState, JournalStore, Observation, PendingTransaction, SignatureResult, TransactionEffects } from '../src/jitosol/types.js';

class MemoryJournal implements JournalStore {
  state: JournalState | null = null;
  saved: JournalState[] = [];
  crashOnPendingSave = false;
  async load(): Promise<JournalState | null> { return structuredClone(this.state); }
  async save(state: JournalState): Promise<void> {
    this.state = structuredClone(state); this.saved.push(structuredClone(state));
    if (this.crashOnPendingSave && state.pending) { this.crashOnPendingSave = false; throw new Error('simulated process crash after fsync'); }
  }
}

function fixture(overrides: Partial<JitoBotConfig> = {}) {
  const config = parseJitoBotConfig({ enabled: true, walletAddress: '11111111111111111111111111111111', maxTotalFeesLamports: '1000000', ...overrides });
  const store = new MemoryJournal();
  let now = 100_000; let quoteCount = 0; let stopped = false;
  let inactive = false; let observedCalls = 0; let claimChecks = 0;
  let modifyObservation: ((sample: Observation) => void) | undefined;
  let failBroadcast = false;
  const prepared: PendingTransaction[] = []; const broadcast: PendingTransaction[] = [];
  const prepareRequests: Parameters<JitoGateway['prepare']>[0][] = [];
  const results = new Map<string, SignatureResult>();
  const gateway: JitoGateway = {
    async observe(): Promise<Observation> {
      observedCalls++; quoteCount++;
      const sample: Observation = {
        observedAtMs: now,
        quote: { id: `quote-${quoteCount}`, receivedAtMs: now, contextSlot: 100 + quoteCount, routeSlot: 100 + quoteCount, inputMint: 'So11111111111111111111111111111111111111112', outputMint: config.jitoMintAddress, inputLamports: config.inputLamports, minJitoOutUnits: '3020000000', raw: { quoteCount } },
        pool: { address: config.stakePoolAddress, mint: config.jitoMintAddress, contextSlot: 100 + quoteCount, currentEpoch: 10, lastUpdateEpoch: 10, totalLamports: '1000000000000', tokenSupply: '1000000000000', withdrawalFeeNumerator: '0', withdrawalFeeDenominator: '1000' },
        withdrawal: { available: true, checkedAtMs: now, minimumDelegationLamports: '1000000000', stakeRentLamports: '2282880', tokenAccountRentLamports: '2039280', sourceStakeAddress: 'source-stake' },
        wallet: { address: config.walletAddress, solLamports: '9000000000', jitoUnits: '999999' },
      };
      modifyObservation?.(sample);
      return sample;
    },
    async prepare(request): Promise<PendingTransaction> {
      prepareRequests.push(structuredClone(request));
      if (request.kind === 'buy') assert.ok(request.observation);
      if (request.kind === 'deactivate' || request.kind === 'claim') assert.ok(request.position.stakeAddress);
      const transaction: PendingTransaction = {
        kind: request.kind, signature: `signature-${request.kind}-${prepared.length}`, wireTransactionBase64: Buffer.from(`signed-${request.kind}-${prepared.length}`).toString('base64'), lastValidBlockHeight: 200, preparedAtMs: now, estimatedFeeLamports: '5000',
        expected: request.kind === 'buy' ? { minJitoReceivedUnits: request.observation?.quote.minJitoOutUnits ?? '0' }
          : request.kind === 'withdraw' ? { stakeAddress: 'stake-from-signed-withdraw', jitoSpentUnits: request.position.actualJitoReceivedUnits, refundableRentLamports: '2282880', minimumRedemptionLamports: '3020000000' }
          : { stakeAddress: request.position.stakeAddress ?? 'missing', ...(request.kind === 'claim' ? { refundableRentLamports: request.position.stakeRentLamports } : {}) },
      };
      prepared.push(structuredClone(transaction));
      return transaction;
    },
    async broadcast(transaction): Promise<void> {
      assert.equal(store.state?.pending?.wireTransactionBase64, transaction.wireTransactionBase64, 'signed bytes must be durable before first send');
      assert.equal(store.state.pending.signature, transaction.signature);
      assert.equal(store.state.pending.lastValidBlockHeight, transaction.lastValidBlockHeight);
      broadcast.push(structuredClone(transaction));
      if (failBroadcast) throw new Error('connection dropped after possible send');
    },
    async poll(transaction) { return results.get(transaction.signature) ?? { status: 'pending' }; },
    async canClaim() { claimChecks++; return { inactive, observedAtMs: now, claimableLamports: '3022282880' }; },
  };
  function engine(customConfig = config) { return new JitoBotEngine({ config: customConfig, store, gateway, now: () => now, stopRequested: () => stopped }); }
  function finalize(effectsOverride: Partial<TransactionEffects> = {}) {
    const pending = store.state?.pending; assert.ok(pending);
    const effects: TransactionEffects = { feeLamports: '5000',
      ...(pending.kind === 'buy' ? { actualInputLamports: '3000000000', actualJitoReceivedUnits: '3020000123', refundableRentLamports: '2039280' } : {}),
      ...(pending.kind === 'withdraw' ? { actualJitoSpentUnits: '3020000123', stakeAddress: 'stake-from-signed-withdraw', refundableRentLamports: '2282880' } : {}),
      ...(pending.kind === 'deactivate' ? { stakeAddress: 'stake-from-signed-withdraw' } : {}),
      ...(pending.kind === 'claim' ? { actualClaimedLamports: '3022282880', refundableRentLamports: '2282880', stakeAddress: 'stake-from-signed-withdraw' } : {}),
      ...effectsOverride,
    };
    results.set(pending.signature, { status: 'finalized', effects });
  }
  return { config, store, gateway, engine, prepared, broadcast, prepareRequests, results, finalize,
    advance: (ms: number) => { now += ms; }, stop: (value: boolean) => { stopped = value; }, setInactive: (value: boolean) => { inactive = value; },
    modify: (fn: (sample: Observation) => void) => { modifyObservation = fn; }, failBroadcast: (value: boolean) => { failBroadcast = value; },
    get observedCalls() { return observedCalls; }, get claimChecks() { return claimChecks; },
  };
}

async function enter(f: ReturnType<typeof fixture>, engine = f.engine()) {
  assert.equal((await engine.tick()).status, 'waiting');
  f.advance(10_000);
  assert.equal((await engine.tick()).status, 'pending');
  return engine;
}

async function reachCooldown(f: ReturnType<typeof fixture>) {
  const engine = await enter(f);
  for (const kind of ['buy', 'withdraw', 'deactivate'] satisfies ActionKind[]) {
    assert.equal(f.store.state?.pending?.kind, kind);
    f.finalize(); await engine.tick();
    if (kind !== 'deactivate') await engine.tick();
  }
  return engine;
}

void test('cold startup disabled does not invoke journal, gateway, clock, or stop ports', async () => {
  const forbidden = () => { throw new Error('disabled port invoked'); };
  const engine = new JitoBotEngine({ config: parseJitoBotConfig({}), store: { load: forbidden, save: forbidden }, gateway: { observe: forbidden, prepare: forbidden, broadcast: forbidden, poll: forbidden, canClaim: forbidden }, now: forbidden, stopRequested: forbidden });
  assert.deepEqual(await engine.tick(), { status: 'disabled', reason: 'bot configuration is disabled' });
});

void test('withdrawal after a restart must retain the original economic floor before broadcast', async () => {
  const f = fixture(); await enter(f); f.finalize(); await f.engine().tick();
  const originalPrepare = f.gateway.prepare.bind(f.gateway);
  f.gateway.prepare = async (request) => {
    const pending = await originalPrepare(request);
    if (pending.kind === 'withdraw') pending.expected.minimumRedemptionLamports = '3011602739';
    return pending;
  };
  const result = await f.engine().tick();
  assert.equal(result.status, 'halted'); assert.match(result.reason, /economic floor/);
  assert.equal(f.broadcast.length, 1, 'only the original buy was sent');
  assert.equal(f.store.state?.position?.stage, 'purchased');
});

void test('two fresh qualifying observations at least ten seconds apart use the newer quote', async () => {
  const f = fixture(); const engine = f.engine();
  assert.equal((await engine.tick()).status, 'waiting');
  f.advance(9_999); assert.equal((await engine.tick()).status, 'waiting');
  assert.equal(f.prepared.length, 0);
  f.advance(1); assert.equal((await engine.tick()).status, 'pending');
  assert.equal(f.prepareRequests[0]?.observation?.quote.id, 'quote-3');
  assert.equal(f.prepared.length, 1);
});

void test('full cycle survives a session boundary and waits for actual inactivity beyond 72 hours', async () => {
  const f = fixture(); await reachCooldown(f);
  assert.equal(f.store.state?.position?.stage, 'deactivated');
  assert.equal(f.store.state?.position?.actualJitoReceivedUnits, '3020000123');
  assert.equal(f.prepareRequests[1]?.position.actualJitoReceivedUnits, '3020000123');
  assert.equal(f.store.state?.totalFeesLamports, '15000');
  assert.equal(f.store.state?.realizedLossLamports, '0', 'inventory is not a realized cash loss');
  const resumed = f.engine(); f.advance(72 * 60 * 60 * 1000);
  assert.equal((await resumed.tick()).status, 'waiting');
  assert.equal(f.prepared.length, 3);
  f.advance(24 * 60 * 60 * 1000); f.setInactive(true);
  assert.equal((await resumed.tick()).status, 'pending');
  assert.equal(f.prepared[3]?.kind, 'claim');
  f.finalize(); assert.equal((await resumed.tick()).status, 'complete');
  assert.equal(f.store.state?.completedCycles, 1);
  assert.equal(f.store.state?.totalFeesLamports, '20000');
  assert.equal(f.store.state?.realizedProfitLamports, '19980000');
  assert.equal(f.store.state?.completedPositions[0]?.tokenAccountRentLamports, '2039280');
  assert.equal(f.store.state?.position, undefined);
  assert.equal((await resumed.tick()).status, 'complete');
  assert.equal(f.observedCalls, 2);
});

void test('crash after durable prepare and before first send resumes identical bytes without preparing again', async () => {
  const f = fixture(); const engine = f.engine(); await engine.tick(); f.advance(10_000);
  f.store.crashOnPendingSave = true;
  await assert.rejects(engine.tick(), /simulated process crash/);
  assert.equal(f.broadcast.length, 0); assert.equal(f.prepared.length, 1);
  const saved = structuredClone(f.store.state?.pending);
  assert.equal((await f.engine().tick()).status, 'pending');
  assert.equal(f.prepared.length, 1);
  assert.equal(f.broadcast[0]?.wireTransactionBase64, saved?.wireTransactionBase64);
  assert.equal(f.broadcast[0]?.signature, saved?.signature);
});

void test('ambiguous send and restart poll finality before any new build or broadcast', async () => {
  const f = fixture(); f.failBroadcast(true); await enter(f);
  const pending = structuredClone(f.store.state?.pending); assert.ok(pending);
  assert.match(f.store.state?.pending?.lastBroadcastError ?? '', /connection dropped/);
  f.finalize(); const resumed = f.engine();
  assert.equal((await resumed.tick()).status, 'progress');
  assert.equal(f.broadcast.length, 1); assert.equal(f.prepared.length, 1);
  assert.equal(f.store.state?.transactions[0]?.transaction.wireTransactionBase64, pending.wireTransactionBase64);
});

void test('a crash while withdrawing retains the chosen stake account and never creates a replacement', async () => {
  const f = fixture(); const engine = await enter(f); f.finalize(); await engine.tick();
  f.store.crashOnPendingSave = true;
  await assert.rejects(engine.tick(), /simulated process crash/);
  const withdrawal = structuredClone(f.store.state?.pending); assert.ok(withdrawal);
  assert.equal(withdrawal.kind, 'withdraw');
  await f.engine().tick();
  assert.equal(f.prepared.length, 2);
  assert.equal(f.broadcast[1]?.signature, withdrawal.signature);
  assert.equal(f.broadcast[1]?.wireTransactionBase64, withdrawal.wireTransactionBase64);
  assert.equal(f.broadcast[1]?.expected.stakeAddress, withdrawal.expected.stakeAddress);
});

void test('a stale decision after signing is retained for inspection and never sent', async () => {
  const f = fixture(); const original = f.gateway.prepare;
  f.gateway.prepare = async (request) => {
    f.advance(6_000);
    return original(request);
  };
  const engine = f.engine(); await engine.tick(); f.advance(10_000);
  assert.equal((await engine.tick()).status, 'halted');
  assert.equal(f.broadcast.length, 0);
  assert.equal(f.store.state?.pending?.kind, 'buy');
});

void test('a stop raised during preparation persists the signed transaction before pausing its send', async () => {
  const f = fixture(); const original = f.gateway.prepare;
  f.gateway.prepare = async (request) => { const result = await original(request); f.stop(true); return result; };
  const engine = f.engine(); await engine.tick(); f.advance(10_000);
  assert.equal((await engine.tick()).status, 'paused');
  assert.equal(f.store.state?.pending?.kind, 'buy'); assert.equal(f.broadcast.length, 0);
  f.stop(false); await f.engine().tick();
  assert.equal(f.broadcast.length, 1); assert.equal(f.prepared.length, 1);
});

void test('a stop raised during the durable send-attempt write prevents the subsequent RPC send', async () => {
  const f = fixture(); const original = f.store.save.bind(f.store);
  f.store.save = async (state) => { await original(state); if (state.pending?.broadcastAttempts === 1) f.stop(true); };
  const engine = f.engine(); await engine.tick(); f.advance(10_000);
  assert.equal((await engine.tick()).status, 'paused');
  assert.equal(f.broadcast.length, 0); assert.equal(f.store.state?.pending?.kind, 'buy');
});

void test('a slow durable send-attempt write cannot broadcast a newly stale buy', async () => {
  const f = fixture(); const original = f.store.save.bind(f.store);
  f.store.save = async (state) => { await original(state); if (state.pending?.broadcastAttempts === 1) f.advance(6_000); };
  const engine = f.engine(); await engine.tick(); f.advance(10_000);
  assert.equal((await engine.tick()).status, 'pending');
  assert.equal(f.broadcast.length, 0); assert.equal(f.store.state?.pending?.kind, 'buy');
});

void test('buy broadcast freshness is measured from the quote rather than the later signing time', async () => {
  const f = fixture(); const originalPrepare = f.gateway.prepare;
  f.gateway.prepare = async (request) => { f.advance(3_000); return originalPrepare(request); };
  const originalSave = f.store.save.bind(f.store);
  f.store.save = async (state) => { await originalSave(state); if (state.pending?.broadcastAttempts === 1) f.advance(3_000); };
  const engine = f.engine(); await engine.tick(); f.advance(10_000);
  assert.equal((await engine.tick()).status, 'pending');
  assert.equal(f.broadcast.length, 0);
});

void test('pending transactions only rebroadcast their saved wire; stale unsent buys are monitored without send', async () => {
  const f = fixture(); const engine = await enter(f);
  const firstWire = f.broadcast[0]?.wireTransactionBase64;
  await engine.tick(); assert.equal(f.broadcast.length, 2);
  assert.equal(f.broadcast[1]?.wireTransactionBase64, firstWire);
  f.advance(6_000); await engine.tick();
  assert.equal(f.broadcast.length, 2); assert.equal(f.prepared.length, 1);
});

void test('unknown or expired finality halts with signed transaction retained for operator recovery', async () => {
  for (const status of ['unknown', 'expired'] as const) {
    const f = fixture(); const engine = await enter(f); const pending = f.store.state?.pending; assert.ok(pending);
    f.results.set(pending.signature, { status, reason: 'cannot establish finalized outcome' });
    assert.equal((await engine.tick()).status, 'halted');
    assert.equal(f.store.state?.pending?.signature, pending.signature);
    assert.equal((await f.engine().tick()).status, 'halted');
    assert.equal(f.prepared.length, 1); assert.equal(f.broadcast.length, 1);
  }
});

void test('a finalized failure records its fee exactly once and halts', async () => {
  const f = fixture(); const engine = await enter(f); const pending = f.store.state?.pending; assert.ok(pending);
  f.results.set(pending.signature, { status: 'failed', effects: { feeLamports: '5000' }, error: 'custom program error' });
  assert.equal((await engine.tick()).status, 'halted');
  assert.equal(f.store.state?.totalFeesLamports, '5000');
  assert.equal(f.store.state?.transactions[0]?.outcome, 'failed');
  assert.equal(f.store.state?.pending, undefined);
  await f.engine().tick(); assert.equal(f.store.state?.totalFeesLamports, '5000');
});

void test('changed wallet or financial authority rejects journal reuse before any gateway call', async () => {
  const f = fixture(); await enter(f);
  const changed = parseJitoBotConfig({ ...f.config, walletAddress: f.config.jitoMintAddress });
  await assert.rejects(f.engine(changed).tick(), /configuration.*match|fingerprint/i);
  assert.equal(f.prepared.length, 1); assert.equal(f.observedCalls, 2);
  const changedCaps = parseJitoBotConfig({ ...f.config, maxCycles: 2 });
  await assert.rejects(f.engine(changedCaps).tick(), /configuration.*match|fingerprint/i);
});

void test('zero fee authority and insufficient cycle budget prevent entry', async () => {
  for (const maxTotalFeesLamports of ['0', '999999']) {
    const f = fixture({ maxTotalFeesLamports });
    assert.equal((await f.engine().tick()).status, 'halted');
    assert.equal(f.observedCalls, 0); assert.equal(f.prepared.length, 0);
  }
});

void test('stop file blocks prepares and rebroadcasts while allowing finalized receipt accounting', async () => {
  const f = fixture(); const engine = f.engine(); f.stop(true);
  assert.equal((await engine.tick()).status, 'paused'); assert.equal(f.observedCalls, 0);
  f.stop(false); await enter(f, engine); f.stop(true);
  assert.equal((await engine.tick()).status, 'paused'); assert.equal(f.broadcast.length, 1);
  f.finalize(); assert.equal((await engine.tick()).status, 'progress');
  assert.equal((await engine.tick()).status, 'paused'); assert.equal(f.prepared.length, 1);
});

void test('observation failure or source staleness resets the confirmation requirement', async () => {
  const f = fixture(); const engine = f.engine(); await engine.tick(); f.advance(10_000);
  f.modify((sample) => { sample.quote.routeSlot = 1; });
  assert.equal((await engine.tick()).status, 'waiting'); assert.equal(f.store.state?.confirmation, undefined);
  f.modify(() => {}); assert.equal((await engine.tick()).status, 'waiting');
  f.advance(10_000); assert.equal((await engine.tick()).status, 'pending');
});

void test('confirmation expires across a long process interruption and cannot reuse a quote', async () => {
  const f = fixture(); const engine = f.engine(); await engine.tick(); f.advance(31_000);
  assert.equal((await f.engine().tick()).status, 'waiting'); assert.equal(f.prepared.length, 0);
  const quoteId = f.store.state?.confirmation?.quoteId;
  assert.ok(quoteId);
  f.advance(10_000); f.modify((sample) => { sample.quote.id = quoteId; });
  assert.equal((await engine.tick()).status, 'waiting'); assert.equal(f.prepared.length, 0);
});

void test('active position prevents overlapping observations and buys even with multiple allowed cycles', async () => {
  const f = fixture({ maxCycles: 2, maxTotalFeesLamports: '2000000' }); const engine = await enter(f);
  await engine.tick(); await engine.tick();
  assert.equal(f.observedCalls, 2); assert.equal(f.prepared.length, 1);
});

void test('realized losses compare economic proceeds after returned rent and actual fees', async () => {
  const f = fixture(); const engine = await reachCooldown(f); f.setInactive(true); await engine.tick();
  f.finalize({ actualClaimedLamports: '2992282880' });
  assert.equal((await engine.tick()).status, 'halted');
  assert.equal(f.store.state?.realizedLossLamports, '10020000');
  assert.equal(f.store.state?.completedCycles, 1);
});

void test('durable configurable cycle count allows exactly two completed cycles across restarts', async () => {
  const f = fixture({ maxCycles: 2, maxTotalFeesLamports: '2000000' });
  const first = await reachCooldown(f); f.setInactive(true); await first.tick(); f.finalize();
  assert.equal((await first.tick()).status, 'progress');
  const second = await reachCooldown(f); await second.tick(); f.finalize();
  assert.equal((await second.tick()).status, 'complete');
  assert.equal(f.store.state?.completedCycles, 2); assert.equal(f.store.state?.totalFeesLamports, '40000');
  const calls = f.observedCalls; await f.engine().tick();
  assert.equal(f.observedCalls, calls); assert.equal(f.prepared.filter((tx) => tx.kind === 'buy').length, 2);
});

void test('actual fees beyond authority are recorded before stopping further mutations', async () => {
  const f = fixture(); const engine = await enter(f); f.finalize({ feeLamports: '1000001' });
  assert.equal((await engine.tick()).status, 'halted');
  assert.equal(f.store.state?.totalFeesLamports, '1000001');
  assert.equal(f.store.state?.position?.stage, 'purchased');
  assert.equal(f.prepared.length, 1);
});

void test('buy delta below signed minimum and inconsistent withdrawal addresses halt after recording actual fees', async () => {
  const f = fixture(); const engine = await enter(f);
  f.finalize({ actualJitoReceivedUnits: '1' });
  assert.equal((await engine.tick()).status, 'halted'); assert.equal(f.store.state?.totalFeesLamports, '5000');
  const g = fixture(); const other = await enter(g); g.finalize(); await other.tick(); await other.tick();
  g.finalize({ stakeAddress: 'unexpected-stake' });
  assert.equal((await other.tick()).status, 'halted'); assert.equal(g.store.state?.totalFeesLamports, '10000');
});

void test('concurrent ticks on one engine are rejected before any duplicate prepare', async () => {
  const f = fixture(); const original = f.gateway.observe;
  let release!: () => void;
  f.gateway.observe = async (config) => { await new Promise<void>((resolve) => { release = resolve; }); return original(config); };
  const engine = f.engine(); const first = engine.tick();
  await assert.rejects(engine.tick(), /concurrent/i);
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  release(); await first;
  assert.equal(f.observedCalls, 1);
});
