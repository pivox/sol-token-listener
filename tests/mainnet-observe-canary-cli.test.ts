import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  MAINNET_OBSERVE_CANARY_MAX_INPUT_BYTES,
  runMainnetObserveCanaryCommand,
  type MainnetObserveCanaryCommandDependencies,
} from '../scripts/evaluate-mainnet-observe-canary.js';

const fixtureUrl = new URL(
  './fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json',
  import.meta.url,
);
const fixtureText = await readFile(fixtureUrl, 'utf8');

void test('evaluates one redacted manifest and emits exactly one canonical JSON line', async () => {
  const harness = commandHarness(async (_path, maximumBytes) => {
    assert.equal(maximumBytes, 1_048_576);
    return fixtureText;
  });

  const exitCode = await runMainnetObserveCanaryCommand(['/redacted/input.json'], harness.dependencies);

  assert.equal(exitCode, 2);
  assert.equal(harness.stderr.join(''), '');
  assert.equal(harness.stdout.length, 1);
  assert.equal(harness.stdout[0]?.endsWith('\n'), true);
  const result = JSON.parse(harness.stdout[0] ?? '') as { overallVerdict?: unknown };
  assert.equal(result.overallVerdict, 'FAIL');
});

void test('fails closed with one fixed error for invocation, read, size, and JSON errors', async () => {
  const cases: readonly [readonly string[], () => Promise<string>][] = [
    [[], async () => fixtureText],
    [['one', 'two'], async () => fixtureText],
    [['secret-path'], async () => { throw new Error('private read failure'); }],
    [['secret-path'], async () => 'x'.repeat(MAINNET_OBSERVE_CANARY_MAX_INPUT_BYTES + 1)],
    [['secret-path'], async () => '{"privateKey":"must-not-leak"'],
  ];
  for (const [args, reader] of cases) {
    const harness = commandHarness(reader);
    assert.equal(await runMainnetObserveCanaryCommand(args, harness.dependencies), 1);
    assert.deepEqual(harness.stdout, []);
    assert.deepEqual(harness.stderr, ['MAINNET_OBSERVE_CANARY_EVALUATION_FAILED\n']);
  }
});

void test('turns malicious but valid JSON fields into a redacted inconclusive result', async () => {
  const malicious = JSON.stringify({
    schemaVersion: 'mainnet-observe-canary-input.v1',
    privateKey: 'must-not-leak',
  });
  const harness = commandHarness(async () => malicious);

  const exitCode = await runMainnetObserveCanaryCommand(['/secret/path.json'], harness.dependencies);

  assert.equal(exitCode, 2);
  assert.equal(harness.stderr.join(''), '');
  assert.equal(harness.stdout.join('').includes('must-not-leak'), false);
  assert.equal(harness.stdout.join('').includes('/secret/path.json'), false);
  assert.equal((JSON.parse(harness.stdout[0] ?? '') as { overallVerdict?: unknown }).overallVerdict,
    'INCONCLUSIVE');
});

void test('real CLI exits 2 and writes one JSON line for the known failed fixture', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/evaluate-mainnet-observe-canary.ts', import.meta.url));
  const fixturePath = fileURLToPath(fixtureUrl);
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, fixturePath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  assert.equal((JSON.parse(result.stdout) as { overallVerdict?: unknown }).overallVerdict, 'FAIL');
});

function commandHarness(
  readInput: MainnetObserveCanaryCommandDependencies['readInput'],
): {
  readonly dependencies: MainnetObserveCanaryCommandDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    dependencies: {
      readInput,
      writeStdout(value) { stdout.push(value); },
      writeStderr(value) { stderr.push(value); },
    },
    stdout,
    stderr,
  };
}
