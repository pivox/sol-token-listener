export type ExecutionVenueTokenProgram = 'SPL_TOKEN' | 'TOKEN_2022';

export interface ExecutionVenuePool {
  readonly migrationId: string;
  readonly migrationInstruction: 'MIGRATE' | 'MIGRATE_V2';
  readonly migrationConfirmationStatus: 'finalized';
  readonly poolAddress: string;
  readonly market: 'pumpswap';
  readonly programId: string;
  readonly poolIndex: 0;
  readonly creator: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly quoteDecimals: number;
  readonly baseTokenProgram: ExecutionVenueTokenProgram;
  readonly quoteTokenProgram: ExecutionVenueTokenProgram;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly lpMint: string;
  readonly poolConfirmationStatus: 'finalized';
  readonly activatedSlot: bigint;
  readonly transactionIndex: number;
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null;
}

export interface ExecutionVenueRepository {
  findFinalizedCanonicalPumpSwapPool(input: Readonly<{
    readonly mint: string;
    readonly quoteMint: string;
  }>): Promise<ExecutionVenuePool | null>;
}
