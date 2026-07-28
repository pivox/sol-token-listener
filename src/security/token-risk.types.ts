import type {
  PoolInfo,
  TransactionSimulation,
} from '../domain/types.js';

export type RiskCheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';
export type RiskVerdict = 'ALLOW' | 'REVIEW' | 'BLOCK';

export interface RiskCheck {
  readonly code: string;
  readonly label: string;
  readonly status: RiskCheckStatus;
  readonly critical: boolean;
  readonly penalty: number;
  readonly message: string;
  readonly evidence?: Record<string, unknown> | undefined;
}

export interface HolderConcentration {
  readonly top1Bps: number | null;
  readonly top5Bps: number | null;
  readonly top10Bps: number | null;
  readonly analyzedAccounts: number;
  readonly excludedAccounts: readonly {
    readonly account: string;
    readonly reason: string;
  }[];
}

export interface RoundTripEstimate {
  readonly amountInLamports: bigint;
  readonly expectedTokenRaw: bigint;
  readonly expectedTokenTransferFeeRaw: bigint;
  readonly recoverableWsolLamports: bigint;
  readonly buyPriceImpactBps: number;
  readonly sellPriceImpactBps: number;
  readonly raydiumFeesLamports: bigint;
  readonly roundTripLossBps: number;
  readonly estimatedAtSlot: bigint;
}

export interface TokenRiskAnalysisInput {
  readonly sessionId: string;
  readonly pool: PoolInfo;
  readonly triggerSlot: bigint;
  readonly wallet: string | null;
}

export interface TokenRiskReport {
  readonly id: string;
  readonly sessionId: string;
  readonly tokenMint: string;
  readonly pool: string;
  readonly slot: bigint;
  readonly score: number;
  readonly verdict: RiskVerdict;
  readonly checks: readonly RiskCheck[];
  readonly tokenProgram: string;
  readonly extensions: readonly string[];
  readonly holderConcentration: HolderConcentration | null;
  readonly buySimulation: Pick<TransactionSimulation, 'ok' | 'error' | 'unitsConsumed' | 'logs'> | null;
  readonly roundTripEstimate: RoundTripEstimate | null;
  readonly evidence: Record<string, unknown>;
  readonly createdAtMs: number;
}

export interface TokenRiskAnalyzer {
  analyze(input: TokenRiskAnalysisInput): Promise<TokenRiskReport>;
}
