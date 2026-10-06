import bs58 from 'bs58';
import type { CatchUpWindowDiagnostic } from './catch-up-scanner.js';
import type { CheckpointProgram, ProcessingCheckpointSnapshot } from './checkpoint-rebase-operator.js';
import type { FinalizedProgramFrontier } from './program-finalized-frontier.js';

export interface CatchUpScanLimits {
  readonly pageSize: number;
  readonly maxPages: number;
}

export interface RecordedLiveEdgeCutoverPlan {
  readonly program: CheckpointProgram;
  readonly previous: ProcessingCheckpointSnapshot;
  readonly frontier: FinalizedProgramFrontier;
  readonly genesisHash: string;
  readonly scan: CatchUpWindowDiagnostic;
  readonly recordedAtMs: number;
}

export interface RecordedLiveEdgeCutoverRepository {
  inspect(program: CheckpointProgram): Promise<Readonly<{
    checkpoint: ProcessingCheckpointSnapshot | null;
    auditTableAvailable: boolean;
  }>>;
  applyRecordedLiveEdgeCutover(
    plan: RecordedLiveEdgeCutoverPlan,
  ): Promise<Readonly<{ status: 'APPLIED' | 'ALREADY_APPLIED'; evidenceId: string }>>;
}

export interface RecordedLiveEdgeCutoverRpc {
  getGenesisHash(): Promise<string>;
}

export interface RecordedLiveEdgeCutoverRequest {
  readonly program: CheckpointProgram;
  readonly previous: ProcessingCheckpointSnapshot;
  readonly frontier: FinalizedProgramFrontier;
  readonly scan: CatchUpWindowDiagnostic;
  readonly limits: CatchUpScanLimits;
  readonly expectedGenesisHash: string;
  readonly recordedAtMs: number;
}

export async function applyRecordedLiveEdgeCutover(
  request: RecordedLiveEdgeCutoverRequest,
  repository: RecordedLiveEdgeCutoverRepository,
  rpc: RecordedLiveEdgeCutoverRpc,
): Promise<string> {
  if (!isDemonstratedOutOfWindow(request.scan, request.limits)
    || request.scan.program !== request.program
    || request.frontier.program !== request.program
    || request.scan.frontierSlot !== request.frontier.slot.toString()
    || request.scan.frontierSignature !== request.frontier.signature
    || request.previous.key !== request.program
    || request.previous.signature === null
    || request.previous.slot.toString() !== request.scan.checkpointSlot
    || truncate(request.previous.signature) !== request.scan.checkpointSignature) {
    throw new RecordedLiveEdgeCutoverRefusal('WINDOW_NOT_PROVEN');
  }
  const state = await repository.inspect(request.program);
  if (!state.auditTableAvailable) throw new RecordedLiveEdgeCutoverRefusal('AUDIT_MIGRATION_REQUIRED');
  if (state.checkpoint === null || !sameCheckpoint(state.checkpoint, request.previous)) {
    throw new RecordedLiveEdgeCutoverRefusal('CHECKPOINT_CHANGED');
  }

  const genesisHash = await rpc.getGenesisHash();
  if (genesisHash !== request.expectedGenesisHash) {
    throw new RecordedLiveEdgeCutoverRefusal('GENESIS_MISMATCH');
  }
  if (!validSignature(request.frontier.signature)
    || request.frontier.slot <= request.previous.slot) {
    throw new RecordedLiveEdgeCutoverRefusal('FRONTIER_SIGNATURE_INVALID');
  }
  if (!Number.isSafeInteger(request.recordedAtMs) || request.recordedAtMs < 0) {
    throw new RecordedLiveEdgeCutoverRefusal('INVALID_TIMESTAMP');
  }
  const plan: RecordedLiveEdgeCutoverPlan = Object.freeze({
    program: request.program,
    previous: request.previous,
    frontier: request.frontier,
    genesisHash,
    scan: request.scan,
    recordedAtMs: request.recordedAtMs,
  });
  const result = await repository.applyRecordedLiveEdgeCutover(plan);
  return result.evidenceId;
}

export class RecordedLiveEdgeCutoverRefusal extends Error {
  public constructor(public readonly code:
    | 'WINDOW_NOT_PROVEN'
    | 'AUDIT_MIGRATION_REQUIRED'
    | 'CHECKPOINT_CHANGED'
    | 'GENESIS_MISMATCH'
    | 'FRONTIER_SIGNATURE_INVALID'
    | 'INVALID_TIMESTAMP') {
    super('Recorded live-edge cutover refused.');
    this.name = 'RecordedLiveEdgeCutoverRefusal';
  }
}

export function isDemonstratedOutOfWindow(
  diagnostic: CatchUpWindowDiagnostic,
  limits: CatchUpScanLimits,
): boolean {
  if (diagnostic.pageSize !== limits.pageSize || diagnostic.maxPages !== limits.maxPages
    || diagnostic.checkpointSignatureFound
    || diagnostic.checkpointSlot === null
    || diagnostic.oldestSlot === null
    || diagnostic.frontierSlot === null
    || diagnostic.frontierSignature === null
    || !positiveInteger(diagnostic.pageSize)
    || !positiveInteger(diagnostic.maxPages)
    || diagnostic.pageCount < 1
    || diagnostic.pageCount > diagnostic.maxPages) return false;

  let checkpointSlot: bigint;
  let oldestSlot: bigint;
  let frontierSlot: bigint;
  try {
    checkpointSlot = BigInt(diagnostic.checkpointSlot);
    oldestSlot = BigInt(diagnostic.oldestSlot);
    frontierSlot = BigInt(diagnostic.frontierSlot);
  } catch {
    return false;
  }
  if (checkpointSlot < 0n || oldestSlot <= checkpointSlot || frontierSlot <= checkpointSlot) return false;

  if (diagnostic.exhaustion === 'page-budget-exhausted') {
    return diagnostic.pageCount === diagnostic.maxPages
      && diagnostic.signaturesRead === diagnostic.pageSize * diagnostic.maxPages;
  }
  return diagnostic.signaturesRead < diagnostic.pageCount * diagnostic.pageSize;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validSignature(signature: string): boolean {
  try {
    return bs58.decode(signature).byteLength === 64;
  } catch {
    return false;
  }
}

function truncate(signature: string): string {
  return signature.length <= 16 ? signature : `${signature.slice(0, 8)}…${signature.slice(-8)}`;
}

function sameCheckpoint(left: ProcessingCheckpointSnapshot, right: ProcessingCheckpointSnapshot): boolean {
  return left.key === right.key && left.slot === right.slot
    && left.signature === right.signature && left.updatedAtMs === right.updatedAtMs;
}
