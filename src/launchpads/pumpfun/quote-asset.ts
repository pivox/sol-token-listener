import type { QuoteAsset, TokenProgramKind } from '../../domain/types.js';
import type {
  NormalizedTokenBalance,
  NormalizedTransaction,
} from '../../solana/rpc/types.js';
import {
  DEFAULT_PUBLIC_KEY,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
  WSOL_MINT,
} from './constants.js';
import { PumpDecodingError } from './errors.js';

export function normalizePumpQuoteMint(quoteMint: string): string {
  return quoteMint === DEFAULT_PUBLIC_KEY ? WSOL_MINT : quoteMint;
}

export function resolvePumpQuoteAsset(
  rawQuoteMint: string,
  transaction: NormalizedTransaction,
): QuoteAsset {
  const mint = normalizePumpQuoteMint(rawQuoteMint);
  if (mint === WSOL_MINT) {
    return Object.freeze({
      mint,
      decimals: 9,
      tokenProgram: 'SPL_TOKEN',
    });
  }

  const candidates = quoteBalanceCandidates(mint, transaction);
  if (candidates.length === 0) {
    throw new PumpDecodingError(
      'PUMP_QUOTE_ASSET_UNRESOLVED',
      true,
      `Quote mint Pump non résolu dans ${transaction.signature}: ${mint}.`,
      transaction.signature,
    );
  }
  if (candidates.length > 1) {
    throw new PumpDecodingError(
      'PUMP_QUOTE_ASSET_CONFLICT',
      true,
      `Métadonnées quote Pump conflictuelles pour ${mint}.`,
      transaction.signature,
    );
  }

  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new PumpDecodingError(
      'PUMP_QUOTE_ASSET_UNRESOLVED',
      true,
      `Quote mint Pump non résolu dans ${transaction.signature}: ${mint}.`,
      transaction.signature,
    );
  }
  return Object.freeze({
    mint,
    decimals: candidate.decimals,
    tokenProgram: tokenProgramKind(candidate.tokenProgram, transaction),
  });
}

function quoteBalanceCandidates(
  mint: string,
  transaction: NormalizedTransaction,
): readonly NormalizedTokenBalance[] {
  const byMetadata = new Map<string, NormalizedTokenBalance>();
  for (const balance of [
    ...transaction.preTokenBalances,
    ...transaction.postTokenBalances,
  ]) {
    if (balance.mint !== mint) continue;
    if (!isValidDecimals(balance.decimals)) {
      throw new PumpDecodingError(
        'PUMP_QUOTE_ASSET_CONFLICT',
        true,
        `Décimales quote Pump invalides pour ${mint}.`,
        transaction.signature,
      );
    }
    byMetadata.set(
      `${balance.decimals}:${balance.tokenProgram}`,
      balance,
    );
  }
  return Object.freeze([...byMetadata.values()]);
}

function tokenProgramKind(
  tokenProgram: string,
  transaction: NormalizedTransaction,
): TokenProgramKind {
  if (tokenProgram === SPL_TOKEN_PROGRAM_ID) return 'SPL_TOKEN';
  if (tokenProgram === TOKEN_2022_PROGRAM_ADDRESS) return 'TOKEN_2022';
  throw new PumpDecodingError(
    'PUMP_TOKEN_PROGRAM_UNSUPPORTED',
    false,
    `Programme token quote Pump non pris en charge: ${tokenProgram}.`,
    transaction.signature,
  );
}

function isValidDecimals(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255;
}
