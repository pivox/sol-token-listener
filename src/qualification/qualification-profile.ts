import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
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
const TOP_LEVEL_FIELDS = ['schemaVersion', 'id', 'version', 'status', 'minimumTotalScore', 'dimensionMaximums', 'rules', 'conditionPolicies'] as const;
const RULE_FIELDS = ['signal', 'dimension', 'weight', 'required', 'message'] as const;
const POLICY_FIELDS = ['code', 'mode', 'maximumTop1Bps', 'maximumTop5Bps', 'maximumTop10Bps', 'maximumClusterBps', 'minimumSharedFunders', 'maximumRoundTripLossBps'] as const;
const MODES = new Set<QualificationConditionMode>(['DISABLED', 'REPORT_ONLY', 'ENFORCED']);
const DIMENSIONS = new Set<string>(QUALIFICATION_DIMENSIONS);
const SIGNALS = new Set<string>(QUALIFICATION_SIGNAL_KEYS);
const REASONS = new Set<string>(QUALIFICATION_REASON_CODES);

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString('utf8'));
  } catch {
    throw new QualificationProfileError('PROFILE_JSON_INVALID');
  }
  return parseQualificationProfile(deepFreeze(parsed), options.minimumScoreOverride);
}

function readProfileBytes(path: string | URL, readFile: LoadQualificationProfileOptions['readFile']): Buffer {
  try {
    const raw: unknown = readFile === undefined ? readBoundedFile(path) : readFile(path);
    if (isProxy(raw) || !Buffer.isBuffer(raw)) throw new QualificationProfileError('PROFILE_READ_FAILED');
    if (raw.byteLength > MAX_PROFILE_BYTES) throw new QualificationProfileError('PROFILE_TOO_LARGE');
    return Buffer.from(raw);
  } catch (error) {
    if (error instanceof QualificationProfileError) throw error;
    throw new QualificationProfileError('PROFILE_READ_FAILED');
  }
}

function readBoundedFile(path: string | URL): Buffer {
  const descriptor = openSync(path, 'r');
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new QualificationProfileError('PROFILE_READ_FAILED');
    if (stats.size > MAX_PROFILE_BYTES) throw new QualificationProfileError('PROFILE_TOO_LARGE');
    const contents = Buffer.allocUnsafe(MAX_PROFILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < contents.length) {
      const read = readSync(descriptor, contents, bytesRead, contents.length - bytesRead, null);
      if (read === 0) break;
      bytesRead += read;
    }
    return contents.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
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
    return deepFreeze({ ...withoutFingerprint, fingerprint });
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
  return deepFreeze(result);
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
    return deepFreeze(rule);
  });
  for (const dimension of QUALIFICATION_DIMENSIONS) if (totals[dimension] !== maxima[dimension]) invalid();
  return deepFreeze([...rules].sort((left, right) => left.signal.localeCompare(right.signal)));
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
    validatePolicyThresholds(policy); seen.add(code); return deepFreeze(policy);
  });
  if (seen.size !== QUALIFICATION_REASON_CODES.length) invalid();
  return deepFreeze([...policies].sort((left, right) => QUALIFICATION_REASON_CODES.indexOf(left.code) - QUALIFICATION_REASON_CODES.indexOf(right.code)));
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
