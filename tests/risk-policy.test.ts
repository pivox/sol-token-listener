import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../src/config/env.js';
import type { TokenExtensionInfo, TokenMetadata } from '../src/domain/types.js';
import { checkExtensions, checkFreezeAuthority, checkLiquidity, transferFeeCalculator } from '../src/security/token-risk.service.js';

const config = {
  riskMaxTransferFeeBps: 1500,
} as AppConfig;

function extension(type: string, details: Record<string, unknown> = {}, affectsTransfers = true, mutable: boolean | null = null): TokenExtensionInfo {
  return { type, details, affectsTransfers, mutable };
}

void test('bloque une freeze authority active', () => {
  const metadata = { freezeAuthority: 'Freeze111111111111111111111111111111111111' } as TokenMetadata;
  const check = checkFreezeAuthority(metadata);
  assert.equal(check.status, 'FAIL');
  assert.equal(check.critical, true);
});

void test('bloque PermanentDelegate et TransferHook inconnu', () => {
  assert.equal(checkExtensions([extension('PermanentDelegate', { authority: 'delegate' })], config).status, 'FAIL');
  assert.equal(checkExtensions([extension('TransferHook', { programId: 'hook' })], config).status, 'FAIL');
});

void test('bloque NonTransferable, état gelé et frais au-dessus du seuil', () => {
  assert.equal(checkExtensions([extension('NonTransferable')], config).status, 'FAIL');
  assert.equal(checkExtensions([extension('DefaultAccountState', { frozenByDefault: true })], config).status, 'FAIL');
  assert.equal(checkExtensions([extension('TransferFeeConfig', { transferFeeBasisPoints: 1600, maximumFeeRaw: '1000' })], config).status, 'FAIL');
});

void test('signale les frais acceptables mais modifiables en WARN', () => {
  const check = checkExtensions([extension('TransferFeeConfig', { transferFeeBasisPoints: 100 }, true, true)], config);
  assert.equal(check.status, 'WARN');
});

void test('applique le plafond de frais Token-2022 sans flottant', () => {
  const fee = transferFeeCalculator([extension('TransferFeeConfig', { transferFeeBasisPoints: 500, maximumFeeRaw: '25' })]);
  assert.equal(fee(1000n), 25n);
});

void test('le seuil de liquidité est critique', () => {
  assert.equal(checkLiquidity(249_999_999n, 250_000_000n, 1n).status, 'FAIL');
  assert.equal(checkLiquidity(250_000_000n, 250_000_000n, 1n).status, 'PASS');
});
