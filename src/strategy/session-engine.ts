import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import { compareCursors } from '../domain/cursor.js';
import { hasOpenPosition, isTerminalStatus } from '../domain/session-status.js';
import type {
  EntryExecution,
  ExitExecution,
  PoolInfo,
  SwapEvent,
  TokenSession,
  TradeRecord,
} from '../domain/types.js';
import type { TradeVenue } from '../dex/trade-venue.js';
import type { TradeExecutor } from '../execution/trade-executor.js';
import type { WalletSigner } from '../execution/wallet.js';
import type { TokenRiskAnalyzer } from '../security/token-risk.types.js';
import type {
  RiskReportRepository,
  SessionRepository,
  SwapEventRepository,
  TradeRepository,
} from '../storage/repositories.js';

export class SessionEngine {
  private readonly sessions = new Map<string, TokenSession>();
  private readonly locks = new Map<string, Promise<void>>();
  private expirationTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly venue: TradeVenue,
    private readonly riskAnalyzer: TokenRiskAnalyzer,
    private readonly executor: TradeExecutor,
    private readonly wallet: WalletSigner,
    private readonly sessionsRepository: SessionRepository,
    private readonly swaps: SwapEventRepository,
    private readonly trades: TradeRepository,
    private readonly reports: RiskReportRepository,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async restore(): Promise<void> {
    const sessions = await this.sessionsRepository.loadActive();
    for (const session of sessions) this.sessions.set(session.pool.pool, session);
    for (const session of sessions) await this.withSessionLock(session.pool.pool, () => this.resumeSession(session));
    this.expirationTimer = setInterval(() => { void this.tick(); }, 15_000);
    this.expirationTimer.unref();
    this.logger.info({ restored: sessions.length }, 'Sessions actives restaurées.');
  }

  stop(): void {
    if (this.expirationTimer) clearInterval(this.expirationTimer);
    this.expirationTimer = null;
  }

  async registerPool(pool: PoolInfo): Promise<TokenSession> {
    const existing = this.sessions.get(pool.pool) ?? await this.sessionsRepository.findByPool(pool.pool);
    if (existing) {
      this.sessions.set(pool.pool, existing);
      return existing;
    }
    const now = Date.now();
    const session: TokenSession = {
      id: `raydium-cpmm:${pool.pool}`,
      pool,
      metadata: null,
      status: 'POOL_DISCOVERED',
      subsequentBuyCount: 0,
      targetBuysAfterEntry: this.config.targetBuysAfterEntry,
      countedBuyEventIds: [],
      sellAttempts: 0,
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + this.config.poolMonitorTtlMinutes * 60_000,
    };
    this.sessions.set(pool.pool, session);
    await this.sessionsRepository.save(session);
    await this.refreshPoolOpenState(session);
    return session;
  }

  async processSwap(event: SwapEvent): Promise<void> {
    const claimed = await this.swaps.claim(event);
    if (!claimed) return;
    try {
      await this.withSessionLock(event.pool, async () => {
        const session = this.sessions.get(event.pool) ?? await this.sessionsRepository.findByPool(event.pool);
        if (!session || isTerminalStatus(session.status) || event.confirmationStatus === 'ORPHANED') return;
        this.sessions.set(event.pool, session);
        if (session.lastProcessedCursor && compareCursors(event.cursor, session.lastProcessedCursor) <= 0) return;
        if (Date.now() >= session.expiresAtMs && !hasOpenPosition(session.status)) {
          await this.transition(session, 'EXPIRED', 'Durée maximale de surveillance atteinte.');
          return;
        }
        if (session.status === 'POOL_DISCOVERED' || session.status === 'WAITING_POOL_OPEN') {
          await this.refreshPoolOpenState(session);
        }
        if (session.status === 'WAITING_FIRST_BUY' && event.kind === 'BUY') {
          await this.handleFirstBuy(session, event);
          session.lastProcessedCursor = event.cursor;
          session.updatedAtMs = Date.now();
          await this.sessionsRepository.save(session);
          return;
        }
        if (session.status === 'HOLDING' && event.kind === 'BUY') {
          await this.countBuyAfterEntry(session, event);
        }
        session.lastProcessedCursor = event.cursor;
        session.updatedAtMs = Date.now();
        await this.sessionsRepository.save(session);
      });
      await this.swaps.markProcessed(event.id);
    } catch (error) {
      await this.swaps.markFailed(event.id, errorMessage(error));
      throw error;
    }
  }

  activePools(): PoolInfo[] {
    return [...this.sessions.values()]
      .filter((session) => !isTerminalStatus(session.status))
      .map((session) => session.pool);
  }

  listSessions(): TokenSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((session) => !isTerminalStatus(session.status)).length;
  }

  async manualSell(sessionId: string): Promise<TokenSession> {
    const session = [...this.sessions.values()].find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Session introuvable: ${sessionId}.`);
    await this.withSessionLock(session.pool.pool, async () => {
      if (!session.entry) throw new Error('Aucune entrée n’est enregistrée pour cette session.');
      if (!['HOLDING', 'MANUAL_REVIEW', 'SELL_PENDING'].includes(session.status)) {
        throw new Error(`Vente manuelle interdite depuis l’état ${session.status}.`);
      }
      await this.transition(session, 'SELL_PENDING', 'Vente manuelle locale demandée.');
      session.sellAttempts += 1;
      await this.sessionsRepository.save(session);
      try {
        session.exit = await this.executor.sell(session);
        await this.transition(session, 'CLOSED');
      } catch (error) {
        await this.transition(session, 'MANUAL_REVIEW', `Vente manuelle échouée: ${errorMessage(error)}`);
        throw error;
      }
    });
    return session;
  }

  async markPoolOrphaned(pool: string, reason: string): Promise<void> {
    await this.withSessionLock(pool, async () => {
      const session = this.sessions.get(pool);
      if (!session) return;
      if (hasOpenPosition(session.status)) await this.transition(session, 'MANUAL_REVIEW', `Pool orphelin après entrée: ${reason}`);
      else await this.transition(session, 'ORPHANED', reason);
    });
  }

  async markSignatureOrphaned(signature: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.firstBuy?.signature !== signature && session.entry?.signature !== signature && session.exit?.signature !== signature) continue;
      await this.withSessionLock(session.pool.pool, async () => {
        if (session.entry?.signature === signature || session.exit?.signature === signature) {
          await this.transition(session, 'MANUAL_REVIEW', `Notre transaction ${signature} n’est pas finalisée.`);
        } else if (!hasOpenPosition(session.status)) {
          await this.transition(session, 'ORPHANED', `Événement déclencheur ${signature} orphelin.`);
        } else {
          await this.transition(session, 'MANUAL_REVIEW', `Premier achat ${signature} orphelin après entrée.`);
        }
      });
    }
  }

  private async handleFirstBuy(session: TokenSession, event: SwapEvent): Promise<void> {
    session.firstBuy = event;
    await this.transition(session, 'RISK_CHECKING');
    const report = await this.riskAnalyzer.analyze({
      sessionId: session.id,
      pool: session.pool,
      triggerSlot: event.cursor.slot,
      wallet: this.wallet.address,
    });
    session.riskReportId = report.id;
    if (report.verdict === 'BLOCK') {
      await this.transition(session, 'REJECTED', `Rapport de risque ${report.score}/100: BLOCK.`);
      return;
    }
    if (report.verdict === 'REVIEW') {
      await this.transition(session, 'MANUAL_REVIEW', `Rapport de risque ${report.score}/100 à examiner.`);
      return;
    }
    const openPositions = await this.sessionsRepository.countOpenPositions();
    if (openPositions >= this.config.maxConcurrentPositions) {
      await this.transition(session, 'REJECTED', 'Limite MAX_CONCURRENT_POSITIONS atteinte.');
      return;
    }
    await this.transition(session, 'BUY_PENDING');
    try {
      session.entry = await this.executor.buy(session);
      await this.transition(session, 'HOLDING');
    } catch (error) {
      await this.transition(session, 'MANUAL_REVIEW', `Achat non exécuté: ${errorMessage(error)}`);
    }
  }

  private async countBuyAfterEntry(session: TokenSession, event: SwapEvent): Promise<void> {
    if (event.signature === session.entry?.signature || event.payer === this.wallet.address) return;
    if (session.countedBuyEventIds.includes(event.id)) return;
    session.countedBuyEventIds.push(event.id);
    session.subsequentBuyCount += 1;
    if (session.subsequentBuyCount < session.targetBuysAfterEntry) return;
    await this.transition(session, 'SELL_PENDING');
    session.sellAttempts += 1;
    await this.sessionsRepository.save(session);
    try {
      session.exit = await this.executor.sell(session);
      await this.transition(session, 'CLOSED');
    } catch (error) {
      await this.transition(session, 'MANUAL_REVIEW', `Échec de vente: ${errorMessage(error)}`);
    }
  }

  private async refreshPoolOpenState(session: TokenSession): Promise<void> {
    try {
      const runtime = await this.venue.readPoolRuntimeState(session.pool);
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (runtime.swapsEnabled && runtime.openTimeUnix <= now) await this.transition(session, 'WAITING_FIRST_BUY');
      else await this.transition(session, 'WAITING_POOL_OPEN');
    } catch (error) {
      await this.transition(session, 'WAITING_POOL_OPEN', `Pool temporairement illisible: ${errorMessage(error)}`);
    }
  }

  private async resumeSession(session: TokenSession): Promise<void> {
    if (session.status === 'POOL_DISCOVERED' || session.status === 'WAITING_POOL_OPEN') {
      await this.refreshPoolOpenState(session);
      return;
    }
    if (session.status === 'RISK_CHECKING') {
      const report = await this.reports.latestBySession(session.id);
      if (!report && session.firstBuy) {
        await this.handleFirstBuy(session, session.firstBuy);
      } else if (report?.verdict === 'ALLOW') {
        await this.transition(session, 'BUY_PENDING');
        await this.resumeBuy(session);
      } else if (report?.verdict === 'REVIEW') {
        await this.transition(session, 'MANUAL_REVIEW', 'Rapport restauré avec verdict REVIEW.');
      } else {
        await this.transition(session, 'REJECTED', 'Rapport restauré avec verdict BLOCK ou absent.');
      }
      return;
    }
    if (session.status === 'BUY_PENDING') await this.resumeBuy(session);
    if (session.status === 'SELL_PENDING') await this.resumeSell(session);
  }

  private async resumeBuy(session: TokenSession): Promise<void> {
    const trade = await this.trades.findByIdempotencyKey(`${session.id}:BUY`);
    if (trade?.status === 'SIMULATED' || trade?.status === 'CONFIRMED') {
      session.entry = entryFromTrade(trade);
      await this.transition(session, 'HOLDING');
      return;
    }
    if (trade?.status === 'FAILED') {
      await this.transition(session, 'MANUAL_REVIEW', `Achat restauré en échec: ${trade.error ?? 'cause inconnue'}.`);
      return;
    }
    try {
      session.entry = await this.executor.buy(session);
      await this.transition(session, 'HOLDING');
    } catch (error) {
      await this.transition(session, 'MANUAL_REVIEW', `Reprise achat échouée: ${errorMessage(error)}`);
    }
  }

  private async resumeSell(session: TokenSession): Promise<void> {
    const trade = await this.trades.findByIdempotencyKey(`${session.id}:SELL`);
    if (trade?.status === 'SIMULATED' || trade?.status === 'CONFIRMED') {
      session.exit = exitFromTrade(trade);
      await this.transition(session, 'CLOSED');
      return;
    }
    if (trade?.status === 'FAILED') {
      await this.transition(session, 'MANUAL_REVIEW', `Vente restaurée en échec: ${trade.error ?? 'cause inconnue'}.`);
      return;
    }
    try {
      session.exit = await this.executor.sell(session);
      await this.transition(session, 'CLOSED');
    } catch (error) {
      await this.transition(session, 'MANUAL_REVIEW', `Reprise vente échouée: ${errorMessage(error)}`);
    }
  }

  private async tick(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (isTerminalStatus(session.status) || session.status === 'MANUAL_REVIEW') continue;
      await this.withSessionLock(session.pool.pool, async () => {
        if (Date.now() >= session.expiresAtMs && !hasOpenPosition(session.status)) {
          await this.transition(session, 'EXPIRED', 'Durée maximale de surveillance atteinte.');
        } else if (session.status === 'WAITING_POOL_OPEN') {
          await this.refreshPoolOpenState(session);
        }
      });
    }
  }

  private async transition(session: TokenSession, status: TokenSession['status'], reason?: string): Promise<void> {
    session.status = status;
    session.updatedAtMs = Date.now();
    if (reason) session.rejectionReason = reason;
    this.sessions.set(session.pool.pool, session);
    await this.sessionsRepository.save(session);
    this.logger.info({ sessionId: session.id, pool: session.pool.pool, status, reason }, 'Transition de session.');
  }

  private async withSessionLock(pool: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(pool) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.locks.set(pool, next);
    try { await next; } finally { if (this.locks.get(pool) === next) this.locks.delete(pool); }
  }
}

function entryFromTrade(trade: TradeRecord): EntryExecution {
  return {
    mode: trade.mode,
    amountInLamports: trade.amountInRaw,
    amountOutTokenRaw: trade.amountOutRaw,
    quotedOutTokenRaw: trade.quotedOutRaw,
    signature: trade.signature,
    feeLamports: trade.feeLamports,
    rentDeltaLamports: trade.rentDeltaLamports,
    priorityFeeLamports: trade.priorityFeeLamports,
    computeUnits: trade.computeUnits,
    cursor: { slot: trade.slot ?? 0n, transactionIndex: -1, instructionIndex: -1, innerInstructionIndex: null },
    confirmedAtMs: trade.updatedAtMs,
    simulation: simulationFromTrade(trade),
  };
}

function exitFromTrade(trade: TradeRecord): ExitExecution {
  return {
    mode: trade.mode,
    amountInTokenRaw: trade.amountInRaw,
    amountOutLamports: trade.amountOutRaw,
    quotedOutLamports: trade.quotedOutRaw,
    signature: trade.signature,
    feeLamports: trade.feeLamports,
    rentDeltaLamports: trade.rentDeltaLamports,
    priorityFeeLamports: trade.priorityFeeLamports,
    computeUnits: trade.computeUnits,
    confirmedAtMs: trade.updatedAtMs,
    simulation: simulationFromTrade(trade),
  };
}

function simulationFromTrade(trade: TradeRecord): EntryExecution['simulation'] {
  const value = trade.payload.simulation;
  if (value && typeof value === 'object' && 'ok' in value) return value as EntryExecution['simulation'];
  return { ok: trade.status !== 'FAILED', error: trade.error ?? null, logs: [], unitsConsumed: trade.computeUnits ?? null, replacementBlockhash: null };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
