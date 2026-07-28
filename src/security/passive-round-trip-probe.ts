import type { PoolInfo } from '../domain/types.js';
import type { TradeVenue } from '../dex/trade-venue.js';
import type { RoundTripEstimate } from './token-risk.types.js';

export class PassiveRoundTripProbe {
  constructor(private readonly venue: TradeVenue) {}

  async estimate(
    pool: PoolInfo,
    amountInLamports: bigint,
    tokenTransferFee: (amount: bigint) => bigint,
  ): Promise<{ estimate: RoundTripEstimate; sellTradeFeeTokenRaw: bigint }> {
    const buy = await this.venue.quoteBuy(pool, amountInLamports);
    const buyTransferFee = buy.transferFeeRaw + tokenTransferFee(buy.amountOutRaw);
    const sellableTokenRaw = buy.amountOutRaw - buyTransferFee;
    if (sellableTokenRaw <= 0n) throw new Error('La quantité récupérable après achat est nulle.');

    const sell = await this.venue.quoteSell(pool, sellableTokenRaw);
    const recoverable = sell.amountOutRaw - sell.transferFeeRaw;
    const loss = recoverable >= amountInLamports
      ? 0
      : Number(((amountInLamports - recoverable) * 10_000n) / amountInLamports);
    return {
      estimate: {
        amountInLamports,
        expectedTokenRaw: buy.amountOutRaw,
        expectedTokenTransferFeeRaw: buyTransferFee,
        recoverableWsolLamports: recoverable,
        buyPriceImpactBps: buy.priceImpactBps,
        sellPriceImpactBps: sell.priceImpactBps,
        raydiumFeesLamports: buy.tradeFeeRaw,
        roundTripLossBps: loss,
        estimatedAtSlot: buy.observedSlot > sell.observedSlot ? buy.observedSlot : sell.observedSlot,
      },
      sellTradeFeeTokenRaw: sell.tradeFeeRaw,
    };
  }
}
