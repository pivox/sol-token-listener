import type { ExecutionPreflightDraftSourceV1 } from '../domain/execution-preflight-draft.js';
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

export function createExecutionPreflightSourceExport(sourceInput: unknown): Readonly<{
  sourceJson: string;
  manifest: ExecutionPreflightSourceManifestV1;
}> {
  const source: ExecutionPreflightDraftSourceV1 = createExecutionPreflightDraftSource(sourceInput);
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
