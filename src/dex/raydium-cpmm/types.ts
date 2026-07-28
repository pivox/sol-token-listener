import type { NormalizedInstruction } from '../../solana/rpc/types.js';

export type RaydiumCpmmInstructionKind =
  | 'INITIALIZE'
  | 'INITIALIZE_WITH_PERMISSION'
  | 'SWAP_BASE_INPUT'
  | 'SWAP_BASE_OUTPUT'
  | 'DEPOSIT'
  | 'WITHDRAW'
  | 'UNKNOWN';

export interface DecodedInitializeInstruction {
  readonly kind: 'INITIALIZE' | 'INITIALIZE_WITH_PERMISSION';
  readonly instruction: NormalizedInstruction;
  readonly payer: string;
  readonly creator: string;
  readonly config: string;
  readonly authority: string;
  readonly pool: string;
  readonly mintA: string;
  readonly mintB: string;
  readonly lpMint: string;
  readonly vaultA: string;
  readonly vaultB: string;
  readonly observation: string;
  readonly tokenProgramA: string;
  readonly tokenProgramB: string;
  readonly amountA: bigint;
  readonly amountB: bigint;
  readonly openTimeUnix: bigint;
  readonly feeOn: number | null;
}

export interface DecodedSwapInstruction {
  readonly kind: 'SWAP_BASE_INPUT' | 'SWAP_BASE_OUTPUT';
  readonly instruction: NormalizedInstruction;
  readonly payer: string;
  readonly authority: string;
  readonly config: string;
  readonly pool: string;
  readonly userInputAccount: string;
  readonly userOutputAccount: string;
  readonly inputVault: string;
  readonly outputVault: string;
  readonly inputTokenProgram: string;
  readonly outputTokenProgram: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly observation: string;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
}

export interface DecodedPoolState {
  readonly config: string;
  readonly creator: string;
  readonly vaultA: string;
  readonly vaultB: string;
  readonly lpMint: string;
  readonly mintA: string;
  readonly mintB: string;
  readonly tokenProgramA: string;
  readonly tokenProgramB: string;
  readonly observation: string;
  readonly bump: number;
  readonly status: number;
  readonly lpDecimals: number;
  readonly mintDecimalsA: number;
  readonly mintDecimalsB: number;
  readonly lpSupplyRaw: bigint;
  readonly protocolFeesA: bigint;
  readonly protocolFeesB: bigint;
  readonly fundFeesA: bigint;
  readonly fundFeesB: bigint;
  readonly openTimeUnix: bigint;
  readonly recentEpoch: bigint;
  readonly feeOn: number;
  readonly enableCreatorFee: boolean;
  readonly creatorFeesA: bigint;
  readonly creatorFeesB: bigint;
}
