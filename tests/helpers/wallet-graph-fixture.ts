import {
  createWalletFundingAssessmentId,
  createWalletFundingEvidenceId,
  WALLET_FUNDING_PAYLOAD_VERSION,
  type DirectQuoteTransferEvidence,
  type FeePayerEvidence,
  type WalletFundingAssessment,
  type WalletFundingEvidence,
} from '../../src/domain/wallet-funding.js';
import type {
  WalletGraphInput,
} from '../../src/domain/wallet-graph.js';
import type {
  ObservedWalletPosition,
  ParticipantAnalyticsLaunch,
  ParticipantAnalyticsTrade,
} from '../../src/domain/participant-analytics.js';

export const CREATOR = 'creator';
export const BUYER_A = 'buyer-a';
export const BUYER_B = 'buyer-b';
export const BUYER_C = 'buyer-c';
export const SHARED_FUNDER = 'shared-funder';
export const OTHER_FUNDER = 'other-funder';
export const QUOTE_SOL = Object.freeze({
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
  tokenProgram: 'SPL_TOKEN' as const,
});
export const QUOTE_USDC = Object.freeze({
  mint: 'usdc-mint',
  decimals: 6,
  tokenProgram: 'SPL_TOKEN' as const,
});

export function graphInput(overrides: Partial<WalletGraphInput> = {}): WalletGraphInput {
  const buyA = buy('trade-a', BUYER_A, 2);
  const buyB = buy('trade-b', BUYER_B, 3);
  const evidenceA = directEvidence(buyA, SHARED_FUNDER, 100n);
  const evidenceB = directEvidence(buyB, SHARED_FUNDER, 200n);
  return Object.freeze({
    launch: launch(),
    participantInputFingerprint: 'participant-fingerprint',
    participantAsOf: null,
    participantConfirmationStatus: null,
    positions: Object.freeze([
      position(BUYER_A, 50n),
      position(BUYER_B, 25n),
      position(BUYER_C, 25n),
    ]),
    buys: Object.freeze([buyA, buyB]),
    assessments: Object.freeze([
      assessment(buyA, 'STRONG', [evidenceA]),
      assessment(buyB, 'STRONG', [evidenceB]),
    ]),
    evidence: Object.freeze([evidenceA, evidenceB]),
    inputFingerprint: 'graph-fingerprint',
    ...overrides,
  });
}

export function launch(
  overrides: Partial<ParticipantAnalyticsLaunch> = {},
): ParticipantAnalyticsLaunch {
  return Object.freeze({
    eventId: 'launch-event',
    mint: 'mint',
    creator: CREATOR,
    source: 'pumpfun',
    program: 'pump-program',
    signature: 'create-signature',
    cursor: cursor(1),
    confirmationStatus: 'confirmed',
    observedAtMs: 1_720_000_000_000,
    ...overrides,
  });
}

export function buy(
  tradeId: string,
  buyer: string,
  instructionIndex: number,
  overrides: Partial<ParticipantAnalyticsTrade> = {},
): ParticipantAnalyticsTrade {
  return Object.freeze({
    eventId: `${tradeId}-event`,
    tradeId,
    launchMint: 'mint',
    signature: `${tradeId}-signature`,
    cursor: cursor(instructionIndex),
    confirmationStatus: 'confirmed',
    observedAtMs: 1_720_000_000_000 + instructionIndex,
    kind: 'BUY',
    trader: buyer,
    baseAmountRaw: 10n,
    quoteAmountRaw: 20n,
    quoteAsset: QUOTE_SOL,
    ...overrides,
  });
}

export function position(
  wallet: string,
  observedNetBaseRaw: bigint,
  overrides: Partial<ObservedWalletPosition> = {},
): ObservedWalletPosition {
  return Object.freeze({
    wallet,
    isCreator: wallet === CREATOR,
    buyCount: 1,
    sellCount: 0,
    boughtBaseRaw: observedNetBaseRaw > 0n ? observedNetBaseRaw : 0n,
    soldBaseRaw: observedNetBaseRaw < 0n ? -observedNetBaseRaw : 0n,
    observedNetBaseRaw,
    quoteFlows: Object.freeze([]),
    firstObservedCursor: cursor(2),
    lastObservedCursor: cursor(2),
    ...overrides,
  });
}

export function assessment(
  trade: ParticipantAnalyticsTrade,
  status: WalletFundingAssessment['status'],
  evidence: readonly WalletFundingEvidence[],
  diagnostics: WalletFundingAssessment['diagnosticCodes'] = Object.freeze([]),
): WalletFundingAssessment {
  const fundingBuy = toFundingBuy(trade);
  return Object.freeze({
    id: createWalletFundingAssessmentId(fundingBuy),
    buy: fundingBuy,
    status,
    inspectedTransferCount: evidence.filter((item) =>
      item.type === 'DIRECT_QUOTE_TRANSFER').length
      + (diagnostics.length > 0 ? 1 : 0),
    acceptedEvidenceCount: evidence.length,
    ignoredTransferCount: diagnostics.length > 0 ? 1 : 0,
    diagnosticCodes: diagnostics,
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
  });
}

export function directEvidence(
  trade: ParticipantAnalyticsTrade,
  funder: string,
  amountRaw: bigint,
  overrides: Partial<DirectQuoteTransferEvidence> = {},
): DirectQuoteTransferEvidence {
  const fundingBuy = toFundingBuy(trade);
  const withoutId: DirectQuoteTransferEvidence = Object.freeze({
    id: '',
    type: 'DIRECT_QUOTE_TRANSFER',
    confidence: 'STRONG',
    mint: fundingBuy.mint,
    buyer: fundingBuy.buyer,
    funder,
    quoteAsset: fundingBuy.quoteAsset,
    amountRaw,
    source: fundingBuy.source,
    program: fundingBuy.program,
    signature: fundingBuy.signature,
    transferCursor: cursor(trade.cursor.instructionIndex - 1),
    buyEventId: fundingBuy.eventId,
    buyTradeId: fundingBuy.tradeId,
    buyCursor: fundingBuy.cursor,
    confirmationStatus: fundingBuy.confirmationStatus,
    blockchainTimeMs: fundingBuy.blockchainTimeMs,
    observedAtMs: fundingBuy.observedAtMs,
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
    ...overrides,
  });
  return Object.freeze({
    ...withoutId,
    id: overrides.id ?? createWalletFundingEvidenceId(withoutId),
  });
}

export function feeEvidence(
  trade: ParticipantAnalyticsTrade,
  funder: string,
): FeePayerEvidence {
  const fundingBuy = toFundingBuy(trade);
  const withoutId: FeePayerEvidence = Object.freeze({
    id: '',
    type: 'FEE_PAYER_FOR_BUYER',
    confidence: 'MEDIUM',
    mint: fundingBuy.mint,
    buyer: fundingBuy.buyer,
    funder,
    quoteAsset: fundingBuy.quoteAsset,
    amountRaw: null,
    source: fundingBuy.source,
    program: fundingBuy.program,
    signature: fundingBuy.signature,
    transferCursor: null,
    buyEventId: fundingBuy.eventId,
    buyTradeId: fundingBuy.tradeId,
    buyCursor: fundingBuy.cursor,
    confirmationStatus: fundingBuy.confirmationStatus,
    blockchainTimeMs: fundingBuy.blockchainTimeMs,
    observedAtMs: fundingBuy.observedAtMs,
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
  });
  return Object.freeze({
    ...withoutId,
    id: createWalletFundingEvidenceId(withoutId),
  });
}

function toFundingBuy(trade: ParticipantAnalyticsTrade) {
  if (trade.trader === null) throw new Error('Wallet graph fixture requires a buyer.');
  return Object.freeze({
    eventId: trade.eventId,
    tradeId: trade.tradeId,
    mint: trade.launchMint,
    buyer: trade.trader,
    source: 'pumpfun',
    program: 'pump-program',
    quoteAsset: trade.quoteAsset,
    signature: trade.signature,
    cursor: trade.cursor,
    confirmationStatus: trade.confirmationStatus,
    blockchainTimeMs: null,
    observedAtMs: trade.observedAtMs,
  });
}

function cursor(instructionIndex: number) {
  return Object.freeze({
    slot: 10n,
    transactionIndex: 0,
    instructionIndex,
    innerInstructionIndex: null,
  });
}
