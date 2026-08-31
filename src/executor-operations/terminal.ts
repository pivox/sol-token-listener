import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  createOperatorAuthorization,
  type ExecutionOperatorAuthorizationV1,
} from '../domain/execution-operations.js';
import type { ExecutionLivePhase } from '../domain/execution-safety-qualification.js';

export interface OperatorTerminal {
  readonly isTTY: boolean;
  readonly write: (value: string) => void;
  readonly readLine: () => Promise<string>;
}

export interface AuthorizeOperatorActionInput {
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

export class ExecutionOperatorTerminalError extends Error {
  public readonly code = 'OPERATOR_AUTHORIZATION_INVALID' as const;

  public constructor() {
    super('Operator authorization failed.');
    this.name = 'ExecutionOperatorTerminalError';
  }
}

export async function authorizeOperatorAction(
  input: AuthorizeOperatorActionInput,
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
