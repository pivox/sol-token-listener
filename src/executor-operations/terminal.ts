import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  createOperatorAuthorization,
  createOperatorAuthorizationV2,
  type ExecutionOperatorAuthorizationV1,
  type ExecutionOperatorAuthorizationV2,
} from '../domain/execution-operations.js';
import type { ExecutionLivePhase } from '../domain/execution-safety-qualification.js';

export interface OperatorTerminal {
  readonly isTTY: boolean;
  readonly write: (value: string) => void;
  readonly readLine: () => Promise<string>;
}

export interface AuthorizeOperatorActionV1Input {
  readonly terminal: OperatorTerminal;
  readonly nonceSource: () => string;
  readonly payloadVersion: 1;
  readonly generationId: string;
  readonly walletPublicKey: string;
  readonly action: 'ARM' | 'RESUME';
  readonly phase: ExecutionLivePhase | null;
  readonly contextFingerprint: string;
  readonly operatorId: string;
  readonly nowMs: number;
}

export interface AuthorizeOperatorCanaryArmInput {
  readonly terminal: OperatorTerminal;
  readonly nonceSource: () => string;
  readonly payloadVersion: 2;
  readonly generationId: string;
  readonly walletPublicKey: string;
  readonly action: 'ARM';
  readonly phase: 'CANARY';
  readonly contextFingerprint: string;
  readonly operatorId: string;
  readonly nowMs: number;
  readonly targetIntentId: string;
  readonly targetMint: string;
  readonly targetQuoteMint: string;
  readonly targetQuoteAmountRaw: bigint;
  readonly maximumCapitalLamports: bigint;
  readonly maximumHoldingMs: number;
  readonly expiresAtMs: number;
  readonly policyFingerprint: string;
  readonly walletSnapshotFingerprint: string;
  readonly providerSnapshotFingerprint: string;
  readonly runtimeQuoteMaxAgeMs: number;
  readonly runtimeSlippageBps: bigint;
  readonly runtimeSnapshotMaxSlotLag: number;
  readonly runtimeMaxComputeUnits: bigint;
  readonly runtimeMaxFeeLamports: bigint;
  readonly runtimeMaxFeePayerLamportDebit: bigint;
  readonly runtimeMaxRpcCallsPerAttempt: number;
  readonly runtimeLeaseMs: number;
}

export class ExecutionOperatorTerminalError extends Error {
  public readonly code = 'OPERATOR_AUTHORIZATION_INVALID' as const;

  public constructor() {
    super('Operator authorization failed.');
    this.name = 'ExecutionOperatorTerminalError';
  }
}

export async function authorizeOperatorAction(
  input: AuthorizeOperatorActionV1Input,
): Promise<ExecutionOperatorAuthorizationV1> {
  try {
    if (!input.terminal.isTTY) throw invalid();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(input.walletPublicKey)) throw invalid();
    if ((input.action === 'ARM') !== (input.phase !== null)) throw invalid();
    const nonce = input.nonceSource();
    if (!/^[0-9a-f]{12}$/u.test(nonce)) throw invalid();
    const phase = input.phase ?? 'NONE';
    const walletLabel = input.walletPublicKey.slice(0, 8);
    const expected = `CONFIRM ${input.action} ${phase} ${walletLabel} ${nonce}`;
    input.terminal.write(`${expected}\n`);
    if (await input.terminal.readLine() !== expected) throw invalid();
    const nonceHash = createHash('sha256').update(JSON.stringify([
      'execution-operator-nonce-v1', nonce, input.generationId, input.action,
      input.phase, input.contextFingerprint, input.operatorId, input.nowMs,
    ])).digest('hex');
    return createOperatorAuthorization({
      payloadVersion: input.payloadVersion,
      generationId: input.generationId,
      action: input.action,
      phase: input.phase,
      contextFingerprint: input.contextFingerprint,
      nonceHash,
      operatorId: input.operatorId,
      issuedAtMs: input.nowMs,
      expiresAtMs: input.nowMs + 60_000,
    });
  } catch {
    throw invalid();
  }
}

export async function authorizeCanaryArmament(
  input: AuthorizeOperatorCanaryArmInput,
): Promise<ExecutionOperatorAuthorizationV2> {
  try {
    if (!input.terminal.isTTY) throw invalid();
    const nonce = input.nonceSource();
    if (!/^[0-9a-f]{12}$/u.test(nonce) || !/^[0-9a-f]{64}$/u.test(input.contextFingerprint)
      || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(input.walletPublicKey)
      || !/^execution_intent_[0-9a-f]{64}$/u.test(input.targetIntentId)
      || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(input.targetMint)
      || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(input.targetQuoteMint)
      || typeof input.targetQuoteAmountRaw !== 'bigint' || input.targetQuoteAmountRaw <= 0n
      || typeof input.maximumCapitalLamports !== 'bigint' || input.maximumCapitalLamports <= 0n
      || input.targetQuoteAmountRaw > input.maximumCapitalLamports
      || !Number.isSafeInteger(input.maximumHoldingMs) || input.maximumHoldingMs < 30_000
      || input.maximumHoldingMs > 900_000 || !Number.isSafeInteger(input.expiresAtMs)
      || input.expiresAtMs <= input.nowMs
      || !/^[0-9a-f]{64}$/u.test(input.policyFingerprint)
      || !/^[0-9a-f]{64}$/u.test(input.walletSnapshotFingerprint)
      || !/^[0-9a-f]{64}$/u.test(input.providerSnapshotFingerprint)
      || !Number.isSafeInteger(input.runtimeQuoteMaxAgeMs) || input.runtimeQuoteMaxAgeMs < 1
      || input.runtimeQuoteMaxAgeMs > 60_000 || typeof input.runtimeSlippageBps !== 'bigint'
      || input.runtimeSlippageBps < 0n || input.runtimeSlippageBps > 10_000n
      || !Number.isSafeInteger(input.runtimeSnapshotMaxSlotLag) || input.runtimeSnapshotMaxSlotLag < 0
      || input.runtimeSnapshotMaxSlotLag > 128 || typeof input.runtimeMaxComputeUnits !== 'bigint'
      || input.runtimeMaxComputeUnits < 1n || input.runtimeMaxComputeUnits > 1_400_000n
      || typeof input.runtimeMaxFeeLamports !== 'bigint' || input.runtimeMaxFeeLamports < 0n
      || input.runtimeMaxFeeLamports > 10_000_000n
      || typeof input.runtimeMaxFeePayerLamportDebit !== 'bigint'
      || input.runtimeMaxFeePayerLamportDebit < 0n
      || input.runtimeMaxFeePayerLamportDebit > 10_000_000_000n
      || !Number.isSafeInteger(input.runtimeMaxRpcCallsPerAttempt)
      || input.runtimeMaxRpcCallsPerAttempt < 12 || input.runtimeMaxRpcCallsPerAttempt > 16
      || !Number.isSafeInteger(input.runtimeLeaseMs) || input.runtimeLeaseMs < 3_000
      || input.runtimeLeaseMs > 120_000) throw invalid();
    const phrase = [
    'CONFIRM', 'ARM', 'V2', 'CANARY', input.walletPublicKey, input.targetIntentId,
    input.targetMint, input.targetQuoteMint, input.targetQuoteAmountRaw.toString(),
    input.maximumCapitalLamports.toString(), String(input.maximumHoldingMs), String(input.expiresAtMs),
    input.contextFingerprint, nonce,
    ].join(' ');
    const details = [
    'ARM_DETAILS', 'V2', `policyFingerprint=${input.policyFingerprint}`,
    `walletSnapshotFingerprint=${input.walletSnapshotFingerprint}`,
    `providerSnapshotFingerprint=${input.providerSnapshotFingerprint}`,
    `runtimeQuoteMaxAgeMs=${input.runtimeQuoteMaxAgeMs}`,
    `runtimeSlippageBps=${input.runtimeSlippageBps.toString()}`,
    `runtimeSnapshotMaxSlotLag=${input.runtimeSnapshotMaxSlotLag}`,
    `runtimeMaxComputeUnits=${input.runtimeMaxComputeUnits.toString()}`,
    `runtimeMaxFeeLamports=${input.runtimeMaxFeeLamports.toString()}`,
    `runtimeMaxFeePayerLamportDebit=${input.runtimeMaxFeePayerLamportDebit.toString()}`,
    `runtimeMaxRpcCallsPerAttempt=${input.runtimeMaxRpcCallsPerAttempt}`,
    `runtimeLeaseMs=${input.runtimeLeaseMs}`,
    ].join(' ');
    input.terminal.write(`${details}\n${phrase}\n`);
    if (await input.terminal.readLine() !== phrase) throw invalid();
    const nonceHash = createHash('sha256').update(JSON.stringify([
    'execution-operator-nonce-v2', nonce, input.generationId, input.action,
    input.phase, input.contextFingerprint, input.operatorId, input.nowMs,
    ])).digest('hex');
    return createOperatorAuthorizationV2({
    payloadVersion: 2, generationId: input.generationId, action: input.action,
    phase: input.phase, contextFingerprint: input.contextFingerprint, nonceHash,
    operatorId: input.operatorId, issuedAtMs: input.nowMs, expiresAtMs: input.nowMs + 60_000,
    });
  } catch {
    throw invalid();
  }
}

export function createNodeOperatorTerminal(): OperatorTerminal {
  return Object.freeze({
    isTTY: stdin.isTTY && stdout.isTTY,
    write: (value: string): void => { stdout.write(value); },
    readLine: async (): Promise<string> => {
      const reader = createInterface({ input: stdin, output: stdout });
      try {
        return await reader.question('> ');
      } finally {
        reader.close();
      }
    },
  });
}

export function createOperatorNonce(): string {
  return randomBytes(6).toString('hex');
}

function invalid(): ExecutionOperatorTerminalError {
  return new ExecutionOperatorTerminalError();
}
