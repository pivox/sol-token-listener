import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { isProxy } from 'node:util/types';
import type {
  EffectiveQualificationProfile,
  QualificationConditionMode,
  QualificationConditionPolicy,
  QualificationDimension,
  QualificationRule,
  QualificationSignalKey,
} from '../domain/qualification.js';
import { QUALIFICATION_DIMENSIONS, QUALIFICATION_SIGNAL_KEYS } from '../domain/qualification.js';
import { QUALIFICATION_REASON_CODES, type QualificationReasonCode } from '../domain/qualification-reasons.js';
import { canonicalStringifyJson } from '../utils/json.js';

const MAX_PROFILE_BYTES = 65_536;
const MAX_PROFILE_PATH_BYTES = 4_096;
const MAX_PROFILE_JSON_DEPTH = 64;
const MAX_PROFILE_JSON_NODES = 10_000;
const TOP_LEVEL_FIELDS = ['schemaVersion', 'id', 'version', 'status', 'minimumTotalScore', 'dimensionMaximums', 'rules', 'conditionPolicies'] as const;
const EFFECTIVE_PROFILE_FIELDS = ['schemaVersion', 'fingerprint', 'id', 'version', 'status', 'minimumTotalScore', 'dimensionMaximums', 'rules', 'conditionPolicies'] as const;
const RULE_FIELDS = ['signal', 'dimension', 'weight', 'required', 'message'] as const;
const POLICY_FIELDS = ['code', 'mode', 'maximumTop1Bps', 'maximumTop5Bps', 'maximumTop10Bps', 'maximumClusterBps', 'minimumSharedFunders', 'maximumRoundTripLossBps'] as const;
const MODES = new Set<QualificationConditionMode>(['DISABLED', 'REPORT_ONLY', 'ENFORCED']);
const DIMENSIONS = new Set<string>(QUALIFICATION_DIMENSIONS);
const SIGNALS = new Set<string>(QUALIFICATION_SIGNAL_KEYS);
const REASONS = new Set<string>(QUALIFICATION_REASON_CODES);

type ProfileReadResult =
  | { readonly kind: 'ok'; readonly contents: Buffer }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'failed' };

export type QualificationProfileErrorCode =
  | 'PROFILE_READ_FAILED'
  | 'PROFILE_TOO_LARGE'
  | 'PROFILE_JSON_INVALID'
  | 'PROFILE_SCHEMA_INVALID';

export class QualificationProfileError extends Error {
  readonly code: QualificationProfileErrorCode;

  constructor(code: QualificationProfileErrorCode) {
    super(code);
    this.name = 'QualificationProfileError';
    this.code = code;
  }
}

export interface LoadQualificationProfileOptions {
  readonly profilePath: string | null;
  readonly minimumScoreOverride: number | null;
  readonly workingDirectory?: string;
  readonly readFile?: (path: string | URL) => Buffer;
}

export function loadQualificationProfile(options: LoadQualificationProfileOptions): EffectiveQualificationProfile {
  const path = options.profilePath === null
    ? new URL('../../config/qualification/pumpfun-v1-unvalidated.json', import.meta.url)
    : resolveProfilePath(options.profilePath, options.workingDirectory ?? process.cwd());
  const contents = readProfileBytes(path, options.readFile);
  return parseQualificationProfileJson(contents, options.minimumScoreOverride);
}

export function parseQualificationProfileJson(contents: Buffer, minimumScoreOverride: number | null): EffectiveQualificationProfile {
  if (isProxy(contents) || !Buffer.isBuffer(contents)) throw new QualificationProfileError('PROFILE_JSON_INVALID');
  if (contents.byteLength > MAX_PROFILE_BYTES) throw new QualificationProfileError('PROFILE_TOO_LARGE');
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    validateJsonText(text);
    parsed = JSON.parse(text);
    freezeJsonSnapshot(parsed);
  } catch {
    throw new QualificationProfileError('PROFILE_JSON_INVALID');
  }
  return parseQualificationProfile(parsed, minimumScoreOverride);
}

function readProfileBytes(path: string | URL, readFile: LoadQualificationProfileOptions['readFile']): Buffer {
  const result = readFile === undefined ? readBoundedFile(path) : readInjectedFile(path, readFile);
  if (result.kind === 'too_large') throw new QualificationProfileError('PROFILE_TOO_LARGE');
  if (result.kind === 'failed') throw new QualificationProfileError('PROFILE_READ_FAILED');
  return result.contents;
}

function readInjectedFile(path: string | URL, readFile: NonNullable<LoadQualificationProfileOptions['readFile']>): ProfileReadResult {
  let raw: unknown;
  try {
    raw = readFile(path);
  } catch {
    return { kind: 'failed' };
  }
  try {
    if (isProxy(raw) || !Buffer.isBuffer(raw)) return { kind: 'failed' };
    if (raw.byteLength > MAX_PROFILE_BYTES) return { kind: 'too_large' };
    return { kind: 'ok', contents: Buffer.from(raw) };
  } catch {
    return { kind: 'failed' };
  }
}

function readBoundedFile(path: string | URL): ProfileReadResult {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return { kind: 'failed' };
    if (stats.size > MAX_PROFILE_BYTES) return { kind: 'too_large' };
    const contents = Buffer.allocUnsafe(MAX_PROFILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < contents.length) {
      const read = readSync(descriptor, contents, bytesRead, contents.length - bytesRead, null);
      if (read === 0) break;
      bytesRead += read;
    }
    return bytesRead > MAX_PROFILE_BYTES
      ? { kind: 'too_large' }
      : { kind: 'ok', contents: contents.subarray(0, bytesRead) };
  } catch {
    return { kind: 'failed' };
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* A read result cannot safely recover from close failure. */ }
    }
  }
}

export function parseQualificationProfile(rawProfile: unknown, minimumScoreOverride: number | null): EffectiveQualificationProfile {
  try {
    const raw = exactObject(rawProfile, TOP_LEVEL_FIELDS);
    if (raw.schemaVersion !== 1 || raw.status !== 'UNVALIDATED_RULE_SET') invalid();
    const id = boundedString(raw.id, 1, 160);
    const version = safeInteger(raw.version, 1, Number.MAX_SAFE_INTEGER);
    const minimumTotalScore = minimumScoreOverride === null
      ? safeInteger(raw.minimumTotalScore, 0, 100)
      : safeInteger(minimumScoreOverride, 0, 100);
    const dimensionMaximums = parseMaximums(raw.dimensionMaximums);
    const rules = parseRules(raw.rules, dimensionMaximums);
    const conditionPolicies = parsePolicies(raw.conditionPolicies);
    const withoutFingerprint = { schemaVersion: 1 as const, id, version, status: 'UNVALIDATED_RULE_SET' as const, minimumTotalScore, dimensionMaximums, rules, conditionPolicies };
    const fingerprint = createHash('sha256').update(canonicalStringifyJson(withoutFingerprint)).digest('hex');
    return freeze({ ...withoutFingerprint, fingerprint });
  } catch (error) {
    if (error instanceof QualificationProfileError) throw error;
    throw new QualificationProfileError('PROFILE_SCHEMA_INVALID');
  }
}

/** Validates a loaded profile before it is consumed outside the profile loader. */
export function assertValidEffectiveQualificationProfile(profile: unknown): asserts profile is EffectiveQualificationProfile {
  try {
    const raw = exactObject(profile, EFFECTIVE_PROFILE_FIELDS);
    if (raw.schemaVersion !== 1 || raw.status !== 'UNVALIDATED_RULE_SET') invalid();
    const id = boundedString(raw.id, 1, 160);
    const version = safeInteger(raw.version, 1, Number.MAX_SAFE_INTEGER);
    const minimumTotalScore = safeInteger(raw.minimumTotalScore, 0, 100);
    if (typeof raw.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.fingerprint)) invalid();
    const dimensionMaximums = parseMaximums(raw.dimensionMaximums);
    const rules = parseRules(raw.rules, dimensionMaximums);
    const conditionPolicies = parsePolicies(raw.conditionPolicies);
    const canonical = { schemaVersion: 1 as const, id, version, status: 'UNVALIDATED_RULE_SET' as const, minimumTotalScore, dimensionMaximums, rules, conditionPolicies };
    const fingerprint = createHash('sha256').update(canonicalStringifyJson(canonical)).digest('hex');
    if (raw.fingerprint !== fingerprint) invalid();
  } catch (error) {
    if (error instanceof QualificationProfileError) throw error;
    throw new QualificationProfileError('PROFILE_SCHEMA_INVALID');
  }
}

function resolveProfilePath(profilePath: string, workingDirectory: string): string {
  if (typeof profilePath !== 'string' || profilePath.length === 0 || Buffer.byteLength(profilePath, 'utf8') > MAX_PROFILE_PATH_BYTES || profilePath.includes('\0')) {
    throw new QualificationProfileError('PROFILE_SCHEMA_INVALID');
  }
  if (profilePath.includes('://')) throw new QualificationProfileError('PROFILE_SCHEMA_INVALID');
  try { return resolve(workingDirectory, profilePath); } catch { throw new QualificationProfileError('PROFILE_SCHEMA_INVALID'); }
}

function parseMaximums(value: unknown): Readonly<Record<QualificationDimension, number>> {
  const fields = exactObject(value, QUALIFICATION_DIMENSIONS);
  const result = {
    preparation: safeInteger(fields.preparation, 15, 15),
    socialAuthenticity: safeInteger(fields.socialAuthenticity, 25, 25),
    onchainHealth: safeInteger(fields.onchainHealth, 60, 60),
  };
  return freeze(result);
}

function parseRules(value: unknown, maxima: Readonly<Record<QualificationDimension, number>>): readonly QualificationRule[] {
  const entries = exactArray(value);
  const signals = new Set<string>();
  const totals: Record<QualificationDimension, number> = { preparation: 0, socialAuthenticity: 0, onchainHealth: 0 };
  const rules = entries.map((entry) => {
    const fields = exactObject(entry, RULE_FIELDS);
    if (typeof fields.signal !== 'string' || !SIGNALS.has(fields.signal) || signals.has(fields.signal)) invalid();
    if (typeof fields.dimension !== 'string' || !DIMENSIONS.has(fields.dimension)) invalid();
    const dimension = fields.dimension as QualificationDimension;
    const weight = safeInteger(fields.weight, 0, 100);
    if (typeof fields.required !== 'boolean') invalid();
    const rule: QualificationRule = { signal: fields.signal as QualificationSignalKey, dimension, weight, required: fields.required, message: boundedString(fields.message, 1, 280) };
    signals.add(rule.signal); totals[dimension] += weight;
    return freeze(rule);
  });
  for (const dimension of QUALIFICATION_DIMENSIONS) if (totals[dimension] !== maxima[dimension]) invalid();
  return freeze([...rules].sort((left, right) => left.signal.localeCompare(right.signal)));
}

function parsePolicies(value: unknown): readonly QualificationConditionPolicy[] {
  const entries = exactArray(value);
  if (entries.length !== QUALIFICATION_REASON_CODES.length) invalid();
  const seen = new Set<string>();
  const policies = entries.map((entry) => {
    const fields = exactObject(entry, POLICY_FIELDS);
    if (typeof fields.code !== 'string' || !REASONS.has(fields.code) || seen.has(fields.code)) invalid();
    if (typeof fields.mode !== 'string' || !MODES.has(fields.mode as QualificationConditionMode)) invalid();
    const code = fields.code as QualificationReasonCode;
    const policy: QualificationConditionPolicy = {
      code, mode: fields.mode as QualificationConditionMode,
      maximumTop1Bps: nullableBps(fields.maximumTop1Bps), maximumTop5Bps: nullableBps(fields.maximumTop5Bps), maximumTop10Bps: nullableBps(fields.maximumTop10Bps),
      maximumClusterBps: nullableBps(fields.maximumClusterBps), minimumSharedFunders: nullablePositive(fields.minimumSharedFunders), maximumRoundTripLossBps: nullableBps(fields.maximumRoundTripLossBps),
    };
    validatePolicyThresholds(policy); seen.add(code); return freeze(policy);
  });
  if (seen.size !== QUALIFICATION_REASON_CODES.length) invalid();
  return freeze([...policies].sort((left, right) => QUALIFICATION_REASON_CODES.indexOf(left.code) - QUALIFICATION_REASON_CODES.indexOf(right.code)));
}

function validatePolicyThresholds(policy: QualificationConditionPolicy): void {
  const holder = policy.code === 'HOLDER_CONCENTRATION_EXCEEDED';
  const related = policy.code === 'RELATED_WALLET_CLUSTER_EXCEEDED';
  const shared = policy.code === 'SHARED_FUNDER_CLUSTER';
  const loss = policy.code === 'ROUND_TRIP_LOSS_EXCEEDED';
  if ((!holder && (policy.maximumTop1Bps !== null || policy.maximumTop5Bps !== null || policy.maximumTop10Bps !== null)) || (!related && policy.maximumClusterBps !== null) || (!shared && policy.minimumSharedFunders !== null) || (!loss && policy.maximumRoundTripLossBps !== null) || (shared && policy.minimumSharedFunders === null) || (loss && policy.maximumRoundTripLossBps === null)) invalid();
}

function exactObject(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value) || !Object.isFrozen(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== expected.length || expected.some((field) => !Object.hasOwn(descriptors, field))) invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of expected) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result[field] = descriptor.value;
  }
  return result;
}

function exactArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || !Object.isFrozen(value) || Object.getOwnPropertySymbols(value).length !== 0) invalid();
  if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  return result;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) invalid();
  return value;
}
function nullableBps(value: unknown): number | null { return value === null ? null : safeInteger(value, 0, 10_000); }
function nullablePositive(value: unknown): number | null { return value === null ? null : safeInteger(value, 1, 10_000); }
function boundedString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.trim() !== value || hasControlCharacter(value)) invalid();
  return value;
}
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 31 || point === 127)) return true;
  }
  return false;
}
function invalid(): never { throw new QualificationProfileError('PROFILE_SCHEMA_INVALID'); }

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') Object.freeze(value);
  return value;
}

type JsonFrame =
  | { readonly kind: 'array'; state: 'valueOrEnd' | 'value' | 'commaOrEnd' }
  | { readonly kind: 'object'; state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd'; readonly keys: Set<string> };

function validateJsonText(text: string): void {
  const frames: JsonFrame[] = [];
  let rootState: 'value' | 'end' = 'value';
  let index = 0;
  let nodes = 0;

  const consumeValue = (): void => {
    nodes += 1;
    if (nodes > MAX_PROFILE_JSON_NODES) throw new Error('too many JSON nodes');
    const character = text[index];
    if (character === '"') {
      index = scanJsonString(text, index).end;
    } else if (character === '{' || character === '[') {
      if (frames.length >= MAX_PROFILE_JSON_DEPTH) throw new Error('JSON nesting is too deep');
      frames.push(character === '{'
        ? { kind: 'object', state: 'keyOrEnd', keys: new Set<string>() }
        : { kind: 'array', state: 'valueOrEnd' });
      index += 1;
    } else if (character === 't') {
      index = scanLiteral(text, index, 'true');
    } else if (character === 'f') {
      index = scanLiteral(text, index, 'false');
    } else if (character === 'n') {
      index = scanLiteral(text, index, 'null');
    } else {
      index = scanJsonNumber(text, index);
    }
  };

  for (;;) {
    index = skipJsonWhitespace(text, index);
    const frame = frames.at(-1);
    if (frame === undefined) {
      if (rootState === 'end') {
        if (index !== text.length) throw new Error('unexpected trailing JSON');
        return;
      }
      if (index >= text.length) throw new Error('missing JSON value');
      rootState = 'end';
      consumeValue();
      continue;
    }

    if (frame.kind === 'object') {
      if (frame.state === 'keyOrEnd' || frame.state === 'key') {
        if (frame.state === 'keyOrEnd' && text[index] === '}') {
          frames.pop();
          index += 1;
          continue;
        }
        if (text[index] !== '"') throw new Error('missing JSON object key');
        const key = scanJsonString(text, index);
        if (frame.keys.has(key.value)) throw new Error('duplicate JSON object key');
        frame.keys.add(key.value);
        frame.state = 'colon';
        index = key.end;
        continue;
      }
      if (frame.state === 'colon') {
        if (text[index] !== ':') throw new Error('missing JSON object colon');
        frame.state = 'value';
        index += 1;
        continue;
      }
      if (frame.state === 'value') {
        frame.state = 'commaOrEnd';
        consumeValue();
        continue;
      }
      if (text[index] === ',') {
        frame.state = 'key';
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        frames.pop();
        index += 1;
        continue;
      }
      throw new Error('invalid JSON object separator');
    }

    if (frame.state === 'valueOrEnd' && text[index] === ']') {
      frames.pop();
      index += 1;
      continue;
    }
    if (frame.state === 'valueOrEnd' || frame.state === 'value') {
      frame.state = 'commaOrEnd';
      consumeValue();
      continue;
    }
    if (text[index] === ',') {
      frame.state = 'value';
      index += 1;
      continue;
    }
    if (text[index] === ']') {
      frames.pop();
      index += 1;
      continue;
    }
    throw new Error('invalid JSON array separator');
  }
}

function scanJsonString(text: string, start: number): { readonly value: string; readonly end: number } {
  let value = '';
  let index = start + 1;
  let segmentStart = index;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      value += text.slice(segmentStart, index);
      return { value, end: index + 1 };
    }
    if (code < 0x20) throw new Error('invalid JSON string control character');
    if (code !== 0x5c) {
      index += 1;
      continue;
    }
    value += text.slice(segmentStart, index);
    index += 1;
    const escape = text[index];
    if (escape === undefined) throw new Error('unterminated JSON escape');
    const simpleEscape = JSON_SIMPLE_ESCAPES[escape];
    if (simpleEscape !== undefined) {
      value += simpleEscape;
      index += 1;
    } else if (escape === 'u') {
      const hexadecimal = text.slice(index + 1, index + 5);
      if (!/^[0-9a-fA-F]{4}$/u.test(hexadecimal)) throw new Error('invalid JSON unicode escape');
      value += String.fromCharCode(Number.parseInt(hexadecimal, 16));
      index += 5;
    } else {
      throw new Error('invalid JSON escape');
    }
    segmentStart = index;
  }
  throw new Error('unterminated JSON string');
}

const JSON_SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
});

function scanLiteral(text: string, start: number, literal: 'true' | 'false' | 'null'): number {
  if (!text.startsWith(literal, start)) throw new Error('invalid JSON literal');
  return start + literal.length;
}

function scanJsonNumber(text: string, start: number): number {
  let index = start;
  if (text[index] === '-') index += 1;
  if (text[index] === '0') {
    index += 1;
    if (isDigit(text[index])) throw new Error('invalid JSON leading zero');
  } else {
    if (!isNonZeroDigit(text[index])) throw new Error('invalid JSON value');
    while (isDigit(text[index])) index += 1;
  }
  if (text[index] === '.') {
    index += 1;
    if (!isDigit(text[index])) throw new Error('invalid JSON fraction');
    while (isDigit(text[index])) index += 1;
  }
  if (text[index] === 'e' || text[index] === 'E') {
    index += 1;
    if (text[index] === '+' || text[index] === '-') index += 1;
    if (!isDigit(text[index])) throw new Error('invalid JSON exponent');
    while (isDigit(text[index])) index += 1;
  }
  return index;
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}

function isNonZeroDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '1' && value <= '9';
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (text[index] === ' ' || text[index] === '\n' || text[index] === '\r' || text[index] === '\t') index += 1;
  return index;
}

function freezeJsonSnapshot(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  const pending: { readonly value: object; readonly depth: number; readonly visited: boolean }[] = [
    { value, depth: 1, visited: false },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.visited) {
      Object.freeze(current.value);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_PROFILE_JSON_NODES || current.depth > MAX_PROFILE_JSON_DEPTH) throw new Error('JSON snapshot is too complex');
    pending.push({ ...current, visited: true });
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current.value))) {
      const child: unknown = 'value' in descriptor ? descriptor.value : null;
      if (child !== null && typeof child === 'object') pending.push({ value: child, depth: current.depth + 1, visited: false });
    }
  }
}
