import assert from 'node:assert/strict';
import test from 'node:test';
import { ListenerRuntimeError } from '../src/application/listener-runtime.js';
import { formatLiveStartupDiagnostics } from '../src/live/live-startup-diagnostics.js';

void test('live startup diagnostics preserve listener stage and useful cause while redacting secrets', () => {
  const root = Object.assign(new Error('scan failed: https://rpc-user:FAKE_RPC_PASSWORD@rpc.invalid/?api-key=FAKE_RPC_TOKEN'), {
    name: 'CatchUpWindowExceededError', code: 'CATCH_UP_WINDOW_EXCEEDED',
    cause: Object.assign(new Error('database postgresql://user:FAKE_DB_PASSWORD@db.invalid/app token=FAKE_TOKEN'), { code: 'ETIMEDOUT' }),
  });
  const failure = new ListenerRuntimeError([{
    phase: 'startup', stage: 'scanner-scan', errorName: 'ListenerDependencyError', cause: root,
  }]);

  const diagnostics = formatLiveStartupDiagnostics(failure);
  const serialized = JSON.stringify(diagnostics);
  assert.equal(diagnostics[0]?.phase, 'startup');
  assert.equal(diagnostics[0]?.stage, 'scanner-scan');
  assert.equal(diagnostics[0]?.errorName, 'ListenerDependencyError');
  assert.equal(diagnostics[0]?.code, 'CATCH_UP_WINDOW_EXCEEDED');
  assert.match(diagnostics[0]?.message ?? '', /scan failed/u);
  assert.ok(diagnostics[0]?.causes.some((cause) => cause.code === 'ETIMEDOUT'));
  assert.doesNotMatch(serialized, /FAKE_RPC_PASSWORD|FAKE_RPC_TOKEN|FAKE_DB_PASSWORD|FAKE_TOKEN|rpc-user|user:/u);
  assert.deepEqual(Object.keys(diagnostics[0] ?? {}).sort(), ['causes', 'code', 'errorName', 'message', 'phase', 'stage']);
});

void test('non-listener live startup failure still has a bounded safe diagnostic', () => {
  const diagnostic = formatLiveStartupDiagnostics(Object.assign(new TypeError('password=FAKE_VALUE'), { code: 'EACCES' }))[0];
  assert.equal(diagnostic?.errorName, 'TypeError');
  assert.equal(diagnostic?.code, 'EACCES');
  assert.doesNotMatch(JSON.stringify(diagnostic), /FAKE_VALUE/u);
});
