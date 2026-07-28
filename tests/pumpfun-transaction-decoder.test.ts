import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  PUMP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../src/launchpads/pumpfun/constants.js';
import { PumpDecodingError } from '../src/launchpads/pumpfun/errors.js';
import { PUMP_INSTRUCTIONS } from '../src/launchpads/pumpfun/generated/pump-idl.js';
import {
  decodePumpTransaction,
} from '../src/launchpads/pumpfun/transaction-decoder.js';
import type {
  PumpInstructionName,
} from '../src/launchpads/pumpfun/types.js';
import type {
  NormalizedInstruction,
  NormalizedTransaction,
} from '../src/solana/rpc/types.js';
import {
  createEventInstruction,
  tradeEventInstruction,
} from './pumpfun-event-decoder.test.js';

const MINT = address(1);
const CREATOR = address(2);
const USER = address(3);
const QUOTE_MINT = address(4);
const OTHER = address(10);
const CREATE_ARGS = {
  name: 'Éclair',
  symbol: 'ECL',
  uri: 'ipfs://metadata',
  creator: CREATOR,
  is_mayhem_mode: true,
  is_cashback_enabled: [true],
} as const;
const TRADE_ARGS = {
  amount: 1n,
  max_sol_cost: 1n,
} as const;
const SELL_ARGS = {
  amount: 1n,
  min_sol_output: 1n,
} as const;

void test('apparie une action externe à son événement interne', () => {
  const decoded = decodePumpTransaction(transaction([
    action('create_v2', cursor(2, null, 1)),
    eventAt(createEventInstruction(), cursor(2, 22, 2)),
  ]));

  assert.equal(decoded.creations.length, 1);
  assert.equal(
    decoded.creations[0]?.action.instruction.innerInstructionIndex,
    null,
  );
});

void test('apparie une action CPI à son événement enfant par stackHeight', () => {
  const decoded = decodePumpTransaction(transaction([
    action('buy_v2', cursor(3, 0, 2)),
    unrelated(cursor(3, 1, 3)),
    eventAt(tradeEventInstruction(), cursor(3, 7, 3)),
  ]));

  assert.equal(decoded.trades.length, 1);
});

void test('décode création puis achat initial dans la même transaction', () => {
  const decoded = decodePumpTransaction(transaction([
    action('create_v2', cursor(2, null, 1)),
    eventAt(createEventInstruction(), cursor(2, 0, 2)),
    action('buy_v2', cursor(3, null, 1)),
    eventAt(tradeEventInstruction(), cursor(3, 0, 2)),
  ]));

  assert.equal(decoded.creations.length, 1);
  assert.equal(decoded.trades.length, 1);
  assert.equal(
    decoded.trades[0]?.event.mint,
    decoded.creations[0]?.event.mint,
  );
});

void test('sépare plusieurs actions Pump sous un même wrapper', () => {
  const decoded = decodePumpTransaction(transaction([
    action('buy_v2', cursor(4, 0, 2)),
    eventAt(tradeEventInstruction(), cursor(4, 1, 3)),
    action('buy_v2', cursor(4, 2, 2)),
    eventAt(tradeEventInstruction(), cursor(4, 3, 3)),
  ]));

  assert.equal(decoded.trades.length, 2);
  assert.equal(
    decoded.trades[0]?.action.instruction.innerInstructionIndex,
    0,
  );
  assert.equal(
    decoded.trades[1]?.action.instruction.innerInstructionIndex,
    2,
  );
});

void test('ignore toute preuve issue d’une transaction échouée', () => {
  const decoded = decodePumpTransaction(transaction([
    action('buy_v2', cursor(3, null, 1)),
  ], { error: { InstructionError: [3, 'Custom'] } }));

  assert.deepEqual(decoded.creations, []);
  assert.deepEqual(decoded.trades, []);
});

void test('exige un transactionIndex canonique', () => {
  assert.throws(
    () => decodePumpTransaction(transaction([], { transactionIndex: null })),
    isPumpError('PUMP_TRANSACTION_INDEX_REQUIRED'),
  );
});

void test('échoue si un événement est manquant, dupliqué ou orphelin', () => {
  const buy = action('buy_v2', cursor(3, null, 1));
  const trade = eventAt(tradeEventInstruction(), cursor(3, 0, 2));
  assert.throws(
    () => decodePumpTransaction(transaction([buy])),
    isPumpError('PUMP_EVENT_MISSING'),
  );
  assert.throws(
    () => decodePumpTransaction(transaction([buy, trade, trade])),
    isPumpError('PUMP_EVENT_DUPLICATE'),
  );
  assert.throws(
    () => decodePumpTransaction(transaction([trade])),
    isPumpError('PUMP_EVENT_ORPHANED'),
  );
});

void test('refuse un événement ambigu dans la portée d’une action', () => {
  assert.throws(
    () => decodePumpTransaction(transaction([
      action('buy_v2', cursor(3, null, 1)),
      eventAt(tradeEventInstruction(), cursor(3, 0, 2)),
      eventAt(tradeEventInstruction(Uint8Array.of(1)), cursor(3, 1, 2)),
    ])),
    isPumpError('PUMP_EVENT_AMBIGUOUS'),
  );
});

void test('exige les stackHeight internes et respecte la borne de portée', () => {
  assert.throws(
    () => decodePumpTransaction(transaction([
      action('buy_v2', cursor(3, 0, 2)),
      eventAt(tradeEventInstruction(), cursor(3, 1, null)),
    ])),
    isPumpError('PUMP_STACK_HEIGHT_REQUIRED'),
  );
  assert.throws(
    () => decodePumpTransaction(transaction([
      action('buy_v2', cursor(3, 0, 2)),
      action('buy_v2', cursor(3, 1, 2)),
      eventAt(tradeEventInstruction(), cursor(3, 2, 3)),
    ])),
    isPumpError('PUMP_EVENT_MISSING'),
  );
});

void test('refuse les contradictions mint, user, sens, quote et programme', () => {
  const mismatches: readonly NormalizedInstruction[][] = [
    [
      action('buy_v2', cursor(3, null, 1), { base_mint: OTHER }),
      eventAt(tradeEventInstruction(), cursor(3, 0, 2)),
    ],
    [
      action('buy_v2', cursor(3, null, 1), { user: OTHER }),
      eventAt(tradeEventInstruction(), cursor(3, 0, 2)),
    ],
    [
      action('sell_v2', cursor(3, null, 1)),
      eventAt(tradeEventInstruction(), cursor(3, 0, 2)),
    ],
    [
      action('buy_v2', cursor(3, null, 1), { quote_mint: OTHER }),
      eventAt(tradeEventInstruction(), cursor(3, 0, 2)),
    ],
    [
      action('create_v2', cursor(2, null, 1), {
        token_program: SPL_TOKEN_PROGRAM_ID,
      }),
      eventAt(createEventInstruction(), cursor(2, 0, 2)),
    ],
  ];
  for (const instructions of mismatches) {
    assert.throws(
      () => decodePumpTransaction(transaction(instructions)),
      isPumpError('PUMP_EVENT_MISMATCH'),
    );
  }
});

void test('refuse un programme token de trade inconnu', () => {
  assert.throws(
    () => decodePumpTransaction(transaction([
      action('buy_v2', cursor(3, null, 1), {
        quote_token_program: OTHER,
      }),
      eventAt(tradeEventInstruction(), cursor(3, 0, 2)),
    ])),
    isPumpError('PUMP_TOKEN_PROGRAM_UNSUPPORTED'),
  );
});

function action(
  name: PumpInstructionName,
  location: Cursor,
  accountOverrides: Readonly<Record<string, string>> = {},
): NormalizedInstruction {
  const definition = PUMP_INSTRUCTIONS[name];
  const values = name === 'create_v2'
    ? CREATE_ARGS
    : name === 'sell_v2'
      ? SELL_ARGS
      : TRADE_ARGS;
  const accounts = definition.accounts.map((account) =>
    accountOverrides[account.name] ?? accountValue(account.name));
  if (name === 'create_v2') {
    accounts.push(
      accountOverrides.quote_mint ?? QUOTE_MINT,
      address(11),
      accountOverrides.quote_token_program ?? SPL_TOKEN_PROGRAM_ID,
    );
  }
  return {
    programId: PUMP_PROGRAM_ID,
    accounts,
    data: Uint8Array.from([
      ...definition.discriminator,
      ...encodeFields(definition.args, values),
    ]),
    ...location,
    parentInstructionIndex:
      location.innerInstructionIndex === null
        ? null
        : location.instructionIndex,
  };
}

function accountValue(name: string): string {
  if (name === 'mint' || name === 'base_mint') return MINT;
  if (name === 'quote_mint') return QUOTE_MINT;
  if (name === 'user') return USER;
  if (name === 'token_program' || name === 'base_token_program') {
    return TOKEN_2022_PROGRAM_ADDRESS;
  }
  if (name === 'quote_token_program') return SPL_TOKEN_PROGRAM_ID;
  return address((name.length % 20) + 12);
}

function transaction(
  instructions: readonly NormalizedInstruction[],
  override: Partial<NormalizedTransaction> = {},
): NormalizedTransaction {
  return {
    signature: 'transaction-signature',
    slot: 12n,
    transactionIndex: 4,
    confirmationStatus: 'CONFIRMED',
    version: 'legacy',
    blockTimeMs: null,
    accountKeys: [],
    signerKeys: [],
    instructions,
    preTokenBalances: [],
    postTokenBalances: [{
      accountIndex: 0,
      account: address(30),
      mint: QUOTE_MINT,
      owner: USER,
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
      amountRaw: 1n,
      decimals: 6,
    }],
    preBalancesLamports: [],
    postBalancesLamports: [],
    feeLamports: 0n,
    computeUnits: null,
    logs: [],
    error: null,
    ...override,
  };
}

function eventAt(
  event: NormalizedInstruction,
  location: Cursor,
): NormalizedInstruction {
  return {
    ...event,
    ...location,
    parentInstructionIndex: location.instructionIndex,
  };
}

function unrelated(location: Cursor): NormalizedInstruction {
  return {
    programId: OTHER,
    accounts: [],
    data: new Uint8Array(),
    ...location,
    parentInstructionIndex: location.instructionIndex,
  };
}

interface Cursor {
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly stackHeight: number | null;
}

function cursor(
  instructionIndex: number,
  innerInstructionIndex: number | null,
  stackHeight: number | null,
): Cursor {
  return { instructionIndex, innerInstructionIndex, stackHeight };
}

function encodeFields(
  fields: readonly { readonly name: string; readonly type: unknown }[],
  values: Readonly<Record<string, unknown>>,
): Buffer {
  return Buffer.concat(fields.map((field) =>
    encodeValue(field.type, values[field.name])));
}

function encodeValue(type: unknown, value: unknown): Buffer {
  if (type === 'bool') return Buffer.from([value === true ? 1 : 0]);
  if (type === 'u64') {
    if (typeof value !== 'bigint') throw new Error('u64 de test invalide.');
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(value);
    return bytes;
  }
  if (type === 'string') {
    if (typeof value !== 'string') throw new Error('string de test invalide.');
    const text = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(text.length);
    return Buffer.concat([length, text]);
  }
  if (type === 'pubkey') {
    if (typeof value !== 'string') throw new Error('pubkey de test invalide.');
    return new PublicKey(value).toBuffer();
  }
  if (isOptionBool(type)) {
    if (!Array.isArray(value)) throw new Error('OptionBool de test invalide.');
    return Buffer.from([value[0] === true ? 1 : 0]);
  }
  throw new Error(`Type de test non pris en charge: ${JSON.stringify(type)}.`);
}

function isOptionBool(type: unknown): boolean {
  if (typeof type !== 'object' || type === null) return false;
  const defined = Reflect.get(type, 'defined');
  return typeof defined === 'object'
    && defined !== null
    && Reflect.get(defined, 'name') === 'OptionBool';
}

function isPumpError(code: string) {
  return (error: unknown): boolean =>
    error instanceof PumpDecodingError && error.code === code;
}

function address(seed: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => seed)).toBase58();
}
