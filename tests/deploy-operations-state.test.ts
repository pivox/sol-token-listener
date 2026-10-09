import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  controlStateOf,
  hasActiveEnvelope,
  runOperationsStateCli,
} from '../scripts/deploy/operations-state.js';

void test('the control state comes from the status JSON', () => {
  assert.equal(
    controlStateOf('{"payloadVersion":1,"command":"status","controlState":"RUNNING"}'),
    'RUNNING',
  );
  assert.throws(() => controlStateOf('{"controlState":"PAUSED"}'), TypeError);
  assert.throws(() => controlStateOf('not json'), SyntaxError);
});

void test('an envelope counts only when ACTIVE and inside its window', () => {
  const show = (state: string, validUntilMs: number): string => JSON.stringify({
    payloadVersion: 1, command: 'envelope-show', envelopes: [{ envelopeId: 'e', state, validUntilMs }],
  });
  assert.equal(hasActiveEnvelope(show('ACTIVE', 2_000), 1_000), true);
  assert.equal(hasActiveEnvelope(show('ACTIVE', 1_000), 1_000), false);
  assert.equal(hasActiveEnvelope(show('EXHAUSTED', 2_000), 1_000), false);
  assert.equal(hasActiveEnvelope('{"envelopes":[]}', 1_000), false);
  assert.throws(() => hasActiveEnvelope('{}', 1_000), TypeError);
});

void test('the command maps answers to exit codes for the shell scripts', () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (text: string) => { out.push(text); }, stderr: (text: string) => { err.push(text); } };
  assert.equal(runOperationsStateCli(['control-state'], '{"controlState":"HARD_STOP"}', io, 0), 0);
  assert.deepEqual(out, ['HARD_STOP\n']);
  assert.equal(runOperationsStateCli(['active-envelope'], '{"envelopes":[]}', io, 0), 1);
  assert.equal(runOperationsStateCli(['active-envelope'], 'garbage', io, 0), 65);
  assert.equal(runOperationsStateCli(['other'], '', io, 0), 64);
  assert.deepEqual(err, [
    'operations-state: unreadable envelope output\n',
    'usage: operations-state control-state|active-envelope < command output\n',
  ]);
});
