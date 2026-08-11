import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const validatorUrl = new URL('../scripts/validate-deployment-images.mjs', import.meta.url);
const validator = await import(validatorUrl.href) as Readonly<{
  MAX_DEPLOYMENT_IMAGE_INPUT_BYTES: number;
  DeploymentImageValidationError: new (code: string) => Error & { readonly code: string };
  readBoundedDeploymentImageInput: (input: AsyncIterable<Uint8Array>) => Promise<string>;
  validateDeploymentImages: (input: string) => void;
}>;

const backend = `registry.example/listener/backend@sha256:${'a'.repeat(64)}`;
const frontend = `registry.example/listener/frontend@sha256:${'b'.repeat(64)}`;
const validLines = [frontend, backend, backend, backend] as const;

void test('accepts exactly one frontend digest and one backend digest shared by three services', () => {
  assert.doesNotThrow(() => { validator.validateDeploymentImages(`${validLines.join('\n')}\n`); });
  assert.doesNotThrow(() => { validator.validateDeploymentImages(`${validLines.join('\r\n')}\r\n`); });
});

void test('rejects mutable, uppercase, malformed, incorrectly counted, and incorrectly shared images', () => {
  const invalid = [
    [...validLines.slice(0, 3), 'registry.example/listener/backend:latest'].join('\n'),
    [...validLines.slice(0, 3), `registry.example/listener/backend@sha256:${'A'.repeat(64)}`].join('\n'),
    validLines.slice(0, 3).join('\n'),
    [...validLines, backend].join('\n'),
    [frontend, frontend, backend, backend].join('\n'),
    [backend, backend, backend, backend].join('\n'),
    [frontend, backend, backend, `${backend}\nextra`].join('\n'),
    `${validLines.join('\n')}\n\n`,
  ];

  for (const input of invalid) {
    assert.throws(
      () => { validator.validateDeploymentImages(input); },
      validationCode('DEPLOYMENT_IMAGES_INVALID'),
    );
  }
});

void test('reads chunked UTF-8 input and rejects input beyond the byte limit before validation', async () => {
  const expected = `${validLines.join('\n')}\n`;
  const chunks = [Buffer.from(expected.slice(0, 19)), Buffer.from(expected.slice(19))];
  assert.equal(
    await validator.readBoundedDeploymentImageInput(Readable.from(chunks)),
    expected,
  );

  const oversized = Readable.from([
    Buffer.alloc(validator.MAX_DEPLOYMENT_IMAGE_INPUT_BYTES, 0x61),
    Buffer.from('b'),
  ]);
  await assert.rejects(
    validator.readBoundedDeploymentImageInput(oversized),
    validationCode('DEPLOYMENT_IMAGES_INPUT_TOO_LARGE'),
  );
});

void test('CLI stays silent on success and emits one stable redacted line on invalid or oversized input', () => {
  const script = fileURLToPath(validatorUrl);
  const success = spawnSync(process.execPath, [script], {
    encoding: 'utf8', input: `${validLines.join('\n')}\n`, timeout: 10_000,
  });
  assert.deepEqual(
    { status: success.status, stdout: success.stdout, stderr: success.stderr },
    { status: 0, stdout: '', stderr: '' },
  );

  const secret = `registry.example/review-secret:latest-${'x'.repeat(512)}`;
  const failure = spawnSync(process.execPath, [script], {
    encoding: 'utf8', input: `${secret}\n`, timeout: 10_000,
  });
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.equal(
    failure.stderr,
    '{"event":"deployment.images","code":"DEPLOYMENT_IMAGES_INVALID"}\n',
  );
  assert.doesNotMatch(failure.stderr, /review-secret|registry\.example|latest/u);

  const oversized = spawnSync(process.execPath, [script], {
    encoding: 'utf8', input: 'x'.repeat(validator.MAX_DEPLOYMENT_IMAGE_INPUT_BYTES + 1), timeout: 10_000,
  });
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stdout, '');
  assert.equal(
    oversized.stderr,
    '{"event":"deployment.images","code":"DEPLOYMENT_IMAGES_INPUT_TOO_LARGE"}\n',
  );
});

function validationCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => (
    error instanceof validator.DeploymentImageValidationError && error.code === code
  );
}
