import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { PUMPSWAP_INSTRUCTIONS } from '../src/markets/pumpswap/generated/pumpswap-idl.js';
import { decodePumpSwapInstruction } from '../src/markets/pumpswap/instruction-decoder.js';
import type { NormalizedInstruction } from '../src/solana/rpc/types.js';

const PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const KEY = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

void test('décode toutes les actions PumpSwap suivies depuis l’IDL', () => {
  const values = {
    buy: [10n, 20n, [true]],
    buy_exact_quote_in: [20n, 10n, [false]],
    create_pool: [0n, 100n, 200n, KEY.toBase58(), false, [true]],
    sell: [10n, 5n],
  } as const;

  for (const name of Object.keys(PUMPSWAP_INSTRUCTIONS) as
    (keyof typeof PUMPSWAP_INSTRUCTIONS)[]) {
    const definition = PUMPSWAP_INSTRUCTIONS[name];
    const instruction: NormalizedInstruction = {
      programId: PROGRAM,
      accounts: definition.accounts.map((_, index) => address(index + 5)),
      data: Uint8Array.from([
        ...definition.discriminator,
        ...encode(values[name]),
      ]),
      instructionIndex: 2,
      innerInstructionIndex: null,
      parentInstructionIndex: null,
      stackHeight: 1,
    };

    const decoded = decodePumpSwapInstruction(instruction);

    assert.equal(decoded?.name, name);
    assert.deepEqual(Object.keys(decoded?.accounts ?? {}), definition.accounts.map((a) => a.name));
  }
});

void test('classe les achats exact quote comme BUY', () => {
  const definition = PUMPSWAP_INSTRUCTIONS.buy_exact_quote_in;
  const decoded = decodePumpSwapInstruction({
    programId: PROGRAM,
    accounts: definition.accounts.map((_, index) => address(index + 50)),
    data: Uint8Array.from([
      ...definition.discriminator,
      ...encode([20n, 10n, [true]]),
    ]),
    instructionIndex: 1,
    innerInstructionIndex: 0,
    parentInstructionIndex: 1,
    stackHeight: 2,
  });
  assert.equal(decoded?.family, 'BUY');
});

function encode(values: readonly unknown[]): Uint8Array {
  return Uint8Array.from(values.flatMap((value) => {
    if (typeof value === 'bigint') {
      const width = value === 0n && values.length === 6 ? 2 : 8;
      const bytes = new Uint8Array(width);
      const view = new DataView(bytes.buffer);
      if (width === 2) view.setUint16(0, Number(value), true);
      else view.setBigUint64(0, value, true);
      return [...bytes];
    }
    if (typeof value === 'string') return [...new PublicKey(value).toBytes()];
    if (typeof value === 'boolean') return [value ? 1 : 0];
    if (Array.isArray(value) && typeof value[0] === 'boolean') {
      return [value[0] ? 1 : 0];
    }
    throw new Error('Valeur de test PumpSwap non encodable.');
  }));
}

function address(seed: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) =>
    (seed + index) % 256)).toBase58();
}
