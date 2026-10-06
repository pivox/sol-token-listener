import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

void test('configuration imports do not load a dotenv file and explicit values override parent state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-config-isolation-'));
  const fakeEnvFile = join(root, 'sentinel.env');
  try {
    await writeFile(fakeEnvFile, [
      'LIVE_SECRET_SENTINEL=FAKE_DOTENV_SENTINEL_47f9',
      'SOLANA_HTTP_RPC_URL=https://dotenv.invalid',
      'SOLANA_WS_RPC_URL=wss://dotenv.invalid',
    ].join('\n'));
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      "import { loadConfig } from './src/config/env.ts'; const config=loadConfig({SOLANA_HTTP_RPC_URL:'https://injected.invalid',SOLANA_WS_RPC_URL:'wss://injected.invalid'}); console.log(JSON.stringify({url:config.httpRpcUrl,sentinel:process.env.LIVE_SECRET_SENTINEL??null}));",
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DOTENV_CONFIG_PATH: fakeEnvFile },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), { url: 'https://injected.invalid/', sentinel: null });
    assert.doesNotMatch(child.stdout + child.stderr, /FAKE_DOTENV_SENTINEL_47f9/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
