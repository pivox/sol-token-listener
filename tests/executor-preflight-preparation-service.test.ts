import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ClaimedExecutionPreflightPreparation,
  ExecutionPreflightPreparationV1,
} from '../src/domain/execution-preflight-preparation.js';
import {
  createExecutionPreflightIntentPreparationManifest,
} from '../src/executor-preflight-preparation/manifest.js';
import {
  createExecutionPreflightPreparationService,
  ExecutionPreflightPreparationServiceError,
  type ExecutionPreflightPreparationServiceDependencies,
  type ExecutionPreflightTargetWorkerFactoryInput,
} from '../src/executor-preflight-preparation/service.js';
import type {
  ExecutionPreflightIntentPreparationManifestInputV1,
} from '../src/executor-preflight-preparation/manifest.js';
import type {
  ExecutionPreflightPairSelectionV1,
  ExecutionPreflightPreparationRepository,
} from '../src/ports/execution-preflight-preparation-repository.js';
import { canonicalStringifyJson } from '../src/utils/json.js';

const HASH = 'a'.repeat(64);
const RUN_ID = `execution_preflight_preparation_${HASH}`;
const PAIR_ID = `execution_preflight_intent_pair_${'b'.repeat(64)}`;
const TARGET_ID = `execution_intent_${'c'.repeat(64)}`;
const SIMULATION_ID = `execution_intent_${'d'.repeat(64)}`;
const ASSESSMENT_ID = `execution_dry_run_assessment_${'e'.repeat(64)}`;
const ARTIFACT_ID = `execution_simulation_artifact_${'f'.repeat(64)}`;
const STARTED_AT_MS = 1_788_825_600_000;
const DEADLINE_AT_MS = STARTED_AT_MS + 120_000;
const PAIR_EXPIRES_AT_MS = STARTED_AT_MS + 90_000;
const PREPARED_AT_MS = STARTED_AT_MS + 5_000;
const SIGNAL = new AbortController().signal;

void test('prepares the first exact pair once from DB timestamps and commits its canonical manifest',
  async () => {
    const calls: string[] = [];
    const waiting = claim('WAITING', 0n);
    const selected = selection(claim('PREPARING', 1n));
    const renewed = claim('PREPARING', 2n);
    const assessed = claim('PREPARING', 3n, { assessment: true });
    const simulationRenewed = claim('PREPARING', 4n, { assessment: true });
    const evidenced = claim('PREPARING', 5n, {
      assessment: true,
      artifact: true,
      updatedAtMs: PREPARED_AT_MS,
    });
    let manifestFingerprint = '';
    const prepared = preparation('PREPARED', 6n, {
      assessment: true,
      artifact: true,
      updatedAtMs: PREPARED_AT_MS,
      completedAtMs: PREPARED_AT_MS + 1,
      manifestFingerprint: () => manifestFingerprint,
    });
    const repository: ExecutionPreflightPreparationRepository = {
      startOrResume: async (options, signal) => {
        calls.push('start');
        assert.deepEqual(options, Object.freeze({
          ownerId: 'executor-preflight-preparation',
          selectionWindowMs: 120_000,
          leaseMs: 60_000,
        }));
        assert.equal(signal, SIGNAL);
        return waiting;
      },
      selectFirstPair: async (input) => {
        calls.push('select');
        assert.equal(input, waiting);
        return selected;
      },
      expireWaitingWithoutPair: async () => { throw new Error('unexpected expiry'); },
      renew: async (input, leaseMs) => {
        calls.push('renew');
        assert.equal(input, selected.preparation);
        assert.equal(leaseMs, 60_000);
        return renewed;
      },
      bindTargetAssessment: async (input) => {
        calls.push('bind-target');
        assert.equal(input, renewed);
        return assessed;
      },
      bindSimulationArtifact: async (input) => {
        calls.push('bind-simulation');
        assert.equal(input, simulationRenewed);
        return evidenced;
      },
      markPrepared: async (input, options) => {
        calls.push('mark-prepared');
        assert.equal(input, evidenced);
        manifestFingerprint = options.manifestFingerprint;
        return prepared;
      },
      fail: async () => { throw new Error('unexpected failure'); },
      read: async () => { throw new Error('unexpected read'); },
    };
    const service = createExecutionPreflightPreparationService(Object.freeze({
      config: config(),
      preparations: repository,
      createTargetWorker: (input: ExecutionPreflightTargetWorkerFactoryInput) => {
        calls.push('create-target');
        assert.equal(Object.isFrozen(input), true);
        assert.equal(input.preparationClaim, renewed);
        assert.equal(input.pair, selected);
        return Object.freeze({ runOnce: async (signal: AbortSignal) => {
          calls.push('target');
          assert.equal(signal, SIGNAL);
          return 'RECORDED' as const;
        } });
      },
      createSimulationWorker: (input: ExecutionPreflightTargetWorkerFactoryInput) => {
        calls.push('create-simulation');
        assert.equal(Object.isFrozen(input), true);
        assert.equal(input.preparationClaim, assessed);
        assert.equal(input.pair, selected);
        return Object.freeze({
          runOnce: async (signal: AbortSignal) => {
            calls.push('simulation');
            assert.equal(signal, SIGNAL);
            return Object.freeze({
              kind: 'RECORDED' as const,
              mode: 'simulation-only' as const,
              intentId: SIMULATION_ID,
              side: 'BUY' as const,
              outcome: 'SIMULATION_SUCCEEDED' as const,
              reasonCode: 'INTENT_SUCCEEDED' as const,
              providerId: 'primary',
            });
          },
          currentPreparationClaim: () => simulationRenewed,
        });
      },
      manifestWriter: Object.freeze({ write: async (
        path: string,
        input: ExecutionPreflightIntentPreparationManifestInputV1,
      ) => {
        calls.push('write-manifest');
        assert.equal(path, '/var/tmp/preflight-prepared.json');
        assert.equal(Object.isFrozen(input), true);
        assert.deepEqual(input, {
          runId: RUN_ID,
          runFingerprint: HASH,
          pairId: PAIR_ID,
          pairFingerprint: 'b'.repeat(64),
          targetIntentId: TARGET_ID,
          simulationIntentId: SIMULATION_ID,
          assessmentId: ASSESSMENT_ID,
          assessmentFingerprint: 'e'.repeat(64),
          artifactId: ARTIFACT_ID,
          artifactFingerprint: 'f'.repeat(64),
          createdAtMs: STARTED_AT_MS,
          preparedAtMs: PREPARED_AT_MS,
          expiresAtMs: PAIR_EXPIRES_AT_MS,
          purgeAfterMs: PREPARED_AT_MS + 4 * 60 * 60 * 1_000,
        });
        return createExecutionPreflightIntentPreparationManifest(input);
      } }),
      delay: async () => { throw new Error('unexpected delay'); },
    }));

    const result = await service.run(SIGNAL);

    assert.equal(result, prepared);
    assert.deepEqual(calls, [
      'start', 'select', 'renew', 'create-target', 'target', 'bind-target',
      'create-simulation', 'simulation', 'bind-simulation', 'write-manifest',
      'mark-prepared',
    ]);
    const expectedManifest = createExecutionPreflightIntentPreparationManifest(Object.freeze({
      runId: RUN_ID,
      runFingerprint: HASH,
      pairId: PAIR_ID,
      pairFingerprint: 'b'.repeat(64),
      targetIntentId: TARGET_ID,
      simulationIntentId: SIMULATION_ID,
      assessmentId: ASSESSMENT_ID,
      assessmentFingerprint: 'e'.repeat(64),
      artifactId: ARTIFACT_ID,
      artifactFingerprint: 'f'.repeat(64),
      createdAtMs: STARTED_AT_MS,
      preparedAtMs: PREPARED_AT_MS,
      expiresAtMs: PAIR_EXPIRES_AT_MS,
      purgeAfterMs: PREPARED_AT_MS + 4 * 60 * 60 * 1_000,
    }));
    assert.equal(manifestFingerprint, createHash('sha256')
      .update(canonicalStringifyJson(expectedManifest), 'utf8').digest('hex'));
  });

void test('polls with an abortable delay and renews the same waiting run before selecting',
  async () => {
    const calls: string[] = [];
    const waiting = claim('WAITING', 0n);
    const renewedWaiting = claim('WAITING', 1n);
    const selected = selection(claim('PREPARING', 2n));
    const beforeTarget = claim('PREPARING', 3n);
    const assessed = claim('PREPARING', 4n, { assessment: true });
    const evidenced = claim('PREPARING', 5n, {
      assessment: true, artifact: true, updatedAtMs: PREPARED_AT_MS,
    });
    let selections = 0;
    let expiryChecks = 0;
    const service = serviceWith({
      calls,
      repository: {
        startOrResume: async () => { calls.push('start'); return waiting; },
        selectFirstPair: async (input) => {
          calls.push('select');
          selections += 1;
          if (selections === 1) { assert.equal(input, waiting); return null; }
          assert.equal(input, renewedWaiting);
          return selected;
        },
        expireWaitingWithoutPair: async (input) => {
          calls.push('expire');
          assert.equal(input, waiting);
          expiryChecks += 1;
          return null;
        },
        renew: async (input) => {
          calls.push('renew');
          return input.preparation.state === 'WAITING' ? renewedWaiting : beforeTarget;
        },
        bindTargetAssessment: async () => { calls.push('bind-target'); return assessed; },
        bindSimulationArtifact: async () => {
          calls.push('bind-simulation'); return evidenced;
        },
      },
      delay: async (delayMs, signal) => {
        calls.push('delay');
        assert.equal(delayMs, 1_000);
        assert.equal(signal, SIGNAL);
      },
    });

    const result = await service.run(SIGNAL);

    assert.equal(result.state, 'PREPARED');
    assert.equal(expiryChecks, 2);
    assert.deepEqual(calls.slice(0, 8), [
      'start', 'select', 'expire', 'delay', 'expire', 'renew', 'select', 'renew',
    ]);
  });

void test('resumes an assessment-bound run without constructing or running TARGET', async () => {
  const calls: string[] = [];
  const assessed = claim('PREPARING', 3n, { assessment: true });
  const selected = selection(assessed);
  const renewed = claim('PREPARING', 4n, { assessment: true });
  const evidenced = claim('PREPARING', 5n, {
    assessment: true, artifact: true, updatedAtMs: PREPARED_AT_MS,
  });
  const service = serviceWith({
    calls,
    repository: {
      startOrResume: async () => { calls.push('start'); return assessed; },
      selectFirstPair: async () => { calls.push('select'); return selected; },
      renew: async () => { calls.push('renew'); return renewed; },
      bindSimulationArtifact: async () => {
        calls.push('bind-simulation'); return evidenced;
      },
    },
    createTargetWorker: () => { throw new Error('TARGET must be skipped'); },
  });

  const result = await service.run(SIGNAL);

  assert.equal(result.state, 'PREPARED');
  assert.deepEqual(calls, [
    'start', 'select', 'renew', 'create-simulation', 'simulation',
    'bind-simulation', 'write-manifest', 'mark-prepared',
  ]);
});

void test('resumes an artifact-bound run by replaying only the deterministic manifest', async () => {
  const calls: string[] = [];
  const evidenced = claim('PREPARING', 5n, {
    assessment: true, artifact: true, updatedAtMs: PREPARED_AT_MS,
  });
  const renewed = claim('PREPARING', 6n, {
    assessment: true, artifact: true, updatedAtMs: PREPARED_AT_MS,
  });
  const service = serviceWith({
    calls,
    repository: {
      startOrResume: async () => { calls.push('start'); return evidenced; },
      selectFirstPair: async () => { calls.push('select'); return selection(evidenced); },
      renew: async () => { calls.push('renew'); return renewed; },
    },
    createTargetWorker: () => { throw new Error('TARGET must be skipped'); },
    createSimulationWorker: () => { throw new Error('SIMULATION must be skipped'); },
  });

  const result = await service.run(SIGNAL);

  assert.equal(result.state, 'PREPARED');
  assert.deepEqual(calls, ['start', 'select', 'renew', 'write-manifest', 'mark-prepared']);
});

void test('returns the terminal PREFLIGHT_PAIR_NOT_FOUND run at the DB deadline', async () => {
  const calls: string[] = [];
  const waiting = claim('WAITING', 0n);
  const failed = preparation('FAILED', 1n, {
    pair: false,
    failureCode: 'PREFLIGHT_PAIR_NOT_FOUND',
    completedAtMs: DEADLINE_AT_MS,
  });
  let expiryChecks = 0;
  const service = serviceWith({
    calls,
    repository: {
      startOrResume: async () => { calls.push('start'); return waiting; },
      selectFirstPair: async () => { calls.push('select'); return null; },
      expireWaitingWithoutPair: async () => {
        calls.push('expire');
        expiryChecks += 1;
        return expiryChecks === 1 ? null : failed;
      },
    },
    delay: async () => { calls.push('delay'); },
  });

  assert.equal(await service.run(SIGNAL), failed);
  assert.deepEqual(calls, ['start', 'select', 'expire', 'delay', 'expire']);
});

void test('closes TARGET idle as PREFLIGHT_TARGET_FENCE_LOST', async () => {
  const calls: string[] = [];
  const selectedClaim = claim('PREPARING', 1n);
  const renewed = claim('PREPARING', 2n);
  const failed = preparation('FAILED', 3n, {
    failureCode: 'PREFLIGHT_TARGET_FENCE_LOST', completedAtMs: PREPARED_AT_MS,
  });
  const service = serviceWith({
    calls,
    repository: {
      startOrResume: async () => selectedClaim,
      selectFirstPair: async () => selection(selectedClaim),
      renew: async () => renewed,
      fail: async (input, code) => {
        calls.push(`fail:${code}`);
        assert.equal(input, renewed);
        return failed;
      },
    },
    targetResult: 'IDLE',
  });

  assert.equal(await service.run(SIGNAL), failed);
  assert.deepEqual(calls, ['create-target', 'target', 'fail:PREFLIGHT_TARGET_FENCE_LOST']);
});

void test('closes every non-success simulation outcome as PREFLIGHT_SIMULATION_FAILED',
  async () => {
    for (const simulationResult of ['IDLE', simulationFailure()] as const) {
      const calls: string[] = [];
      const assessed = claim('PREPARING', 3n, { assessment: true });
      const selected = selection(assessed);
      const renewed = claim('PREPARING', 4n, { assessment: true });
      const failed = preparation('FAILED', 5n, {
        assessment: true,
        failureCode: 'PREFLIGHT_SIMULATION_FAILED',
        completedAtMs: PREPARED_AT_MS,
      });
      const service = serviceWith({
        calls,
        repository: {
          startOrResume: async () => assessed,
          selectFirstPair: async () => selected,
          renew: async () => renewed,
          fail: async (input, code) => {
            calls.push(`fail:${code}`);
            assert.equal(input, renewed);
            return failed;
          },
        },
        simulationResult,
        createTargetWorker: () => { throw new Error('TARGET must be skipped'); },
      });

      assert.equal(await service.run(SIGNAL), failed);
      assert.deepEqual(calls, [
        'create-simulation', 'simulation', 'fail:PREFLIGHT_SIMULATION_FAILED',
      ]);
    }
  });

void test('throws one redacted recoverable error on preparation lease loss', async () => {
  const secret = 'lease-secret-that-must-not-leak';
  const selectedClaim = claim('PREPARING', 1n);
  const service = serviceWith({
    repository: {
      startOrResume: async () => selectedClaim,
      selectFirstPair: async () => selection(selectedClaim),
      renew: async () => { throw new Error(secret); },
    },
  });

  await assert.rejects(service.run(SIGNAL), (error: unknown) => {
    assert.ok(error instanceof ExecutionPreflightPreparationServiceError);
    assert.equal(error.code, 'EXECUTION_PREFLIGHT_PREPARATION_FAILED');
    assert.equal(error.recoverable, true);
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret, 'u'));
    return true;
  });
});

void test('closes a manifest write failure without exposing its cause', async () => {
  const calls: string[] = [];
  const secret = 'filesystem-secret';
  const evidenced = claim('PREPARING', 5n, {
    assessment: true, artifact: true, updatedAtMs: PREPARED_AT_MS,
  });
  const renewed = claim('PREPARING', 6n, {
    assessment: true, artifact: true, updatedAtMs: PREPARED_AT_MS,
  });
  const failed = preparation('FAILED', 7n, {
    assessment: true,
    artifact: true,
    failureCode: 'PREFLIGHT_PREPARATION_EXPORT_FAILED',
    completedAtMs: PREPARED_AT_MS + 1,
  });
  const service = serviceWith({
    calls,
    repository: {
      startOrResume: async () => evidenced,
      selectFirstPair: async () => selection(evidenced),
      renew: async () => renewed,
      fail: async (input, code) => {
        calls.push(`fail:${code}`);
        assert.equal(input, renewed);
        return failed;
      },
    },
    manifestWriter: Object.freeze({ write: async () => {
      calls.push('write-manifest');
      throw new Error(secret);
    } }),
    createTargetWorker: () => { throw new Error('TARGET must be skipped'); },
    createSimulationWorker: () => { throw new Error('SIMULATION must be skipped'); },
  });

  const result = await service.run(SIGNAL);

  assert.equal(result, failed);
  assert.doesNotMatch(JSON.stringify(result, (_key: string, value: unknown): unknown => (
    typeof value === 'bigint' ? value.toString() : value
  )), new RegExp(secret, 'u'));
  assert.deepEqual(calls, [
    'write-manifest', 'fail:PREFLIGHT_PREPARATION_EXPORT_FAILED',
  ]);
});

void test('recovers an uncertain mark commit only from the exact stored fingerprint', async () => {
  const calls: string[] = [];
  const evidenced = claim('PREPARING', 5n, {
    assessment: true, artifact: true, updatedAtMs: PREPARED_AT_MS,
  });
  const renewed = claim('PREPARING', 6n, {
    assessment: true, artifact: true, updatedAtMs: PREPARED_AT_MS,
  });
  let expectedFingerprint = '';
  const service = serviceWith({
    calls,
    repository: {
      startOrResume: async () => evidenced,
      selectFirstPair: async () => selection(evidenced),
      renew: async () => renewed,
      markPrepared: async (_input, options) => {
        calls.push('mark-prepared');
        expectedFingerprint = options.manifestFingerprint;
        throw new Error('commit outcome unknown with sensitive transport');
      },
      read: async (runId) => {
        calls.push('read');
        assert.equal(runId, RUN_ID);
        return preparation('PREPARED', 7n, {
          assessment: true,
          artifact: true,
          updatedAtMs: PREPARED_AT_MS,
          completedAtMs: PREPARED_AT_MS + 1,
          manifestFingerprint: () => expectedFingerprint,
        });
      },
    },
    createTargetWorker: () => { throw new Error('TARGET must be skipped'); },
    createSimulationWorker: () => { throw new Error('SIMULATION must be skipped'); },
  });

  const result = await service.run(SIGNAL);

  assert.equal(result.state, 'PREPARED');
  assert.equal(result.manifestFingerprint, expectedFingerprint);
  assert.deepEqual(calls, ['write-manifest', 'mark-prepared', 'read']);
});

void test('rejects an abort during polling as a redacted recoverable error', async () => {
  const controller = new AbortController();
  const waiting = claim('WAITING', 0n);
  const service = serviceWith({
    repository: {
      startOrResume: async () => waiting,
      selectFirstPair: async () => null,
      expireWaitingWithoutPair: async () => null,
    },
    delay: async (_delayMs, signal) => {
      controller.abort('sensitive-abort-reason');
      assert.equal(signal.aborted, true);
      throw signal.reason;
    },
  });

  await assert.rejects(service.run(controller.signal), (error: unknown) => {
    assert.ok(error instanceof ExecutionPreflightPreparationServiceError);
    assert.equal(error.recoverable, true);
    assert.doesNotMatch(JSON.stringify(error), /sensitive-abort-reason/u);
    return true;
  });
});

void test('is permanently one-shot and never starts a second run', async () => {
  const starts: string[] = [];
  const service = serviceWith({
    repository: {
      startOrResume: async () => { starts.push('start'); return claim('PREPARING', 1n); },
    },
  });

  const [first, concurrent] = await Promise.all([service.run(SIGNAL), service.run(SIGNAL)]);
  const replay = await service.run(SIGNAL);

  assert.equal(first, concurrent);
  assert.equal(replay, first);
  assert.deepEqual(starts, ['start']);
});

void test('rejects mutable service dependencies before repository access', () => {
  let starts = 0;
  const repository = {
    startOrResume: async () => { starts += 1; return claim('WAITING', 0n); },
  } as unknown as ExecutionPreflightPreparationRepository;
  assert.throws(() => createExecutionPreflightPreparationService({
    config: config(),
    preparations: repository,
    createTargetWorker: () => { throw new Error('unreachable'); },
    createSimulationWorker: () => { throw new Error('unreachable'); },
    manifestWriter: Object.freeze({ write: async () => { throw new Error('unreachable'); } }),
    delay: async () => undefined,
  }), ExecutionPreflightPreparationServiceError);
  assert.equal(starts, 0);
});

void test('rejects a substituted pair on resume before renewing or constructing workers',
  async () => {
    const calls: string[] = [];
    const resumed = claim('PREPARING', 3n, { assessment: true });
    const substitutedPairId = `execution_preflight_intent_pair_${'9'.repeat(64)}`;
    const substitutedClaim = Object.freeze({
      ...resumed,
      preparation: Object.freeze({ ...resumed.preparation, pairId: substitutedPairId }),
    });
    const substituted = Object.freeze({
      ...selection(substitutedClaim),
      pairId: substitutedPairId,
    });
    const service = serviceWith({
      calls,
      repository: {
        startOrResume: async () => resumed,
        selectFirstPair: async () => substituted,
        renew: async () => { calls.push('renew'); return substitutedClaim; },
      },
    });

    await assert.rejects(service.run(SIGNAL), ExecutionPreflightPreparationServiceError);
    assert.deepEqual(calls, []);
  });

type RepositoryOverrides = Partial<ExecutionPreflightPreparationRepository>;

interface ServiceOverrides {
  readonly calls?: string[];
  readonly repository?: RepositoryOverrides;
  readonly delay?: ExecutionPreflightPreparationServiceDependencies['delay'];
  readonly createTargetWorker?: ExecutionPreflightPreparationServiceDependencies[
    'createTargetWorker'
  ];
  readonly createSimulationWorker?: ExecutionPreflightPreparationServiceDependencies[
    'createSimulationWorker'
  ];
  readonly manifestWriter?: ExecutionPreflightPreparationServiceDependencies['manifestWriter'];
  readonly targetResult?: 'IDLE' | 'RECORDED' | 'COMMIT_RECOVERED';
  readonly simulationResult?: Awaited<ReturnType<
    ReturnType<ExecutionPreflightPreparationServiceDependencies[
      'createSimulationWorker'
    ]>['runOnce']
  >>;
}

function serviceWith(overrides: ServiceOverrides = {}) {
  const calls = overrides.calls ?? [];
  const defaultSelectedClaim = claim('PREPARING', 1n);
  const defaultRenewed = claim('PREPARING', 2n);
  const defaultAssessed = claim('PREPARING', 3n, { assessment: true });
  const defaultEvidenced = claim('PREPARING', 4n, {
    assessment: true, artifact: true, updatedAtMs: PREPARED_AT_MS,
  });
  const repository: ExecutionPreflightPreparationRepository = {
    startOrResume: async () => defaultSelectedClaim,
    selectFirstPair: async () => selection(defaultSelectedClaim),
    expireWaitingWithoutPair: async () => null,
    renew: async () => defaultRenewed,
    bindTargetAssessment: async () => defaultAssessed,
    bindSimulationArtifact: async () => defaultEvidenced,
    markPrepared: async (input, options) => {
      calls.push('mark-prepared');
      return preparation('PREPARED', input.preparation.stateRevision + 1n, {
        assessment: true,
        artifact: true,
        updatedAtMs: input.preparation.updatedAtMs,
        completedAtMs: input.preparation.updatedAtMs + 1,
        manifestFingerprint: () => options.manifestFingerprint,
      });
    },
    fail: async () => { throw new Error('unexpected failure'); },
    read: async () => { throw new Error('unexpected read'); },
    ...overrides.repository,
  };
  return createExecutionPreflightPreparationService(Object.freeze({
    config: config(),
    preparations: repository,
    createTargetWorker: overrides.createTargetWorker ?? (() => {
      calls.push('create-target');
      return Object.freeze({ runOnce: async () => {
        calls.push('target');
        return overrides.targetResult ?? 'RECORDED';
      } });
    }),
    createSimulationWorker: overrides.createSimulationWorker ?? ((
      input: ExecutionPreflightTargetWorkerFactoryInput,
    ) => {
      calls.push('create-simulation');
      return Object.freeze({
        runOnce: async () => {
          calls.push('simulation');
          return overrides.simulationResult ?? simulationSuccess();
        },
        currentPreparationClaim: () => input.preparationClaim,
      });
    }),
    manifestWriter: overrides.manifestWriter ?? Object.freeze({ write: async (
      _path: string,
      input: ExecutionPreflightIntentPreparationManifestInputV1,
    ) => {
      calls.push('write-manifest');
      return createExecutionPreflightIntentPreparationManifest(input);
    } }),
    delay: overrides.delay ?? (async () => { throw new Error('unexpected delay'); }),
  }));
}

function simulationSuccess() {
  return Object.freeze({
    kind: 'RECORDED' as const,
    mode: 'simulation-only' as const,
    intentId: SIMULATION_ID,
    side: 'BUY' as const,
    outcome: 'SIMULATION_SUCCEEDED' as const,
    reasonCode: 'INTENT_SUCCEEDED' as const,
    providerId: 'primary',
  });
}

function simulationFailure() {
  return Object.freeze({
    kind: 'RECORDED' as const,
    mode: 'simulation-only' as const,
    intentId: SIMULATION_ID,
    side: 'BUY' as const,
    outcome: 'SIMULATION_FAILED' as const,
    reasonCode: 'BUY_SIMULATION_FAILED' as const,
    providerId: 'primary',
  });
}

function config() {
  return Object.freeze({
    payloadVersion: 1 as const,
    enabled: true as const,
    selectionWindowMs: 120_000,
    preparationLeaseMs: 60_000,
    outputPath: '/var/tmp/preflight-prepared.json',
    executor: Object.freeze({ pollMs: 1_000 }),
  });
}

function selection(
  preparationClaim: ClaimedExecutionPreflightPreparation,
): ExecutionPreflightPairSelectionV1 {
  return Object.freeze({
    preparation: preparationClaim,
    pairId: PAIR_ID,
    pairFingerprint: 'b'.repeat(64),
    targetIntentId: TARGET_ID,
    simulationIntentId: SIMULATION_ID,
    decisionEventId: 'event-1',
    decisionFingerprint: '1'.repeat(64),
    pairCreatedAtMs: STARTED_AT_MS + 1_000,
    pairExpiresAtMs: PAIR_EXPIRES_AT_MS,
  });
}

function claim(
  state: 'WAITING' | 'PREPARING',
  revision: bigint,
  options: {
    readonly assessment?: boolean;
    readonly artifact?: boolean;
    readonly pair?: boolean;
    readonly updatedAtMs?: number;
  } = {},
): ClaimedExecutionPreflightPreparation {
  return Object.freeze({
    preparation: preparation(state, revision, options),
    leaseOwner: 'executor-preflight-preparation',
    leaseToken: '00000000-0000-4000-8000-000000000001',
    leaseExpiresAtMs: DEADLINE_AT_MS - 5_000,
  });
}

function preparation(
  state: 'WAITING' | 'PREPARING' | 'PREPARED' | 'FAILED',
  revision: bigint,
  options: {
    readonly assessment?: boolean;
    readonly artifact?: boolean;
    readonly pair?: boolean;
    readonly updatedAtMs?: number;
    readonly completedAtMs?: number;
    readonly manifestFingerprint?: () => string;
    readonly failureCode?: ExecutionPreflightPreparationV1['failureCode'];
  } = {},
): ExecutionPreflightPreparationV1 {
  return Object.freeze({
    payloadVersion: 1,
    runId: RUN_ID,
    runFingerprint: HASH,
    state,
    stateRevision: revision,
    watermarkAtMs: STARTED_AT_MS,
    deadlineAtMs: DEADLINE_AT_MS,
    pairId: state === 'WAITING' || options.pair === false ? null : PAIR_ID,
    assessmentId: options.assessment === true ? ASSESSMENT_ID : null,
    assessmentFingerprint: options.assessment === true ? 'e'.repeat(64) : null,
    artifactId: options.artifact === true ? ARTIFACT_ID : null,
    artifactFingerprint: options.artifact === true ? 'f'.repeat(64) : null,
    manifestFingerprint: options.manifestFingerprint?.() ?? null,
    failureCode: options.failureCode ?? null,
    createdAtMs: STARTED_AT_MS,
    updatedAtMs: options.updatedAtMs ?? STARTED_AT_MS,
    selectedAtMs: state === 'WAITING' ? null : STARTED_AT_MS + 1_000,
    completedAtMs: options.completedAtMs ?? null,
    purgeAfterMs: options.completedAtMs === undefined
      ? null
      : options.completedAtMs + 4 * 60 * 60 * 1_000,
  });
}
