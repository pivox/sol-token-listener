import { createExecutionPreflightBundle } from '../domain/execution-preflight-bundle.js';
import { createExecutionPreflightDraft } from '../domain/execution-preflight-draft.js';
import { canonicalStringifyJson, parseJson } from '../utils/json.js';

export interface ExecutionPreflightDraftManifestV1 {
  readonly schemaVersion: 'execution-preflight-draft-manifest.v1';
  readonly state: 'PREFLIGHT_DRAFT_ASSEMBLED';
  readonly qualificationId: string;
  readonly qualificationFingerprint: string;
  readonly canaryEvidenceId: string;
  readonly canaryEvidenceFingerprint: string;
  readonly targetIntentId: string;
  readonly generationId: string;
  readonly walletPublicKey: string;
  readonly providerId: string;
  readonly walletSnapshotId: string;
  readonly walletSnapshotFingerprint: string;
  readonly providerSnapshotId: string;
  readonly providerSnapshotFingerprint: string;
  readonly simulationArtifactId: string;
  readonly buildFingerprint: string;
  readonly configurationFingerprint: string;
  readonly strategyFingerprint: string;
  readonly assembledAtMs: number;
  readonly expiresAtMs: number;
  readonly canaryStatus: 'CANARY_NOT_STARTED';
  readonly paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED';
  readonly liveCapabilityPresent: false;
}

export interface ExecutionPreflightDraftResultV1 {
  readonly draftJson: string;
  readonly manifest: ExecutionPreflightDraftManifestV1;
}

export class ExecutionPreflightDraftServiceError extends Error {
  public readonly code = 'EXECUTION_PREFLIGHT_DRAFT_FAILED' as const;
  public constructor() {
    super('Execution preflight draft assembly failed.');
    this.name = 'ExecutionPreflightDraftServiceError';
  }
}

export function assembleExecutionPreflightDraft(
  sourceJson: string,
  gateCatalogJson: string,
): ExecutionPreflightDraftResultV1 {
  try {
    const source = parseCanonical(sourceJson);
    const catalog = parseCanonical(gateCatalogJson);
    const draft = createExecutionPreflightDraft(deepFreeze(source), deepFreeze(catalog));
    const bundle = createExecutionPreflightBundle(draft);
    const simulation = requiredObject((source as Readonly<Record<string, unknown>>).simulation);
    const draftJson = canonicalStringifyJson(draft);
    return Object.freeze({
      draftJson,
      manifest: Object.freeze({
        schemaVersion: 'execution-preflight-draft-manifest.v1',
        state: 'PREFLIGHT_DRAFT_ASSEMBLED',
        qualificationId: bundle.qualification.qualificationId,
        qualificationFingerprint: bundle.qualification.qualificationFingerprint,
        canaryEvidenceId: bundle.canary.evidenceId,
        canaryEvidenceFingerprint: bundle.canary.evidenceFingerprint,
        targetIntentId: bundle.canary.targetIntentId,
        generationId: bundle.qualification.generationId,
        walletPublicKey: bundle.qualification.walletPublicKey,
        providerId: bundle.qualification.providerId,
        walletSnapshotId: bundle.canary.walletSnapshot.snapshotId,
        walletSnapshotFingerprint: bundle.canary.walletSnapshot.snapshotFingerprint,
        providerSnapshotId: bundle.canary.providerSnapshot.snapshotId,
        providerSnapshotFingerprint: bundle.canary.providerSnapshot.snapshotFingerprint,
        simulationArtifactId: requiredString(simulation.artifactId),
        buildFingerprint: bundle.qualification.buildHash,
        configurationFingerprint: bundle.qualification.configurationFingerprint,
        strategyFingerprint: bundle.qualification.strategyFingerprint,
        assembledAtMs: bundle.canary.capturedAtMs,
        expiresAtMs: bundle.canary.expiresAtMs,
        canaryStatus: 'CANARY_NOT_STARTED',
        paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
        liveCapabilityPresent: false,
      }),
    });
  } catch {
    throw new ExecutionPreflightDraftServiceError();
  }
}

function parseCanonical(value: string): unknown {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 1_048_576) throw new TypeError();
  const decoded = parseJson(value);
  if (canonicalStringifyJson(decoded) !== value) throw new TypeError();
  return decoded;
}
function requiredObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError();
  return value as Readonly<Record<string, unknown>>;
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError();
  return value;
}
function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
