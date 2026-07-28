import type {
  BondingCurveState,
  LaunchpadTrade,
  ObservedChainTransaction,
  TokenLaunch,
} from '../domain/types.js';

export interface LaunchpadAdapter<
  TTransaction extends ObservedChainTransaction = ObservedChainTransaction,
> {
  readonly source: string;
  readonly programId: string;

  detectLaunches(transaction: TTransaction): Promise<readonly TokenLaunch[]>;
  decodeTrades(
    transaction: TTransaction,
    trackedMints: ReadonlySet<string>,
  ): Promise<readonly LaunchpadTrade[]>;
  readBondingCurveState(launch: TokenLaunch): Promise<BondingCurveState>;
}
