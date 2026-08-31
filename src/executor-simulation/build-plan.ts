export type UnsignedBuildVenue = 'PUMP_FUN' | 'PUMP_SWAP';
export type UnsignedBuildSide = 'BUY' | 'SELL';
export type UnsignedBuildTokenProgram = 'SPL_TOKEN' | 'TOKEN_2022';

export interface NormalizedInstructionAccountV1 {
  readonly address: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface NormalizedInstructionV1 {
  readonly programId: string;
  readonly accounts: readonly NormalizedInstructionAccountV1[];
  readonly dataBase64: string;
}

export interface UnsignedBuildIdentityV1 {
  readonly mint: string;
  readonly quoteMint: string;
  readonly baseTokenProgram: UnsignedBuildTokenProgram;
  readonly quoteTokenProgram: UnsignedBuildTokenProgram;
  readonly quoteDecimals: number;
  readonly snapshotSlot: bigint;
  readonly quoteFingerprint: string;
}

export interface UnsignedBuildAmountsV1 {
  readonly amountInRaw: bigint;
  readonly expectedAmountOutRaw: bigint;
  readonly protectedAmountOutRaw: bigint;
}

export interface ExpectedBuildAccountV1 {
  readonly role: string;
  readonly address: string;
}

export interface DeterministicBuildRecipientSelectionV1 {
  readonly role: 'FEE' | 'BUYBACK_FEE';
  readonly domain: string;
  readonly listKind: 'NORMAL' | 'RESERVED' | 'BUYBACK';
  readonly candidates: readonly string[];
  readonly selectionHash: string;
  readonly selectedIndex: number;
  readonly selectedAddress: string;
}

export interface SdkRandomBuildRecipientSelectionV1 {
  readonly role: 'FEE' | 'BUYBACK_FEE';
  readonly selectionMethod: 'SDK_RANDOM';
  readonly listKind: 'NORMAL' | 'RESERVED' | 'BUYBACK';
  readonly candidates: readonly string[];
  readonly selectedIndex: number;
  readonly selectedAddress: string;
}

export type BuildRecipientSelectionV1 =
  | DeterministicBuildRecipientSelectionV1
  | SdkRandomBuildRecipientSelectionV1;

export interface UnsignedBuildPlanV1 {
  readonly payloadVersion: 1;
  readonly venue: UnsignedBuildVenue;
  readonly side: UnsignedBuildSide;
  readonly feePayer: string;
  readonly identity: UnsignedBuildIdentityV1;
  readonly amounts: UnsignedBuildAmountsV1;
  readonly expectedAccounts: readonly ExpectedBuildAccountV1[];
  readonly recipientSelections: readonly BuildRecipientSelectionV1[];
  readonly instructions: readonly NormalizedInstructionV1[];
}

export class ExecutionBuildPolicyError extends Error {
  public readonly code = 'BUILD_POLICY_REJECTED' as const;

  public constructor(venue: UnsignedBuildVenue) {
    super(venue === 'PUMP_FUN'
      ? 'Pump.fun build policy rejected.'
      : 'PumpSwap build policy rejected.');
    this.name = 'ExecutionBuildPolicyError';
  }
}
