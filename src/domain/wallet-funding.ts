import { createHash } from 'node:crypto';
import {
  assertValidChainCursor,
  compareCursors,
} from './cursor.js';
import {
  assertValidNullableTimestampMs,
  assertValidTimestampMs,
} from './timestamp.js';
import type {
  ChainConfirmationStatus,
  ChainCursor,
  QuoteAsset,
} from './types.js';

export const WALLET_FUNDING_PAYLOAD_VERSION = 1 as const;
export const WALLET_FUNDING_ASSESSMENT_STATUSES = [
  'STRONG',
  'MEDIUM_ONLY',
  'NO_EVIDENCE',
  'UNAVAILABLE',
] as const;
export const WALLET_FUNDING_EVIDENCE_TYPES = [
  'DIRECT_QUOTE_TRANSFER',
  'FEE_PAYER_FOR_BUYER',
] as const;
export const WALLET_FUNDING_CONFIDENCES = ['STRONG', 'MEDIUM'] as const;
export const WALLET_FUNDING_DIAGNOSTIC_CODES = [
  'OWNER_AMBIGUOUS',
  'TOKEN_BALANCE_UNAVAILABLE',
  'KNOWN_TRANSFER_INVALID',
  'SELF_TRANSFER_IGNORED',
] as const;

export type WalletFundingAssessmentStatus =
  (typeof WALLET_FUNDING_ASSESSMENT_STATUSES)[number];
export type WalletFundingEvidenceType =
  (typeof WALLET_FUNDING_EVIDENCE_TYPES)[number];
export type WalletFundingConfidence =
  (typeof WALLET_FUNDING_CONFIDENCES)[number];
export type WalletFundingDiagnosticCode =
  (typeof WALLET_FUNDING_DIAGNOSTIC_CODES)[number];

export interface WalletFundingBuy {
  readonly eventId: string;
  readonly tradeId: string;
  readonly mint: string;
  readonly buyer: string;
  readonly source: string;
  readonly program: string;
  readonly quoteAsset: QuoteAsset;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTimeMs: number | null;
  readonly observedAtMs: number;
}

export interface WalletFundingAssessment {
  readonly id: string;
  readonly buy: WalletFundingBuy;
  readonly status: WalletFundingAssessmentStatus;
  readonly inspectedTransferCount: number;
  readonly acceptedEvidenceCount: number;
  readonly ignoredTransferCount: number;
  readonly diagnosticCodes: readonly WalletFundingDiagnosticCode[];
  readonly payloadVersion: typeof WALLET_FUNDING_PAYLOAD_VERSION;
}

interface WalletFundingEvidenceBase {
  readonly id: string;
  readonly mint: string;
  readonly buyer: string;
  readonly funder: string;
  readonly quoteAsset: QuoteAsset;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly buyEventId: string;
  readonly buyTradeId: string;
  readonly buyCursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTimeMs: number | null;
  readonly observedAtMs: number;
  readonly payloadVersion: typeof WALLET_FUNDING_PAYLOAD_VERSION;
}

export interface DirectQuoteTransferEvidence
  extends WalletFundingEvidenceBase {
  readonly type: 'DIRECT_QUOTE_TRANSFER';
  readonly confidence: 'STRONG';
  readonly amountRaw: bigint;
  readonly transferCursor: ChainCursor;
}

export interface FeePayerEvidence extends WalletFundingEvidenceBase {
  readonly type: 'FEE_PAYER_FOR_BUYER';
  readonly confidence: 'MEDIUM';
  readonly amountRaw: null;
  readonly transferCursor: null;
}

export type WalletFundingEvidence =
  | DirectQuoteTransferEvidence
  | FeePayerEvidence;

export interface WalletFundingExtractionResult {
  readonly assessments: readonly WalletFundingAssessment[];
  readonly evidence: readonly WalletFundingEvidence[];
}

export function createWalletFundingAssessmentId(
  buy: WalletFundingBuy,
): string {
  return hashId('funding_assessment', [
    buy.source,
    buy.program,
    buy.signature,
    buy.mint,
    buy.eventId,
    buy.tradeId,
    ...cursorIdentity(buy.cursor),
  ]);
}

export function createWalletFundingEvidenceId(
  evidence: WalletFundingEvidence,
): string {
  return hashId('funding_evidence', [
    evidence.type,
    evidence.source,
    evidence.program,
    evidence.signature,
    evidence.mint,
    evidence.buyer,
    evidence.funder,
    evidence.quoteAsset.mint,
    evidence.quoteAsset.decimals,
    evidence.quoteAsset.tokenProgram,
    evidence.buyEventId,
    evidence.buyTradeId,
    ...cursorIdentity(evidence.buyCursor),
    ...(evidence.transferCursor === null
      ? ['fee-payer']
      : cursorIdentity(evidence.transferCursor)),
  ]);
}

export function assertValidWalletFundingExtractionResult(
  result: WalletFundingExtractionResult,
): void {
  assertFrozen(result, 'result');
  assertFrozen(result.assessments, 'result.assessments');
  assertFrozen(result.evidence, 'result.evidence');

  const assessmentIds = new Set<string>();
  const assessedEventIds = new Set<string>();
  const assessedTradeIds = new Set<string>();
  const assessmentByTrade = new Map<string, WalletFundingAssessment>();
  for (const assessment of result.assessments) {
    validateAssessment(assessment);
    if (
      assessmentIds.has(assessment.id)
      || assessedEventIds.has(assessment.buy.eventId)
      || assessedTradeIds.has(assessment.buy.tradeId)
    ) {
      throw new TypeError('Wallet funding assessments must be unique.');
    }
    assessmentIds.add(assessment.id);
    assessedEventIds.add(assessment.buy.eventId);
    assessedTradeIds.add(assessment.buy.tradeId);
    assessmentByTrade.set(assessment.buy.tradeId, assessment);
  }

  const evidenceIds = new Set<string>();
  const evidenceByTrade = new Map<string, WalletFundingEvidence[]>();
  for (const evidence of result.evidence) {
    validateEvidence(evidence);
    if (evidenceIds.has(evidence.id)) {
      throw new TypeError('Wallet funding evidence IDs must be unique.');
    }
    evidenceIds.add(evidence.id);
    const assessment = assessmentByTrade.get(evidence.buyTradeId);
    if (assessment === undefined) {
      throw new TypeError('Wallet funding evidence must reference an assessed trade.');
    }
    validateEvidenceContext(evidence, assessment.buy);
    const matches = evidenceByTrade.get(evidence.buyTradeId) ?? [];
    matches.push(evidence);
    evidenceByTrade.set(evidence.buyTradeId, matches);
  }

  for (const assessment of result.assessments) {
    const evidence = evidenceByTrade.get(assessment.buy.tradeId) ?? [];
    if (assessment.acceptedEvidenceCount !== evidence.length) {
      throw new TypeError('Wallet funding accepted evidence count is inconsistent.');
    }
    const strongCount = evidence.filter((item) => item.confidence === 'STRONG').length;
    const mediumCount = evidence.filter((item) => item.confidence === 'MEDIUM').length;
    const unavailable = assessment.diagnosticCodes.some(
      (code) => code !== 'SELF_TRANSFER_IGNORED',
    );
    const expectedStatus: WalletFundingAssessmentStatus = strongCount > 0
      ? 'STRONG'
      : mediumCount > 0
        ? 'MEDIUM_ONLY'
        : unavailable
          ? 'UNAVAILABLE'
          : 'NO_EVIDENCE';
    if (assessment.status !== expectedStatus) {
      throw new TypeError('Wallet funding assessment status contradicts its evidence.');
    }
  }
}

function validateAssessment(assessment: WalletFundingAssessment): void {
  assertFrozen(assessment, 'assessment');
  validateBuy(assessment.buy);
  assertText(assessment.id, 'assessment.id');
  if (assessment.id !== createWalletFundingAssessmentId(assessment.buy)) {
    throw new TypeError('Wallet funding assessment ID is not deterministic.');
  }
  if (!WALLET_FUNDING_ASSESSMENT_STATUSES.includes(assessment.status)) {
    throw new TypeError('Wallet funding assessment status is invalid.');
  }
  assertCount(assessment.inspectedTransferCount, 'assessment.inspectedTransferCount');
  assertCount(assessment.acceptedEvidenceCount, 'assessment.acceptedEvidenceCount');
  assertCount(assessment.ignoredTransferCount, 'assessment.ignoredTransferCount');
  if (assessment.ignoredTransferCount > assessment.inspectedTransferCount) {
    throw new TypeError('Ignored transfers exceed inspected transfers.');
  }
  assertFrozen(assessment.diagnosticCodes, 'assessment.diagnosticCodes');
  const diagnostics = new Set<WalletFundingDiagnosticCode>();
  for (const code of assessment.diagnosticCodes) {
    if (!WALLET_FUNDING_DIAGNOSTIC_CODES.includes(code)) {
      throw new TypeError('Wallet funding diagnostic code is invalid.');
    }
    if (diagnostics.has(code)) {
      throw new TypeError('Wallet funding diagnostic codes must be unique.');
    }
    diagnostics.add(code);
  }
  const payloadVersion: unknown = assessment.payloadVersion;
  if (payloadVersion !== WALLET_FUNDING_PAYLOAD_VERSION) {
    throw new TypeError('Wallet funding assessment payload version is invalid.');
  }
}

function validateBuy(buy: WalletFundingBuy): void {
  assertFrozen(buy, 'buy');
  for (const [field, value] of [
    ['eventId', buy.eventId],
    ['tradeId', buy.tradeId],
    ['mint', buy.mint],
    ['buyer', buy.buyer],
    ['source', buy.source],
    ['program', buy.program],
    ['signature', buy.signature],
  ] as const) assertText(value, `buy.${field}`);
  assertFrozen(buy.cursor, 'buy.cursor');
  assertValidChainCursor(buy.cursor);
  validateQuoteAsset(buy.quoteAsset);
  validateConfirmation(buy.confirmationStatus);
  assertValidNullableTimestampMs('blockchainTimeMs', buy.blockchainTimeMs);
  assertValidTimestampMs('observedAtMs', buy.observedAtMs);
}

function validateEvidence(evidence: WalletFundingEvidence): void {
  assertFrozen(evidence, 'evidence');
  for (const [field, value] of [
    ['id', evidence.id],
    ['mint', evidence.mint],
    ['buyer', evidence.buyer],
    ['funder', evidence.funder],
    ['source', evidence.source],
    ['program', evidence.program],
    ['signature', evidence.signature],
    ['buyEventId', evidence.buyEventId],
    ['buyTradeId', evidence.buyTradeId],
  ] as const) assertText(value, `evidence.${field}`);
  if (evidence.buyer === evidence.funder) {
    throw new TypeError('Wallet funding buyer and funder must be different.');
  }
  validateQuoteAsset(evidence.quoteAsset);
  assertFrozen(evidence.buyCursor, 'evidence.buyCursor');
  assertValidChainCursor(evidence.buyCursor);
  validateConfirmation(evidence.confirmationStatus);
  assertValidNullableTimestampMs('blockchainTimeMs', evidence.blockchainTimeMs);
  assertValidTimestampMs('observedAtMs', evidence.observedAtMs);
  const payloadVersion: unknown = evidence.payloadVersion;
  if (payloadVersion !== WALLET_FUNDING_PAYLOAD_VERSION) {
    throw new TypeError('Wallet funding evidence payload version is invalid.');
  }
  const evidenceType: unknown = evidence.type;
  if (
    evidenceType !== 'DIRECT_QUOTE_TRANSFER'
    && evidenceType !== 'FEE_PAYER_FOR_BUYER'
  ) {
    throw new TypeError('Wallet funding evidence type is invalid.');
  }
  if (evidenceType === 'DIRECT_QUOTE_TRANSFER') {
    const confidence: unknown = evidence.confidence;
    const amountRaw: unknown = evidence.amountRaw;
    if (confidence !== 'STRONG') {
      throw new TypeError('Direct wallet funding evidence must be strong.');
    }
    if (typeof amountRaw !== 'bigint' || amountRaw <= 0n) {
      throw new TypeError('Direct wallet funding amount must be positive.');
    }
    const direct = evidence as DirectQuoteTransferEvidence;
    assertFrozen(direct.transferCursor, 'evidence.transferCursor');
    assertValidChainCursor(direct.transferCursor);
    if (compareCursors(direct.transferCursor, evidence.buyCursor) >= 0) {
      throw new TypeError('Direct wallet funding transfer must precede its buy.');
    }
  } else {
    const confidence: unknown = evidence.confidence;
    const amountRaw: unknown = evidence.amountRaw;
    const transferCursor: unknown = evidence.transferCursor;
    if (
      confidence !== 'MEDIUM'
      || amountRaw !== null
      || transferCursor !== null
    ) {
      throw new TypeError('Fee-payer wallet funding evidence is invalid.');
    }
  }
  if (evidence.id !== createWalletFundingEvidenceId(evidence)) {
    throw new TypeError('Wallet funding evidence ID is not deterministic.');
  }
}

function validateEvidenceContext(
  evidence: WalletFundingEvidence,
  buy: WalletFundingBuy,
): void {
  if (
    evidence.mint !== buy.mint
    || evidence.buyer !== buy.buyer
    || evidence.source !== buy.source
    || evidence.program !== buy.program
    || evidence.signature !== buy.signature
    || evidence.buyEventId !== buy.eventId
    || evidence.buyTradeId !== buy.tradeId
    || compareCursors(evidence.buyCursor, buy.cursor) !== 0
    || evidence.confirmationStatus !== buy.confirmationStatus
    || evidence.blockchainTimeMs !== buy.blockchainTimeMs
    || evidence.observedAtMs !== buy.observedAtMs
    || !quoteAssetsEqual(evidence.quoteAsset, buy.quoteAsset)
  ) {
    throw new TypeError('Wallet funding evidence context does not match its buy.');
  }
}

function validateQuoteAsset(asset: QuoteAsset): void {
  assertFrozen(asset, 'quoteAsset');
  assertText(asset.mint, 'quoteAsset.mint');
  if (
    !Number.isSafeInteger(asset.decimals)
    || asset.decimals < 0
    || asset.decimals > 255
  ) {
    throw new TypeError('Wallet funding quote decimals are invalid.');
  }
  const tokenProgram: unknown = asset.tokenProgram;
  if (tokenProgram !== 'SPL_TOKEN' && tokenProgram !== 'TOKEN_2022') {
    throw new TypeError('Wallet funding quote token program is invalid.');
  }
}

function validateConfirmation(status: ChainConfirmationStatus): void {
  const runtimeStatus: unknown = status;
  if (
    runtimeStatus !== 'processed'
    && runtimeStatus !== 'confirmed'
    && runtimeStatus !== 'finalized'
    && runtimeStatus !== 'orphaned'
  ) {
    throw new TypeError('Wallet funding confirmation status is invalid.');
  }
}

function quoteAssetsEqual(left: QuoteAsset, right: QuoteAsset): boolean {
  return left.mint === right.mint
    && left.decimals === right.decimals
    && left.tokenProgram === right.tokenProgram;
}

function assertFrozen(value: object, field: string): void {
  if (!Object.isFrozen(value)) {
    throw new TypeError(`Wallet funding ${field} must be frozen.`);
  }
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Wallet funding ${field} must be non-empty text.`);
  }
}

function assertCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Wallet funding ${field} must be a non-negative safe integer.`);
  }
}

function cursorIdentity(cursor: ChainCursor): readonly (string | number)[] {
  return [
    cursor.slot.toString(),
    cursor.transactionIndex,
    cursor.instructionIndex,
    cursor.innerInstructionIndex ?? 'outer',
  ];
}

function hashId(prefix: string, values: readonly unknown[]): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}
