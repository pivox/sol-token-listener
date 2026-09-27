import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  captureMainnetTerminalAttribution,
  runMainnetTerminalAttributionCommand,
  writeMainnetTerminalAttributionExclusive,
  type MainnetTerminalAttributionCommandDependencies,
  type MainnetTerminalAttributionConnection,
} from '../scripts/capture-mainnet-terminal-attribution.js';

void test('captures after STOPPED in one read-only repeatable-read snapshot', async () => {
  const queries: string[] = [];
  let resultIndex = 0;
  const resultRows: readonly (readonly Record<string, unknown>[])[] = [
    [{ runtime_state: 'STOPPED', subscriber_state: 'STOPPED', scanner_state: 'STOPPED',
      worker_state: 'STOPPED', reconciler_state: 'STOPPED', leased_transactions: 0 }],
    [],
    [],
    [{ parent_count: '0', incomplete_count: '0' }],
  ];
  const connection: MainnetTerminalAttributionConnection = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] };
      const rows = resultRows[resultIndex];
      resultIndex += 1;
      return { rows: rows ?? [] };
    },
  };

  const artifact = await captureMainnetTerminalAttribution(connection);

  assert.equal(artifact.schemaVersion, 'mainnet-terminal-attribution.v1');
  assert.equal(queries[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.match(queries[1] ?? '', /listener_heartbeats/u);
  assert.match(queries[2] ?? '', /chain_transaction_inbox/u);
  assert.match(queries[3] ?? '', /transaction_inbox_terminal_attributions/u);
  assert.match(queries[4] ?? '', /terminal_attribution_incomplete_count/u);
  assert.equal(queries[5], 'COMMIT');
});

void test('rolls back and reveals no database or provenance error text', async () => {
  const secret = 'postgres://operator:private@db/mainnet signature-secret';
  const queries: string[] = [];
  const connection: MainnetTerminalAttributionConnection = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('SELECT')) throw new Error(secret);
      return { rows: [] };
    },
  };
  await assert.rejects(captureMainnetTerminalAttribution(connection));
  assert.equal(queries.at(-1), 'ROLLBACK');

  const harness = commandHarness({
    async connect() { throw new Error(secret); },
    async close() {},
    async writeArtifact() {},
  });
  const exitCode = await runMainnetTerminalAttributionCommand(['/tmp/private.json'], harness.dependencies);

  assert.equal(exitCode, 1);
  assert.deepEqual(harness.stdout, []);
  assert.deepEqual(harness.stderr, ['MAINNET_TERMINAL_ATTRIBUTION_CAPTURE_FAILED\n']);
  assert.equal(harness.stderr.join('').includes(secret), false);
  assert.equal(harness.stderr.join('').includes('/tmp/private.json'), false);
});

void test('command writes deterministic bytes and closes the database without stdout', async () => {
  const written: { path?: string; bytes?: string } = {};
  let closed = 0;
  const connection = emptyStoppedConnection();
  const harness = commandHarness({
    async connect() { return connection; },
    async close() { closed += 1; },
    async writeArtifact(path, bytes) { written.path = path; written.bytes = bytes; },
  });

  assert.equal(await runMainnetTerminalAttributionCommand(['/secure/evidence.json'], harness.dependencies), 0);
  assert.equal(written.path, '/secure/evidence.json');
  assert.equal(JSON.parse(written.bytes ?? '').schemaVersion, 'mainnet-terminal-attribution.v1');
  assert.equal(closed, 1);
  assert.deepEqual(harness.stdout, []);
  assert.deepEqual(harness.stderr, []);
});

void test('exclusive writer creates an owner-only regular file and rejects an existing path or symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-attribution-'));
  try {
    const output = join(directory, 'evidence.json');
    await writeMainnetTerminalAttributionExclusive(output, '{"ok":true}\n');
    const metadata = await stat(output);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.mode & 0o777, 0o600);
    if (typeof process.getuid === 'function') assert.equal(metadata.uid, process.getuid());
    assert.equal(await readFile(output, 'utf8'), '{"ok":true}\n');
    await assert.rejects(writeMainnetTerminalAttributionExclusive(output, '{}\n'));

    const target = join(directory, 'target.json');
    const linked = join(directory, 'linked.json');
    await writeFile(target, 'untouched', { mode: 0o600 });
    await symlink(target, linked);
    await assert.rejects(writeMainnetTerminalAttributionExclusive(linked, '{}\n'));
    assert.equal(await readFile(target, 'utf8'), 'untouched');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('exclusive writer rejects oversized content and cleans a partial file after a write failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-attribution-failure-'));
  try {
    const oversized = join(directory, 'oversized.json');
    await assert.rejects(writeMainnetTerminalAttributionExclusive(
      oversized,
      'x'.repeat(1_048_577),
    ));
    await assert.rejects(lstat(oversized));

    const partial = join(directory, 'partial.json');
    await assert.rejects(writeMainnetTerminalAttributionExclusive(partial, '{"ok":true}\n', {
      async afterOpen(handle) {
        await handle.writeFile('partial');
        throw new Error('private partial failure');
      },
    }));
    await assert.rejects(lstat(partial));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('fails closed when listener is not fully stopped', async () => {
  const connection = emptyStoppedConnection('RUNNING');
  await assert.rejects(captureMainnetTerminalAttribution(connection), TypeError);
});

function emptyStoppedConnection(runtimeState = 'STOPPED'): MainnetTerminalAttributionConnection {
  let queryIndex = 0;
  return {
    async query(sql) {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      queryIndex += 1;
      if (queryIndex === 1) {
        return { rows: [{
          runtime_state: runtimeState,
          subscriber_state: 'STOPPED',
          scanner_state: 'STOPPED',
          worker_state: 'STOPPED',
          reconciler_state: 'STOPPED',
          leased_transactions: 0,
        }] };
      }
      if (queryIndex === 4) return { rows: [{ parent_count: 0, incomplete_count: 0 }] };
      return { rows: [] };
    },
  };
}

function commandHarness(
  overrides: Pick<MainnetTerminalAttributionCommandDependencies,
  'connect' | 'close' | 'writeArtifact'>,
): {
  readonly dependencies: MainnetTerminalAttributionCommandDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    dependencies: {
      ...overrides,
      writeStdout(value) { stdout.push(value); },
      writeStderr(value) { stderr.push(value); },
    },
    stdout,
    stderr,
  };
}

void constants.O_NOFOLLOW;
