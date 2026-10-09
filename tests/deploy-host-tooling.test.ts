import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const repository = fileURLToPath(root).replace(/\/$/u, '');
const FAKE_HASH = `$2a$10$${'a'.repeat(53)}`;

async function artifact(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

async function fakeDocker(directory: string, body: string): Promise<string> {
  const bin = join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

void test('host scripts are bash and parse', async () => {
  for (const name of ['init-secrets.sh', 'backup.sh']) {
    const source = await artifact(`deploy/host/${name}`);
    assert.ok(source.startsWith('#!/usr/bin/env bash\n'), name);
    assert.match(source, /^set -euo pipefail$/mu, name);
    const syntax = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${name}: ${syntax.stderr}`);
  }
});

void test('init-secrets creates the host layout once, owner-only, and prints no database secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-init-'));
  try {
    const dockerArgs = join(directory, 'docker-args');
    const bin = await fakeDocker(directory,
      `cat > /dev/null; printf '%s' "$*" > '${dockerArgs}'; printf '%s\\n' '${FAKE_HASH}'`);
    const host = join(directory, 'host');
    const run = (): ReturnType<typeof spawnSync> => spawnSync(
      'bash', [join(repository, 'deploy/host/init-secrets.sh'), host],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } },
    );
    const first = run();
    assert.equal(first.status, 0, String(first.stderr));
    const output = String(first.stdout);
    const admin = (await readFile(join(host, 'secrets/db/postgres-admin-password'), 'utf8')).trim();
    assert.match(admin, /^[0-9a-f]{64}$/u);
    assert.equal(output.includes(admin), false);
    assert.equal((output.match(/^front password, shown once/gmu) ?? []).length, 1);
    assert.equal((await readFile(join(host, 'secrets/front/front-basic-auth-hash'), 'utf8')).trim(), FAKE_HASH);
    assert.match(await readFile(dockerArgs, 'utf8'), / hash-password --bcrypt-cost 10$/u);
    assert.equal((await readdir(join(host, 'secrets/db/logins'))).length, 9);
    assert.equal((await stat(join(host, 'secrets'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(host, 'secrets/db/logins/pg-sol_live-password'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(host, 'config'))).mode & 0o777, 0o755);
    assert.equal((await stat(join(host, 'config/live.env'))).mode & 0o777, 0o644);
    assert.match(output, /to provide: .*\/secrets\/back\/wallet-keypair\.json/u);

    const second = run();
    assert.equal(second.status, 0, String(second.stderr));
    assert.equal((await readFile(join(host, 'secrets/db/postgres-admin-password'), 'utf8')).trim(), admin);
    assert.doesNotMatch(String(second.stdout), /front password|created/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('init-secrets leaves no front hash behind when Caddy fails, and retries on the next run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-init-fail-'));
  try {
    const host = join(directory, 'host');
    const hashFile = join(host, 'secrets/front/front-basic-auth-hash');
    const run = (body: string): Promise<ReturnType<typeof spawnSync>> => fakeDocker(directory, body)
      .then((bin) => spawnSync('bash', [join(repository, 'deploy/host/init-secrets.sh'), host], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      }));
    for (const failing of ['cat > /dev/null; exit 1', "cat > /dev/null; printf 'not a hash\\n'"]) {
      const failed = await run(failing);
      assert.notEqual(failed.status, 0, failing);
      assert.doesNotMatch(String(failed.stdout), /front password/u, failing);
      await assert.rejects(stat(hashFile), { code: 'ENOENT' }, failing);
    }
    const retried = await run(`cat > /dev/null; printf '%s\\n' '${FAKE_HASH}'`);
    assert.equal(retried.status, 0, String(retried.stderr));
    assert.equal((await readFile(hashFile, 'utf8')).trim(), FAKE_HASH);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('init-secrets hashes the front password with the Caddy image pinned in the Dockerfile', async () => {
  const [script, dockerfile] = await Promise.all([artifact('deploy/host/init-secrets.sh'), artifact('Dockerfile')]);
  const image = /^caddy_image='([^']+)'$/mu.exec(script)?.[1];
  assert.ok(image !== undefined, 'missing caddy_image');
  assert.ok(dockerfile.includes(`FROM ${image} AS frontend`));
});

void test('backup dumps through the postgres container, writes a checksum and keeps 14 days', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-backup-'));
  try {
    const bin = await fakeDocker(directory, 'printf "%s" "$*" > "$SOL_HOST_DIR/docker-args"; printf "PGDMP-fake"');
    const host = join(directory, 'host');
    await mkdir(join(host, 'backups'), { recursive: true });
    const old = join(host, 'backups', 'sol-20260101T000000Z.dump');
    await writeFile(old, 'old');
    await utimes(old, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const result = spawnSync('bash', [join(repository, 'deploy/host/backup.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host, SOL_REPOSITORY: repository,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const [dump, checksum, ...rest] = (await readdir(join(host, 'backups'))).sort();
    assert.deepEqual(rest, []);
    assert.match(dump ?? '', /^sol-\d{8}T\d{6}Z\.dump$/u);
    assert.equal(checksum, `${dump ?? ''}.sha256`);
    assert.equal(await readFile(join(host, 'backups', dump ?? ''), 'utf8'), 'PGDMP-fake');
    assert.equal(
      await readFile(join(host, 'docker-args'), 'utf8'),
      `compose --env-file ${host}/compose.env -f ${repository}/deploy/compose.yaml exec -T postgres sh -c `
        + 'exec pg_dump -Fc -U sol_owner -d "$POSTGRES_DB"',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('the takeover SQL checks the stop precondition and counts rows in a stable order', async () => {
  const [precondition, counts] = await Promise.all([
    artifact('deploy/sql/takeover-precondition.sql'),
    artifact('deploy/sql/table-row-counts.sql'),
  ]);
  for (const fragment of [
    "execution_entry_envelopes WHERE state = 'ACTIVE'",
    "execution_activation_armaments WHERE state IN ('ARMED', 'LOCKED')",
    "execution_live_positions WHERE state IN ('OPEN', 'EXIT_PENDING', 'UNKNOWN')",
    "WHERE state NOT IN ('RECONCILED', 'REVOKED_NO_SEND')",
  ]) {
    assert.ok(precondition.includes(fragment), fragment);
  }
  assert.match(counts, /table_schema = 'public' AND table_type = 'BASE TABLE'/u);
  assert.match(counts, /ORDER BY table_name COLLATE "C";/u);
});

void test('the backup jobs run backup.sh daily on the server and on the Mac', async () => {
  const [service, timer, plist] = await Promise.all([
    artifact('deploy/host/sol-backup.service'),
    artifact('deploy/host/sol-backup.timer'),
    artifact('deploy/host/com.sol-token-listener.backup.plist'),
  ]);
  assert.match(service, /^Type=oneshot$/mu);
  assert.match(service, /^ExecStart=\/usr\/bin\/env bash \/srv\/sol-token-listener\/repository\/deploy\/host\/backup\.sh$/mu);
  assert.match(timer, /^OnCalendar=\*-\*-\* 04:30:00$/mu);
  assert.match(timer, /^Persistent=true$/mu);
  assert.ok(plist.includes('<string>__SOL_REPOSITORY__/deploy/host/backup.sh</string>'));
  assert.ok(plist.includes('<key>StartCalendarInterval</key>'));
  const lint = spawnSync('plutil', ['-lint', '-'], { input: plist, encoding: 'utf8' });
  if (lint.error === undefined) assert.equal(lint.status, 0, lint.stdout);
});
