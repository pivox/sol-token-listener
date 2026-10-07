import {
  FAST_ENTRY_MAX_CREATE_AGE_MS,
  FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW,
  decideFastEntryQuotes,
  FAST_ENTRY_SLIPPAGE_BPS,
  precheckFastEntry,
} from '../domain/fast-entry.js';
import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import type { PaperQuoteRequest } from '../ports/paper-quote-router.js';
import type {
  FastEntryLaunchContext,
  PostgresFastEntryRepository,
} from '../storage/fast-entry.repository.js';

export interface FastEntryService {
  onObserved(signature: string, mints: readonly string[]): Promise<void>;
}

export interface FastEntryDecisionEvent {
  readonly mint: string;
  readonly decision: 'BUY' | 'REJECTED';
  readonly reason: string | null;
  readonly lossBps: string | null;
  readonly durationMs: number;
}

export interface FastEntryProbeEvent {
  readonly mint: string;
  readonly outcome: 'RECORDED' | 'SKIPPED' | 'QUOTE_UNAVAILABLE';
}

export interface FastEntryServiceDependencies {
  readonly repository: Pick<
    PostgresFastEntryRepository,
    'readLaunchForSignature' | 'readActiveEnvelope' | 'recordRejection' | 'recordBuy' | 'recordProbe'
  >;
  readonly quotes: { quote(request: PaperQuoteRequest): Promise<PaperExecutionQuote> };
  readonly maximumRoundTripLossBps: bigint;
  /** Gate-10 bootstrap probe (FAST_ENTRY_PROBE_ENABLED); absent means disabled. */
  readonly probe?: Readonly<{ intervalMs: number }>;
  readonly now?: () => number;
  readonly onDecision?: (event: Readonly<FastEntryDecisionEvent>) => void;
  readonly onProbe?: (event: Readonly<FastEntryProbeEvent>) => void;
  readonly onError?: (event: Readonly<{ mint: string; errorName: string }>) => void;
}

export class DefaultFastEntryService implements FastEntryService {
  private readonly now: () => number;
  private lastProbeAttemptAtMs: number | null = null;

  public constructor(private readonly deps: FastEntryServiceDependencies) {
    this.now = deps.now ?? Date.now;
  }

  public async onObserved(signature: string, mints: readonly string[]): Promise<void> {
    for (const mint of mints) {
      try {
        await this.processMint(signature, mint);
      } catch (error) {
        try {
          this.deps.onError?.({
            mint,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        } catch {
          // A failing observer must not stop the remaining mints.
        }
      }
    }
  }

  private async processMint(signature: string, mint: string): Promise<void> {
    const { repository, quotes } = this.deps;
    const startedAtMs = this.now();
    const launch = await repository.readLaunchForSignature(mint, signature);
    if (launch === null) return;
    if (startedAtMs - launch.launchEvent.observedAtMs > FAST_ENTRY_MAX_CREATE_AGE_MS) return;

    const envelope = await repository.readActiveEnvelope(startedAtMs);
    const precheck = precheckFastEntry(launch, envelope);
    if (precheck !== null || envelope === null) {
      const reason = precheck ?? 'NO_ENVELOPE_CAPACITY';
      const recorded = await repository.recordRejection({
        launch, decidedAtMs: this.now(), reason, roundTripLossBps: null,
        buyQuote: null, reverseQuote: null, envelopeId: envelope?.envelopeId ?? null,
      });
      if (recorded === 'RECORDED') this.emit(mint, 'REJECTED', reason, null, startedAtMs);
      if (recorded === 'RECORDED' && precheck === 'NO_ENVELOPE_CAPACITY') await this.probe(launch);
      return;
    }

    let buyQuote: PaperExecutionQuote | null = null;
    let reverseQuote: PaperExecutionQuote;
    try {
      buyQuote = await quotes.quote({
        mint,
        quoteAsset: {
          mint: launch.quoteMint,
          decimals: launch.quoteDecimals,
          tokenProgram: launch.quoteTokenProgram,
        },
        side: 'BUY',
        amountInRaw: envelope.perBuyQuoteAmountRaw,
        slippageBps: FAST_ENTRY_SLIPPAGE_BPS,
      });
      reverseQuote = await quotes.quote({
        mint,
        quoteAsset: {
          mint: launch.quoteMint,
          decimals: launch.quoteDecimals,
          tokenProgram: launch.quoteTokenProgram,
        },
        side: 'SELL',
        amountInRaw: buyQuote.minimumAmountOutRaw,
        slippageBps: FAST_ENTRY_SLIPPAGE_BPS,
      });
    } catch {
      const recorded = await repository.recordRejection({
        launch, decidedAtMs: this.now(), reason: 'QUOTE_UNAVAILABLE', roundTripLossBps: null,
        buyQuote, reverseQuote: null, envelopeId: envelope.envelopeId,
      });
      if (recorded === 'RECORDED') this.emit(mint, 'REJECTED', 'QUOTE_UNAVAILABLE', null, startedAtMs);
      return;
    }

    const decision = decideFastEntryQuotes(buyQuote, reverseQuote, this.deps.maximumRoundTripLossBps);
    // Stamped after the quotes so the intent TTL starts at the decision, not before the RPCs.
    const decidedAtMs = this.now();
    if (decision.decision === 'REJECTED') {
      const recorded = await repository.recordRejection({
        launch, decidedAtMs, reason: decision.reason, roundTripLossBps: decision.lossBps,
        buyQuote, reverseQuote, envelopeId: envelope.envelopeId,
      });
      if (recorded === 'RECORDED') this.emit(mint, 'REJECTED', decision.reason, decision.lossBps, startedAtMs);
      return;
    }
    const bought = await repository.recordBuy({
      launch, decidedAtMs, envelope, buyQuote, reverseQuote, roundTripLossBps: decision.lossBps,
    });
    if (bought.kind === 'RECORDED') this.emit(mint, 'BUY', null, decision.lossBps, startedAtMs);
  }

  /** At most one attempt per interval in this process; the repository enforces it durably. */
  private async probe(launch: FastEntryLaunchContext): Promise<void> {
    const { probe, repository, quotes } = this.deps;
    if (probe === undefined) return;
    const attemptAtMs = this.now();
    if (this.lastProbeAttemptAtMs !== null && attemptAtMs - this.lastProbeAttemptAtMs < probe.intervalMs) return;
    this.lastProbeAttemptAtMs = attemptAtMs;
    let buyQuote: PaperExecutionQuote;
    try {
      buyQuote = await quotes.quote({
        mint: launch.mint,
        quoteAsset: {
          mint: launch.quoteMint,
          decimals: launch.quoteDecimals,
          tokenProgram: launch.quoteTokenProgram,
        },
        side: 'BUY',
        amountInRaw: FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW,
        slippageBps: FAST_ENTRY_SLIPPAGE_BPS,
      });
    } catch {
      this.deps.onProbe?.({ mint: launch.mint, outcome: 'QUOTE_UNAVAILABLE' });
      return;
    }
    const result = await repository.recordProbe({
      launch, decidedAtMs: this.now(), buyQuote, intervalMs: probe.intervalMs,
    });
    this.deps.onProbe?.({ mint: launch.mint, outcome: result.kind });
  }

  private emit(
    mint: string,
    decision: 'BUY' | 'REJECTED',
    reason: string | null,
    lossBps: bigint | null,
    startedAtMs: number,
  ): void {
    this.deps.onDecision?.({
      mint,
      decision,
      reason,
      lossBps: lossBps === null ? null : lossBps.toString(),
      durationMs: this.now() - startedAtMs,
    });
  }
}
