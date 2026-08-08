import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  parseRpcSoakOptions,
  runRpcSoakCli,
} from '../scripts/rpc-soak.js';
import type { RpcSoakReport } from '../src/solana/rpc/rpc-soak.js';

void test('parses bounded soak defaults and explicit integer settings', () => {
  assert.deepEqual(parseRpcSoakOptions({}), {
    durationMs: 60_000,
    intervalMs: 1_000,
  });
  assert.deepEqual(parseRpcSoakOptions({
    RPC_SOAK_DURATION_SECONDS: '5',
    RPC_SOAK_INTERVAL_MS: '2500',
  }), {
    durationMs: 5_000,
    intervalMs: 2_500,
  });
});

void test('rejects malformed, out-of-range and excessive sample settings', () => {
  for (const environment of [
    { RPC_SOAK_DURATION_SECONDS: ' 60' },
    { RPC_SOAK_DURATION_SECONDS: '5.5' },
    { RPC_SOAK_DURATION_SECONDS: '4' },
    { RPC_SOAK_DURATION_SECONDS: '3601' },
    { RPC_SOAK_INTERVAL_MS: '249' },
    { RPC_SOAK_INTERVAL_MS: '60001' },
    { RPC_SOAK_DURATION_SECONDS: '3600', RPC_SOAK_INTERVAL_MS: '250' },
  ]) {
    assert.throws(() => parseRpcSoakOptions(environment), TypeError);
  }
});

void test('writes exactly one report and maps verdicts to stable exit codes', async () => {
  for (const [verdict, expectedExitCode] of [
    ['PASS', 0],
    ['DEGRADED', 2],
    ['FAIL', 1],
  ] as const) {
    const output: string[] = [];
    let receivedOptions: unknown = null;
    const report = fakeReport(verdict);
    const exitCode = await runRpcSoakCli({
      environment: {
        RPC_SOAK_DURATION_SECONDS: '5',
        RPC_SOAK_INTERVAL_MS: '2500',
      },
      execute: async (options) => {
        receivedOptions = options;
        return report;
      },
      write: (line) => { output.push(line); },
    });

    assert.equal(exitCode, expectedExitCode);
    assert.deepEqual(receivedOptions, { durationMs: 5_000, intervalMs: 2_500 });
    assert.deepEqual(output, [`${JSON.stringify(report)}\n`]);
  }
});

void test('the command remains observation-only and independent from storage', async () => {
  const source = await readFile(new URL('../scripts/rpc-soak.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /database|private.?key|sendTransaction|simulateTransaction|signTransaction/iu);
  assert.match(source, /SolanaRpcSoakTransport/u);
  assert.match(source, /runRpcSoak/u);
});

function fakeReport(verdict: RpcSoakReport['verdict']): RpcSoakReport {
  return {
    schemaVersion: 'rpc-soak.v1',
    startedAtMs: 1,
    completedAtMs: 2,
    configuredDurationMs: 5_000,
    intervalMs: 2_500,
    sampleCount: 3,
    http: {
      attempted: 3,
      succeeded: 3,
      failed: 0,
      rateLimited: 0,
      failuresByCode: {
        RPC_RATE_LIMITED: 0,
        RPC_REQUEST_FAILED: 0,
        RPC_RESPONSE_INVALID: 0,
      },
      latencyMs: { min: 1, p50: 1, p95: 1, max: 1 },
      firstSlot: '1',
      lastSlot: '2',
    },
    websocket: {
      subscriptionState: 'ESTABLISHED',
      cleanupState: 'COMPLETED',
      observations: 2,
      pumpfunObservations: 1,
      pumpswapObservations: 1,
      firstSlot: '1',
      lastSlot: '2',
    },
    verdict,
    reasonCodes: [],
  };
}
