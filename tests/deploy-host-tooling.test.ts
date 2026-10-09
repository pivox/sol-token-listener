import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    const host = join(directory, 'host');
    // What a compose run before init-secrets leaves: Docker created the missing file as a directory.
    await mkdir(join(host, 'secrets/db/postgres-admin-password'), { recursive: true });
    const result = spawnSync('bash', [join(repository, 'deploy/host/init-secrets.sh'), host], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    assert.equal(result.status, 78);
    assert.equal(
      result.stderr,
      `init-secrets: ${host}/secrets/db/postgres-admin-password is a directory: remove it, then run again\n`,
    );
    await assert.rejects(stat(join(host, 'secrets/front/front-basic-auth-hash')), { code: 'ENOENT' });
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

void test('vault-init runs vault-setup once as the calling user and refuses a second time', async () => {
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
    const run = (): ReturnType<typeof spawnSync> => spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    const first = run();
    assert.equal(first.status, 0, String(first.stderr));
    const compose = `compose --env-file ${host}/compose.env -f ${repository}/deploy/compose.yaml`;
    const user = `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
      `${compose} up --detach vault`,
      `${compose} exec -T vault wget -q -O /dev/null http://127.0.0.1:8200/v1/sys/seal-status`,
      `${compose} run --rm --no-deps --user ${user} vault-setup init`,
      `${compose} exec -T vault vault status`,
    ]);
    assert.equal((String(first.stdout).match(/fake-operator-password/gu) ?? []).length, 1);
    assert.match(String(first.stdout), /^next: store secrets\/vault\/unseal\/unseal-key in your password manager, then run deploy\/host\/vault-import\.sh$/mu);

    await writeFile(join(host, 'secrets/vault/unseal/unseal-key'), 'key\n');
    await rm(log);
    const second = run();
    assert.equal(second.status, 78);
    assert.match(String(second.stderr), /already initialized/u);
    await assert.rejects(stat(log), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('vault-init refuses before any docker call when its directories are missing or not empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-vault-init-pre-'));
  try {
    const log = join(directory, 'docker-log');
    const bin = await fakeDocker(directory, `printf '%s\\n' "$*" >> '${log}'`);
    const host = join(directory, 'host');
    const run = (): ReturnType<typeof spawnSync> => spawnSync('bash', [join(repository, 'deploy/host/vault-init.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    await mkdir(join(host, 'secrets/vault/unseal'), { recursive: true });
    const missing = run();
    assert.equal(missing.status, 78);
    assert.equal(
      missing.stderr,
      'vault-init: secrets/vault/approle must be a directory you own and can write (deploy/host/init-secrets.sh creates it)\n',
    );
    await mkdir(join(host, 'secrets/vault/approle'), { recursive: true });
    await writeFile(join(host, 'secrets/vault/approle/back.json'), '{}\n');
    const leftover = run();
    assert.equal(leftover.status, 78);
    assert.equal(
      leftover.stderr,
      'vault-init: secrets/vault/approle holds files of an earlier attempt: start over as the runbook says\n',
    );
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
    const keypair = join(directory, 'wallet.json');
    await mkdir(dirname(adminKey), { recursive: true });
    await writeFile(adminKey, 'admin-key-value\n');
    await writeFile(keypair, '[1,2]\n');
    await writeFile(join(env, 'provider-evidence.env'), `HELIUS_API_KEY_PATH="${adminKey}"\n`);
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
      `-v ${adminKey}:/import/keys/helius-admin-api-key:ro -v ${keypair}:/import/keys/wallet-keypair.json:ro`,
      `-e SOL_IMPORT_EVIDENCE_PREFIX=${lot5}/evidence vault-import`,
    ].join(' '));
    assert.equal(await readFile(stdin, 'utf8'), 'operator-password-0123\n');
    for (const value of ['secret-value', 'admin-key-value', 'operator-password-0123']) {
      assert.equal(`${result.stdout}${result.stderr}`.includes(value), false, value);
    }

    await writeFile(join(env, 'live.env'), 'EXECUTOR_KEYPAIR_PATH=/nonexistent/wallet.json\n');
    const missing = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh'), env], {
      encoding: 'utf8', input: 'x\n', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_HOST_DIR: host },
    });
    assert.equal(missing.status, 78);
    assert.equal(missing.stderr, 'vault-import: /nonexistent/wallet.json (named by EXECUTOR_KEYPAIR_PATH) does not exist\n');
    const usage = spawnSync('bash', [join(repository, 'deploy/host/vault-import.sh')], {
      encoding: 'utf8', env: { ...process.env, SOL_HOST_DIR: host },
    });
    assert.equal(usage.status, 64);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
