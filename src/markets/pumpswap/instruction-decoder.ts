import type { NormalizedInstruction } from '../../solana/rpc/types.js';
import { PumpSwapBorshReader } from './borsh-reader.js';
import { PUMPSWAP_PROGRAM_ID } from './constants.js';
import { PumpSwapDecodingError } from './errors.js';
import { PUMPSWAP_INSTRUCTIONS } from './generated/pumpswap-idl.js';
import type {
  DecodedPumpSwapInstruction,
  PumpSwapIdlValue,
  PumpSwapInstructionFamily,
  PumpSwapInstructionName,
} from './types.js';

interface Definition {
  readonly discriminator: readonly number[];
  readonly accounts: readonly { readonly name: string }[];
  readonly args: readonly { readonly name: string; readonly type: unknown }[];
}
const DEFINITIONS = PUMPSWAP_INSTRUCTIONS as unknown as Readonly<
  Record<PumpSwapInstructionName, Definition>
>;
const BY_DISCRIMINATOR = new Map(
  (Object.entries(DEFINITIONS) as [PumpSwapInstructionName, Definition][])
    .map(([name, definition]) => [
      Buffer.from(definition.discriminator).toString('hex'),
      { name, definition },
    ]),
);

export function decodePumpSwapInstruction(
  instruction: NormalizedInstruction,
): DecodedPumpSwapInstruction | null {
  if (instruction.programId !== PUMPSWAP_PROGRAM_ID || instruction.data.length < 8) {
    return null;
  }
  const matched = BY_DISCRIMINATOR.get(
    Buffer.from(instruction.data.subarray(0, 8)).toString('hex'),
  );
  if (matched === undefined) return null;
  if (instruction.accounts.length < matched.definition.accounts.length) {
    throw new PumpSwapDecodingError(
      'PUMPSWAP_ACCOUNT_MISSING',
      `Instruction ${matched.name}: comptes incomplets.`,
    );
  }
  const accounts = Object.freeze(Object.fromEntries(
    matched.definition.accounts.map((account, index) => [
      account.name,
      requiredAccount(instruction, index, account.name),
    ]),
  ));
  const reader = new PumpSwapBorshReader(instruction.data.subarray(8));
  const args = Object.freeze(Object.fromEntries(
    matched.definition.args.map((argument) => [
      argument.name,
      decodeValue(argument.type, reader),
    ]),
  ));
  if (reader.remaining !== 0) {
    throw new PumpSwapDecodingError(
      'PUMPSWAP_BORSH_INVALID',
      `Instruction ${matched.name}: octets résiduels.`,
    );
  }
  return Object.freeze({
    name: matched.name,
    family: familyOf(matched.name),
    instruction,
    accounts,
    args,
  });
}

function requiredAccount(
  instruction: NormalizedInstruction,
  index: number,
  name: string,
): string {
  const value = instruction.accounts[index];
  if (value === undefined) {
    throw new PumpSwapDecodingError(
      'PUMPSWAP_ACCOUNT_MISSING',
      `Compte PumpSwap ${name} absent à l’index ${index}.`,
    );
  }
  return value;
}

function decodeValue(type: unknown, reader: PumpSwapBorshReader): PumpSwapIdlValue {
  if (type === 'u16') return reader.readU16();
  if (type === 'u64') return reader.readU64();
  if (type === 'pubkey') return reader.readPubkey();
  if (type === 'bool') return reader.readBool();
  if (
    typeof type === 'object'
    && type !== null
    && 'defined' in type
  ) {
    return Object.freeze([reader.readBool()]);
  }
  throw new PumpSwapDecodingError(
    'PUMPSWAP_SCHEMA_UNSUPPORTED',
    `Type d’argument PumpSwap non pris en charge: ${JSON.stringify(type)}.`,
  );
}

function familyOf(name: PumpSwapInstructionName): PumpSwapInstructionFamily {
  if (name === 'create_pool') return 'CREATE_POOL';
  if (name === 'sell') return 'SELL';
  return 'BUY';
}
