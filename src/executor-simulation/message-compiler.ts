import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type MessageV0,
} from '@solana/web3.js';
import type { NormalizedInstructionV1 } from './build-plan.js';

export interface CompiledInspectedV0MessageV1 {
  readonly payloadVersion: 1;
  readonly recentBlockhash: string;
  readonly messageHash: string;
  readonly messageBytes: readonly number[];
  readonly unsignedTransactionBytes: readonly number[];
  readonly staticAccountKeys: readonly string[];
  readonly instructionCount: number;
}

export function compileInspectedV0Message(inputValue: Readonly<{
  readonly feePayer: string;
  readonly instructions: readonly NormalizedInstructionV1[];
  readonly recentBlockhash: string;
  readonly maximumTransactionBytes: number;
}>): CompiledInspectedV0MessageV1 {
  try {
    validateInput(inputValue);
    const message = new TransactionMessage({
      payerKey: new PublicKey(inputValue.feePayer),
      recentBlockhash: inputValue.recentBlockhash,
      instructions: inputValue.instructions.map(toInstruction),
    }).compileToV0Message([]);
    assertCompiledMessage(
      message, inputValue.feePayer, inputValue.instructions, inputValue.recentBlockhash,
    );
    const messageBytes = message.serialize();
    const transaction = new VersionedTransaction(message);
    const transactionBytes = transaction.serialize();
    if (transactionBytes.length > inputValue.maximumTransactionBytes
      || transaction.signatures.length !== 1
      || transaction.signatures[0]?.length !== 64
      || !transaction.signatures[0].every((byte) => byte === 0)) reject();
    return Object.freeze({
      payloadVersion: 1,
      recentBlockhash: inputValue.recentBlockhash,
      messageHash: createHash('sha256').update(messageBytes).digest('hex'),
      messageBytes: Object.freeze([...messageBytes]),
      unsignedTransactionBytes: Object.freeze([...transactionBytes]),
      staticAccountKeys: Object.freeze(message.staticAccountKeys.map((key) => key.toBase58())),
      instructionCount: message.compiledInstructions.length,
    });
  } catch {
    throw new TypeError('Invalid inspected v0 message input.');
  }
}

function validateInput(input: unknown): asserts input is Readonly<{
  readonly feePayer: string;
  readonly instructions: readonly NormalizedInstructionV1[];
  readonly recentBlockhash: string;
  readonly maximumTransactionBytes: number;
}> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || isProxy(input)
    || !Object.isFrozen(input)) reject();
  const candidate = input as Readonly<Record<string, unknown>>;
  if (typeof candidate.feePayer !== 'string' || !Array.isArray(candidate.instructions)
    || typeof candidate.recentBlockhash !== 'string'
    || typeof candidate.maximumTransactionBytes !== 'number'
    || !Number.isSafeInteger(candidate.maximumTransactionBytes)
    || candidate.maximumTransactionBytes < 1 || candidate.maximumTransactionBytes > 1_232) reject();
}

function toInstruction(instruction: NormalizedInstructionV1): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(instruction.dataBase64, 'base64'),
  });
}

function assertCompiledMessage(
  message: MessageV0,
  feePayer: string,
  instructions: readonly NormalizedInstructionV1[],
  blockhash: string,
): void {
  if (message.recentBlockhash !== blockhash || message.addressTableLookups.length !== 0
    || message.header.numRequiredSignatures !== 1
    || !message.staticAccountKeys[0]?.equals(new PublicKey(feePayer))
    || message.compiledInstructions.length !== instructions.length) reject();
  const expectedKeys = new Map<string, { signer: boolean; writable: boolean }>([
    [feePayer, { signer: true, writable: true }],
  ]);
  for (const instruction of instructions) {
    expectedKeys.set(
      instruction.programId,
      expectedKeys.get(instruction.programId) ?? { signer: false, writable: false },
    );
    for (const account of instruction.accounts) {
      const current = expectedKeys.get(account.address) ?? { signer: false, writable: false };
      expectedKeys.set(account.address, {
        signer: current.signer || account.isSigner,
        writable: current.writable || account.isWritable,
      });
    }
  }
  if (message.staticAccountKeys.length !== expectedKeys.size
    || message.staticAccountKeys.some((key, index) => {
      const signer = index < message.header.numRequiredSignatures;
      const writable = signer
        ? index < message.header.numRequiredSignatures - message.header.numReadonlySignedAccounts
        : index < message.staticAccountKeys.length - message.header.numReadonlyUnsignedAccounts;
      const expected = expectedKeys.get(key.toBase58()) ?? { signer: !signer, writable: !writable };
      return expected.signer !== signer || expected.writable !== writable;
    })) reject();
  for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex += 1) {
    const expected = instructions[instructionIndex];
    const actual = message.compiledInstructions[instructionIndex];
    if (expected === undefined || actual === undefined
      || actual.programIdIndex >= message.staticAccountKeys.length
      || message.staticAccountKeys[actual.programIdIndex]?.toBase58() !== expected.programId
      || !Buffer.from(actual.data).equals(Buffer.from(expected.dataBase64, 'base64'))
      || actual.accountKeyIndexes.length !== expected.accounts.length) reject();
    for (let accountIndex = 0; accountIndex < expected.accounts.length; accountIndex += 1) {
      const expectedAccount = expected.accounts[accountIndex];
      const keyIndex = actual.accountKeyIndexes[accountIndex];
      if (expectedAccount === undefined || keyIndex === undefined
        || keyIndex >= message.staticAccountKeys.length
        || message.staticAccountKeys[keyIndex]?.toBase58() !== expectedAccount.address) reject();
    }
  }
}

function reject(): never { throw new Error(); }
