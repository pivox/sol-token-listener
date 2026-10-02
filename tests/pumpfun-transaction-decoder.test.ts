import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  PUMP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
  WSOL_MINT,
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
const HOLDER_REWARDS_CREATOR = PublicKey.findProgramAddressSync(
  [Buffer.from('holder-rewards'), new PublicKey(MINT).toBuffer()],
  new PublicKey(PUMP_PROGRAM_ID),
)[0].toBase58();
const USER = address(3);
const QUOTE_MINT = address(4);
const OTHER = address(10);
const EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  new PublicKey(PUMP_PROGRAM_ID),
)[0].toBase58();
const OPAQUE_SELL_AMOUNT = 9_007_199_254_740_993n;
const CREATE_ARGS = {
  name: 'Éclair',
  symbol: 'ECL',
  uri: 'ipfs://metadata',
  creator: CREATOR,
  is_mayhem_mode: true,
  is_cashback_enabled: [true],
  creator_fee_bps: [1_200n],
  is_holder_reward: [true],
} as const;
const CREATE_LEGACY_ARGS = {
  name: 'Éclair',
  symbol: 'ECL',
  uri: 'ipfs://metadata',
  creator: CREATOR,
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

void test('conserve le décodage create legacy sans holder reward', () => {
  const decoded = decodePumpTransaction(transaction([
    action('create', cursor(2, null, 1)),
    eventAt(createEventInstruction(new Uint8Array(), {
      is_mayhem_mode: false,
      is_cashback_enabled: false,
      creator_fee_bps: 0n,
      is_holder_reward: false,
      creator: CREATOR,
      quote_mint: PublicKey.default.toBase58(),
    }), cursor(2, 0, 2)),
  ]));

  assert.equal(decoded.creations[0]?.action.name, 'create');
  assert.equal(decoded.creations[0]?.requestedCreator, CREATOR);
  assert.equal(decoded.creations[0]?.effectiveCreator, CREATOR);
  assert.equal(decoded.creations[0]?.isHolderReward, false);
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

void test('sépare le créateur demandé du routage effectif holder-reward', () => {
  const requestedCreator = OTHER;
  const decoded = decodePumpTransaction(transaction([
    action(
      'create_v2',
      cursor(2, null, 1),
      {},
      { creator: requestedCreator, is_holder_reward: [true] },
    ),
    eventAt(createEventInstruction(), cursor(2, 0, 2)),
  ]));

  assert.equal(decoded.creations[0]?.requestedCreator, requestedCreator);
  assert.equal(
    decoded.creations[0]?.effectiveCreator,
    HOLDER_REWARDS_CREATOR,
  );
  assert.equal(decoded.creations[0]?.creatorFeeBps, 1_200n);
  assert.equal(decoded.creations[0]?.isHolderReward, true);
});

void test('exige le même créateur demandé et effectif hors holder-reward', () => {
  assert.throws(
    () => decodePumpTransaction(transaction([
      action(
        'create_v2',
        cursor(2, null, 1),
        {},
        { creator: OTHER, is_holder_reward: [false] },
      ),
      eventAt(createEventInstruction(new Uint8Array(), {
        is_holder_reward: false,
      }), cursor(2, 0, 2)),
    ])),
    isPumpError('PUMP_EVENT_MISMATCH'),
  );
});

void test('conserve le creator fee effectif avec un quote-control redondant', () => {
  const quoteControl = PublicKey.findProgramAddressSync(
    [Buffer.from('quote-control')],
    new PublicKey(PUMP_PROGRAM_ID),
  )[0].toBase58();

  const decoded = decodePumpTransaction(transaction([
    action(
      'create_v2',
      cursor(2, null, 1),
      { quote_control: quoteControl },
      { creator_fee_bps: [300n] },
    ),
    eventAt(createEventInstruction(new Uint8Array(), {
      creator_fee_bps: 0n,
    }), cursor(2, 0, 2)),
  ]));

  assert.deepEqual(decoded.creations[0]?.action.args.creator_fee_bps, [300n]);
  assert.equal(decoded.creations[0]?.creatorFeeBps, 0n);
});

void test('refuse un créateur holder-reward qui n’est pas le PDA du mint', () => {
  assert.throws(
    () => decodePumpTransaction(transaction([
      action('create_v2', cursor(2, null, 1)),
      eventAt(createEventInstruction(new Uint8Array(), {
        creator: OTHER,
      }), cursor(2, 0, 2)),
    ])),
    isPumpError('PUMP_EVENT_MISMATCH'),
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
      eventAt(tradeEventInstruction(), cursor(3, 1, 2)),
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
    [
      action('create_v2', cursor(2, null, 1), { user: OTHER }),
      eventAt(createEventInstruction(), cursor(2, 0, 2)),
    ],
    [
      action('create_v2', cursor(2, null, 1), { bonding_curve: OTHER }),
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

void test('refuse un ix_name ambigu ou inconnu', () => {
  for (const ixName of ['buy_sell', 'notbuy']) {
    assert.throws(
      () => decodePumpTransaction(transaction([
        action('buy_v2', cursor(3, null, 1)),
        eventAt(tradeEventInstruction(new Uint8Array(), { ix_name: ixName }), cursor(3, 0, 2)),
      ])),
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

for (const name of ['create_v2', 'sell'] as const) {
  void test(`atteste ${name} opaque sans fabriquer d’arguments optionnels`, () => {
    const instruction = opaqueAction(name, cursor(3, null, 1));
    const event = opaqueEvent(name, cursor(3, 7, 2));
    const decoded = decodePumpTransaction(transaction([instruction, event]));
    const accepted = name === 'create_v2'
      ? decoded.creations[0]?.action
      : decoded.trades[0]?.action;
    assert.ok(accepted);
    assert.equal(accepted.instruction, instruction);
    assert.deepEqual(accepted.wireEvidence, {
      profile: name === 'create_v2' ? 'CREATE_V2_OPAQUE_0001_V1' : 'SELL_OPAQUE_0100_V1',
      pairedEventCursor: cursor(3, 7, 2),
    });
    assert.ok(Object.isFrozen(accepted));
    assert.ok(Object.isFrozen(accepted.wireEvidence));
    assert.ok(Object.isFrozen(accepted.wireEvidence?.pairedEventCursor));
    for (const optional of ['is_cashback_enabled', 'creator_fee_bps', 'is_holder_reward', 'track_volume']) {
      assert.equal(Object.hasOwn(accepted.args, optional), false);
    }
    if (name === 'sell') {
      assert.equal(accepted.args.amount, OPAQUE_SELL_AMOUNT);
      assert.equal(accepted.args.min_sol_output, 1n);
    }
  });

  for (const [label, mutate, code] of [
    ['absent', () => [], 'PUMP_EVENT_MISSING'],
    ['dupliqué', (event: NormalizedInstruction) => [event, event], 'PUMP_EVENT_DUPLICATE'],
    ['ambigu', (event: NormalizedInstruction) => [event, eventAt(event, cursor(3, 8, 2))], 'PUMP_EVENT_AMBIGUOUS'],
    ['autre action', (event: NormalizedInstruction) => [eventAt(event, cursor(4, 7, 2))], 'PUMP_EVENT_MISSING'],
    ['mauvaise profondeur', (event: NormalizedInstruction) => [eventAt(event, cursor(3, 7, 3))], 'PUMP_EVENT_MISSING'],
    ['sans profondeur', (event: NormalizedInstruction) => [eventAt(event, cursor(3, 7, null))], 'PUMP_STACK_HEIGHT_REQUIRED'],
    ['externe', (event: NormalizedInstruction) => [eventAt(event, cursor(3, null, 2))], 'PUMP_EVENT_MISSING'],
    ['mauvais programme', (event: NormalizedInstruction) => [{ ...event, programId: OTHER }], 'PUMP_EVENT_MISSING'],
    ['mauvais tag', (event: NormalizedInstruction) => [{ ...event, data: Uint8Array.from([0, ...event.data.subarray(1)]) }], 'PUMP_EVENT_MISSING'],
    ['mauvais discriminateur', (event: NormalizedInstruction) => [{ ...event, data: Uint8Array.from([...event.data.subarray(0, 8), ...Buffer.alloc(8), ...event.data.subarray(16)]) }], 'PUMP_EVENT_MISSING'],
  ] as const) {
    void test(`refuse ${name} opaque avec événement ${label}`, () => {
      assert.throws(() => decodePumpTransaction(transaction([
        opaqueAction(name, cursor(3, null, 1)),
        ...mutate(opaqueEvent(name, cursor(3, 7, 2))),
      ])), isPumpError(code));
    });
  }

  for (const authorityAccounts of [[], [OTHER], [EVENT_AUTHORITY, OTHER]]) {
    void test(`refuse ${name} opaque avec autorité CPI ${JSON.stringify(authorityAccounts)}`, () => {
      assert.throws(() => decodePumpTransaction(transaction([
        opaqueAction(name, cursor(3, null, 1)),
        { ...opaqueEvent(name, cursor(3, 7, 2)), accounts: authorityAccounts },
      ])), isPumpError('PUMP_EVENT_MISMATCH'));
    });
  }

  void test(`refuse ${name} opaque avec event_authority non canonique`, () => {
    assert.throws(() => decodePumpTransaction(transaction([
      opaqueAction(name, cursor(3, null, 1), { event_authority: OTHER }),
      opaqueEvent(name, cursor(3, 7, 2)),
    ])), isPumpError('PUMP_EVENT_MISMATCH'));
  });

  void test(`atteste ${name} opaque CPI uniquement dans sa portée`, () => {
    const instruction = opaqueAction(name, cursor(3, 2, 2));
    const event = opaqueEvent(name, cursor(3, 3, 3));
    const decoded = decodePumpTransaction(transaction([instruction, event]));
    assert.equal(decoded.creations.length + decoded.trades.length, 1);
    for (const escaped of [
      eventAt(event, cursor(3, 1, 3)),
      eventAt(event, cursor(3, 5, 3)),
    ]) {
      assert.throws(() => decodePumpTransaction(transaction([
        instruction,
        unrelated(cursor(3, 4, 2)),
        escaped,
      ])), isPumpError('PUMP_EVENT_MISSING'));
    }
  });

  void test(`refuse ${name} opaque avec événement orphelin supplémentaire`, () => {
    assert.throws(() => decodePumpTransaction(transaction([
      opaqueAction(name, cursor(3, null, 1)),
      opaqueEvent(name, cursor(3, 7, 2)),
      opaqueEvent(name, cursor(4, 0, 2)),
    ])), isPumpError('PUMP_EVENT_ORPHANED'));
  });

  for (const [label, mutate] of [
    ['programme', (instruction: NormalizedInstruction) => ({ ...instruction, programId: OTHER })],
    ['discriminateur', (instruction: NormalizedInstruction) => ({ ...instruction, data: Uint8Array.from([...Buffer.alloc(8), ...instruction.data.subarray(8)]) })],
  ] as const) {
    void test(`n’atteste pas une action ${name} au ${label} inconnu`, () => {
      assert.throws(() => decodePumpTransaction(transaction([
        mutate(opaqueAction(name, cursor(3, null, 1))),
        opaqueEvent(name, cursor(3, 7, 2)),
      ])), isPumpError('PUMP_EVENT_ORPHANED'));
    });
  }
}

for (const [field, value] of Object.entries({
  name: 'wrong', symbol: 'wrong', uri: 'wrong', mint: OTHER,
  bonding_curve: OTHER, user: OTHER, creator: OTHER,
  token_program: SPL_TOKEN_PROGRAM_ID, is_mayhem_mode: false,
  is_cashback_enabled: true, is_holder_reward: false,
  creator_fee_bps: 1n, quote_mint: OTHER,
})) {
  void test(`refuse la contradiction ${field} d’une création opaque`, () => {
    assert.throws(() => decodePumpTransaction(transaction([
      opaqueAction('create_v2', cursor(3, null, 1)),
      opaqueEvent('create_v2', cursor(3, 7, 2), { [field]: value }),
    ])), isPumpError('PUMP_EVENT_MISMATCH'));
  });
}

void test('conserve le créateur demandé opaque et exige le PDA effectif du mint', () => {
  const decoded = decodePumpTransaction(transaction([
    opaqueAction('create_v2', cursor(3, null, 1), {}, { creator: OTHER }),
    opaqueEvent('create_v2', cursor(3, 7, 2)),
  ]));
  assert.equal(decoded.creations[0]?.requestedCreator, OTHER);
  assert.equal(decoded.creations[0]?.effectiveCreator, HOLDER_REWARDS_CREATOR);
  assert.equal(decoded.creations[0]?.creatorFeeBps, 0n);
});

void test('refuse les métadonnées quote incompatibles d’une création opaque', () => {
  const instructions = [
    opaqueAction('create_v2', cursor(3, null, 1)),
    opaqueEvent('create_v2', cursor(3, 7, 2)),
  ];
  const base = transaction(instructions);
  assert.throws(() => decodePumpTransaction({ ...base, postTokenBalances: [] }),
    isPumpError('PUMP_QUOTE_ASSET_UNRESOLVED'));
  assert.throws(() => decodePumpTransaction({
    ...base,
    postTokenBalances: base.postTokenBalances.map((balance) => ({
      ...balance, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    })),
  }), isPumpError('PUMP_EVENT_MISMATCH'));
  assert.throws(() => decodePumpTransaction(transaction([
    opaqueAction('create_v2', cursor(3, null, 1), { quote_control: OTHER }),
    opaqueEvent('create_v2', cursor(3, 7, 2)),
  ])), isPumpError('PUMP_ACCOUNT_MISSING'));
});

for (const [field, value] of Object.entries({
  is_buy: true, ix_name: 'sell_v2', user: OTHER, mint: OTHER,
  token_amount: OPAQUE_SELL_AMOUNT - 1n, track_volume: true, quote_mint: OTHER,
})) {
  void test(`refuse la contradiction ${field} d’une vente opaque`, () => {
    assert.throws(() => decodePumpTransaction(transaction([
      opaqueAction('sell', cursor(3, null, 1)),
      opaqueEvent('sell', cursor(3, 7, 2), { [field]: value }),
    ])), isPumpError('PUMP_EVENT_MISMATCH'));
  });
}

void test('ne globalise pas les restrictions d’une vente opaque aux formes IDL', () => {
  const decoded = decodePumpTransaction(transaction([
    action('sell', cursor(3, null, 1)),
    eventAt(tradeEventInstruction(new Uint8Array(), {
      is_buy: false, ix_name: 'sell_v2', track_volume: true,
      quote_mint: WSOL_MINT,
    }), cursor(3, 7, 2)),
  ]));
  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.action.wireEvidence, undefined);
});

function opaqueAction(
  name: 'create_v2' | 'sell',
  location: Cursor,
  accountOverrides: Readonly<Record<string, string>> = {},
  argumentOverrides: Readonly<Record<string, unknown>> = {},
): NormalizedInstruction {
  const instruction = action(name, location, {
    event_authority: EVENT_AUTHORITY,
    ...accountOverrides,
  }, argumentOverrides);
  const definition = PUMP_INSTRUCTIONS[name];
  const values = name === 'create_v2'
    ? { ...CREATE_ARGS, ...argumentOverrides }
    : { ...SELL_ARGS, amount: OPAQUE_SELL_AMOUNT, ...argumentOverrides };
  return {
    ...instruction,
    data: Uint8Array.from([
      ...definition.discriminator,
      ...encodeFields(name === 'create_v2' ? definition.args.slice(0, 5) : definition.args, values),
      ...(name === 'create_v2' ? [0, 1] : [1, 0]),
    ]),
  };
}

function opaqueEvent(
  name: 'create_v2' | 'sell',
  location: Cursor,
  overrides: Readonly<Record<string, unknown>> = {},
): NormalizedInstruction {
  const event = name === 'create_v2'
    ? createEventInstruction(new Uint8Array(), {
      is_cashback_enabled: false, creator_fee_bps: 0n, ...overrides,
    })
    : tradeEventInstruction(new Uint8Array(), {
      is_buy: false, ix_name: 'sell', track_volume: false,
      token_amount: OPAQUE_SELL_AMOUNT, quote_mint: WSOL_MINT, ...overrides,
    });
  return { ...eventAt(event, location), accounts: [EVENT_AUTHORITY] };
}

function action(
  name: PumpInstructionName,
  location: Cursor,
  accountOverrides: Readonly<Record<string, string>> = {},
  argumentOverrides: Readonly<Record<string, unknown>> = {},
): NormalizedInstruction {
  const definition = PUMP_INSTRUCTIONS[name];
  const baseValues = name === 'create_v2'
    ? CREATE_ARGS
    : name === 'create'
      ? CREATE_LEGACY_ARGS
    : name === 'sell_v2' || name === 'sell'
      ? SELL_ARGS
      : TRADE_ARGS;
  const values = { ...baseValues, ...argumentOverrides };
  const accounts = definition.accounts.map((account) =>
    accountOverrides[account.name] ?? accountValue(account.name));
  if (name === 'create_v2') {
    accounts.push(
      accountOverrides.quote_mint ?? QUOTE_MINT,
      address(11),
      accountOverrides.quote_token_program ?? SPL_TOKEN_PROGRAM_ID,
    );
    if (accountOverrides.quote_control !== undefined) {
      accounts.push(accountOverrides.quote_control);
    }
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
  if (name === 'bonding_curve') return address(5);
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
  if (isOptionU64(type)) {
    if (!Array.isArray(value) || typeof value[0] !== 'bigint') {
      throw new Error('OptionU64 de test invalide.');
    }
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(value[0]);
    return bytes;
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

function isOptionU64(type: unknown): boolean {
  if (typeof type !== 'object' || type === null) return false;
  const defined = Reflect.get(type, 'defined');
  return typeof defined === 'object'
    && defined !== null
    && Reflect.get(defined, 'name') === 'OptionU64';
}

function isPumpError(code: string) {
  return (error: unknown): boolean =>
    error instanceof PumpDecodingError && error.code === code;
}

function address(seed: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => seed)).toBase58();
}
