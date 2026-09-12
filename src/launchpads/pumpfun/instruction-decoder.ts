import { PublicKey } from '@solana/web3.js';
import type { NormalizedInstruction } from '../../solana/rpc/types.js';
import { PumpBorshReader } from './borsh-reader.js';
import { PUMP_PROGRAM_ID } from './constants.js';
import { createPumpDecodingError } from './errors.js';
import { PUMP_INSTRUCTIONS } from './generated/pump-idl.js';
import { decodeIdlFields } from './idl-codec.js';
import type {
  DecodedPumpInstruction,
  PumpIdlValue,
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
const CREATE_V2_REQUIRED_ARGUMENT_COUNT = 5;
const CREATE_V2_SUFFIX_LENGTHS = new Set([0, 1, 9, 10]);
const QUOTE_CONTROL_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from('quote-control')],
  new PublicKey(PUMP_PROGRAM_ID),
)[0].toBase58();

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
  const args = matched.name === 'create_v2'
    ? decodeCreateV2Args(matched.definition, reader)
    : decodeIdlFields(matched.definition.args, reader);
  if (reader.remaining !== 0) {
    throw createPumpDecodingError(
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

function decodeCreateV2Args(
  definition: InstructionDefinition,
  reader: PumpBorshReader,
): Readonly<Record<string, PumpIdlValue>> {
  const required = decodeIdlFields(
    definition.args.slice(0, CREATE_V2_REQUIRED_ARGUMENT_COUNT),
    reader,
  );
  const suffixLength = reader.remaining;
  if (!CREATE_V2_SUFFIX_LENGTHS.has(suffixLength)) {
    throw createPumpDecodingError(
      'PUMP_BORSH_INVALID',
      false,
      `create_v2 attend un suffixe officiel de 0, 1, 9 ou 10 octets, reçu ${suffixLength}.`,
    );
  }

  const cashback = suffixLength >= 1 ? reader.readBool() : false;
  const creatorFeeBps = suffixLength >= 9 ? reader.readU64() : 0n;
  const holderReward = suffixLength === 10 ? reader.readBool() : false;
  return Object.freeze({
    ...required,
    is_cashback_enabled: Object.freeze([cashback]),
    creator_fee_bps: Object.freeze([creatorFeeBps]),
    is_holder_reward: Object.freeze([holderReward]),
  });
}

function mapAccounts(
  name: PumpInstructionName,
  definition: InstructionDefinition,
  instruction: NormalizedInstruction,
): Readonly<Record<string, string>> {
  if (instruction.accounts.length < definition.accounts.length) {
    throw createPumpDecodingError(
      'PUMP_ACCOUNT_MISSING',
      true,
      `Instruction Pump ${name}: ${instruction.accounts.length}/${definition.accounts.length} comptes.`,
    );
  }

  const entries = definition.accounts.map((account, index) => {
    const address = instruction.accounts[index];
    if (address === undefined) {
      throw createPumpDecodingError(
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
    if (remainingCount !== 0 && remainingCount !== 3 && remainingCount !== 4) {
      throw createPumpDecodingError(
        'PUMP_ACCOUNT_MISSING',
        true,
        `create_v2 attend zéro, trois ou quatre remaining accounts, reçu ${remainingCount}.`,
      );
    }
    if (remainingCount >= 3) {
      const quoteMint = instruction.accounts[definition.accounts.length];
      const quoteCurve = instruction.accounts[definition.accounts.length + 1];
      const quoteProgram = instruction.accounts[definition.accounts.length + 2];
      if (
        quoteMint === undefined
        || quoteCurve === undefined
        || quoteProgram === undefined
      ) {
        throw createPumpDecodingError(
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
    if (remainingCount === 4) {
      const quoteControl = instruction.accounts[definition.accounts.length + 3];
      if (quoteControl !== QUOTE_CONTROL_PDA) {
        throw createPumpDecodingError(
          'PUMP_ACCOUNT_MISSING',
          false,
          'Remaining account quote_control create_v2 invalide.',
        );
      }
      entries.push(['quote_control', quoteControl]);
    }
  }

  return Object.freeze(Object.fromEntries(entries));
}

function familyOf(name: PumpInstructionName): PumpInstructionFamily {
  switch (name) {
    case 'create':
    case 'create_v2':
      return 'CREATE';
    case 'migrate':
    case 'migrate_v2':
      return 'MIGRATE';
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
