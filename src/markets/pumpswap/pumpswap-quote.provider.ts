import { createHash } from 'node:crypto';
import type { MarketQuote } from '../../domain/market.js';
import type {
  PumpSwapQuotePort,
  PumpSwapQuoteRequest,
} from '../../ports/pumpswap-quote-provider.js';
import type {
  PumpSwapFeeState,
  PumpSwapFeeTier,
} from './pumpswap-fee-state.js';
export { computeEffectiveQuoteReservesRaw } from './reserve-math.js';

export class InvalidPumpSwapQuoteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidPumpSwapQuoteError';
  }
}

export class SellQuoteUnavailableError extends InvalidPumpSwapQuoteError {
  public constructor(public readonly pool: string) {
    super(`Réserves quote réelles insuffisantes pour ${pool}.`);
    this.name = 'SellQuoteUnavailableError';
  }
}

export class PumpSwapQuoteProvider implements PumpSwapQuotePort {
  public constructor(
    private readonly readFeeState: (
      pool: PumpSwapQuoteRequest['pool'],
    ) => Promise<PumpSwapFeeState>,
    private readonly clock: () => number = Date.now,
  ) {}

  public async quote(request: PumpSwapQuoteRequest): Promise<MarketQuote> {
    return createPumpSwapQuote(
      request,
      await this.readFeeState(request.pool),
      this.clock(),
    );
  }
}

export function createPumpSwapQuote(
  request: PumpSwapQuoteRequest,
  state: PumpSwapFeeState,
  observedAtMs: number,
): MarketQuote {
  validate(request, state, observedAtMs);
  const inputIsQuote = request.inputMint === request.pool.quoteAsset.mint;
  const outputMint = inputIsQuote
    ? request.pool.baseMint
    : request.pool.quoteAsset.mint;
  const fees = selectFees(request, state);
  const creatorFeeBps = state.creatorFeeEnabled ? fees.creatorFeeBps : 0n;
  const totalFeeBps =
    fees.lpFeeBps + fees.protocolFeeBps + creatorFeeBps;
  if (totalFeeBps > 10_000n) {
    throw new InvalidPumpSwapQuoteError('Somme des frais supérieure à 100%.');
  }
  const result = inputIsQuote
    ? buy(request, fees.lpFeeBps, fees.protocolFeeBps, creatorFeeBps)
    : sell(request, fees.lpFeeBps, fees.protocolFeeBps, creatorFeeBps);
  const minimumAmountOutRaw =
    result.amountOutRaw * (10_000n - request.slippageBps) / 10_000n;
  const priceImpactBps = impact(
    inputIsQuote,
    request.amountInRaw,
    result.amountOutRaw,
    request.reserves.baseReservesRaw,
    request.reserves.effectiveQuoteReservesRaw,
  );
  const identity = JSON.stringify([
    request.pool.address,
    request.inputMint,
    request.amountInRaw.toString(),
    request.slippageBps.toString(),
    request.reserves.observedSlot.toString(),
    state.observedSlot.toString(),
  ]);
  return Object.freeze({
    id: `quote_${createHash('sha256').update(identity).digest('hex')}`,
    pool: request.pool.address,
    inputMint: request.inputMint,
    outputMint,
    amountInRaw: request.amountInRaw,
    amountOutRaw: result.amountOutRaw,
    minimumAmountOutRaw,
    feesRaw: result.feesRaw,
    slippageBps: request.slippageBps,
    priceImpactBps,
    observedAtMs,
    observedSlot:
      request.reserves.observedSlot < state.observedSlot
        ? request.reserves.observedSlot
        : state.observedSlot,
  });
}

function selectFees(
  request: PumpSwapQuoteRequest,
  state: PumpSwapFeeState,
): Pick<PumpSwapFeeTier, 'lpFeeBps' | 'protocolFeeBps' | 'creatorFeeBps'> {
  if (state.tiers.length === 0) return state;
  const marketCapRaw =
    state.baseMintSupplyRaw * request.reserves.effectiveQuoteReservesRaw
    / request.reserves.baseReservesRaw;
  return state.tiers
    .filter((tier) => marketCapRaw >= tier.marketCapThresholdRaw)
    .at(-1) ?? state.tiers[0] ?? state;
}

function buy(
  request: PumpSwapQuoteRequest,
  lpFeeBps: bigint,
  protocolFeeBps: bigint,
  creatorFeeBps: bigint,
): { readonly amountOutRaw: bigint; readonly feesRaw: bigint } {
  const totalFeeBps = lpFeeBps + protocolFeeBps + creatorFeeBps;
  let effectiveQuoteRaw =
    request.amountInRaw * 10_000n / (10_000n + totalFeeBps);
  let feesRaw =
    fee(effectiveQuoteRaw, lpFeeBps)
    + fee(effectiveQuoteRaw, protocolFeeBps)
    + fee(effectiveQuoteRaw, creatorFeeBps);
  if (effectiveQuoteRaw + feesRaw > request.amountInRaw) {
    effectiveQuoteRaw -= effectiveQuoteRaw + feesRaw - request.amountInRaw;
    feesRaw =
      fee(effectiveQuoteRaw, lpFeeBps)
      + fee(effectiveQuoteRaw, protocolFeeBps)
      + fee(effectiveQuoteRaw, creatorFeeBps);
  }
  if (effectiveQuoteRaw <= 1n) {
    throw new InvalidPumpSwapQuoteError('Montant quote trop faible.');
  }
  const input = effectiveQuoteRaw - 1n;
  const amountOutRaw =
    request.reserves.baseReservesRaw * input
    / (request.reserves.effectiveQuoteReservesRaw + input);
  if (amountOutRaw <= 0n) {
    throw new InvalidPumpSwapQuoteError('Sortie base nulle.');
  }
  return { amountOutRaw, feesRaw };
}

function sell(
  request: PumpSwapQuoteRequest,
  lpFeeBps: bigint,
  protocolFeeBps: bigint,
  creatorFeeBps: bigint,
): { readonly amountOutRaw: bigint; readonly feesRaw: bigint } {
  const grossQuoteRaw =
    request.reserves.effectiveQuoteReservesRaw * request.amountInRaw
    / (request.reserves.baseReservesRaw + request.amountInRaw);
  const lpFeeRaw = fee(grossQuoteRaw, lpFeeBps);
  const feesRaw =
    lpFeeRaw
    + fee(grossQuoteRaw, protocolFeeBps)
    + fee(grossQuoteRaw, creatorFeeBps);
  if (request.reserves.quoteVaultAmountRaw < grossQuoteRaw - lpFeeRaw) {
    throw new SellQuoteUnavailableError(request.pool.address);
  }
  const amountOutRaw = grossQuoteRaw - feesRaw;
  if (amountOutRaw <= 0n) {
    throw new InvalidPumpSwapQuoteError('Sortie quote nulle.');
  }
  return { amountOutRaw, feesRaw };
}

function fee(amountRaw: bigint, basisPoints: bigint): bigint {
  return ceilDiv(amountRaw * basisPoints, 10_000n);
}

function impact(
  inputIsQuote: boolean,
  amountInRaw: bigint,
  amountOutRaw: bigint,
  baseReserveRaw: bigint,
  effectiveQuoteReserveRaw: bigint,
): bigint {
  const spotNumerator = inputIsQuote
    ? amountInRaw * baseReserveRaw
    : amountInRaw * effectiveQuoteReserveRaw;
  const spotDenominator = inputIsQuote
    ? effectiveQuoteReserveRaw
    : baseReserveRaw;
  const candidate = spotNumerator - amountOutRaw * spotDenominator;
  const lost = candidate > 0n ? candidate : 0n;
  const value = ceilDiv(lost * 10_000n, spotNumerator);
  return value > 10_000n ? 10_000n : value;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new InvalidPumpSwapQuoteError('Division entière invalide.');
  }
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function validate(
  request: PumpSwapQuoteRequest,
  state: PumpSwapFeeState,
  observedAtMs: number,
): void {
  if (
    request.inputMint !== request.pool.baseMint
    && request.inputMint !== request.pool.quoteAsset.mint
  ) throw new InvalidPumpSwapQuoteError('Mint d’entrée hors pool.');
  if (request.reserves.pool !== request.pool.address) {
    throw new InvalidPumpSwapQuoteError('Réserves d’un autre pool.');
  }
  if (
    request.amountInRaw <= 0n
    || request.reserves.baseReservesRaw <= 0n
    || request.reserves.effectiveQuoteReservesRaw <= 0n
  ) throw new InvalidPumpSwapQuoteError('Montants de quote invalides.');
  if (request.slippageBps < 0n || request.slippageBps > 10_000n) {
    throw new InvalidPumpSwapQuoteError('Slippage hors bornes.');
  }
  if (
    !Number.isSafeInteger(observedAtMs)
    || observedAtMs < 0
    || state.observedSlot < 0n
    || state.baseMintSupplyRaw < 0n
  ) throw new InvalidPumpSwapQuoteError('Observation non canonique.');
  let previousThreshold: bigint | null = null;
  for (const fees of [state, ...state.tiers]) {
    for (const value of [
      fees.lpFeeBps,
      fees.protocolFeeBps,
      fees.creatorFeeBps,
    ]) {
      if (value < 0n || value > 10_000n) {
        throw new InvalidPumpSwapQuoteError('Frais hors bornes.');
      }
    }
    if ('marketCapThresholdRaw' in fees) {
      if (
        fees.marketCapThresholdRaw < 0n
        || (
          previousThreshold !== null
          && fees.marketCapThresholdRaw <= previousThreshold
        )
      ) throw new InvalidPumpSwapQuoteError('Paliers de frais non canoniques.');
      previousThreshold = fees.marketCapThresholdRaw;
    }
  }
}
