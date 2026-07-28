import type {
  BondingCurveState,
  LaunchpadTrade,
  ObservedChainTransaction,
  TokenLaunch,
} from '../domain/types.js';

export interface LaunchpadAdapter {
  readonly source: string;
  readonly programId: string;

  detectLaunches(transaction: ObservedChainTransaction): Promise<readonly TokenLaunch[]>;
  decodeTrades(
    transaction: ObservedChainTransaction,
    trackedMints: ReadonlySet<string>,
  ): Promise<readonly LaunchpadTrade[]>;
  readBondingCurveState(launch: TokenLaunch): Promise<BondingCurveState>;
}
