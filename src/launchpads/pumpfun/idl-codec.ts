import type { PumpBorshReader } from './borsh-reader.js';
import { PumpDecodingError } from './errors.js';
import { PUMP_TYPES } from './generated/pump-idl.js';
import type { PumpIdlValue } from './types.js';

interface NamedField {
  readonly name: string;
  readonly type: unknown;
}

interface TypeDefinition {
  readonly type: unknown;
}

const TYPE_DEFINITIONS = PUMP_TYPES as unknown as Readonly<
  Record<string, TypeDefinition>
>;
const MAX_STRING_BYTES = 1_024;
const MAX_VECTOR_ITEMS = 64;

export function decodeIdlFields(
  fields: unknown,
  reader: PumpBorshReader,
): Readonly<Record<string, PumpIdlValue>> {
  const namedFields = requireNamedFields(fields);
  return freezeRecord(Object.fromEntries(namedFields.map((field) => [
    field.name,
    decodeIdlValue(field.type, reader),
  ])));
}

function decodeIdlValue(
  type: unknown,
  reader: PumpBorshReader,
): PumpIdlValue {
  if (type === 'bool') return reader.readBool();
  if (type === 'u16') return reader.readU16();
  if (type === 'u64') return reader.readU64();
  if (type === 'i64') return reader.readI64();
  if (type === 'pubkey') return reader.readPubkey();
  if (type === 'string') return reader.readString(MAX_STRING_BYTES);

  if (!isRecord(type)) throw unsupportedType(type);

  const defined = type.defined;
  if (isRecord(defined) && typeof defined.name === 'string') {
    return decodeDefinedType(defined.name, reader);
  }

  if (Object.hasOwn(type, 'vec')) {
    const length = reader.readU32Length(MAX_VECTOR_ITEMS);
    const values: PumpIdlValue[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(decodeIdlValue(type.vec, reader));
    }
    return Object.freeze(values);
  }

  throw unsupportedType(type);
}

function decodeDefinedType(
  name: string,
  reader: PumpBorshReader,
): PumpIdlValue {
  const definition = TYPE_DEFINITIONS[name];
  if (definition === undefined || !isRecord(definition.type)) {
    throw unsupportedType({ defined: name });
  }
  if (
    definition.type.kind !== 'struct'
    || !Array.isArray(definition.type.fields)
  ) {
    throw unsupportedType(definition.type);
  }

  if (definition.type.fields.every(isNamedField)) {
    return decodeIdlFields(definition.type.fields, reader);
  }

  const values = definition.type.fields.map((field) =>
    decodeIdlValue(field, reader));
  return Object.freeze(values);
}

function requireNamedFields(fields: unknown): readonly NamedField[] {
  if (!Array.isArray(fields) || !fields.every(isNamedField)) {
    throw unsupportedType(fields);
  }
  return fields;
}

function isNamedField(value: unknown): value is NamedField {
  return (
    isRecord(value)
    && typeof value.name === 'string'
    && Object.hasOwn(value, 'type')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeRecord(
  value: Record<string, PumpIdlValue>,
): Readonly<Record<string, PumpIdlValue>> {
  return Object.freeze(value);
}

function unsupportedType(type: unknown): PumpDecodingError {
  return new PumpDecodingError(
    'PUMP_SCHEMA_UNSUPPORTED',
    false,
    `Type IDL Pump non pris en charge: ${safeStringify(type)}.`,
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
