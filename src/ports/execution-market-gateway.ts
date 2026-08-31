export interface ExecutionProviderUsage {
  readonly providerId: string;
  readonly rpcCallsUsed: number;
  readonly rpcCallsLimit: number;
}

export interface ExecutionGenesisEvidence {
  readonly providerId: string;
  readonly expectedGenesisHash: string;
  readonly observedGenesisHash: string;
}

export interface ExecutionRpcAccount {
  readonly address: string;
  readonly lamports: bigint;
  readonly owner: string;
  readonly executable: boolean;
  readonly rentEpoch: bigint | null;
  readonly space: bigint | null;
  readonly dataBase64: string;
}

export interface ExecutionAccountSnapshot {
  readonly providerId: string;
  readonly slot: bigint;
  readonly addresses: readonly string[];
  readonly accounts: readonly (ExecutionRpcAccount | null)[];
}

export interface ExecutionLatestBlockhash {
  readonly providerId: string;
  readonly contextSlot: bigint;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}

export interface ExecutionMessageFee {
  readonly providerId: string;
  readonly contextSlot: bigint;
  readonly feeLamports: bigint | null;
}

export interface ExecutionInnerInstruction {
  readonly kind: 'PARTIALLY_DECODED' | 'PARSED';
  readonly programId: string;
  readonly accounts: readonly string[] | null;
  readonly data: string | null;
  readonly stackHeight: number | null;
}

export interface ExecutionInnerInstructionGroup {
  readonly index: number;
  readonly instructions: readonly ExecutionInnerInstruction[];
}

export type ExecutionSimulationFailureKind = 'BLOCKHASH_NOT_FOUND' | 'PROGRAM_ERROR';

export interface ExecutionUnsignedSimulationRequest {
  readonly transactionBase64: string;
  readonly snapshotSlot: bigint;
  readonly accountAddresses: readonly string[];
}

export interface ExecutionUnsignedSimulationResult {
  readonly providerId: string;
  readonly contextSlot: bigint;
  readonly failureKind: ExecutionSimulationFailureKind | null;
  readonly logs: readonly string[] | null;
  readonly unitsConsumed: bigint | null;
  readonly accounts: readonly (ExecutionRpcAccount | null)[] | null;
  readonly innerInstructions: readonly ExecutionInnerInstructionGroup[] | null;
}

export interface ExecutionMarketGateway {
  readonly providerId: string;
  /** Authenticates a snapshot object emitted by this exact provider session. */
  readonly ownsAccountSnapshot: (snapshot: ExecutionAccountSnapshot) => boolean;
  readonly verifyGenesis: (signal: AbortSignal) => Promise<ExecutionGenesisEvidence>;
  readonly readAccountSnapshot: (
    addresses: readonly string[],
    signal: AbortSignal,
  ) => Promise<ExecutionAccountSnapshot>;
  readonly getLatestBlockhash: (
    snapshotSlot: bigint,
    signal: AbortSignal,
  ) => Promise<ExecutionLatestBlockhash>;
  readonly getFeeForMessage: (
    messageBase64: string,
    snapshotSlot: bigint,
    signal: AbortSignal,
  ) => Promise<ExecutionMessageFee>;
  readonly simulateUnsignedTransaction: (
    request: ExecutionUnsignedSimulationRequest,
    signal: AbortSignal,
  ) => Promise<ExecutionUnsignedSimulationResult>;
  readonly usage: () => ExecutionProviderUsage;
}
