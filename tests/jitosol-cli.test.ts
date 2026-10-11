import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRuntimeConfig } from '../src/jitosol/runtime-config.js';
import { runJitoCli, type JitoCliDependencies } from '../src/jitosol/cli.js';
import type { JournalState } from '../src/jitosol/types.js';

function dependencies(config: unknown = {}): { deps: JitoCliDependencies; events: unknown[]; calls: string[] } {
  const events: unknown[] = []; const calls: string[] = [];
  const forbidden = (name: string): never => { calls.push(name); throw new Error(`Forbidden ${name}`); };
  return {
    events, calls,
    deps: {
      loadConfig: async () => parseRuntimeConfig(config, '/tmp/jito-cli-test'),
      readState: async () => forbidden('readState'),
      openStore: async () => forbidden('openStore'),
      loadSigner: async () => forbidden('loadSigner'),
      makeGateway: async () => forbidden('makeGateway'),
      observeMarket: async () => forbidden('observeMarket'),
      emit: (event) => events.push(event),
      now: () => 1000,
      delay: async () => forbidden('delay'),
      signal: new AbortController().signal,
      stopRequested: () => false,
    },
  };
}

void test('shipped defaults are disabled with zero fee authority and stable resolved paths', () => {
  const config = parseRuntimeConfig({}, '/tmp/operator');
  assert.equal(config.strategy.enabled, false);
  assert.equal(config.strategy.maxTotalFeesLamports, '0');
  assert.equal(config.runtime.keypairPath, '');
  assert.equal(config.strategy.stopFile, `${config.runtime.stateDirectory}/STOP`);
  assert.equal(parseRuntimeConfig({ runtime: { stateDirectory: './state', keypairPath: './key.json' } }, '/tmp/operator').runtime.keypairPath, '/tmp/operator/key.json');
});

void test('runtime rejects unknown settings, unsafe endpoints and a fee policy exceeding cycle allowance', () => {
  assert.throws(() => parseRuntimeConfig({ enabled: true }));
  assert.throws(() => parseRuntimeConfig({ runtime: { rpcUrl: 'http://rpc.example.com' } }));
  assert.throws(() => parseRuntimeConfig({ runtime: { rpcUrl: 'https://user:secret@rpc.example.com' } }));
  assert.throws(() => parseRuntimeConfig({ runtime: { maxTransactionFeeLamports: '1000001' } }));
});

void test('run defaults to disabled before filesystem journal, signer, gateway or network ports', async () => {
  const { deps, events, calls } = dependencies();
  assert.equal(await runJitoCli(['run'], deps), 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, [{ status: 'disabled', reason: 'Enable the configuration and pass --live to execute.' }]);
});

void test('a live flag alone never enables a disabled configuration', async () => {
  const { deps, calls } = dependencies();
  assert.equal(await runJitoCli(['run', '--live'], deps), 0);
  assert.deepEqual(calls, []);
});

void test('enabled configuration still requires explicit live flag before touching execution ports', async () => {
  const { deps, calls } = dependencies({ strategy: { enabled: true, walletAddress: '11111111111111111111111111111111' } });
  assert.equal(await runJitoCli(['run'], deps), 0);
  assert.deepEqual(calls, []);
});

void test('live mode refuses missing fee authority or keypair path before opening resources', async () => {
  const { deps, calls } = dependencies({ strategy: { enabled: true, walletAddress: '11111111111111111111111111111111' } });
  await assert.rejects(runJitoCli(['run', '--live'], deps), /JITO_LIVE_CONFIGURATION_INCOMPLETE/);
  assert.deepEqual(calls, []);
});

void test('offline status emits only a projection, never signed wire data or provider errors', async () => {
  const { deps, events, calls } = dependencies();
  deps.readState = async () => ({
    status: 'halted', sequence: 5, completedCycles: 0, totalFeesLamports: '5000', realizedProfitLamports: '0', realizedLossLamports: '0',
    haltReason: 'https://secret.example?api-key=PRIVATE',
    position: { stage: 'purchased', tokenAccountRentLamports: '2039280', stakeRentLamports: '0' },
    pending: { kind: 'withdraw', signature: 'public-signature', wireTransactionBase64: 'PRIVATE_SIGNED_WIRE', lastValidBlockHeight: 123 },
  } as JournalState);
  assert.equal(await runJitoCli(['status'], deps), 0);
  assert.deepEqual(calls, []);
  const printed = JSON.stringify(events);
  assert.match(printed, /public-signature/); assert.doesNotMatch(printed, /PRIVATE|secret.example|wireTransaction/);
});

void test('observe does not load a wallet or open an execution journal', async () => {
  const { deps, calls, events } = dependencies();
  deps.observeMarket = async () => ({ status: 'observed', walletChecked: false });
  assert.equal(await runJitoCli(['observe'], deps), 0);
  assert.deepEqual(calls, []); assert.equal(events.length, 1);
});

void test('invalid arguments fail before configuration or resource access', async () => {
  const { deps, calls } = dependencies();
  deps.loadConfig = async () => { throw new Error('must not read'); };
  await assert.rejects(runJitoCli(['status', '--live'], deps), /JITO_ARGUMENTS_INVALID/);
  await assert.rejects(runJitoCli(['run', '--config'], deps), /JITO_ARGUMENTS_INVALID/);
  await assert.rejects(runJitoCli(['run', '--live', '--live'], deps), /JITO_ARGUMENTS_INVALID/);
  assert.deepEqual(calls, []);
});

void test('foreground runtime limit closes signer and journal while retaining resumable state', async () => {
  const { deps, events, calls } = dependencies({
    strategy: { enabled: true, walletAddress: '11111111111111111111111111111111', maxTotalFeesLamports: '1000000' },
    runtime: { keypairPath: '/unused/mock-key', maxRuntimeSeconds: 1 },
  });
  let clock = 1000; let state: JournalState | null = null;
  deps.now = () => clock;
  deps.delay = async (ms) => { clock += ms; };
  deps.openStore = async () => ({ load: async () => state, save: async (value) => { state = structuredClone(value); }, close: async () => { calls.push('journal.close'); } });
  deps.loadSigner = async () => ({ publicKey: '11111111111111111111111111111111', signMessage: async () => { throw new Error('no signing expected'); }, close: async () => { calls.push('signer.close'); } });
  deps.makeGateway = async (_config, signer) => {
    assert.ok(signer);
    return {
      observe: async () => { throw new Error('fixed observational failure'); },
      prepare: async () => { throw new Error('no preparation expected'); },
      poll: async () => { throw new Error('no pending expected'); },
      broadcast: async () => { throw new Error('no broadcast expected'); },
      canClaim: async () => { throw new Error('no claim expected'); },
    };
  };
  assert.equal(await runJitoCli(['run', '--live'], deps), 0);
  assert.deepEqual(calls, ['signer.close', 'journal.close']);
  assert.ok(state); assert.match(JSON.stringify(events.at(-1)), /Runtime limit/);
});

void test('signer-load failure always releases the journal lock', async () => {
  const { deps, calls } = dependencies({
    strategy: { enabled: true, walletAddress: '11111111111111111111111111111111', maxTotalFeesLamports: '1000000' },
    runtime: { keypairPath: '/unused/mock-key' },
  });
  deps.openStore = async () => ({ load: async () => null, save: async () => {}, close: async () => { calls.push('journal.close'); } });
  deps.loadSigner = async () => { throw new Error('key unavailable'); };
  await assert.rejects(runJitoCli(['run', '--live'], deps), /key unavailable/);
  assert.deepEqual(calls, ['journal.close']);
});

void test('stop request prevents resource opening even with a live configuration', async () => {
  const { deps, calls } = dependencies({
    strategy: { enabled: true, walletAddress: '11111111111111111111111111111111', maxTotalFeesLamports: '1000000' },
    runtime: { keypairPath: '/unused/mock-key' },
  });
  deps.stopRequested = () => true;
  assert.equal(await runJitoCli(['run', '--live'], deps), 0);
  assert.deepEqual(calls, []);
});
