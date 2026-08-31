import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import {
  computePumpFunCausalQuote,
  pumpFunQuoteAccountAddresses,
  PumpFunCausalQuoteError,
} from '../launchpads/pumpfun/causal-quote.js';
import type { MarketRpcReader } from '../ports/market-rpc-reader.js';
import {
  PaperQuoteError,
  type PaperQuoteRequest,
  type PaperQuoteRouter,
} from '../ports/paper-quote-router.js';

export class PumpFunPaperQuoteProvider implements PaperQuoteRouter {
  public constructor(
    private readonly rpc: MarketRpcReader,
    private readonly clock: () => number = Date.now,
  ) {}

  public async quote(request: PaperQuoteRequest): Promise<PaperExecutionQuote> {
    let addresses: ReturnType<typeof pumpFunQuoteAccountAddresses>;
    try {
      addresses = pumpFunQuoteAccountAddresses(request.mint);
    } catch (error) {
      throw asPaperQuoteError(error);
    }
    let accounts: Awaited<ReturnType<MarketRpcReader['readAccountsAtSameSlot']>>;
    try {
      accounts = await this.rpc.readAccountsAtSameSlot(addresses);
    } catch {
      throw new PaperQuoteError(
        'QUOTE_STATE_UNAVAILABLE',
        'Les comptes de cotation Pump.fun sont temporairement indisponibles.',
      );
    }
    try {
      return computePumpFunCausalQuote({
        request,
        addresses,
        accounts,
        observedAtMs: this.clock(),
      }).quote;
    } catch (error) {
      throw asPaperQuoteError(error);
    }
  }
}

function asPaperQuoteError(error: unknown): PaperQuoteError {
  if (error instanceof PumpFunCausalQuoteError) {
    const code = error.code === 'UNSUPPORTED_TOKEN_EXTENSION'
      ? 'QUOTE_STATE_INCONSISTENT'
      : error.code;
    return new PaperQuoteError(code, error.message);
  }
  return new PaperQuoteError(
    'QUOTE_STATE_INCONSISTENT',
    'Les comptes de cotation Pump.fun ne peuvent pas être validés.',
  );
}
