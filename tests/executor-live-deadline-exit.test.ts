import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeadlineExit,
  type DeadlineExitServiceDependencies,
} from '../src/executor-live/deadline-exit.service.js';

void test('delegates one deterministic deadline exit request to durable storage', async () => {
  const calls: unknown[] = [];
  const dependencies: DeadlineExitServiceDependencies = Object.freeze({
    repository: {
      createDeadlineExitIntent: (input: Readonly<{
        readonly positionId: string;
        readonly observedAtMs: number;
      }>) => {
        calls.push(input);
        return Promise.resolve(Object.freeze({
          payloadVersion: 1 as const, kind: 'NOT_DUE' as const, intent: null,
        }));
      },
    },
  });
  const result = await createDeadlineExit(dependencies, Object.freeze({
    payloadVersion: 1,
    positionId: `execution_live_position_${'a'.repeat(64)}`,
    observedAtMs: 1_786_699_300_000,
  }));
  assert.equal(result.kind, 'NOT_DUE');
  assert.deepEqual(calls, [Object.freeze({
    positionId: `execution_live_position_${'a'.repeat(64)}`,
    observedAtMs: 1_786_699_300_000,
  })]);
});
