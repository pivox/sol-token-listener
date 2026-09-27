import { Buffer } from 'node:buffer';
import { isProxy } from 'node:util/types';

export const MAX_PUMP_WIRE_BYTES = 1_232;
const MAX_PUMP_IDL_NAME_BYTES = 64;

export const TERMINAL_DIAGNOSTIC_CODES = Object.freeze([
  'PUMP_BORSH_INVALID',
  'WALLET_GRAPH_POSTGRES_SERIALIZATION',
  'WALLET_GRAPH_POSTGRES_DEADLOCK',
  'WALLET_GRAPH_LAUNCH_MISSING',
  'WALLET_GRAPH_DATA_INVALID',
  'WALLET_GRAPH_ANALYSIS_INVALID',
  'WALLET_GRAPH_PERSISTENCE_UNKNOWN',
  'PUMPSWAP_MUTABLE_RPC_UNAVAILABLE',
  'PUMPSWAP_RPC_CONTEXT_INVALID',
  'PUMPSWAP_MUTABLE_ACCOUNT_DECODING',
  'PUMPSWAP_MARKET_POOL_MISMATCH',
  'PUMPSWAP_MARKET_POOL_NON_CANONICAL',
  'PUMPSWAP_UNSUPPORTED_TOKEN_EXTENSION',
  'PUMPSWAP_PERSISTENCE_UNKNOWN',
  'UNAVAILABLE',
] as const);

export const TERMINAL_ATTRIBUTION_CAUSE_KINDS = Object.freeze([
  'PUMP_DECODER',
  'LOCATOR',
  'NORMALIZATION',
  'PUMP_MINT_LIMIT',
  'PUMP_MULTI_MINT',
] as const);

/** Pinned from the official Pump IDL revision used by the generated adapters. */
export const PUMP_WIRE_IDL_NAMES = Object.freeze([
  'buy',
  'buy_exact_quote_in_v2',
  'buy_exact_sol_in',
  'buy_v2',
  'create',
  'create_v2',
  'migrate',
  'migrate_v2',
  'sell',
  'sell_v2',
  'CreateEvent',
  'TradeEvent',
  'UNKNOWN_DISCRIMINATOR',
] as const);

export type TerminalDiagnosticCode = (typeof TERMINAL_DIAGNOSTIC_CODES)[number];
export type TerminalAttributionCauseKind =
  (typeof TERMINAL_ATTRIBUTION_CAUSE_KINDS)[number];
export type PumpWireSurface = 'INSTRUCTION' | 'CPI_EVENT';
export type PumpWireLocation = 'OUTER' | 'INNER';

export interface PumpWireAttributionV1 {
  readonly surface: PumpWireSurface;
  readonly location: PumpWireLocation;
  readonly discriminatorHex: string;
  readonly idlName: string;
  readonly totalBytes: number;
  readonly payloadBytes: number;
  readonly suffixBytes: number | null;
}

export interface TerminalAttributionV1 {
  readonly version: 1;
  readonly diagnosticCode: TerminalDiagnosticCode;
  readonly causeKind: TerminalAttributionCauseKind | null;
  readonly pumpWire: PumpWireAttributionV1 | null;
}

const ATTRIBUTION_FIELDS = Object.freeze([
  'version', 'diagnosticCode', 'causeKind', 'pumpWire',
] as const);
const PUMP_WIRE_FIELDS = Object.freeze([
  'surface', 'location', 'discriminatorHex', 'idlName',
  'totalBytes', 'payloadBytes', 'suffixBytes',
] as const);
const diagnosticCodes = new Set<unknown>(TERMINAL_DIAGNOSTIC_CODES);
const causeKinds = new Set<unknown>(TERMINAL_ATTRIBUTION_CAUSE_KINDS);
const pumpWireIdlNames = new Set<string>(PUMP_WIRE_IDL_NAMES);
const trustedAttributions = new WeakMap<object, TerminalAttributionV1>();

export function createTerminalAttribution(input: unknown): TerminalAttributionV1 {
  const fields = exactDataFields(input, ATTRIBUTION_FIELDS);
  if (fields.version !== 1
    || !diagnosticCodes.has(fields.diagnosticCode)
    || (fields.causeKind !== null && !causeKinds.has(fields.causeKind))) {
    invalidAttribution();
  }

  const diagnosticCode = fields.diagnosticCode as TerminalDiagnosticCode;
  const causeKind = fields.causeKind as TerminalAttributionCauseKind | null;
  const pumpWire = fields.pumpWire === null
    ? null
    : snapshotPumpWire(fields.pumpWire);
  const isPumpWireDiagnostic = diagnosticCode === 'PUMP_BORSH_INVALID';
  if (isPumpWireDiagnostic !== (pumpWire !== null)
    || (isPumpWireDiagnostic && causeKind !== 'PUMP_DECODER')) {
    invalidAttribution();
  }

  return Object.freeze({ version: 1, diagnosticCode, causeKind, pumpWire });
}

/** @internal Registers evidence only at a boundary that already authenticated the identity. */
export function registerTrustedTerminalAttribution(
  identity: object,
  input: unknown,
): TerminalAttributionV1 {
  if (isProxy(identity) || trustedAttributions.has(identity)) invalidAttribution();
  const attribution = createTerminalAttribution(input);
  trustedAttributions.set(identity, attribution);
  return attribution;
}

/** Exact identity only: this never reads properties, prototypes or cause chains. */
export function trustedTerminalAttribution(value: unknown): TerminalAttributionV1 | null {
  return typeof value === 'object' && value !== null
    ? trustedAttributions.get(value) ?? null
    : null;
}

/** @internal A wrapper may inherit only evidence registered on the exact source identity. */
export function inheritTrustedTerminalAttribution(target: object, source: unknown): void {
  if (isProxy(target)) return;
  const attribution = trustedTerminalAttribution(source);
  if (attribution !== null && !trustedAttributions.has(target)) {
    trustedAttributions.set(target, attribution);
  }
}

/** @internal Attaches trusted evidence without extending a frozen durable contract. */
export function attachTrustedTerminalAttribution(target: object, source: unknown): void {
  if (isProxy(target)
    || !Object.isFrozen(target)
    || (Object.getPrototypeOf(target) !== Object.prototype
      && Object.getPrototypeOf(target) !== null)) {
    invalidAttribution();
  }
  const attribution = trustedTerminalAttribution(source);
  if (attribution === null || trustedAttributions.has(target)) invalidAttribution();
  trustedAttributions.set(target, attribution);
}

function snapshotPumpWire(input: unknown): PumpWireAttributionV1 {
  const fields = exactDataFields(input, PUMP_WIRE_FIELDS);
  if ((fields.surface !== 'INSTRUCTION' && fields.surface !== 'CPI_EVENT')
    || (fields.location !== 'OUTER' && fields.location !== 'INNER')
    || typeof fields.discriminatorHex !== 'string'
    || !/^[0-9a-f]{16}$/u.test(fields.discriminatorHex)
    || typeof fields.idlName !== 'string'
    || !isPumpIdlName(fields.idlName)
    || !isBoundedByteLength(fields.totalBytes)
    || !isBoundedByteLength(fields.payloadBytes)
    || (fields.suffixBytes !== null && !isBoundedByteLength(fields.suffixBytes))) {
    invalidAttribution();
  }
  const headerBytes = fields.surface === 'INSTRUCTION' ? 8 : 16;
  if (fields.totalBytes < headerBytes
    || fields.payloadBytes !== fields.totalBytes - headerBytes
    || (fields.suffixBytes !== null && fields.suffixBytes > fields.payloadBytes)) {
    invalidAttribution();
  }
  return Object.freeze({
    surface: fields.surface,
    location: fields.location,
    discriminatorHex: fields.discriminatorHex,
    idlName: fields.idlName,
    totalBytes: fields.totalBytes,
    payloadBytes: fields.payloadBytes,
    suffixBytes: fields.suffixBytes,
  });
}

function exactDataFields<const TFields extends readonly string[]>(
  input: unknown,
  expectedFields: TFields,
): Record<TFields[number], unknown> {
  try {
    if (typeof input !== 'object'
      || input === null
      || Array.isArray(input)
      || isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
      invalidAttribution();
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expectedFields.length
      || keys.some((key) => typeof key !== 'string' || !expectedFields.includes(key))) {
      invalidAttribution();
    }
    const fields = {} as Record<TFields[number], unknown>;
    for (const field of expectedFields) {
      const descriptor = descriptors[field];
      if (descriptor === undefined
        || !('value' in descriptor)
        || descriptor.enumerable !== true) {
        invalidAttribution();
      }
      const descriptorValue: unknown = descriptor.value as unknown;
      fields[field as TFields[number]] = descriptorValue;
    }
    return fields;
  } catch {
    invalidAttribution();
  }
}

function isPumpIdlName(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= MAX_PUMP_IDL_NAME_BYTES
    && pumpWireIdlNames.has(value);
}

function isBoundedByteLength(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
    && value <= MAX_PUMP_WIRE_BYTES;
}

function invalidAttribution(): never {
  throw new TypeError('Invalid terminal attribution.');
}
