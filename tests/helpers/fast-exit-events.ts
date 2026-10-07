// Observed launch and curve-trade events (domain_events) that drive the lot 4b early exit rules,
// shared by the repository and the fast-exit safety tests.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Keypair } from '@solana/web3.js';
import { toJsonValue } from '../../src/utils/json.js';

const quoteMint = 'So11111111111111111111111111111111111111112';

export const earlyExitPolicy = Object.freeze({
  takeProfitBps: 20_000n, externalBuyersTarget: 3, externalMinimumBuyRaw: 100n,
});
/** The BUY entry slot of the repository test fixture; default trades land one slot later. */
export const entrySlot = 128n;

export function earlyExitPublicKey(): string {
  return Keypair.generate().publicKey.toBase58();
}

export async function insertLaunchEvent(
  pool: InstanceType<typeof pg.Pool>,
  mint: string,
  creator: string,
  confirmationStatus = 'finalized',
): Promise<void> {
  const payload = toJsonValue({
    launch: {
      mint, creator, tokenProgram: 'SPL_TOKEN',
      quoteAssets: [{ mint: quoteMint, decimals: 9, tokenProgram: 'SPL_TOKEN' }],
      launchpad: 'pump.fun',
      createdAt: { slot: 100n, transactionIndex: 0, instructionIndex: 0, innerInstructionIndex: null },
      parameters: {},
    },
  });
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,inner_instruction_index,confirmation_status,observed_at,payload_version,payload
  ) VALUES ($1,NULL,'TokenLaunchDetected',$2,'test-fixture','test-fixture',$1,100,0,0,NULL,$3,
    statement_timestamp(),1,$4::JSONB)`, [
    `launch:${randomUUID()}`, mint, confirmationStatus, JSON.stringify(payload),
  ]);
}

export type SeedTrade = Readonly<{
  kind: 'BUY' | 'SELL';
  trader: string | null;
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
  slot?: bigint;
  transactionIndex?: number;
  confirmationStatus?: string;
  mutate?: (payload: { trade: Record<string, unknown> }) => void;
}>;

export async function insertTradeEvents(
  pool: InstanceType<typeof pg.Pool>,
  mint: string,
  trades: readonly SeedTrade[],
): Promise<void> {
  for (const [position, trade] of trades.entries()) {
    const slot = trade.slot ?? entrySlot + 1n;
    const transactionIndex = trade.transactionIndex ?? position;
    const cursor = { slot, transactionIndex, instructionIndex: 0, innerInstructionIndex: null };
    const eventId = `trade:${randomUUID()}`;
    const payload = JSON.parse(JSON.stringify(toJsonValue({
      trade: {
        id: eventId, launchMint: mint, kind: trade.kind, trader: trade.trader,
        baseAmountRaw: trade.baseAmountRaw, quoteAmountRaw: trade.quoteAmountRaw,
        quoteAsset: { mint: quoteMint, decimals: 9, tokenProgram: 'SPL_TOKEN' },
        cursor,
      },
    }))) as { trade: Record<string, unknown> };
    trade.mutate?.(payload);
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
      instruction_index,inner_instruction_index,confirmation_status,observed_at,payload_version,
      payload
    ) VALUES ($1,NULL,'BondingCurveTradeObserved',$2,'test-fixture','test-fixture',$1,
      $3::NUMERIC,$4,0,NULL,$5,statement_timestamp(),1,$6::JSONB)`, [
      eventId, mint, slot.toString(), transactionIndex,
      trade.confirmationStatus ?? 'finalized', JSON.stringify(payload),
    ]);
  }
}

/** Trades that fire every rule: creator sell, 4 external buyers, a take-profit last price. */
export function everyRuleTrades(
  fixture: Readonly<{ quoteCostRaw: bigint }>,
  creator: string,
  overrides: Partial<Pick<SeedTrade, 'slot' | 'confirmationStatus' | 'trader'>> = {},
): readonly SeedTrade[] {
  const cheap = { baseAmountRaw: 1_000_000n, quoteAmountRaw: 100n };
  return Object.freeze([
    { kind: 'SELL', trader: creator, ...cheap, ...overrides },
    { kind: 'BUY', trader: earlyExitPublicKey(), ...cheap, ...overrides },
    { kind: 'BUY', trader: earlyExitPublicKey(), ...cheap, ...overrides },
    { kind: 'BUY', trader: earlyExitPublicKey(), ...cheap, ...overrides },
    {
      kind: 'BUY', trader: earlyExitPublicKey(), baseAmountRaw: 1n,
      quoteAmountRaw: 2n * fixture.quoteCostRaw, ...overrides,
    },
  ] as const satisfies readonly SeedTrade[]);
}
