import assert from 'node:assert/strict';
import test from 'node:test';
import type { FinalityReconcilerDiagnosticV1 } from '../src/domain/finality-reconciler-diagnostic.js';
import {
  createFinalityReconcilerDiagnosticSink,
  type FinalityDiagnosticLogger,
} from '../src/application/finality-reconciler-diagnostic-logger.js';

interface CapturedLog {
  readonly level: 'warn' | 'info';
  readonly record: object;
  readonly message: string;
}

function captureLogger(entries: CapturedLog[]): FinalityDiagnosticLogger {
  return Object.freeze({
    warn(record: object, message: string): void {
      entries.push(Object.freeze({ level: 'warn', record, message }));
    },
    info(record: object, message: string): void {
      entries.push(Object.freeze({ level: 'info', record, message }));
    },
  });
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function diagnostic(
  phase: FinalityReconcilerDiagnosticV1['phase'],
): FinalityReconcilerDiagnosticV1 {
  return Object.freeze({
    version: 1,
    phase,
    reasonCode: phase === 'DEGRADED' ? 'FINALITY_BLOCK' : null,
    degradedAtMs: 1_000,
    observedAtMs: 1_250,
    durationMs: 250,
    consecutiveFailures: 12,
    suppressedFailures: 10,
  });
}

void test('diagnostic logger maps degraded and recovered phases to fixed levels, events and messages', () => {
  const entries: CapturedLog[] = [];
  const sink = createFinalityReconcilerDiagnosticSink(captureLogger(entries));

  sink(diagnostic('DEGRADED'));
  sink(diagnostic('RECOVERED'));

  assert.deepEqual(entries, [
    {
      level: 'warn',
      record: {
        event: 'listener.finality_reconciler_degraded',
        version: 1,
        phase: 'DEGRADED',
        reasonCode: 'FINALITY_BLOCK',
        degradedAtMs: 1_000,
        observedAtMs: 1_250,
        durationMs: 250,
        consecutiveFailures: 12,
        suppressedFailures: 10,
      },
      message: 'Réconciliateur de finalité dégradé.',
    },
    {
      level: 'info',
      record: {
        event: 'listener.finality_reconciler_recovered',
        version: 1,
        phase: 'RECOVERED',
        reasonCode: null,
        degradedAtMs: 1_000,
        observedAtMs: 1_250,
        durationMs: 250,
        consecutiveFailures: 12,
        suppressedFailures: 10,
      },
      message: 'Réconciliateur de finalité rétabli.',
    },
  ]);
  assert.ok(entries.every(({ record }) => Object.isFrozen(record)));
});

void test('diagnostic logger projects only the stable event and diagnostic fields', () => {
  const entries: CapturedLog[] = [];
  const sink = createFinalityReconcilerDiagnosticSink(captureLogger(entries));
  const tainted = {
    ...diagnostic('DEGRADED'),
    error: 'private error',
    stack: 'private stack',
    url: 'https://rpc.private',
    signature: 'private signature',
    payload: { private: true },
    mint: 'private mint',
    wallet: 'private wallet',
    secret: 'private secret',
  } as FinalityReconcilerDiagnosticV1;

  sink(tainted);

  const entry = entries[0];
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry.record), [
    'event',
    'version',
    'phase',
    'reasonCode',
    'degradedAtMs',
    'observedAtMs',
    'durationMs',
    'consecutiveFailures',
    'suppressedFailures',
  ]);
  for (const forbidden of [
    'error', 'stack', 'url', 'signature', 'payload', 'mint', 'wallet', 'secret',
  ]) assert.equal(Object.hasOwn(entry.record, forbidden), false);
});

void test('diagnostic logger consumes a rejected native Promise without awaiting it', async () => {
  const failure = new Error('private asynchronous logger failure');
  const unhandled: unknown[] = [];
  const observeUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', observeUnhandled);
  try {
    const sink = createFinalityReconcilerDiagnosticSink(Object.freeze({
      warn(): unknown { return Promise.reject(failure); },
      info(): unknown { return undefined; },
    }));

    sink(diagnostic('DEGRADED'));
    await nextTurn();
    await nextTurn();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', observeUnhandled);
  }
});

void test('diagnostic logger never inspects or invokes an arbitrary thenable', () => {
  let thenReads = 0;
  const arbitraryThenable = Object.defineProperty({}, 'then', {
    get(): never {
      thenReads += 1;
      throw new Error('arbitrary thenable must remain opaque');
    },
  });
  const sink = createFinalityReconcilerDiagnosticSink(Object.freeze({
    warn(): unknown { return arbitraryThenable; },
    info(): unknown { return undefined; },
  }));

  assert.doesNotThrow(() => { sink(diagnostic('DEGRADED')); });
  assert.equal(thenReads, 0);
});
