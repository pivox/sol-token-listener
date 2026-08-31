import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionOperationsCliError,
  runExecutionOperationsCommand,
} from '../src/executor-operations/main.js';
import type { ExecutionOperationsService } from '../src/executor-operations/service.js';

void test('status emits one bounded versioned redacted JSON document', async () => {
  const output = await runExecutionOperationsCommand(['status'], environment(), {
    service: serviceStub({
      status: async (generationId) => ({
        payloadVersion: 1, generationId, controlState: 'ENTRY_STOP', controlRevision: 2n,
        latestQualificationId: null, latestQualificationExpiresAtMs: null,
        activeArmamentId: null, activeArmamentPhase: null, activeArmamentExpiresAtMs: null,
      }),
    }),
    terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async () => { throw new Error('not used'); },
    now: () => 1_000,
  });
  assert.deepEqual(JSON.parse(output), {
    payloadVersion: 1,
    command: 'status',
    controlState: 'ENTRY_STOP',
    controlRevision: '2',
    latestQualificationId: null,
    latestQualificationExpiresAtMs: null,
    activeArmamentId: null,
    activeArmamentPhase: null,
    activeArmamentExpiresAtMs: null,
    paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
    liveCapabilityPresent: false,
  });
  assert.equal(output.includes('postgresql://'), false);
});

void test('rejects unknown commands and malformed mutation arguments with a fixed error', async () => {
  const dependencies = {
    service: serviceStub({}),
    terminal: { isTTY: false, write() {}, readLine: async () => '' },
    readTextFile: async () => '',
    now: () => 1_000,
  };
  for (const argv of [
    [], ['unknown'], ['kill-switch'], ['kill-switch', '--mode=invalid'],
    ['arm', '--maximum-lamports=1.5'],
  ]) await assert.rejects(
    runExecutionOperationsCommand(argv, environment(), dependencies),
    (error) => error instanceof ExecutionOperationsCliError
      && error.code === 'INVALID_EXECUTION_OPERATIONS_COMMAND'
      && error.message === 'Execution operations command failed.',
  );
});

function serviceStub(overrides: Partial<ExecutionOperationsService>): ExecutionOperationsService {
  const unavailable = async (): Promise<never> => { throw new Error('unexpected service call'); };
  return {
    preflight: unavailable,
    status: unavailable,
    stop: unavailable,
    arm: unavailable,
    resume: unavailable,
    ...overrides,
  };
}

function environment() {
  return {
    DATABASE_URL: 'postgresql://localhost/solanabot',
    EXECUTOR_WALLET_GENERATION_ID: `execution_wallet_generation_${'a'.repeat(64)}`,
    EXECUTOR_PUBLIC_KEY: '11111111111111111111111111111111',
    SOLANA_EXPECTED_GENESIS_HASH: '11111111111111111111111111111111',
    EXECUTOR_RPC_PROVIDER_ID: 'primary', EXECUTOR_BUILD_HASH: 'b'.repeat(64),
    EXECUTOR_CONFIGURATION_FINGERPRINT: 'c'.repeat(64),
    EXECUTOR_STRATEGY_FINGERPRINT: 'd'.repeat(64), EXECUTOR_ACTIVATION_PHASE: 'CANARY',
    EXECUTOR_OPERATOR_ID: 'operator-primary',
    EXECUTOR_PREFLIGHT_EVIDENCE_PATH: '/tmp/preflight-evidence.json',
    LIVE_TRADING_ENABLED: 'false',
  };
}
