import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const repository = fileURLToPath(root).replace(/\/$/u, '');
const FAKE_HASH = `$2a$10$${'a'.repeat(53)}`;
// Root passes every permission check, so the tests that rely on a refusal skip themselves as root.
const IS_ROOT = process.getuid?.() === 0;

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
  for (const name of ['init-secrets.sh', 'backup.sh', 'vault-init.sh', 'vault-import.sh']) {
    const source = await artifact(`deploy/host/${name}`);
    assert.ok(source.startsWith('#!/usr/bin/env bash\n'), name);
    assert.match(source, /^set -euo pipefail$/mu, name);
    const syntax = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${name}: ${syntax.stderr}`);
  }
});

void test('init-secrets creates only the bootstrap layout once, owner-only, and prints no database secret', async () => {
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
    for (const path of ['secrets', 'secrets/vault', 'secrets/vault/unseal', 'secrets/vault/approle', 'backups']) {
      assert.equal((await stat(join(host, path))).mode & 0o777, 0o700, path);
    }
    assert.deepEqual((await readdir(join(host, 'secrets'))).sort(), ['db', 'front', 'vault']);
    assert.deepEqual(await readdir(join(host, 'secrets/vault/unseal')), []);
    assert.deepEqual((await readdir(host)).sort(), ['backups', 'secrets']);
    assert.match(output, /^next: deploy\/host\/vault-init\.sh, then deploy\/host\/vault-import\.sh/mu);

    const second = run();
    assert.equal(second.status, 0, String(second.stderr));
    assert.equal((await readFile(join(host, 'secrets/db/postgres-admin-password'), 'utf8')).trim(), admin);
    assert.doesNotMatch(String(second.stdout), /front password|created/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('init-secrets refuses a directory where a secret file belongs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-init-dir-'));
  try {
    const bin = await fakeDocker(directory, `cat > /dev/null; printf '%s\\n' '${FAKE_HASH}'`);
    // What a compose run before init-secrets leaves: Docker created the missing file as a directory.
    for (const secret of ['secrets/db/postgres-admin-password', 'secrets/front/front-basic-auth-hash']) {
      const host = join(directory, secret.replace(/\W/gu, '-'));
      await mkdir(join(host, secret), { recursive: true });
      const result = spawnSync('bash', [join(repository, 'deploy/host/init-secrets.sh'), host], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      assert.equal(result.status, 78, secret);
      assert.equal(result.stderr, `init-secrets: ${host}/${secret} is a directory: remove it, then run again\n`, secret);
      // It refuses before creating anything else.
      await assert.rejects(stat(join(host, 'backups')), { code: 'ENOENT' }, secret);
    }
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

void test('init-secrets leaves no admin password behind when openssl fails, and retries on the next run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-init-openssl-'));
  try {
    const bin = await fakeDocker(directory, `cat > /dev/null; printf '%s\\n' '${FAKE_HASH}'`);
    const host = join(directory, 'host');
    const adminFile = join(host, 'secrets/db/postgres-admin-password');
    const run = (): ReturnType<typeof spawnSync> => spawnSync('bash', [join(repository, 'deploy/host/init-secrets.sh'), host], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    // The fake openssl either fails or answers something that is not 32 bytes of hex.
    for (const failing of ['exit 1', "printf 'not hex\\n'"]) {
      await writeFile(join(bin, 'openssl'), `#!/bin/sh\n${failing}\n`, { mode: 0o755 });
      const failed = run();
      assert.notEqual(failed.status, 0, failing);
      assert.doesNotMatch(String(failed.stdout), /created/u, failing);
      await assert.rejects(stat(adminFile), { code: 'ENOENT' }, failing);
    }
    await rm(join(bin, 'openssl'));
    const retried = run();
    assert.equal(retried.status, 0, String(retried.stderr));
    assert.match(await readFile(adminFile, 'utf8'), /^[0-9a-f]{64}\n$/u);
    assert.equal((await stat(adminFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(host, 'secrets/db')), ['postgres-admin-password']);
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

void test('backup dumps the database and snapshots Vault, with checksums and 14 days kept', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-backup-'));
  try {
    const bin = await fakeDocker(directory, [
      'printf "%s\\n" "$*" >> "$SOL_HOST_DIR/docker-args"',
      'case "$*" in',
      '  *" exec -T postgres "*) printf "PGDMP-fake" ;;',
      '  *" run --rm --no-deps -T vault-snapshot") cat > "$SOL_HOST_DIR/snapshot-stdin"; printf "SNAP-fake" ;;',
      '  *) exit 99 ;;',
      'esac',
    ].join('\n'));
    const host = join(directory, 'host');
    await mkdir(join(host, 'backups'), { recursive: true });
    await mkdir(join(host, 'secrets/vault/approle'), { recursive: true });
    await writeFile(join(host, 'secrets/vault/approle/backup.json'), '{"role_id":"r","secret_id":"s"}\n');
    for (const name of ['sol-20260101T000000Z.dump', 'vault-20260101T000000Z.snap']) {
      const old = join(host, 'backups', name);
      await writeFile(old, 'old');
      await utimes(old, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    }
    const result = spawnSync('bash', [join(repository, 'deploy/host/backup.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host, SOL_REPOSITORY: repository },
    });
    assert.equal(result.status, 0, result.stderr);
    const files = (await readdir(join(host, 'backups'))).sort();
    assert.equal(files.length, 4);
    const [dump, dumpSum, snapshot, snapshotSum] = files;
    assert.match(dump ?? '', /^sol-\d{8}T\d{6}Z\.dump$/u);
    assert.equal(dumpSum, `${dump ?? ''}.sha256`);
    assert.equal(snapshot, `vault-${(dump ?? '').slice(4, -5)}.snap`);
    assert.equal(snapshotSum, `${snapshot ?? ''}.sha256`);
    assert.equal(await readFile(join(host, 'backups', dump ?? ''), 'utf8'), 'PGDMP-fake');
    assert.equal(await readFile(join(host, 'backups', snapshot ?? ''), 'utf8'), 'SNAP-fake');
    assert.equal(await readFile(join(host, 'snapshot-stdin'), 'utf8'), '{"role_id":"r","secret_id":"s"}\n');
    const compose = `compose --env-file ${host}/compose.env -f ${repository}/deploy/compose.yaml`;
    assert.equal(await readFile(join(host, 'docker-args'), 'utf8'), [
      `${compose} exec -T postgres sh -c exec pg_dump -Fc -U sol_owner -d "$POSTGRES_DB"`,
      `${compose} run --rm --no-deps -T vault-snapshot`,
      '',
    ].join('\n'));
    assert.equal(result.stdout, `backup ${host}/backups/${dump ?? ''} ${host}/backups/${snapshot ?? ''}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('backup keeps no empty snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-backup-empty-'));
  try {
    const bin = await fakeDocker(directory, [
      'case "$*" in',
      '  *" exec -T postgres "*) printf "PGDMP-fake" ;;',
      '  *" run --rm --no-deps -T vault-snapshot") cat > /dev/null ;;',
      '  *) exit 99 ;;',
      'esac',
    ].join('\n'));
    const host = join(directory, 'host');
    await mkdir(join(host, 'backups'), { recursive: true });
    await mkdir(join(host, 'secrets/vault/approle'), { recursive: true });
    await writeFile(join(host, 'secrets/vault/approle/backup.json'), '{"role_id":"r","secret_id":"s"}\n');
    const result = spawnSync('bash', [join(repository, 'deploy/host/backup.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host, SOL_REPOSITORY: repository },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'backup: the Vault snapshot is empty\n');
    assert.equal((await readdir(join(host, 'backups'))).some((name) => /^vault-\d{8}T\d{6}Z\.snap$/u.test(name)), false);
    assert.deepEqual((await readdir(join(host, 'backups'))).filter((name) => name.endsWith('.partial')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('backup leaves no partial file when the snapshot tool fails after writing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-backup-failing-'));
  try {
    const bin = await fakeDocker(directory, [
      'case "$*" in',
      '  *" exec -T postgres "*) printf "PGDMP-fake" ;;',
      '  *" run --rm --no-deps -T vault-snapshot") cat > /dev/null; printf "half"; exit 1 ;;',
      '  *) exit 99 ;;',
      'esac',
    ].join('\n'));
    const host = join(directory, 'host');
    await mkdir(join(host, 'backups'), { recursive: true });
    await mkdir(join(host, 'secrets/vault/approle'), { recursive: true });
    await writeFile(join(host, 'secrets/vault/approle/backup.json'), '{"role_id":"r","secret_id":"s"}\n');
    const result = spawnSync('bash', [join(repository, 'deploy/host/backup.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host, SOL_REPOSITORY: repository },
    });
    assert.equal(result.status, 1);
    // The database dump stays, with its checksum; the half snapshot does not.
    const files = (await readdir(join(host, 'backups'))).sort();
    assert.equal(files.length, 2, files.join(' '));
    assert.match(files[0] ?? '', /^sol-\d{8}T\d{6}Z\.dump$/u);
    assert.equal(files[1], `${files[0] ?? ''}.sha256`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('backup refuses a missing AppRole file, after taking the dump', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-backup-approle-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, [
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$*" in',
      '  *" exec -T postgres "*) printf "PGDMP-fake" ;;',
      '  *) exit 99 ;;',
      'esac',
    ].join('\n'));
    const host = join(directory, 'host');
    await mkdir(join(host, 'backups'), { recursive: true });
    const result = spawnSync('bash', [join(repository, 'deploy/host/backup.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host, SOL_REPOSITORY: repository },
    });
    assert.equal(result.status, 78);
    assert.equal(result.stderr, 'backup: secrets/vault/approle/backup.json is missing: run deploy/host/vault-init.sh first\n');
    // The database is still backed up first; nothing else is left, and the snapshot tool never ran.
    const files = (await readdir(join(host, 'backups'))).sort();
    assert.equal(files.length, 2, files.join(' '));
    assert.match(files[0] ?? '', /^sol-\d{8}T\d{6}Z\.dump$/u);
    assert.equal(files[1], `${files[0] ?? ''}.sha256`);
    assert.equal((await readFile(log, 'utf8')).includes('vault-snapshot'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('backup keeps no empty database dump and takes no snapshot after it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-backup-empty-dump-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, [
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$*" in',
      '  *" exec -T postgres "*) ;;',
      '  *) exit 99 ;;',
      'esac',
    ].join('\n'));
    const host = join(directory, 'host');
    await mkdir(join(host, 'backups'), { recursive: true });
    const result = spawnSync('bash', [join(repository, 'deploy/host/backup.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host, SOL_REPOSITORY: repository },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'backup: the database dump is empty\n');
    assert.equal((await readdir(join(host, 'backups'))).some((name) => /\.(?:dump|snap)$/u.test(name)), false);
    assert.deepEqual((await readdir(join(host, 'backups'))).filter((name) => name.endsWith('.partial')), []);
    assert.equal((await readFile(log, 'utf8')).includes('vault-snapshot'), false);
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

const APPROLE_FILES = Object.freeze(['approle/back.json', 'approle/migrate.json', 'approle/backup.json']);

/**
 * Runs vault-init on empty secrets/vault/unseal and secrets/vault/approle directories, plus `files`
 * (relative to secrets/vault), with a docker that only logs its calls: `dockerCalls` is null when
 * it was never called.
 */
async function vaultInitWith(
  files: readonly string[],
): Promise<Readonly<{ status: number | null; stderr: string; dockerCalls: string | null }>> {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-init-files-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, `printf '%s\\n' "$*" >> '${log}'`);
    const host = join(directory, 'host');
    for (const name of ['unseal', 'approle']) await mkdir(join(host, 'secrets/vault', name), { recursive: true });
    for (const file of files) await writeFile(join(host, 'secrets/vault', file), 'x\n');
    const result = spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    const dockerCalls = await readFile(log, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    return { status: result.status, stderr: result.stderr, dockerCalls };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('vault-init has nothing to do once the key and the three AppRole files exist', async () => {
  assert.deepEqual(await vaultInitWith(['unseal/unseal-key', ...APPROLE_FILES]), {
    status: 78,
    stderr: 'vault-init: secrets/vault/unseal/unseal-key exists: Vault is already initialized: nothing to do (to start over, see the runbook)\n',
    dockerCalls: null,
  });
});

void test('vault-init tells an unfinished init from a Vault in service that lost an AppRole file', async () => {
  // vault-setup saves the key first: it failed before the first AppRole file, or between two. A
  // Vault in service that lost one AppRole file looks the same: the `next:` line tells them apart.
  for (const approle of [[], APPROLE_FILES.slice(0, 1), APPROLE_FILES.slice(0, 2)]) {
    assert.deepEqual(await vaultInitWith(['unseal/unseal-key', ...approle]), {
      status: 78,
      stderr: 'vault-init: secrets/vault/unseal/unseal-key exists but the AppRole files are missing: if vault-init never printed its next: line, start over as the runbook says; otherwise recreate the missing file as the runbook says\n',
      dockerCalls: null,
    }, approle.join(' '));
  }
});

void test('vault-init tells AppRole files without the key to put the key back, never to start over', async () => {
  // A lost key, or one moved away to seal a Vault in service: starting over would wipe that Vault.
  // Another file in unseal/ does not turn it into an earlier attempt.
  for (const files of [APPROLE_FILES, ['approle/backup.json', 'unseal/unseal-key.old']]) {
    assert.deepEqual(await vaultInitWith(files), {
      status: 78,
      stderr: 'vault-init: secrets/vault/approle holds AppRole files but secrets/vault/unseal/unseal-key is missing: Vault is already initialized: put the key back as the runbook says; do not start over\n',
      dockerCalls: null,
    }, files.join(' '));
  }
});

void test('vault-init calls another file without the key or any AppRole file an earlier attempt, to start over', async () => {
  for (const directory of ['unseal', 'approle']) {
    assert.deepEqual(await vaultInitWith([`${directory}/notes.txt`]), {
      status: 78,
      stderr: `vault-init: secrets/vault/${directory} holds files of an earlier attempt: start over as the runbook says\n`,
      dockerCalls: null,
    }, directory);
  }
});

void test('vault-init runs vault-setup once as the calling user when both directories are empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-init-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, [
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$*" in',
      `  *" vault-setup init") echo '{"service":"vault-setup","event":"vault.initialized"}'; echo 'Vault operator password, shown once (store it in your password manager): fake-operator-password' ;;`,
      'esac',
    ].join('\n'));
    const host = join(directory, 'host');
    await mkdir(join(host, 'secrets/vault/unseal'), { recursive: true });
    await mkdir(join(host, 'secrets/vault/approle'), { recursive: true });
    const result = spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(result.status, 0, result.stderr);
    const compose = `compose --env-file ${host}/compose.env -f ${repository}/deploy/compose.yaml`;
    const user = `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
      `${compose} up --detach vault`,
      `${compose} exec -T vault wget -q -O /dev/null http://127.0.0.1:8200/v1/sys/seal-status`,
      `${compose} run --rm --no-deps --user ${user} vault-setup init`,
    ]);
    assert.equal((result.stdout.match(/fake-operator-password/gu) ?? []).length, 1);
    assert.match(result.stdout, /^next: store secrets\/vault\/unseal\/unseal-key in your password manager, then run deploy\/host\/vault-import\.sh$/mu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('vault-init refuses before any docker call a relative SOL_HOST_DIR or a missing directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-init-pre-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, `printf '%s\\n' "$*" >> '${log}'`);
    const host = join(directory, 'host');
    // The checks below look at $SOL_HOST_DIR from here, while Compose resolves its bind sources elsewhere.
    const relative = spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: 'relative/host' },
    });
    assert.equal(relative.status, 78);
    assert.equal(relative.stderr, 'vault-init: SOL_HOST_DIR must be an absolute path\n');
    await mkdir(join(host, 'secrets/vault/unseal'), { recursive: true });
    const missing = spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(missing.status, 78);
    assert.equal(
      missing.stderr,
      'vault-init: secrets/vault/approle must be a directory you own and can write (deploy/host/init-secrets.sh creates it)\n',
    );
    await assert.rejects(stat(log), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('vault-init stops before any docker call when it cannot list a directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-init-ls-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, `printf '%s\\n' "$*" >> '${log}'`);
    // A listing that fails must not read as an empty directory.
    await writeFile(join(bin, 'ls'), '#!/bin/sh\necho "ls: cannot read the directory" >&2\nexit 2\n', { mode: 0o755 });
    const host = join(directory, 'host');
    await mkdir(join(host, 'secrets/vault/unseal'), { recursive: true });
    await mkdir(join(host, 'secrets/vault/approle'), { recursive: true });
    const result = spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'ls: cannot read the directory\n');
    await assert.rejects(stat(log), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('vault-init gives up after 60 tries when the Vault API never answers, without running vault-setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-init-wait-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, [
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$*" in',
      '  *" exec -T vault wget "*) exit 1 ;;',
      'esac',
    ].join('\n'));
    // No real second between the tries.
    await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const host = join(directory, 'host');
    await mkdir(join(host, 'secrets/vault/unseal'), { recursive: true });
    await mkdir(join(host, 'secrets/vault/approle'), { recursive: true });
    const result = spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(result.status, 69);
    assert.equal(result.stderr, 'vault-init: the Vault API did not answer within 60 tries: see docker compose logs vault\n');
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(calls.filter((call) => call.includes(' exec -T vault wget ')).length, 60);
    assert.equal(calls.some((call) => call.includes('vault-setup')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('vault-init refuses before any docker call a directory it cannot write', { skip: IS_ROOT }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-init-write-'));
  const host = join(directory, 'host');
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, `printf '%s\\n' "$*" >> '${log}'`);
    for (const name of ['unseal', 'approle']) {
      await mkdir(join(host, 'secrets/vault', name), { recursive: true });
    }
    for (const name of ['unseal', 'approle']) {
      await chmod(join(host, 'secrets/vault', name), 0o500);
      const result = spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
      });
      assert.equal(result.status, 78, name);
      assert.equal(
        result.stderr,
        `vault-init: secrets/vault/${name} must be a directory you own and can write (deploy/host/init-secrets.sh creates it)\n`,
        name,
      );
      await chmod(join(host, 'secrets/vault', name), 0o700);
    }
    await assert.rejects(stat(log), { code: 'ENOENT' });
  } finally {
    // A read-only directory could not be cleaned up.
    for (const name of ['unseal', 'approle']) await chmod(join(host, 'secrets/vault', name), 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

void test('vault-init refuses before any docker call a directory it does not own', { skip: IS_ROOT }, async (t) => {
  // A directory the caller can write but another user owns: /tmp is root-owned and world-writable.
  const foreign = '/tmp';
  if ((await stat(foreign)).uid === process.getuid?.()) {
    t.skip(`${foreign} belongs to the caller`);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-init-own-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, `printf '%s\\n' "$*" >> '${log}'`);
    const host = join(directory, 'host');
    for (const name of ['unseal', 'approle']) {
      await mkdir(join(host, 'secrets/vault/unseal'), { recursive: true });
      await mkdir(join(host, 'secrets/vault/approle'), { recursive: true });
      await rm(join(host, 'secrets/vault', name), { recursive: true });
      await symlink(foreign, join(host, 'secrets/vault', name));
      const result = spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
      });
      assert.equal(result.status, 78, name);
      assert.equal(
        result.stderr,
        `vault-init: secrets/vault/${name} must be a directory you own and can write (deploy/host/init-secrets.sh creates it)\n`,
        name,
      );
      // Only the link goes: never what it points to.
      await rm(join(host, 'secrets/vault', name), { force: true });
    }
    await assert.rejects(stat(log), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('vault-import mounts the role files, the key files they name and the templates, and sends the password on stdin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-import-'));
  try {
    const log = join(directory, 'docker-log');
    const stdin = join(directory, 'docker-stdin');
    const bin = await fakeDocker(directory, `printf '%s\\n' "$*" >> '${log}'; cat > '${stdin}'`);
    const host = join(directory, 'host');
    const lot5 = join(directory, 'lot5');
    const env = join(lot5, 'env');
    await mkdir(env, { recursive: true });
    await mkdir(host, { recursive: true });
    const adminKey = join(lot5, 'keys', 'helius-admin.key');
    const evidenceKey = join(lot5, 'keys', 'evidence.key');
    const keypair = join(directory, 'wallet.json');
    await mkdir(dirname(adminKey), { recursive: true });
    await writeFile(adminKey, 'admin-key-value\n');
    await writeFile(evidenceKey, 'evidence-key-value\n');
    await writeFile(keypair, '[1,2]\n');
    // The three quoting styles of the lot5 files: double quotes, single quotes, none.
    await writeFile(
      join(env, 'provider-evidence.env'),
      `HELIUS_API_KEY_PATH="${adminKey}"\nEXECUTOR_EVIDENCE_PRIVATE_KEY_PATH='${evidenceKey}'\n`,
    );
    await writeFile(join(env, 'live.env'), `EXECUTOR_KEYPAIR_PATH=${keypair}\nSOLANA_HTTP_RPC_URL=https://x.invalid/?api-key=secret-value\n`);
    const result = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh'), env], {
      encoding: 'utf8', input: 'operator-password-0123\n',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(result.status, 0, result.stderr);
    const compose = `compose --env-file ${host}/compose.env -f ${repository}/deploy/compose.yaml`;
    assert.equal((await readFile(log, 'utf8')).trim(), [
      `${compose} run --rm --no-deps -T`,
      `-v ${env}:/import/env:ro -v ${repository}/deploy/config:/import/templates:ro`,
      `-v ${adminKey}:/import/keys/helius-admin-api-key:ro -v ${evidenceKey}:/import/keys/evidence-private-key:ro`,
      `-v ${keypair}:/import/keys/wallet-keypair.json:ro`,
      `-e SOL_IMPORT_EVIDENCE_PREFIX=${lot5}/evidence vault-import`,
    ].join(' '));
    assert.equal(await readFile(stdin, 'utf8'), 'operator-password-0123\n');
    for (const value of ['secret-value', 'admin-key-value', 'evidence-key-value', 'operator-password-0123']) {
      assert.equal(`${result.stdout}${result.stderr}`.includes(value), false, value);
    }

    // A relative evidence directory becomes absolute from the current directory, which need not hold it.
    // Its dot segments stay as typed: the tool normalizes them.
    const relative = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh'), env, '../evidence'], {
      encoding: 'utf8', input: 'operator-password-0123\n', cwd: env,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(relative.status, 0, relative.stderr);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(
      lines[lines.length - 1]?.split(' -e ').pop(),
      `SOL_IMPORT_EVIDENCE_PREFIX=${await realpath(env)}/../evidence vault-import`,
    );

    // A password piped without a trailing newline is still read, and sent with the newline printf adds.
    const unterminated = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh'), env], {
      encoding: 'utf8', input: 'unterminated-password-4567',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(unterminated.status, 0, unterminated.stderr);
    assert.equal(await readFile(stdin, 'utf8'), 'unterminated-password-4567\n');
    assert.equal(`${unterminated.stdout}${unterminated.stderr}`.includes('unterminated-password-4567'), false);

    // Under `bash -x` the password must not show in the trace (printf would expand it).
    const traced = spawnSync('bash', ['-x', join(repository, 'deploy/host/vault-import.sh'), env], {
      encoding: 'utf8', input: 'traced-password-8910\n',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(traced.status, 0, traced.stderr);
    assert.equal(await readFile(stdin, 'utf8'), 'traced-password-8910\n');
    assert.match(traced.stderr, /set \+x/u, 'the trace is on until the password is read');
    assert.equal(`${traced.stdout}${traced.stderr}`.includes('traced-password-8910'), false);

    await writeFile(join(env, 'live.env'), 'EXECUTOR_KEYPAIR_PATH=/nonexistent/wallet.json\n');
    const missing = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh'), env], {
      encoding: 'utf8', input: 'x\n', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(missing.status, 78);
    assert.equal(missing.stderr, 'vault-import: /nonexistent/wallet.json (named by EXECUTOR_KEYPAIR_PATH) does not exist\n');
    // A bare call is a usage error before it is a missing SOL_HOST_DIR.
    const usage = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh')], {
      encoding: 'utf8', env: { ...process.env, SOL_HOST_DIR: '' },
    });
    assert.equal(usage.status, 64);
    assert.equal(usage.stderr, 'usage: deploy/host/vault-import.sh <env directory> [evidence directory]\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('vault-import refuses an empty password before any docker call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-import-empty-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, `printf '%s\\n' "$*" >> '${log}'; cat > /dev/null`);
    const env = join(directory, 'lot5', 'env');
    await mkdir(env, { recursive: true });
    // A bare Enter at the prompt, and an input that ends at once.
    for (const input of ['\n', '']) {
      const result = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh'), env], {
        encoding: 'utf8', input,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: join(directory, 'host') },
      });
      assert.equal(result.status, 64, JSON.stringify(input));
      assert.equal(result.stderr.trim(), 'vault-import: no password given', JSON.stringify(input));
    }
    await assert.rejects(stat(log), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('vault-import stops when it cannot read a role file for a key path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-import-sed-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, `printf '%s\\n' "$*" >> '${log}'; cat > /dev/null`);
    // A read that fails must not pass for "no key path": the wallet key would go missing from the import.
    await writeFile(join(bin, 'sed'), '#!/bin/sh\necho "sed: cannot read the file" >&2\nexit 2\n', { mode: 0o755 });
    const env = join(directory, 'lot5', 'env');
    await mkdir(env, { recursive: true });
    await writeFile(join(env, 'live.env'), 'EXECUTOR_KEYPAIR_PATH=/some/wallet.json\n');
    const result = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh'), env], {
      encoding: 'utf8', input: 'operator-password-0123\n',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: join(directory, 'host') },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /sed: cannot read the file/u);
    await assert.rejects(stat(log), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
