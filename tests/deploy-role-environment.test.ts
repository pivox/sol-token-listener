import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  RoleEnvironmentError,
  buildRoleEnvironment,
  loginDatabaseUrl,
  parseRoleConfig,
  renderShellExports,
  secretText,
} from '../src/deploy/role-environment.js';
import type { RoleName, StackMode } from '../src/deploy/stack.js';

const LEAK = 'value-that-must-not-leak';
const SECRETS: Readonly<Record<string, string>> = Object.freeze({
  '/run/sol/listener/pg-sol_listener-password': 'p@ss/word:with?reserved#chars\n',
  '/run/sol/listener/helius-listener-http-url': 'https://listener.invalid/?api-key=listener-key\n',
  '/run/sol/listener/helius-listener-ws-url': 'wss://listener.invalid/?api-key=listener-key\n',
  '/run/sol/opapi/pg-sol_reader-password': 'reader-password-0123456789\n',
  '/run/sol/opapi/operator-api-token': 'operator-token-0123456789abcdef0123456789abcdef\n',
  '/run/sol/opapi/helius-listener-http-url': 'https://listener.invalid/?api-key=listener-key\n',
  '/run/sol/opapi/helius-executor-http-url': 'https://executor.invalid/?api-key=executor-key\n',
  '/run/sol/h2b/pg-sol_live-password': 'live-password-0123456789\n',
  '/run/sol/h2b/helius-executor-http-url': 'https://executor.invalid/?api-key=executor-key\n',
  '/run/sol/h2b/wallet-keypair.json': '[1,2,3]\n',
  '/run/sol/worker/pg-sol_worker-password': 'worker-password-0123456789\n',
  '/run/sol/worker/helius-executor-http-url': 'https://executor.invalid/\n',
  '/run/sol/ops/helius-admin-api-key': 'admin-key\n',
  '/run/sol/ops/evidence-private-key': 'private-key-material\n',
});

function build(
  role: RoleName,
  configText: string,
  options: Readonly<{ mode?: StackMode; overrideText?: string }> = {},
): Readonly<Record<string, string>> {
  return buildRoleEnvironment({
    role,
    mode: options.mode ?? 'live',
    databaseName: 'sol_token_listener',
    configText,
    overrideText: options.overrideText ?? null,
    runDirectory: '/run/sol',
    readSecret: (path) => {
      const value = SECRETS[path];
      if (value === undefined) throw new RoleEnvironmentError(`missing file ${path}`);
      return value;
    },
    secretExists: (path) => SECRETS[path] !== undefined,
  });
}

void test('the listener gets its configuration, an encoded login URL and both listener RPC URLs', () => {
  const environment = build('listener', 'LISTENER_ENABLED=true\nAPI_HOST=0.0.0.0\n');
  assert.equal(environment.LISTENER_ENABLED, 'true');
  assert.equal(
    environment.DATABASE_URL,
    'postgresql://sol_listener:p%40ss%2Fword%3Awith%3Freserved%23chars@postgres:5432/sol_token_listener'
      + '?options=-c%20role%3Dsol_token_listener_writer',
  );
  assert.equal(environment.SOLANA_HTTP_RPC_URL, 'https://listener.invalid/?api-key=listener-key');
  assert.equal(environment.SOLANA_WS_RPC_URL, 'wss://listener.invalid/?api-key=listener-key');
  assert.equal(environment.SOL_RUN_USER, 'listener');
  assert.equal(environment.SOL_RUN_UID, '10001');
  assert.equal(environment.EXECUTOR_KEYPAIR_PATH, undefined);
});

void test('only H2b gets the keypair path, and the worker pins its search_path', () => {
  const h2b = build('h2b', 'EXECUTOR_MODE=live\n');
  assert.equal(h2b.EXECUTOR_KEYPAIR_PATH, '/run/sol/h2b/wallet-keypair.json');
  assert.equal(h2b.SOLANA_HTTP_RPC_URL, 'https://executor.invalid/?api-key=executor-key');
  const worker = build('worker', 'EXECUTOR_MODE=simulation-only\n');
  assert.match(
    worker.DATABASE_URL ?? '',
    /\?options=-c%20role%3Dsol_token_executor_worker%20-c%20search_path%3Dpg_catalog%2Cpublic$/u,
  );
  assert.equal(worker.EXECUTOR_KEYPAIR_PATH, undefined);
});

void test('the operator API reads its token and follows the mode for its RPC project', () => {
  const observe = build('opapi', 'OPERATOR_API_HOST=0.0.0.0\n', { mode: 'observe' });
  assert.equal(observe.OPERATOR_API_TOKEN, 'operator-token-0123456789abcdef0123456789abcdef');
  assert.equal(observe.SOLANA_HTTP_RPC_URL, 'https://listener.invalid/?api-key=listener-key');
  assert.match(observe.OPERATOR_API_DATABASE_URL ?? '', /^postgresql:\/\/sol_reader:/u);
  assert.equal(observe.DATABASE_URL, undefined);
  const live = build('opapi', 'OPERATOR_API_HOST=0.0.0.0\n', { mode: 'live' });
  assert.equal(live.SOLANA_HTTP_RPC_URL, 'https://executor.invalid/?api-key=executor-key');
});

void test('evidence roles get secret file paths and nothing else', () => {
  const provider = build('evidence-provider', 'HELIUS_PROJECT_ID=project\n');
  assert.equal(provider.HELIUS_API_KEY_PATH, '/run/sol/ops/helius-admin-api-key');
  assert.equal(provider.EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH, '/run/sol/ops/evidence-private-key');
  const bundle = build(
    'evidence-bundle', 'EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY=/var/lib/sol/evidence\n',
  );
  assert.deepEqual(Object.keys(bundle).sort(), [
    'EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH',
    'EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY',
    'SOL_RUN_UID',
    'SOL_RUN_USER',
  ]);
});

void test('configuration files cannot carry secrets, injected variables or credentials', () => {
  for (const key of [
    'DATABASE_URL', 'SOLANA_HTTP_RPC_URL', 'EXECUTOR_KEYPAIR_PATH', 'OPERATOR_API_TOKEN',
    'POSTGRES_PASSWORD', 'EXECUTOR_PRIVATE_KEY', 'SOL_RUN_UID',
  ]) {
    assert.throws(
      () => parseRoleConfig(`${key}=${LEAK}\n`, 'live.env'),
      (error: unknown) => error instanceof RoleEnvironmentError
        && error.message === `live.env: ${key} comes from a secret file, not from the configuration`,
    );
  }
  for (const value of [`https://x.invalid/?api-key=${LEAK}`, `postgresql://user:${LEAK}@host/db`]) {
    assert.throws(
      () => parseRoleConfig(`LISTENER_NOTE=${value}\n`, 'listener.env'),
      (error: unknown) => error instanceof RoleEnvironmentError
        && error.message === 'listener.env: LISTENER_NOTE looks like a credential',
    );
  }
  assert.throws(() => parseRoleConfig('MULTI="a\nb"\n', 'listener.env'), RoleEnvironmentError);
  assert.deepEqual(
    parseRoleConfig('# comment\nEXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64=AAAA\n', 'operations.env'),
    { EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: 'AAAA' },
  );
});

void test('an override wins over the configuration and obeys the same rules', () => {
  const environment = build('listener', 'FAST_ENTRY_PROBE_ENABLED=false\n', {
    overrideText: 'FAST_ENTRY_PROBE_ENABLED=true\n',
  });
  assert.equal(environment.FAST_ENTRY_PROBE_ENABLED, 'true');
  assert.throws(
    () => build('listener', '', { overrideText: `DATABASE_URL=${LEAK}\n` }),
    (error: unknown) => error instanceof RoleEnvironmentError
      && error.message.startsWith('override listener.env: ')
      && !error.message.includes(LEAK),
  );
});

void test('a missing or malformed secret fails with its file name only', () => {
  assert.throws(
    () => build('autoarm', 'EXECUTOR_POLL_MS=500\n'),
    (error: unknown) => error instanceof RoleEnvironmentError
      && error.message === 'missing file /run/sol/autoarm/pg-sol_autoarm-password',
  );
  assert.throws(
    () => secretText(`two ${LEAK}\n`, 'pg-sol_ops-password'),
    (error: unknown) => error instanceof RoleEnvironmentError
      && error.message === 'pg-sol_ops-password: expected one printable line without spaces',
  );
  assert.equal(secretText('value\r\n', 'file'), 'value');
  assert.throws(
    () => loginDatabaseUrl({
      login: 'sol_ops', password: 'x'.repeat(24), databaseName: 'Bad-Name', searchPath: false,
    }),
    RoleEnvironmentError,
  );
});

void test('shell exports keep hostile values literal', () => {
  const hostile = "it's $(touch /nonexistent/never) `x` \\ \"q\"";
  const rendered = renderShellExports({ SOL_RUN_USER: 'listener', LISTENER_NOTE: hostile });
  assert.equal(
    rendered,
    "export LISTENER_NOTE='it'\\''s $(touch /nonexistent/never) `x` \\ \"q\"'\n"
      + "export SOL_RUN_USER='listener'\n",
  );
  const shell = spawnSync('sh', ['-c', `${rendered}printf '%s' "$LISTENER_NOTE"`], { encoding: 'utf8' });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, hostile);
});
