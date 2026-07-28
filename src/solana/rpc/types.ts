export type LegacyConfirmationStatus = 'PROCESSED' | 'CONFIRMED' | 'FINALIZED' | 'ORPHANED';

export interface NormalizedInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly parentInstructionIndex: number | null;
  readonly stackHeight: number | null;
}

export interface NormalizedTokenBalance {
  readonly accountIndex: number;
  readonly account: string;
  readonly mint: string;
  readonly owner: string | null;
  readonly tokenProgram: string;
  readonly amountRaw: bigint;
  readonly decimals: number;
}

export interface NormalizedTransaction {
  readonly signature: string;
  readonly slot: bigint;
  readonly transactionIndex: number;
  confirmationStatus: LegacyConfirmationStatus;
  readonly version: number | 'legacy';
  readonly blockTimeMs: number | null;
  readonly accountKeys: readonly string[];
  readonly signerKeys: readonly string[];
  readonly instructions: readonly NormalizedInstruction[];
  readonly preTokenBalances: readonly NormalizedTokenBalance[];
  readonly postTokenBalances: readonly NormalizedTokenBalance[];
  readonly preBalancesLamports: readonly bigint[];
  readonly postBalancesLamports: readonly bigint[];
  readonly feeLamports: bigint;
  readonly computeUnits: bigint | null;
  readonly logs: readonly string[];
  error: unknown;
}
