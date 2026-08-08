import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInboxRecoveryCli } from '../scripts/recover-inbox.js';

const signature = '1'.repeat(64);

void test('requires exact independent confirmation then emits one scheduled result', async () => {
  const writes: string[] = [];
  let calls = 0;
  const exitCode = await runInboxRecoveryCli({
    argv: [`--signature=${signature}`, `--confirm=${signature}`],
    repository: {
      async recoverExhausted(value) {
        calls += 1;
        assert.equal(value, signature);
        return Object.freeze({ code: 'RECOVERY_SCHEDULED' as const, signature: value });
      },
    },
    write: (line) => { writes.push(line); },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls, 1);
  assert.deepEqual(writes, [
    `${JSON.stringify({
      event: 'transaction-inbox.recovery', code: 'RECOVERY_SCHEDULED', signature,
    })}\n`,
  ]);
});

void test('rejects mismatched confirmation and unknown arguments before repository access', async () => {
  let calls = 0;
  const repository = {
    async recoverExhausted(value: string) {
      calls += 1;
      return Object.freeze({ code: 'RECOVERY_SCHEDULED' as const, signature: value });
    },
  };
  const mismatch: string[] = [];
  assert.equal(await runInboxRecoveryCli({
    argv: [`--signature=${signature}`, `--confirm=${'2'.repeat(64)}`],
    repository,
    write: (line) => { mismatch.push(line); },
  }), 2);
  assert.match(mismatch[0] ?? '', /RECOVERY_CONFIRMATION_REQUIRED/u);

  const invalid: string[] = [];
  assert.equal(await runInboxRecoveryCli({
    argv: [`--signature=${signature}`, `--confirm=${signature}`, '--force'],
    repository,
    write: (line) => { invalid.push(line); },
  }), 2);
  assert.match(invalid[0] ?? '', /RECOVERY_ARGUMENTS_INVALID/u);
  assert.equal(calls, 0);
});

void test('maps ineligible and dependency failures to stable redacted output', async () => {
  const ineligible: string[] = [];
  assert.equal(await runInboxRecoveryCli({
    argv: [`--signature=${signature}`, `--confirm=${signature}`],
    repository: {
      async recoverExhausted(value) {
        return Object.freeze({ code: 'RECOVERY_NOT_ELIGIBLE' as const, signature: value });
      },
    },
    write: (line) => { ineligible.push(line); },
  }), 2);
  assert.match(ineligible[0] ?? '', /RECOVERY_NOT_ELIGIBLE/u);

  const failed: string[] = [];
  assert.equal(await runInboxRecoveryCli({
    argv: [`--signature=${signature}`, `--confirm=${signature}`],
    repository: {
      async recoverExhausted() {
        throw new Error('postgresql://operator:secret@private.invalid/database');
      },
    },
    write: (line) => { failed.push(line); },
  }), 1);
  assert.deepEqual(failed, [
    '{"event":"transaction-inbox.recovery","code":"RECOVERY_COMMAND_FAILED"}\n',
  ]);
  assert.doesNotMatch(failed[0] ?? '', /secret|private|postgresql/iu);
});

void test('command source is local-only and contains no signing or submission capability', async () => {
  const source = await readFile(new URL('../scripts/recover-inbox.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    readonly scripts?: Readonly<Record<string, unknown>>;
  };

  assert.equal(packageJson.scripts?.['inbox:recover'], 'tsx scripts/recover-inbox.ts');
  assert.doesNotMatch(source, /sendRawTransaction|sendTransaction|Keypair|privateKey|secretKey/iu);
  assert.doesNotMatch(source, /api\/v1|createServer|fetch\(/iu);
});
