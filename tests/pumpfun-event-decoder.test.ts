import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../src/launchpads/pumpfun/constants.js';
import {
  decodePumpCpiEvent,
} from '../src/launchpads/pumpfun/event-decoder.js';
import {
  PumpDecodingError,
} from '../src/launchpads/pumpfun/errors.js';
import {
  PUMP_EVENTS,
  PUMP_TYPES,
} from '../src/launchpads/pumpfun/generated/pump-idl.js';
import type {
  NormalizedInstruction,
} from '../src/solana/rpc/types.js';

const PUMP_PROGRAM =
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MINT = address(1);
const CREATOR = address(2);
const USER = address(3);
const QUOTE_MINT = address(4);
const CREATE_VALUES: Readonly<Record<string, unknown>> = {
  name: 'Éclair',
  symbol: 'ECL',
  uri: 'ipfs://metadata',
  mint: MINT,
  bonding_curve: address(5),
  user: USER,
  creator: CREATOR,
  timestamp: 9_007_199_254_740_993n,
  virtual_token_reserves: 1_000_000_000_000n,
  virtual_sol_reserves: 30_000_000_000n,
  real_token_reserves: 793_100_000_000n,
  token_total_supply: 1_000_000_000_000n,
  token_program: TOKEN_2022_PROGRAM_ADDRESS,
  is_mayhem_mode: true,
  is_cashback_enabled: true,
  quote_mint: QUOTE_MINT,
  virtual_quote_reserves: 30_000_000_001n,
};
const TRADE_VALUES: Readonly<Record<string, unknown>> = {
  mint: MINT,
  sol_amount: 250_000_000n,
  token_amount: 9_007_199_254_740_993n,
  is_buy: true,
  user: USER,
  timestamp: 9_007_199_254_740_993n,
  virtual_sol_reserves: 30_250_000_000n,
  virtual_token_reserves: 990_000_000_000n,
  real_sol_reserves: 250_000_000n,
  real_token_reserves: 783_100_000_000n,
  fee_recipient: address(6),
  fee_basis_points: 95n,
  fee: 2_375_000n,
  creator: CREATOR,
  creator_fee_basis_points: 30n,
  creator_fee: 750_000n,
  track_volume: true,
  total_unclaimed_tokens: 100n,
  total_claimed_tokens: 200n,
  current_sol_volume: 300n,
  last_update_timestamp: 9_007_199_254_740_992n,
  ix_name: 'buy_exact_quote_in',
  mayhem_mode: false,
  cashback_fee_basis_points: 5n,
  cashback: 125_000n,
  buyback_fee_basis_points: 10n,
  buyback_fee: 250_000n,
  shareholders: [{ address: address(7), share_bps: 1_250n }],
  quote_mint: QUOTE_MINT,
  quote_amount: 250_000_001n,
  virtual_quote_reserves: 30_250_000_001n,
  real_quote_reserves: 250_000_001n,
};

void test('décode CreateEvent avec Token-2022, Mayhem, Cashback et quote mint', () => {
  const decoded = decodePumpCpiEvent(createEventInstruction());

  assert.ok(decoded);
  assert.equal(decoded.kind, 'CREATE');
  assert.equal(decoded.event.mint, MINT);
  assert.equal(decoded.event.creator, CREATOR);
  assert.equal(decoded.event.tokenProgram, TOKEN_2022_PROGRAM_ADDRESS);
  assert.equal(decoded.event.isMayhemMode, true);
  assert.equal(decoded.event.isCashbackEnabled, true);
  assert.equal(decoded.event.virtualQuoteReserves, 30_000_000_001n);
  assert.equal(decoded.trailingDataHex, '');
});

void test('décode TradeEvent avec montants réels, réserves et frais', () => {
  const decoded = decodePumpCpiEvent(tradeEventInstruction());

  assert.ok(decoded);
  assert.equal(decoded.kind, 'TRADE');
  assert.equal(decoded.event.tokenAmount, 9_007_199_254_740_993n);
  assert.equal(decoded.event.quoteAmount, 250_000_001n);
  assert.equal(decoded.event.isBuy, true);
  assert.equal(decoded.event.creatorFee, 750_000n);
  assert.equal(decoded.event.shareholders[0]?.shareBps, 1_250n);
  assert.equal(decoded.event.ixName, 'buy_exact_quote_in');
});

void test('ignore un mauvais programme, tag Anchor ou événement inconnu', () => {
  const create = createEventInstruction();
  assert.equal(decodePumpCpiEvent({
    ...create,
    programId: address(8),
  }), null);
  assert.equal(decodePumpCpiEvent({
    ...create,
    data: Uint8Array.from([0, ...create.data.slice(1)]),
  }), null);
  assert.equal(decodePumpCpiEvent(eventInstruction(
    Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    Buffer.alloc(0),
  )), null);
});

void test('échoue explicitement sur un événement connu tronqué', () => {
  const trade = tradeEventInstruction();
  assert.throws(
    () => decodePumpCpiEvent({
      ...trade,
      data: trade.data.slice(0, -1),
    }),
    (error: unknown) =>
      error instanceof PumpDecodingError
      && error.code === 'PUMP_BORSH_TRUNCATED',
  );
});

void test('conserve les octets finaux d’une extension append-only', () => {
  const decoded = decodePumpCpiEvent(tradeEventInstruction(
    Uint8Array.of(0xaa, 0xbb),
  ));

  assert.ok(decoded);
  assert.equal(decoded.kind, 'TRADE');
  assert.equal(decoded.trailingDataHex, 'aabb');
});

export function createEventInstruction(
  trailing: Uint8Array = new Uint8Array(),
): NormalizedInstruction {
  return eventInstruction(
    Uint8Array.from(PUMP_EVENTS.CreateEvent.discriminator),
    encodeNamedType('CreateEvent', CREATE_VALUES),
    trailing,
  );
}

export function tradeEventInstruction(
  trailing: Uint8Array = new Uint8Array(),
  overrides: Readonly<Record<string, unknown>> = {},
): NormalizedInstruction {
  return eventInstruction(
    Uint8Array.from(PUMP_EVENTS.TradeEvent.discriminator),
    encodeNamedType('TradeEvent', { ...TRADE_VALUES, ...overrides }),
    trailing,
  );
}

function eventInstruction(
  discriminator: Uint8Array,
  payload: Uint8Array,
  trailing: Uint8Array = new Uint8Array(),
): NormalizedInstruction {
  return {
    programId: PUMP_PROGRAM,
    accounts: [address(9)],
    data: Uint8Array.from([
      ...anchorEventTag(),
      ...discriminator,
      ...payload,
      ...trailing,
    ]),
    instructionIndex: 2,
    innerInstructionIndex: 1,
    parentInstructionIndex: 2,
    stackHeight: 2,
  };
}

function anchorEventTag(): Uint8Array {
  return Uint8Array.from(
    createHash('sha256')
      .update('anchor:event')
      .digest()
      .subarray(0, 8),
  ).reverse();
}

function encodeNamedType(
  name: keyof typeof PUMP_TYPES,
  values: Readonly<Record<string, unknown>>,
): Buffer {
  const definition = PUMP_TYPES[name].type;
  if (definition.kind !== 'struct' || !Array.isArray(definition.fields)) {
    throw new Error(`Type de test ${name} invalide.`);
  }
  return encodeFields(definition.fields, values);
}

function encodeFields(
  fields: readonly unknown[],
  values: Readonly<Record<string, unknown>>,
): Buffer {
  return Buffer.concat(fields.map((field) => {
    if (!isRecord(field) || typeof field.name !== 'string') {
      throw new Error('Champ nommé attendu.');
    }
    return encodeValue(field.type, values[field.name]);
  }));
}

function encodeValue(type: unknown, value: unknown): Buffer {
  if (type === 'bool') return Buffer.from([value === true ? 1 : 0]);
  if (type === 'u16') return encodeInteger(value, 2, true);
  if (type === 'u64') return encodeInteger(value, 8, true);
  if (type === 'i64') return encodeInteger(value, 8, false);
  if (type === 'string') {
    if (typeof value !== 'string') throw new Error('String de test invalide.');
    const text = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(text.length);
    return Buffer.concat([length, text]);
  }
  if (type === 'pubkey') {
    if (typeof value !== 'string') throw new Error('Pubkey de test invalide.');
    return new PublicKey(value).toBuffer();
  }
  if (isRecord(type) && isRecord(type.defined)) {
    const name = type.defined.name;
    if (typeof name !== 'string' || !(name in PUMP_TYPES)) {
      throw new Error('Type défini de test invalide.');
    }
    const definition = PUMP_TYPES[name as keyof typeof PUMP_TYPES].type;
    if (
      !isRecord(definition)
      || definition.kind !== 'struct'
      || !Array.isArray(definition.fields)
    ) {
      throw new Error('Struct de test invalide.');
    }
    const fields: readonly unknown[] = definition.fields;
    if (fields.every(isNamedField)) {
      if (!isRecord(value)) throw new Error('Objet struct de test invalide.');
      return encodeFields(fields, value);
    }
    if (!Array.isArray(value)) throw new Error('Tuple struct de test invalide.');
    return Buffer.concat(fields.map((field, index) =>
      encodeValue(field, value[index])));
  }
  if (isRecord(type) && Object.hasOwn(type, 'vec')) {
    if (!Array.isArray(value)) throw new Error('Vec de test invalide.');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(value.length);
    return Buffer.concat([
      length,
      ...value.map((item) => encodeValue(type.vec, item)),
    ]);
  }
  throw new Error(`Type de test inconnu: ${JSON.stringify(type)}.`);
}

function encodeInteger(
  value: unknown,
  bytes: 2 | 8,
  unsigned: boolean,
): Buffer {
  if (typeof value !== 'bigint') throw new Error('Entier de test invalide.');
  const result = Buffer.alloc(bytes);
  if (bytes === 2) result.writeUInt16LE(Number(value));
  else if (unsigned) result.writeBigUInt64LE(value);
  else result.writeBigInt64LE(value);
  return result;
}

function address(seed: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => seed)).toBase58();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNamedField(
  value: unknown,
): value is { readonly name: string; readonly type: unknown } {
  return isRecord(value) && typeof value.name === 'string';
}
