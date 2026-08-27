import {
  createProviderUsageSnapshot,
  type ProviderUsageProbe,
  type ProviderUsageSnapshot,
} from '../ports/provider-usage-probe.js';

export class UnavailableProviderUsageProbe implements ProviderUsageProbe {
  public readonly identity = 'provider-usage:unavailable:v1';

  public snapshot(): Promise<ProviderUsageSnapshot> {
    return Promise.resolve(createProviderUsageSnapshot({
      status: 'UNAVAILABLE', creditsUsedStart: null, creditsUsedEnd: null, rateLimitedCount: 0,
    }));
  }
}
