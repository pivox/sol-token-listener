import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { decodePumpTransaction } from '../src/launchpads/pumpfun/transaction-decoder.js';
import { loadPumpFixture, parsePumpFixture } from './helpers/pumpfun-fixture.js';

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
