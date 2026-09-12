import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservedPipelineError } from '../src/application/observed-transaction-pipeline.js';
import { OBSERVED_PIPELINE_ORIGIN_CODES, OBSERVED_PIPELINE_STAGES } from '../src/domain/observed-pipeline-failure.js';
import { LaunchpadObservationError } from '../src/application/launchpad-observation-errors.js';
import { LaunchpadObservationService } from '../src/application/launchpad-observation.service.js';
import { PumpFunLaunchpadAdapter } from '../src/launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import { TransactionInboxWorker, type TransactionInboxWorkerPipeline } from '../src/application/transaction-inbox-worker.js';
import { assertValidIngestionFailure, createDurableTransactionSnapshot, type IngestionFailure } from '../src/domain/transaction-ingestion.js';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';
import type pg from 'pg';
import { PumpBorshReader } from '../src/launchpads/pumpfun/borsh-reader.js';
import { PumpDecodingError } from '../src/launchpads/pumpfun/errors.js';
import * as pumpErrors from '../src/launchpads/pumpfun/errors.js';
import * as swapErrors from '../src/markets/pumpswap/errors.js';
import { PumpSwapDecodingError } from '../src/markets/pumpswap/errors.js';
import { decodePumpSwapTransaction } from '../src/markets/pumpswap/transaction-decoder.js';
import { failurePipeline, failureTransaction, realPumpPipeline, malformedPumpTransaction } from './observed-pipeline-failure-fixtures.js';

const swapCodes = [
  'PUMPSWAP_ACCOUNT_MISSING', 'PUMPSWAP_BORSH_INVALID', 'PUMPSWAP_BORSH_TRUNCATED',
  'PUMPSWAP_EVENT_AMBIGUOUS', 'PUMPSWAP_EVENT_DUPLICATE', 'PUMPSWAP_EVENT_MISMATCH',
  'PUMPSWAP_EVENT_MISSING', 'PUMPSWAP_EVENT_ORPHANED', 'PUMPSWAP_SCHEMA_UNSUPPORTED',
  'PUMPSWAP_STACK_HEIGHT_REQUIRED', 'PUMPSWAP_TOKEN_PROGRAM_UNSUPPORTED',
] as const;

const invalidDurableFailures = [
  ['ObservedPipelineError', true],
  ['ObservedPipelineFailure.v2.launchpad_observation.PUMP_BORSH_INVALID', false],
  ['ObservedPipelineFailure.v1.secret.PUMP_BORSH_INVALID', false],
  ['ObservedPipelineFailure.v1.launchpad_observation.SECRET', false],
  ['ObservedPipelineFailure.v1.launchpad_observation.UNKNOWN', false],
  ['ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_INVALID', true],
  ['ObservedPipelineFailure.v1.unclassified.PUMP_BORSH_INVALID', false],
  ['ObservedPipelineFailure.v1.unclassified.UNKNOWN.secret', true],
] as const;

void test('rejects noncanonical pipeline taxonomy and retry decisions before any PostgreSQL I/O', async () => {
  let calls = 0;
  const pool = { async connect() { calls += 1; throw new Error('unexpected I/O'); } };
  const repository = new PostgresTransactionInboxRepository(pool as unknown as pg.Pool);
  for (const [errorName, retryable] of invalidDurableFailures) {
    const failure = Object.freeze({ code: 'PIPELINE_STAGE_FAILED' as const, errorName, retryable });
    assert.throws(() => { assertValidIngestionFailure(failure); }, TypeError);
    await assert.rejects(repository.markFailed('sig', 'lease', failure));
  }
  assert.equal(calls, 0);
});

void test('the durable contract exhaustively covers every adapter code and real stage', () => {
  assert.deepEqual(OBSERVED_PIPELINE_ORIGIN_CODES, [...pumpErrors.PUMP_DECODING_ERROR_CODES, ...swapCodes, 'UNKNOWN']);
  for (const stage of OBSERVED_PIPELINE_STAGES) {
    for (const code of OBSERVED_PIPELINE_ORIGIN_CODES) {
      assert.doesNotThrow(() => { assertValidIngestionFailure(Object.freeze({
        code: 'PIPELINE_STAGE_FAILED', errorName: `ObservedPipelineFailure.v1.${stage}.${code}`, retryable: code === 'UNKNOWN',
      })); });
    }
  }
  assert.doesNotThrow(() => { assertValidIngestionFailure(Object.freeze({
    code: 'PIPELINE_STAGE_FAILED', errorName: 'ObservedPipelineFailure.v1.unclassified.UNKNOWN', retryable: true,
  })); });
});

void test('the real launchpad service does not inspect proxies or infer authority through public cause chains', async () => {
  let traps = 0;
  const trap = () => { traps += 1; throw new Error('secret'); };
  const internal = pumpErrors.createPumpDecodingError('PUMP_BORSH_INVALID', false, 'secret');
  const publicWrapper = new LaunchpadObservationError('detect_launches', 'pumpfun', 'program', 'sig', internal);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const cause of [new Proxy({}, { get: trap, getPrototypeOf: trap }), revoked.proxy, publicWrapper] as readonly unknown[]) {
    const adapter = new PumpFunLaunchpadAdapter({ async read() { assert.fail(); } }, () => { throw cause; });
    const service = new LaunchpadObservationService(adapter, { async record() { assert.fail(); } });
    const pipeline = failurePipeline(() => {}, 'launchpad_observation', service);
    assert.deepEqual(await runFailure(() => {}, true, 'launchpad_observation', failureTransaction(), pipeline), {
      code: 'PIPELINE_STAGE_FAILED', errorName: 'ObservedPipelineFailure.v1.launchpad_observation.UNKNOWN', retryable: true,
    });
  }
  assert.equal(traps, 0);
});

void test('PumpSwap contextual issues do not launder external errors or inspect hostile proxies', () => {
  let traps = 0;
  const trap = () => { traps += 1; throw new Error('trap secret'); };
  const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap });
  const transaction = {
    ...failureTransaction(),
    instructions: [{ programId: 'program', accounts: [], data: new Uint8Array(),
      instructionIndex: 0, innerInstructionIndex: null, parentInstructionIndex: null, stackHeight: null }],
  };
  for (const cause of [new PumpSwapDecodingError('PUMPSWAP_BORSH_INVALID', 'secret'), hostile] as readonly unknown[]) {
    let caught: unknown;
    try {
      decodePumpSwapTransaction(transaction, () => { throw cause; });
    } catch (error) { caught = error; }
    assert.equal(caught, cause);
  }
  assert.equal(traps, 0);
  const internal = swapErrors.createPumpSwapDecodingError('PUMPSWAP_BORSH_TRUNCATED', 'secret');
  Object.defineProperties(internal, { code: { get: trap }, message: { get: trap } });
  const decoded = decodePumpSwapTransaction(transaction, () => { throw internal; }, () => null);
  assert.equal(decoded.issues.length, 1);
  assert.equal(decoded.issues[0]?.code, 'PUMPSWAP_BORSH_TRUNCATED');
  assert.equal(decoded.issues[0]?.cause, internal);
  assert.doesNotMatch(decoded.issues[0]?.message ?? '', /secret/);
  assert.equal(traps, 0);
});

void test('exhaustively classifies internal Pump/PumpSwap codes on fresh and replay snapshots, ignoring mutable public metadata', async () => {
  const pumpFactory = pumpErrors.createPumpDecodingError;
  const swapFactory = swapErrors.createPumpSwapDecodingError;
  assert.deepEqual(swapErrors.PUMPSWAP_DECODING_ERROR_CODES, swapCodes);
  for (const replay of [false, true]) {
    for (const code of [...pumpErrors.PUMP_DECODING_ERROR_CODES, ...swapCodes]) {
      for (const stage of ['launchpad_observation', 'pumpswap_observation'] as const) {
        const origin: unknown = code.startsWith('PUMP_')
          ? Reflect.apply(pumpFactory, undefined, [code, true, 'secret message', 'secret signature'])
          : Reflect.apply(swapFactory, undefined, [code, 'secret message', 'secret signature']);
        Object.assign(origin as object, { code: 'SECRET', name: 'SECRET', retryable: true });
        assert.deepEqual(await runFailure(() => { throw origin; }, replay, stage), {
          code: 'PIPELINE_STAGE_FAILED', errorName: `ObservedPipelineFailure.v1.${stage}.${code}`, retryable: false,
        });
      }
    }
  }
});

async function runFailure(operation: () => unknown, replay: boolean, stage: 'launchpad_observation' | 'pumpswap_observation' | 'load_tracked_mints' = 'launchpad_observation', transaction = failureTransaction(), observedPipeline: TransactionInboxWorkerPipeline = failurePipeline(operation, stage)) {
  let marked: IngestionFailure | null = null;
  let located = 0;
  let saved = 0;
  const worker = new TransactionInboxWorker({
    async claim() {
      return Object.freeze({
        signature: 'sig', slot: 1n, confirmationStatus: 'confirmed', observedAtMs: 1000,
        leaseToken: 'lease', leaseExpiresAtMs: 11000, attempts: 1,
        normalizedTransaction: replay ? createDurableTransactionSnapshot(transaction) : null,
      });
    },
    async renewLease() {},
    async saveSnapshot() { saved += 1; },
    async markProcessed() { assert.fail('failure must not be processed'); },
    async markFailed(_signature, _token, failure) { marked = failure; },
  }, {
    async locate() { located += 1; return transaction; },
  }, observedPipeline, {
    leaseSeconds: 10, renewalIntervalMs: 1000, idlePollMs: 100, now: () => 1000,
  });
  const result = await worker.runOnce();
  assert.equal(result.kind, 'failed');
  assert.equal(located, replay ? 0 : 1);
  assert.equal(saved, replay ? 0 : 1);
  assert.ok(Object.isFrozen(marked));
  return marked;
}

void test('worker trusts immutable wrapper identity, not altered public fields or a proxy around an authentic wrapper', async () => {
  let traps = 0;
  const trap = () => { traps += 1; throw new Error('secret getter'); };
  for (const proxied of [false, true]) {
    const pipeline = failurePipeline(() => { new PumpBorshReader(new Uint8Array()).readBool(); });
    const result = await runFailure(() => {}, true, 'launchpad_observation', failureTransaction(), {
      async process(tx, observedAtMs) {
        try { return await pipeline.process(tx, observedAtMs); } catch (error) {
          Object.defineProperties(error, { code: { get: trap }, stage: { get: trap },
            name: { get: trap }, cause: { get: trap } });
          if (proxied) {
            const wrapped: unknown = new Proxy(error as object, { get: trap, getPrototypeOf: trap });
            throw wrapped;
          }
          throw error;
        }
      },
    });
    assert.deepEqual(result, {
      code: 'PIPELINE_STAGE_FAILED',
      errorName: proxied ? 'ObservedPipelineFailure.v1.unclassified.UNKNOWN'
        : 'ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_TRUNCATED',
      retryable: proxied,
    });
  }
  assert.equal(traps, 0);
});

void test('real Pump decoder, adapter, launchpad service, observed pipeline and worker retain all three H2i failure codes offline', async () => {
  for (const replay of [false, true]) {
    for (const code of ['PUMP_BORSH_INVALID', 'PUMP_BORSH_TRUNCATED', 'PUMP_ACCOUNT_MISSING'] as const) {
      const transaction = malformedPumpTransaction(code);
      assert.deepEqual(await runFailure(() => {}, replay, 'launchpad_observation', transaction, realPumpPipeline()), {
        code: 'PIPELINE_STAGE_FAILED', errorName: `ObservedPipelineFailure.v1.launchpad_observation.${code}`, retryable: false,
      });
    }
  }
});

void test('terminalizes actual Pump Borsh failures on fresh and replayed snapshots with safe v1 metadata', async () => {
  for (const replay of [false, true]) {
    for (const [bytes, code] of [
      [Uint8Array.of(2), 'PUMP_BORSH_INVALID'],
      [new Uint8Array(), 'PUMP_BORSH_TRUNCATED'],
    ] as const) {
      assert.deepEqual(await runFailure(() => new PumpBorshReader(bytes).readBool(), replay), {
        code: 'PIPELINE_STAGE_FAILED',
        errorName: `ObservedPipelineFailure.v1.launchpad_observation.${code}`,
        retryable: false,
      });
    }
  }
});

void test('preserves the raw cause in memory but excludes it from durable metadata', async () => {
  const cause = new Error('https://secret.invalid/key?token=secret');
  await assert.rejects(failurePipeline(() => { throw cause; }).process(failureTransaction(), 1000), (error: unknown) => {
    assert.ok(error instanceof ObservedPipelineError);
    assert.equal(error.cause, cause);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

void test('foreign DB/RPC values, public constructions, subclasses and hostile proxies remain UNKNOWN without introspection', async () => {
  let traps = 0;
  const trap = () => { traps += 1; throw new Error('secret trap'); };
  const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  class ForeignPumpError extends PumpDecodingError {}
  for (const cause of [
    undefined, null, 'secret', new Error('DB secret'), new Error('RPC secret'),
    { code: 'PUMP_BORSH_INVALID', retryable: false },
    new PumpDecodingError('PUMP_BORSH_INVALID', false, 'secret'),
    new ForeignPumpError('PUMP_BORSH_INVALID', false, 'secret'),
    new PumpSwapDecodingError('PUMPSWAP_BORSH_INVALID', 'secret'),
    Object.create(PumpDecodingError.prototype),
    Object.create(PumpSwapDecodingError.prototype), hostile, revoked.proxy,
  ]) {
    assert.deepEqual(await runFailure(() => { throw cause; }, true), {
      code: 'PIPELINE_STAGE_FAILED',
      errorName: 'ObservedPipelineFailure.v1.launchpad_observation.UNKNOWN', retryable: true,
    });
  }
  assert.equal(traps, 0);
});
