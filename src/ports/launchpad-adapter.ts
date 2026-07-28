import type {
  BondingCurveState,
  LaunchpadTrade,
  ObservedChainTransaction,
  TokenLaunch,
} from '../domain/types.js';

export interface LaunchpadAdapter<
  in TTransaction extends ObservedChainTransaction = ObservedChainTransaction,
> {
  readonly source: string;
  readonly programId: string;

  readonly detectLaunches: (transaction: TTransaction) => Promise<readonly TokenLaunch[]>;
  readonly decodeTrades: (
    transaction: TTransaction,
    trackedMints: ReadonlySet<string>,
  ) => Promise<readonly LaunchpadTrade[]>;
  readonly readBondingCurveState: (launch: TokenLaunch) => Promise<BondingCurveState>;
}
