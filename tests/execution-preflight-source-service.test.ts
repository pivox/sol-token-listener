import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJson } from '../src/utils/json.js';
import { createExecutionPreflightSourceExport } from '../src/preflight-source/service.js';
import { preflightDraftInputs } from './helpers/execution-preflight-draft-fixture.js';

void test('exports canonical source plus a redacted non-live manifest', () => {
  const input = preflightDraftInputs();
  const exported = createExecutionPreflightSourceExport(input.source);
  assert.deepEqual(parseJson(exported.sourceJson), input.source);
  assert.equal(exported.manifest.state, 'PREFLIGHT_SOURCE_EXPORTED');
  assert.equal(exported.manifest.targetIntentId, input.source.target.intent.id);
  assert.equal(exported.manifest.simulationArtifactId, input.source.simulation.artifactId);
  assert.equal(exported.manifest.liveCapabilityPresent, false);
  assert.equal(JSON.stringify(exported.manifest).includes('secret'), false);
});
