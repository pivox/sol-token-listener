import bs58 from 'bs58';

export type CheckpointProgram = 'launchpad' | 'market';
export type CheckpointRebaseReason = 'invalid-future-checkpoint' | 'operator-approved-live-edge-cutover';

export interface ProcessingCheckpointSnapshot {
  readonly key: CheckpointProgram;
  readonly source: string;
  readonly program: string;
  readonly slot: bigint;
  readonly signature: string | null;
  readonly transactionIndex: number | null;
  readonly payload: unknown;
  readonly updatedAtMs: number;
}

export interface FinalizedProgramSignature {
  readonly signature: string;
  readonly slot: bigint;
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
}

export interface CheckpointRebaseGap {
  readonly program: CheckpointProgram;
  readonly previousSlot: bigint;
  readonly previousSignature: string | null;
  readonly newSlot: bigint;
  readonly newSignature: string;
  readonly finalizedHeadSlot: bigint;
  readonly genesisHash: string;
  readonly reason: CheckpointRebaseReason;
  readonly recordedAtMs: number;
}

export interface CheckpointRebasePlan {
  readonly previous: ProcessingCheckpointSnapshot;
  readonly next: FinalizedProgramSignature;
  readonly finalizedHeadSlot: bigint;
  readonly genesisHash: string;
  readonly reason: CheckpointRebaseReason;
  readonly recordedAtMs: number;
}

export interface CheckpointRebaseState {
  readonly checkpoint: ProcessingCheckpointSnapshot | null;
  readonly latestGap: CheckpointRebaseGap | null;
  readonly auditTableAvailable: boolean;
}

export interface CheckpointRebaseRepository {
  inspect(program: CheckpointProgram): Promise<CheckpointRebaseState>;
  apply(plan: CheckpointRebasePlan): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
}

export interface CheckpointRebaseRpc {
  getGenesisHash(): Promise<string>;
  getFinalizedHead(): Promise<bigint>;
  getLatestFinalizedSignature(program: CheckpointProgram): Promise<FinalizedProgramSignature>;
}

export type CheckpointRebaseRefusalCode =
  | 'INVALID_REASON'
  | 'GENESIS_MISMATCH'
  | 'CHECKPOINT_MISSING'
  | 'CHECKPOINT_SIGNATURE_MISSING'
  | 'CHECKPOINT_NOT_ABOVE_FINALIZED_HEAD'
  | 'SIGNATURE_NOT_FINALIZED'
  | 'REBASE_SIGNATURE_ABOVE_FINALIZED_HEAD'
  | 'INVALID_SIGNATURE'
  | 'AUDIT_MIGRATION_REQUIRED';

export class CheckpointRebaseRefusal extends Error {
  public constructor(public readonly code: CheckpointRebaseRefusalCode) {
    super('Checkpoint rebase refused.');
    this.name = 'CheckpointRebaseRefusal';
  }
}

export class CheckpointRebaseOperator {
  public constructor(
    private readonly repository: CheckpointRebaseRepository,
    private readonly rpc: CheckpointRebaseRpc,
    private readonly now: () => number = Date.now,
  ) {}

  public async execute(
    program: CheckpointProgram,
    reason: string,
    confirmed: boolean,
    expectedGenesisHash: string,
  ): Promise<
    | { readonly status: 'DRY_RUN'; readonly plan: CheckpointRebasePlan }
    | { readonly status: 'APPLIED'; readonly plan: CheckpointRebasePlan }
    | { readonly status: 'ALREADY_APPLIED'; readonly checkpoint: ProcessingCheckpointSnapshot }
  > {
  if (reason !== 'invalid-future-checkpoint') {
      throw new CheckpointRebaseRefusal('INVALID_REASON');
    }
    const state = await this.repository.inspect(program);
    const checkpoint = state.checkpoint;
    if (checkpoint === null) throw new CheckpointRebaseRefusal('CHECKPOINT_MISSING');

    const genesisHash = await this.rpc.getGenesisHash();
    if (genesisHash !== expectedGenesisHash) throw new CheckpointRebaseRefusal('GENESIS_MISMATCH');
    const initialFinalizedHeadSlot = await this.rpc.getFinalizedHead();

    if (checkpoint.slot <= initialFinalizedHeadSlot) {
      const previousGap = state.latestGap;
      if (previousGap !== null
        && previousGap.program === program
        && previousGap.newSlot === checkpoint.slot
        && previousGap.newSignature === checkpoint.signature) {
        return Object.freeze({ status: 'ALREADY_APPLIED', checkpoint });
      }
      throw new CheckpointRebaseRefusal('CHECKPOINT_NOT_ABOVE_FINALIZED_HEAD');
    }
    if (checkpoint.signature === null) {
      throw new CheckpointRebaseRefusal('CHECKPOINT_SIGNATURE_MISSING');
    }

    const next = await this.rpc.getLatestFinalizedSignature(program);
    if (next.confirmationStatus !== 'finalized') {
      throw new CheckpointRebaseRefusal('SIGNATURE_NOT_FINALIZED');
    }
    // The program's latest signature can advance between getSlot and
    // getSignaturesForAddress. Sample the head again so the stored checkpoint
    // and the signature are evaluated against a consistent recent boundary.
    const finalizedHeadSlot = await this.rpc.getFinalizedHead();
    if (checkpoint.slot <= finalizedHeadSlot) {
      throw new CheckpointRebaseRefusal('CHECKPOINT_NOT_ABOVE_FINALIZED_HEAD');
    }
    if (next.slot > finalizedHeadSlot) {
      throw new CheckpointRebaseRefusal('REBASE_SIGNATURE_ABOVE_FINALIZED_HEAD');
    }
    if (!validSignature(next.signature)) throw new CheckpointRebaseRefusal('INVALID_SIGNATURE');

    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new TypeError('Checkpoint rebase clock is invalid.');
    }
    const plan: CheckpointRebasePlan = Object.freeze({
      previous: checkpoint,
      next,
      finalizedHeadSlot,
      genesisHash,
      reason,
      recordedAtMs: timestamp,
    });
    if (!confirmed) return Object.freeze({ status: 'DRY_RUN', plan });
    if (!state.auditTableAvailable) throw new CheckpointRebaseRefusal('AUDIT_MIGRATION_REQUIRED');
    const result = await this.repository.apply(plan);
    if (result === 'ALREADY_APPLIED') {
      const applied = await this.repository.inspect(program);
      if (applied.checkpoint === null) throw new CheckpointRebaseRefusal('CHECKPOINT_MISSING');
      return Object.freeze({ status: result, checkpoint: applied.checkpoint });
    }
    return Object.freeze({ status: result, plan });
  }
}

function validSignature(value: string): boolean {
  try {
    return bs58.decode(value).byteLength === 64;
  } catch {
    return false;
  }
}
