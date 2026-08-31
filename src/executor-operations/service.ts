import {
  createExecutionArmament,
  type ExecutionActivationArmamentV1,
} from '../domain/execution-operations.js';
import type { ExecutionSafetyQualificationV1 } from '../domain/execution-safety-qualification.js';
import type {
  ExecutionControlCommandV1,
  ExecutionOperationsRepository,
  ExecutionOperationsStatusV1,
} from '../ports/execution-operations-repository.js';
import {
  authorizeOperatorAction,
  type OperatorTerminal,
} from './terminal.js';

interface ServiceDependencies {
  readonly repository: ExecutionOperationsRepository;
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

export interface ExecutionOperationsService {
  readonly preflight: (
    qualification: ExecutionSafetyQualificationV1,
  ) => Promise<ExecutionSafetyQualificationV1>;
  readonly status: (generationId: string) => Promise<ExecutionOperationsStatusV1>;
  readonly stop: (
    command: ExecutionControlCommandV1,
    mode: 'ENTRY_STOP' | 'HARD_STOP',
  ) => Promise<ExecutionOperationsStatusV1>;
  readonly arm: (command: ArmCommandV1) => Promise<ExecutionActivationArmamentV1>;
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
    arm: async (command: ArmCommandV1) => {
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
