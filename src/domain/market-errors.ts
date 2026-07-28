export type MarketErrorCode =
  | 'MARKET_CONFIRMATION_CONFLICT'
  | 'MARKET_EFFECTIVE_RESERVE_INVALID'
  | 'MARKET_FEE_STATE_UNAVAILABLE'
  | 'MARKET_INPUT_MINT_UNSUPPORTED'
  | 'MARKET_OBSERVATION_CONFLICT'
  | 'MARKET_POOL_NON_CANONICAL'
  | 'MARKET_POOL_MISMATCH'
  | 'MARKET_RPC_SLOT_MISMATCH'
  | 'MARKET_SELL_QUOTE_UNAVAILABLE'
  | 'UNSUPPORTED_TOKEN_EXTENSION';

export class MarketError extends Error {
  public constructor(
    public readonly code: MarketErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MarketError';
  }
}
