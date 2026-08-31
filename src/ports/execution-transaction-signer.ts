export interface ExecutionTransactionSigner {
  readonly publicKey: string;
  signMessage(messageBytes: Uint8Array): Promise<Readonly<{
    readonly signature: Uint8Array;
  }>>;
  close(): Promise<void>;
}
