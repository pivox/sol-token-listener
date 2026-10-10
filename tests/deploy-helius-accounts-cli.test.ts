import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHeliusAccountsCli } from '../scripts/deploy/helius-accounts.js';

function run(argv: readonly string[], file: string | Error) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runHeliusAccountsCli(argv, {
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  }, () => {
    if (file instanceof Error) throw file;
    return file;
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

void test('names prints the account names in order, never a key', () => {
  const result = run(['names', '/run/sol/listener/helius-listener-accounts'], '{"02-spare":"key-b","01-main":"key-a"}');
  assert.deepEqual(result, { code: 0, stdout: '["01-main","02-spare"]\n', stderr: '' });
});

void test('an invalid list exits 78 with a message that names no key', () => {
  const result = run(['names', '/f'], '{"01-main":"key with space"}');
  assert.equal(result.code, 78);
  assert.equal(result.stderr, 'helius-accounts: /f: 01-main must be one printable line without spaces\n');
  assert.equal(result.stdout, '');
});

void test('usage errors exit 64 and an unreadable file exits 1', () => {
  assert.equal(run([], '').code, 64);
  assert.equal(run(['list', '/f'], '').code, 64);
  const missing = Object.assign(new Error('nope'), { code: 'ENOENT' });
  assert.deepEqual(run(['names', '/f'], missing), { code: 1, stdout: '', stderr: 'helius-accounts: cannot read /f (ENOENT)\n' });
});
