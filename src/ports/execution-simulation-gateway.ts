import type { UnsignedBuildPlanV1 } from '../executor-simulation/build-plan.js';
import type { ExecutionBuildReceiptV1 } from '../executor-simulation/build-receipt.js';
import type { ExecutionAccountSnapshot } from './execution-market-gateway.js';

export type ExecutionSimulationGatewayStage =
  | 'BUILD'
  | 'BLOCKHASH'
  | 'FEE'
  | 'SIMULATION';

export type ExecutionSimulationGatewayErrorCode =
  | 'INVALID_INPUT'
  | 'OPERATION_ABORTED'
  | 'BUILD_POLICY_REJECTED'
  | 'RPC_RATE_LIMITED'
  | 'RPC_TIMEOUT'
  | 'RPC_UNAVAILABLE'
  | 'RPC_RESPONSE_INVALID'
  | 'SIMULATION_EVIDENCE_INVALID'
  | 'SIMULATION_PROGRAM_ERROR';

export interface ExecutionSimulationGatewayLimitsV1 {
  readonly maxTransactionBytes: number;
  readonly maxComputeUnits: bigint;
  readonly maxFeeLamports: bigint;
  readonly maxFeePayerLamportDebit: bigint;
}

export interface ExecutionSimulationGatewayRequestV1 {
  readonly plan: UnsignedBuildPlanV1;
  readonly snapshot: ExecutionAccountSnapshot;
  readonly receipt: ExecutionBuildReceiptV1;
}

export interface ExecutionSimulationPartialEvidenceV1 {
  readonly snapshotFingerprint: string | null;
  readonly buildFingerprint: string | null;
  readonly messageHash: string | null;
  readonly blockhash: string | null;
  readonly lastValidBlockHeight: bigint | null;
  readonly blockhashContextSlot: bigint | null;
  readonly feeContextSlot: bigint | null;
  readonly estimatedFeeLamports: bigint | null;
  readonly simulationSlot: bigint | null;
  readonly simulatedFeePayerLamportDebit: bigint | null;
  readonly unitsConsumed: bigint | null;
  readonly simulatedBaseDeltaRaw: bigint | null;
  readonly simulatedQuoteDeltaRaw: bigint | null;
  readonly logsFingerprint: string | null;
  readonly logsLineCount: number | null;
}

export interface ExecutionSimulationEvidenceV1 {
  readonly outcome: 'SUCCESS';
  readonly snapshotFingerprint: string;
  readonly buildFingerprint: string;
  readonly messageHash: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly blockhashContextSlot: bigint;
  readonly feeContextSlot: bigint;
  readonly estimatedFeeLamports: bigint;
  readonly simulationSlot: bigint;
  readonly simulatedFeePayerLamportDebit: bigint;
  readonly unitsConsumed: bigint;
  readonly simulatedBaseDeltaRaw: bigint;
  readonly simulatedQuoteDeltaRaw: bigint;
  readonly logsFingerprint: string;
  readonly logsLineCount: number;
}

export interface ExecutionSimulationGateway {
  readonly simulate: (
    input: ExecutionSimulationGatewayRequestV1,
    signal: AbortSignal,
  ) => Promise<ExecutionSimulationEvidenceV1>;
}
