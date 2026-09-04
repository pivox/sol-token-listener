export interface LiveSignatureObservationV1 {
  readonly confirmationStatus: 'CONFIRMED' | 'FINALIZED' | 'NOT_FOUND';
  readonly observedSlot: bigint | null;
  readonly observedAtMs: number;
}

export interface LiveConfirmationGateway {
  observeSignature(
    signature: string,
    signal: AbortSignal,
  ): Promise<LiveSignatureObservationV1>;
}
