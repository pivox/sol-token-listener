import {
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { verifySignedProviderUsageEvidence } from
  '../domain/execution-provider-attestation.js';
import {
  createHeliusProviderEvidenceManifest,
  createHeliusProviderUsage,
  type HeliusProviderEvidenceManifestV1,
} from '../domain/helius-provider-evidence.js';
import { canonicalStringifyJson, parseJson } from '../utils/json.js';
import type { HeliusProviderEvidenceConfig } from './config.js';

export interface HeliusProviderEvidenceClient {
  readonly getProjectUsage: (
    projectId: string,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

export interface HeliusProviderEvidenceServiceDependencies {
  readonly config: HeliusProviderEvidenceConfig;
  readonly client: HeliusProviderEvidenceClient;
  readonly readProtectedFile: (path: string) => Promise<string>;
  readonly writeEvidence: (path: string, value: string) => Promise<void>;
  readonly now: () => number;
}

export interface HeliusProviderEvidenceService {
  readonly collect: (signal: AbortSignal) => Promise<HeliusProviderEvidenceManifestV1>;
}

export class HeliusProviderEvidenceServiceError extends Error {
  public readonly code = 'HELIUS_PROVIDER_EVIDENCE_FAILED' as const;
  public constructor() {
    super('Helius provider evidence collection failed.');
    this.name = 'HeliusProviderEvidenceServiceError';
  }
}

export function createHeliusProviderEvidenceService(
  dependencies: HeliusProviderEvidenceServiceDependencies,
): HeliusProviderEvidenceService {
  return Object.freeze({
    collect: async (signal: AbortSignal): Promise<HeliusProviderEvidenceManifestV1> => {
      try {
        if (!(signal instanceof AbortSignal) || signal.aborted) throw new TypeError();
        const apiKey = secret(dependencies.config.apiKeyPath,
          await dependencies.readProtectedFile(dependencies.config.apiKeyPath));
        const response = await dependencies.client.getProjectUsage(
          dependencies.config.projectId, apiKey, signal,
        );
        const measuredAtMs = timestamp(dependencies.now());
        const usage = createHeliusProviderUsage(Object.freeze({
          providerId: dependencies.config.providerId,
          projectId: dependencies.config.projectId,
          response,
          measuredAtMs,
          ttlMs: dependencies.config.ttlMs,
        }));
        const privateKeyText = await dependencies.readProtectedFile(
          dependencies.config.privateKeyPath,
        );
        const privateKey = createPrivateKey(privateKeyText);
        if (privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError();
        const publicKeyBase64 = createPublicKey(privateKey)
          .export({ format: 'der', type: 'spki' }).toString('base64');
        const snapshot = usage.snapshot;
        const payload = canonicalStringifyJson(Object.freeze({
          providerId: snapshot.providerId,
          planId: snapshot.planId,
          billingPeriodId: snapshot.billingPeriodId,
          billingPeriodStartedAtMs: snapshot.billingPeriodStartedAtMs,
          billingPeriodEndsAtMs: snapshot.billingPeriodEndsAtMs,
          limitUnits: snapshot.limitUnits.toString(),
          usedUnits: snapshot.usedUnits.toString(),
          measuredAtMs: snapshot.measuredAtMs,
          expiresAtMs: snapshot.expiresAtMs,
          provenance: snapshot.provenance,
        }));
        const envelope = Object.freeze({
          payloadVersion: 1,
          algorithm: 'Ed25519',
          signedPayloadBase64: Buffer.from(payload, 'utf8').toString('base64'),
          signatureBase64: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
        });
        const encodedEnvelope = canonicalStringifyJson(envelope);
        const verifiedAtMs = timestamp(dependencies.now());
        if (verifiedAtMs < measuredAtMs || verifiedAtMs >= snapshot.expiresAtMs) {
          throw new TypeError();
        }
        const verified = verifySignedProviderUsageEvidence(
          deepFreeze(parseJson(encodedEnvelope)), publicKeyBase64,
          dependencies.config.providerId, verifiedAtMs,
        );
        if (verified.snapshotId !== snapshot.snapshotId
          || verified.snapshotFingerprint !== snapshot.snapshotFingerprint) throw new TypeError();
        await dependencies.writeEvidence(dependencies.config.outputPath, encodedEnvelope);
        const completedAtMs = timestamp(dependencies.now());
        if (completedAtMs < verifiedAtMs || completedAtMs >= snapshot.expiresAtMs) {
          throw new TypeError();
        }
        return createHeliusProviderEvidenceManifest(usage, publicKeyBase64);
      } catch {
        throw new HeliusProviderEvidenceServiceError();
      }
    },
  });
}

function secret(path: string, value: string): string {
  const result = value.endsWith('\n') ? value.slice(0, -1) : value;
  if (result.length === 0 || result.length > 512 || /\s/u.test(result)
    || result.includes('\0') || path.length === 0) throw new TypeError();
  return result;
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError();
  return value;
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
