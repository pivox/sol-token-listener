import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { amount, configFingerprint, evaluateObservation, parseJitoBotConfig, requiredRedemptionLamports } from './config.js';
import { validateJournalState } from './journal.js';
import type { ActionKind, JitoBotConfig, JitoGateway, JournalState, JournalStore, Observation, PendingTransaction, Position, SignatureResult, TickResult, TransactionEffects } from './types.js';

export interface JitoBotEngineOptions {
  config: JitoBotConfig;
  store: JournalStore;
  gateway: JitoGateway;
  now?: () => number;
  stopRequested?: () => boolean | Promise<boolean>;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Every tick is bounded to one decision, transaction preparation, or finality check. */
export class JitoBotEngine {
  private readonly config: JitoBotConfig;
  private readonly now: () => number;
  private readonly stopped: () => boolean | Promise<boolean>;
  private ticking = false;

  constructor(private readonly options: JitoBotEngineOptions) {
    this.config = parseJitoBotConfig(options.config);
    this.now = options.now ?? Date.now;
    this.stopped = options.stopRequested ?? ((): boolean => existsSync(this.config.stopFile));
  }

  async tick(): Promise<TickResult> {
    if (!this.config.enabled) return { status: 'disabled', reason: 'bot configuration is disabled' };
    if (this.ticking) throw new Error('Concurrent engine ticks are forbidden');
    this.ticking = true;
    try { return await this.runTick(); } finally { this.ticking = false; }
  }

  private result(state: JournalState, status: TickResult['status'], reason: string): TickResult {
    return { status, reason, state: structuredClone(state) };
  }

  private async save(state: JournalState): Promise<void> {
    state.sequence += 1;
    validateJournalState(state);
    await this.options.store.save(state);
  }

  private async halt(state: JournalState, reason: string): Promise<TickResult> {
    state.status = 'halted'; state.haltReason = reason; delete state.confirmation;
    await this.save(state);
    return this.result(state, 'halted', reason);
  }

  private async runTick(): Promise<TickResult> {
    const loaded = await this.options.store.load();
    let state: JournalState;
    if (loaded) {
      state = validateJournalState(loaded);
      if (state.configFingerprint !== configFingerprint(this.config)) throw new Error('Journal configuration fingerprint does not match: explicit operator migration required');
      if (state.position && state.position.inputLamports !== this.config.inputLamports) throw new Error('Journal position amount does not match configuration');
    } else {
      state = { version: 1, configFingerprint: configFingerprint(this.config), sequence: 0, status: 'running', completedCycles: 0, totalFeesLamports: '0', realizedProfitLamports: '0', realizedLossLamports: '0', transactions: [], completedPositions: [] };
      await this.save(state);
    }
    if (state.status === 'halted') return this.result(state, 'halted', state.haltReason ?? 'operator recovery required');
    if (state.pending) return this.pending(state);
    if (!state.position && state.completedCycles >= this.config.maxCycles) return this.result(state, 'complete', 'durable cycle limit reached');
    if (amount(state.realizedLossLamports) > amount(this.config.maxRealizedLossLamports)) return this.halt(state, 'realized loss limit exceeded');
    if (await this.stopped()) return this.result(state, 'paused', 'stop file blocks transaction mutations');
    if (state.position) {
      switch (state.position.stage) {
        case 'purchased': return this.prepare(state, 'withdraw', state.position);
        case 'withdrawn': return this.prepare(state, 'deactivate', state.position);
        case 'deactivated': {
          let readiness: Awaited<ReturnType<JitoGateway['canClaim']>>;
          try { readiness = await this.options.gateway.canClaim(structuredClone(state.position)); }
          catch (error) { return this.result(state, 'waiting', `claim readiness unavailable: ${message(error)}`); }
          const now = this.now();
          if (!Number.isSafeInteger(readiness.observedAtMs) || readiness.observedAtMs > now || now - readiness.observedAtMs > this.config.maxObservationAgeMs) return this.result(state, 'waiting', 'claim readiness is stale');
          if (!readiness.inactive) return this.result(state, 'waiting', 'stake is not actually inactive');
          if (amount(readiness.claimableLamports) <= amount(state.position.stakeRentLamports)) return this.halt(state, 'inactive stake has no claimable principal');
          return this.prepare(state, 'claim', state.position);
        }
        default: return this.halt(state, 'position has no pending transaction and cannot safely advance');
      }
    }
    if (amount(this.config.maxTotalFeesLamports) - amount(state.totalFeesLamports) < amount(this.config.networkBudgetLamports)) return this.halt(state, 'explicit fee authority is insufficient for another complete cycle');
    return this.entry(state);
  }

  private async entry(state: JournalState): Promise<TickResult> {
    let observation: Observation;
    try { observation = await this.options.gateway.observe(this.config); }
    catch (error) {
      delete state.confirmation; await this.save(state);
      return this.result(state, 'waiting', `observation unavailable: ${message(error)}`);
    }
    const now = this.now();
    const decision = evaluateObservation(observation, this.config, now);
    if (!decision.eligible) {
      delete state.confirmation; await this.save(state);
      return this.result(state, 'waiting', decision.reason);
    }
    const first = state.confirmation;
    if (!first || observation.observedAtMs - first.observedAtMs > this.config.maxConfirmationGapMs || observation.observedAtMs < first.observedAtMs) {
      state.confirmation = { quoteId: observation.quote.id, observedAtMs: observation.observedAtMs, contextSlot: observation.quote.contextSlot };
      await this.save(state);
      return this.result(state, 'waiting', 'first qualifying observation recorded; wait for an independent fresh quote');
    }
    if (observation.observedAtMs - first.observedAtMs < this.config.confirmationDelayMs) return this.result(state, 'waiting', 'confirmation delay has not elapsed');
    if (observation.quote.id === first.quoteId || observation.quote.contextSlot <= first.contextSlot) return this.result(state, 'waiting', 'confirmation must use a newer quote and chain context');
    const position: Position = { id: randomUUID(), stage: 'buy-pending', openedAtMs: now, inputLamports: this.config.inputLamports, actualJitoReceivedUnits: '0', stakeRentLamports: '0', tokenAccountRentLamports: '0', feesLamports: '0', nonRefundableCostLamports: '0' };
    return this.prepare(state, 'buy', position, observation);
  }

  private assertPrepared(transaction: PendingTransaction, kind: ActionKind, position: Position, observation?: Observation): void {
    if (transaction.kind !== kind || !transaction.signature || !transaction.wireTransactionBase64 || !Number.isSafeInteger(transaction.lastValidBlockHeight) || transaction.lastValidBlockHeight <= 0) throw new Error('invalid signed transaction identity');
    const now = this.now();
    if (!Number.isSafeInteger(transaction.preparedAtMs) || transaction.preparedAtMs > now || now - transaction.preparedAtMs > this.config.maxObservationAgeMs) throw new Error('signed transaction preparation timestamp is stale');
    if (amount(transaction.estimatedFeeLamports) === 0n) throw new Error('transaction fee estimate is missing');
    if (kind === 'buy' && transaction.expected.minJitoReceivedUnits !== observation?.quote.minJitoOutUnits) throw new Error('signed buy minimum differs from decision quote');
    if (kind === 'withdraw' && (!transaction.expected.stakeAddress || transaction.expected.jitoSpentUnits !== position.actualJitoReceivedUnits)) throw new Error('withdrawal must consume the actual purchased token delta into a durable stake address');
    if (kind === 'withdraw' && amount(transaction.expected.minimumRedemptionLamports ?? '0') < requiredRedemptionLamports(this.config)) throw new Error('withdrawal minimum is below the original economic floor');
    if ((kind === 'deactivate' || kind === 'claim') && transaction.expected.stakeAddress !== position.stakeAddress) throw new Error('signed transaction targets a different stake account');
    if (kind === 'claim' && transaction.expected.refundableRentLamports !== position.stakeRentLamports) throw new Error('claim must preserve known refundable stake rent');
  }

  private async prepare(state: JournalState, kind: ActionKind, position: Position, observation?: Observation): Promise<TickResult> {
    if (await this.stopped()) return this.result(state, 'paused', 'stop file blocks transaction preparation');
    let transaction: PendingTransaction;
    try {
      transaction = await this.options.gateway.prepare({ kind, config: this.config, position: structuredClone(position), ...(observation ? { observation } : {}) });
      this.assertPrepared(transaction, kind, position, observation);
      const fee = amount(transaction.estimatedFeeLamports);
      if (amount(state.totalFeesLamports) + fee > amount(this.config.maxTotalFeesLamports)) throw new Error('transaction exceeds total fee authority');
      if (amount(position.feesLamports) + fee > amount(this.config.networkBudgetLamports)) throw new Error('transaction exceeds the cycle network budget');
    } catch (error) { return this.halt(state, `transaction preparation rejected: ${message(error)}`); }
    state.position = position;
    state.pending = structuredClone(transaction);
    if (observation) state.pending.quoteExpiresAtMs = Math.min(observation.observedAtMs, observation.quote.receivedAtMs, observation.withdrawal.checkedAtMs) + this.config.maxObservationAgeMs;
    delete state.confirmation;
    // Never call broadcast until this save has completed, including its fsync.
    await this.save(state);
    if (observation && !evaluateObservation(observation, this.config, this.now()).eligible) return this.halt(state, 'entry observation became stale or invalid during preparation; signed transaction retained and never sent');
    return this.broadcast(state);
  }

  private async broadcast(state: JournalState): Promise<TickResult> {
    const transaction = state.pending;
    if (!transaction) throw new Error('Cannot broadcast without a durable pending transaction');
    if (await this.stopped()) return this.result(state, 'paused', 'stop file blocks transaction broadcast');
    if (transaction.kind === 'buy' && (transaction.quoteExpiresAtMs === undefined || this.now() > transaction.quoteExpiresAtMs)) return this.result(state, 'pending', 'buy quote age exceeded; monitoring saved signature without further broadcast');
    transaction.broadcastAttempts = (transaction.broadcastAttempts ?? 0) + 1;
    transaction.lastBroadcastAtMs = this.now();
    delete transaction.lastBroadcastError;
    // Record attempted send first, so a crash on either side of the RPC call is ambiguous safely.
    await this.save(state);
    if (await this.stopped()) return this.result(state, 'paused', 'stop file blocks transaction broadcast');
    if (transaction.kind === 'buy' && (transaction.quoteExpiresAtMs === undefined || this.now() > transaction.quoteExpiresAtMs)) return this.result(state, 'pending', 'buy quote expired during persistence; monitoring saved signature without broadcast');
    try { await this.options.gateway.broadcast(structuredClone(transaction)); }
    catch (error) {
      transaction.lastBroadcastError = message(error);
      await this.save(state);
      return this.result(state, 'pending', 'broadcast outcome is ambiguous; retain and poll the same signature');
    }
    return this.result(state, 'pending', `${transaction.kind} submitted; awaiting finalized receipt`);
  }

  private async pending(state: JournalState): Promise<TickResult> {
    const transaction = state.pending;
    if (!transaction) throw new Error('Cannot poll without a durable pending transaction');
    let result: SignatureResult;
    try { result = await this.options.gateway.poll(structuredClone(transaction)); }
    catch (error) { return this.result(state, 'pending', `signature status unavailable; no replacement allowed: ${message(error)}`); }
    if (result.status === 'pending') return this.broadcast(state);
    if (result.status === 'unknown' || result.status === 'expired') return this.halt(state, `${result.status} transaction finality: ${result.reason}; operator recovery required`);
    return this.finalized(state, transaction, result);
  }

  private validateEffects(effects: TransactionEffects): void {
    amount(effects.feeLamports);
    for (const key of ['actualInputLamports', 'actualJitoReceivedUnits', 'actualJitoSpentUnits', 'actualClaimedLamports', 'refundableRentLamports', 'nonRefundableCostLamports'] as const) {
      const value = effects[key]; if (value !== undefined) amount(value);
    }
  }

  private async finalized(state: JournalState, transaction: PendingTransaction, result: Extract<SignatureResult, { status: 'finalized' | 'failed' }>): Promise<TickResult> {
    try { this.validateEffects(result.effects); }
    catch (error) { return this.halt(state, `finalized receipt cannot be accounted: ${message(error)}; retain pending signature for operator`); }
    const position = state.position;
    if (!position) return this.halt(state, 'finalized transaction has no durable position');
    const effects = result.effects;
    state.totalFeesLamports = (amount(state.totalFeesLamports) + amount(effects.feeLamports)).toString();
    position.feesLamports = (amount(position.feesLamports) + amount(effects.feeLamports)).toString();
    position.nonRefundableCostLamports = (amount(position.nonRefundableCostLamports) + amount(effects.nonRefundableCostLamports ?? '0')).toString();
    state.transactions.push({ positionId: position.id, transaction, outcome: result.status, effects, recordedAtMs: this.now() });
    delete state.pending;
    if (result.status === 'failed') return this.halt(state, `finalized ${transaction.kind} failed: ${result.error}; actual fee recorded`);
    try { this.applyEffects(state, position, transaction, effects); }
    catch (error) { return this.halt(state, `finalized ${transaction.kind} effects mismatch: ${message(error)}; receipt and actual fee recorded`); }
    if (amount(state.totalFeesLamports) > amount(this.config.maxTotalFeesLamports) || amount(position.feesLamports) > amount(this.config.networkBudgetLamports)) return this.halt(state, 'actual finalized fees exceeded the authorized budget');
    if (amount(state.realizedLossLamports) > amount(this.config.maxRealizedLossLamports)) return this.halt(state, 'realized loss limit exceeded');
    await this.save(state);
    if (!state.position && state.completedCycles >= this.config.maxCycles) return this.result(state, 'complete', 'claim finalized and durable cycle limit reached');
    return this.result(state, 'progress', `${transaction.kind} finalized and accounted`);
  }

  private applyEffects(state: JournalState, position: Position, transaction: PendingTransaction, effects: TransactionEffects): void {
    switch (transaction.kind) {
      case 'buy': {
        if (position.stage !== 'buy-pending' || effects.actualInputLamports !== position.inputLamports) throw new Error('actual SOL input differs from authorized input');
        const received = amount(effects.actualJitoReceivedUnits ?? '0');
        position.actualJitoReceivedUnits = received.toString();
        position.tokenAccountRentLamports = effects.refundableRentLamports ?? '0';
        if (received < amount(transaction.expected.minJitoReceivedUnits ?? '0') || received === 0n) throw new Error('actual Jito delta is below signed minimum');
        position.stage = 'purchased';
        break;
      }
      case 'withdraw': {
        if (position.stage !== 'purchased' || effects.actualJitoSpentUnits !== position.actualJitoReceivedUnits || effects.stakeAddress !== transaction.expected.stakeAddress) throw new Error('actual withdrawal token delta or stake address differs from signed intent');
        if (!effects.stakeAddress || !effects.refundableRentLamports) throw new Error('withdrawal receipt lacks stake address or funded rent');
        position.stakeAddress = effects.stakeAddress;
        position.stakeRentLamports = effects.refundableRentLamports;
        position.stage = 'withdrawn';
        break;
      }
      case 'deactivate': {
        if (position.stage !== 'withdrawn' || effects.stakeAddress !== position.stakeAddress) throw new Error('deactivation targets a different stake account');
        position.stage = 'deactivated';
        break;
      }
      case 'claim': {
        if (position.stage !== 'deactivated' || effects.stakeAddress !== position.stakeAddress || effects.actualClaimedLamports === undefined || effects.refundableRentLamports !== position.stakeRentLamports) throw new Error('claim receipt lacks verified principal and refundable rent');
        const claimed = amount(effects.actualClaimedLamports);
        if (claimed < amount(position.stakeRentLamports)) throw new Error('claim is less than refundable stake rent');
        const profit = claimed - amount(position.stakeRentLamports) - amount(position.inputLamports) - amount(position.feesLamports) - amount(position.nonRefundableCostLamports);
        position.actualClaimedLamports = claimed.toString();
        position.realizedProfitLamports = profit.toString();
        position.completedAtMs = this.now(); position.stage = 'complete';
        state.realizedProfitLamports = (BigInt(state.realizedProfitLamports) + profit).toString();
        if (profit < 0n) state.realizedLossLamports = (amount(state.realizedLossLamports) - profit).toString();
        state.completedCycles += 1; state.completedPositions.push(position); delete state.position;
        break;
      }
    }
  }
}
