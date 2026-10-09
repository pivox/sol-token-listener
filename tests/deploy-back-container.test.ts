import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ROLES, type RoleName } from '../src/deploy/stack.js';

const root = new URL('../', import.meta.url);
const SCRIPTS = Object.freeze([
  'sol', 'sol-admin', 'sol-boot-entry-stop', 'sol-entrypoint', 'sol-h2b', 'sol-health', 'sol-run',
]);
const SUPERVISOR_FILES = Object.freeze([
  'deploy/back/supervisor/supervisord.conf',
  'deploy/back/supervisor/programs/common.conf',
  'deploy/back/supervisor/programs/live.conf',
]);

async function artifact(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

interface Program {
  readonly name: string;
  readonly settings: ReadonlyMap<string, string>;
}

function programs(ini: string): readonly Program[] {
  const result: { name: string; settings: Map<string, string> }[] = [];
  for (const raw of ini.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';')) continue;
    const section = /^\[program:([a-z0-9]+)\]$/u.exec(line);
    if (section !== null) {
      result.push({ name: section[1] ?? '', settings: new Map() });
      continue;
    }
    const setting = /^([a-z_]+)=(.*)$/u.exec(line);
    const current = result.at(-1);
    if (setting !== null && current !== undefined) current.settings.set(setting[1] ?? '', setting[2] ?? '');
  }
  return result;
}

function assertOrder(source: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    assert.ok(index > previous, `${marker} is missing or out of order`);
    previous = index;
  }
}

void test('every back script is POSIX sh and parses', async () => {
  assert.deepEqual((await readdir(new URL('deploy/back/bin/', root))).sort(), [...SCRIPTS]);
  for (const name of SCRIPTS) {
    const source = await artifact(`deploy/back/bin/${name}`);
    assert.match(source, /^#!\/bin\/sh\n/u, name);
    const syntax = spawnSync('sh', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${name}: ${syntax.stderr}`);
  }
});

void test('supervisor runs each program as its own user, retries forever and bounds its stop', async () => {
  const common = programs(await artifact('deploy/back/supervisor/programs/common.conf'));
  const live = programs(await artifact('deploy/back/supervisor/programs/live.conf'));
  assert.deepEqual(common.map((program) => program.name), ['listener', 'opapi', 'retention']);
  assert.deepEqual(live.map((program) => program.name), ['h2a', 'h2b', 'autoarm', 'worker']);
  const commands: Readonly<Record<string, string>> = {
    listener: '/usr/local/bin/sol-run listener node /app/dist/src/app.js',
    opapi: '/usr/local/bin/sol-run opapi node /app/dist/src/operator-api/main.js',
    retention: '/usr/local/bin/sol-run retention node /app/dist/scripts/purge-retained-data.js',
    h2a: '/usr/local/bin/sol-run h2a node /app/dist/src/executor-live-recovery/main.js',
    h2b: '/usr/local/bin/sol-h2b',
    autoarm: '/usr/local/bin/sol-run autoarm node /app/dist/src/executor-operations/auto-arm-main.js',
    worker: '/usr/local/bin/sol-run worker node /app/dist/src/executor/main.js',
  };
  for (const program of [...common, ...live]) {
    const settings = program.settings;
    assert.equal(settings.get('command'), commands[program.name], program.name);
    assert.equal(settings.get('user'), ROLES[program.name as RoleName].user, program.name);
    assert.equal(settings.get('directory'), '/app', program.name);
    assert.equal(settings.get('autostart'), program.name === 'worker' ? 'false' : 'true', program.name);
    assert.equal(settings.get('autorestart'), 'true', program.name);
    // supervisord waits one more second before each new attempt and never gives up (FATAL).
    assert.equal(settings.get('startretries'), '1000000', program.name);
    assert.equal(settings.get('stopsignal'), 'TERM', program.name);
    // 40 s where the process has its own 30 s shutdown grace; the API and the purge stop at once.
    assert.equal(settings.get('stopwaitsecs'),
      program.name === 'opapi' || program.name === 'retention' ? '10' : '40', program.name);
    assert.equal(settings.get('killasgroup'), 'true', program.name);
    assert.equal(settings.get('stdout_logfile'), '/dev/stdout', program.name);
    assert.equal(settings.get('stdout_logfile_maxbytes'), '0', program.name);
    assert.equal(settings.get('redirect_stderr'), 'true', program.name);
  }
  // sol-h2b forwards TERM to H2b itself: supervisord must not signal the child directly.
  assert.equal(live.find((program) => program.name === 'h2b')?.settings.get('stopasgroup'), 'false');
});

void test('the back stop grace covers every program stopped one after the other', async () => {
  const all = [
    ...programs(await artifact('deploy/back/supervisor/programs/common.conf')),
    ...programs(await artifact('deploy/back/supervisor/programs/live.conf')),
  ];
  // supervisord stops one program at a time, each within stopwaitsecs plus about one second.
  const budget = all.reduce((total, program) => total + Number(program.settings.get('stopwaitsecs')) + 1, 0);
  const grace = /^ {4}stop_grace_period: (\d+)s$/mu.exec(await artifact('deploy/compose.yaml'));
  assert.ok(grace !== null, 'the back has no stop_grace_period in seconds');
  assert.ok(budget + 10 <= Number(grace[1]), `stop budget ${String(budget)} s + 10 s margin exceeds ${grace[1] ?? ''} s`);
});

void test('supervisord keeps its socket root-only and loads the programs the entrypoint selects', async () => {
  const lines = (await artifact('deploy/back/supervisor/supervisord.conf')).split('\n');
  for (const line of [
    'nodaemon=true', 'user=root', 'logfile=/dev/null', 'file=/run/sol/supervisor.sock', 'chmod=0700',
    'serverurl=unix:///run/sol/supervisor.sock', 'files = /run/sol/programs/*.conf',
  ]) {
    assert.ok(lines.includes(line), line);
  }
});

void test('the entrypoint distributes secrets and applies the boot entry-stop before supervisord', async () => {
  const entrypoint = await artifact('deploy/back/bin/sol-entrypoint');
  // Under `set -e`, a failing plain command line ends the entrypoint before supervisord.
  assert.match(entrypoint, /^set -eu$/mu);
  assertOrder(entrypoint, [
    // Alone on its line: a commented-out or `|| true` variant would let the container boot without Vault.
    '\nnode /app/dist/scripts/deploy/vault-pull.js back "$mode"\n',
    'node /app/dist/scripts/deploy/distribute-secrets.js "$mode"',
    'install -m 0644 /etc/sol/programs/common.conf /run/sol/programs/common.conf',
    'if [ "$mode" = live ]; then',
    'install -m 0644 /etc/sol/programs/live.conf /run/sol/programs/live.conf',
    '\n  sol-boot-entry-stop\nfi\n',
    'exec supervisord -n -c /etc/sol/supervisord.conf',
  ]);
});

void test('the boot entry-stop turns only RUNNING into ENTRY_STOP and fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-boot-entry-stop-'));
  try {
    const bin = join(directory, 'bin');
    const calls = join(directory, 'calls');
    await mkdir(bin);
    // sol-run logs its arguments; `status` prints STUB_STATUS and exits STUB_STATUS_EXIT, the
    // kill-switch exits STUB_KILL_EXIT.
    await writeFile(join(bin, 'sol-run'), [
      '#!/bin/sh',
      `echo "$*" >> '${calls}'`,
      'case "$*" in',
      '  *"/main.js status") printf \'%s\' "$STUB_STATUS"; exit "$STUB_STATUS_EXIT" ;;',
      '  *"/main.js kill-switch --mode=entry-stop --reason=OPERATOR_ENTRY_STOP") echo \'{}\'; exit "$STUB_KILL_EXIT" ;;',
      'esac',
      'exit 99',
      '',
    ].join('\n'), { mode: 0o755 });
    // node: the image path of operations-state runs the repository source of that command.
    await writeFile(join(bin, 'node'), [
      '#!/bin/sh',
      'if [ "$1" != /app/dist/scripts/deploy/operations-state.js ]; then exit 99; fi',
      'shift',
      `exec '${process.execPath}' --import tsx '${fileURLToPath(new URL('scripts/deploy/operations-state.ts', root))}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    const status = (state: string): string => JSON.stringify({ payloadVersion: 1, command: 'status', controlState: state });
    const run = async (stub: Readonly<{ status: string; statusExit?: number; killExit?: number }>) => {
      await rm(calls, { force: true });
      const result = spawnSync('sh', [fileURLToPath(new URL('deploy/back/bin/sol-boot-entry-stop', root))], {
        cwd: fileURLToPath(root),
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          STUB_STATUS: stub.status,
          STUB_STATUS_EXIT: String(stub.statusExit ?? 0),
          STUB_KILL_EXIT: String(stub.killExit ?? 0),
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
      const invoked = (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      return { code: result.status, stdout: result.stdout, invoked };
    };
    const statusCall = 'operations node /app/dist/src/executor-operations/main.js status';
    const killCall = 'operations node /app/dist/src/executor-operations/main.js kill-switch --mode=entry-stop --reason=OPERATOR_ENTRY_STOP';

    assert.deepEqual(await run({ status: status('RUNNING') }), {
      code: 0,
      stdout: '{"service":"sol-entrypoint","event":"boot.entry_stop","previousControlState":"RUNNING"}\n',
      invoked: [statusCall, killCall],
    });
    for (const state of ['ENTRY_STOP', 'HARD_STOP']) {
      assert.deepEqual(await run({ status: status(state) }), { code: 0, stdout: '', invoked: [statusCall] }, state);
    }
    for (const failure of [
      { status: '', statusExit: 1 },
      { status: 'not json' },
      { status: status('PAUSED') },
    ]) {
      const result = await run(failure);
      assert.notEqual(result.code, 0, JSON.stringify(failure));
      assert.deepEqual(result.invoked, [statusCall], JSON.stringify(failure));
    }
    const refused = await run({ status: status('RUNNING'), killExit: 1 });
    assert.notEqual(refused.code, 0);
    assert.equal(refused.stdout, '');
    assert.deepEqual(refused.invoked, [statusCall, killCall]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('sol-run drops root to the role user and refuses a foreign role', async () => {
  const solRun = await artifact('deploy/back/bin/sol-run');
  assertOrder(solRun, [
    'exports="$(node /app/dist/scripts/deploy/role-env.js "$role")"',
    'eval "$exports"',
    'exec setpriv --reuid="$SOL_RUN_UID" --regid="$SOL_RUN_UID" --clear-groups -- "$@"',
    'if [ "$current" != "$SOL_RUN_UID" ]; then',
    'exec "$@"',
  ]);
});

void test('only the H2b role points at the keypair; no script or supervisor file names it', async () => {
  const keypairRoles = Object.entries(ROLES)
    .filter(([, role]) => Object.values(role.secretPaths ?? {}).includes('wallet-keypair.json'))
    .map(([name]) => name);
  assert.deepEqual(keypairRoles, ['h2b']);
  for (const path of [...SCRIPTS.map((name) => `deploy/back/bin/${name}`), ...SUPERVISOR_FILES]) {
    assert.doesNotMatch(await artifact(path), /keypair/iu, path);
  }
});

void test('sol trading start needs an ACTIVE envelope and a running H2b, then resumes at the TTY', async () => {
  const sol = await artifact('deploy/back/bin/sol');
  assertOrder(sol, [
    'trading() {', 'envelope show', 'active-envelope', 'until h2b_ready; do',
    'executor-operations/main.js resume', 'kill-switch --mode=entry-stop --reason=OPERATOR_ENTRY_STOP',
    'qualify() {', ': > /run/sol/qualify', 'ctl stop retention',
    "printf 'FAST_ENTRY_PROBE_ENABLED=true\\n' > /run/sol/overrides/listener.env",
    'ctl restart listener', 'ctl start worker',
    'ctl stop worker', 'rm -f /run/sol/overrides/listener.env', 'ctl start retention',
  ]);
});

void test('sol-h2b relaunches after exit 75, backs off after a failure and stops cleanly on TERM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-h2b-'));
  try {
    const bin = join(directory, 'bin');
    const log = join(directory, 'launches');
    const state = join(directory, 'state');
    await mkdir(bin);
    await writeFile(join(bin, 'sol-run'), [
      '#!/bin/sh',
      `log='${log}'`,
      'count=$(( $(cat "$log" 2> /dev/null | wc -l) + 1 ))',
      'echo "$*" >> "$log"',
      'if [ "$count" -eq 1 ]; then exit 75; fi',
      'if [ "$count" -eq 2 ]; then exit 1; fi',
      'trap \'echo terminated >> "$log"; exit 0\' TERM',
      'while :; do sleep 1; done',
      '',
    ].join('\n'), { mode: 0o755 });
    const child = spawn('sh', [fileURLToPath(new URL('deploy/back/bin/sol-h2b', root))], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SOL_H2B_STATE_FILE: state,
        SOL_H2B_IDLE_SECONDS: '1',
        SOL_H2B_BACKOFF_SECONDS: '1',
        SOL_H2B_BACKOFF_MAX_SECONDS: '2',
      },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => { resolve(code); });
    });
    const seen = new Set<string>();
    const deadline = Date.now() + 20_000;
    for (;;) {
      const current = await readFile(state, 'utf8').catch(() => '');
      seen.add(current.split(' ')[0] ?? '');
      const launches = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      if (launches.length >= 3 && current.startsWith('running ')) break;
      assert.ok(Date.now() < deadline, 'sol-h2b did not relaunch H2b three times');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(seen.has('idle'), 'exit 75 must leave the idle state');
    assert.ok(seen.has('failing'), 'exit 1 must leave the failing state');
    assert.deepEqual(
      (await readFile(log, 'utf8')).trim().split('\n'),
      Array.from({ length: 3 }, () => 'h2b node /app/dist/src/executor-live/main.js'),
    );
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.match(await readFile(log, 'utf8'), /terminated\n$/u);
    assert.match(await readFile(state, 'utf8'), /^stopped \d+\n$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('sol-admin migrate reads the login passwords from Vault before migrating', async () => {
  const solAdmin = await artifact('deploy/back/bin/sol-admin');
  assertOrder(solAdmin, [
    '  migrate)\n',
    '    node /app/dist/scripts/deploy/vault-pull.js migrate\n',
    '    exec node /app/dist/scripts/deploy/admin-database.js migrate ;;\n',
    '  group-roles)\n',
    '    exec node /app/dist/scripts/deploy/admin-database.js group-roles ;;\n',
    '  report)\n',
  ]);
});
