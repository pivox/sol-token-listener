import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import type {
  WalletFundingBuy,
} from '../src/domain/wallet-funding.js';
import {
  PUMP_INSTRUCTIONS,
} from '../src/launchpads/pumpfun/generated/pump-idl.js';
import {
  PUMP_PROGRAM_ID,
  WSOL_MINT,
} from '../src/launchpads/pumpfun/constants.js';
import {
  SolanaWalletFundingEvidenceExtractor,
} from '../src/solana/wallet-funding-evidence-extractor.js';
import type {
  NormalizedInstruction,
  NormalizedTokenBalance,
  NormalizedTransaction,
} from '../src/solana/rpc/types.js';

const BUYER = address(1);
const FUNDER = address(2);
const OTHER = address(3);
const BASE_MINT = address(4);
const QUOTE_MINT = address(5);
const SOURCE_TOKEN = address(6);
const DESTINATION_TOKEN = address(7);
const TECHNICAL_FUNDER = address(8);
const extractor = new SolanaWalletFundingEvidenceExtractor();

void test('extracts an outer System transfer before a canonical SOL buy', () => {
  const transfer = normalizeInstruction(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(FUNDER),
      toPubkey: new PublicKey(BUYER),
      lamports: 1_000_000n,
    }),
    location(1),
  );
  const buyInstruction = pumpBuy(location(2), {
    user: BUYER,
    base_mint: BASE_MINT,
    quote_mint: WSOL_MINT,
  });
  const buy = fundingBuy(location(2), {
    buyer: BUYER,
    quoteAsset: quote(WSOL_MINT, 9, 'SPL_TOKEN'),
  });

  const result = extractor.extract(
    transaction([transfer, buyInstruction], { signerKeys: [BUYER] }),
    Object.freeze([buy]),
  );

  assert.equal(result.assessments[0]?.status, 'STRONG');
  assert.equal(result.assessments[0]?.inspectedTransferCount, 1);
  assert.equal(result.assessments[0]?.acceptedEvidenceCount, 1);
  assert.equal(result.evidence[0]?.type, 'DIRECT_QUOTE_TRANSFER');
  assert.equal(result.evidence[0]?.amountRaw, 1_000_000n);
  assert.equal(result.evidence[0]?.funder, FUNDER);
  assert.equal(result.evidence[0]?.buyer, BUYER);
});

void test('extracts an inner System transfer and ignores transfers after the buy', () => {
  const inner = normalizeInstruction(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(FUNDER),
      toPubkey: new PublicKey(BUYER),
      lamports: 2_000_000n,
    }),
    location(1, 0, 2),
  );
  const buyInstruction = pumpBuy(location(2), {
    user: BUYER,
    base_mint: BASE_MINT,
    quote_mint: WSOL_MINT,
  });
  const after = normalizeInstruction(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(OTHER),
      toPubkey: new PublicKey(BUYER),
      lamports: 3_000_000n,
    }),
    location(3),
  );

  const result = extractor.extract(
    transaction([inner, buyInstruction, after], { signerKeys: [BUYER] }),
    Object.freeze([fundingBuy(location(2), {
      quoteAsset: quote(WSOL_MINT, 9, 'SPL_TOKEN'),
    })]),
  );

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.funder, FUNDER);
  assert.equal(result.evidence[0]?.amountRaw, 2_000_000n);
});

void test('decodes SPL Transfer and TransferChecked only for the matching quote owner', () => {
  for (const checked of [false, true]) {
    const instruction = checked
      ? createTransferCheckedInstruction(
        new PublicKey(SOURCE_TOKEN),
        new PublicKey(QUOTE_MINT),
        new PublicKey(DESTINATION_TOKEN),
        new PublicKey(FUNDER),
        4_000_000n,
        6,
      )
      : createTransferInstruction(
        new PublicKey(SOURCE_TOKEN),
        new PublicKey(DESTINATION_TOKEN),
        new PublicKey(FUNDER),
        4_000_000n,
      );
    const transfer = normalizeInstruction(instruction, location(1));
    const buyInstruction = pumpBuy(location(2), {
      user: BUYER,
      base_mint: BASE_MINT,
      quote_mint: QUOTE_MINT,
      quote_token_program: TOKEN_PROGRAM_ID.toBase58(),
    });
    const balances = tokenBalances(
      QUOTE_MINT,
      TOKEN_PROGRAM_ID.toBase58(),
      FUNDER,
      BUYER,
    );

    const result = extractor.extract(
      transaction([transfer, buyInstruction], {
        signerKeys: [BUYER],
        tokenBalances: balances,
      }),
      Object.freeze([fundingBuy(location(2), {
        quoteAsset: quote(QUOTE_MINT, 6, 'SPL_TOKEN'),
      })]),
    );

    assert.equal(result.assessments[0]?.status, 'STRONG');
    assert.equal(result.evidence[0]?.amountRaw, 4_000_000n);
    assert.equal(result.evidence[0]?.funder, FUNDER);
  }
});

void test('decodes Token-2022 Transfer and TransferChecked with exact quote metadata', () => {
  for (const checked of [false, true]) {
    const instruction = checked
      ? createTransferCheckedInstruction(
        new PublicKey(SOURCE_TOKEN),
        new PublicKey(QUOTE_MINT),
        new PublicKey(DESTINATION_TOKEN),
        new PublicKey(FUNDER),
        5_000_000n,
        6,
        [],
        TOKEN_2022_PROGRAM_ID,
      )
      : createTransferInstruction(
        new PublicKey(SOURCE_TOKEN),
        new PublicKey(DESTINATION_TOKEN),
        new PublicKey(FUNDER),
        5_000_000n,
        [],
        TOKEN_2022_PROGRAM_ID,
      );
    const transfer = normalizeInstruction(instruction, location(1));
    const buyInstruction = pumpBuy(location(2), {
      user: BUYER,
      base_mint: BASE_MINT,
      quote_mint: QUOTE_MINT,
      quote_token_program: TOKEN_2022_PROGRAM_ID.toBase58(),
    });

    const result = extractor.extract(
      transaction([transfer, buyInstruction], {
        signerKeys: [BUYER],
        tokenBalances: tokenBalances(
          QUOTE_MINT,
          TOKEN_2022_PROGRAM_ID.toBase58(),
          FUNDER,
          BUYER,
        ),
      }),
      Object.freeze([fundingBuy(location(2), {
        quoteAsset: quote(QUOTE_MINT, 6, 'TOKEN_2022'),
      })]),
    );

    assert.equal(result.assessments[0]?.status, 'STRONG');
    assert.equal(result.evidence[0]?.quoteAsset.tokenProgram, 'TOKEN_2022');
  }
});

void test('marks ambiguous token ownership unavailable and ignores self consolidation', () => {
  const transfer = normalizeInstruction(
    createTransferInstruction(
      new PublicKey(SOURCE_TOKEN),
      new PublicKey(DESTINATION_TOKEN),
      new PublicKey(FUNDER),
      10n,
    ),
    location(1),
  );
  const buyInstruction = pumpBuy(location(2), {
    user: BUYER,
    base_mint: BASE_MINT,
    quote_mint: QUOTE_MINT,
    quote_token_program: TOKEN_PROGRAM_ID.toBase58(),
  });
  const targetBuy = fundingBuy(location(2), {
    quoteAsset: quote(QUOTE_MINT, 6, 'SPL_TOKEN'),
  });

  const unavailable = extractor.extract(
    transaction([transfer, buyInstruction], {
      signerKeys: [BUYER],
      tokenBalances: Object.freeze([
        balance(SOURCE_TOKEN, QUOTE_MINT, null, TOKEN_PROGRAM_ID.toBase58(), 0),
        balance(DESTINATION_TOKEN, QUOTE_MINT, BUYER, TOKEN_PROGRAM_ID.toBase58(), 1),
      ]),
    }),
    Object.freeze([targetBuy]),
  );
  assert.equal(unavailable.assessments[0]?.status, 'UNAVAILABLE');
  assert.deepEqual(unavailable.assessments[0]?.diagnosticCodes, [
    'TOKEN_BALANCE_UNAVAILABLE',
  ]);
  assert.equal(unavailable.evidence.length, 0);

  const self = extractor.extract(
    transaction([transfer, buyInstruction], {
      signerKeys: [BUYER],
      tokenBalances: tokenBalances(
        QUOTE_MINT,
        TOKEN_PROGRAM_ID.toBase58(),
        BUYER,
        BUYER,
      ),
    }),
    Object.freeze([targetBuy]),
  );
  assert.equal(self.assessments[0]?.status, 'NO_EVIDENCE');
  assert.deepEqual(self.assessments[0]?.diagnosticCodes, [
    'SELF_TRANSFER_IGNORED',
  ]);
  assert.equal(self.assessments[0]?.ignoredTransferCount, 1);
  assert.equal(self.evidence.length, 0);
});

void test('marks a recognized malformed token transfer unavailable', () => {
  const malformed = Object.freeze({
    programId: TOKEN_PROGRAM_ID.toBase58(),
    accounts: Object.freeze([SOURCE_TOKEN, DESTINATION_TOKEN]),
    data: Uint8Array.of(TokenInstruction.Transfer),
    ...normalizedLocation(location(1)),
  });
  const buyInstruction = pumpBuy(location(2), {
    user: BUYER,
    base_mint: BASE_MINT,
    quote_mint: QUOTE_MINT,
    quote_token_program: TOKEN_PROGRAM_ID.toBase58(),
  });
  const result = extractor.extract(
    transaction([malformed, buyInstruction], {
      signerKeys: [BUYER],
      tokenBalances: tokenBalances(
        QUOTE_MINT,
        TOKEN_PROGRAM_ID.toBase58(),
        FUNDER,
        BUYER,
      ),
    }),
    Object.freeze([fundingBuy(location(2), {
      quoteAsset: quote(QUOTE_MINT, 6, 'SPL_TOKEN'),
    })]),
  );

  assert.equal(result.assessments[0]?.status, 'UNAVAILABLE');
  assert.deepEqual(result.assessments[0]?.diagnosticCodes, [
    'KNOWN_TRANSFER_INVALID',
  ]);
  assert.equal(result.evidence.length, 0);
});

void test('keeps a different fee payer medium and never merges it as a transfer', () => {
  const buyInstruction = pumpBuy(location(2), {
    user: BUYER,
    base_mint: BASE_MINT,
    quote_mint: WSOL_MINT,
  });
  const targetBuy = fundingBuy(location(2), {
    quoteAsset: quote(WSOL_MINT, 9, 'SPL_TOKEN'),
  });

  const medium = extractor.extract(
    transaction([buyInstruction], { signerKeys: [FUNDER, BUYER] }),
    Object.freeze([targetBuy]),
  );
  assert.equal(medium.assessments[0]?.status, 'MEDIUM_ONLY');
  assert.equal(medium.evidence[0]?.type, 'FEE_PAYER_FOR_BUYER');
  assert.equal(medium.evidence[0]?.amountRaw, null);
  assert.equal(medium.evidence[0]?.transferCursor, null);

  const none = extractor.extract(
    transaction([buyInstruction], { signerKeys: [BUYER] }),
    Object.freeze([targetBuy]),
  );
  assert.equal(none.assessments[0]?.status, 'NO_EVIDENCE');
  assert.equal(none.evidence.length, 0);
});

void test('consumes each transfer once and assigns it to the first compatible later buy', () => {
  const transfer = normalizeInstruction(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(FUNDER),
      toPubkey: new PublicKey(BUYER),
      lamports: 100n,
    }),
    location(1),
  );
  const firstAction = pumpBuy(location(2), {
    user: BUYER,
    base_mint: BASE_MINT,
    quote_mint: WSOL_MINT,
  });
  const secondAction = pumpBuy(location(3), {
    user: BUYER,
    base_mint: BASE_MINT,
    quote_mint: WSOL_MINT,
  });
  const first = fundingBuy(location(2), {
    eventId: 'buy-event-1',
    tradeId: 'buy-trade-1',
    quoteAsset: quote(WSOL_MINT, 9, 'SPL_TOKEN'),
  });
  const second = fundingBuy(location(3), {
    eventId: 'buy-event-2',
    tradeId: 'buy-trade-2',
    quoteAsset: quote(WSOL_MINT, 9, 'SPL_TOKEN'),
  });

  const result = extractor.extract(
    transaction([transfer, firstAction, secondAction], { signerKeys: [BUYER] }),
    Object.freeze([second, first]),
  );

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.buyTradeId, first.tradeId);
  assert.equal(result.assessments.find((item) =>
    item.buy.tradeId === first.tradeId)?.status, 'STRONG');
  assert.equal(result.assessments.find((item) =>
    item.buy.tradeId === second.tradeId)?.status, 'NO_EVIDENCE');
});

void test('excludes Pump technical accounts and rejects failed transaction input', () => {
  const action = pumpBuy(location(2), {
    user: BUYER,
    base_mint: BASE_MINT,
    quote_mint: WSOL_MINT,
    bonding_curve: TECHNICAL_FUNDER,
  });
  const transfer = normalizeInstruction(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(TECHNICAL_FUNDER),
      toPubkey: new PublicKey(BUYER),
      lamports: 100n,
    }),
    location(1),
  );
  const targetBuy = fundingBuy(location(2), {
    quoteAsset: quote(WSOL_MINT, 9, 'SPL_TOKEN'),
  });
  const result = extractor.extract(
    transaction([transfer, action], { signerKeys: [BUYER] }),
    Object.freeze([targetBuy]),
  );
  assert.equal(result.evidence.length, 0);
  assert.equal(result.assessments[0]?.status, 'NO_EVIDENCE');

  assert.throws(
    () => extractor.extract(
      transaction([transfer, action], {
        signerKeys: [BUYER],
        error: { InstructionError: [1, 'Custom'] },
      }),
      Object.freeze([targetBuy]),
    ),
    /failed transaction/u,
  );
});

function transaction(
  instructions: readonly NormalizedInstruction[],
  options: {
    readonly signerKeys?: readonly string[];
    readonly tokenBalances?: readonly NormalizedTokenBalance[];
    readonly error?: unknown;
  } = {},
): NormalizedTransaction {
  const accountKeys = Object.freeze([...new Set([
    ...(options.signerKeys ?? [BUYER]),
    ...instructions.flatMap((instruction) => instruction.accounts),
  ])]);
  const balances = options.tokenBalances ?? Object.freeze([]);
  return Object.freeze({
    signature: 'signature',
    slot: 10n,
    transactionIndex: 0,
    confirmationStatus: 'CONFIRMED' as const,
    version: 0,
    blockTimeMs: 1_720_000_000_000,
    accountKeys,
    signerKeys: Object.freeze([...(options.signerKeys ?? [BUYER])]),
    instructions: Object.freeze([...instructions]),
    preTokenBalances: balances,
    postTokenBalances: balances,
    preBalancesLamports: Object.freeze(accountKeys.map(() => 0n)),
    postBalancesLamports: Object.freeze(accountKeys.map(() => 0n)),
    feeLamports: 5_000n,
    computeUnits: null,
    logs: Object.freeze([]),
    error: options.error ?? null,
  });
}

function fundingBuy(
  target: Location,
  overrides: Partial<WalletFundingBuy> = {},
): WalletFundingBuy {
  return Object.freeze({
    eventId: 'buy-event',
    tradeId: 'buy-trade',
    mint: BASE_MINT,
    buyer: BUYER,
    source: 'pumpfun',
    program: PUMP_PROGRAM_ID,
    quoteAsset: quote(WSOL_MINT, 9, 'SPL_TOKEN'),
    signature: 'signature',
    cursor: frozenCursor(target),
    confirmationStatus: 'confirmed',
    blockchainTimeMs: 1_720_000_000_000,
    observedAtMs: 1_720_000_000_100,
    ...overrides,
  });
}

function pumpBuy(
  target: Location,
  accountOverrides: Readonly<Record<string, string>>,
): NormalizedInstruction {
  const definition = PUMP_INSTRUCTIONS.buy_v2;
  const data = Buffer.alloc(24);
  data.set(definition.discriminator, 0);
  data.writeBigUInt64LE(1n, 8);
  data.writeBigUInt64LE(1n, 16);
  const accounts = definition.accounts.map((account, index) =>
    accountOverrides[account.name] ?? address(30 + index));
  return Object.freeze({
    programId: PUMP_PROGRAM_ID,
    accounts: Object.freeze(accounts),
    data: Uint8Array.from(data),
    ...normalizedLocation(target),
  });
}

function normalizeInstruction(
  instruction: TransactionInstruction,
  target: Location,
): NormalizedInstruction {
  return Object.freeze({
    programId: instruction.programId.toBase58(),
    accounts: Object.freeze(instruction.keys.map((key) => key.pubkey.toBase58())),
    data: Uint8Array.from(instruction.data),
    ...normalizedLocation(target),
  });
}

function normalizedLocation(target: Location): Pick<
  NormalizedInstruction,
  'instructionIndex' | 'innerInstructionIndex' | 'parentInstructionIndex' | 'stackHeight'
> {
  return {
    instructionIndex: target.instructionIndex,
    innerInstructionIndex: target.innerInstructionIndex,
    parentInstructionIndex: target.innerInstructionIndex === null
      ? null
      : target.instructionIndex,
    stackHeight: target.stackHeight,
  };
}

function tokenBalances(
  mint: string,
  tokenProgram: string,
  sourceOwner: string | null,
  destinationOwner: string | null,
): readonly NormalizedTokenBalance[] {
  return Object.freeze([
    balance(SOURCE_TOKEN, mint, sourceOwner, tokenProgram, 0),
    balance(DESTINATION_TOKEN, mint, destinationOwner, tokenProgram, 1),
  ]);
}

function balance(
  account: string,
  mint: string,
  owner: string | null,
  tokenProgram: string,
  accountIndex: number,
): NormalizedTokenBalance {
  return Object.freeze({
    accountIndex,
    account,
    mint,
    owner,
    tokenProgram,
    amountRaw: 1_000_000n,
    decimals: 6,
  });
}

function quote(
  mint: string,
  decimals: number,
  tokenProgram: 'SPL_TOKEN' | 'TOKEN_2022',
) {
  return Object.freeze({ mint, decimals, tokenProgram });
}

interface Location {
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly stackHeight: number;
}

function location(
  instructionIndex: number,
  innerInstructionIndex: number | null = null,
  stackHeight = innerInstructionIndex === null ? 1 : 2,
): Location {
  return Object.freeze({
    instructionIndex,
    innerInstructionIndex,
    stackHeight,
  });
}

function frozenCursor(target: Location) {
  return Object.freeze({
    slot: 10n,
    transactionIndex: 0,
    instructionIndex: target.instructionIndex,
    innerInstructionIndex: target.innerInstructionIndex,
  });
}

function address(seed: number): string {
  return new PublicKey(Uint8Array.from(
    { length: 32 },
    (_unused, index) => (seed + index) % 256,
  )).toBase58();
}
