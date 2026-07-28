import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  PUMPSWAP_EVENTS,
  PUMPSWAP_TYPES,
} from '../src/markets/pumpswap/generated/pumpswap-idl.js';
import { decodePumpSwapCpiEvent } from '../src/markets/pumpswap/event-decoder.js';
import type { NormalizedInstruction } from '../src/solana/rpc/types.js';

const PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const POOL = address(1);
const USER = address(2);
const MINT = address(3);

void test('décode CreatePoolEvent avec son pool canonique annoncé', () => {
  const decoded = decodePumpSwapCpiEvent(eventInstruction('CreatePoolEvent', {
    index: 0n,
    pool: POOL,
    base_mint: MINT,
    quote_mint: address(4),
  }));
  assert.equal(decoded?.kind, 'CREATE_POOL');
  assert.equal(decoded?.fields.pool, POOL);
  assert.equal(decoded?.fields.index, 0n);
});

void test('décode BuyEvent et le champ append-only base_supply', () => {
  const decoded = decodePumpSwapCpiEvent(eventInstruction('BuyEvent', {
    pool: POOL,
    user: USER,
    base_amount_out: 100n,
    quote_amount_in: 50n,
    ix_name: 'buy_exact_quote_in',
    base_supply: 1_000_000n,
  }));
  assert.equal(decoded?.kind, 'BUY');
  assert.equal(decoded?.fields.base_amount_out, 100n);
  assert.equal(decoded?.fields.quote_amount_in, 50n);
  assert.equal(decoded?.fields.base_supply, 1_000_000n);
});

void test('décode SellEvent et les réserves virtuelles signées', () => {
  const decoded = decodePumpSwapCpiEvent(eventInstruction('SellEvent', {
    pool: POOL,
    user: USER,
    base_amount_in: 100n,
    quote_amount_out: 45n,
    virtual_quote_reserves: -5n,
  }));
  assert.equal(decoded?.kind, 'SELL');
  assert.equal(decoded?.fields.virtual_quote_reserves, -5n);
});

type EventName = keyof typeof PUMPSWAP_EVENTS;

function eventInstruction(
  name: EventName,
  overrides: Readonly<Record<string, string | bigint | boolean>>,
): NormalizedInstruction {
  const definition = PUMPSWAP_TYPES[name];
  const fields = definition.type.fields;
  return {
    programId: PROGRAM,
    accounts: [],
    data: Uint8Array.from([
      ...eventTag(),
      ...PUMPSWAP_EVENTS[name].discriminator,
      ...fields.flatMap((field) =>
        encodeType(field.type, overrides[field.name] ?? defaultValue(field.type))),
    ]),
    instructionIndex: 2,
    innerInstructionIndex: 3,
    parentInstructionIndex: 2,
    stackHeight: 3,
  };
}

function encodeType(type: unknown, value: string | bigint | boolean): number[] {
  if (type === 'u8' || type === 'bool') return [value === true ? 1 : Number(value)];
  if (type === 'u16') return bytes(2, BigInt(value));
  if (type === 'u64' || type === 'i64') return bytes(8, BigInt(value));
  if (type === 'i128') return bytes(16, BigInt(value));
  if (type === 'pubkey') return [...new PublicKey(String(value)).toBytes()];
  if (type === 'string') {
    const text = new TextEncoder().encode(String(value));
    return [...bytes(4, BigInt(text.length)), ...text];
  }
  throw new Error(`Type de fixture inconnu: ${JSON.stringify(type)}`);
}

function defaultValue(type: unknown): string | bigint | boolean {
  if (type === 'pubkey') return address(90);
  if (type === 'string') return 'buy';
  if (type === 'bool') return false;
  return 0n;
}

function bytes(width: number, input: bigint): number[] {
  const modulus = 1n << BigInt(width * 8);
  let value = input < 0n ? modulus + input : input;
  return Array.from({ length: width }, () => {
    const byte = Number(value & 0xffn);
    value >>= 8n;
    return byte;
  });
}

function eventTag(): Uint8Array {
  return Uint8Array.from(
    createHash('sha256').update('anchor:event').digest().subarray(0, 8),
  ).reverse();
}

function address(seed: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) =>
    (seed + index) % 256)).toBase58();
}
