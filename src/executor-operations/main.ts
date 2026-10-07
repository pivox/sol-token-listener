import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifySignedSafetyQualificationEvidence } from '../domain/execution-safety-attestation.js';
import { verifySignedExecutionCanaryEvidence } from '../domain/execution-canary-attestation.js';
import {
  createEnvelopeQualificationDraft,
  createExecutionPreflightDraftSource,
} from '../domain/execution-preflight-draft.js';
import { createExecutionRiskPolicy } from '../domain/execution-risk-policy.js';
import { canonicalStringifyJson, parseJson } from '../utils/json.js';
import {
  parseExecutionCanaryArmConfig,
  parseExecutionEnvelopeConfig,
  parseExecutionOperationsConfig,
  type ExecutionEnvelopeConfig,
} from './config.js';
import { openExecutionOperationsDatabase } from './database.js';
import {
  createExecutionOperationsService,
  ExecutionEnvelopeCommandError,
  type ExecutionEnvelopeCommandErrorCode,
  type ExecutionOperationsService,
} from './service.js';
import {
  createNodeOperatorTerminal,
  createOperatorNonce,
  type OperatorTerminal,
} from './terminal.js';

interface CommandDependencies {
  readonly service: ExecutionOperationsService;
  readonly terminal: OperatorTerminal;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly now: () => number;
}

const MAX_CANARY_EVIDENCE_ENVELOPE_BYTES = 196_608;
const MAX_QUALIFICATION_EVIDENCE_BYTES = 131_072;
const MAX_GATE_CATALOG_BYTES = 1_048_576;
const ENVELOPE_CREATE_OPTIONS = Object.freeze([
  'per-buy-lamports', 'max-buys', 'max-exposure-lamports', 'max-loss-lamports', 'holding-ms',
]);

export class ExecutionOperationsCliError extends Error {
  public readonly code = 'INVALID_EXECUTION_OPERATIONS_COMMAND' as const;
  /** Set only for refusals the operator must tell apart; the message stays fixed. */
  public readonly reason: ExecutionEnvelopeCommandErrorCode | null;

  public constructor(reason: ExecutionEnvelopeCommandErrorCode | null = null) {
    super('Execution operations command failed.');
    this.name = 'ExecutionOperationsCliError';
    this.reason = reason;
  }
}

export async function runExecutionOperationsCommand(
  argv: readonly string[],
  environment: unknown,
  dependencies: CommandDependencies,
): Promise<string> {
  try {
    const config = parseExecutionOperationsConfig(environment);
    const command = singleCommand(argv);
    const nowMs = timestamp(dependencies.now());
    switch (command.name) {
      case 'preflight': {
        requireNoOptions(command.options);
        const encoded = await dependencies.readTextFile(config.evidencePath);
        if (Buffer.byteLength(encoded, 'utf8') > MAX_QUALIFICATION_EVIDENCE_BYTES) throw invalid();
        const qualificationDraft = verifySignedSafetyQualificationEvidence(
          JSON.parse(encoded) as unknown,
          config.evidencePublicKeyBase64,
        );
        // An ENVELOPE qualification is only ever persisted by `envelope create`, bound to it.
        if (qualificationDraft.payloadVersion !== 1) throw invalid();
        assertQualificationBinding(qualificationDraft, config, nowMs);
        const qualification = await dependencies.service.preflight(qualificationDraft);
        return JSON.stringify({
          payloadVersion: 1, command: 'preflight',
          qualificationId: qualification.qualificationId,
          qualificationFingerprint: qualification.qualificationFingerprint,
          phase: qualification.phase, expiresAtMs: qualification.expiresAtMs,
          paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
          liveCapabilityPresent: false,
        });
      }
      case 'status':
      case 'report': {
        requireNoOptions(command.options);
        return statusJson(command.name, await dependencies.service.status(config.generationId));
      }
      case 'kill-switch': {
        const modeValue = requiredOption(command.options, 'mode');
        const reason = requiredOption(command.options, 'reason');
        const mode = modeValue === 'entry-stop' ? 'ENTRY_STOP'
          : modeValue === 'hard-stop' ? 'HARD_STOP' : null;
        if (mode === null || reason !== (mode === 'ENTRY_STOP'
          ? 'OPERATOR_ENTRY_STOP' : 'OPERATOR_HARD_STOP')) throw invalid();
        requireOnly(command.options, ['mode', 'reason']);
        const status = await dependencies.service.stop({
          payloadVersion: 1,
          commandId: commandId('kill-switch', mode, nowMs),
          generationId: config.generationId,
          operatorId: config.operatorId,
          occurredAtMs: nowMs,
        }, mode);
        return statusJson('kill-switch', status);
      }
      case 'arm': {
        const arm = armOnlyCommand(command.options);
        const armConfig = parseExecutionCanaryArmConfig(environment);
        const encoded = await dependencies.readTextFile(armConfig.canaryEvidencePath);
        if (Buffer.byteLength(encoded, 'utf8') > MAX_CANARY_EVIDENCE_ENVELOPE_BYTES) throw invalid();
        const evidence = verifySignedExecutionCanaryEvidence(
          Object.freeze(JSON.parse(encoded) as Record<string, unknown>),
          armConfig.evidencePublicKeyBase64,
        );
        if (arm.intentId !== evidence.targetIntentId) throw invalid();
        const sourceEncoded = await dependencies.readTextFile(armConfig.preflightSourcePath);
        if (Buffer.byteLength(sourceEncoded, 'utf8') > MAX_CANARY_EVIDENCE_ENVELOPE_BYTES) throw invalid();
        const decodedSource = parseJson(sourceEncoded);
        if (canonicalStringifyJson(decodedSource) !== sourceEncoded) throw invalid();
        const preflightSource = createExecutionPreflightDraftSource(deepFreeze(decodedSource));
        if (preflightSource.schemaVersion !== 'execution-preflight-draft-source.v2'
          || preflightSource.target.intent.id !== arm.intentId) throw invalid();
        assertQualificationBinding(evidence.qualification, armConfig, nowMs);
        const armament = await dependencies.service.arm({
          payloadVersion: 3, evidence, preflightSource, intentId: arm.intentId,
          maximumCapitalLamports: arm.maximumCapitalLamports,
          maximumHoldingMs: arm.maximumHoldingMs,
          runtimeQuoteMaxAgeMs: armConfig.runtimeQuoteMaxAgeMs,
          runtimeSlippageBps: armConfig.runtimeSlippageBps,
          runtimeSnapshotMaxSlotLag: armConfig.runtimeSnapshotMaxSlotLag,
          runtimeMaxComputeUnits: armConfig.runtimeMaxComputeUnits,
          runtimeMaxFeeLamports: armConfig.runtimeMaxFeeLamports,
          runtimeMaxFeePayerLamportDebit: armConfig.runtimeMaxFeePayerLamportDebit,
          runtimeMaxRpcCallsPerAttempt: armConfig.runtimeMaxRpcCallsPerAttempt,
          runtimeLeaseMs: armConfig.runtimeLeaseMs,
          operatorId: armConfig.operatorId,
          operatorReason: arm.operatorReason,
          nowMs,
          terminal: dependencies.terminal,
        });
        if (armament.payloadVersion !== 2) throw invalid();
        return JSON.stringify({
          payloadVersion: 3, command: 'arm', armamentId: armament.armamentId,
          admissionReportId: armament.admissionReportId, reservationId: armament.reservationId,
          state: armament.state, phase: 'CANARY', expiresAtMs: armament.armamentExpiresAtMs,
          canaryStatus: 'CANARY_NOT_STARTED',
          paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
          liveCapabilityPresent: false,
        });
      }
      case 'resume': {
        requireNoOptions(command.options);
        const status = await dependencies.service.status(config.generationId);
        if (status.latestQualificationId === null) throw invalid();
        const resumed = await dependencies.service.resume({
          payloadVersion: 1,
          commandId: commandId('resume', status.latestQualificationId, nowMs),
          qualificationId: status.latestQualificationId,
          operatorId: config.operatorId,
          nowMs,
          terminal: dependencies.terminal,
        });
        return statusJson('resume', resumed);
      }
      case 'envelope-prepare': {
        requireOnly(command.options, ['valid-ms']);
        const validMs = decimalInteger(requiredOption(command.options, 'valid-ms'),
          3_600_000, 86_400_000);
        const envelopeConfig = parseExecutionEnvelopeConfig(environment);
        const catalog = await readGateCatalog(dependencies, envelopeConfig);
        const facts = await dependencies.service.prepareEnvelopeFacts(envelopeConfig.generationId, {
          buildHash: envelopeConfig.buildHash,
          configurationFingerprint: envelopeConfig.configurationFingerprint,
          walletPublicKey: envelopeConfig.walletPublicKey,
          providerId: envelopeConfig.providerId,
          genesisHash: envelopeConfig.genesisHash,
        });
        if (facts === null) throw new ExecutionEnvelopeCommandError('ENVELOPE_FACTS_UNAVAILABLE');
        if (facts.generation.generationId !== envelopeConfig.generationId) throw invalid();
        return canonicalStringifyJson(createEnvelopeQualificationDraft({
          catalog,
          generation: facts.generation,
          providerId: envelopeConfig.providerId,
          simulation: facts.simulation,
          qualifiedAtMs: facts.databaseNowMs,
          expiresAtMs: facts.databaseNowMs + validMs,
        }));
      }
      case 'envelope-create': {
        const limits = envelopeCreateOptions(command.options);
        const envelopeConfig = parseExecutionEnvelopeConfig(environment);
        const encoded = await dependencies.readTextFile(envelopeConfig.evidencePath);
        if (Buffer.byteLength(encoded, 'utf8') > MAX_QUALIFICATION_EVIDENCE_BYTES) throw invalid();
        const qualification = verifySignedSafetyQualificationEvidence(
          JSON.parse(encoded) as unknown,
          envelopeConfig.evidencePublicKeyBase64,
        );
        if (qualification.payloadVersion !== 2) throw invalid();
        assertQualificationBinding(qualification, envelopeConfig, nowMs);
        const catalog = await readGateCatalog(dependencies, envelopeConfig);
        const envelope = await dependencies.service.createEnvelope({
          payloadVersion: 1, qualification,
          policy: createExecutionRiskPolicy(catalog.policy),
          operatorId: envelopeConfig.operatorId,
          ...limits,
          terminal: dependencies.terminal,
        });
        return JSON.stringify({
          payloadVersion: 1, command: 'envelope-create', envelopeId: envelope.envelopeId,
          validUntilMs: envelope.validUntilMs,
          perBuyQuoteAmountRaw: envelope.perBuyQuoteAmountRaw.toString(),
          maxBuys: envelope.maxBuys, qualificationId: envelope.qualificationId,
          liveCapabilityPresent: false,
        });
      }
      case 'envelope-revoke': {
        requireOnly(command.options, ['envelope-id']);
        const envelopeId = requiredOption(command.options, 'envelope-id');
        if (!/^execution_entry_envelope_[0-9a-f]{64}$/u.test(envelopeId)) throw invalid();
        const revocation = await dependencies.service.revokeEnvelope({
          generationId: config.generationId, envelopeId,
          operatorId: config.operatorId, occurredAtMs: nowMs,
        });
        return JSON.stringify({
          payloadVersion: 1, command: 'envelope-revoke', envelopeId: revocation.envelopeId,
          state: revocation.state, replayed: revocation.replayed,
          armamentRevoked: revocation.armamentRevoked, databaseNowMs: revocation.databaseNowMs,
          liveCapabilityPresent: false,
        });
      }
      case 'envelope-show': {
        requireNoOptions(command.options);
        const envelopes = await dependencies.service.readEnvelopes(config.generationId);
        return JSON.stringify({
          payloadVersion: 1, command: 'envelope-show', envelopes,
          liveCapabilityPresent: false,
        }, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
      }
    }
  } catch (error) {
    throw invalid(error instanceof ExecutionEnvelopeCommandError ? error.code : null);
  }
}

export async function main(): Promise<void> {
  const config = parseExecutionOperationsConfig(process.env);
  const database = openExecutionOperationsDatabase({
    databaseUrl: config.databaseUrl,
    statementTimeoutMs: 3_000,
    onIdleError: () => { database.evict(); },
  });
  const service = createExecutionOperationsService({
    repository: database.repository,
    canaryRepository: database.repository,
    envelopeRepository: database.repository,
    nonceSource: createOperatorNonce,
  });
  try {
    const output = await runExecutionOperationsCommand(process.argv.slice(2), process.env, {
      service,
      terminal: createNodeOperatorTerminal(),
      readTextFile: async (path) => readFile(path, 'utf8'),
      now: Date.now,
    });
    process.stdout.write(`${output}\n`);
  } finally {
    await database.close();
  }
}

type CommandName = 'preflight' | 'status' | 'report' | 'kill-switch' | 'arm' | 'resume'
  | 'envelope-prepare' | 'envelope-create' | 'envelope-revoke' | 'envelope-show';

function singleCommand(argv: readonly string[]): Readonly<{
  name: CommandName;
  options: ReadonlyMap<string, string>;
}> {
  const [first, ...rest] = argv;
  let name: CommandName;
  let encodedOptions: readonly string[];
  if (first === 'envelope') {
    const [subCommand, ...envelopeOptions] = rest;
    if (subCommand !== 'prepare' && subCommand !== 'create' && subCommand !== 'revoke'
      && subCommand !== 'show') throw invalid();
    name = `envelope-${subCommand}`;
    encodedOptions = envelopeOptions;
  } else {
    if (first !== 'preflight' && first !== 'status' && first !== 'report'
      && first !== 'kill-switch' && first !== 'arm' && first !== 'resume') throw invalid();
    name = first;
    encodedOptions = rest;
  }
  const options = new Map<string, string>();
  for (const encoded of encodedOptions) {
    const match = /^--([a-z][a-z-]{0,31})=(.{1,256})$/u.exec(encoded);
    if (match === null) throw invalid();
    const [, key, value] = match;
    if (key === undefined || value === undefined || options.has(key)) throw invalid();
    options.set(key, value);
  }
  return Object.freeze({ name, options });
}

function requireNoOptions(options: ReadonlyMap<string, string>): void {
  if (options.size !== 0) throw invalid();
}

function requireOnly(options: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const key of options.keys()) if (!allowed.includes(key)) throw invalid();
}

function requiredOption(options: ReadonlyMap<string, string>, key: string): string {
  const value = options.get(key);
  if (value === undefined) throw invalid();
  return value;
}

function armOnlyCommand(options: ReadonlyMap<string, string>): Readonly<{
  intentId: string;
  maximumCapitalLamports: bigint;
  maximumHoldingMs: number;
  operatorReason: string;
}> {
  requireOnly(options, ['intent-id', 'maximum-lamports', 'holding-ms', 'reason']);
  if (options.size !== 4) throw invalid();
  const intentId = requiredOption(options, 'intent-id');
  if (!/^execution_intent_[0-9a-f]{64}$/u.test(intentId)) throw invalid();
  const operatorReason = requiredOption(options, 'reason');
  if (!/^[\x20-\x7E]{1,256}$/u.test(operatorReason)) throw invalid();
  return Object.freeze({ intentId,
    maximumCapitalLamports: positiveU64(requiredOption(options, 'maximum-lamports')),
    maximumHoldingMs: decimalInteger(requiredOption(options, 'holding-ms'), 30_000, 900_000),
    operatorReason });
}

function envelopeCreateOptions(options: ReadonlyMap<string, string>): Readonly<{
  perBuyQuoteAmountRaw: bigint;
  maxBuys: number;
  maxTotalExposureRaw: bigint;
  maxRealizedLossRaw: bigint;
  maximumHoldingMs: number;
}> {
  requireOnly(options, ENVELOPE_CREATE_OPTIONS);
  if (options.size !== ENVELOPE_CREATE_OPTIONS.length) throw invalid();
  return Object.freeze({
    perBuyQuoteAmountRaw: positiveU64(requiredOption(options, 'per-buy-lamports')),
    maxBuys: decimalInteger(requiredOption(options, 'max-buys'), 1, 1_000),
    maxTotalExposureRaw: positiveU64(requiredOption(options, 'max-exposure-lamports')),
    maxRealizedLossRaw: positiveU64(requiredOption(options, 'max-loss-lamports')),
    maximumHoldingMs: decimalInteger(requiredOption(options, 'holding-ms'), 30_000, 900_000),
  });
}

/** The H2g gate catalog: canonical JSON whose strategy is this runtime's. */
async function readGateCatalog(
  dependencies: CommandDependencies,
  config: ExecutionEnvelopeConfig,
): Promise<Readonly<{ policy: unknown }> & Readonly<Record<string, unknown>>> {
  const encoded = await dependencies.readTextFile(config.gateCatalogPath);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_GATE_CATALOG_BYTES) throw invalid();
  const decoded = parseJson(encoded);
  if (canonicalStringifyJson(decoded) !== encoded || typeof decoded !== 'object'
    || decoded === null || Array.isArray(decoded)) throw invalid();
  const catalog = deepFreeze(decoded) as Readonly<Record<string, unknown>>;
  if (catalog.strategyFingerprint !== config.strategyFingerprint) throw invalid();
  return catalog as Readonly<{ policy: unknown }> & Readonly<Record<string, unknown>>;
}

function positiveU64(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) throw invalid();
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw invalid();
  return parsed;
}

function decimalInteger(value: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw invalid();
  return parsed;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > 8_640_000_000_000_000) throw invalid();
  return value as number;
}

function commandId(kind: string, identity: string, nowMs: number): string {
  return `command:${kind}:${createHash('sha256').update(JSON.stringify([
    'execution-operations-command-v1', kind, identity, nowMs,
  ])).digest('hex')}`;
}

function assertQualificationBinding(
  qualification: ReturnType<typeof verifySignedSafetyQualificationEvidence>,
  config: ReturnType<typeof parseExecutionOperationsConfig>,
  nowMs: number,
): void {
  if (qualification.phase !== config.phase
    || qualification.buildHash !== config.buildHash
    || qualification.configurationFingerprint !== config.configurationFingerprint
    || qualification.strategyFingerprint !== config.strategyFingerprint
    || qualification.generationId !== config.generationId
    || qualification.walletPublicKey !== config.walletPublicKey
    || qualification.genesisHash !== config.genesisHash
    || qualification.providerId !== config.providerId
    || qualification.qualifiedAtMs > nowMs
    || qualification.expiresAtMs <= nowMs) throw invalid();
}

function statusJson(command: string, status: Awaited<ReturnType<
  ExecutionOperationsService['status']
>>): string {
  return JSON.stringify({
    payloadVersion: 1, command,
    controlState: status.controlState,
    controlRevision: status.controlRevision.toString(),
    latestQualificationId: status.latestQualificationId,
    latestQualificationExpiresAtMs: status.latestQualificationExpiresAtMs,
    activeArmamentId: status.activeArmamentId,
    activeArmamentPhase: status.activeArmamentPhase,
    activeArmamentExpiresAtMs: status.activeArmamentExpiresAtMs,
    paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
    liveCapabilityPresent: false,
  });
}

function invalid(reason: ExecutionEnvelopeCommandErrorCode | null = null): ExecutionOperationsCliError {
  return new ExecutionOperationsCliError(reason);
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    process.exitCode = 1;
    const reason = error instanceof ExecutionOperationsCliError ? error.reason : null;
    process.stderr.write(`${JSON.stringify({
      service: 'sol-token-executor-operations',
      event: 'executor.operations_failed',
      errorCode: 'EXECUTION_OPERATIONS_FAILED',
      ...(reason === null ? {} : { reason }),
    })}\n`);
  });
}
