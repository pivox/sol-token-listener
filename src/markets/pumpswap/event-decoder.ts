import { createHash } from 'node:crypto';
import type { NormalizedInstruction } from '../../solana/rpc/types.js';
import { PumpSwapBorshReader } from './borsh-reader.js';
import { PUMPSWAP_PROGRAM_ID } from './constants.js';
import {
  PUMPSWAP_EVENTS,
  PUMPSWAP_TYPES,
} from './generated/pumpswap-idl.js';
import type {
  DecodedPumpSwapCpiEvent,
  PumpSwapIdlValue,
} from './types.js';
import { PumpSwapDecodingError } from './errors.js';

const EVENT_TAG = Uint8Array.from(
  createHash('sha256').update('anchor:event').digest().subarray(0, 8),
).reverse();
const EVENT_NAMES = ['BuyEvent', 'CreatePoolEvent', 'SellEvent'] as const;

export function decodePumpSwapCpiEvent(
  instruction: NormalizedInstruction,
): DecodedPumpSwapCpiEvent | null {
  if (
    instruction.programId !== PUMPSWAP_PROGRAM_ID
    || instruction.data.length < 16
    || !equal(instruction.data.subarray(0, 8), EVENT_TAG)
  ) {
    return null;
  }
  const name = EVENT_NAMES.find((candidate) =>
    equal(
      instruction.data.subarray(8, 16),
      Uint8Array.from(PUMPSWAP_EVENTS[candidate].discriminator),
    ));
  if (name === undefined) return null;
  const reader = new PumpSwapBorshReader(instruction.data.subarray(16));
  const fields = decodeFields(PUMPSWAP_TYPES[name].type.fields, reader);
  return Object.freeze({
    kind: name === 'BuyEvent'
      ? 'BUY'
      : name === 'SellEvent' ? 'SELL' : 'CREATE_POOL',
    fields,
    instruction,
    trailingDataHex: Buffer.from(
      instruction.data.subarray(16 + reader.offset),
    ).toString('hex'),
  });
}

function decodeFields(
  fields: readonly { readonly name: string; readonly type: unknown }[],
  reader: PumpSwapBorshReader,
): Readonly<Record<string, PumpSwapIdlValue>> {
  return Object.freeze(Object.fromEntries(fields.map((field) => [
    field.name,
    decodeValue(field.type, reader),
  ])));
}

function decodeValue(type: unknown, reader: PumpSwapBorshReader): PumpSwapIdlValue {
  if (type === 'u8') return reader.readU8();
  if (type === 'u16') return reader.readU16();
  if (type === 'u64') return reader.readU64();
  if (type === 'i64') return reader.readI64();
  if (type === 'i128') return reader.readI128();
  if (type === 'bool') return reader.readBool();
  if (type === 'pubkey') return reader.readPubkey();
  if (type === 'string') return reader.readString();
  throw new PumpSwapDecodingError(
    'PUMPSWAP_SCHEMA_UNSUPPORTED',
    `Type d’événement PumpSwap non pris en charge: ${JSON.stringify(type)}.`,
  );
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}
