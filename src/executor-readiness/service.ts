import { isProxy } from 'node:util/types';
import { verifySignedProviderUsageEvidence } from
  '../domain/execution-provider-attestation.js';
import {
  createExecutionReadinessManifest,
  createExecutionWalletGeneration,
  type ExecutionReadinessManifestV1,
} from '../domain/execution-readiness.js';
import { createExecutionWalletSnapshot } from '../domain/execution-wallet-snapshot.js';
import type { ExecutionReadinessRepository } from
  '../ports/execution-readiness-repository.js';
import { parseJson } from '../utils/json.js';
import type { ExecutionReadinessConfig } from './config.js';
import type { ReadinessWalletObservationV1 } from './rpc-gateway.js';

export interface ExecutionReadinessRpc {
  readonly verifyGenesis: (signal: AbortSignal) => Promise<void>;
  readonly observeWallet: (
    walletPublicKey: string,
    maximumSlotLag: number,
    signal: AbortSignal,
    now?: () => number,
  ) => Promise<ReadinessWalletObservationV1>;
}

export interface ExecutionReadinessServiceDependencies {
  readonly config: ExecutionReadinessConfig;
  readonly rpc: ExecutionReadinessRpc;
  readonly repository: ExecutionReadinessRepository;
  readonly readEvidence: (path: string) => Promise<string>;
  readonly now: () => number;
}

export interface ExecutionReadinessService {
  readonly collect: (signal: AbortSignal) => Promise<ExecutionReadinessManifestV1>;
}

export class ExecutionReadinessServiceError extends Error {
  public readonly code = 'EXECUTION_READINESS_FAILED' as const;
  public constructor() {
    super('Execution readiness collection failed.');
    this.name = 'ExecutionReadinessServiceError';
  }
}

export function createExecutionReadinessService(
  dependencies: ExecutionReadinessServiceDependencies,
): ExecutionReadinessService {
  try {
    if (isProxy(dependencies)) throw new TypeError();
  } catch {
    throw invalid();
  }
  return Object.freeze({
    collect: async (signal: AbortSignal): Promise<ExecutionReadinessManifestV1> => {
      try {
        if (!(signal instanceof AbortSignal) || signal.aborted) throw new TypeError();
        const collectionStartedAtMs = timestamp(dependencies.now());
        const generation = createExecutionWalletGeneration(Object.freeze({
          walletPublicKey: dependencies.config.walletPublicKey,
          cluster: dependencies.config.cluster,
          genesisHash: dependencies.config.expectedGenesisHash,
          generation: dependencies.config.generationNumber,
        }));
        await dependencies.rpc.verifyGenesis(signal);
        const observation = await dependencies.rpc.observeWallet(
          dependencies.config.walletPublicKey,
          dependencies.config.maximumSlotLag,
          signal,
          () => collectionStartedAtMs,
        );
        const encodedEvidence = await dependencies.readEvidence(
          dependencies.config.providerEvidencePath,
        );
        if (Buffer.byteLength(encodedEvidence, 'utf8') > 131_072) throw new TypeError();
        const evidenceVerifiedAtMs = timestamp(dependencies.now());
        if (evidenceVerifiedAtMs < collectionStartedAtMs) throw new TypeError();
        const providerSnapshot = verifySignedProviderUsageEvidence(
          deepFreeze(parseJson(encodedEvidence)),
          dependencies.config.evidencePublicKeyBase64,
          dependencies.config.providerId,
          evidenceVerifiedAtMs,
        );
        const walletSnapshot = createExecutionWalletSnapshot(Object.freeze({
          generationId: generation.generationId,
          providerId: dependencies.config.providerId,
          stateRevision: 0n,
          slot: observation.slot,
          blockTimeMs: observation.blockTimeMs,
          observedAtMs: observation.observedAtMs,
          commitment: 'finalized' as const,
          walletLamports: observation.walletLamports,
          tokenBalanceCount: observation.tokenBalanceCount,
          openPositions: Object.freeze([]),
          realizedNetPnlRaw: 0n,
        }));
        const committed = await dependencies.repository.commit(Object.freeze({
          generation, walletSnapshot, providerSnapshot,
        }));
        return createExecutionReadinessManifest(Object.freeze({
          generationId: committed.generation.generationId,
          walletPublicKey: committed.generation.walletPublicKey,
          cluster: committed.generation.cluster,
          providerId: committed.providerSnapshot.providerId,
          walletSnapshotId: committed.walletSnapshot.snapshotId,
          walletSnapshotFingerprint: committed.walletSnapshot.snapshotFingerprint,
          providerSnapshotId: committed.providerSnapshot.snapshotId,
          providerSnapshotFingerprint: committed.providerSnapshot.snapshotFingerprint,
          walletLamports: committed.walletSnapshot.walletLamports,
          tokenBalanceCount: committed.walletSnapshot.tokenBalanceCount,
          observedAtMs: committed.walletSnapshot.observedAtMs,
          expiresAtMs: committed.providerSnapshot.expiresAtMs,
        }));
      } catch {
        throw invalid();
      }
    },
  });
}

function deepFreeze(value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > 8_640_000_000_000_000) throw invalid();
  return value as number;
}

function invalid(): ExecutionReadinessServiceError {
  return new ExecutionReadinessServiceError();
}
