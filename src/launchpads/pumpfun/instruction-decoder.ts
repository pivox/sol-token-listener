import type { NormalizedInstruction } from '../../solana/rpc/types.js';
import { PumpBorshReader } from './borsh-reader.js';
import { PUMP_PROGRAM_ID } from './constants.js';
import { PumpDecodingError } from './errors.js';
import { PUMP_INSTRUCTIONS } from './generated/pump-idl.js';
import { decodeIdlFields } from './idl-codec.js';
import type {
  DecodedPumpInstruction,
  PumpInstructionFamily,
  PumpInstructionName,
} from './types.js';

interface InstructionDefinition {
  readonly discriminator: readonly number[];
  readonly accounts: readonly { readonly name: string }[];
  readonly args: readonly { readonly name: string; readonly type: unknown }[];
}

const DEFINITIONS = PUMP_INSTRUCTIONS as unknown as Readonly<
  Record<PumpInstructionName, InstructionDefinition>
>;
const DEFINITION_BY_DISCRIMINATOR = new Map(
  (Object.entries(DEFINITIONS) as [
    PumpInstructionName,
    InstructionDefinition,
  ][]).map(([name, definition]) => [
    toHex(Uint8Array.from(definition.discriminator)),
    { name, definition },
  ]),
);

export function decodePumpInstruction(
  instruction: NormalizedInstruction,
): DecodedPumpInstruction | null {
  if (
    instruction.programId !== PUMP_PROGRAM_ID
    || instruction.data.length < 8
  ) {
    return null;
  }

  const matched = DEFINITION_BY_DISCRIMINATOR.get(
    toHex(instruction.data.subarray(0, 8)),
  );
  if (matched === undefined) return null;

  const accounts = mapAccounts(
    matched.name,
    matched.definition,
    instruction,
  );
  const reader = new PumpBorshReader(instruction.data.subarray(8));
  const args = decodeIdlFields(matched.definition.args, reader);
  if (reader.remaining !== 0) {
    throw new PumpDecodingError(
      'PUMP_BORSH_INVALID',
      false,
      `Instruction Pump ${matched.name} avec ${reader.remaining} octet(s) résiduel(s).`,
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

function mapAccounts(
  name: PumpInstructionName,
  definition: InstructionDefinition,
  instruction: NormalizedInstruction,
): Readonly<Record<string, string>> {
  if (instruction.accounts.length < definition.accounts.length) {
    throw new PumpDecodingError(
      'PUMP_ACCOUNT_MISSING',
      true,
      `Instruction Pump ${name}: ${instruction.accounts.length}/${definition.accounts.length} comptes.`,
    );
  }

  const entries = definition.accounts.map((account, index) => {
    const address = instruction.accounts[index];
    if (address === undefined) {
      throw new PumpDecodingError(
        'PUMP_ACCOUNT_MISSING',
        true,
        `Compte Pump ${account.name} absent à l’index ${index}.`,
      );
    }
    return [account.name, address] as const;
  });

  const remainingCount =
    instruction.accounts.length - definition.accounts.length;
  if (name === 'create_v2') {
    if (remainingCount !== 0 && remainingCount !== 3) {
      throw new PumpDecodingError(
        'PUMP_ACCOUNT_MISSING',
        true,
        `create_v2 attend zéro ou trois remaining accounts, reçu ${remainingCount}.`,
      );
    }
    if (remainingCount === 3) {
      const quoteMint = instruction.accounts[definition.accounts.length];
      const quoteCurve = instruction.accounts[definition.accounts.length + 1];
      const quoteProgram = instruction.accounts[definition.accounts.length + 2];
      if (
        quoteMint === undefined
        || quoteCurve === undefined
        || quoteProgram === undefined
      ) {
        throw new PumpDecodingError(
          'PUMP_ACCOUNT_MISSING',
          true,
          'Remaining accounts create_v2 incomplets.',
        );
      }
      entries.push(
        ['quote_mint', quoteMint],
        ['associated_quote_bonding_curve', quoteCurve],
        ['quote_token_program', quoteProgram],
      );
    }
  }

  return Object.freeze(Object.fromEntries(entries));
}

function familyOf(name: PumpInstructionName): PumpInstructionFamily {
  switch (name) {
    case 'create':
    case 'create_v2':
      return 'CREATE';
    case 'buy':
    case 'buy_exact_quote_in_v2':
    case 'buy_exact_sol_in':
    case 'buy_v2':
      return 'BUY';
    case 'sell':
    case 'sell_v2':
      return 'SELL';
  }
}

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}
