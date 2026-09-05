import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  createSignedTransactionArtifact,
  type SignedTransactionArtifactV1,
} from '../src/domain/execution-live.js';
import { createExecutionIntentDraft, type ExecutionIntentV1 } from '../src/domain/execution-intent.js';
import {
  executeLivePreparedTransaction,
  resumeLivePersistedTransaction,
  type LiveExecutionWorkerDependencies,
} from '../src/executor-live/execution-worker.js';
import {
  SignedSimulationGatewayError,
  type SignedSimulationGatewayInputV1,
} from '../src/executor-live/signed-simulation-gateway.js';
import { LiveSubmissionGatewayError } from '../src/executor-live/submission-gateway.js';
import {
  createLiveRpcCallBudgetExhaustedError,
} from '../src/executor-live/rpc-gateway.js';
import {
  ExecutionLiveRepositoryError,
  type ExecutionLiveRepositoryErrorCode,
} from '../src/storage/execution-live.repository.js';
import type {
  ExecutionLiveSignedTransactionInspectionV1,
  ExecutionLiveSignedSimulationEvidenceV1,
  ExecutionLiveSubmissionOutcomeV1,
  ExecutionPreSubmissionRevocationInputV1,
  ExecutionLiveRepository,
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
    'renew-before-submission', 'read-blockhash-validity',
    'renew-before-submission',
    'begin-submission', 'rpc-submit', 'record-accepted',
  ]);
});

for (const outcome of ['ACCEPTED', 'AMBIGUOUS'] as const) {
  void test(`carries the authoritative claim through fresh ${outcome} and release`, async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    let activeClaim: ClaimedExecutionIntent = fixture.input.persist.claim;
    let artifactState: ExecutionLiveSignedTransactionInspectionV1['state'] | null = null;
    let artifactRevision = 0n;
    let released = false;
    const requireClaim = (claim: ClaimedExecutionIntent): void => {
      assert.equal(claim.leaseToken, activeClaim.leaseToken);
      assert.equal(claim.intent.status, activeClaim.intent.status);
      assert.equal(claim.intent.stateRevision, activeClaim.intent.stateRevision);
    };
    const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
      activateRpcBudget: () => undefined,
      reserveSubmissionRpcCall: () => Promise.resolve(),
      repository: {
        inspectSignedTransaction: (
          input: Parameters<ExecutionLiveRepository['inspectSignedTransaction']>[0],
        ) => {
          calls.push('inspect');
          if (artifactState === null) return Promise.resolve(null);
          requireClaim(input.claim);
          return Promise.resolve(inspectionFor(fixture, artifactState, artifactRevision));
        },
        persistSigned: (input: Parameters<ExecutionLiveRepository['persistSigned']>[0]) => {
          calls.push('persist');
          requireClaim(input.claim);
          activeClaim = claimAt(
            activeClaim, 'SIGNED_NOT_SUBMITTED', activeClaim.intent.stateRevision + 2n,
            'SIGNATURE_PERSISTED',
          );
          artifactState = 'PERSISTED';
          return Promise.resolve(Object.freeze({
            payloadVersion: 1 as const, artifact: fixture.artifact, claim: activeClaim,
          }));
        },
        recordSignedSimulation: (claim: ClaimedExecutionIntent) => {
          calls.push('record-signed-simulation');
          requireClaim(claim);
          artifactState = 'SIGNED_SIMULATED';
          artifactRevision = 1n;
          return Promise.resolve(Object.freeze({
            payloadVersion: 1 as const, artifact: fixture.artifact,
            state: 'SIGNED_SIMULATED' as const, stateRevision: artifactRevision,
          }));
        },
        revokeBeforeSubmission: () => { throw new Error('unexpected revocation'); },
        beginSubmission: (input: Parameters<ExecutionLiveRepository['beginSubmission']>[0]) => {
          calls.push('begin-submission');
          requireClaim(input.claim);
          artifactState = 'SUBMISSION_STARTED';
          artifactRevision = 2n;
          return Promise.resolve(submissionStartedFor(fixture, artifactRevision));
        },
        recordSubmissionOutcome: (
          claim: ClaimedExecutionIntent,
          recorded: ExecutionLiveSubmissionOutcomeV1,
        ) => {
          calls.push(`record-${recorded.outcome.toLowerCase()}`);
          requireClaim(claim);
          activeClaim = claimAt(
            activeClaim,
            recorded.outcome === 'ACCEPTED' ? 'SUBMITTED' : 'UNKNOWN_REQUIRES_RECONCILIATION',
            activeClaim.intent.stateRevision + 1n,
            recorded.outcome === 'ACCEPTED'
              ? 'SUBMISSION_ACCEPTED' : 'RECONCILIATION_REQUIRED',
          );
          artifactState = recorded.outcome;
          artifactRevision = 3n;
          return Promise.resolve(Object.freeze({
            payloadVersion: 1 as const, artifact: fixture.artifact, claim: activeClaim,
          }));
        },
      },
      signedSimulation: {
        simulate: () => {
          calls.push('signed-simulate');
          return Promise.resolve(fixture.signedEvidence);
        },
      },
      renewBeforeSubmission: (claim: ClaimedExecutionIntent) => {
        calls.push('renew-before-submission');
        requireClaim(claim);
        return Promise.resolve(activeClaim);
      },
      readBlockhashValidity: (
        _artifact: SignedTransactionArtifactV1,
        minimumContextSlot: bigint,
      ) => {
        calls.push('read-blockhash-validity');
        assert.equal(
          minimumContextSlot,
          fixture.input.persist.unsignedSimulation.blockhashContextSlot,
        );
        return Promise.resolve(fixture.blockhashValidity);
      },
      submission: {
        submitPersisted: () => {
          calls.push('rpc-submit');
          return outcome === 'ACCEPTED'
            ? Promise.resolve(Object.freeze({ signature: fixture.artifact.signature }))
            : Promise.reject(new LiveSubmissionGatewayError('SUBMISSION_AMBIGUOUS', true));
        },
      },
      clock: () => 1_786_699_000_100,
    });

    const result = await executeLivePreparedTransaction(
      dependencies, fixture.input, new AbortController().signal,
    );
    assert.notEqual(result.claim, null);
    if (result.claim === null) throw new TypeError('Expected an active outcome claim.');
    requireClaim(result.claim);
    released = releaseClaim(result.claim, activeClaim);

    assert.equal(result.kind, outcome);
    assert.equal(activeClaim.intent.stateRevision, fixture.input.persist.claim.intent.stateRevision + 3n);
    assert.equal(released, true);
    assert.equal(calls.filter((call) => call === 'signed-simulate').length, 1);
    assert.equal(calls.filter((call) => call === 'rpc-submit').length, 1);
  });
}

void test('recovers SIGNED_SIMULATED without re-signing or double-sending', async () => {
    const recoveredState = 'SIGNED_SIMULATED' as const;
    const fixture = workerFixture();
    let activeClaim: ClaimedExecutionIntent = claimAt(
      fixture.input.persist.claim, 'SIGNED_NOT_SUBMITTED',
      fixture.input.persist.claim.intent.stateRevision + 2n, 'SIGNATURE_PERSISTED',
    );
    let artifactState: ExecutionLiveSignedTransactionInspectionV1['state'] = recoveredState;
    let artifactRevision = 1n;
    let signedSimulations = 0;
    let sends = 0;
    let persists = 0;
    const requireClaim = (claim: ClaimedExecutionIntent): void => {
      assert.equal(claim.intent.status, activeClaim.intent.status);
      assert.equal(claim.intent.stateRevision, activeClaim.intent.stateRevision);
    };
    const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
      activateRpcBudget: () => undefined,
      reserveSubmissionRpcCall: () => Promise.resolve(),
      repository: {
        inspectSignedTransaction: (
          input: Parameters<ExecutionLiveRepository['inspectSignedTransaction']>[0],
        ) => {
          requireClaim(input.claim);
          return Promise.resolve(inspectionFor(fixture, artifactState, artifactRevision));
        },
        persistSigned: () => { persists += 1; throw new Error('must not persist recovery'); },
        recordSignedSimulation: (claim: ClaimedExecutionIntent) => {
          requireClaim(claim);
          artifactState = 'SIGNED_SIMULATED';
          artifactRevision = 1n;
          return Promise.resolve(Object.freeze({
            payloadVersion: 1 as const, artifact: fixture.artifact,
            state: 'SIGNED_SIMULATED' as const, stateRevision: artifactRevision,
          }));
        },
        revokeBeforeSubmission: () => { throw new Error('unexpected revocation'); },
        beginSubmission: (input: Parameters<ExecutionLiveRepository['beginSubmission']>[0]) => {
          requireClaim(input.claim);
          artifactState = 'SUBMISSION_STARTED';
          artifactRevision = 2n;
          return Promise.resolve(submissionStartedFor(fixture, artifactRevision));
        },
        recordSubmissionOutcome: (claim: ClaimedExecutionIntent) => {
          requireClaim(claim);
          activeClaim = claimAt(
            activeClaim, 'SUBMITTED', activeClaim.intent.stateRevision + 1n,
            'SUBMISSION_ACCEPTED',
          );
          artifactState = 'ACCEPTED';
          artifactRevision = 3n;
          return Promise.resolve(Object.freeze({
            payloadVersion: 1 as const, artifact: fixture.artifact, claim: activeClaim,
          }));
        },
      },
      signedSimulation: {
        simulate: () => {
          signedSimulations += 1;
          return Promise.resolve(fixture.signedEvidence);
        },
      },
      renewBeforeSubmission: (claim: ClaimedExecutionIntent) => {
        requireClaim(claim);
        return Promise.resolve(claim);
      },
      readBlockhashValidity: () => Promise.resolve(fixture.blockhashValidity),
      submission: {
        submitPersisted: () => {
          sends += 1;
          return Promise.resolve(Object.freeze({ signature: fixture.artifact.signature }));
        },
      },
      clock: () => 1_786_699_000_100,
    });

    const result = await resumeLivePersistedTransaction(dependencies, Object.freeze({
      payloadVersion: 1, claim: activeClaim, runtime: fixture.input.runtime,
    }), new AbortController().signal);

    assert.equal(result.kind, 'ACCEPTED');
    assert.notEqual(result.claim, null);
    if (result.claim === null) throw new TypeError('Expected an active outcome claim.');
    assert.equal(releaseClaim(result.claim, activeClaim), true);
    assert.equal(persists, 0);
    assert.equal(signedSimulations, 0);
    assert.equal(sends, 1);
  });

void test('never opens the submission fence when either final renewal or blockhash proof fails',
  async () => {
    for (const boundary of ['PRE_BLOCKHASH_RENEW', 'BLOCKHASH', 'POST_BLOCKHASH_RENEW'] as const) {
      const fixture = workerFixture();
      const calls: string[] = [];
      const baseline = dependenciesFor(fixture, calls, false);
      const expected = new Error(`failed ${boundary}`);
      let renewCount = 0;
      const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
        ...baseline,
        renewBeforeSubmission: boundary === 'PRE_BLOCKHASH_RENEW'
          || boundary === 'POST_BLOCKHASH_RENEW'
          ? (claim: ClaimedExecutionIntent) => {
              renewCount += 1;
              calls.push('renew-before-submission');
              if ((boundary === 'PRE_BLOCKHASH_RENEW' && renewCount === 1)
                || (boundary === 'POST_BLOCKHASH_RENEW' && renewCount === 2)) {
                return Promise.reject(expected);
              }
              return Promise.resolve(claim);
            }
          : baseline.renewBeforeSubmission,
        readBlockhashValidity: boundary === 'BLOCKHASH'
          ? () => {
              calls.push('read-blockhash-validity');
              return Promise.reject(expected);
            }
          : baseline.readBlockhashValidity,
      });

      await assert.rejects(executeLivePreparedTransaction(
        dependencies, fixture.input, new AbortController().signal,
      ), expected);
      assert.equal(calls.includes('begin-submission'), false);
      assert.equal(calls.includes('rpc-submit'), false);
    }
  });

void test('passes the claim from the post-blockhash renewal to the submission fence', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const baseline = dependenciesFor(fixture, calls, false);
  const claims: ClaimedExecutionIntent[] = [];
  let renewCount = 0;
  const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
    ...baseline,
    renewBeforeSubmission: (claim: ClaimedExecutionIntent) => {
      calls.push('renew-before-submission');
      renewCount += 1;
      const renewed = Object.freeze({
        ...claim,
        leaseToken: `${renewCount + 1}1111111-1111-4111-8111-111111111111`,
        leaseExpiresAtMs: claim.leaseExpiresAtMs + renewCount,
      });
      claims.push(renewed);
      return Promise.resolve(renewed);
    },
    repository: Object.freeze({
      ...baseline.repository,
      beginSubmission: (
        input: Parameters<ExecutionLiveRepository['beginSubmission']>[0],
      ) => {
        calls.push('begin-submission');
        assert.equal(input.claim, claims[1]);
        return Promise.resolve(submissionStartedFor(fixture, 2n));
      },
    }),
  });

  await executeLivePreparedTransaction(
    dependencies, fixture.input, new AbortController().signal,
  );

  assert.equal(renewCount, 2);
});

void test('durably reserves the send RPC call with the final renewed claim before the fence',
  async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const baseline = dependenciesFor(fixture, calls, false);
    let finalClaim: ClaimedExecutionIntent | null = null;
    let renewCount = 0;
    const dependencies = Object.freeze({
      ...baseline,
      renewBeforeSubmission: (claim: ClaimedExecutionIntent) => {
        calls.push('renew-before-submission');
        renewCount += 1;
        finalClaim = Object.freeze({
          ...claim,
          leaseToken: `${renewCount + 1}1111111-1111-4111-8111-111111111111`,
        });
        return Promise.resolve(finalClaim);
      },
      reserveSubmissionRpcCall: (claim: ClaimedExecutionIntent, artifactId: string) => {
        calls.push('reserve-submission-rpc-call');
        assert.equal(claim, finalClaim);
        assert.equal(artifactId, fixture.artifact.artifactId);
        return Promise.resolve();
      },
    });

    await executeLivePreparedTransaction(
      dependencies, fixture.input, new AbortController().signal,
    );

    assert.ok(calls.indexOf('reserve-submission-rpc-call') > calls.lastIndexOf(
      'renew-before-submission',
    ));
    assert.ok(calls.indexOf('reserve-submission-rpc-call') < calls.indexOf('begin-submission'));
  });

void test('revokes SIGNED_SIMULATED when the durable send reservation is exhausted', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const baseline = dependenciesFor(fixture, calls, false);
  const error = createLiveRpcCallBudgetExhaustedError();
  const dependencies = Object.freeze({
    ...baseline,
    reserveSubmissionRpcCall: () => {
      calls.push('reserve-submission-rpc-call');
      return Promise.reject(error);
    },
    repository: Object.freeze({
      ...baseline.repository,
      revokeBeforeSubmission: (input: ExecutionPreSubmissionRevocationInputV1) => {
        calls.push('revoke-before-submission');
        assert.equal(input.expectedState, 'SIGNED_SIMULATED');
        assert.equal(input.expectedRevision, 1n);
        return Promise.resolve(Object.freeze({
          payloadVersion: 1 as const,
          kind: 'REVOKED' as const,
          artifactState: 'REVOKED_NO_SEND' as const,
        }));
      },
    }),
  });

  await assert.rejects(
    executeLivePreparedTransaction(
      dependencies, fixture.input, new AbortController().signal,
    ),
    (caught: unknown) => caught === error,
  );
  assert.equal(calls.includes('revoke-before-submission'), true);
  assert.equal(calls.includes('begin-submission'), false);
  assert.equal(calls.includes('rpc-submit'), false);
});

void test('uses the persisted unsigned blockhash context as the fresh signed-simulation causal floor',
  async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const baseline = dependenciesFor(fixture, calls, false);
    const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
      ...baseline,
      signedSimulation: Object.freeze({
        simulate: (input: SignedSimulationGatewayInputV1) => {
          calls.push('signed-simulate');
          assert.equal(input.snapshotSlot, fixture.input.persist.unsignedSimulation.blockhashContextSlot);
          return Promise.resolve(fixture.signedEvidence);
        },
      }),
    });

    await executeLivePreparedTransaction(
      dependencies, fixture.input, new AbortController().signal,
    );
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
    'renew-before-submission', 'read-blockhash-validity',
    'renew-before-submission',
    'begin-submission', 'rpc-submit', 'record-ambiguous',
  ]);
  assert.equal(calls.filter((call) => call === 'rpc-submit').length, 1);
});

void test('keeps RPC budget exhaustion ambiguous after the durable submission fence', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const baseline = dependenciesFor(fixture, calls, false);
  const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
    ...baseline,
    submission: Object.freeze({
      submitPersisted: () => {
        calls.push('rpc-submit');
        return Promise.reject(createLiveRpcCallBudgetExhaustedError());
      },
    }),
  });

  const result = await executeLivePreparedTransaction(
    dependencies, fixture.input, new AbortController().signal,
  );

  assert.equal(result.kind, 'AMBIGUOUS');
  assert.deepEqual(calls, [
    'inspect', 'persist', 'inspect', 'signed-simulate', 'record-signed-simulation',
    'renew-before-submission', 'read-blockhash-validity',
    'renew-before-submission', 'begin-submission', 'rpc-submit', 'record-ambiguous',
  ]);
  assert.equal(calls.includes('revoke-before-submission'), false);
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
    'renew-before-submission', 'read-blockhash-validity',
    'renew-before-submission',
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

void test('durably revokes persisted bytes when the RPC budget is exhausted during signed simulation',
  async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const baseline = dependenciesFor(fixture, calls, false);
    const error = createLiveRpcCallBudgetExhaustedError();
    const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
      ...baseline,
      signedSimulation: Object.freeze({
        simulate: () => {
          calls.push('signed-simulate');
          return Promise.reject(error);
        },
      }),
    });

    await assert.rejects(
      executeLivePreparedTransaction(
        dependencies, fixture.input, new AbortController().signal,
      ),
      (caught: unknown) => caught === error,
    );

    assert.deepEqual(calls, [
      'inspect', 'persist', 'inspect', 'signed-simulate', 'revoke-before-submission',
    ]);
  });

void test('durably revokes signed-simulated bytes when the RPC budget is exhausted before the fence',
  async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const baseline = dependenciesFor(fixture, calls, false);
    const error = createLiveRpcCallBudgetExhaustedError();
    const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
      ...baseline,
      readBlockhashValidity: () => {
        calls.push('read-blockhash-validity');
        return Promise.reject(error);
      },
      repository: Object.freeze({
        ...baseline.repository,
        revokeBeforeSubmission: (input: ExecutionPreSubmissionRevocationInputV1) => {
          calls.push('revoke-before-submission');
          assert.equal(input.expectedState, 'SIGNED_SIMULATED');
          assert.equal(input.expectedRevision, 1n);
          assert.equal(input.causeReasonCode, 'PRE_SUBMISSION_GATES_FAILED');
          return Promise.resolve(Object.freeze({
            payloadVersion: 1 as const,
            kind: 'REVOKED' as const,
            artifactState: 'REVOKED_NO_SEND' as const,
          }));
        },
      }),
    });

    await assert.rejects(
      executeLivePreparedTransaction(
        dependencies, fixture.input, new AbortController().signal,
      ),
      (caught: unknown) => caught === error,
    );

    assert.deepEqual(calls, [
      'inspect', 'persist', 'inspect', 'signed-simulate', 'record-signed-simulation',
      'renew-before-submission', 'read-blockhash-validity', 'revoke-before-submission',
    ]);
    assert.equal(calls.includes('begin-submission'), false);
    assert.equal(calls.includes('rpc-submit'), false);
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
      'renew-before-submission', 'read-blockhash-validity',
      'renew-before-submission',
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
      'renew-before-submission', 'read-blockhash-validity',
      'renew-before-submission',
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
    'renew-before-submission', 'read-blockhash-validity',
    'renew-before-submission',
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
    'renew-before-submission', 'read-blockhash-validity',
    'renew-before-submission',
    'begin-submission',
  ]);
});

void test('restart from PERSISTED reuses exact bytes without persisting them again', async () => {
  const fixture = workerFixture();
  const calls: string[] = [];
  const baseline = dependenciesFor(fixture, calls, false);
  const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
    ...baseline,
    renewBeforeSubmission: (claim: ClaimedExecutionIntent) => {
      calls.push('renew-before-submission');
      assert.equal(claim.intent.status, 'SIGNED_NOT_SUBMITTED');
      assert.equal(
        claim.intent.stateRevision,
        fixture.input.persist.claim.intent.stateRevision + 2n,
      );
      return Promise.resolve(claim);
    },
  });
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
    'renew-before-submission', 'read-blockhash-validity',
    'renew-before-submission',
    'begin-submission', 'rpc-submit', 'record-accepted',
  ]);
});

for (const state of [
  'SIGNED_SIMULATED', 'SUBMISSION_STARTED', 'ACCEPTED', 'AMBIGUOUS', 'REVOKED_NO_SEND',
] as const) {
  void test(`resume inspects ${state} without creating signed-simulation recovery context`,
    async () => {
      const fixture = workerFixture();
      const calls: string[] = [];
      const dependencies = dependenciesFor(fixture, calls, false);
      dependencies.repository.inspectSignedTransaction = () => {
        calls.push('inspect');
        return Promise.resolve(inspectionFor(
          fixture,
          state,
          state === 'SIGNED_SIMULATED' ? 1n : state === 'SUBMISSION_STARTED' ? 2n : 3n,
        ));
      };
      await resumeLivePersistedTransaction(dependencies, Object.freeze({
        payloadVersion: 1,
        claim: fixture.input.persist.claim,
        runtime: fixture.input.runtime,
      }), new AbortController().signal);

      assert.equal(calls.filter((call) => call === 'inspect').length, 1);
      assert.equal(calls.includes('signed-simulate'), false);
      const continuesFromSignedSimulation = state === 'SIGNED_SIMULATED';
      assert.equal(calls.includes('read-blockhash-validity'), continuesFromSignedSimulation);
      assert.equal(calls.includes('begin-submission'), continuesFromSignedSimulation);
      assert.equal(calls.includes('rpc-submit'), continuesFromSignedSimulation);
    });
}

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
      'inspect', 'renew-before-submission', 'read-blockhash-validity',
      'renew-before-submission',
      'begin-submission', 'rpc-submit', 'record-accepted',
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
  dependencies.repository.recordSubmissionOutcome = (claim, outcome) => {
    calls.push(`record-${outcome.outcome.toLowerCase()}`);
    assert.equal(claim.intent.status, 'SIGNED_NOT_SUBMITTED');
    assert.equal(
      claim.intent.stateRevision,
      fixture.input.persist.claim.intent.stateRevision + 2n,
    );
    return Promise.resolve(Object.freeze({
      payloadVersion: 1 as const,
      artifact: fixture.artifact,
      claim: claimAt(
        claim, 'UNKNOWN_REQUIRES_RECONCILIATION', claim.intent.stateRevision + 1n,
        'RECONCILIATION_REQUIRED',
      ),
    }));
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
    assert.notEqual(result.claim, null);
    if (result.claim === null) throw new TypeError('Expected an authoritative durable claim.');
    assert.equal(
      result.claim.intent.stateRevision,
      fixture.input.persist.claim.intent.stateRevision + 3n,
    );
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

void test('recovery after RPC budget exhaustion is terminal and performs no new provider call',
  async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const baseline = dependenciesFor(fixture, calls, false);
    const error = createLiveRpcCallBudgetExhaustedError();
    let state: 'ABSENT' | 'PERSISTED' | 'REVOKED_NO_SEND' = 'ABSENT';
    let providerCalls = 0;
    const dependencies: LiveExecutionWorkerDependencies = Object.freeze({
      ...baseline,
      repository: Object.freeze({
        ...baseline.repository,
        persistSigned: (input: Parameters<ExecutionLiveRepository['persistSigned']>[0]) => {
          state = 'PERSISTED';
          return baseline.repository.persistSigned(input);
        },
        inspectSignedTransaction: () => {
          calls.push('inspect');
          if (state === 'ABSENT') return Promise.resolve(null);
          return Promise.resolve(inspectionFor(
            fixture, state, state === 'PERSISTED' ? 0n : 1n,
          ));
        },
        revokeBeforeSubmission: () => {
          calls.push('revoke-before-submission');
          state = 'REVOKED_NO_SEND';
          return Promise.resolve(Object.freeze({
            payloadVersion: 1 as const,
            kind: 'REVOKED' as const,
            artifactState: 'REVOKED_NO_SEND' as const,
          }));
        },
      }),
      signedSimulation: Object.freeze({
        simulate: () => {
          calls.push('signed-simulate');
          providerCalls += 1;
          return Promise.reject(error);
        },
      }),
    });
    await assert.rejects(
      executeLivePreparedTransaction(
        dependencies, fixture.input, new AbortController().signal,
      ),
      (caught: unknown) => caught === error,
    );
    const providerCallsBeforeRecovery = providerCalls;
    const recovered = await executeLivePreparedTransaction(
      dependencies, fixture.input, new AbortController().signal,
    );

    assert.equal(recovered.kind, 'REVOKED_NO_SEND');
    assert.equal(providerCalls, providerCallsBeforeRecovery);
    assert.deepEqual(calls, [
      'inspect', 'persist', 'inspect', 'signed-simulate',
      'revoke-before-submission', 'inspect',
    ]);
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
    const claim = inspectionClaimFor(fixture, state);
    if (claim === null) throw new TypeError('Expected a live inspection claim.');
    return Object.freeze({
      payloadVersion: 1, state, stateRevision, artifact: fixture.artifact,
      unsignedSimulation: fixture.input.persist.unsignedSimulation, claim,
    });
  }
  if (state === 'REVOKED_NO_SEND') {
    return Object.freeze({
      payloadVersion: 1, state, stateRevision,
      artifactId: fixture.artifact.artifactId,
      signature: fixture.artifact.signature,
      signedTransactionHash: fixture.artifact.signedTransactionHash,
      claim: null,
    });
  }
  const claim = inspectionClaimFor(fixture, state);
  if (claim === null) throw new TypeError('Expected a live inspection claim.');
  return Object.freeze({
    payloadVersion: 1, state, stateRevision,
    artifactId: fixture.artifact.artifactId,
    signature: fixture.artifact.signature,
    signedTransactionHash: fixture.artifact.signedTransactionHash,
    claim,
  });
}

function inspectionClaimFor(
  fixture: ReturnType<typeof workerFixture>,
  state: ExecutionLiveSignedTransactionInspectionV1['state'],
): ClaimedExecutionIntent | null {
  if (state === 'REVOKED_NO_SEND') return null;
  const initial = fixture.input.persist.claim;
  if (state === 'ACCEPTED') {
    return claimAt(initial, 'SUBMITTED', initial.intent.stateRevision + 3n, 'SUBMISSION_ACCEPTED');
  }
  if (state === 'AMBIGUOUS') {
    return claimAt(
      initial, 'UNKNOWN_REQUIRES_RECONCILIATION', initial.intent.stateRevision + 3n,
      'RECONCILIATION_REQUIRED',
    );
  }
  return claimAt(
    initial, 'SIGNED_NOT_SUBMITTED', initial.intent.stateRevision + 2n,
    'SIGNATURE_PERSISTED',
  );
}

function submissionStartedFor(
  fixture: ReturnType<typeof workerFixture>,
  stateRevision: bigint,
): Awaited<ReturnType<ExecutionLiveRepository['beginSubmission']>> {
  return Object.freeze({
    payloadVersion: 1,
    state: 'SUBMISSION_STARTED',
    stateRevision,
    artifact: fixture.artifact,
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
  const persistedClaim = claimAt(
    fixture.input.persist.claim,
    'SIGNED_NOT_SUBMITTED',
    fixture.input.persist.claim.intent.stateRevision + 2n,
    'SIGNATURE_PERSISTED',
  );
  const persisted = Object.freeze({
    payloadVersion: 1 as const, artifact: fixture.artifact,
    unsignedSimulation: fixture.input.persist.unsignedSimulation,
    state: 'PERSISTED' as const, stateRevision: 0n, claim: persistedClaim,
  });
  const signedSimulated = Object.freeze({
    ...persisted, state: 'SIGNED_SIMULATED' as const, stateRevision: 1n,
  });
  const submissionStarted = Object.freeze({
    ...persisted, state: 'SUBMISSION_STARTED' as const, stateRevision: 2n,
  });
  let inspectionCount = 0;
  return Object.freeze({
    activateRpcBudget: () => undefined,
    reserveSubmissionRpcCall: () => Promise.resolve(),
    repository: {
      persistSigned: () => {
        calls.push('persist');
        return Promise.resolve(Object.freeze({
          payloadVersion: 1 as const, artifact: fixture.artifact, claim: persistedClaim,
        }));
      },
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
        claim: ClaimedExecutionIntent,
        outcome: ExecutionLiveSubmissionOutcomeV1,
      ) => {
        calls.push(`record-${outcome.outcome.toLowerCase()}`);
        if (acceptedRecordFailure && outcome.outcome === 'ACCEPTED') {
          return Promise.reject(new Error('accepted outcome commit unknown'));
        }
        return Promise.resolve(Object.freeze({
          payloadVersion: 1 as const,
          artifact: fixture.artifact,
          claim: claimAt(
            claim,
            outcome.outcome === 'ACCEPTED'
              ? 'SUBMITTED' : 'UNKNOWN_REQUIRES_RECONCILIATION',
            claim.intent.stateRevision + 1n,
            outcome.outcome === 'ACCEPTED'
              ? 'SUBMISSION_ACCEPTED' : 'RECONCILIATION_REQUIRED',
          ),
        }));
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
    renewBeforeSubmission: (claim: ClaimedExecutionIntent) => {
      calls.push('renew-before-submission');
      return Promise.resolve(claim);
    },
    readBlockhashValidity: () => {
      calls.push('read-blockhash-validity');
      return Promise.resolve(fixture.blockhashValidity);
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

function claimAt(
  previous: ClaimedExecutionIntent,
  status: ExecutionIntentV1['status'],
  stateRevision: bigint,
  lastReasonCode: ExecutionIntentV1['lastReasonCode'],
): ClaimedExecutionIntent {
  return Object.freeze({
    ...previous,
    intent: Object.freeze({
      ...previous.intent,
      status,
      stateRevision,
      lastReasonCode,
      updatedAtMs: previous.intent.updatedAtMs + 1,
    }),
  });
}

function releaseClaim(
  released: ClaimedExecutionIntent,
  authoritative: ClaimedExecutionIntent,
): boolean {
  assert.equal(released.intent.status, authoritative.intent.status);
  assert.equal(released.intent.stateRevision, authoritative.intent.stateRevision);
  assert.equal(released.leaseToken, authoritative.leaseToken);
  return true;
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
        preSignatureLockId: `execution_pre_signature_lock_${'e'.repeat(64)}`,
        qualificationId: `execution_safety_qualification_${'a'.repeat(64)}`,
        reservationId: `execution_exposure_reservation_${'b'.repeat(64)}`,
        artifact, unsignedSimulation,
        rpcBudget: Object.freeze({
          payloadVersion: 1 as const, callsUsed: 5, callsLimit: 12,
        }),
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
        quoteMaxAgeMs: 60_000, slippageBps: 0n, snapshotMaxSlotLag: 128,
        maxComputeUnits: 1_400_000n, maxFeeLamports: 10_000_000n,
        maxFeePayerLamportDebit: 10_000_000_000n, maxRpcCallsPerAttempt: 12, leaseMs: 3_000,
      }),
    }),
    blockhashValidity: Object.freeze({
      payloadVersion: 1 as const, providerId: 'primary', blockhash: artifact.blockhash,
      valid: true as const, observedBlockHeight: 499n, contextSlot: 127n,
      observedAtMs: nowMs + 75,
    }),
  });
}
