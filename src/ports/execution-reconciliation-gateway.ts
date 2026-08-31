export interface NormalizedExecutionTransactionV1 {
  readonly signature: string;
  readonly blockhash: string;
  readonly messageHash: string;
  readonly buildFingerprint: string;
  readonly snapshotFingerprint: string;
}

export interface WalletDeltaRequestV1 {
  readonly signature: string;
  readonly walletPublicKey: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly side: 'BUY' | 'SELL';
}

export interface FinalizedWalletDeltasV1 {
  readonly confirmationStatus: 'FINALIZED' | 'CONFIRMED' | 'ORPHANED' | 'NOT_FOUND';
  readonly observedSlot: bigint | null;
  readonly feeLamports: bigint;
  readonly walletLamportDelta: bigint;
  readonly baseDeltaRaw: bigint;
  readonly quoteDeltaRaw: bigint;
  readonly unexpectedResidualTokenBalanceRaw: bigint;
  readonly observedAtMs: number;
  readonly finalizedAtMs: number | null;
}

export interface ExecutionReconciliationGateway {
  readFinalizedBlockHeight(signal: AbortSignal): Promise<bigint>;
  readSignatureHistory(
    signature: string,
    signal: AbortSignal,
  ): Promise<'PRESENT' | 'ABSENT' | 'UNKNOWN'>;
  readNormalizedTransaction(
    signature: string,
    signal: AbortSignal,
  ): Promise<NormalizedExecutionTransactionV1 | null>;
  readFinalizedWalletDeltas(
    request: WalletDeltaRequestV1,
    signal: AbortSignal,
  ): Promise<FinalizedWalletDeltasV1>;
}
