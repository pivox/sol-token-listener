export interface ExecutionSignedSimulationRequestV1 {
  readonly payloadVersion: 1;
  readonly transactionBase64: string;
  readonly snapshotSlot: bigint;
  readonly accountAddresses: readonly [string, string, string];
  readonly commitment: 'confirmed';
  readonly sigVerify: true;
  readonly replaceRecentBlockhash: false;
}

export interface ExecutionSignedSimulationResultV1 {
  readonly payloadVersion: 1;
  readonly providerId: string;
  readonly contextSlot: bigint;
  readonly failureKind: 'PROGRAM_ERROR' | 'BLOCKHASH_NOT_FOUND' | null;
  readonly unitsConsumed: bigint;
  readonly feePayerLamportDebit: bigint;
  readonly baseDeltaRaw: bigint;
  readonly quoteDeltaRaw: bigint;
  readonly logsFingerprint: string;
  readonly logsLineCount: number;
}

export interface ExecutionLiveGateway {
  readonly simulateSignedTransaction: (
    request: ExecutionSignedSimulationRequestV1,
    signal: AbortSignal,
  ) => Promise<ExecutionSignedSimulationResultV1>;
}
