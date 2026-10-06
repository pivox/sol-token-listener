import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileLiveTokenBalance } from '../src/live/live-token-reconciliation.js';

const wallet = 'wallet-test';
const mint = 'mint-test';
const balance = (owner: string, tokenMint: string, amount: string) => ({
  owner, mint: tokenMint, uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1_000_000 },
});

test('somme les comptes du wallet par montant entier, ignore autres owners et mints', () => {
  const result = reconcileLiveTokenBalance({
    owner: wallet, mint,
    transaction: { meta: {
      err: null,
      preTokenBalances: [balance(wallet, mint, '10'), balance(wallet, 'other', '900'), balance('other-wallet', mint, '700')],
      postTokenBalances: [balance(wallet, mint, '1000001'), balance(wallet, mint, '2000000'), balance('other-wallet', mint, '9000')],
    } },
  });
  assert.deepEqual(result, {
    status: 'KNOWN', owner: wallet, mint, preAmountRaw: 10n,
    postAmountRaw: 3_000_001n, deltaRaw: 2_999_991n,
  });
});

test('un compte ATA créé est un delta depuis zéro seulement si les deux côtés sont présents', () => {
  const result = reconcileLiveTokenBalance({
    owner: wallet, mint,
    transaction: { meta: { err: null, preTokenBalances: [], postTokenBalances: [balance(wallet, mint, '42')] } },
  });
  assert.equal(result.status, 'KNOWN');
  if (result.status === 'KNOWN') assert.equal(result.deltaRaw, 42n);
});

test('des métadonnées absentes ou un échec ne deviennent jamais un delta nul', () => {
  assert.deepEqual(reconcileLiveTokenBalance({ owner: wallet, mint, transaction: null }), { status: 'UNKNOWN', reason: 'TRANSACTION_MISSING' });
  assert.deepEqual(reconcileLiveTokenBalance({ owner: wallet, mint, transaction: { meta: null } }), { status: 'UNKNOWN', reason: 'METADATA_MISSING' });
  assert.deepEqual(reconcileLiveTokenBalance({ owner: wallet, mint, transaction: { meta: { err: { InstructionError: [0, 'Custom'] } } } }), { status: 'UNKNOWN', reason: 'EXECUTION_FAILED' });
  assert.deepEqual(reconcileLiveTokenBalance({ owner: wallet, mint, transaction: { meta: { err: null } } }), { status: 'UNKNOWN', reason: 'TOKEN_BALANCES_MISSING' });
});
