import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  PumpDecodingError,
} from '../src/launchpads/pumpfun/errors.js';
import {
  PUMP_INSTRUCTIONS,
} from '../src/launchpads/pumpfun/generated/pump-idl.js';
import {
  decodePumpInstruction,
} from '../src/launchpads/pumpfun/instruction-decoder.js';
import type {
  PumpInstructionName,
} from '../src/launchpads/pumpfun/types.js';
import type {
  NormalizedInstruction,
} from '../src/solana/rpc/types.js';

const PUMP_PROGRAM =
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CREATOR = new PublicKey(
  Uint8Array.from({ length: 32 }, (_unused, index) => index + 1),
).toBase58();
const VALUES: Record<PumpInstructionName, Readonly<Record<string, unknown>>> = {
  buy: {
    amount: 9_007_199_254_740_993n,
    max_sol_cost: 500_000_000n,
    track_volume: [true],
  },
  buy_exact_quote_in_v2: {
    spendable_quote_in: 250_000_000n,
    min_tokens_out: 9_007_199_254_740_993n,
  },
  buy_exact_sol_in: {
    spendable_sol_in: 250_000_000n,
    min_tokens_out: 9_007_199_254_740_993n,
    track_volume: [false],
  },
  buy_v2: {
    amount: 9_007_199_254_740_993n,
    max_sol_cost: 500_000_000n,
  },
  create: {
    name: 'Éclair',
    symbol: 'ECL',
    uri: 'https://example.invalid/metadata.json',
    creator: CREATOR,
  },
  create_v2: {
    name: 'Éclair V2',
    symbol: 'ECL2',
    uri: 'ipfs://metadata',
    creator: CREATOR,
    is_mayhem_mode: true,
    is_cashback_enabled: [false],
  },
  sell: {
    amount: 9_007_199_254_740_993n,
    min_sol_output: 200_000_000n,
  },
  sell_v2: {
    amount: 9_007_199_254_740_993n,
    min_sol_output: 200_000_000n,
  },
};

void test('décode toutes les instructions Pump du périmètre depuis le module généré', () => {
  for (const name of Object.keys(PUMP_INSTRUCTIONS) as PumpInstructionName[]) {
    const definition = PUMP_INSTRUCTIONS[name];
    const instruction = pumpInstruction(name);
    const decoded = decodePumpInstruction(instruction);

    assert.ok(decoded);
    assert.equal(decoded.name, name);
    assert.equal(decoded.instruction, instruction);
    assert.deepEqual(
      Object.keys(decoded.accounts),
      definition.accounts.map((account) => account.name),
    );
    assert.deepEqual(decoded.args, VALUES[name]);
  }
});

void test('classe les variantes par famille métier', () => {
  assert.equal(decodePumpInstruction(pumpInstruction('create'))?.family, 'CREATE');
  assert.equal(decodePumpInstruction(pumpInstruction('buy_v2'))?.family, 'BUY');
  assert.equal(decodePumpInstruction(pumpInstruction('sell_v2'))?.family, 'SELL');
});

void test('décode les trois remaining accounts multi-quote de create_v2', () => {
  const instruction = pumpInstruction('create_v2');
  const remaining = ['quote-mint', 'quote-curve-account', 'quote-token-program'];
  const decoded = decodePumpInstruction({
    ...instruction,
    accounts: [...instruction.accounts, ...remaining],
  });

  assert.ok(decoded);
  assert.equal(decoded.accounts.quote_mint, remaining[0]);
  assert.equal(
    decoded.accounts.associated_quote_bonding_curve,
    remaining[1],
  );
  assert.equal(decoded.accounts.quote_token_program, remaining[2]);
});

void test('ignore une instruction Pump hors périmètre', () => {
  assert.equal(
    decodePumpInstruction(normalizedInstruction(Uint8Array.of(1, 2, 3))),
    null,
  );
});

void test('refuse un compte obligatoire ou un remaining account manquant', () => {
  const create = pumpInstruction('create');
  assert.throws(
    () => decodePumpInstruction({
      ...create,
      accounts: create.accounts.slice(0, -1),
    }),
    isPumpError('PUMP_ACCOUNT_MISSING'),
  );

  const createV2 = pumpInstruction('create_v2');
  assert.throws(
    () => decodePumpInstruction({
      ...createV2,
      accounts: [...createV2.accounts, 'partial-quote'],
    }),
    isPumpError('PUMP_ACCOUNT_MISSING'),
  );
});

void test('refuse les octets résiduels après les arguments', () => {
  const buy = pumpInstruction('buy');
  assert.throws(
    () => decodePumpInstruction({
      ...buy,
      data: Uint8Array.from([...buy.data, 1]),
    }),
    isPumpError('PUMP_BORSH_INVALID'),
  );
});

function pumpInstruction(name: PumpInstructionName): NormalizedInstruction {
  const definition = PUMP_INSTRUCTIONS[name];
  const encodedArgs = encodeFields(definition.args, VALUES[name]);
  return normalizedInstruction(Uint8Array.from([
    ...definition.discriminator,
    ...encodedArgs,
  ]), definition.accounts.map((account, index) =>
    `${account.name}-${index}`));
}

function normalizedInstruction(
  data: Uint8Array,
  accounts: readonly string[] = [],
): NormalizedInstruction {
  return {
    programId: PUMP_PROGRAM,
    accounts,
    data,
    instructionIndex: 2,
    innerInstructionIndex: null,
    parentInstructionIndex: null,
    stackHeight: 1,
  };
}

function encodeFields(
  fields: readonly { readonly name: string; readonly type: unknown }[],
  values: Readonly<Record<string, unknown>>,
): Uint8Array {
  return Buffer.concat(fields.map((field) =>
    encodeValue(field.type, values[field.name])));
}

function encodeValue(type: unknown, value: unknown): Buffer {
  if (type === 'bool') return Buffer.from([value === true ? 1 : 0]);
  if (type === 'u64') {
    if (typeof value !== 'bigint') {
      throw new Error('Valeur u64 de test invalide.');
    }
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(value);
    return bytes;
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new Error('Valeur string de test invalide.');
    }
    const text = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(text.length);
    return Buffer.concat([length, text]);
  }
  if (type === 'pubkey') {
    if (typeof value !== 'string') {
      throw new Error('Valeur pubkey de test invalide.');
    }
    return new PublicKey(value).toBuffer();
  }
  if (isOptionBool(type)) {
    assert.ok(Array.isArray(value));
    return Buffer.from([value[0] === true ? 1 : 0]);
  }
  throw new Error(`Type de test non pris en charge: ${JSON.stringify(type)}.`);
}

function isOptionBool(
  type: unknown,
): type is { readonly defined: { readonly name: 'OptionBool' } } {
  if (typeof type !== 'object' || type === null) return false;
  const defined = Reflect.get(type, 'defined');
  if (typeof defined !== 'object' || defined === null) return false;
  return Reflect.get(defined, 'name') === 'OptionBool';
}

function isPumpError(code: string) {
  return (error: unknown): boolean =>
    error instanceof PumpDecodingError && error.code === code;
}
