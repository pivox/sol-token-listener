import type { ChainCursor, QuoteAsset } from './types.js';

export interface PublicTokenMetadata {
  readonly name: string | null;
  readonly symbol: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly videoUrl: string | null;
  readonly websiteUrl: string | null;
  readonly twitterUrl: string | null;
  readonly telegramUrl: string | null;
}

export type MetadataFailureReason =
  | 'URI_INVALID'
  | 'UNSUPPORTED_URI_SCHEME'
  | 'FETCH_FAILED'
  | 'HTTP_STATUS_INVALID'
  | 'REDIRECT_LIMIT_EXCEEDED'
  | 'CONTENT_TOO_LARGE'
  | 'JSON_INVALID'
  | 'JSON_SHAPE_INVALID';

export type MetadataResolution =
  | {
    readonly status: 'RESOLVED';
    readonly metadata: PublicTokenMetadata;
  }
  | {
    readonly status: 'FAILED';
    readonly reason: MetadataFailureReason;
    readonly message: string;
  };

export interface TokenMetadataSnapshot {
  readonly mint: string;
  readonly uri: string;
  readonly resolution: MetadataResolution;
  readonly fetchedAtMs: number;
  readonly payloadVersion: number;
}

export interface BondingCurveSnapshot {
  readonly launchMint: string;
  readonly quoteAsset: QuoteAsset;
  readonly realBaseReservesRaw: bigint;
  readonly realQuoteReservesRaw: bigint;
  readonly virtualBaseReservesRaw: bigint;
  readonly virtualQuoteReservesRaw: bigint;
  readonly progressBps: bigint;
  readonly complete: boolean;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized' | 'orphaned';
}

export interface PersistedLaunchTrade {
  readonly id: string;
  readonly launchMint: string;
  readonly kind: 'BUY' | 'SELL';
  readonly trader: string | null;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
  readonly quoteAsset: QuoteAsset;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized' | 'orphaned';
}

export function normalizePublicTokenMetadata(
  value: Readonly<Record<string, unknown>>,
): PublicTokenMetadata {
  return Object.freeze({
    name: nullableText(value.name, 'name'),
    symbol: nullableText(value.symbol, 'symbol')?.toUpperCase() ?? null,
    description: nullableText(value.description, 'description'),
    imageUrl: nullableText(value.image, 'image'),
    videoUrl: nullableText(value.animation_url, 'animation_url'),
    websiteUrl: nullableText(value.external_url, 'external_url'),
    twitterUrl: nullableText(value.twitter, 'twitter'),
    telegramUrl: nullableText(value.telegram, 'telegram'),
  });
}

function nullableText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`Champ de métadonnées ${field} invalide.`);
  }
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}
