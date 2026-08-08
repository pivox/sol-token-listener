import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  OFFICIAL_PUMP_IDL_REVISION,
  OFFICIAL_PUMP_IDL_SHA256,
} from '../scripts/generate-pumpfun-idl.js';
import {
  OFFICIAL_PUMP_AMM_IDL_REVISION,
  OFFICIAL_PUMP_AMM_IDL_SHA256,
} from '../scripts/generate-pumpswap-idl.js';
import {
  PUMP_IDL_REVISION,
  PUMP_IDL_SHA256,
  PUMP_EVENTS,
  PUMP_INSTRUCTIONS,
} from '../src/launchpads/pumpfun/generated/pump-idl.js';
import {
  PUMPSWAP_IDL_REVISION,
  PUMPSWAP_IDL_SHA256,
  PUMPSWAP_EVENTS,
  PUMPSWAP_INSTRUCTIONS,
} from '../src/markets/pumpswap/generated/pumpswap-idl.js';

void test('attests exact official Pump IDL bytes and generated coverage offline', async () => {
  const path = new URL('../vendor/pumpfun/idl/manifest.json', import.meta.url);
  const manifest = JSON.parse(await readFile(path, 'utf8')) as OfficialManifest;

  assert.deepEqual(Object.keys(manifest).sort(), [
    'artifacts', 'repository', 'revision', 'revisionUrl', 'schemaVersion', 'verifiedHeadOn',
  ]);
  assert.equal(manifest.schemaVersion, 'official-pump-idl-manifest.v1');
  assert.equal(manifest.repository, 'https://github.com/pump-fun/pump-public-docs');
  assert.equal(manifest.revision, '9c82f61cb711b044a17f770ab8ce9f9bdf78f333');
  assert.equal(
    manifest.revisionUrl,
    `https://github.com/pump-fun/pump-public-docs/tree/${manifest.revision}`,
  );
  assert.equal(manifest.verifiedHeadOn, '2026-08-08');
  assert.equal(manifest.artifacts.length, 2);

  for (const artifact of manifest.artifacts) {
    assert.deepEqual(Object.keys(artifact).sort(), [
      'family', 'localPath', 'requiredEvents', 'requiredInstructions', 'sha256', 'upstreamPath',
    ]);
    const bytes = await readFile(new URL(`../${artifact.localPath}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    assert.match(
      artifact.upstreamPath,
      /^idl\/(?:pump|pump_amm)\.json$/u,
    );
  }

  const pump = manifest.artifacts.find((value) => value.family === 'pumpfun');
  const swap = manifest.artifacts.find((value) => value.family === 'pumpswap');
  assert.ok(pump);
  assert.ok(swap);
  assert.equal(pump.sha256, OFFICIAL_PUMP_IDL_SHA256);
  assert.equal(pump.sha256, PUMP_IDL_SHA256);
  assert.equal(swap.sha256, OFFICIAL_PUMP_AMM_IDL_SHA256);
  assert.equal(swap.sha256, PUMPSWAP_IDL_SHA256);
  assert.equal(manifest.revision, OFFICIAL_PUMP_IDL_REVISION);
  assert.equal(manifest.revision, OFFICIAL_PUMP_AMM_IDL_REVISION);
  assert.equal(manifest.revision, PUMP_IDL_REVISION);
  assert.equal(manifest.revision, PUMPSWAP_IDL_REVISION);
  assert.deepEqual(Object.keys(PUMP_INSTRUCTIONS).sort(), [...pump.requiredInstructions].sort());
  assert.deepEqual(Object.keys(PUMPSWAP_INSTRUCTIONS).sort(), [...swap.requiredInstructions].sort());
  assert.deepEqual(Object.keys(PUMP_EVENTS).sort(), [...pump.requiredEvents].sort());
  assert.deepEqual(Object.keys(PUMPSWAP_EVENTS).sort(), [...swap.requiredEvents].sort());
});

interface OfficialManifest {
  readonly schemaVersion: string;
  readonly repository: string;
  readonly revision: string;
  readonly revisionUrl: string;
  readonly verifiedHeadOn: string;
  readonly artifacts: readonly {
    readonly family: string;
    readonly upstreamPath: string;
    readonly localPath: string;
    readonly sha256: string;
    readonly requiredInstructions: readonly string[];
    readonly requiredEvents: readonly string[];
  }[];
}
