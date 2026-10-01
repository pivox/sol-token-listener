import { Buffer } from 'node:buffer';
import { isProxy } from 'node:util/types';
import {
  OBSERVED_PIPELINE_ORIGIN_CODES,
  type ObservedPipelineOriginCode,
} from './observed-pipeline-taxonomy.js';

export const MAX_PUMP_WIRE_BYTES = 1_232;
const MAX_PUMP_IDL_NAME_BYTES = 64;

export const TERMINAL_DIAGNOSTIC_CODES = Object.freeze([
  'PUMP_BORSH_INVALID',
  'FUNDING_OBSERVATION_VALIDATE',
  'FUNDING_OBSERVATION_EXTRACT',
  'FUNDING_OBSERVATION_RECORD',
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
  'QUALIFICATION_CONNECT_FAILED',
  'QUALIFICATION_POSTGRES_SERIALIZATION',
  'QUALIFICATION_POSTGRES_DEADLOCK',
  'QUALIFICATION_DATA_INVALID',
  'QUALIFICATION_LAUNCH_MISSING',
  'QUALIFICATION_REBUILD_UNKNOWN',
  'QUALIFICATION_PERSISTENCE_UNKNOWN',
  'QUALIFICATION_CLEANUP_FAILED',
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

export interface TerminalAttributionLocatorV1 {
  readonly signature: string;
  readonly slot: bigint;
  readonly transactionIndex: number | null;
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized' | 'orphaned';
  readonly instructionIndex: number | null;
  readonly innerInstructionIndex: number | null;
}

export interface TerminalAttributionContextV1 {
  readonly originCode: Exclude<ObservedPipelineOriginCode, 'UNKNOWN'> | null;
  readonly locator: TerminalAttributionLocatorV1;
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
const trustedContexts = new WeakMap<object, TerminalAttributionContextV1>();

/** @internal Only trusted boundaries may register immutable public-chain provenance. */
export function registerTrustedTerminalAttributionContext(
  identity: object,
  input: unknown,
): TerminalAttributionContextV1 {
  if (isProxy(identity) || trustedContexts.has(identity)) invalidAttribution();
  const fields = exactDataFields(input, ['originCode', 'locator'] as const);
  if (fields.originCode !== null
    && (fields.originCode === 'UNKNOWN'
      || !OBSERVED_PIPELINE_ORIGIN_CODES.some((code) => code === fields.originCode))) {
    invalidAttribution();
  }
  const locator = exactDataFields(fields.locator, [
    'signature', 'slot', 'transactionIndex', 'confirmationStatus',
    'instructionIndex', 'innerInstructionIndex',
  ] as const);
  if (typeof locator.signature !== 'string' || locator.signature.length === 0
    || locator.signature.trim() !== locator.signature
    || Buffer.byteLength(locator.signature, 'utf8') > 128
    || typeof locator.slot !== 'bigint' || locator.slot < 0n
    || locator.slot > BigInt(Number.MAX_SAFE_INTEGER)
    || !nullableIndex(locator.transactionIndex) || !nullableIndex(locator.instructionIndex)
    || !nullableIndex(locator.innerInstructionIndex)
    || (locator.instructionIndex === null && locator.innerInstructionIndex !== null)
    || (locator.confirmationStatus !== 'processed' && locator.confirmationStatus !== 'confirmed'
      && locator.confirmationStatus !== 'finalized' && locator.confirmationStatus !== 'orphaned')) {
    invalidAttribution();
  }
  const context: TerminalAttributionContextV1 = Object.freeze({
    originCode: fields.originCode as TerminalAttributionContextV1['originCode'],
    locator: Object.freeze({
      signature: locator.signature, slot: locator.slot, transactionIndex: locator.transactionIndex,
      confirmationStatus: locator.confirmationStatus, instructionIndex: locator.instructionIndex,
      innerInstructionIndex: locator.innerInstructionIndex,
    }),
  });
  trustedContexts.set(identity, context);
  return context;
}

/** Exact identity only, including hostile and revoked proxies. */
export function trustedTerminalAttributionContext(value: unknown): TerminalAttributionContextV1 | null {
  return typeof value === 'object' && value !== null ? trustedContexts.get(value) ?? null : null;
}

function nullableIndex(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && !Object.is(value, -0));
}

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
    || (isPumpWireDiagnostic && causeKind !== 'PUMP_DECODER')
    || (diagnosticCode.startsWith('QUALIFICATION_') && causeKind !== null)) {
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
  const context = trustedTerminalAttributionContext(source);
  if (context !== null && !trustedContexts.has(target)) trustedContexts.set(target, context);
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
  const context = trustedTerminalAttributionContext(source);
  if ((attribution === null && context === null)
    || trustedAttributions.has(target) || trustedContexts.has(target)) invalidAttribution();
  if (attribution !== null) trustedAttributions.set(target, attribution);
  if (context !== null) trustedContexts.set(target, context);
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
