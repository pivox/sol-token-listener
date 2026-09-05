import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalStringifyJson, parseJson } from '../src/utils/json.js';
import { assembleExecutionPreflightDraft } from '../src/preflight-draft/service.js';
import { preflightDraftInputs } from './helpers/execution-preflight-draft-fixture.js';

void test('assembles canonical draft and a redacted non-live manifest', () => {
  const input = preflightDraftInputs();
  const result = assembleExecutionPreflightDraft(
    canonicalStringifyJson(input.source), canonicalStringifyJson(input.catalog),
  );
  assert.equal(result.manifest.state, 'PREFLIGHT_DRAFT_ASSEMBLED');
  assert.equal(result.manifest.targetIntentId, input.source.target.intent.id);
  assert.equal(result.manifest.simulationArtifactId, input.source.simulation.artifactId);
  assert.equal(result.manifest.liveCapabilityPresent, false);
  assert.equal(result.manifest.paperMainnet49Status, 'NON_EXECUTED_NON_VALIDATED');
  assert.doesNotMatch(canonicalStringifyJson(result.manifest), /secret|private|signature/iu);
  assert.equal(canonicalStringifyJson(parseJson(result.draftJson)), result.draftJson);
});

void test('rejects non-canonical and malformed inputs with one stable error', () => {
  const input = preflightDraftInputs();
  const catalog = canonicalStringifyJson(input.catalog);
  assert.throws(() => assembleExecutionPreflightDraft(
    `${canonicalStringifyJson(input.source)}\n`, catalog,
  ), { code: 'EXECUTION_PREFLIGHT_DRAFT_FAILED' });
  assert.throws(() => assembleExecutionPreflightDraft('{}', catalog),
    { code: 'EXECUTION_PREFLIGHT_DRAFT_FAILED' });
});
