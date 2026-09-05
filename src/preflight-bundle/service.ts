import {
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { createExecutionPreflightBundle } from '../domain/execution-preflight-bundle.js';
import { verifySignedExecutionCanaryEvidence } from '../domain/execution-canary-attestation.js';
import { verifySignedSafetyQualificationEvidence } from '../domain/execution-safety-attestation.js';
import { canonicalStringifyJson, parseJson } from '../utils/json.js';

export interface ExecutionPreflightBundleManifestV1 {
  readonly schemaVersion: 'execution-preflight-bundle.v1';
  readonly state: 'PREFLIGHT_EVIDENCE_PACKAGED';
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
  readonly qualifiedAtMs: number;
  readonly expiresAtMs: number;
  readonly evidencePublicKeyBase64: string;
  readonly canaryStatus: 'CANARY_NOT_STARTED';
  readonly paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED';
  readonly liveCapabilityPresent: false;
}

export interface ExecutionPreflightBundlePackageV1 {
  readonly qualificationEnvelope: string;
  readonly canaryEnvelope: string;
  readonly manifest: ExecutionPreflightBundleManifestV1;
}

export class ExecutionPreflightBundleServiceError extends Error {
  public readonly code = 'EXECUTION_PREFLIGHT_BUNDLE_FAILED' as const;
  public constructor() {
    super('Execution preflight bundle packaging failed.');
    this.name = 'ExecutionPreflightBundleServiceError';
  }
}

export function createExecutionPreflightBundlePackage(
  encodedDraft: string,
  privateKeyText: string,
  nowMs = Date.now(),
): ExecutionPreflightBundlePackageV1 {
  try {
    if (encodedDraft.length === 0
      || Buffer.byteLength(encodedDraft, 'utf8') > 1_048_576) throw invalid();
    if (privateKeyText.length === 0
      || Buffer.byteLength(privateKeyText, 'utf8') > 8_192
      || !Number.isSafeInteger(nowMs) || nowMs < 0) throw invalid();
    const decodedDraft = parseJson(encodedDraft);
    if (canonicalStringifyJson(decodedDraft) !== encodedDraft) throw invalid();
    const bundle = createExecutionPreflightBundle(deepFreeze(decodedDraft));
    assertFreshForPackaging(bundle, nowMs);
    const privateKey = createPrivateKey(privateKeyText);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw invalid();
    const evidencePublicKeyBase64 = createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' }).toString('base64');

    const qualificationPayload = without(
      bundle.qualification,
      ['qualificationId', 'qualificationFingerprint'],
    );
    const canaryPayload = without(
      bundle.canary,
      ['evidenceId', 'evidenceFingerprint'],
    );
    const qualificationEnvelope = signedEnvelope(qualificationPayload, privateKey);
    const canaryEnvelope = signedEnvelope(canaryPayload, privateKey);

    const verifiedQualification = verifySignedSafetyQualificationEvidence(
      deepFreeze(parseJson(qualificationEnvelope)),
      evidencePublicKeyBase64,
    );
    const verifiedCanary = verifySignedExecutionCanaryEvidence(
      deepFreeze(parseJson(canaryEnvelope)),
      evidencePublicKeyBase64,
    );
    if (verifiedQualification.qualificationId !== bundle.qualification.qualificationId
      || verifiedQualification.qualificationFingerprint
        !== bundle.qualification.qualificationFingerprint
      || verifiedCanary.evidenceId !== bundle.canary.evidenceId
      || verifiedCanary.evidenceFingerprint !== bundle.canary.evidenceFingerprint) throw invalid();

    return Object.freeze({
      qualificationEnvelope,
      canaryEnvelope,
      manifest: Object.freeze({
        schemaVersion: 'execution-preflight-bundle.v1',
        state: 'PREFLIGHT_EVIDENCE_PACKAGED',
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
        qualifiedAtMs: bundle.qualification.qualifiedAtMs,
        expiresAtMs: bundle.canary.expiresAtMs,
        evidencePublicKeyBase64,
        canaryStatus: 'CANARY_NOT_STARTED',
        paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
        liveCapabilityPresent: false,
      }),
    });
  } catch {
    throw invalid();
  }
}

function assertFreshForPackaging(
  bundle: ReturnType<typeof createExecutionPreflightBundle>,
  nowMs: number,
): void {
  const marginMs = 5_000;
  if (bundle.qualification.qualifiedAtMs > nowMs
    || bundle.canary.capturedAtMs > nowMs
    || bundle.canary.walletSnapshot.observedAtMs > nowMs
    || bundle.canary.providerSnapshot.measuredAtMs > nowMs
    || bundle.qualification.expiresAtMs < nowMs + marginMs
    || bundle.canary.expiresAtMs < nowMs + marginMs
    || bundle.canary.providerSnapshot.expiresAtMs < nowMs + marginMs) throw invalid();
}

function signedEnvelope(value: unknown, privateKey: ReturnType<typeof createPrivateKey>): string {
  const payload = Buffer.from(canonicalStringifyJson(value), 'utf8');
  return canonicalStringifyJson(Object.freeze({
    payloadVersion: 1,
    algorithm: 'Ed25519',
    signedPayloadBase64: payload.toString('base64'),
    signatureBase64: sign(null, payload, privateKey).toString('base64'),
  }));
}

function without(value: object, omitted: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.includes(key)),
  ));
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function invalid(): ExecutionPreflightBundleServiceError {
  return new ExecutionPreflightBundleServiceError();
}
