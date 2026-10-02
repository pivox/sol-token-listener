import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  MAINNET_OBSERVE_CANARY_MAX_INPUT_BYTES,
  readBoundedRegularFile,
  runMainnetObserveCanaryCommand,
  type MainnetObserveCanaryCommandDependencies,
} from '../scripts/evaluate-mainnet-observe-canary.js';

const fixtureUrl = new URL(
  './fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json',
  import.meta.url,
);
const fixtureText = await readFile(fixtureUrl, 'utf8');
const terminalAttributionText = `${JSON.stringify({
  schemaVersion: 'mainnet-terminal-attribution.v1',
  currentPopulation: {
    totalRows: 244,
    retainedRows: 244,
    unavailableRows: 190,
    overflow: { groupCount: 0, rowCount: 0 },
    groups: [
      {
        processingStatus: 'FAILED', normalizedErrorName: 'LEGACY_LEASE_EXPIRED',
        retryable: false, failureState: 'TERMINAL', attempts: 3, attemptsInCycle: 3,
        catchUpReasonCode: null, count: 54,
      },
      {
        processingStatus: 'QUARANTINED', normalizedErrorName: 'UNAVAILABLE',
        retryable: null, failureState: 'TERMINAL', attempts: 0, attemptsInCycle: 0,
        catchUpReasonCode: 'PUMP_SCHEMA_UNSUPPORTED', count: 190,
      },
    ],
  },
  diagnosticOccurrences: {
    totalOccurrences: 0,
    retainedOccurrences: 0,
    unavailableOccurrences: 0,
    overflow: { groupCount: 0, occurrenceCount: 0 },
    groups: [],
  },
  incompleteAttribution: { parentRows: 0, missingOccurrences: 0 },
})}\n`;

void test('evaluates the redacted manifest plus aggregate attribution and emits one JSON line', async () => {
  const paths: string[] = [];
  const harness = commandHarness(async (path, maximumBytes) => {
    assert.equal(maximumBytes, 1_048_576);
    paths.push(path);
    return path.endsWith('terminal.json') ? terminalAttributionText : fixtureText;
  });

  const exitCode = await runMainnetObserveCanaryCommand(
    ['/redacted/input.json', '/redacted/terminal.json'],
    harness.dependencies,
  );

  assert.equal(exitCode, 2);
  assert.deepEqual(paths, ['/redacted/input.json', '/redacted/terminal.json']);
  assert.equal(harness.stderr.join(''), '');
  assert.equal(harness.stdout.length, 1);
  assert.equal(harness.stdout[0]?.endsWith('\n'), true);
  const result = JSON.parse(harness.stdout[0] ?? '') as { overallVerdict?: unknown };
  assert.equal(result.overallVerdict, 'FAIL');
});

void test('fails closed with one fixed error for invocation, read, size, and JSON errors', async () => {
  const cases: readonly [readonly string[], () => Promise<string>][] = [
    [[], async () => fixtureText],
    [['one'], async () => fixtureText],
    [['one', 'two', 'three'], async () => fixtureText],
    [['manifest', 'secret-path'], async () => { throw new Error('private read failure'); }],
    [['manifest', 'secret-path'], async () =>
      'x'.repeat(MAINNET_OBSERVE_CANARY_MAX_INPUT_BYTES + 1)],
    [['manifest', 'secret-path'], async () => '{"privateKey":"must-not-leak"'],
  ];
  for (const [args, reader] of cases) {
    const harness = commandHarness(reader);
    assert.equal(await runMainnetObserveCanaryCommand(args, harness.dependencies), 1);
    assert.deepEqual(harness.stdout, []);
    assert.deepEqual(harness.stderr, ['MAINNET_OBSERVE_CANARY_EVALUATION_FAILED\n']);
  }
});

void test('CLI keeps legacy worker evidence inconclusive and accepts only exact paired stopped proof', async () => {
  const manifest = JSON.parse(fixtureText) as Record<string, any>;
  const metrics = {
    version: 1, enabled: true, trackingWindowSeconds: 45, claimableBacklogCount: 0,
    classificationPendingCount: 0, oldestClassificationPendingAgeMs: null,
    freshMintCount: 0, extendedMintCount: 0, demotedCount: 0,
  };
  for (const snapshot of [...Object.values(manifest.snapshots) as Record<string, any>[],
    manifest.stoppedHeartbeat as Record<string, any>]) {
    snapshot.workerAdmission = metrics;
    snapshot.workerAdmissionClock = { version: 1, sampledAtMs: snapshot.observedAtMs };
  }
  manifest.postStopWorkerAdmissionClaimableCount = 0;
  const stoppedSampledAtMs = manifest.stoppedHeartbeat.observedAtMs as number;
  for (const [proof, verdict, reasonCode] of [
    [undefined, 'INCONCLUSIVE', 'WORKER_ADMISSION_POST_STOP_EVIDENCE_MISSING'],
    [{ version: 1, sampledAtMs: stoppedSampledAtMs,
      claimableBacklogCount: 0 }, 'PASS', 'WORKER_ADMISSION_BOUNDED'],
    [{ version: 1, sampledAtMs: stoppedSampledAtMs + 1,
      claimableBacklogCount: 0 }, 'INCONCLUSIVE', 'WORKER_ADMISSION_POST_STOP_CLOCK_INCOHERENT'],
    [{ version: 1, sampledAtMs: stoppedSampledAtMs,
      claimableBacklogCount: 0, wallet: 'must-not-leak' }, 'INCONCLUSIVE',
    'WORKER_ADMISSION_POST_STOP_EVIDENCE_MALFORMED'],
  ] as const) {
    manifest.postStopWorkerAdmissionClaimableProof = proof;
    const harness = commandHarness(async (path) => path.endsWith('terminal.json')
      ? terminalAttributionText : JSON.stringify(manifest));
    assert.equal(await runMainnetObserveCanaryCommand(
      ['/redacted/input.json', '/redacted/terminal.json'], harness.dependencies,
    ), 2);
    assert.equal(harness.stdout.length, 1);
    assert.deepEqual(harness.stderr, []);
    const result = JSON.parse(harness.stdout[0] ?? '') as Record<string, any>;
    assert.deepEqual(result.gates.workerAdmission, { verdict, reasonCode });
    assert.equal(result.overallVerdict, 'FAIL', 'The archived real failures remain failures.');
    assert.equal(harness.stdout.join('').includes('must-not-leak'), false);
  }
});

void test('turns malicious but valid JSON fields into a redacted inconclusive result', async () => {
  const malicious = JSON.stringify({
    schemaVersion: 'mainnet-observe-canary-input.v1',
    privateKey: 'must-not-leak',
  });
  const harness = commandHarness(async (path) => path.endsWith('terminal.json')
    ? terminalAttributionText
    : malicious);

  const exitCode = await runMainnetObserveCanaryCommand(
    ['/secret/path.json', '/secret/terminal.json'],
    harness.dependencies,
  );

  assert.equal(exitCode, 2);
  assert.equal(harness.stderr.join(''), '');
  assert.equal(harness.stdout.join('').includes('must-not-leak'), false);
  assert.equal(harness.stdout.join('').includes('/secret/path.json'), false);
  assert.equal((JSON.parse(harness.stdout[0] ?? '') as { overallVerdict?: unknown }).overallVerdict,
    'INCONCLUSIVE');
});

void test('rejects malformed attribution JSON without reflecting path or content', async () => {
  const harness = commandHarness(async (path) => path.endsWith('terminal.json')
    ? '{"signature":"must-not-leak"'
    : fixtureText);

  assert.equal(await runMainnetObserveCanaryCommand(
    ['/redacted/input.json', '/private/terminal.json'],
    harness.dependencies,
  ), 1);
  assert.deepEqual(harness.stdout, []);
  assert.deepEqual(harness.stderr, ['MAINNET_OBSERVE_CANARY_EVALUATION_FAILED\n']);
});

void test('real CLI exits 2 and writes one JSON line for the known failed fixture', async () => {
  const scriptPath = fileURLToPath(new URL('../scripts/evaluate-mainnet-observe-canary.ts', import.meta.url));
  const fixturePath = fileURLToPath(fixtureUrl);
  const directory = await mkdtemp(join(tmpdir(), 'canary-attribution-cli-'));
  try {
    const attributionPath = join(directory, 'terminal.json');
    await writeFile(attributionPath, terminalAttributionText, { encoding: 'utf8', mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', scriptPath, fixturePath, attributionPath],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trimEnd().split('\n').length, 1);
    assert.equal((JSON.parse(result.stdout) as { overallVerdict?: unknown }).overallVerdict, 'FAIL');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('bounded reader rejects symlinks and FIFOs without blocking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canary-cli-'));
  try {
    const regular = join(directory, 'input.json');
    const linked = join(directory, 'linked.json');
    const fifo = join(directory, 'input.fifo');
    await writeFile(regular, fixtureText, 'utf8');
    await symlink(regular, linked);
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    for (const path of [linked, fifo]) {
      await assert.rejects(Promise.race([
        readBoundedRegularFile(path, MAINNET_OBSERVE_CANARY_MAX_INPUT_BYTES),
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('reader blocked')); }, 1_000);
        }),
      ]));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('bounded reader rejects a file that grows after reading starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canary-cli-growth-'));
  try {
    const mutable = join(directory, 'mutable.json');
    const padding = ' '.repeat(MAINNET_OBSERVE_CANARY_MAX_INPUT_BYTES
      - Buffer.byteLength(fixtureText, 'utf8'));
    await writeFile(mutable, `${fixtureText}${padding}`, 'utf8');
    const rejection = assert.rejects(
      readBoundedRegularFile(mutable, MAINNET_OBSERVE_CANARY_MAX_INPUT_BYTES),
    );
    await appendFile(mutable, 'x', 'utf8');
    await rejection;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
