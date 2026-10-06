export const BALANCE_CACHE_TTL_MS = 15_000;

export interface BalanceObservation {
  readonly lamports: bigint;
  readonly observedAtMs: number;
}

export interface BalanceCache {
  readonly read: (wallet: string) => Promise<BalanceObservation | null>;
}

export interface BalanceCacheOptions {
  readonly fetchLamports: (wallet: string) => Promise<bigint>;
  readonly now: () => number;
  readonly ttlMs?: number;
}

/**
 * Serves one wallet balance from memory for `ttlMs`, shares a single in-flight RPC between
 * concurrent readers, and falls back to the last known observation (or null) when the RPC
 * fails.
 */
export function createBalanceCache(options: BalanceCacheOptions): BalanceCache {
  const ttlMs = options.ttlMs ?? BALANCE_CACHE_TTL_MS;
  let last: { readonly wallet: string; readonly observation: BalanceObservation } | null = null;
  let inFlight: { readonly wallet: string; readonly promise: Promise<BalanceObservation | null> } | null = null;

  async function refresh(wallet: string): Promise<BalanceObservation | null> {
    try {
      const lamports = await options.fetchLamports(wallet);
      const observation = Object.freeze({ lamports, observedAtMs: options.now() });
      last = { wallet, observation };
      return observation;
    } catch {
      return last?.wallet === wallet ? last.observation : null;
    } finally {
      inFlight = null;
    }
  }

  return Object.freeze({
    read: (wallet: string): Promise<BalanceObservation | null> => {
      if (last?.wallet === wallet && options.now() - last.observation.observedAtMs < ttlMs) {
        return Promise.resolve(last.observation);
      }
      if (inFlight?.wallet === wallet) return inFlight.promise;
      const promise = refresh(wallet);
      inFlight = { wallet, promise };
      return promise;
    },
  });
}
