import { PublicKey, type Connection } from '@solana/web3.js';
import type { AppConfig } from '../config/env.js';
import type { PoolInfo, TokenExtensionInfo, TokenMetadata } from '../domain/types.js';
import type { TradeVenue } from '../dex/trade-venue.js';
import type { TransactionSimulator } from '../execution/transaction-simulator.js';
import { RAYDIUM_BURN_AND_EARN_AUTHORITY, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../dex/raydium-cpmm/constants.js';
import { MintReader } from '../solana/token/mint-reader.js';
import type { RiskReportRepository } from '../storage/repositories.js';
import { evaluateRisk } from './risk-evaluator.js';
import { PassiveRoundTripProbe } from './passive-round-trip-probe.js';
import type {
  HolderConcentration,
  RiskCheck,
  TokenRiskAnalysisInput,
  TokenRiskAnalyzer,
  TokenRiskReport,
} from './token-risk.types.js';

const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

export class TokenRiskService implements TokenRiskAnalyzer {
  private readonly mintReader: MintReader;
  private readonly roundTrip: PassiveRoundTripProbe;

  constructor(
    private readonly connection: Connection,
    private readonly venue: TradeVenue,
    private readonly simulator: TransactionSimulator,
    private readonly reports: RiskReportRepository,
    private readonly config: AppConfig,
  ) {
    this.mintReader = new MintReader(connection);
    this.roundTrip = new PassiveRoundTripProbe(venue);
  }

  async analyze(input: TokenRiskAnalysisInput): Promise<TokenRiskReport> {
    const checks: RiskCheck[] = [];
    const evidence: Record<string, unknown> = {};
    let metadata: TokenMetadata | null = null;
    let slot = input.triggerSlot;
    try {
      const mint = await this.mintReader.read(input.pool.tokenMint);
      metadata = mint.metadata;
      slot = mint.slot > slot ? mint.slot : slot;
      checks.push(checkMintAccount(metadata, mint.initialized));
      checks.push(checkMintAuthority(metadata));
      checks.push(checkFreezeAuthority(metadata));
      evidence.mint = metadata;
    } catch (error) {
      checks.push(fail('MINT_ACCOUNT', 'Compte mint', true, 100, message(error)));
    }

    let runtime: Awaited<ReturnType<TradeVenue['readPoolRuntimeState']>> | null = null;
    try {
      runtime = await this.venue.readPoolRuntimeState(input.pool);
      slot = runtime.observedSlot > slot ? runtime.observedSlot : slot;
      checks.push(checkPoolState(input.pool, runtime, this.config));
      checks.push(checkLiquidity(runtime.wsolVaultBalanceRaw, this.config.minWsolLiquidityLamports, runtime.observedSlot));
      evidence.poolRuntime = runtime;
    } catch (error) {
      checks.push(fail('POOL_STATE', 'État du pool', true, 100, message(error)));
      checks.push(unknown('WSOL_LIQUIDITY', 'Liquidité WSOL', true, 20, 'Liquidité impossible à lire.'));
    }

    if (metadata) {
      checks.push(checkExtensions(metadata.extensions, this.config));
      const distribution = await this.analyzeDistribution(input.pool, metadata);
      checks.push(distribution.check);
      evidence.distribution = distribution.evidence;
      const lp = await this.analyzeLpControl(input.pool);
      checks.push(lp.check);
      evidence.lpControl = lp.evidence;
      checks.push(checkMetadata(metadata));
    } else {
      checks.push(unknown('TOKEN_2022_EXTENSIONS', 'Extensions Token-2022', true, 30, 'Le mint n’a pas pu être décodé.'));
      checks.push(unknown('TOKEN_DISTRIBUTION', 'Distribution du token', false, 15, 'Supply indisponible.'));
      checks.push(unknown('LP_CONTROL', 'Contrôle du LP', false, 15, 'LP non analysable sans pool valide.'));
      checks.push(unknown('METADATA_MUTABILITY', 'Mutabilité des métadonnées', false, 5, 'Métadonnées indisponibles.'));
    }

    let buySimulation: TokenRiskReport['buySimulation'] = null;
    let roundTripEstimate: TokenRiskReport['roundTripEstimate'] = null;
    if (!input.wallet) {
      const status = this.config.riskBuySimulationRequired ? 'FAIL' : 'UNKNOWN';
      checks.push({
        code: 'BUY_SIMULATION', label: 'Simulation d’achat', status,
        critical: this.config.riskBuySimulationRequired, penalty: this.config.riskBuySimulationRequired ? 100 : 20,
        message: 'Aucun wallet public n’est disponible pour construire la transaction réelle.',
      });
    } else {
      try {
        const quote = await this.venue.quoteBuy(input.pool, this.config.buyAmountLamports);
        const built = await this.venue.buildBuy(input.pool, quote, input.wallet);
        const simulation = await this.simulator.simulate(built, false);
        buySimulation = {
          ok: simulation.ok,
          error: simulation.error,
          unitsConsumed: simulation.unitsConsumed,
          logs: simulation.logs,
        };
        const overLimit = this.config.computeUnitLimit !== null && simulation.unitsConsumed !== null
          && simulation.unitsConsumed > BigInt(this.config.computeUnitLimit);
        checks.push({
          code: 'BUY_SIMULATION',
          label: 'Simulation d’achat',
          status: simulation.ok && !overLimit ? 'PASS' : 'FAIL',
          critical: this.config.riskBuySimulationRequired,
          penalty: simulation.ok && !overLimit ? 0 : 100,
          message: simulation.ok && !overLimit
            ? 'La transaction d’achat complète est simulée sans erreur.'
            : overLimit ? 'La simulation dépasse la limite de compute configurée.' : `Simulation échouée: ${simulation.error ?? 'erreur programme'}.`,
          evidence: { unitsConsumed: simulation.unitsConsumed?.toString() ?? null, logs: simulation.logs.slice(-20) },
        });
      } catch (error) {
        checks.push(fail('BUY_SIMULATION', 'Simulation d’achat', this.config.riskBuySimulationRequired, 100, message(error)));
      }
    }

    try {
      const transferFee = transferFeeCalculator(metadata?.extensions ?? []);
      const probe = await this.roundTrip.estimate(input.pool, this.config.buyAmountLamports, transferFee);
      roundTripEstimate = probe.estimate;
      checks.push({
        code: 'REVERSE_QUOTE',
        label: 'Cotation inverse',
        status: probe.estimate.recoverableWsolLamports > 0n ? 'PASS' : 'FAIL',
        critical: this.config.riskReverseQuoteRequired,
        penalty: probe.estimate.recoverableWsolLamports > 0n ? 0 : 100,
        message: probe.estimate.recoverableWsolLamports > 0n
          ? 'Une cotation directe token vers WSOL existe sur le même pool.'
          : 'Aucune sortie WSOL exploitable n’a été cotée.',
        evidence: { sellTradeFeeTokenRaw: probe.sellTradeFeeTokenRaw.toString() },
      });
      const impactExceeded = (this.config.riskMaxBuyPriceImpactBps !== null
        && probe.estimate.buyPriceImpactBps > this.config.riskMaxBuyPriceImpactBps)
        || (this.config.riskMaxSellPriceImpactBps !== null
        && probe.estimate.sellPriceImpactBps > this.config.riskMaxSellPriceImpactBps);
      const lossExceeded = probe.estimate.roundTripLossBps > this.config.riskMaxRoundTripLossBps;
      checks.push({
        code: 'ROUND_TRIP_ESTIMATE',
        label: 'Estimation aller-retour',
        status: impactExceeded || lossExceeded ? 'FAIL' : 'PASS',
        critical: true,
        penalty: impactExceeded || lossExceeded ? 100 : 0,
        message: impactExceeded
          ? 'Impact de prix supérieur à la politique configurée.'
          : lossExceeded
            ? `Perte aller-retour estimée à ${probe.estimate.roundTripLossBps} bps, au-dessus du seuil.`
            : 'L’estimation aller-retour reste dans les seuils configurés; elle ne prouve pas la sellabilité.',
        evidence: serializeEstimate(probe.estimate),
      });
    } catch (error) {
      checks.push(fail('REVERSE_QUOTE', 'Cotation inverse', this.config.riskReverseQuoteRequired, 100, message(error)));
      checks.push(unknown('ROUND_TRIP_ESTIMATE', 'Estimation aller-retour', true, 30, 'Estimation indisponible.'));
    }

    const evaluation = evaluateRisk(checks, {
      minScore: this.config.riskMinScore,
      allowUnknownReviews: this.config.riskAllowUnknownReviews,
      allowUnknownMinScore: this.config.riskAllowUnknownMinScore,
    });
    const report: TokenRiskReport = {
      id: `risk:${input.sessionId}:${slot}`,
      sessionId: input.sessionId,
      tokenMint: input.pool.tokenMint,
      pool: input.pool.pool,
      slot,
      score: evaluation.score,
      verdict: evaluation.verdict,
      checks,
      tokenProgram: metadata?.tokenProgram ?? input.pool.tokenProgram,
      extensions: metadata?.extensions.map((extension) => extension.type) ?? [],
      holderConcentration: extractConcentration(evidence.distribution),
      buySimulation,
      roundTripEstimate,
      evidence: { ...evidence, evaluationReasons: evaluation.reasons },
      createdAtMs: Date.now(),
    };
    await this.reports.save(report);
    return report;
  }

  private async analyzeDistribution(pool: PoolInfo, metadata: TokenMetadata): Promise<{
    check: RiskCheck;
    evidence: Record<string, unknown> & { concentration?: HolderConcentration };
  }> {
    try {
      const largest = await this.connection.getTokenLargestAccounts(new PublicKey(pool.tokenMint), 'confirmed');
      const rows = await Promise.all(largest.value.map(async (entry) => {
        const address = entry.address.toBase58();
        const owner = await readTokenAccountOwner(this.connection, entry.address);
        return { address, owner, amount: BigInt(entry.amount) };
      }));
      if (rows.some((row) => row.owner === null)) {
        return {
          check: unknown('TOKEN_DISTRIBUTION', 'Distribution du token', false, 15, 'Au moins un propriétaire de compte token est indéterminable.'),
          evidence: { accounts: rows.map(serializableHolder) },
        };
      }
      const excluded = rows.filter((row) => row.address === pool.tokenVault)
        .map((row) => ({ account: row.address, reason: 'vault officiel du pool' }));
      const retained = rows.filter((row) => row.address !== pool.tokenVault).sort((a, b) => a.amount > b.amount ? -1 : 1);
      const concentration: HolderConcentration = {
        top1Bps: concentrationBps(retained, 1, metadata.supplyRaw),
        top5Bps: concentrationBps(retained, 5, metadata.supplyRaw),
        top10Bps: concentrationBps(retained, 10, metadata.supplyRaw),
        analyzedAccounts: retained.length,
        excludedAccounts: excluded,
      };
      const exceeded = exceedsHolderPolicy(concentration, this.config);
      return {
        check: {
          code: 'TOKEN_DISTRIBUTION', label: 'Distribution du token',
          status: exceeded ? 'FAIL' : 'PASS', critical: exceeded, penalty: exceeded ? 100 : 0,
          message: exceeded ? 'La concentration des détenteurs dépasse un seuil configuré.' : 'Les concentrations top 1/5/10 respectent les seuils configurés.',
          evidence: concentration as unknown as Record<string, unknown>,
        },
        evidence: { concentration, accounts: rows.map(serializableHolder) },
      };
    } catch (error) {
      return { check: unknown('TOKEN_DISTRIBUTION', 'Distribution du token', false, 15, message(error)), evidence: {} };
    }
  }

  private async analyzeLpControl(pool: PoolInfo): Promise<{ check: RiskCheck; evidence: Record<string, unknown> }> {
    try {
      const [supply, largest] = await Promise.all([
        this.connection.getTokenSupply(new PublicKey(pool.lpMint), 'confirmed'),
        this.connection.getTokenLargestAccounts(new PublicKey(pool.lpMint), 'confirmed'),
      ]);
      const supplyRaw = BigInt(supply.value.amount);
      const holders = await Promise.all(largest.value.map(async (entry) => ({
        account: entry.address.toBase58(),
        owner: await readTokenAccountOwner(this.connection, entry.address),
        amountRaw: BigInt(entry.amount),
      })));
      const lockedRaw = holders.filter((holder) => holder.owner === RAYDIUM_BURN_AND_EARN_AUTHORITY)
        .reduce((sum, holder) => sum + holder.amountRaw, 0n);
      const incineratedRaw = holders.filter((holder) => holder.owner === INCINERATOR)
        .reduce((sum, holder) => sum + holder.amountRaw, 0n);
      const creatorRaw = pool.creator === null ? 0n : holders.filter((holder) => holder.owner === pool.creator)
        .reduce((sum, holder) => sum + holder.amountRaw, 0n);
      const unresolved = holders.some((holder) => holder.owner === null);
      const evidence = {
        supplyRaw: supplyRaw.toString(),
        lockedRaydiumRaw: lockedRaw.toString(),
        incineratedRaw: incineratedRaw.toString(),
        creatorRaw: creatorRaw.toString(),
        lockedRaydiumBps: ratioBps(lockedRaw, supplyRaw),
        creatorBps: ratioBps(creatorRaw, supplyRaw),
        holders: holders.map((holder) => ({ ...holder, amountRaw: holder.amountRaw.toString() })),
      };
      return {
        check: unresolved
          ? unknown('LP_CONTROL', 'Contrôle du LP', false, 15, 'Certains propriétaires LP sont indéterminables; aucun verrouillage n’est affirmé.')
          : lockedRaw > 0n || incineratedRaw > 0n
            ? pass('LP_CONTROL', 'Contrôle du LP', 'Une part LP est prouvée on-chain dans Raydium Burn & Earn ou l’incinérateur.', evidence)
            : unknown('LP_CONTROL', 'Contrôle du LP', false, 10, 'Aucun verrouillage LP reconnu n’est prouvé on-chain.'),
        evidence,
      };
    } catch (error) {
      return { check: unknown('LP_CONTROL', 'Contrôle du LP', false, 15, message(error)), evidence: {} };
    }
  }
}

export function checkMintAccount(metadata: TokenMetadata, initialized: boolean): RiskCheck {
  const programAccepted = [SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(metadata.tokenProgram);
  const valid = initialized && programAccepted && metadata.decimals >= 0 && metadata.decimals <= 18 && metadata.supplyRaw > 0n;
  return valid
    ? pass('MINT_ACCOUNT', 'Compte mint', 'Mint initialisé, programme Token accepté, supply positive et decimals raisonnables.', {
      decimals: metadata.decimals, supplyRaw: metadata.supplyRaw.toString(), tokenProgram: metadata.tokenProgram,
    })
    : fail('MINT_ACCOUNT', 'Compte mint', true, 100, 'Le mint est absent, non initialisé, vide ou hors des programmes Token acceptés.');
}

export function checkMintAuthority(metadata: TokenMetadata): RiskCheck {
  return metadata.mintAuthority === null
    ? pass('MINT_AUTHORITY', 'Autorité de mint', 'L’autorité de mint est révoquée.')
    : { code: 'MINT_AUTHORITY', label: 'Autorité de mint', status: 'WARN', critical: false, penalty: 20,
      message: 'Une autorité peut encore augmenter la supply.', evidence: { authority: metadata.mintAuthority, supplyRaw: metadata.supplyRaw.toString() } };
}

export function checkFreezeAuthority(metadata: TokenMetadata): RiskCheck {
  return metadata.freezeAuthority === null
    ? pass('FREEZE_AUTHORITY', 'Autorité de gel', 'L’autorité de gel est révoquée.')
    : fail('FREEZE_AUTHORITY', 'Autorité de gel', true, 100, 'Une autorité de gel est encore active.', { authority: metadata.freezeAuthority });
}

export function checkPoolState(
  pool: PoolInfo,
  runtime: Awaited<ReturnType<TradeVenue['readPoolRuntimeState']>>,
  config: AppConfig,
): RiskCheck {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const valid = pool.programId === config.raydiumCpmmProgramId
    && runtime.pool === pool.pool
    && runtime.swapsEnabled
    && runtime.openTimeUnix <= now;
  return valid
    ? pass('POOL_STATE', 'État du pool', 'Pool CPMM officiel, ouvert et swaps autorisés.', {
      statusBits: runtime.statusBits, openTimeUnix: runtime.openTimeUnix.toString(), observedSlot: runtime.observedSlot.toString(),
    })
    : fail('POOL_STATE', 'État du pool', true, 100, 'Pool non officiel, pas encore ouvert ou swaps désactivés.');
}

export function checkLiquidity(balance: bigint, threshold: bigint, slot: bigint): RiskCheck {
  return balance >= threshold
    ? pass('WSOL_LIQUIDITY', 'Liquidité WSOL', 'La liquidité WSOL respecte le seuil.', {
      balanceLamports: balance.toString(), thresholdLamports: threshold.toString(), slot: slot.toString(),
    })
    : fail('WSOL_LIQUIDITY', 'Liquidité WSOL', true, 100, 'La liquidité WSOL est sous le seuil critique.', {
      balanceLamports: balance.toString(), thresholdLamports: threshold.toString(), slot: slot.toString(),
    });
}

export function checkExtensions(extensions: readonly TokenExtensionInfo[], config: AppConfig): RiskCheck {
  const blocking: string[] = [];
  const warnings: string[] = [];
  for (const extension of extensions) {
    const details = extension.details;
    if (extension.type === 'NonTransferable') blocking.push(extension.type);
    else if (extension.type === 'DefaultAccountState' && details.frozenByDefault === true) blocking.push('DefaultAccountState:FROZEN');
    else if (extension.type === 'PermanentDelegate' && details.authority) blocking.push(extension.type);
    else if (extension.type === 'TransferHook' && details.programId) blocking.push(extension.type);
    else if (extension.type === 'ConfidentialTransferMint') blocking.push(extension.type);
    else if (extension.type === 'TransferFeeConfig') {
      const bps = Number(details.transferFeeBasisPoints ?? 0);
      if (bps > config.riskMaxTransferFeeBps) blocking.push(`TransferFeeConfig:${bps}`);
      else if (extension.mutable) warnings.push('TransferFeeConfig modifiable');
    } else if (extension.affectsTransfers && extension.type.startsWith('UNKNOWN_')) blocking.push(extension.type);
    else if (extension.type === 'PausableConfig' || extension.type === 'PermissionedBurn') blocking.push(extension.type);
  }
  if (blocking.length > 0) return fail('TOKEN_2022_EXTENSIONS', 'Extensions Token-2022', true, 100,
    `Extensions bloquantes: ${blocking.join(', ')}.`, { extensions, blocking });
  if (warnings.length > 0) return {
    code: 'TOKEN_2022_EXTENSIONS', label: 'Extensions Token-2022', status: 'WARN', critical: false, penalty: 15,
    message: warnings.join(', '), evidence: { extensions, warnings },
  };
  return pass('TOKEN_2022_EXTENSIONS', 'Extensions Token-2022', 'Aucune extension de transfert bloquante détectée.', { extensions });
}

export function checkMetadata(metadata: TokenMetadata): RiskCheck {
  if (metadata.name === null && metadata.symbol === null && metadata.uri === null) {
    return unknown('METADATA_MUTABILITY', 'Mutabilité des métadonnées', false, 5, 'Aucune métadonnée vérifiable.');
  }
  if (metadata.mutable === true) {
    return { code: 'METADATA_MUTABILITY', label: 'Mutabilité des métadonnées', status: 'WARN', critical: false, penalty: 5,
      message: 'Les métadonnées sont modifiables.', evidence: metadataEvidence(metadata) };
  }
  return pass('METADATA_MUTABILITY', 'Mutabilité des métadonnées', 'Les métadonnées présentes ne sont pas modifiables.', metadataEvidence(metadata));
}

export function transferFeeCalculator(extensions: readonly TokenExtensionInfo[]): (amount: bigint) => bigint {
  const extension = extensions.find((item) => item.type === 'TransferFeeConfig');
  if (!extension) return () => 0n;
  const bps = BigInt(Number(extension.details.transferFeeBasisPoints ?? 0));
  const maximum = BigInt(String(extension.details.maximumFeeRaw ?? '0'));
  return (amount) => {
    if (amount <= 0n || bps === 0n) return 0n;
    const fee = (amount * bps + 9999n) / 10_000n;
    return maximum > 0n && fee > maximum ? maximum : fee;
  };
}

async function readTokenAccountOwner(connection: Connection, address: PublicKey): Promise<string | null> {
  const response = await connection.getParsedAccountInfo(address, 'confirmed');
  if (!response.value || !('parsed' in response.value.data)) return null;
  const parsed = response.value.data.parsed as { info?: { owner?: string } };
  return parsed.info?.owner ?? null;
}

function concentrationBps(rows: readonly { amount: bigint }[], count: number, supply: bigint): number | null {
  if (supply <= 0n) return null;
  const amount = rows.slice(0, count).reduce((sum, row) => sum + row.amount, 0n);
  return Number(amount * 10_000n / supply);
}

function ratioBps(amount: bigint, total: bigint): number | null {
  return total > 0n ? Number(amount * 10_000n / total) : null;
}

function exceedsHolderPolicy(concentration: HolderConcentration, config: AppConfig): boolean {
  return (config.riskMaxTop1HolderBps !== null && (concentration.top1Bps ?? 0) > config.riskMaxTop1HolderBps)
    || (config.riskMaxTop5HoldersBps !== null && (concentration.top5Bps ?? 0) > config.riskMaxTop5HoldersBps)
    || (config.riskMaxTop10HoldersBps !== null && (concentration.top10Bps ?? 0) > config.riskMaxTop10HoldersBps);
}

function extractConcentration(value: unknown): HolderConcentration | null {
  if (!value || typeof value !== 'object' || !('concentration' in value)) return null;
  return (value as { concentration?: HolderConcentration }).concentration ?? null;
}

function serializeEstimate(estimate: NonNullable<TokenRiskReport['roundTripEstimate']>): Record<string, unknown> {
  return {
    amountInLamports: estimate.amountInLamports.toString(),
    expectedTokenRaw: estimate.expectedTokenRaw.toString(),
    expectedTokenTransferFeeRaw: estimate.expectedTokenTransferFeeRaw.toString(),
    recoverableWsolLamports: estimate.recoverableWsolLamports.toString(),
    buyPriceImpactBps: estimate.buyPriceImpactBps,
    sellPriceImpactBps: estimate.sellPriceImpactBps,
    raydiumFeesLamports: estimate.raydiumFeesLamports.toString(),
    roundTripLossBps: estimate.roundTripLossBps,
    estimatedAtSlot: estimate.estimatedAtSlot.toString(),
  };
}

function serializableHolder(holder: { address: string; owner: string | null; amount: bigint }): Record<string, unknown> {
  return { address: holder.address, owner: holder.owner, amountRaw: holder.amount.toString() };
}

function metadataEvidence(metadata: TokenMetadata): Record<string, unknown> {
  return { name: metadata.name, symbol: metadata.symbol, uri: metadata.uri, updateAuthority: metadata.updateAuthority, mutable: metadata.mutable };
}

function pass(code: string, label: string, messageText: string, evidence?: Record<string, unknown>): RiskCheck {
  return { code, label, status: 'PASS', critical: false, penalty: 0, message: messageText, evidence };
}

function fail(
  code: string,
  label: string,
  critical: boolean,
  penalty: number,
  messageText: string,
  evidence?: Record<string, unknown>,
): RiskCheck {
  return { code, label, status: 'FAIL', critical, penalty, message: messageText, evidence };
}

function unknown(code: string, label: string, critical: boolean, penalty: number, messageText: string): RiskCheck {
  return { code, label, status: 'UNKNOWN', critical, penalty, message: messageText };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
