import { createHash } from 'node:crypto';
import type { NormalizedInstruction } from '../../solana/rpc/types.js';
import { PumpBorshReader } from './borsh-reader.js';
import { PUMP_PROGRAM_ID } from './constants.js';
import { PumpDecodingError } from './errors.js';
import {
  PUMP_EVENTS,
  PUMP_TYPES,
} from './generated/pump-idl.js';
import { decodeIdlFields } from './idl-codec.js';
import type {
  DecodedPumpCpiEvent,
  DecodedPumpCreateEvent,
  DecodedPumpShareholder,
  DecodedPumpTradeEvent,
  PumpIdlObject,
  PumpIdlValue,
} from './types.js';

const DISCRIMINATOR_LENGTH = 8;
const EVENT_HEADER_LENGTH = DISCRIMINATOR_LENGTH * 2;
const ANCHOR_EVENT_CPI_TAG = Uint8Array.from(
  createHash('sha256')
    .update('anchor:event')
    .digest()
    .subarray(0, DISCRIMINATOR_LENGTH),
).reverse();

export function decodePumpCpiEvent(
  instruction: NormalizedInstruction,
): DecodedPumpCpiEvent | null {
  if (
    instruction.programId !== PUMP_PROGRAM_ID
    || instruction.data.length < EVENT_HEADER_LENGTH
    || !equalBytes(
      instruction.data.subarray(0, DISCRIMINATOR_LENGTH),
      ANCHOR_EVENT_CPI_TAG,
    )
  ) {
    return null;
  }

  const discriminator = instruction.data.subarray(
    DISCRIMINATOR_LENGTH,
    EVENT_HEADER_LENGTH,
  );
  const payload = instruction.data.subarray(EVENT_HEADER_LENGTH);

  if (equalBytes(
    discriminator,
    Uint8Array.from(PUMP_EVENTS.CreateEvent.discriminator),
  )) {
    return decodeCreateEvent(instruction, payload);
  }
  if (equalBytes(
    discriminator,
    Uint8Array.from(PUMP_EVENTS.TradeEvent.discriminator),
  )) {
    return decodeTradeEvent(instruction, payload);
  }
  return null;
}

function decodeCreateEvent(
  instruction: NormalizedInstruction,
  payload: Uint8Array,
): DecodedPumpCpiEvent {
  const reader = new PumpBorshReader(payload);
  const fields = decodeIdlFields(PUMP_TYPES.CreateEvent.type.fields, reader);
  const event: DecodedPumpCreateEvent = Object.freeze({
    name: requireString(fields, 'name'),
    symbol: requireString(fields, 'symbol'),
    uri: requireString(fields, 'uri'),
    mint: requireString(fields, 'mint'),
    bondingCurve: requireString(fields, 'bonding_curve'),
    user: requireString(fields, 'user'),
    creator: requireString(fields, 'creator'),
    timestamp: requireBigInt(fields, 'timestamp'),
    virtualTokenReserves: requireBigInt(fields, 'virtual_token_reserves'),
    virtualSolReserves: requireBigInt(fields, 'virtual_sol_reserves'),
    realTokenReserves: requireBigInt(fields, 'real_token_reserves'),
    tokenTotalSupply: requireBigInt(fields, 'token_total_supply'),
    tokenProgram: requireString(fields, 'token_program'),
    isMayhemMode: requireBoolean(fields, 'is_mayhem_mode'),
    isCashbackEnabled: requireBoolean(fields, 'is_cashback_enabled'),
    quoteMint: requireString(fields, 'quote_mint'),
    virtualQuoteReserves: requireBigInt(
      fields,
      'virtual_quote_reserves',
    ),
  });
  return Object.freeze({
    kind: 'CREATE',
    event,
    instruction,
    trailingDataHex: trailingHex(payload, reader.offset),
  });
}

function decodeTradeEvent(
  instruction: NormalizedInstruction,
  payload: Uint8Array,
): DecodedPumpCpiEvent {
  const reader = new PumpBorshReader(payload);
  const fields = decodeIdlFields(PUMP_TYPES.TradeEvent.type.fields, reader);
  const event: DecodedPumpTradeEvent = Object.freeze({
    mint: requireString(fields, 'mint'),
    solAmount: requireBigInt(fields, 'sol_amount'),
    tokenAmount: requireBigInt(fields, 'token_amount'),
    isBuy: requireBoolean(fields, 'is_buy'),
    user: requireString(fields, 'user'),
    timestamp: requireBigInt(fields, 'timestamp'),
    virtualSolReserves: requireBigInt(fields, 'virtual_sol_reserves'),
    virtualTokenReserves: requireBigInt(fields, 'virtual_token_reserves'),
    realSolReserves: requireBigInt(fields, 'real_sol_reserves'),
    realTokenReserves: requireBigInt(fields, 'real_token_reserves'),
    feeRecipient: requireString(fields, 'fee_recipient'),
    feeBasisPoints: requireBigInt(fields, 'fee_basis_points'),
    fee: requireBigInt(fields, 'fee'),
    creator: requireString(fields, 'creator'),
    creatorFeeBasisPoints: requireBigInt(
      fields,
      'creator_fee_basis_points',
    ),
    creatorFee: requireBigInt(fields, 'creator_fee'),
    trackVolume: requireBoolean(fields, 'track_volume'),
    totalUnclaimedTokens: requireBigInt(fields, 'total_unclaimed_tokens'),
    totalClaimedTokens: requireBigInt(fields, 'total_claimed_tokens'),
    currentSolVolume: requireBigInt(fields, 'current_sol_volume'),
    lastUpdateTimestamp: requireBigInt(fields, 'last_update_timestamp'),
    ixName: requireString(fields, 'ix_name'),
    mayhemMode: requireBoolean(fields, 'mayhem_mode'),
    cashbackFeeBasisPoints: requireBigInt(
      fields,
      'cashback_fee_basis_points',
    ),
    cashback: requireBigInt(fields, 'cashback'),
    buybackFeeBasisPoints: requireBigInt(
      fields,
      'buyback_fee_basis_points',
    ),
    buybackFee: requireBigInt(fields, 'buyback_fee'),
    shareholders: decodeShareholders(fields.shareholders),
    quoteMint: requireString(fields, 'quote_mint'),
    quoteAmount: requireBigInt(fields, 'quote_amount'),
    virtualQuoteReserves: requireBigInt(
      fields,
      'virtual_quote_reserves',
    ),
    realQuoteReserves: requireBigInt(fields, 'real_quote_reserves'),
  });
  return Object.freeze({
    kind: 'TRADE',
    event,
    instruction,
    trailingDataHex: trailingHex(payload, reader.offset),
  });
}

function decodeShareholders(
  value: PumpIdlValue | undefined,
): readonly DecodedPumpShareholder[] {
  if (!isPumpIdlArray(value)) throw invalidField('shareholders');
  return Object.freeze(value.map((item) => {
    if (!isIdlObject(item)) throw invalidField('shareholders');
    return Object.freeze({
      address: requireString(item, 'address'),
      shareBps: requireBigInt(item, 'share_bps'),
    });
  }));
}

function requireString(
  fields: Readonly<Record<string, PumpIdlValue>>,
  name: string,
): string {
  const value = fields[name];
  if (typeof value !== 'string') throw invalidField(name);
  return value;
}

function requireBigInt(
  fields: Readonly<Record<string, PumpIdlValue>>,
  name: string,
): bigint {
  const value = fields[name];
  if (typeof value !== 'bigint') throw invalidField(name);
  return value;
}

function requireBoolean(
  fields: Readonly<Record<string, PumpIdlValue>>,
  name: string,
): boolean {
  const value = fields[name];
  if (typeof value !== 'boolean') throw invalidField(name);
  return value;
}

function invalidField(name: string): PumpDecodingError {
  return new PumpDecodingError(
    'PUMP_SCHEMA_UNSUPPORTED',
    false,
    `Champ d’événement Pump invalide: ${name}.`,
  );
}

function isIdlObject(value: PumpIdlValue): value is PumpIdlObject {
  return typeof value === 'object' && !Array.isArray(value);
}

function isPumpIdlArray(
  value: PumpIdlValue | undefined,
): value is readonly PumpIdlValue[] {
  return Array.isArray(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function trailingHex(payload: Uint8Array, offset: number): string {
  return Buffer.from(payload.subarray(offset)).toString('hex');
}
