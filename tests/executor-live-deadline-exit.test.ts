import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeadlineExit,
  type DeadlineExitServiceDependencies,
} from '../src/executor-live/deadline-exit.service.js';
import type {
  ExecutionDeadlineExitResultV1,
  ExecutionLiveRepository,
} from '../src/ports/execution-live-repository.js';

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
type Equal<Left, Right> = (
  <Value>() => Value extends Left ? 1 : 2
) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */
type Expect<Value extends true> = Value;
type DeadlineScannerContract = Expect<Equal<
  ExecutionLiveRepository['createNextDeadlineExitIntent'],
  () => Promise<ExecutionDeadlineExitResultV1 | null>
>>;
void (null as never as DeadlineScannerContract);

function compileTimeDeadlineScannerAssertions(repository: ExecutionLiveRepository): void {
  void repository.createNextDeadlineExitIntent();
  // @ts-expect-error the durable scanner accepts no caller-controlled clock or position.
  void repository.createNextDeadlineExitIntent({ observedAtMs: 1, positionId: 'position' });
}
void compileTimeDeadlineScannerAssertions;

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
