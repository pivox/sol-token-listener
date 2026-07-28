export interface ReadonlyAccountSnapshot {
  readonly address: string;
  readonly owner: string;
  readonly data: Uint8Array;
  readonly lamports: bigint;
  readonly slot: bigint;
}

export interface MarketRpcReader {
  readAccountsAtSameSlot(
    addresses: readonly string[],
  ): Promise<readonly (ReadonlyAccountSnapshot | null)[]>;
}
