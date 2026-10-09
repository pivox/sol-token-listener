import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMP_INSTRUCTIONS } from '../src/launchpads/pumpfun/generated/pump-idl.js';
import { decodePumpInstruction } from '../src/launchpads/pumpfun/instruction-decoder.js';
import { bondingCurvePda } from '../src/launchpads/pumpfun/official-sdk.js';
import { decodePumpTransaction } from '../src/launchpads/pumpfun/transaction-decoder.js';
import { poolPda, pumpPoolAuthorityPda } from '../src/markets/pumpswap/official-sdk.js';
import { loadPumpFixture, parsePumpFixture } from './helpers/pumpfun-fixture.js';

void test('observe la création opaque finalisée et son achat initial multi-quote', async () => {
  const fixture = await loadPumpFixture('create-v2-opaque-holder-mainnet.json');
  const instruction = fixture.transaction.instructions.find((candidate) =>
    Buffer.from(candidate.data.subarray(0, 8)).equals(
      Buffer.from(PUMP_INSTRUCTIONS.create_v2.discriminator),
    ));
  assert.ok(instruction);
  assert.equal(Buffer.from(instruction.data.subarray(-2)).toString('hex'), '0001');
  assert.equal(fixture.provenance.slot, 452_406_478n);
  assert.equal(fixture.provenance.transactionIndex, 78);
  assert.equal(fixture.transaction.confirmationStatus, 'FINALIZED');
  assert.equal(fixture.transaction.error, null);
  assert.throws(() => decodePumpInstruction(instruction),
    (error: unknown) => error instanceof Error
      && 'code' in error && error.code === 'PUMP_BORSH_INVALID');

  const decoded = decodePumpTransaction(fixture.transaction);
  assert.equal(decoded.creations.length, 1);
  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.event.isBuy, true);
  assert.equal(decoded.creations[0]?.isHolderReward, true);
  assert.equal(decoded.creations[0]?.quoteAsset.mint,
    'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn');
  assert.equal(decoded.creations[0]?.quoteAsset.tokenProgram, 'TOKEN_2022');
  assert.equal(decoded.creations[0]?.quoteAsset.decimals, 6);
  assert.equal(decoded.creations[0]?.action.instruction, instruction);
  const creation = decoded.creations[0];
  assert.ok(creation);
  assert.deepEqual(creation.action.wireEvidence, {
    profile: 'CREATE_V2_OPAQUE_0001_V1',
    pairedEventCursor: {
      instructionIndex: creation.eventCpi.instruction.instructionIndex,
      innerInstructionIndex: creation.eventCpi.instruction.innerInstructionIndex,
      stackHeight: creation.eventCpi.instruction.stackHeight,
    },
  });
  assert.deepEqual(Object.keys(creation.action.args), [
    'name', 'symbol', 'uri', 'creator', 'is_mayhem_mode',
  ]);
  assert.equal(creation.creatorFeeBps, 0n);
  assert.equal(creation.event.isCashbackEnabled, false);
  assert.equal(decoded.trades[0]?.action.wireEvidence, undefined);
});

void test('observe la vente opaque finalisée avec événement appairé', async () => {
  const fixture = await loadPumpFixture('sell-opaque-volume-mainnet.json');
  const instruction = fixture.transaction.instructions.find((candidate) =>
    Buffer.from(candidate.data.subarray(0, 8)).equals(
      Buffer.from(PUMP_INSTRUCTIONS.sell.discriminator),
    ));
  assert.ok(instruction);
  assert.equal(Buffer.from(instruction.data.subarray(-2)).toString('hex'), '0100');
  assert.equal(fixture.provenance.slot, 452_406_531n);
  assert.equal(fixture.provenance.transactionIndex, 460);
  assert.equal(fixture.transaction.confirmationStatus, 'FINALIZED');
  assert.equal(fixture.transaction.error, null);
  assert.throws(() => decodePumpInstruction(instruction),
    (error: unknown) => error instanceof Error
      && 'code' in error && error.code === 'PUMP_BORSH_INVALID');

  const decoded = decodePumpTransaction(fixture.transaction);
  assert.equal(decoded.creations.length, 0);
  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.event.isBuy, false);
  assert.equal(decoded.trades[0]?.event.tokenAmount, 25_659_383_952_290n);
  assert.equal(decoded.trades[0]?.action.instruction, instruction);
  const trade = decoded.trades[0];
  assert.ok(trade);
  assert.deepEqual(trade.action.wireEvidence, {
    profile: 'SELL_OPAQUE_0100_V1',
    pairedEventCursor: {
      instructionIndex: trade.eventCpi.instruction.instructionIndex,
      innerInstructionIndex: trade.eventCpi.instruction.innerInstructionIndex,
      stackHeight: trade.eventCpi.instruction.stackHeight,
    },
  });
  assert.deepEqual(Object.keys(trade.action.args), ['amount', 'min_sol_output']);
  assert.equal(trade.event.tokenAmount, trade.action.args.amount);
  assert.equal(trade.event.trackVolume, false);
  assert.equal(trade.event.ixName, 'sell');
});

void test('décode hors ligne la création mainnet et son achat initial', async () => {
  const fixture = await loadPumpFixture('create-v2-initial-buy-mainnet.json');
  const decoded = decodePumpTransaction(fixture.transaction);

  assert.equal(fixture.schemaVersion, 'solana-mainnet-fixture.v1');
  assert.equal(fixture.family, 'pumpfun');
  assert.equal(fixture.sanitization.anonymized, false);
  assert.equal(fixture.transaction.confirmationStatus, 'FINALIZED');
  assert.equal(fixture.provenance.transactionIndex, 946);
  assert.equal(decoded.creations.length, 1);
  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.event.isBuy, true);
});

void test('décode la création Mainnet courante et son achat initial', async () => {
  const fixture = await loadPumpFixture(
    'create-v2-current-initial-buy-mainnet.json',
  );
  const decoded = decodePumpTransaction(fixture.transaction);

  assert.equal(
    fixture.provenance.signature,
    '28yWZwRAEfMTvD4H82PaCaK3oxwuia4HqWa9QQbHZoCuu5EPJwiJyazn2udwM8PT3wfEPLac6kcpEoGi4LRFBvT7',
  );
  assert.equal(decoded.creations.length, 1);
  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.event.isBuy, true);
  assert.equal(decoded.creations[0]?.creatorFeeBps, 0n);
  assert.equal(decoded.creations[0]?.isHolderReward, false);
});

void test('valide le PDA quote-control et le créateur effectif holder-reward Mainnet', async () => {
  const fixture = await loadPumpFixture('create-v2-quote-control-mainnet.json');
  const decoded = decodePumpTransaction(fixture.transaction);
  const creation = decoded.creations[0];

  assert.equal(decoded.creations.length, 1);
  assert.ok(creation);
  assert.equal(creation.action.accounts.quote_control, '6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP');
  assert.equal(creation.creatorFeeBps, 300n);
  assert.equal(creation.isHolderReward, true);
  assert.notEqual(creation.requestedCreator, creation.effectiveCreator);
  assert.equal(
    creation.effectiveCreator,
    PublicKey.findProgramAddressSync(
      [
        Buffer.from('holder-rewards'),
        new PublicKey(creation.event.mint).toBuffer(),
      ],
      new PublicKey(PUMP_PROGRAM_ID),
    )[0].toBase58(),
  );
});

void test('décode la création Mainnet cotée dans un coin pump non migré (cinq remaining accounts)', async () => {
  const fixture = await loadPumpFixture('create-v2-pump-quote-curve-mainnet.json');
  const decoded = decodePumpTransaction(fixture.transaction);
  const creation = decoded.creations[0];
  const quoteMint = 'AAeVN8d7YSKaf1EDpaFgNVjvCuTYZopJu9pJXW8avamp';

  assert.equal(
    fixture.provenance.signature,
    '3nd9NnqSjfJjh6W149rEitdW1LvDcpncw4mmReZjKDvzAgBsxje4bkkhGRg3vTAiYTewFZVGSVCwvQstYPRUNjUC',
  );
  assert.equal(fixture.provenance.slot, 454_797_478n);
  assert.equal(fixture.provenance.transactionIndex, 746);
  assert.equal(decoded.creations.length, 1);
  assert.equal(decoded.trades.length, 0);
  assert.ok(creation);
  assert.equal(
    creation.action.instruction.accounts.length,
    PUMP_INSTRUCTIONS.create_v2.accounts.length + 5,
  );
  assert.equal(creation.action.wireEvidence, undefined);
  assert.deepEqual(creation.quoteAsset, { mint: quoteMint, decimals: 6, tokenProgram: 'TOKEN_2022' });
  assert.equal(creation.event.quoteMint, quoteMint);
  assert.equal(creation.event.depth, 1);
  assert.equal(creation.action.accounts.quote_control, '6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP');
  assert.equal(creation.action.accounts.quote_bonding_curve, bondingCurvePda(quoteMint).toBase58());
  assert.equal(creation.action.accounts.quote_bonding_curve, '2sirTTFugL6oxUSvV7ZESG9CHRTzbaS4k4VXAmSESGYQ');
  assert.equal(Object.hasOwn(creation.action.accounts, 'quote_pool'), false);
});

void test('décode la création Mainnet cotée dans un coin pump migré et son achat initial (huit remaining accounts)', async () => {
  const fixture = await loadPumpFixture('create-v2-pump-quote-pool-mainnet.json');
  const decoded = decodePumpTransaction(fixture.transaction);
  const creation = decoded.creations[0];
  const trade = decoded.trades[0];
  const quoteMint = 'NV2RYH954cTJ3ckFUpvfqaQXU4ARqqDH3562nFSpump';
  // The migrated quote coin's canonical pump-amm pool: index 0 under its pump pool-authority PDA,
  // quoted in WSOL like the SOL curve it graduated from.
  const pool = poolPda(0, pumpPoolAuthorityPda(new PublicKey(quoteMint)), new PublicKey(quoteMint), NATIVE_MINT);

  assert.equal(
    fixture.provenance.signature,
    '4MVxbMzFXnGoa3U9NH2xxB5DSPJWmh4pfyKUHXiPVafpcSjR1G2vnc4bcDzTPi6vztif7RSg6UsTEQdce2Dbk3Cd',
  );
  assert.equal(fixture.provenance.slot, 454_800_482n);
  assert.equal(fixture.provenance.transactionIndex, 417);
  assert.equal(fixture.transaction.version, 1);
  assert.equal(decoded.creations.length, 1);
  assert.equal(decoded.trades.length, 1);
  assert.ok(creation);
  assert.ok(trade);
  assert.equal(
    creation.action.instruction.accounts.length,
    PUMP_INSTRUCTIONS.create_v2.accounts.length + 8,
  );
  assert.equal(creation.action.wireEvidence?.profile, 'CREATE_V2_OPAQUE_0001_V1');
  assert.equal(creation.isHolderReward, true);
  assert.deepEqual(creation.quoteAsset, { mint: quoteMint, decimals: 6, tokenProgram: 'TOKEN_2022' });
  assert.equal(creation.event.depth, 1);
  assert.equal(creation.action.accounts.quote_bonding_curve, bondingCurvePda(quoteMint).toBase58());
  assert.equal(creation.action.accounts.quote_pool, pool.toBase58());
  assert.equal(
    creation.action.accounts.quote_pool_base_vault,
    getAssociatedTokenAddressSync(new PublicKey(quoteMint), pool, true, TOKEN_2022_PROGRAM_ID).toBase58(),
  );
  assert.equal(
    creation.action.accounts.quote_pool_quote_vault,
    getAssociatedTokenAddressSync(NATIVE_MINT, pool, true, TOKEN_PROGRAM_ID).toBase58(),
  );
  assert.equal(trade.action.name, 'buy_exact_quote_in_v2');
  assert.equal(trade.event.isBuy, true);
  assert.equal(trade.event.mint, creation.event.mint);
  assert.equal(trade.quoteAsset.mint, quoteMint);
});

void test('décode hors ligne une vente CPI avec stackHeight 3', async () => {
  const fixture = await loadPumpFixture('sell-cpi-mainnet.json');
  const decoded = decodePumpTransaction(fixture.transaction);

  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.event.isBuy, false);
  assert.equal(decoded.trades[0]?.eventCpi.instruction.stackHeight, 3);
});

void test('décode hors ligne un achat V2 CPI multi-quote', async () => {
  const fixture = await loadPumpFixture('buy-exact-quote-v2-cpi-mainnet.json');
  const decoded = decodePumpTransaction(fixture.transaction);

  assert.equal(fixture.provenance.transactionIndex, 1188);
  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.action.name, 'buy_exact_quote_in_v2');
  assert.equal(decoded.trades[0]?.action.instruction.stackHeight, 2);
  assert.equal(decoded.trades[0]?.eventCpi.instruction.stackHeight, 3);
});

void test('décode le suffixe volume historique de buy_exact_quote_in_v2 interne', async () => {
  const fixture = await loadPumpFixture(
    'buy-exact-quote-v2-track-volume-mainnet.json',
  );
  const decoded = decodePumpTransaction(fixture.transaction);
  const trade = decoded.trades[0];

  assert.equal(fixture.provenance.slot, 450_205_204n);
  assert.equal(fixture.provenance.transactionIndex, 1_113);
  assert.equal(decoded.trades.length, 1);
  assert.ok(trade);
  assert.equal(trade.action.name, 'buy_exact_quote_in_v2');
  assert.equal(trade.action.instruction.innerInstructionIndex, 1);
  assert.deepEqual(trade.action.args.track_volume, [true]);
});

void test('décode le suffixe option historique de buy_exact_sol_in externe', async () => {
  const fixture = await loadPumpFixture(
    'buy-exact-sol-in-option-mainnet.json',
  );
  const decoded = decodePumpTransaction(fixture.transaction);
  const trade = decoded.trades[0];

  assert.equal(fixture.provenance.slot, 450_205_410n);
  assert.equal(fixture.provenance.transactionIndex, 238);
  assert.equal(decoded.trades.length, 1);
  assert.ok(trade);
  assert.equal(trade.action.name, 'buy_exact_sol_in');
  assert.equal(trade.action.instruction.innerInstructionIndex, null);
  assert.deepEqual(trade.action.args.track_volume, [false]);
});

void test('décode le buy_exact_sol_in Mainnet sans suffixe', async () => {
  const fixture = await loadPumpFixture(
    'buy-exact-sol-in-omitted-mainnet.json',
  );
  const decoded = decodePumpTransaction(fixture.transaction);
  const trade = decoded.trades[0];

  assert.equal(
    fixture.provenance.signature,
    'EYKWHsAcnkDbr9AkNFSwrLKNqkr17EbrMK7HcFqtAyvrFDQ6ssYZmcMsLkkmHFLNSCkxum2cSPWNN7t1F9DWsvv',
  );
  assert.equal(fixture.provenance.slot, 451_001_703n);
  assert.equal(fixture.provenance.transactionIndex, 540);
  assert.equal(decoded.trades.length, 1);
  assert.ok(trade);
  assert.equal(trade.action.name, 'buy_exact_sol_in');
  assert.equal(Object.hasOwn(trade.action.args, 'track_volume'), false);
  assert.equal(
    Buffer.from(trade.action.instruction.data).toString('hex'),
    '38fc74089edfcd5f0065cd1d000000000100000000000000',
  );
  assert.equal(trade.event.isBuy, true);
  assert.equal(trade.action.accounts.mint, trade.event.mint);
  assert.equal(
    trade.action.instruction.instructionIndex,
    trade.eventCpi.instruction.instructionIndex,
  );
  assert.equal(trade.action.args.spendable_sol_in, 500_000_000n);
  assert.equal(trade.action.args.min_tokens_out, 1n);
  assert.equal(trade.event.solAmount, 493_827_159n);
  assert.equal(trade.event.tokenAmount, 12_048_581_000_247n);
});

void test('décode le Some(true) historique du buy Mainnet', async () => {
  const fixture = await loadPumpFixture('buy-option-true-mainnet.json');
  const decoded = decodePumpTransaction(fixture.transaction);
  const trade = decoded.trades[0];

  assert.equal(
    fixture.provenance.signature,
    '3chxQscqoPW9sFxo7RMj17YHKJYKj3K4dMFXLTrJd2VB2NrnSqkwxNbA1mEbv2GJNBe7gVqTvrGxXMmd1Uqbf7V9',
  );
  assert.equal(fixture.provenance.slot, 451_001_714n);
  assert.equal(fixture.provenance.transactionIndex, 751);
  assert.equal(decoded.trades.length, 1);
  assert.ok(trade);
  assert.equal(trade.action.name, 'buy');
  assert.deepEqual(trade.action.args.track_volume, [true]);
  assert.equal(
    Buffer.from(trade.action.instruction.data).toString('hex'),
    '66063d1201daebeacf3b52ec9e010000fcb1f006000000000101',
  );
  assert.equal(trade.event.isBuy, true);
  assert.equal(trade.action.accounts.mint, trade.event.mint);
  assert.equal(
    trade.action.instruction.instructionIndex,
    trade.eventCpi.instruction.instructionIndex,
  );
  assert.equal(trade.action.args.amount, trade.event.tokenAmount);
  assert.equal(trade.action.args.amount, 1_782_081_272_783n);
  assert.equal(trade.action.args.max_sol_cost, 116_437_500n);
  assert.equal(trade.event.solAmount, 100_472_247n);
});

void test('refuse une provenance qui ne correspond pas à la transaction', async () => {
  const path = new URL(
    './fixtures/pumpfun/sell-cpi-mainnet.json',
    import.meta.url,
  );
  const value = JSON.parse(await readFile(path, 'utf8')) as {
    provenance: { signature: string };
  };
  value.provenance.signature = 'mismatch';

  assert.throws(() => parsePumpFixture(value), /provenance\.signature/);
});

void test('refuse les champs hors contrat et les preuves prétendument anonymisées', async () => {
  const path = new URL(
    './fixtures/pumpfun/sell-cpi-mainnet.json',
    import.meta.url,
  );
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

  assert.throws(() => parsePumpFixture({ ...value, endpoint: 'https://private.invalid' }), /clés/u);
  assert.throws(() => parsePumpFixture({ ...value, family: 'pumpswap' }), /family/u);
  assert.throws(() => parsePumpFixture({
    ...value,
    sanitization: { contract: 'normalized-public-chain.v1', anonymized: true },
  }), /anonymized/u);
  assert.throws(() => parsePumpFixture({
    ...value,
    transaction: { ...(value.transaction as object), logs: [] },
  }), /transaction.*clés/u);
  assert.throws(() => parsePumpFixture({
    ...value,
    provenance: {
      ...(value.provenance as object),
      capturedAt: '2026-08-08 08:00:00Z',
    },
  }), /capturedAt.*ISO-8601/u);
  assert.throws(() => parsePumpFixture({
    ...value,
    provenance: {
      ...(value.provenance as object),
      slot: '043',
    },
  }), /provenance\.slot.*entier décimal/u);
  assert.throws(() => parsePumpFixture({
    ...value,
    transaction: {
      ...(value.transaction as object),
      confirmationStatus: 'CONFIRMED',
    },
  }), /confirmationStatus.*FINALIZED/u);
});
