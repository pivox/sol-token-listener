import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifySignedSafetyQualificationEvidence } from '../domain/execution-safety-attestation.js';
import { verifySignedExecutionCanaryEvidence } from '../domain/execution-canary-attestation.js';
import { parseExecutionCanaryArmConfig, parseExecutionOperationsConfig } from './config.js';
import { openExecutionOperationsDatabase } from './database.js';
import {
  createExecutionOperationsService,
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

export class ExecutionOperationsCliError extends Error {
  public readonly code = 'INVALID_EXECUTION_OPERATIONS_COMMAND' as const;

  public constructor() {
    super('Execution operations command failed.');
    this.name = 'ExecutionOperationsCliError';
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
        if (Buffer.byteLength(encoded, 'utf8') > 131_072) throw invalid();
        const qualificationDraft = verifySignedSafetyQualificationEvidence(
          JSON.parse(encoded) as unknown,
          config.evidencePublicKeyBase64,
        );
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
        assertQualificationBinding(evidence.qualification, armConfig, nowMs);
        const armament = await dependencies.service.arm({
          payloadVersion: 2, evidence, intentId: arm.intentId,
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
          payloadVersion: 2, command: 'arm', armamentId: armament.armamentId,
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
    }
  } catch {
    throw invalid();
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

function singleCommand(argv: readonly string[]): Readonly<{
  name: 'preflight' | 'status' | 'report' | 'kill-switch' | 'arm' | 'resume';
  options: ReadonlyMap<string, string>;
}> {
  const [name, ...encodedOptions] = argv;
  if (name !== 'preflight' && name !== 'status' && name !== 'report'
    && name !== 'kill-switch' && name !== 'arm' && name !== 'resume') throw invalid();
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

function invalid(): ExecutionOperationsCliError {
  return new ExecutionOperationsCliError();
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    process.exitCode = 1;
    process.stderr.write(`${JSON.stringify({
      service: 'sol-token-executor-operations',
      event: 'executor.operations_failed',
      errorCode: 'EXECUTION_OPERATIONS_FAILED',
    })}\n`);
  });
}
