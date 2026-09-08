import type {
  ExecutionPreflightDraftSource,
  ExecutionPreflightDraftSourceV1,
  ExecutionPreflightDraftSourceV2,
} from '../domain/execution-preflight-draft.js';
import { createExecutionPreflightDraftSource } from '../domain/execution-preflight-draft.js';
import { canonicalStringifyJson } from '../utils/json.js';

export interface ExecutionPreflightSourceManifestV1 {
  readonly schemaVersion: 'execution-preflight-source-export.v1';
  readonly state: 'PREFLIGHT_SOURCE_EXPORTED';
  readonly generationId: string;
  readonly targetIntentId: string;
  readonly simulationArtifactId: string;
  readonly walletSnapshotId: string;
  readonly walletSnapshotFingerprint: string;
  readonly providerSnapshotId: string;
  readonly providerSnapshotFingerprint: string;
  readonly databaseCapturedAtMs: number;
  readonly expiresAtMs: number;
  readonly canaryStatus: 'CANARY_NOT_STARTED';
  readonly paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED';
  readonly liveCapabilityPresent: false;
}

export interface ExecutionPreflightSourceManifestV2 {
  readonly schemaVersion: 'execution-preflight-source-export.v2';
  readonly state: 'PREFLIGHT_SOURCE_EXPORTED';
  readonly preparationRunId: string;
  readonly preparationRunFingerprint: string;
  readonly pairId: string;
  readonly pairFingerprint: string;
  readonly targetIntentId: string;
  readonly simulationArtifactId: string;
  readonly proofFingerprint: string;
  readonly databaseCapturedAtMs: number;
  readonly expiresAtMs: number;
  readonly canaryStatus: 'CANARY_NOT_STARTED';
  readonly paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED';
  readonly liveCapabilityPresent: false;
}

export function createExecutionPreflightSourceExport(sourceInput: unknown): Readonly<{
  sourceJson: string;
  manifest: ExecutionPreflightSourceManifestV1 | ExecutionPreflightSourceManifestV2;
}> {
  const source: ExecutionPreflightDraftSource = createExecutionPreflightDraftSource(sourceInput);
  if (source.schemaVersion === 'execution-preflight-draft-source.v2') {
    return sourceV2Export(source);
  }
  return sourceV1Export(source);
}

function sourceV2Export(source: ExecutionPreflightDraftSourceV2): Readonly<{
  sourceJson: string;
  manifest: ExecutionPreflightSourceManifestV2;
}> {
  return Object.freeze({ sourceJson: canonicalStringifyJson(source), manifest: Object.freeze({
    schemaVersion: 'execution-preflight-source-export.v2', state: 'PREFLIGHT_SOURCE_EXPORTED',
    preparationRunId: source.lineage.preparationRunId,
    preparationRunFingerprint: source.lineage.preparationRunFingerprint,
    pairId: source.lineage.pairId,
    pairFingerprint: source.lineage.pairFingerprint,
    targetIntentId: source.target.intent.id,
    simulationArtifactId: source.simulation.artifactId,
    proofFingerprint: source.proofFingerprint,
    databaseCapturedAtMs: source.capturedAtMs,
    expiresAtMs: source.expiresAtMs,
    canaryStatus: 'CANARY_NOT_STARTED', paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
    liveCapabilityPresent: false,
  }) });
}

function sourceV1Export(source: ExecutionPreflightDraftSourceV1): Readonly<{
  sourceJson: string;
  manifest: ExecutionPreflightSourceManifestV1;
}> {
  return Object.freeze({ sourceJson: canonicalStringifyJson(source), manifest: Object.freeze({
    schemaVersion: 'execution-preflight-source-export.v1', state: 'PREFLIGHT_SOURCE_EXPORTED',
    generationId: source.generation.generationId, targetIntentId: source.target.intent.id,
    simulationArtifactId: source.simulation.artifactId,
    walletSnapshotId: source.walletSnapshot.snapshotId,
    walletSnapshotFingerprint: source.walletSnapshot.snapshotFingerprint,
    providerSnapshotId: source.providerSnapshot.snapshotId,
    providerSnapshotFingerprint: source.providerSnapshot.snapshotFingerprint,
    databaseCapturedAtMs: source.databaseNowMs,
    expiresAtMs: Math.min(source.target.intent.expiresAtMs, source.providerSnapshot.expiresAtMs),
    canaryStatus: 'CANARY_NOT_STARTED', paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
    liveCapabilityPresent: false,
  }) });
}
