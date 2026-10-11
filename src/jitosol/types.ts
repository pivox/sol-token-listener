/** Amounts are decimal integer strings at every persistence and gateway boundary. */
export type Amount = string;
export type ActionKind = 'buy' | 'withdraw' | 'deactivate' | 'claim';

export interface JitoBotConfig {
  version: 1;
  enabled: boolean;
  walletAddress: string;
  stakePoolAddress: string;
  jitoMintAddress: string;
  inputLamports: Amount;
  minProfitLamports: Amount;
  networkBudgetLamports: Amount;
  reserveLamports: Amount;
  carryAnnualBps: number;
  carryHours: number;
  confirmationDelayMs: number;
  maxConfirmationGapMs: number;
  maxObservationAgeMs: number;
  maxSourceSlotLag: number;
  maxPoolQuoteSlotGap: number;
  maxCycles: number;
  maxTotalFeesLamports: Amount;
  maxRealizedLossLamports: Amount;
  stopFile: string;
}

export interface Observation {
  observedAtMs: number;
  quote: {
    id: string;
    receivedAtMs: number;
    contextSlot: number;
    routeSlot: number;
    inputMint: string;
    outputMint: string;
    inputLamports: Amount;
    minJitoOutUnits: Amount;
    /** Opaque provider quote is only used to build the entry from this observation. */
    raw: unknown;
  };
  pool: {
    address: string;
    mint: string;
    contextSlot: number;
    currentEpoch: number;
    lastUpdateEpoch: number;
    totalLamports: Amount;
    tokenSupply: Amount;
    withdrawalFeeNumerator: Amount;
    withdrawalFeeDenominator: Amount;
  };
  withdrawal: {
    available: boolean;
    checkedAtMs: number;
    minimumDelegationLamports: Amount;
    stakeRentLamports: Amount;
    tokenAccountRentLamports: Amount;
    sourceStakeAddress?: string;
    reason?: string;
  };
  wallet: { address: string; solLamports: Amount; jitoUnits: Amount };
}

export interface PendingTransaction {
  kind: ActionKind;
  signature: string;
  wireTransactionBase64: string;
  lastValidBlockHeight: number;
  preparedAtMs: number;
  /** Entry decision deadline set by the engine from the original observation timestamps. */
  quoteExpiresAtMs?: number;
  estimatedFeeLamports: Amount;
  expected: {
    stakeAddress?: string;
    minJitoReceivedUnits?: Amount;
    jitoSpentUnits?: Amount;
    refundableRentLamports?: Amount;
    /** Encoded minimum SOL principal from the guarded pool withdrawal, excluding funded rent. */
    minimumRedemptionLamports?: Amount;
  };
  broadcastAttempts?: number;
  lastBroadcastAtMs?: number;
  lastBroadcastError?: string;
}

export interface TransactionEffects {
  feeLamports: Amount;
  actualInputLamports?: Amount;
  actualJitoReceivedUnits?: Amount;
  actualJitoSpentUnits?: Amount;
  stakeAddress?: string;
  /** Claim balance including any separately funded rent returned by the stake account. */
  actualClaimedLamports?: Amount;
  /** Newly funded refundable rent, or rent returned by a claim. Excluded from profit/loss. */
  refundableRentLamports?: Amount;
  nonRefundableCostLamports?: Amount;
}

export type SignatureResult =
  | { status: 'pending' }
  | { status: 'finalized'; effects: TransactionEffects }
  | { status: 'failed'; effects: TransactionEffects; error: string }
  | { status: 'expired'; reason: string }
  | { status: 'unknown'; reason: string };

export interface Position {
  id: string;
  stage: 'buy-pending' | 'purchased' | 'withdrawn' | 'deactivated' | 'complete';
  openedAtMs: number;
  inputLamports: Amount;
  actualJitoReceivedUnits: Amount;
  stakeAddress?: string;
  stakeRentLamports: Amount;
  tokenAccountRentLamports: Amount;
  feesLamports: Amount;
  nonRefundableCostLamports: Amount;
  actualClaimedLamports?: Amount;
  realizedProfitLamports?: Amount;
  completedAtMs?: number;
}

export interface JournalState {
  version: 1;
  configFingerprint: string;
  sequence: number;
  status: 'running' | 'halted';
  haltReason?: string;
  completedCycles: number;
  totalFeesLamports: Amount;
  realizedProfitLamports: Amount;
  realizedLossLamports: Amount;
  confirmation?: { quoteId: string; observedAtMs: number; contextSlot: number };
  position?: Position;
  pending?: PendingTransaction;
  transactions: {
    positionId: string;
    transaction: PendingTransaction;
    outcome: 'finalized' | 'failed';
    effects: TransactionEffects;
    recordedAtMs: number;
  }[];
  completedPositions: Position[];
}

export interface JournalStore {
  load(): Promise<JournalState | null>;
  save(state: JournalState): Promise<void>;
}

export interface JitoGateway {
  observe(config: JitoBotConfig): Promise<Observation>;
  /** Build, simulate and sign only. MUST NOT broadcast here. */
  prepare(request: {
    kind: ActionKind;
    config: JitoBotConfig;
    position: Position;
    observation?: Observation;
  }): Promise<PendingTransaction>;
  /** Send exactly the durable bytes, without rebuilding or changing signatures. */
  broadcast(transaction: PendingTransaction): Promise<void>;
  /** Only finalized receipts may report success; unknown/expired requires operator recovery. */
  poll(transaction: PendingTransaction): Promise<SignatureResult>;
  canClaim(position: Position): Promise<{
    inactive: boolean;
    observedAtMs: number;
    claimableLamports: Amount;
  }>;
}

export interface TickResult {
  status: 'disabled' | 'waiting' | 'pending' | 'progress' | 'complete' | 'paused' | 'halted';
  reason: string;
  state?: JournalState;
}
