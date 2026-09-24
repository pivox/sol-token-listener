import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runDecoderQuarantineRecoveryCli } from '../scripts/recover-decoder-quarantine.js';
import { DECODER_RECOVERY_RESULT_CODES } from '../src/domain/transaction-ingestion.js';

const signature = '1'.repeat(64);

void test('requires exact independent confirmation and emits one bounded scheduled result', async () => {
  const writes: string[] = [];
  let calls = 0;
  const exitCode = await runDecoderQuarantineRecoveryCli({
    argv: [`--signature=${signature}`, `--confirm=${signature}`],
    repository: {
      async recoverDecoderQuarantine(value) {
        calls += 1;
        assert.equal(value, signature);
        return Object.freeze({ code: 'DECODER_RECOVERY_SCHEDULED' as const, signature: value });
      },
    },
    write: (line) => { writes.push(line); },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls, 1);
  assert.deepEqual(writes, [
    `${JSON.stringify({
      event: 'transaction-inbox.decoder-recovery',
      code: 'DECODER_RECOVERY_SCHEDULED',
      signature,
    })}\n`,
  ]);
  assert.ok((writes[0]?.length ?? Infinity) <= 256);
});

void test('maps both success codes to zero and every expected negative result to two', async () => {
  for (const code of DECODER_RECOVERY_RESULT_CODES) {
    const writes: string[] = [];
    const exitCode = await runDecoderQuarantineRecoveryCli({
      argv: [`--confirm=${signature}`, `--signature=${signature}`],
      repository: {
        async recoverDecoderQuarantine(value) {
          return Object.freeze({ code, signature: value });
        },
      },
      write: (line) => { writes.push(line); },
    });
    const expected = code === 'DECODER_RECOVERY_SCHEDULED'
      || code === 'DECODER_RECOVERY_ALREADY_SCHEDULED' ? 0 : 2;
    assert.equal(exitCode, expected);
    assert.equal(writes.length, 1);
    assert.match(writes[0] ?? '', new RegExp(code, 'u'));
  }
});

void test('rejects mismatched confirmation, unknown, duplicate and malformed arguments before access', async () => {
  let calls = 0;
  const repository = {
    async recoverDecoderQuarantine(value: string) {
      calls += 1;
      return Object.freeze({ code: 'DECODER_RECOVERY_SCHEDULED' as const, signature: value });
    },
  };
  for (const [argv, code] of [
    [[`--signature=${signature}`, `--confirm=${'2'.repeat(64)}`], 'DECODER_RECOVERY_CONFIRMATION_REQUIRED'],
    [[`--signature=${signature}`, `--confirm=${signature}`, '--force'], 'DECODER_RECOVERY_ARGUMENTS_INVALID'],
    [[`--signature=${signature}`, `--signature=${signature}`], 'DECODER_RECOVERY_ARGUMENTS_INVALID'],
    [[`--confirm=${signature}`, `--confirm=${signature}`], 'DECODER_RECOVERY_ARGUMENTS_INVALID'],
    [['--signature', signature, `--confirm=${signature}`], 'DECODER_RECOVERY_ARGUMENTS_INVALID'],
  ] as const) {
    const writes: string[] = [];
    assert.equal(await runDecoderQuarantineRecoveryCli({
      argv,
      repository,
      write: (line) => { writes.push(line); },
    }), 2);
    assert.equal(writes.length, 1);
    assert.match(writes[0] ?? '', new RegExp(code, 'u'));
  }
  assert.equal(calls, 0);
});

void test('redacts dependency failures and malformed repository results', async () => {
  for (const recoverDecoderQuarantine of [
    async () => { throw new Error('postgresql://operator:secret@private.invalid/database'); },
    async () => Object.freeze({ code: 'PRIVATE_RESULT', signature, endpoint: 'private.invalid' }),
  ]) {
    const writes: string[] = [];
    assert.equal(await runDecoderQuarantineRecoveryCli({
      argv: [`--signature=${signature}`, `--confirm=${signature}`],
      repository: { recoverDecoderQuarantine },
      write: (line) => { writes.push(line); },
    }), 1);
    assert.deepEqual(writes, [
      '{"event":"transaction-inbox.decoder-recovery","code":"DECODER_RECOVERY_COMMAND_FAILED"}\n',
    ]);
    assert.doesNotMatch(writes[0] ?? '', /secret|private|postgresql/iu);
  }
});

void test('command runner exposes no wallet, RPC, server or submission capability', async () => {
  const source = await readFile(
    new URL('../scripts/recover-decoder-quarantine.ts', import.meta.url),
    'utf8',
  );
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    readonly scripts?: Readonly<Record<string, unknown>>;
  };

  assert.equal(
    packageJson.scripts?.['inbox:recover-decoder'],
    'tsx scripts/recover-decoder-quarantine.ts',
  );
  assert.match(source, /import 'dotenv\/config';/u);
  assert.match(source, /PostgresTransactionInboxRepository/u);
  assert.match(source, /getDatabasePool/u);
  assert.match(source, /closeDatabase/u);
  assert.match(source, /pathToFileURL/u);
  assert.doesNotMatch(
    source,
    /@solana|wallet|Keypair|secretKey|privateKey|sendRawTransaction|sendTransaction|\bRPC\b|createServer|fetch\(|submit/iu,
  );
  assert.doesNotMatch(source, /api\/v1|executor|app\.js/iu);
});
