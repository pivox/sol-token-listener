import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import { createExecutionOperationsService } from '../src/executor-operations/service.js';
import type { ExecutionOperationsRepository } from '../src/ports/execution-operations-repository.js';

const NOW_MS = 1_788_134_400_000;

void test('arms only after exact terminal authorization and persists its hash first', async () => {
  const calls: string[] = [];
  const qualification = fixtureQualification();
  const repository = repositoryStub({
    readQualification: async () => { calls.push('qualification'); return qualification; },
    recordAuthorization: async () => { calls.push('authorization'); return 'RECORDED'; },
    arm: async (armament) => { calls.push('arm'); return armament; },
  });
  const service = createExecutionOperationsService({
    repository,
    nonceSource: () => 'abcdef123456',
  });
  const armament = await service.arm({
    payloadVersion: 1,
    qualificationId: qualification.qualificationId,
    maximumCapitalLamports: 500_000n,
    maximumHoldingMs: 300_000,
    operatorId: 'operator-primary',
    operatorReason: 'Mainnet canary manually approved.',
    nowMs: NOW_MS + 1,
    terminal: {
      isTTY: true,
      write() {},
      readLine: async () => 'CONFIRM ARM CANARY 11111111 abcdef123456',
    },
  });
  assert.deepEqual(calls, ['qualification', 'authorization', 'arm']);
  assert.equal(armament.phase, 'CANARY');
  assert.equal(armament.maximumBuys, 1);
  assert.equal(armament.maximumExposureBps, 500n);
  assert.equal(armament.maximumOpenPositions, 1);
  assert.equal(JSON.stringify({ ...armament, maximumCapitalLamports: 'redacted', maximumExposureBps: 'redacted' })
    .includes('abcdef123456'), false);
});

void test('resume requires fresh terminal authorization before repository mutation', async () => {
  const calls: string[] = [];
  const qualification = fixtureQualification();
  const repository = repositoryStub({
    readQualification: async () => qualification,
    recordAuthorization: async () => { calls.push('authorization'); return 'RECORDED'; },
    resume: async () => {
      calls.push('resume');
      return {
        payloadVersion: 1, generationId: qualification.generationId,
        controlState: 'RUNNING', controlRevision: 1n,
        latestQualificationId: qualification.qualificationId,
        latestQualificationExpiresAtMs: qualification.expiresAtMs,
        activeArmamentId: null, activeArmamentPhase: null,
        activeArmamentExpiresAtMs: null,
      };
    },
  });
  const service = createExecutionOperationsService({ repository, nonceSource: () => 'abcdef123456' });
  const status = await service.resume({
    payloadVersion: 1,
    commandId: 'command:resume',
    qualificationId: qualification.qualificationId,
    operatorId: 'operator-primary',
    nowMs: NOW_MS + 1,
    terminal: {
      isTTY: true, write() {},
      readLine: async () => 'CONFIRM RESUME NONE 11111111 abcdef123456',
    },
  });
  assert.equal(status.controlState, 'RUNNING');
  assert.deepEqual(calls, ['authorization', 'resume']);
});

function repositoryStub(
  overrides: Partial<ExecutionOperationsRepository>,
): ExecutionOperationsRepository {
  const unavailable = async (): Promise<never> => { throw new Error('unexpected repository call'); };
  return {
    persistQualification: unavailable,
    readQualification: unavailable,
    recordAuthorization: unavailable,
    setStop: unavailable,
    resume: unavailable,
    arm: unavailable,
    readStatus: unavailable,
    ...overrides,
  };
}

function fixtureQualification() {
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return createSafetyQualification({
    payloadVersion: 1, evaluatorVersion: 1, phase: 'CANARY',
    buildHash: 'a'.repeat(64), configurationFingerprint: 'b'.repeat(64),
    strategyFingerprint: 'c'.repeat(64),
    generationId: `execution_wallet_generation_${'d'.repeat(64)}`,
    walletPublicKey: '11111111111111111111111111111111',
    cluster: 'mainnet-beta', genesisHash: '11111111111111111111111111111111',
    providerId: 'primary', qualifiedAtMs: NOW_MS, expiresAtMs: NOW_MS + 300_000,
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1, gateId, status: 'PASSED', evidenceType: evidenceTypes[index],
      evidenceId: `evidence:${index}`,
      evidenceFingerprint: index.toString(16).repeat(64),
      observedAtMs: NOW_MS - 1_000 + index, expiresAtMs: NOW_MS + 300_000,
    })),
  });
}
