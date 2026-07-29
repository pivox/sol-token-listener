import type {
  WalletFundingBuy,
  WalletFundingExtractionResult,
} from '../domain/wallet-funding.js';

export interface WalletFundingEvidenceExtractor<TTransaction> {
  extract(
    transaction: TTransaction,
    buys: readonly WalletFundingBuy[],
  ): WalletFundingExtractionResult;
}
