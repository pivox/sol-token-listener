import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { createSignedTransactionArtifact } from '../src/domain/execution-live.js';
import { createExecutionIntentDraft, type ExecutionIntentV1 } from '../src/domain/execution-intent.js';
import {
  executeLivePreparedTransaction,
  resumeLivePersistedTransaction,
  type LiveExecutionWorkerDependencies,
} from '../src/executor-live/execution-worker.js';
import { SignedSimulationGatewayError } from '../src/executor-live/signed-simulation-gateway.js';
import { LiveSubmissionGatewayError } from '../src/executor-live/submission-gateway.js';
import {
  ExecutionLiveRepositoryError,
  type ExecutionLiveRepositoryErrorCode,
} from '../src/storage/execution-live.repository.js';
import type {
  ExecutionLiveSignedTransactionInspectionV1,
  ExecutionLiveSignedSimulationEvidenceV1,
  ExecutionLiveSubmissionOutcomeV1,
  ExecutionPreSubmissionRevocationInputV1,
} from '../src/ports/execution-live-repository.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';

void test('orders persistence, signed simulation, submission fence and RPC exactly once', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const dependencies = dependenciesFor(fixture, calls, false);

  const result = await executeLivePreparedTransaction(
    dependencies, fixture.input, new AbortController().signal,
  );

  assert.equal(result.kind, 'ACCEPTED');
  assert.deepEqual(calls, [
    'inspect', 'persist', 'inspect', 'signed-simulate', 'record-signed-simulation',
    'begin-submission', 'rpc-submit', 'record-accepted',
  ]);
});

void test('records ambiguity after the durable submission fence and never retries', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const result = await executeLivePreparedTransaction(
    dependenciesFor(fixture, calls, true), fixture.input,
    new AbortController().signal,
  );
  assert.equal(result.kind, 'AMBIGUOUS');
  assert.deepEqual(calls, [
    'inspect', 'persist', 'inspect', 'signed-simulate', 'record-signed-simulation',
    'begin-submission', 'rpc-submit', 'record-ambiguous',
  ]);
  assert.equal(calls.filter((call) => call === 'rpc-submit').length, 1);
});

void test('does not rewrite an accepted outcome as ambiguous when its commit is unknown', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  await assert.rejects(executeLivePreparedTransaction(
    dependenciesFor(fixture, calls, false, true), fixture.input,
    new AbortController().signal,
  ), /accepted outcome commit unknown/u);
  assert.deepEqual(calls, [
    'inspect', 'persist', 'inspect', 'signed-simulate', 'record-signed-simulation',
    'begin-submission', 'rpc-submit', 'record-accepted',
  ]);
});

for (const code of ['SIGNED_TRANSACTION_INVALID', 'SIGNED_SIMULATION_INCONSISTENT'] as const) {
  void test(`revokes persisted bytes without send after deterministic ${code}`, async () => {
    const fixture = workerFixture();
    const calls: string[] = [];

    await assert.rejects(
      executeLivePreparedTransaction(
        dependenciesFor(fixture, calls, false, false, code),
        fixture.input,
        new AbortController().signal,
      ),
      (error: unknown) => error instanceof SignedSimulationGatewayError && error.code === code,
    );

    assert.deepEqual(calls, [
      'inspect', 'persist', 'inspect', 'signed-simulate', 'revoke-before-submission',
    ]);
  });
}

void test('does not classify an unavailable signed simulation provider as deterministic', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  await assert.rejects(
    executeLivePreparedTransaction(
      dependenciesFor(fixture, calls, false, false, 'SIGNED_SIMULATION_FAILED'),
      fixture.input,
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof SignedSimulationGatewayError
      && error.code === 'SIGNED_SIMULATION_FAILED',
  );
  assert.deepEqual(calls, ['inspect', 'persist', 'inspect', 'signed-simulate']);
});

void test('does not irreversibly revoke when cancellation caused signed validation to stop',
  async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      executeLivePreparedTransaction(
        dependenciesFor(fixture, calls, false, false, 'SIGNED_TRANSACTION_INVALID'),
        fixture.input,
        controller.signal,
      ),
      (error: unknown) => error instanceof SignedSimulationGatewayError
        && error.code === 'SIGNED_TRANSACTION_INVALID',
    );
    assert.deepEqual(calls, ['inspect', 'persist', 'inspect', 'signed-simulate']);
  });

for (const code of ['PREFLIGHT_EXPIRED', 'CONTROL_STOPPED'] as const) {
  void test(`durably revokes SIGNED_SIMULATED bytes after deterministic ${code}`, async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const error = new ExecutionLiveRepositoryError(code);

    await assert.rejects(
      executeLivePreparedTransaction(
        dependenciesWithBeginSubmissionFailure(fixture, calls, error),
        fixture.input,
        new AbortController().signal,
      ),
      (caught: unknown) => caught === error,
    );

    assert.deepEqual(calls, [
      'inspect', 'persist', 'inspect', 'signed-simulate', 'record-signed-simulation',
      'begin-submission', 'revoke-before-submission',
    ]);
  });
}

for (const code of [
  'INVALID_INPUT', 'INVALID_DATA', 'CONFLICT', 'LEASE_LOST',
  'DATABASE_FAILURE', 'COMMIT_OUTCOME_UNKNOWN',
] as const satisfies readonly ExecutionLiveRepositoryErrorCode[]) {
  void test(`does not revoke SIGNED_SIMULATED bytes after non-allowlisted ${code}`, async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const error = new ExecutionLiveRepositoryError(code);

    await assert.rejects(
      executeLivePreparedTransaction(
        dependenciesWithBeginSubmissionFailure(fixture, calls, error),
        fixture.input,
        new AbortController().signal,
      ),
      (caught: unknown) => caught === error,
    );

    assert.deepEqual(calls, [
      'inspect', 'persist', 'inspect', 'signed-simulate', 'record-signed-simulation',
      'begin-submission',
    ]);
  });
}

void test('fails closed when an untyped error spoofs a deterministic gate code', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const error = Object.assign(new Error('spoofed repository error'), {
    code: 'PREFLIGHT_EXPIRED',
  });

  await assert.rejects(
    executeLivePreparedTransaction(
      dependenciesWithBeginSubmissionFailure(fixture, calls, error),
      fixture.input,
      new AbortController().signal,
    ),
    (caught: unknown) => caught === error,
  );

  assert.deepEqual(calls, [
    'inspect', 'persist', 'inspect', 'signed-simulate', 'record-signed-simulation',
    'begin-submission',
  ]);
});

void test('does not revoke a deterministic gate refusal once cancellation is observed', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const controller = new AbortController();
  const error = new ExecutionLiveRepositoryError('PREFLIGHT_EXPIRED');

  await assert.rejects(
    executeLivePreparedTransaction(
      dependenciesWithBeginSubmissionFailure(
        fixture, calls, error, () => { controller.abort(); },
      ),
      fixture.input,
      controller.signal,
    ),
    (caught: unknown) => caught === error,
  );

  assert.deepEqual(calls, [
    'inspect', 'persist', 'inspect', 'signed-simulate', 'record-signed-simulation',
    'begin-submission',
  ]);
});

void test('restart from PERSISTED reuses exact bytes without persisting them again', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const dependencies = dependenciesFor(fixture, calls, false);
  dependencies.repository.inspectSignedTransaction = () => {
    calls.push('inspect');
    return Promise.resolve(inspectionFor(fixture, 'PERSISTED', 0n));
  };

  const result = await executeLivePreparedTransaction(
    dependencies, fixture.input, new AbortController().signal,
  );

  assert.equal(result.kind, 'ACCEPTED');
  assert.deepEqual(calls, [
    'inspect', 'signed-simulate', 'record-signed-simulation',
    'begin-submission', 'rpc-submit', 'record-accepted',
  ]);
});

void test('process restart discovers the durable artifact and unsigned proof from its claim',
  async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const dependencies = dependenciesFor(fixture, calls, false);
    dependencies.repository.inspectSignedTransaction = (input) => {
      calls.push(input.artifactId === undefined ? 'discover' : 'inspect-by-id');
      return Promise.resolve(inspectionFor(fixture, 'PERSISTED', 0n));
    };
    dependencies.signedSimulation.simulate = (input) => {
      calls.push('signed-simulate');
      assert.equal(input.persisted.artifact.artifactId, fixture.artifact.artifactId);
      assert.deepEqual(input.unsignedSimulation, fixture.input.persist.unsignedSimulation);
      return Promise.resolve(fixture.signedEvidence);
    };

    const result = await resumeLivePersistedTransaction(dependencies, Object.freeze({
      payloadVersion: 1,
      claim: fixture.input.persist.claim,
      signedSimulation: Object.freeze({
        payloadVersion: 1,
        snapshotSlot: fixture.input.signedSimulation.snapshotSlot,
        accountAddresses: fixture.input.signedSimulation.accountAddresses,
        amountInRaw: fixture.input.signedSimulation.amountInRaw,
        protectedAmountOutRaw: fixture.input.signedSimulation.protectedAmountOutRaw,
      }),
      runtime: fixture.input.runtime,
      blockhashValidity: fixture.input.blockhashValidity,
    }), new AbortController().signal);

    assert.equal(result.kind, 'ACCEPTED');
    assert.deepEqual(calls, [
      'discover', 'signed-simulate', 'record-signed-simulation',
      'begin-submission', 'rpc-submit', 'record-accepted',
    ]);
  });

void test('restart from SIGNED_SIMULATED skips signed simulation and continues at the final gate',
  async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const dependencies = dependenciesFor(fixture, calls, false);
    dependencies.repository.inspectSignedTransaction = () => {
      calls.push('inspect');
      return Promise.resolve(inspectionFor(fixture, 'SIGNED_SIMULATED', 1n));
    };

    const result = await executeLivePreparedTransaction(
      dependencies, fixture.input, new AbortController().signal,
    );

    assert.equal(result.kind, 'ACCEPTED');
    assert.deepEqual(calls, [
      'inspect', 'begin-submission', 'rpc-submit', 'record-accepted',
    ]);
  });

void test('restart from SUBMISSION_STARTED records ambiguity without submitting bytes', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const dependencies = dependenciesFor(fixture, calls, false);
  dependencies.repository.inspectSignedTransaction = () => {
    calls.push('inspect');
    return Promise.resolve(inspectionFor(fixture, 'SUBMISSION_STARTED', 2n));
  };

  const result = await executeLivePreparedTransaction(
    dependencies, fixture.input, new AbortController().signal,
  );

  assert.equal(result.kind, 'AMBIGUOUS');
  assert.deepEqual(calls, ['inspect', 'record-ambiguous']);
});

for (const state of ['ACCEPTED', 'AMBIGUOUS'] as const) {
  void test(`restart from ${state} returns the durable outcome without submitting bytes`, async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const dependencies = dependenciesFor(fixture, calls, false);
    dependencies.repository.inspectSignedTransaction = () => {
      calls.push('inspect');
      return Promise.resolve(inspectionFor(fixture, state, 3n));
    };

    const result = await executeLivePreparedTransaction(
      dependencies, fixture.input, new AbortController().signal,
    );

    assert.equal(result.kind, state);
    assert.deepEqual(calls, ['inspect']);
  });
}

void test('restart from REVOKED_NO_SEND returns a stable terminal result', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const dependencies = dependenciesFor(fixture, calls, false);
  dependencies.repository.inspectSignedTransaction = () => {
    calls.push('inspect');
    return Promise.resolve(inspectionFor(fixture, 'REVOKED_NO_SEND', 1n));
  };

  const result = await executeLivePreparedTransaction(
    dependencies, fixture.input, new AbortController().signal,
  );

  assert.equal(result.kind, 'REVOKED_NO_SEND');
  assert.deepEqual(calls, ['inspect']);
});

void test('restart recovers an unknown revocation commit without depending on a new clock value',
  async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    let durableState: 'PERSISTED' | 'REVOKED_NO_SEND' = 'PERSISTED';
    let clockMs = 1_786_699_000_100;
    const baseline = dependenciesFor(
      fixture, calls, false, false, 'SIGNED_TRANSACTION_INVALID',
    );
    let firstInspection = true;
    const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
      ...baseline,
      repository: Object.freeze({
        ...baseline.repository,
        inspectSignedTransaction: () => {
          calls.push('inspect');
          if (firstInspection) {
            firstInspection = false;
            return Promise.resolve(null);
          }
          return Promise.resolve(inspectionFor(
            fixture, durableState, durableState === 'PERSISTED' ? 0n : 1n,
          ));
        },
        revokeBeforeSubmission: () => {
          calls.push('revoke-before-submission');
          durableState = 'REVOKED_NO_SEND';
          return Promise.reject(new ExecutionLiveRepositoryError('COMMIT_OUTCOME_UNKNOWN'));
        },
      }),
      clock: () => clockMs,
    });

    await assert.rejects(executeLivePreparedTransaction(
      dependencies, fixture.input, new AbortController().signal,
    ), (error: unknown) => error instanceof ExecutionLiveRepositoryError
      && error.code === 'COMMIT_OUTCOME_UNKNOWN');

    clockMs += 1_000;
    const recovered = await executeLivePreparedTransaction(
      dependencies, fixture.input, new AbortController().signal,
    );
    assert.equal(recovered.kind, 'REVOKED_NO_SEND');
    assert.deepEqual(calls, [
      'inspect', 'persist', 'inspect', 'signed-simulate', 'revoke-before-submission',
      'inspect',
    ]);
  });

function inspectionFor(
  fixture: ReturnType<typeof workerFixture>,
  state: ExecutionLiveSignedTransactionInspectionV1['state'],
  stateRevision: bigint,
): ExecutionLiveSignedTransactionInspectionV1 {
  if (state === 'PERSISTED' || state === 'SIGNED_SIMULATED') {
    return Object.freeze({
      payloadVersion: 1, state, stateRevision, artifact: fixture.artifact,
      unsignedSimulation: fixture.input.persist.unsignedSimulation,
    });
  }
  return Object.freeze({
    payloadVersion: 1, state, stateRevision,
    artifactId: fixture.artifact.artifactId,
    signature: fixture.artifact.signature,
    signedTransactionHash: fixture.artifact.signedTransactionHash,
  });
}

function dependenciesWithBeginSubmissionFailure(
  fixture: ReturnType<typeof workerFixture>,
  calls: string[],
  error: Error,
  beforeReject: () => void = () => { /* no cancellation */ },
): LiveExecutionWorkerDependencies {
  const baseline = dependenciesFor(fixture, calls, false);
  return Object.freeze({
    ...baseline,
    repository: Object.freeze({
      ...baseline.repository,
      beginSubmission: () => {
        calls.push('begin-submission');
        beforeReject();
        return Promise.reject(error);
      },
      revokeBeforeSubmission: (input: ExecutionPreSubmissionRevocationInputV1) => {
        calls.push('revoke-before-submission');
        assert.equal(input.artifactId, fixture.artifact.artifactId);
        assert.equal(input.expectedState, 'SIGNED_SIMULATED');
        assert.equal(input.expectedRevision, 1n);
        assert.equal(input.causeReasonCode, 'PRE_SUBMISSION_GATES_FAILED');
        assert.match(input.evidenceFingerprint, /^[0-9a-f]{64}$/u);
        return Promise.resolve(Object.freeze({
          payloadVersion: 1 as const,
          kind: 'REVOKED' as const,
          artifactState: 'REVOKED_NO_SEND' as const,
        }));
      },
    }),
  });
}

function dependenciesFor(
  fixture: ReturnType<typeof workerFixture>,
  calls: string[],
  ambiguous: boolean,
  acceptedRecordFailure = false,
  signedSimulationFailure: 'SIGNED_TRANSACTION_INVALID' | 'SIGNED_SIMULATION_FAILED'
    | 'SIGNED_SIMULATION_INCONSISTENT' | null = null,
): LiveExecutionWorkerDependencies {
  const persisted = Object.freeze({
    payloadVersion: 1 as const, artifact: fixture.artifact,
    unsignedSimulation: fixture.input.persist.unsignedSimulation,
    state: 'PERSISTED' as const, stateRevision: 0n,
  });
  const signedSimulated = Object.freeze({
    ...persisted, state: 'SIGNED_SIMULATED' as const, stateRevision: 1n,
  });
  const submissionStarted = Object.freeze({
    ...persisted, state: 'SUBMISSION_STARTED' as const, stateRevision: 2n,
  });
  let inspectionCount = 0;
  return Object.freeze({
    repository: {
      persistSigned: () => { calls.push('persist'); return Promise.resolve(fixture.artifact); },
      inspectSignedTransaction: () => {
        calls.push('inspect');
        inspectionCount += 1;
        return Promise.resolve(inspectionCount === 1 ? null : persisted);
      },
      recordSignedSimulation: () => {
        calls.push('record-signed-simulation'); return Promise.resolve(signedSimulated);
      },
      revokeBeforeSubmission: (input: ExecutionPreSubmissionRevocationInputV1) => {
        calls.push('revoke-before-submission');
        assert.equal(input.artifactId, fixture.artifact.artifactId);
        assert.equal(input.expectedState, 'PERSISTED');
        assert.equal(input.expectedRevision, 0n);
        assert.equal(input.causeReasonCode, 'SIGNED_SIMULATION_FAILED');
        assert.match(input.evidenceFingerprint, /^[0-9a-f]{64}$/u);
        return Promise.resolve(Object.freeze({
          payloadVersion: 1 as const, kind: 'REVOKED' as const,
          artifactState: 'REVOKED_NO_SEND' as const,
        }));
      },
      beginSubmission: () => {
        calls.push('begin-submission'); return Promise.resolve(submissionStarted);
      },
      recordSubmissionOutcome: (
        _claim: ClaimedExecutionIntent,
        outcome: ExecutionLiveSubmissionOutcomeV1,
      ) => {
        calls.push(`record-${outcome.outcome.toLowerCase()}`);
        if (acceptedRecordFailure && outcome.outcome === 'ACCEPTED') {
          return Promise.reject(new Error('accepted outcome commit unknown'));
        }
        return Promise.resolve(fixture.artifact);
      },
    },
    signedSimulation: {
      simulate: () => {
        calls.push('signed-simulate');
        return signedSimulationFailure === null
          ? Promise.resolve(fixture.signedEvidence)
          : Promise.reject(new SignedSimulationGatewayError(signedSimulationFailure));
      },
    },
    submission: {
      submitPersisted: () => {
        calls.push('rpc-submit');
        if (ambiguous) return Promise.reject(
          new LiveSubmissionGatewayError('SUBMISSION_AMBIGUOUS', true),
        );
        return Promise.resolve(Object.freeze({ signature: fixture.artifact.signature }));
      },
    },
    clock: () => 1_786_699_000_100,
  });
}

function workerFixture() {
  const nowMs = 1_786_699_000_000;
  const draft = createExecutionIntentDraft({
    strategyId: 'worker-test', strategyVersion: 1, positionId: 'position:test',
    logicalCommandId: 'command:test', mint: '11111111111111111111111111111111',
    side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 100n, baseAmountRaw: null, minimumAmountOutRaw: 90n,
    decisionEventId: 'decision:test', decisionFingerprint: '1'.repeat(64),
    requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 60_000,
  });
  const intent: ExecutionIntentV1 = Object.freeze({
    ...draft, status: 'PROCESSING', attemptCount: 1, stateRevision: 1n,
    lastReasonCode: 'EXECUTION_STARTED', terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: nowMs - 1_000, updatedAtMs: nowMs - 500,
  });
  const claim = Object.freeze({
    intent, leaseOwner: 'worker-live', leaseToken: '11111111-1111-4111-8111-111111111111',
    leaseExpiresAtMs: nowMs + 30_000,
  });
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1, intentId: intent.id, attemptNumber: 1,
    generationId: `execution_wallet_generation_${'2'.repeat(64)}`,
    armamentId: `execution_activation_armament_${'3'.repeat(64)}`,
    reservationId: `execution_exposure_reservation_${'b'.repeat(64)}`,
    exitAuthorizationId: null, providerId: 'primary', walletPublicKey: intent.mint,
    side: 'BUY', effectiveVenue: 'PUMP_FUN', messageHash: '4'.repeat(64),
    buildFingerprint: '5'.repeat(64), snapshotFingerprint: '6'.repeat(64),
    quoteFingerprint: '7'.repeat(64), quoteObservedAtMs: nowMs - 100,
    quoteExpiresAtMs: nowMs + 5_000, blockhash: intent.mint,
    lastValidBlockHeight: 500n, signature: bs58.encode(new Uint8Array(64).fill(8)),
    signedTransactionBytes: Uint8Array.from([1, 2, 3]), signedAtMs: nowMs,
  });
  const unsignedSimulation = Object.freeze({
    outcome: 'SUCCESS' as const, snapshotFingerprint: artifact.snapshotFingerprint,
    buildFingerprint: artifact.buildFingerprint, messageHash: artifact.messageHash,
    blockhash: artifact.blockhash, lastValidBlockHeight: artifact.lastValidBlockHeight,
    blockhashContextSlot: 124n, feeContextSlot: 124n, estimatedFeeLamports: 5n,
    simulationSlot: 125n, simulatedFeePayerLamportDebit: 5n, unitsConsumed: 20n,
    simulatedBaseDeltaRaw: 100n, simulatedQuoteDeltaRaw: -100n,
    logsFingerprint: '8'.repeat(64), logsLineCount: 1,
  });
  const signedEvidence: ExecutionLiveSignedSimulationEvidenceV1 = Object.freeze({
    payloadVersion: 1, artifactId: artifact.artifactId,
    unsignedSimulationEvidenceId:
      `execution_live_unsigned_simulation_evidence_${'d'.repeat(64)}`,
    signedTransactionHash: artifact.signedTransactionHash, simulationSlot: 126n,
    providerId: artifact.providerId,
    unitsConsumed: 21n, feePayerLamportDebit: 5n,
    baseDeltaRaw: 99n, quoteDeltaRaw: -100n,
    logsFingerprint: '8'.repeat(64), logsLineCount: 1,
    evidenceFingerprint: '9'.repeat(64), observedAtMs: nowMs + 50,
  });
  return Object.freeze({
    artifact, signedEvidence,
    input: Object.freeze({
      persist: Object.freeze({
        payloadVersion: 1 as const, claim,
        qualificationId: `execution_safety_qualification_${'a'.repeat(64)}`,
        reservationId: `execution_exposure_reservation_${'b'.repeat(64)}`,
        artifact, unsignedSimulation,
      }),
      signedSimulation: Object.freeze({
        payloadVersion: 1 as const, snapshotSlot: 123n,
        accountAddresses: Object.freeze([intent.mint, intent.mint, intent.mint] as const),
        amountInRaw: 100n, protectedAmountOutRaw: 90n, unsignedSimulation,
      }),
      runtime: Object.freeze({
        payloadVersion: 1 as const, phase: 'CANARY' as const,
        buildHash: 'a'.repeat(64), configurationFingerprint: 'b'.repeat(64),
        strategyFingerprint: 'c'.repeat(64), walletPublicKey: intent.mint,
        cluster: 'mainnet-beta' as const, expectedGenesisHash: intent.mint,
        observedGenesisHash: intent.mint, providerId: 'primary',
      }),
      blockhashValidity: Object.freeze({
        payloadVersion: 1 as const, providerId: 'primary', blockhash: artifact.blockhash,
        valid: true as const, observedBlockHeight: 499n, contextSlot: 127n,
        observedAtMs: nowMs + 75,
      }),
    }),
  });
}
