import { PublicKey } from '@solana/web3.js';
import { trustedObservedPipelineOrigin } from '../../domain/observed-pipeline-failure.js';
import { registerTrustedTerminalAttribution } from '../../domain/terminal-attribution.js';
import type { NormalizedInstruction } from '../../solana/rpc/types.js';
import { PumpBorshReader } from './borsh-reader.js';
import { PUMP_PROGRAM_ID } from './constants.js';
import type { PumpDecodingError } from './errors.js';
import { createPumpDecodingError } from './errors.js';
import { PUMP_INSTRUCTIONS } from './generated/pump-idl.js';
import { decodeIdlFields } from './idl-codec.js';
import type {
  DecodedPumpInstruction,
  PumpIdlValue,
  PumpInstructionCandidate,
  PumpInstructionFamily,
  PumpInstructionName,
  PumpObservedWireProfile,
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

  let suffixBytes: number | null = null;
  try {
    return decodeMatchedInstruction(instruction, matched, (length) => { suffixBytes = length; });
  } catch (error) {
    if (trustedObservedPipelineOrigin(error) === 'PUMP_BORSH_INVALID') {
      try {
        registerTrustedTerminalAttribution(error as object, {
          version: 1, diagnosticCode: 'PUMP_BORSH_INVALID', causeKind: 'PUMP_DECODER',
          pumpWire: {
            surface: 'INSTRUCTION',
            location: instruction.innerInstructionIndex === null ? 'OUTER' : 'INNER',
            discriminatorHex: toHex(instruction.data.subarray(0, 8)), idlName: matched.name,
            totalBytes: instruction.data.length, payloadBytes: instruction.data.length - 8,
            suffixBytes,
          },
        });
      } catch { /* Attribution cannot change the decoder decision. */ }
    }
    throw error;
  }
}

/** Transaction-only candidates require event attestation before business use. */
export function decodePumpInstructionForTransaction(
  instruction: NormalizedInstruction,
): PumpInstructionCandidate | null {
  try {
    const action = decodePumpInstruction(instruction);
    return action === null ? null : Object.freeze({ action, profile: null });
  } catch (error) {
    if (trustedObservedPipelineOrigin(error) !== 'PUMP_BORSH_INVALID') throw error;
    const matched = DEFINITION_BY_DISCRIMINATOR.get(
      toHex(instruction.data.subarray(0, 8)),
    );
    if (matched === undefined || (matched.name !== 'create_v2' && matched.name !== 'sell')) {
      throw error;
    }

    // Re-read only the required fields; opaque bytes have no invented IDL meaning.
    try {
      const reader = new PumpBorshReader(instruction.data.subarray(8));
      const fields = matched.name === 'create_v2'
        ? matched.definition.args.slice(0, CREATE_V2_REQUIRED_ARGUMENT_COUNT)
        : matched.definition.args;
      const args = decodeIdlFields(fields, reader);
      if (reader.remaining !== 2) throw error;
      const expectedSuffix = matched.name === 'create_v2' ? '0001' : '0100';
      if (toHex(reader.readBytes(2)) !== expectedSuffix) throw error;
      const action = Object.freeze({
        name: matched.name,
        family: familyOf(matched.name),
        instruction,
        accounts: mapAccounts(matched.name, matched.definition, instruction),
        args,
      });
      const profile: PumpObservedWireProfile = matched.name === 'create_v2'
        ? 'CREATE_V2_OPAQUE_0001_V1'
        : 'SELL_OPAQUE_0100_V1';
      return Object.freeze({ action, profile });
    } catch {
      // Any prefix/account failure or nonmatching suffix retains the strict error.
      throw error;
    }
  }
}

function decodeMatchedInstruction(
  instruction: NormalizedInstruction,
  matched: { readonly name: PumpInstructionName; readonly definition: InstructionDefinition },
  observeSuffix: (length: number) => void,
): DecodedPumpInstruction {
  const accounts = mapAccounts(
    matched.name,
    matched.definition,
    instruction,
  );
  const reader = new PumpBorshReader(instruction.data.subarray(8));
  const args = decodeInstructionArgs(matched.name, matched.definition, reader, observeSuffix);
  if (reader.remaining !== 0) {
    observeSuffix(reader.remaining);
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

function decodeInstructionArgs(
  name: PumpInstructionName,
  definition: InstructionDefinition,
  reader: PumpBorshReader,
  observeSuffix: (length: number) => void,
): Readonly<Record<string, PumpIdlValue>> {
  if (name === 'create_v2') return decodeCreateV2Args(definition, reader, observeSuffix);
  if (name === 'buy' || name === 'buy_exact_sol_in') {
    return decodeLegacyBuyArgs(name, definition, reader, observeSuffix);
  }
  if (name === 'buy_exact_quote_in_v2') {
    return decodeExactQuoteBuyArgs(definition, reader, observeSuffix);
  }
  if (name === 'buy_v2') return decodeBuyV2Args(definition, reader, observeSuffix);
  return decodeIdlFields(definition.args, reader);
}

// Since the program upgrade at slot 454596459 the @pump-fun/pump-sdk 4.0.0 IDL appends an
// EOF-tolerant `partial_fill: OptionBool` to `buy`, `buy_exact_sol_in`, `buy_exact_quote_in_v2`
// and `buy_v2` (one byte, 0 or 1, after the existing arguments). The pinned IDL predates it, so
// the byte is read here by name; absent means the argument is not present in the instruction.
function decodeLegacyBuyArgs(
  name: 'buy' | 'buy_exact_sol_in',
  definition: InstructionDefinition,
  reader: PumpBorshReader,
  observeSuffix: (length: number) => void,
): Readonly<Record<string, PumpIdlValue>> {
  const required = decodeIdlFields(definition.args.slice(0, 2), reader);
  const suffixLength = reader.remaining;
  observeSuffix(suffixLength);
  if (suffixLength === 0) return required;
  if (suffixLength > 2) throw invalidBuySuffix(name, suffixLength);
  const suffix = reader.readBytes(suffixLength);
  const first = suffix[0];
  const second = suffix[1];
  if (!isBorshBool(first) || (second !== undefined && !isBorshBool(second))) {
    throw invalidBuySuffix(name, suffixLength);
  }
  if (second === undefined) return withOptionBools(required, { track_volume: first === 1 });
  // Two bytes `[t, p]` are `track_volume` then `partial_fill` under pump-sdk 4.0.0 (the SDK
  // itself emits `[1, 0]` for `buy`). The historical Mainnet form `[1, b]` (an older Option<bool>
  // `Some(b)`) is byte-identical; its historical reading track_volume = b is kept, so only
  // `[1, 0]` is ambiguous: it decodes as track_volume = false, partial_fill = false, whereas the
  // 4.0.0 layout would read track_volume = true.
  return withOptionBools(required, {
    track_volume: first === 1 && second === 1,
    partial_fill: second === 1,
  });
}

function decodeExactQuoteBuyArgs(
  definition: InstructionDefinition,
  reader: PumpBorshReader,
  observeSuffix: (length: number) => void,
): Readonly<Record<string, PumpIdlValue>> {
  const required = decodeIdlFields(definition.args, reader);
  const suffixLength = reader.remaining;
  observeSuffix(suffixLength);
  if (suffixLength === 0) return required;
  if (suffixLength !== 1) {
    throw invalidBuySuffix('buy_exact_quote_in_v2', suffixLength);
  }
  const partialFill = reader.readBool();
  // pump-sdk 4.0.0 names this single trailing byte `partial_fill`; the historical Mainnet `[1]`
  // form was recorded as track_volume = true before that IDL existed and keeps that label too.
  return withOptionBools(required, partialFill
    ? { track_volume: true, partial_fill: true }
    : { partial_fill: false });
}

function decodeBuyV2Args(
  definition: InstructionDefinition,
  reader: PumpBorshReader,
  observeSuffix: (length: number) => void,
): Readonly<Record<string, PumpIdlValue>> {
  const required = decodeIdlFields(definition.args, reader);
  const suffixLength = reader.remaining;
  observeSuffix(suffixLength);
  if (suffixLength === 0) return required;
  if (suffixLength !== 1) throw invalidBuySuffix('buy_v2', suffixLength);
  return withOptionBools(required, { partial_fill: reader.readBool() });
}

function isBorshBool(value: number | undefined): value is 0 | 1 {
  return value === 0 || value === 1;
}

function withOptionBools(
  required: Readonly<Record<string, PumpIdlValue>>,
  options: Readonly<Record<string, boolean>>,
): Readonly<Record<string, PumpIdlValue>> {
  return Object.freeze({
    ...required,
    ...Object.fromEntries(Object.entries(options).map(([name, value]) =>
      [name, Object.freeze([value])])),
  });
}

function invalidBuySuffix(
  name: 'buy' | 'buy_exact_quote_in_v2' | 'buy_exact_sol_in' | 'buy_v2',
  suffixLength: number,
): PumpDecodingError {
  return createPumpDecodingError(
    'PUMP_BORSH_INVALID',
    false,
    `Instruction Pump ${name}: suffixe BUY historique invalide (${suffixLength} octet(s)).`,
  );
}

function decodeCreateV2Args(
  definition: InstructionDefinition,
  reader: PumpBorshReader,
  observeSuffix: (length: number) => void,
): Readonly<Record<string, PumpIdlValue>> {
  const required = decodeIdlFields(
    definition.args.slice(0, CREATE_V2_REQUIRED_ARGUMENT_COUNT),
    reader,
  );
  const suffixLength = reader.remaining;
  observeSuffix(suffixLength);
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
