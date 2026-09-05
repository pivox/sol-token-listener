import {
  createExecutionArmament,
  createExecutionArmamentRequestV2,
  type ExecutionActivationArmamentV1,
  type ExecutionActivationArmamentV2,
  type ExecutionCanaryTargetV2,
} from '../domain/execution-operations.js';
import type { ExecutionCanaryEvidenceV1 } from '../domain/execution-canary.js';
import type { ExecutionSafetyQualificationV1 } from '../domain/execution-safety-qualification.js';
import type {
  ExecutionControlCommandV1,
  ExecutionCanaryArmamentRepository,
  ExecutionCanaryTargetIntentV1,
  ExecutionOperationsRepository,
  ExecutionOperationsStatusV1,
} from '../ports/execution-operations-repository.js';
import {
  authorizeOperatorAction,
  authorizeCanaryArmament,
  type OperatorTerminal,
} from './terminal.js';

interface ServiceDependencies {
  readonly repository: ExecutionOperationsRepository;
  readonly canaryRepository?: ExecutionCanaryArmamentRepository;
  readonly nonceSource: () => string;
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

export interface ExecutionOperationsService {
  readonly preflight: (
    qualification: ExecutionSafetyQualificationV1,
  ) => Promise<ExecutionSafetyQualificationV1>;
  readonly status: (generationId: string) => Promise<ExecutionOperationsStatusV1>;
  readonly stop: (
    command: ExecutionControlCommandV1,
    mode: 'ENTRY_STOP' | 'HARD_STOP',
  ) => Promise<ExecutionOperationsStatusV1>;
  readonly arm: (command: ArmCommandV1 | ArmCanaryCommandV2) => Promise<
    ExecutionActivationArmamentV1 | ExecutionActivationArmamentV2
  >;
  readonly resume: (command: ResumeCommandV1) => Promise<ExecutionOperationsStatusV1>;
}

export function createExecutionOperationsService(
  dependencies: ServiceDependencies,
): ExecutionOperationsService {
  return Object.freeze({
    preflight: (qualification: ExecutionSafetyQualificationV1) =>
      dependencies.repository.persistQualification(qualification),
    status: (generationId: string) => dependencies.repository.readStatus(generationId),
    stop: (command: ExecutionControlCommandV1, mode: 'ENTRY_STOP' | 'HARD_STOP') =>
      dependencies.repository.setStop(command, mode),
    arm: async (command: ArmCommandV1 | ArmCanaryCommandV2) => {
      if (command.payloadVersion === 2) {
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
          command.evidence.walletSnapshot.observedAtMs + command.evidence.policy.walletSnapshotMaxAgeMs);
        if (effectiveExpiryMs < command.nowMs + 2 * command.runtimeLeaseMs) {
          throw new Error('CANARY_ARMAMENT_EXPIRED');
        }
        const request = createExecutionArmamentRequestV2({
          payloadVersion: 2, qualification, targetIntentId: command.evidence.targetIntentId,
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
        });
        const authorization = await authorizeCanaryArmament({
          terminal: command.terminal, nonceSource: dependencies.nonceSource, payloadVersion: 2,
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
        });
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
