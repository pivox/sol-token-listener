import type {
  ExecutionActivationArmamentV1,
  ExecutionControlState,
  ExecutionOperatorAuthorizationV1,
} from '../domain/execution-operations.js';
import type { ExecutionSafetyQualificationV1 } from '../domain/execution-safety-qualification.js';

export interface ExecutionControlCommandV1 {
  readonly payloadVersion: 1;
  readonly commandId: string;
  readonly generationId: string;
  readonly operatorId: string;
  readonly occurredAtMs: number;
}

export interface ExecutionResumeCommandV1 extends ExecutionControlCommandV1 {
  readonly qualificationId: string;
  readonly authorization: ExecutionOperatorAuthorizationV1;
}

export interface ExecutionOperationsStatusV1 {
  readonly payloadVersion: 1;
  readonly generationId: string;
  readonly controlState: ExecutionControlState;
  readonly controlRevision: bigint;
  readonly latestQualificationId: string | null;
  readonly latestQualificationExpiresAtMs: number | null;
  readonly activeArmamentId: string | null;
  readonly activeArmamentPhase: 'CANARY' | 'MICRO_LIVE' | 'PILOT' | null;
  readonly activeArmamentExpiresAtMs: number | null;
}

export interface ExecutionOperationsRepository {
  persistQualification(
    qualification: ExecutionSafetyQualificationV1,
  ): Promise<ExecutionSafetyQualificationV1>;
  readQualification(qualificationId: string): Promise<ExecutionSafetyQualificationV1>;
  recordAuthorization(
    authorization: ExecutionOperatorAuthorizationV1,
  ): Promise<'RECORDED' | 'REPLAYED'>;
  setStop(
    command: ExecutionControlCommandV1,
    mode: 'ENTRY_STOP' | 'HARD_STOP',
  ): Promise<ExecutionOperationsStatusV1>;
  resume(command: ExecutionResumeCommandV1): Promise<ExecutionOperationsStatusV1>;
  arm(armament: ExecutionActivationArmamentV1): Promise<ExecutionActivationArmamentV1>;
  readStatus(generationId: string): Promise<ExecutionOperationsStatusV1>;
}
