import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WALLET_FUNDING_ASSESSMENT_STATUSES,
  WALLET_FUNDING_CONFIDENCES,
  WALLET_FUNDING_EVIDENCE_TYPES,
  WALLET_FUNDING_PAYLOAD_VERSION,
  assertValidWalletFundingExtractionResult,
  createWalletFundingAssessmentId,
  createWalletFundingEvidenceId,
  type DirectQuoteTransferEvidence,
  type WalletFundingAssessment,
  type WalletFundingBuy,
  type WalletFundingExtractionResult,
} from '../src/domain/wallet-funding.js';

const cursor = Object.freeze({
  slot: 10n,
  transactionIndex: 0,
  instructionIndex: 2,
  innerInstructionIndex: null,
});
const transferCursor = Object.freeze({
  ...cursor,
  instructionIndex: 1,
});
const quoteAsset = Object.freeze({
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
  tokenProgram: 'SPL_TOKEN' as const,
});
const buy: WalletFundingBuy = Object.freeze({
  eventId: 'buy-event',
  tradeId: 'buy-trade',
  mint: 'mint',
  buyer: 'buyer',
  source: 'pumpfun',
  program: 'pump-program',
  quoteAsset,
  signature: 'signature',
  cursor,
  confirmationStatus: 'confirmed',
  blockchainTimeMs: 1_720_000_000_000,
  observedAtMs: 1_720_000_000_100,
});

void test('publishes stable wallet-funding constants and accepts a canonical frozen result', () => {
  assert.deepEqual(WALLET_FUNDING_ASSESSMENT_STATUSES, [
    'STRONG', 'MEDIUM_ONLY', 'NO_EVIDENCE', 'UNAVAILABLE',
  ]);
  assert.deepEqual(WALLET_FUNDING_EVIDENCE_TYPES, [
    'DIRECT_QUOTE_TRANSFER', 'FEE_PAYER_FOR_BUYER',
  ]);
  assert.deepEqual(WALLET_FUNDING_CONFIDENCES, ['STRONG', 'MEDIUM']);
  assert.equal(WALLET_FUNDING_PAYLOAD_VERSION, 1);

  const result = directResult();
  assert.doesNotThrow(() => { assertValidWalletFundingExtractionResult(result); });
  assert.equal(
    result.assessments[0]?.id,
    createWalletFundingAssessmentId(buy),
  );
  assert.equal(
    requiredDirectEvidence(result).id,
    createWalletFundingEvidenceId(requiredDirectEvidence(result)),
  );
});

void test('accepts medium-only and explicit no-evidence assessments without fake transfers', () => {
  const medium = feePayerResult();
  assert.doesNotThrow(() => { assertValidWalletFundingExtractionResult(medium); });
  assert.equal(medium.evidence[0]?.amountRaw, null);
  assert.equal(medium.evidence[0]?.transferCursor, null);

  const noEvidence = resultWith(
    assessmentWith({
      status: 'NO_EVIDENCE',
      inspectedTransferCount: 0,
      acceptedEvidenceCount: 0,
    }),
    [],
  );
  assert.doesNotThrow(() => { assertValidWalletFundingExtractionResult(noEvidence); });
});

void test('rejects duplicates, foreign evidence and contradictory assessment statuses', () => {
  const canonical = directResult();
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(Object.freeze({
      assessments: Object.freeze([
        requiredAssessment(canonical),
        requiredAssessment(canonical),
      ]),
      evidence: canonical.evidence,
    })); },
    /unique/u,
  );
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(resultWith(
      requiredAssessment(canonical),
      Object.freeze([
        requiredDirectEvidence(canonical),
        requiredDirectEvidence(canonical),
      ]),
    )); },
    /unique/u,
  );
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(resultWith(
      assessmentWith({ status: 'NO_EVIDENCE', acceptedEvidenceCount: 1 }),
      canonical.evidence,
    )); },
    /status|evidence|accepted/u,
  );
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(resultWith(
      requiredAssessment(canonical),
      Object.freeze([directEvidence({ buyTradeId: 'foreign-trade' })]),
    )); },
    /assessed|trade/u,
  );
});

void test('rejects self-funding, negative amounts and mismatched immutable context', () => {
  const canonical = directResult();
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(resultWith(
      requiredAssessment(canonical),
      Object.freeze([directEvidence({ funder: buy.buyer })]),
    )); },
    /different|self/u,
  );
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(resultWith(
      requiredAssessment(canonical),
      Object.freeze([directEvidence({ amountRaw: -1n })]),
    )); },
    /amount/u,
  );
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(resultWith(
      requiredAssessment(canonical),
      Object.freeze([directEvidence({ mint: 'foreign-mint' })]),
    )); },
    /mint|context/u,
  );
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(resultWith(
      requiredAssessment(canonical),
      Object.freeze([directEvidence({ signature: 'foreign-signature' })]),
    )); },
    /signature|context/u,
  );
});

void test('rejects mutable, non-canonical cursor, quote and timestamp inputs', () => {
  const canonical = directResult();
  assert.throws(
    () => { assertValidWalletFundingExtractionResult({
      assessments: canonical.assessments,
      evidence: canonical.evidence,
    }); },
    /frozen/u,
  );
  const badCursorBuy = Object.freeze({
    ...buy,
    cursor: Object.freeze({ ...cursor, transactionIndex: -1 }),
  });
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(resultWith(
      assessmentWith({}, badCursorBuy),
      [],
    )); },
    /cursor|transactionIndex/u,
  );
  const badQuoteBuy = Object.freeze({
    ...buy,
    quoteAsset: Object.freeze({ ...quoteAsset, decimals: 256 }),
  });
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(resultWith(
      assessmentWith({}, badQuoteBuy),
      [],
    )); },
    /decimals|quote/u,
  );
  const badTimeBuy = Object.freeze({ ...buy, observedAtMs: -1 });
  assert.throws(
    () => { assertValidWalletFundingExtractionResult(resultWith(
      assessmentWith({}, badTimeBuy),
      [],
    )); },
    /observedAtMs|timestamp/u,
  );
});

function directResult(): WalletFundingExtractionResult {
  return resultWith(
    assessmentWith({
      status: 'STRONG',
      inspectedTransferCount: 1,
      acceptedEvidenceCount: 1,
    }),
    Object.freeze([directEvidence()]),
  );
}

function feePayerResult(): WalletFundingExtractionResult {
  const evidence = Object.freeze({
    id: '',
    type: 'FEE_PAYER_FOR_BUYER' as const,
    confidence: 'MEDIUM' as const,
    mint: buy.mint,
    buyer: buy.buyer,
    funder: 'fee-payer',
    quoteAsset,
    amountRaw: null,
    source: buy.source,
    program: buy.program,
    signature: buy.signature,
    transferCursor: null,
    buyEventId: buy.eventId,
    buyTradeId: buy.tradeId,
    buyCursor: buy.cursor,
    confirmationStatus: buy.confirmationStatus,
    blockchainTimeMs: buy.blockchainTimeMs,
    observedAtMs: buy.observedAtMs,
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
  });
  const identified = Object.freeze({
    ...evidence,
    id: createWalletFundingEvidenceId(evidence),
  });
  return resultWith(
    assessmentWith({
      status: 'MEDIUM_ONLY',
      inspectedTransferCount: 0,
      acceptedEvidenceCount: 1,
    }),
    Object.freeze([identified]),
  );
}

function assessmentWith(
  overrides: Partial<WalletFundingAssessment>,
  targetBuy: WalletFundingBuy = buy,
): WalletFundingAssessment {
  return Object.freeze({
    id: createWalletFundingAssessmentId(targetBuy),
    buy: targetBuy,
    status: 'NO_EVIDENCE',
    inspectedTransferCount: 0,
    acceptedEvidenceCount: 0,
    ignoredTransferCount: 0,
    diagnosticCodes: Object.freeze([]),
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
    ...overrides,
  });
}

function directEvidence(
  overrides: Partial<DirectQuoteTransferEvidence> = {},
): DirectQuoteTransferEvidence {
  const evidence = Object.freeze({
    id: '',
    type: 'DIRECT_QUOTE_TRANSFER' as const,
    confidence: 'STRONG' as const,
    mint: buy.mint,
    buyer: buy.buyer,
    funder: 'funder',
    quoteAsset,
    amountRaw: 1_000_000n,
    source: buy.source,
    program: buy.program,
    signature: buy.signature,
    transferCursor,
    buyEventId: buy.eventId,
    buyTradeId: buy.tradeId,
    buyCursor: buy.cursor,
    confirmationStatus: buy.confirmationStatus,
    blockchainTimeMs: buy.blockchainTimeMs,
    observedAtMs: buy.observedAtMs,
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
    ...overrides,
  });
  return Object.freeze({
    ...evidence,
    id: overrides.id ?? createWalletFundingEvidenceId(evidence),
  });
}

function resultWith(
  assessment: WalletFundingAssessment,
  evidence: WalletFundingExtractionResult['evidence'],
): WalletFundingExtractionResult {
  return Object.freeze({
    assessments: Object.freeze([assessment]),
    evidence: Object.freeze([...evidence]),
  });
}

function requiredAssessment(
  result: WalletFundingExtractionResult,
): WalletFundingAssessment {
  const assessment = result.assessments[0];
  assert.ok(assessment);
  return assessment;
}

function requiredDirectEvidence(
  result: WalletFundingExtractionResult,
): DirectQuoteTransferEvidence {
  const evidence = result.evidence[0];
  assert.ok(evidence);
  assert.equal(evidence.type, 'DIRECT_QUOTE_TRANSFER');
  return evidence as DirectQuoteTransferEvidence;
}
