import {
  createExecutionArmament,
  createExecutionArmamentRequestV2,
  createExecutionArmamentRequestV3,
  type ExecutionActivationArmamentV1,
  type ExecutionActivationArmamentV2,
  type ExecutionCanaryTargetV2,
} from '../domain/execution-operations.js';
import {
  createExecutionPreflightDraftSource,
  type ExecutionPreflightDraftSourceV2,
} from '../domain/execution-preflight-draft.js';
import type { ExecutionCanaryEvidenceV1 } from '../domain/execution-canary.js';
import {
  createEntryEnvelope,
  type EntryEnvelopeV2,
} from '../domain/execution-entry-envelope.js';
import type { ExecutionRiskPolicyV1 } from '../domain/execution-risk-policy.js';
import type {
  ExecutionSafetyQualification,
  ExecutionSafetyQualificationV1,
  ExecutionSafetyQualificationV2,
} from '../domain/execution-safety-qualification.js';
import type {
  ExecutionControlCommandV1,
  ExecutionCanaryArmamentRepository,
  ExecutionEntryEnvelopeRepository,
  ExecutionEntryEnvelopeSummaryV1,
  ExecutionEnvelopeFactsQueryV1,
  ExecutionEnvelopeFactsV1,
  ExecutionEnvelopeRevocationV1,
  ExecutionEnvelopeRevokeCommandV1,
  ExecutionCanaryTargetIntentV1,
  ExecutionOperationsRepository,
  ExecutionOperationsStatusV1,
} from '../ports/execution-operations-repository.js';
import {
  authorizeEnvelopeCreation,
  authorizeOperatorAction,
  authorizeCanaryArmament,
  type OperatorTerminal,
} from './terminal.js';

interface ServiceDependencies {
  readonly repository: ExecutionOperationsRepository;
  readonly canaryRepository?: ExecutionCanaryArmamentRepository;
  readonly envelopeRepository?: ExecutionEntryEnvelopeRepository;
  readonly nonceSource: () => string;
}

export interface CreateEnvelopeCommandV1 {
  readonly payloadVersion: 1;
  readonly qualification: ExecutionSafetyQualificationV2;
  readonly policy: ExecutionRiskPolicyV1;
  readonly operatorId: string;
  readonly perBuyQuoteAmountRaw: bigint;
  readonly maxBuys: number;
  readonly maxTotalExposureRaw: bigint;
  readonly maxRealizedLossRaw: bigint;
  readonly maximumHoldingMs: number;
  readonly terminal: OperatorTerminal;
}

export type ExecutionEnvelopeCommandErrorCode =
  | 'ENVELOPE_LIMITS_REJECTED'
  | 'ENVELOPE_FACTS_UNAVAILABLE';

/** An envelope refusal the operator must be able to tell apart from a generic failure. */
export class ExecutionEnvelopeCommandError extends Error {
  public readonly code: ExecutionEnvelopeCommandErrorCode;

  public constructor(code: ExecutionEnvelopeCommandErrorCode) {
    super(code === 'ENVELOPE_LIMITS_REJECTED'
      ? 'Envelope limits rejected: window, caps or risk policy (capital >= 20 x per-buy after the loss cap).'
      : 'No matching SUCCESS mainnet simulation artifact in the last 24 hours.');
    this.name = 'ExecutionEnvelopeCommandError';
    this.code = code;
  }
}

interface ArmCommandV1 {
  readonly payloadVersion: 1;
  readonly qualificationId: string;
  readonly maximumCapitalLamports: bigint;
  readonly maximumHoldingMs: number;
  readonly operatorId: string;
  readonly operatorReason: string;
  readonly nowMs: number;
  readonly terminal: OperatorTerminal;
}

interface ResumeCommandV1 {
  readonly payloadVersion: 1;
  readonly commandId: string;
  readonly qualificationId: string;
  readonly operatorId: string;
  readonly nowMs: number;
  readonly terminal: OperatorTerminal;
}

interface ArmCanaryCommandV2 {
  readonly payloadVersion: 2;
  readonly evidence: ExecutionCanaryEvidenceV1;
  readonly intentId: string;
  readonly maximumCapitalLamports: bigint;
  readonly maximumHoldingMs: number;
  readonly runtimeQuoteMaxAgeMs: number;
  readonly runtimeSlippageBps: bigint;
  readonly runtimeSnapshotMaxSlotLag: number;
  readonly runtimeMaxComputeUnits: bigint;
  readonly runtimeMaxFeeLamports: bigint;
  readonly runtimeMaxFeePayerLamportDebit: bigint;
  readonly runtimeMaxRpcCallsPerAttempt: number;
  readonly runtimeLeaseMs: number;
  readonly operatorId: string;
  readonly operatorReason: string;
  readonly nowMs: number;
  readonly terminal: OperatorTerminal;
}

interface ArmCanaryCommandV3 extends Omit<ArmCanaryCommandV2, 'payloadVersion'> {
  readonly payloadVersion: 3;
  readonly preflightSource: ExecutionPreflightDraftSourceV2;
}

export interface ExecutionOperationsService {
  readonly preflight: (
    qualification: ExecutionSafetyQualification,
  ) => Promise<ExecutionSafetyQualification>;
  readonly status: (generationId: string) => Promise<ExecutionOperationsStatusV1>;
  readonly stop: (
    command: ExecutionControlCommandV1,
    mode: 'ENTRY_STOP' | 'HARD_STOP',
  ) => Promise<ExecutionOperationsStatusV1>;
  readonly arm: (command: ArmCommandV1 | ArmCanaryCommandV2 | ArmCanaryCommandV3) => Promise<
    ExecutionActivationArmamentV1 | ExecutionActivationArmamentV2
  >;
  readonly resume: (command: ResumeCommandV1) => Promise<ExecutionOperationsStatusV1>;
  readonly prepareEnvelopeFacts: (
    generationId: string,
    query: ExecutionEnvelopeFactsQueryV1,
  ) => Promise<ExecutionEnvelopeFactsV1 | null>;
  readonly createEnvelope: (command: CreateEnvelopeCommandV1) => Promise<EntryEnvelopeV2>;
  readonly revokeEnvelope: (
    command: ExecutionEnvelopeRevokeCommandV1,
  ) => Promise<ExecutionEnvelopeRevocationV1>;
  readonly readEnvelopes: (
    generationId: string,
  ) => Promise<readonly ExecutionEntryEnvelopeSummaryV1[]>;
}

export function createExecutionOperationsService(
  dependencies: ServiceDependencies,
): ExecutionOperationsService {
  const envelopeRepository = (): ExecutionEntryEnvelopeRepository => {
    if (dependencies.envelopeRepository === undefined) {
      throw new Error('ENVELOPE_REPOSITORY_UNAVAILABLE');
    }
    return dependencies.envelopeRepository;
  };
  return Object.freeze({
    preflight: (qualification: ExecutionSafetyQualification) =>
      dependencies.repository.persistQualification(qualification),
    status: (generationId: string) => dependencies.repository.readStatus(generationId),
    stop: (command: ExecutionControlCommandV1, mode: 'ENTRY_STOP' | 'HARD_STOP') =>
      dependencies.repository.setStop(command, mode),
    arm: async (command: ArmCommandV1 | ArmCanaryCommandV2 | ArmCanaryCommandV3) => {
      if (command.payloadVersion === 2 || command.payloadVersion === 3) {
        const canaryRepository = dependencies.canaryRepository;
        if (canaryRepository === undefined) throw new Error('CANARY_ARMAMENT_REPOSITORY_UNAVAILABLE');
        const qualification = await dependencies.repository.readQualification(
          command.evidence.qualification.qualificationId,
        );
        const target = await canaryRepository.readTargetIntent(command.intentId);
        const targetRequest = targetFromIntent(target);
        if (qualification.qualificationId !== command.evidence.qualification.qualificationId
          || qualification.qualificationFingerprint !== command.evidence.qualification.qualificationFingerprint
          || qualification.qualifiedAtMs > command.nowMs
          || command.intentId !== command.evidence.targetIntentId
          || command.evidence.walletSnapshot.generationId !== qualification.generationId
          || command.evidence.walletSnapshot.providerId !== qualification.providerId
          || command.evidence.providerSnapshot.providerId !== qualification.providerId
          || command.evidence.capturedAtMs > command.nowMs
          || command.evidence.providerSnapshot.measuredAtMs > command.nowMs
          || command.evidence.walletSnapshot.observedAtMs > command.nowMs
          || target.intentId !== command.evidence.targetIntentId || target.side !== 'BUY'
          || target.status !== 'PENDING' || target.leaseOwner !== null
          || target.leaseExpiresAtMs !== null || target.expiresAtMs <= command.nowMs) {
          throw new Error('CANARY_ARMAMENT_INPUT_INVALID');
        }
        const effectiveExpiryMs = effectiveCanaryExpiryMs(qualification.expiresAtMs, target.expiresAtMs,
          command.evidence.expiresAtMs, command.evidence.providerSnapshot.expiresAtMs,
          command.evidence.providerSnapshot.measuredAtMs + command.evidence.policy.providerUsageMaxAgeMs,
          command.evidence.walletSnapshot.observedAtMs + command.evidence.policy.walletSnapshotMaxAgeMs,
          command.payloadVersion === 3 ? command.preflightSource.expiresAtMs
            : Number.MAX_SAFE_INTEGER);
        if (effectiveExpiryMs < command.nowMs + 2 * command.runtimeLeaseMs) {
          throw new Error('CANARY_ARMAMENT_EXPIRED');
        }
        const requestInput = {
          payloadVersion: command.payloadVersion, qualification,
          targetIntentId: command.evidence.targetIntentId,
          policy: command.evidence.policy, walletSnapshot: command.evidence.walletSnapshot,
          providerSnapshot: command.evidence.providerSnapshot,
          allEndpointsUnavailable: command.evidence.allEndpointsUnavailable,
          capturedAtMs: command.evidence.capturedAtMs, expiresAtMs: command.evidence.expiresAtMs,
          target: targetRequest, maximumBuys: 1, maximumCapitalLamports: command.maximumCapitalLamports,
          maximumExposureBps: 500n, maximumOpenPositions: 1, maximumHoldingMs: command.maximumHoldingMs,
          runtimeQuoteMaxAgeMs: command.runtimeQuoteMaxAgeMs, runtimeSlippageBps: command.runtimeSlippageBps,
          runtimeSnapshotMaxSlotLag: command.runtimeSnapshotMaxSlotLag,
          runtimeMaxComputeUnits: command.runtimeMaxComputeUnits,
          runtimeMaxFeeLamports: command.runtimeMaxFeeLamports,
          runtimeMaxFeePayerLamportDebit: command.runtimeMaxFeePayerLamportDebit,
          runtimeMaxRpcCallsPerAttempt: command.runtimeMaxRpcCallsPerAttempt,
          runtimeLeaseMs: command.runtimeLeaseMs, armedAtMs: command.nowMs,
          armamentExpiresAtMs: effectiveExpiryMs, operatorId: command.operatorId,
          operatorReason: command.operatorReason,
        };
        const request = command.payloadVersion === 3
          ? createExecutionArmamentRequestV3({ ...requestInput, payloadVersion: 3,
            lineageProof: lineageProofFromSource(command.preflightSource, command.evidence,
              target, command.nowMs) })
          : createExecutionArmamentRequestV2(requestInput);
        const authorization = await authorizeCanaryArmament({
          terminal: command.terminal, nonceSource: dependencies.nonceSource,
          payloadVersion: command.payloadVersion,
          generationId: qualification.generationId, walletPublicKey: qualification.walletPublicKey,
          action: 'ARM', phase: 'CANARY', contextFingerprint: request.armamentRequestFingerprint,
          operatorId: command.operatorId, nowMs: command.nowMs, targetIntentId: request.target.intentId,
          targetMint: request.target.mint, targetQuoteMint: request.target.quoteMint,
          targetQuoteAmountRaw: request.target.quoteAmountRaw,
          maximumCapitalLamports: request.maximumCapitalLamports,
          maximumHoldingMs: request.maximumHoldingMs, expiresAtMs: request.armamentExpiresAtMs,
          policyFingerprint: request.policy.policyFingerprint,
          walletSnapshotFingerprint: request.walletSnapshot.snapshotFingerprint,
          providerSnapshotFingerprint: request.providerSnapshot.snapshotFingerprint,
          runtimeQuoteMaxAgeMs: request.runtimeQuoteMaxAgeMs,
          runtimeSlippageBps: request.runtimeSlippageBps,
          runtimeSnapshotMaxSlotLag: request.runtimeSnapshotMaxSlotLag,
          runtimeMaxComputeUnits: request.runtimeMaxComputeUnits,
          runtimeMaxFeeLamports: request.runtimeMaxFeeLamports,
          runtimeMaxFeePayerLamportDebit: request.runtimeMaxFeePayerLamportDebit,
          runtimeMaxRpcCallsPerAttempt: request.runtimeMaxRpcCallsPerAttempt,
          runtimeLeaseMs: request.runtimeLeaseMs,
          ...(request.payloadVersion === 3 ? {
            preparationRunId: request.lineageProof.preparationRunId,
            pairId: request.lineageProof.pairId,
            pairFingerprint: request.lineageProof.pairFingerprint,
            preparationManifestFingerprint: request.lineageProof.preparationManifestFingerprint,
            proofFingerprint: request.lineageProof.proofFingerprint,
          } : {}),
        });
        if (request.payloadVersion === 3) {
          if (command.payloadVersion !== 3) throw new Error('CANARY_ARMAMENT_INPUT_INVALID');
          return canaryRepository.armCanary(Object.freeze({ request, authorization,
            preflightSource: command.preflightSource }));
        }
        return canaryRepository.armCanary(Object.freeze({ request, authorization }));
      }
      const qualification = await dependencies.repository.readQualification(command.qualificationId);
      const authorization = await authorizeOperatorAction({
        terminal: command.terminal,
        nonceSource: dependencies.nonceSource,
        payloadVersion: command.payloadVersion,
        generationId: qualification.generationId,
        walletPublicKey: qualification.walletPublicKey,
        action: 'ARM',
        phase: qualification.phase,
        contextFingerprint: qualification.qualificationFingerprint,
        operatorId: command.operatorId,
        nowMs: command.nowMs,
      });
      await dependencies.repository.recordAuthorization(authorization);
      const limits = phaseLimits(qualification.phase);
      return dependencies.repository.arm(createExecutionArmament({
        payloadVersion: 1,
        qualification,
        ...limits,
        maximumCapitalLamports: command.maximumCapitalLamports,
        maximumHoldingMs: command.maximumHoldingMs,
        armedAtMs: command.nowMs,
        expiresAtMs: qualification.expiresAtMs,
        operatorId: command.operatorId,
        operatorReason: command.operatorReason,
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.authorizationFingerprint,
      }));
    },
    resume: async (command: ResumeCommandV1) => {
      const qualification = await dependencies.repository.readQualification(command.qualificationId);
      const authorization = await authorizeOperatorAction({
        terminal: command.terminal,
        nonceSource: dependencies.nonceSource,
        payloadVersion: command.payloadVersion,
        generationId: qualification.generationId,
        walletPublicKey: qualification.walletPublicKey,
        action: 'RESUME',
        phase: null,
        contextFingerprint: qualification.qualificationFingerprint,
        operatorId: command.operatorId,
        nowMs: command.nowMs,
      });
      await dependencies.repository.recordAuthorization(authorization);
      return dependencies.repository.resume({
        payloadVersion: 1,
        commandId: command.commandId,
        generationId: qualification.generationId,
        qualificationId: qualification.qualificationId,
        authorization,
        operatorId: command.operatorId,
        occurredAtMs: command.nowMs,
      });
    },
    prepareEnvelopeFacts: (generationId: string, query: ExecutionEnvelopeFactsQueryV1) =>
      envelopeRepository().prepareEnvelopeFacts(generationId, query),
    createEnvelope: async (command: CreateEnvelopeCommandV1) => {
      const repository = envelopeRepository();
      const qualification = command.qualification;
      // A15: the envelope starts at the DB now, never at the operator's clock.
      const { databaseNowMs } = await repository.expireEnvelopes(qualification.generationId);
      let envelope: EntryEnvelopeV2;
      try {
        envelope = createEntryEnvelope(Object.freeze({
          payloadVersion: 2, qualification, operatorId: command.operatorId,
          perBuyQuoteAmountRaw: command.perBuyQuoteAmountRaw, maxBuys: command.maxBuys,
          maxTotalExposureRaw: command.maxTotalExposureRaw,
          maxRealizedLossRaw: command.maxRealizedLossRaw,
          maximumHoldingMs: command.maximumHoldingMs,
          validFromMs: databaseNowMs, validUntilMs: qualification.expiresAtMs,
          policy: command.policy,
        }));
      } catch {
        throw new ExecutionEnvelopeCommandError('ENVELOPE_LIMITS_REJECTED');
      }
      const authorization = await authorizeEnvelopeCreation({
        terminal: command.terminal, nonceSource: dependencies.nonceSource,
        walletPublicKey: qualification.walletPublicKey, envelope, nowMs: databaseNowMs,
      });
      await dependencies.repository.recordAuthorization(authorization);
      return repository.createEnvelope(Object.freeze({ envelope, qualification, authorization }));
    },
    revokeEnvelope: (command: ExecutionEnvelopeRevokeCommandV1) =>
      envelopeRepository().revokeEnvelope(command),
    readEnvelopes: (generationId: string) => envelopeRepository().readEnvelopes(generationId),
  });
}

function lineageProofFromSource(
  input: ExecutionPreflightDraftSourceV2,
  evidence: ExecutionCanaryEvidenceV1,
  target: ExecutionCanaryTargetIntentV1,
  nowMs: number,
): Readonly<{
  preparationRunId: string; preparationRunFingerprint: string; pairId: string;
  pairFingerprint: string; targetAssessmentId: string; targetAssessmentFingerprint: string;
  simulationArtifactId: string; simulationArtifactFingerprint: string;
  preparationManifestFingerprint: string; candidateId: string;
  candidateEvidenceFingerprint: string; proofFingerprint: string;
  sourceCapturedAtMs: number; sourceExpiresAtMs: number;
}> {
  const source = createExecutionPreflightDraftSource(input);
  if (source.schemaVersion !== 'execution-preflight-draft-source.v2'
    || source.target.intent.id !== target.intentId
    || source.target.intent.stateRevision !== target.stateRevision
    || source.target.intent.decisionFingerprint !== target.decisionFingerprint
    || source.target.intent.mint !== target.mint
    || source.target.intent.quoteMint !== target.quoteMint
    || source.target.intent.quoteAmountRaw !== target.quoteAmountRaw
    || source.generation.generationId !== evidence.qualification.generationId
    || source.generation.walletPublicKey !== evidence.qualification.walletPublicKey
    || source.generation.genesisHash !== evidence.qualification.genesisHash
    || source.walletSnapshot.snapshotFingerprint !== evidence.walletSnapshot.snapshotFingerprint
    || source.providerSnapshot.snapshotFingerprint !== evidence.providerSnapshot.snapshotFingerprint
    || source.providerSnapshot.providerId !== evidence.qualification.providerId
    || source.capturedAtMs > nowMs || source.expiresAtMs <= nowMs) {
    throw new Error('CANARY_ARMAMENT_INPUT_INVALID');
  }
  return Object.freeze({
    preparationRunId: source.lineage.preparationRunId,
    preparationRunFingerprint: source.lineage.preparationRunFingerprint,
    pairId: source.lineage.pairId, pairFingerprint: source.lineage.pairFingerprint,
    targetAssessmentId: source.lineage.targetAssessmentId,
    targetAssessmentFingerprint: source.lineage.targetAssessmentFingerprint,
    simulationArtifactId: source.lineage.simulationArtifactId,
    simulationArtifactFingerprint: source.lineage.simulationArtifactFingerprint,
    preparationManifestFingerprint: source.lineage.preparationManifestFingerprint,
    candidateId: source.lineage.candidateId,
    candidateEvidenceFingerprint: source.lineage.candidateEvidenceFingerprint,
    proofFingerprint: source.proofFingerprint, sourceCapturedAtMs: source.capturedAtMs,
    sourceExpiresAtMs: source.expiresAtMs,
  });
}

function targetFromIntent(
  target: ExecutionCanaryTargetIntentV1,
): ExecutionCanaryTargetV2 {
  return Object.freeze({ intentId: target.intentId, stateRevision: target.stateRevision,
    strategyId: target.strategyId, strategyVersion: target.strategyVersion,
    decisionFingerprint: target.decisionFingerprint, mint: target.mint, quoteMint: target.quoteMint,
    quoteAmountRaw: target.quoteAmountRaw });
}

function effectiveCanaryExpiryMs(...values: readonly number[]): number {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('CANARY_ARMAMENT_INPUT_INVALID');
  }
  return Math.min(...values);
}

function phaseLimits(phase: ExecutionSafetyQualificationV1['phase']): Readonly<{
  maximumBuys: number;
  maximumExposureBps: bigint;
  maximumOpenPositions: number;
}> {
  switch (phase) {
    case 'CANARY': return Object.freeze({
      maximumBuys: 1, maximumExposureBps: 500n, maximumOpenPositions: 1,
    });
    case 'MICRO_LIVE': return Object.freeze({
      maximumBuys: 3, maximumExposureBps: 500n, maximumOpenPositions: 1,
    });
    case 'PILOT': return Object.freeze({
      maximumBuys: 10, maximumExposureBps: 2_000n, maximumOpenPositions: 2,
    });
  }
}
