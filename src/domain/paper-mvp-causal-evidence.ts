import { z } from 'zod';
import { compareCursors } from './cursor.js';
import type { PaperMvpPositionSample } from './paper-mvp.js';

const text = z.string().min(1).max(512).refine((value) => value === value.trim());
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = integer.max(8_640_000_000_000_000);
const amount = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/u);
const cursor = z.object({
  slot: amount, transactionIndex: integer, instructionIndex: integer,
  innerInstructionIndex: integer.nullable(),
});
const evidenceSchema = z.object({
  schemaVersion: z.literal('paper-mvp-causal-evidence.v1'),
  positionId: text, mint: text, quoteMint: text, creator: text, sessionId: text,
  qualification: z.object({
    reportId: text, profileId: text, profileVersion: integer.positive(),
    profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), verdict: text,
    blockers: z.array(text).max(100), reasonCodes: z.array(text).max(100),
    candidateReasonCodes: z.array(text).max(100),
  }),
  buy: z.object({
    tradeId: text, quoteId: text, observedSlot: amount, quoteObservedAtMs: timestamp,
    createdAtMs: timestamp, decisionCursor: cursor,
    boundary: z.object({
      kind: z.literal('PAPER_BUY_QUOTE_SLOT'), slot: amount, quoteId: text,
      observedAtMs: timestamp,
    }).nullable(),
  }),
  externalUniqueBuyers: z.object({
    target: integer.min(1).max(1_000), count: integer.max(1_000),
    minimumQuoteAmountRaw: amount, minimumConfirmation: z.enum(['confirmed', 'finalized']),
    countedTradeIds: z.array(text).max(1_000), countedWallets: z.array(text).max(1_000),
    progression: z.array(z.object({
      count: integer.min(1).max(1_000), tradeId: text, wallet: text, sourceEventId: text,
      cursor, confirmationStatus: text, quoteAmountRaw: amount, observedAtMs: timestamp,
    })).max(1_000),
  }),
  sell: z.object({
    tradeId: text, quoteId: text, createdAtMs: timestamp,
    closeEvent: z.object({
      id: text, type: text, cursor, confirmationStatus: text, observedAtMs: timestamp,
    }),
  }),
  recovery: z.object({
    sessionState: text, pendingExitReason: text.nullable(), lastErrorCode: text.nullable(),
    // Sessions preserve their latest state, not a durable count/history of quote waits or resumes.
    quoteWaitHistory: z.literal('UNAVAILABLE'),
  }),
});

export type PaperMvpCausalEvidence = z.infer<typeof evidenceSchema>;

export function inspectPaperMvpCausalEvidence(
  value: unknown,
  sample: PaperMvpPositionSample,
  fingerprint: string,
  target: number,
): Readonly<{ evidence: PaperMvpCausalEvidence | null; coherent: boolean; targetReached: boolean }> {
  const parsed = evidenceSchema.safeParse(value);
  if (!parsed.success) return { evidence: null, coherent: false, targetReached: false };
  const evidence = parsed.data;
  const { buy, sell, qualification, externalUniqueBuyers: buyers } = evidence;
  const boundary = buy.boundary;
  const tradeIds = new Set(buyers.progression.map((item) => item.tradeId));
  const wallets = new Set(buyers.progression.map((item) => item.wallet));
  const sourceIds = new Set(buyers.progression.map((item) => item.sourceEventId));
  let coherent = evidence.positionId === sample.positionId && evidence.mint === sample.mint
    && evidence.quoteMint === sample.quoteMint
    && evidence.recovery.sessionState === 'PAPER_CLOSED'
    && qualification.profileId === 'pumpfun-mvp-technical-v1' && qualification.profileVersion === 1
    && qualification.profileFingerprint === fingerprint && qualification.verdict === 'QUALIFIED'
    && qualification.blockers.length === 0
    && qualification.candidateReasonCodes.includes('QUALIFIED_ENTRY')
    && buy.tradeId !== sell.tradeId && buy.quoteId !== sell.quoteId
    && buy.createdAtMs === sample.paperBuyAtMs && buy.quoteObservedAtMs === sample.entryQuoteAtMs
    && sell.createdAtMs === sample.paperSellAtMs
    && sell.closeEvent.type === 'PaperPositionClosed'
    && sell.closeEvent.confirmationStatus === 'finalized'
    && sell.closeEvent.observedAtMs === sample.exitTriggerAtMs
    && boundary !== null && boundary.quoteId === buy.quoteId
    && boundary.slot === buy.observedSlot && boundary.observedAtMs === buy.quoteObservedAtMs
    && BigInt(buy.decisionCursor.slot) <= BigInt(buy.observedSlot)
    && buyers.target === target && buyers.count === buyers.progression.length
    && buyers.countedTradeIds.length === buyers.count && buyers.countedWallets.length === buyers.count
    && tradeIds.size === buyers.count && wallets.size === buyers.count && sourceIds.size === buyers.count
    && new Set(buyers.countedTradeIds).size === buyers.count
    && new Set(buyers.countedWallets).size === buyers.count
    && buyers.countedTradeIds.every((id) => tradeIds.has(id))
    && buyers.countedWallets.every((wallet) => wallets.has(wallet));
  for (const [index, buyer] of buyers.progression.entries()) {
    const previous = buyers.progression[index - 1];
    coherent &&= buyer.count === index + 1 && buyer.wallet !== evidence.creator
      && buyer.tradeId !== buy.tradeId && buyer.tradeId !== sell.tradeId
      && BigInt(buyer.cursor.slot) > BigInt(buy.observedSlot)
      && (buyer.confirmationStatus === 'finalized'
        || (buyer.confirmationStatus === 'confirmed' && buyers.minimumConfirmation === 'confirmed'))
      && BigInt(buyer.quoteAmountRaw) >= BigInt(buyers.minimumQuoteAmountRaw)
      && BigInt(buyer.quoteAmountRaw) > 0n
      && buyer.observedAtMs >= sample.paperBuyAtMs && buyer.observedAtMs <= sample.exitTriggerAtMs
      && compare(buyer.cursor, sell.closeEvent.cursor) <= 0
      && (previous === undefined || compare(previous.cursor, buyer.cursor) < 0);
  }
  freezeEvidence(evidence);
  return Object.freeze({ evidence, coherent,
    targetReached: coherent && buyers.count === target });
}

function freezeEvidence(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeEvidence(child);
  Object.freeze(value);
}

function compare(left: z.infer<typeof cursor>, right: z.infer<typeof cursor>): number {
  return compareCursors({ ...left, slot: BigInt(left.slot) }, { ...right, slot: BigInt(right.slot) });
}
