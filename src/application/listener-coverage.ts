import type { ListenerRuntimeState } from '../domain/transaction-ingestion.js';
import type { MarketCoverageState } from './market-pool-tracker.js';

export interface LaunchpadCoverage<TBootstrap> {
  scan(): Promise<TBootstrap>;
  close(): Promise<void>;
  state(): ListenerRuntimeState;
  isCoverageHealthy(): boolean;
}

export interface MarketCoverage {
  start(): Promise<void>;
  close(): Promise<void>;
  coverageState(): MarketCoverageState;
  isMintCovered(mint: string): boolean;
}

// The runtime sees a single scanner: launchpad bootstrap first (its cutover rules are unchanged),
// then the per-pool market tracker.
export class ListenerCoverage<TBootstrap> {
  private marketStartFailed = false;

  public constructor(
    private readonly launchpad: LaunchpadCoverage<TBootstrap>,
    private readonly market: MarketCoverage,
  ) {}

  public async scan(): Promise<TBootstrap> {
    const result = await this.launchpad.scan();
    // The first market cycle can take pools x 30 s: do not block the runtime on it. Until it completes the
    // tracker reports mints as uncovered (fail-closed). A rejection is contained and marks coverage degraded.
    void this.market.start().catch(() => {
      this.marketStartFailed = true;
    });
    return result;
  }

  // Both shutdowns run in parallel so a slow one never delays the other; the first failure (market
  // before launchpad) is rethrown once both have settled.
  public async close(): Promise<void> {
    const results = await Promise.allSettled([this.market.close(), this.launchpad.close()]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  public state(): ListenerRuntimeState {
    const launchpad = this.launchpad.state();
    if (launchpad !== 'RUNNING') return launchpad;
    if (this.marketStartFailed) return 'DEGRADED';
    const market = this.market.coverageState();
    if (market === 'HEALTHY') return 'RUNNING';
    return market === 'DEGRADED' ? 'DEGRADED' : 'STARTING';
  }

  public isMintCovered(mint: string): boolean {
    return !this.marketStartFailed && this.launchpad.isCoverageHealthy() && this.market.isMintCovered(mint);
  }
}
