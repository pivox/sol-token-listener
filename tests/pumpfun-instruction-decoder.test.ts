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
  decodePumpInstructionForTransaction,
} from '../src/launchpads/pumpfun/instruction-decoder.js';
import type {
  PumpInstructionCandidate,
  PumpInstructionName,
} from '../src/launchpads/pumpfun/types.js';
import type {
  NormalizedInstruction,
} from '../src/solana/rpc/types.js';
import { loadPumpFixture } from './helpers/pumpfun-fixture.js';

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
    creator_fee_bps: [1_200n],
    is_holder_reward: [true],
  },
  migrate: {},
  migrate_v2: {},
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
  assert.equal(decodePumpInstruction(pumpInstruction('migrate_v2'))?.family, 'MIGRATE');
});

void test('omet track_volume pour les deux suffixes BUY absents', () => {
  for (const name of ['buy', 'buy_exact_sol_in'] as const) {
    const decoded = decodePumpInstruction(
      buyInstructionWithSuffix(name, Buffer.alloc(0)),
    );
    assert.ok(decoded);
    assert.equal(Object.hasOwn(decoded.args, 'track_volume'), false);
  }
});

void test('normalise les deux booléens OptionBool courants des BUY historiques', () => {
  for (const name of ['buy', 'buy_exact_sol_in'] as const) {
    for (const trackVolume of [false, true]) {
      const decoded = decodePumpInstruction(
        buyInstructionWithSuffix(name, Buffer.from([Number(trackVolume)])),
      );
      assert.ok(decoded);
      assert.deepEqual(decoded.args.track_volume, [trackVolume]);
    }
  }
});

void test('normalise les deux booléens Some historiques des BUY', () => {
  for (const name of ['buy', 'buy_exact_sol_in'] as const) {
    for (const trackVolume of [false, true]) {
      const decoded = decodePumpInstruction(
        buyInstructionWithSuffix(
          name,
          Buffer.from([1, Number(trackVolume)]),
        ),
      );
      assert.ok(decoded);
      assert.deepEqual(decoded.args.track_volume, [trackVolume]);
    }
  }
});

void test('conserve le booléen historique borné de buy_exact_quote_in_v2', () => {
  const decoded = decodePumpInstruction(
    buyInstructionWithSuffix('buy_exact_quote_in_v2', Buffer.from([1])),
  );
  assert.ok(decoded);
  assert.deepEqual(decoded.args.track_volume, [true]);
});

void test('refuse les suffixes BUY historiques ambigus ou non booléens', () => {
  for (const name of ['buy', 'buy_exact_sol_in'] as const) {
    for (const suffix of [
      Buffer.from([2]),
      Buffer.from([0, 0]),
      Buffer.from([0, 1]),
      Buffer.from([1, 2]),
      Buffer.alloc(3),
    ]) {
      assert.throws(
        () => decodePumpInstruction(buyInstructionWithSuffix(name, suffix)),
        isPumpError('PUMP_BORSH_INVALID'),
      );
    }
  }

  for (const suffix of [Buffer.from([0]), Buffer.from([2]), Buffer.alloc(2)]) {
    assert.throws(
      () => decodePumpInstruction(
        buyInstructionWithSuffix('buy_exact_quote_in_v2', suffix),
      ),
      isPumpError('PUMP_BORSH_INVALID'),
    );
  }
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

void test('décode uniquement les quatre suffixes EOF officiels de create_v2', () => {
  const cases = [
    {
      suffix: Buffer.alloc(0),
      cashback: false,
      creatorFeeBps: 0n,
      holderReward: false,
    },
    {
      suffix: Buffer.from([1]),
      cashback: true,
      creatorFeeBps: 0n,
      holderReward: false,
    },
    {
      suffix: Buffer.concat([Buffer.from([0]), u64(975n)]),
      cashback: false,
      creatorFeeBps: 975n,
      holderReward: false,
    },
    {
      suffix: Buffer.concat([Buffer.from([0]), u64(1_200n), Buffer.from([1])]),
      cashback: false,
      creatorFeeBps: 1_200n,
      holderReward: true,
    },
  ] as const;

  for (const fixture of cases) {
    const decoded = decodePumpInstruction(
      createV2InstructionWithSuffix(fixture.suffix),
    );
    assert.ok(decoded);
    assert.deepEqual(decoded.args.is_cashback_enabled, [fixture.cashback]);
    assert.deepEqual(decoded.args.creator_fee_bps, [fixture.creatorFeeBps]);
    assert.deepEqual(decoded.args.is_holder_reward, [fixture.holderReward]);
  }
});

void test('accepte le quatrième remaining account seulement pour le PDA quote-control', () => {
  const instruction = pumpInstruction('create_v2');
  const quoteControl = PublicKey.findProgramAddressSync(
    [Buffer.from('quote-control')],
    new PublicKey(PUMP_PROGRAM),
  )[0].toBase58();
  const remaining = [
    address(21),
    address(22),
    address(23),
    quoteControl,
  ];
  const decoded = decodePumpInstruction({
    ...instruction,
    accounts: [...instruction.accounts, ...remaining],
  });

  assert.ok(decoded);
  assert.equal(decoded.accounts.quote_control, quoteControl);
  assert.throws(
    () => decodePumpInstruction({
      ...instruction,
      accounts: [...instruction.accounts, ...remaining.slice(0, 3), address(24)],
    }),
    isPumpError('PUMP_ACCOUNT_MISSING'),
  );
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
      data: Uint8Array.from([...buy.data, 2]),
    }),
    isPumpError('PUMP_BORSH_INVALID'),
  );
});

void test('refuse chaque taille de suffixe create_v2 non documentée', () => {
  for (const length of [2, 7, 8, 11]) {
    assert.throws(
      () => decodePumpInstruction(
        createV2InstructionWithSuffix(Buffer.alloc(length)),
      ),
      isPumpError('PUMP_BORSH_INVALID'),
    );
  }
});

void test('refuse les remaining account counts create_v2 hors 0, 3 et 4', () => {
  const instruction = pumpInstruction('create_v2');
  for (const count of [1, 2, 5]) {
    assert.throws(
      () => decodePumpInstruction({
        ...instruction,
        accounts: [
          ...instruction.accounts,
          ...Array.from({ length: count }, (_, index) => address(index + 25)),
        ],
      }),
      isPumpError('PUMP_ACCOUNT_MISSING'),
    );
  }
});

for (const fixture of [
  {
    file: 'create-v2-opaque-holder-mainnet.json',
    name: 'create_v2',
    suffix: '0001',
    profile: 'CREATE_V2_OPAQUE_0001_V1',
  },
  {
    file: 'sell-opaque-volume-mainnet.json',
    name: 'sell',
    suffix: '0100',
    profile: 'SELL_OPAQUE_0100_V1',
  },
] as const) {
  void test(`refuse strictement le suffixe opaque original ${fixture.name}`, async () => {
    const instruction = await opaqueFixtureInstruction(fixture.file, fixture.name);
    assert.equal(Buffer.from(instruction.data.subarray(-2)).toString('hex'), fixture.suffix);
    assert.throws(() => decodePumpInstruction(instruction), isPumpError('PUMP_BORSH_INVALID'));
  });

  void test(`préserve le préfixe et la provenance du candidat ${fixture.profile}`, async () => {
    const instruction = await opaqueFixtureInstruction(fixture.file, fixture.name);
    const originalBytes = Uint8Array.from(instruction.data);
    const originalAccounts = [...instruction.accounts];
    const candidate = decodeForTransaction(instruction);
    assert.ok(candidate);
    assert.equal(candidate.profile, fixture.profile);
    assert.equal(candidate.action.name, fixture.name);
    assert.equal(candidate.action.family, fixture.name === 'create_v2' ? 'CREATE' : 'SELL');
    assert.equal(candidate.action.instruction, instruction);
    assert.equal(candidate.action.instruction.data, instruction.data);
    assert.equal(candidate.action.instruction.accounts, instruction.accounts);
    assert.deepEqual(instruction.data, originalBytes);
    assert.deepEqual(instruction.accounts, originalAccounts);
    const definition = PUMP_INSTRUCTIONS[fixture.name];
    for (const [index, account] of definition.accounts.entries()) {
      assert.equal(candidate.action.accounts[account.name], instruction.accounts[index]);
    }
    if (fixture.name === 'create_v2') {
      assert.deepEqual(candidate.action.args, {
        name: 'attentioninu', symbol: 'AI',
        uri: 'https://m.rapidlaunch.io/m/r1pPHQ1mM',
        creator: new PublicKey(Buffer.from(
          'a7eee5ed2ef38b3511545a51c0d1a307b25a339432d3b36d86f8ae1602ee86bd0', 'hex',
        )).toBase58(),
        is_mayhem_mode: false,
      });
      assert.equal(candidate.action.accounts.quote_mint,
        'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn');
      assert.equal(candidate.action.accounts.quote_control, instruction.accounts.at(-1));
    } else {
      assert.deepEqual(candidate.action.args, {
        amount: 25_659_383_952_290n, min_sol_output: 0n,
      });
    }
    for (const optional of ['is_cashback_enabled', 'creator_fee_bps', 'is_holder_reward', 'track_volume']) {
      assert.equal(Object.hasOwn(candidate.action.args, optional), false);
    }
    for (const value of [candidate, candidate.action, candidate.action.args, candidate.action.accounts]) {
      assert.equal(Object.isFrozen(value), true);
    }
    const nextCandidate = decodeForTransaction(instruction);
    assert.notEqual(nextCandidate, candidate);
    assert.notEqual(nextCandidate?.action, candidate.action);
  });
}

void test('étiquette les instructions officielles avec un profil null', () => {
  for (const name of Object.keys(PUMP_INSTRUCTIONS) as PumpInstructionName[]) {
    const instruction = pumpInstruction(name);
    const candidate = decodeForTransaction(instruction);
    assert.ok(candidate);
    assert.equal(candidate.profile, null);
    assert.deepEqual(candidate.action, decodePumpInstruction(instruction));
    assert.equal(candidate.action.instruction, instruction);
    assert.equal(Object.isFrozen(candidate), true);
  }
  const officialOneByte = decodeForTransaction(createV2InstructionWithSuffix(Uint8Array.of(0)));
  assert.equal(officialOneByte?.profile, null);
});

void test('refuse les suffixes opaques modifiés, étendus ou sell tronqués', () => {
  for (const name of ['create_v2', 'sell'] as const) {
    for (const suffix of [
      Uint8Array.of(0, 0), Uint8Array.of(1, 1), Uint8Array.of(2, 0),
      Uint8Array.of(0, 2), Uint8Array.of(0, 1, 0), Uint8Array.of(1, 0, 0),
      ...(name === 'create_v2' ? [Uint8Array.of(1, 0)] : [Uint8Array.of(0, 1), Uint8Array.of(1)]),
    ]) {
      assertSameStrictFailure(opaqueInstruction(name, suffix), 'PUMP_BORSH_INVALID');
    }
  }
});

void test('ne reconnaît aucun profil opaque pour les autres discriminateurs ou programmes', () => {
  const sell = opaqueInstruction('sell', Uint8Array.of(1, 0));
  assert.equal(decodeForTransaction({ ...sell, programId: address(99) }), null);
  assert.equal(decodeForTransaction({ ...sell, data: Uint8Array.of(1, 2, 3) }), null);
  assert.equal(decodeForTransaction({
    ...sell, data: Uint8Array.from([...Buffer.alloc(8, 255), ...sell.data.subarray(8)]),
  }), null);
  assertSameStrictFailure({
    ...sell,
    accounts: pumpInstruction('sell_v2').accounts,
    data: Uint8Array.from([...PUMP_INSTRUCTIONS.sell_v2.discriminator, ...sell.data.subarray(8)]),
  }, 'PUMP_BORSH_INVALID');
  assertSameStrictFailure(buyInstructionWithSuffix('buy', Uint8Array.of(0, 1)), 'PUMP_BORSH_INVALID');
});

void test('préserve les rejets des comptes requis et remaining accounts opaques', () => {
  for (const name of ['create_v2', 'sell'] as const) {
    const instruction = opaqueInstruction(name, name === 'create_v2' ? Uint8Array.of(0, 1) : Uint8Array.of(1, 0));
    assertSameStrictFailure({ ...instruction, accounts: instruction.accounts.slice(0, -1) }, 'PUMP_ACCOUNT_MISSING');
    if (name === 'create_v2') {
      for (const count of [1, 2, 5]) {
        assertSameStrictFailure({
          ...instruction,
          accounts: [...instruction.accounts, ...Array.from({ length: count }, () => address(22))],
        }, 'PUMP_ACCOUNT_MISSING');
      }
      assertSameStrictFailure({
        ...instruction, accounts: [...instruction.accounts, address(21), address(22), address(23), address(24)],
      }, 'PUMP_ACCOUNT_MISSING');
    }
  }
});

void test('préserve les rejets des préfixes requis malformés et tronqués', () => {
  const create = opaqueInstruction('create_v2', Uint8Array.of(0, 1));
  const invalidBool = Uint8Array.from(create.data);
  invalidBool[invalidBool.length - 3] = 2;
  assertSameStrictFailure({ ...create, data: invalidBool }, 'PUMP_BORSH_INVALID');
  const invalidUtf8 = Uint8Array.from(create.data);
  invalidUtf8[12] = 255;
  assertSameStrictFailure({ ...create, data: invalidUtf8 }, 'PUMP_BORSH_INVALID');
  const oversizedString = Uint8Array.from(create.data);
  oversizedString.set(Buffer.from([255, 255, 255, 255]), 8);
  assertSameStrictFailure({ ...create, data: oversizedString }, 'PUMP_BORSH_INVALID');
  assertSameStrictFailure({ ...create, data: create.data.subarray(0, 13) }, 'PUMP_BORSH_TRUNCATED');
  const sell = opaqueInstruction('sell', Uint8Array.of(1, 0));
  assertSameStrictFailure({
    ...sell, data: Uint8Array.from([...sell.data.subarray(0, 15), 1, 0]),
  }, 'PUMP_BORSH_TRUNCATED');
});

function decodeForTransaction(instruction: NormalizedInstruction): PumpInstructionCandidate | null {
  return decodePumpInstructionForTransaction(instruction);
}

async function opaqueFixtureInstruction(
  file: string, name: 'create_v2' | 'sell',
): Promise<NormalizedInstruction> {
  const fixture = await loadPumpFixture(file);
  const instruction = fixture.transaction.instructions.find((candidate) =>
    candidate.programId === PUMP_PROGRAM
    && Buffer.from(candidate.data.subarray(0, 8)).equals(Buffer.from(PUMP_INSTRUCTIONS[name].discriminator)));
  assert.ok(instruction);
  return instruction;
}

function opaqueInstruction(name: 'create_v2' | 'sell', suffix: Uint8Array): NormalizedInstruction {
  if (name === 'create_v2') return createV2InstructionWithSuffix(suffix);
  const instruction = pumpInstruction(name);
  return { ...instruction, data: Uint8Array.from([...instruction.data, ...suffix]) };
}

function assertSameStrictFailure(instruction: NormalizedInstruction, code: string): void {
  let strictError: unknown;
  assert.throws(() => decodePumpInstruction(instruction), (error: unknown) => {
    strictError = error;
    return isPumpError(code)(error);
  });
  assert.throws(() => decodeForTransaction(instruction), (error: unknown) => {
    assert.ok(strictError instanceof PumpDecodingError);
    return error instanceof PumpDecodingError
      && error.code === strictError.code && error.message === strictError.message
      && error.retryable === strictError.retryable;
  });
}

function pumpInstruction(name: PumpInstructionName): NormalizedInstruction {
  const definition = PUMP_INSTRUCTIONS[name];
  const encodedArgs = encodeFields(definition.args, VALUES[name]);
  return normalizedInstruction(Uint8Array.from([
    ...definition.discriminator,
    ...encodedArgs,
  ]), definition.accounts.map((account, index) =>
    `${account.name}-${index}`));
}

function createV2InstructionWithSuffix(suffix: Uint8Array): NormalizedInstruction {
  const definition = PUMP_INSTRUCTIONS.create_v2;
  return normalizedInstruction(Uint8Array.from([
    ...definition.discriminator,
    ...encodeFields(definition.args.slice(0, 5), VALUES.create_v2),
    ...suffix,
  ]), definition.accounts.map((account, index) => `${account.name}-${index}`));
}

function buyInstructionWithSuffix(
  name: 'buy' | 'buy_exact_quote_in_v2' | 'buy_exact_sol_in',
  suffix: Uint8Array,
): NormalizedInstruction {
  const definition = PUMP_INSTRUCTIONS[name];
  return normalizedInstruction(Uint8Array.from([
    ...definition.discriminator,
    ...encodeFields(definition.args.slice(0, 2), VALUES[name]),
    ...suffix,
  ]), definition.accounts.map((account, index) => `${account.name}-${index}`));
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
  if (isOptionU64(type)) {
    assert.ok(Array.isArray(value));
    return u64(value[0]);
  }
  throw new Error(`Type de test non pris en charge: ${JSON.stringify(type)}.`);
}

function isOptionU64(
  type: unknown,
): type is { readonly defined: { readonly name: 'OptionU64' } } {
  if (typeof type !== 'object' || type === null) return false;
  const defined = Reflect.get(type, 'defined');
  if (typeof defined !== 'object' || defined === null) return false;
  return Reflect.get(defined, 'name') === 'OptionU64';
}

function u64(value: unknown): Buffer {
  if (typeof value !== 'bigint') throw new Error('Valeur u64 de test invalide.');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function address(seed: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => seed)).toBase58();
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
