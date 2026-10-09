import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runRoleEnvCli } from '../scripts/deploy/role-env.js';

async function fixture(): Promise<Readonly<{ root: string; environment: NodeJS.ProcessEnv }>> {
  const root = await mkdtemp(join(tmpdir(), 'sol-role-env-'));
  const config = join(root, 'config');
  const run = join(root, 'run');
  await mkdir(config);
  await mkdir(join(run, 'retention'), { recursive: true });
  await mkdir(join(run, 'overrides'));
  await writeFile(join(config, 'retention.env'), 'DATA_RETENTION_HOURS=4\nRETENTION_PURGE_INTERVAL_MS=900000\n');
  await writeFile(join(run, 'retention', 'pg-sol_retention-password'), "retention'password-0123456789\n");
  return {
    root,
    environment: { SOL_CONFIG_DIR: config, SOL_RUN_DIR: run, SOL_STACK_MODE: 'observe', POSTGRES_DB: 'smoke' },
  };
}

function capture(): Readonly<{
  out: string[];
  err: string[];
  io: Readonly<{ stdout: (text: string) => void; stderr: (text: string) => void }>;
}> {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (text) => { out.push(text); }, stderr: (text) => { err.push(text); } } };
}

void test('role-env prints exports that sh evaluates into the role environment', async () => {
  const { root, environment } = await fixture();
  try {
    const { out, err, io } = capture();
    assert.equal(runRoleEnvCli(['retention'], environment, io), 0);
    assert.deepEqual(err, []);
    const shell = spawnSync('sh', [
      '-c', `${out.join('')}printf '%s|%s|%s' "$DATA_RETENTION_HOURS" "$SOL_RUN_UID" "$DATABASE_URL"`,
    ], { encoding: 'utf8' });
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(
      shell.stdout,
      "4|10006|postgresql://sol_retention:retention'password-0123456789@postgres:5432/smoke"
        + '?options=-c%20role%3Dsol_token_retention_worker',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('an override file in the run directory wins over the configuration', async () => {
  const { root, environment } = await fixture();
  try {
    await writeFile(join(root, 'run', 'overrides', 'retention.env'), 'DATA_RETENTION_HOURS=5\n');
    const { out, io } = capture();
    assert.equal(runRoleEnvCli(['retention'], environment, io), 0);
    assert.match(out.join(''), /^export DATA_RETENTION_HOURS='5'$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('role-env refuses unknown roles and reports missing files without values', async () => {
  const { root, environment } = await fixture();
  try {
    let captured = capture();
    assert.equal(runRoleEnvCli(['nosuch'], environment, captured.io), 64);
    assert.deepEqual(captured.err, ['usage: role-env <role>\n']);

    captured = capture();
    assert.equal(runRoleEnvCli(['listener'], environment, captured.io), 78);
    assert.deepEqual(captured.out, []);
    assert.match(captured.err.join(''), /^sol-run listener: missing file .*\/config\/listener\.env\n$/u);

    captured = capture();
    assert.equal(runRoleEnvCli(['retention'], { ...environment, SOL_STACK_MODE: 'LIVE' }, captured.io), 78);
    assert.deepEqual(captured.err, ['sol-run retention: SOL_STACK_MODE must be observe or live\n']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
