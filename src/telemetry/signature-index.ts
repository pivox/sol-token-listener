export interface SignatureSourceRow {
  relativePath: string;
  wave: number;
  event: string;
  signature?: unknown;
  mint?: unknown;
  positionId?: unknown;
  orderId?: unknown;
  side?: unknown;
  orderStatus?: unknown;
}

export interface SignatureLink {
  source: string;
  wave: number;
  mint: string | null;
  positionId: string | null;
  orderId: string | null;
  side: 'BUY' | 'SELL' | null;
  orderStatus: string | null;
  event: string;
  role: 'TOKEN_CREATE' | 'BUY' | 'SELL' | 'MARKET_ACTIVITY' | 'OTHER_TRANSACTION';
}

export interface SignatureIndexRow { signature: string; links: SignatureLink[] }

function role(event: string): SignatureLink['role'] {
  if (event === 'pumpfun_create') return 'TOKEN_CREATE';
  if (event.startsWith('buy_') || event === 'position_open' || event === 'status_buy_link') return 'BUY';
  if (event.startsWith('sell_') || event === 'complete' || event === 'status_sell_link') return 'SELL';
  if (event === 'trade') return 'MARKET_ACTIVITY';
  return 'OTHER_TRANSACTION';
}

/** Deduplicate network lookups while retaining every evidence and position link. */
export function buildSignatureIndex(rows: readonly SignatureSourceRow[]): SignatureIndexRow[] {
  const index = new Map<string, Map<string, SignatureLink>>();
  for (const row of rows) {
    if (typeof row.signature !== 'string' || row.signature.length === 0) continue;
    const mint = typeof row.mint === 'string' ? row.mint : null;
    const side = row.side === 'BUY' || row.side === 'SELL' ? row.side : null;
    const link: SignatureLink = { source: row.relativePath, wave: row.wave, mint,
      positionId: typeof row.positionId === 'string' ? row.positionId
        : mint === null ? null : `wave-${String(row.wave).padStart(3, '0')}:${mint}`,
      orderId: typeof row.orderId === 'string' ? row.orderId : null,
      side,
      orderStatus: typeof row.orderStatus === 'string' ? row.orderStatus : null,
      event: row.event, role: role(row.event) };
    const links = index.get(row.signature) ?? new Map<string, SignatureLink>();
    links.set(JSON.stringify(link), link);
    index.set(row.signature, links);
  }
  return [...index.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([signature, links]) => ({ signature, links: [...links.values()] }));
}
