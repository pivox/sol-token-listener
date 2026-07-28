# Pump.fun Creation and Trade Decoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode current Pump.fun token creations and bonding-curve trades from official instruction and CPI-event schemas, without activating production behavior or making runtime RPC calls.

**Architecture:** Vendor the official Pump IDL at one immutable commit, generate a small TypeScript schema module, and decode normalized Solana instructions with strict local Borsh codecs. A transaction decoder pairs every supported Pump action with exactly one CPI event using canonical instruction order and real stack heights; a non-composed `PumpFunLaunchpadAdapter` maps the complete Pump evidence to the generic PR B domain.

**Tech Stack:** TypeScript 5.8 strict ESM, Node.js 22+, `@solana/web3.js`, `@solana/spl-token`, Node test runner through `tsx`, SHA-256, checked-in normalized Solana fixtures.

---

## Scope and file map

This plan implements one subsystem: Pump.fun transaction decoding. It does not
activate WebSocket observation, read bonding-curve accounts, add PostgreSQL
migrations, fetch metadata, quote trades, or decode migration/PumpSwap
instructions.

### Files created

| File | Responsibility |
| --- | --- |
| `vendor/pumpfun/README.md` | Immutable source, revision, checksum, refresh procedure |
| `vendor/pumpfun/idl/pump-9c82f61.json` | Exact official IDL snapshot |
| `scripts/generate-pumpfun-idl.ts` | Validate the snapshot and render selected schemas deterministically |
| `src/launchpads/pumpfun/generated/pump-idl.ts` | Generated discriminators, accounts, args, events, and selected types |
| `src/launchpads/pumpfun/constants.ts` | Pump, SPL Token, Token-2022, WSOL, and default-pubkey constants |
| `src/launchpads/pumpfun/errors.ts` | Stable typed decoding error codes |
| `src/launchpads/pumpfun/borsh-reader.ts` | Bounds-checked integer, string, pubkey, and byte reader |
| `src/launchpads/pumpfun/idl-codec.ts` | Recursive decoder for the selected generated IDL types |
| `src/launchpads/pumpfun/types.ts` | Pump-specific decoded instruction, event, pair, and transaction contracts |
| `src/launchpads/pumpfun/instruction-decoder.ts` | Supported instruction classification, args, and named account mapping |
| `src/launchpads/pumpfun/event-decoder.ts` | Anchor CPI tag validation and typed Create/Trade event decoding |
| `src/launchpads/pumpfun/quote-asset.ts` | Local quote normalization and transaction-balance evidence |
| `src/launchpads/pumpfun/transaction-decoder.ts` | CPI scope pairing and cross-evidence validation |
| `src/launchpads/pumpfun/pumpfun-launchpad.adapter.ts` | Mapping to `LaunchpadAdapter` with per-observation WeakMap |
| `tests/helpers/pumpfun-fixture.ts` | Strict parser for sanitized Pump fixtures |
| `tests/fixtures/pumpfun/*.json` | Three public, normalized, offline fixtures |
| `tests/pumpfun-idl-generation.test.ts` | Provenance and deterministic generation |
| `tests/transaction-normalization.test.ts` | Real inner stack-height preservation |
| `tests/pumpfun-borsh-reader.test.ts` | Bounds and integer correctness |
| `tests/pumpfun-instruction-decoder.test.ts` | Every supported instruction |
| `tests/pumpfun-event-decoder.test.ts` | Create/Trade event schemas and failures |
| `tests/pumpfun-quote-asset.test.ts` | SOL, generic quote, conflicts, and Token Programs |
| `tests/pumpfun-transaction-decoder.test.ts` | Pairing, CPI, multiple actions, and fail-closed behavior |
| `tests/pumpfun-launchpad-adapter.test.ts` | Generic mapping, initial buy, filtering, and no composition |

### Files modified

| File | Change |
| --- | --- |
| `package.json` | Add offline IDL generation/check scripts and include the check in `npm run check` |
| `src/solana/rpc/transaction-fetcher.ts` | Preserve RPC-provided inner `stackHeight` |
| `docs/architecture/pumpfun-v1.md` | Record implemented decoder revision and remaining non-goals |

## Official fixture provenance

Capture each transaction once, then run all tests offline:

| Scenario | Signature | Slot | `transactionIndex` |
| --- | --- | ---: | ---: |
| `create_v2` + initial `buy_v2` | `5e5t9JwautKTqCNKqHmDiZhJx9K2x85kd7RbFfbtGZ4DtcLwPW4U18ZWoinYcCuUQzZ3WRmEiMe3BDsSewVwto8h` | `435798633` | `946` |
| CPI legacy `sell` | `3tVQzGUFNsAHoTcfiCbuX87y7Ta9rdY2BdTvgeSGwbEu7Nok8bfAGSCDwZMkuVMjjRniXyx6VKfYnPQXUCSC7yHG` | `435798642` | `763` |
| CPI `buy_exact_quote_in_v2` | `57qfbsAcVGdenmgVq2sySpVcgyNDCx1aXLQvwz2kuX4fr8V5twxzdCdvWK2RjsZUuArCdneB4WzcSotaWVE8Forw` | `435782997` | `1188` |

The fixtures keep public Pump accounts, instruction bytes, token-balance
evidence, signature, slot, indexes, and confirmation status. They omit logs,
unrelated lamport balances, and unrelated account metadata.

---

### Task 1: Vendor and generate the official Pump IDL subset

**Files:**
- Create: `vendor/pumpfun/README.md`
- Create: `vendor/pumpfun/idl/pump-9c82f61.json`
- Create: `scripts/generate-pumpfun-idl.ts`
- Create: `src/launchpads/pumpfun/generated/pump-idl.ts`
- Create: `tests/pumpfun-idl-generation.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing provenance and generation test**

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PUMP_IDL_REVISION,
  PUMP_IDL_SHA256,
  PUMP_INSTRUCTIONS,
  PUMP_EVENTS,
} from '../src/launchpads/pumpfun/generated/pump-idl.js';
import {
  OFFICIAL_PUMP_IDL_REVISION,
  OFFICIAL_PUMP_IDL_SHA256,
  renderPumpIdlModule,
} from '../scripts/generate-pumpfun-idl.js';

const SNAPSHOT = new URL(
  '../vendor/pumpfun/idl/pump-9c82f61.json',
  import.meta.url,
);
const GENERATED = new URL(
  '../src/launchpads/pumpfun/generated/pump-idl.ts',
  import.meta.url,
);

void test('épingle et régénère exactement le sous-ensemble IDL Pump officiel', async () => {
  const idl = await readFile(SNAPSHOT, 'utf8');
  const generated = await readFile(GENERATED, 'utf8');

  assert.equal(PUMP_IDL_REVISION, OFFICIAL_PUMP_IDL_REVISION);
  assert.equal(PUMP_IDL_SHA256, OFFICIAL_PUMP_IDL_SHA256);
  assert.equal(await renderPumpIdlModule(idl), generated);
  assert.deepEqual(Object.keys(PUMP_INSTRUCTIONS), [
    'buy',
    'buy_exact_quote_in_v2',
    'buy_exact_sol_in',
    'buy_v2',
    'create',
    'create_v2',
    'sell',
    'sell_v2',
  ]);
  assert.deepEqual(Object.keys(PUMP_EVENTS), ['CreateEvent', 'TradeEvent']);
});
```

- [ ] **Step 2: Run the test and verify the missing modules fail**

Run:

```bash
npx tsx --test tests/pumpfun-idl-generation.test.ts
```

Expected: FAIL because the generated module and generator do not exist.

- [ ] **Step 3: Download the exact official snapshot once and verify it**

Run:

```bash
mkdir -p vendor/pumpfun/idl
gh api \
  'repos/pump-fun/pump-public-docs/contents/idl/pump.json?ref=9c82f61cb711b044a17f770ab8ce9f9bdf78f333' \
  --jq .content |
  tr -d '\n' |
  base64 --decode > vendor/pumpfun/idl/pump-9c82f61.json
shasum -a 256 vendor/pumpfun/idl/pump-9c82f61.json
```

Expected checksum:

```text
b90bc471327f671449271d5d1d42354d1fae6f5a06502f5834459a3108138e49
```

Do not refresh from `main`; the full commit is mandatory.

- [ ] **Step 4: Add immutable provenance documentation**

```markdown
# Pump.fun official IDL snapshot

- Repository: https://github.com/pump-fun/pump-public-docs
- Commit: `9c82f61cb711b044a17f770ab8ce9f9bdf78f333`
- File: `idl/pump.json`
- Program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- SHA-256: `b90bc471327f671449271d5d1d42354d1fae6f5a06502f5834459a3108138e49`
- Verified: 2026-07-28

`npm run pumpfun:generate` reads only this local snapshot. Updating the
snapshot requires a new explicit commit, checksum, generated diff, fixture
verification, and protocol review.
```

- [ ] **Step 5: Implement the deterministic generator**

The generator must export its constants and render function for tests, validate
the complete snapshot, select exact entries, sort selected names, and support a
non-writing `--check` mode.

```ts
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const OFFICIAL_PUMP_IDL_REVISION =
  '9c82f61cb711b044a17f770ab8ce9f9bdf78f333';
export const OFFICIAL_PUMP_IDL_SHA256 =
  'b90bc471327f671449271d5d1d42354d1fae6f5a06502f5834459a3108138e49';
const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const REQUIRED_INSTRUCTIONS = [
  'buy',
  'buy_exact_quote_in_v2',
  'buy_exact_sol_in',
  'buy_v2',
  'create',
  'create_v2',
  'sell',
  'sell_v2',
] as const;
const REQUIRED_EVENTS = ['CreateEvent', 'TradeEvent'] as const;
const REQUIRED_TYPES = [
  'CreateEvent',
  'OptionBool',
  'Shareholder',
  'TradeEvent',
] as const;
const discriminatorSchema = z.array(z.number().int().min(0).max(255)).length(8);
const idlSchema = z.object({
  address: z.string(),
  instructions: z.array(z.object({
    name: z.string(),
    discriminator: discriminatorSchema,
    accounts: z.array(z.object({ name: z.string() }).passthrough()),
    args: z.array(z.object({ name: z.string(), type: z.unknown() })),
  })),
  events: z.array(z.object({
    name: z.string(),
    discriminator: discriminatorSchema,
  })),
  types: z.array(z.object({ name: z.string(), type: z.unknown() })),
});

function selectUnique<T extends { readonly name: string }>(
  values: readonly T[],
  names: readonly string[],
  label: string,
): Record<string, T> {
  return Object.fromEntries(names.map((name) => {
    const matches = values.filter((value) => value.name === name);
    const match = matches[0];
    if (matches.length !== 1 || match === undefined) {
      throw new Error(`${label} ${name}: ${matches.length} occurrence(s).`);
    }
    return [name, match];
  }));
}

export async function renderPumpIdlModule(json: string): Promise<string> {
  const checksum = createHash('sha256').update(json).digest('hex');
  if (checksum !== OFFICIAL_PUMP_IDL_SHA256) {
    throw new Error(`Checksum IDL Pump inattendu: ${checksum}.`);
  }
  const idl = idlSchema.parse(JSON.parse(json) as unknown);
  if (idl.address !== PUMP_PROGRAM_ID) {
    throw new Error(`Programme Pump inattendu: ${idl.address}.`);
  }
  const instructions = selectUnique(
    idl.instructions,
    REQUIRED_INSTRUCTIONS,
    'Instruction',
  );
  const events = selectUnique(idl.events, REQUIRED_EVENTS, 'Événement');
  const types = selectUnique(idl.types, REQUIRED_TYPES, 'Type');
  return [
    '// Generated by scripts/generate-pumpfun-idl.ts. Do not edit.',
    `export const PUMP_IDL_REVISION = '${OFFICIAL_PUMP_IDL_REVISION}';`,
    `export const PUMP_IDL_SHA256 = '${OFFICIAL_PUMP_IDL_SHA256}';`,
    `export const PUMP_INSTRUCTIONS = ${JSON.stringify(instructions, null, 2)} as const;`,
    `export const PUMP_EVENTS = ${JSON.stringify(events, null, 2)} as const;`,
    `export const PUMP_TYPES = ${JSON.stringify(types, null, 2)} as const;`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const snapshot = new URL(
    '../vendor/pumpfun/idl/pump-9c82f61.json',
    import.meta.url,
  );
  const output = new URL(
    '../src/launchpads/pumpfun/generated/pump-idl.ts',
    import.meta.url,
  );
  const rendered = await renderPumpIdlModule(await readFile(snapshot, 'utf8'));
  if (process.argv.includes('--check')) {
    if (await readFile(output, 'utf8') !== rendered) {
      throw new Error('Le module Pump IDL généré est obsolète.');
    }
    return;
  }
  await writeFile(output, rendered);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
```

- [ ] **Step 6: Add scripts and generate the committed module**

Add:

```json
{
  "scripts": {
    "pumpfun:generate": "tsx scripts/generate-pumpfun-idl.ts",
    "pumpfun:check-generated": "tsx scripts/generate-pumpfun-idl.ts --check",
    "check": "npm run pumpfun:check-generated && tsc -p tsconfig.json --noEmit"
  }
}
```

Preserve every existing script not shown. Then run:

```bash
npm run pumpfun:generate
npx tsx --test tests/pumpfun-idl-generation.test.ts
npm run check
```

Expected: PASS and a clean second `npm run pumpfun:generate`.

- [ ] **Step 7: Commit the IDL source of truth**

```bash
git add package.json vendor/pumpfun scripts/generate-pumpfun-idl.ts \
  src/launchpads/pumpfun/generated/pump-idl.ts \
  tests/pumpfun-idl-generation.test.ts
git commit -m "build: pin official Pump.fun IDL"
```

---

### Task 2: Preserve real CPI stack heights

**Files:**
- Modify: `src/solana/rpc/transaction-fetcher.ts`
- Create: `tests/transaction-normalization.test.ts`

- [ ] **Step 1: Write a failing normalization test**

Construct a minimal `VersionedTransactionResponse` whose inner Pump instruction
has `stackHeight: 3`, pass it to `normalizeTransaction`, and assert that the
normalized inner instruction retains `3`.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { normalizeTransaction } from '../src/solana/rpc/transaction-fetcher.js';

const PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PAYER = new PublicKey('11111111111111111111111111111111');

function responseWithInnerStackHeight(
  stackHeight: number | null,
): VersionedTransactionResponse {
  const accountKeys = [PAYER, PROGRAM];
  return {
    slot: 10,
    blockTime: null,
    version: 'legacy',
    transaction: {
      signatures: ['signature'],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
        compiledInstructions: [{
          programIdIndex: 1,
          accountKeyIndexes: [],
          data: new Uint8Array(),
        }],
        getAccountKeys: () => ({
          length: accountKeys.length,
          get: (index: number) => accountKeys[index],
        }),
      },
    },
    meta: {
      err: null,
      fee: 0,
      preBalances: [0, 0],
      postBalances: [0, 0],
      innerInstructions: [{
        index: 0,
        instructions: [{
          programIdIndex: 1,
          accounts: [],
          data: '',
          stackHeight,
        }],
      }],
      preTokenBalances: [],
      postTokenBalances: [],
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: [],
      rewards: [],
    },
  } as unknown as VersionedTransactionResponse;
}

void test('préserve le stackHeight RPC réel des instructions internes', () => {
  const transaction = normalizeTransaction(
    responseWithInnerStackHeight(3),
    'CONFIRMED',
    4,
  );
  assert.equal(transaction.instructions[1]?.stackHeight, 3);
});

void test('préserve null lorsque le RPC ne fournit pas de stackHeight', () => {
  const transaction = normalizeTransaction(
    responseWithInnerStackHeight(null),
    'CONFIRMED',
    4,
  );
  assert.equal(transaction.instructions[1]?.stackHeight, null);
});
```

- [ ] **Step 2: Run the test and verify the hard-coded value fails**

```bash
npx tsx --test tests/transaction-normalization.test.ts
```

Expected: first test FAILS with actual `2`.

- [ ] **Step 3: Preserve the RPC value**

Replace the inner instruction field:

```ts
stackHeight: instruction.stackHeight ?? null,
```

Keep outer instructions at `stackHeight: 1`.

- [ ] **Step 4: Run focused and existing transaction tests**

```bash
npx tsx --test \
  tests/transaction-normalization.test.ts \
  tests/swap-classification.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/solana/rpc/transaction-fetcher.ts \
  tests/transaction-normalization.test.ts
git commit -m "fix: preserve Solana CPI stack heights"
```

---

### Task 3: Add strict Pump errors and Borsh primitives

**Files:**
- Create: `src/launchpads/pumpfun/errors.ts`
- Create: `src/launchpads/pumpfun/borsh-reader.ts`
- Create: `src/launchpads/pumpfun/constants.ts`
- Create: `tests/pumpfun-borsh-reader.test.ts`

- [ ] **Step 1: Write failing bounds and bigint tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { PumpBorshReader } from '../src/launchpads/pumpfun/borsh-reader.js';
import {
  PUMP_DECODING_ERROR_CODES,
  PumpDecodingError,
  type PumpDecodingErrorCode,
} from '../src/launchpads/pumpfun/errors.js';

void test('décode les entiers Borsh sans float', () => {
  const bytes = Buffer.alloc(18);
  bytes.writeBigUInt64LE(9_007_199_254_740_993n, 0);
  bytes.writeBigInt64LE(-9_007_199_254_740_993n, 8);
  bytes.writeUInt16LE(10_000, 16);
  const reader = new PumpBorshReader(bytes);
  assert.equal(reader.readU64(), 9_007_199_254_740_993n);
  assert.equal(reader.readI64(), -9_007_199_254_740_993n);
  assert.equal(reader.readU16(), 10_000n);
  assert.equal(reader.remaining, 0);
});

void test('décode string et pubkey avec des bornes explicites', () => {
  const key = new PublicKey('So11111111111111111111111111111111111111112');
  const text = Buffer.from('éclair');
  const bytes = Buffer.alloc(4 + text.length + 32);
  bytes.writeUInt32LE(text.length, 0);
  text.copy(bytes, 4);
  key.toBuffer().copy(bytes, 4 + text.length);
  const reader = new PumpBorshReader(bytes);
  assert.equal(reader.readString(32), 'éclair');
  assert.equal(reader.readPubkey(), key.toBase58());
});

void test('échoue de façon typée sur une donnée tronquée', () => {
  assert.throws(
    () => new PumpBorshReader(Uint8Array.of(1)).readU64(),
    (error: unknown) =>
      error instanceof PumpDecodingError
      && error.code === 'PUMP_BORSH_TRUNCATED',
  );
});

void test('le jeu de codes techniques reste stable', () => {
  const expected: readonly PumpDecodingErrorCode[] = [
    'PUMP_TRANSACTION_INDEX_REQUIRED',
    'PUMP_SCHEMA_UNSUPPORTED',
    'PUMP_BORSH_TRUNCATED',
    'PUMP_BORSH_INVALID',
    'PUMP_ACCOUNT_MISSING',
    'PUMP_STACK_HEIGHT_REQUIRED',
    'PUMP_STACK_HEIGHT_INVALID',
    'PUMP_EVENT_MISSING',
    'PUMP_EVENT_DUPLICATE',
    'PUMP_EVENT_ORPHANED',
    'PUMP_EVENT_AMBIGUOUS',
    'PUMP_EVENT_MISMATCH',
    'PUMP_QUOTE_ASSET_UNRESOLVED',
    'PUMP_QUOTE_ASSET_CONFLICT',
    'PUMP_TOKEN_PROGRAM_UNSUPPORTED',
  ];
  assert.deepEqual(PUMP_DECODING_ERROR_CODES, expected);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx tsx --test tests/pumpfun-borsh-reader.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement stable errors and constants**

```ts
export const PUMP_DECODING_ERROR_CODES = [
  'PUMP_TRANSACTION_INDEX_REQUIRED',
  'PUMP_SCHEMA_UNSUPPORTED',
  'PUMP_BORSH_TRUNCATED',
  'PUMP_BORSH_INVALID',
  'PUMP_ACCOUNT_MISSING',
  'PUMP_STACK_HEIGHT_REQUIRED',
  'PUMP_STACK_HEIGHT_INVALID',
  'PUMP_EVENT_MISSING',
  'PUMP_EVENT_DUPLICATE',
  'PUMP_EVENT_ORPHANED',
  'PUMP_EVENT_AMBIGUOUS',
  'PUMP_EVENT_MISMATCH',
  'PUMP_QUOTE_ASSET_UNRESOLVED',
  'PUMP_QUOTE_ASSET_CONFLICT',
  'PUMP_TOKEN_PROGRAM_UNSUPPORTED',
] as const;

export type PumpDecodingErrorCode =
  (typeof PUMP_DECODING_ERROR_CODES)[number];

export class PumpDecodingError extends Error {
  public readonly decodingCause: unknown;

  public constructor(
    public readonly code: PumpDecodingErrorCode,
    public readonly retryable: boolean,
    message: string,
    public readonly signature: string | null = null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PumpDecodingError';
    this.decodingCause = cause;
  }
}
```

Add constants using exact package exports, not copied token-program strings:

```ts
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

export const PUMP_PROGRAM_ID =
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const DEFAULT_PUBLIC_KEY =
  '11111111111111111111111111111111';
export const WSOL_MINT = NATIVE_MINT.toBase58();
export const SPL_TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ID.toBase58();
export const TOKEN_2022_PROGRAM_ADDRESS = TOKEN_2022_PROGRAM_ID.toBase58();
```

- [ ] **Step 4: Implement the bounds-checked reader**

`PumpBorshReader` exposes `offset`, `remaining`, `readBool`, `readU16`,
`readU32Length`, `readU64`, `readI64`, `readPubkey`, `readString(maxBytes)`,
and `readBytes(length)`. Every read calls one private `require(length)` method.
`readU16` returns `bigint`; only lengths use validated safe `number`.

```ts
import { PublicKey } from '@solana/web3.js';
import { PumpDecodingError } from './errors.js';

export class PumpBorshReader {
  private position = 0;

  public constructor(private readonly bytes: Uint8Array) {}

  public get offset(): number {
    return this.position;
  }

  public get remaining(): number {
    return this.bytes.length - this.position;
  }

  public readBool(): boolean {
    const value = this.readBytes(1)[0];
    if (value === 0) return false;
    if (value === 1) return true;
    throw new PumpDecodingError(
      'PUMP_BORSH_INVALID',
      false,
      `Booléen Borsh invalide: ${value}.`,
    );
  }

  public readU16(): bigint {
    const data = this.readBytes(2);
    return BigInt(new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).getUint16(0, true));
  }

  public readU32Length(maximum = 1_048_576): number {
    const data = this.readBytes(4);
    const value = new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).getUint32(0, true);
    if (value > maximum) {
      throw new PumpDecodingError(
        'PUMP_BORSH_INVALID',
        false,
        `Longueur Borsh ${value} supérieure à ${maximum}.`,
      );
    }
    return value;
  }

  public readU64(): bigint {
    const data = this.readBytes(8);
    return new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).getBigUint64(0, true);
  }

  public readI64(): bigint {
    const data = this.readBytes(8);
    return new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).getBigInt64(0, true);
  }

  public readPubkey(): string {
    return new PublicKey(this.readBytes(32)).toBase58();
  }

  public readString(maxBytes: number): string {
    const length = this.readU32Length(maxBytes);
    const bytes = this.readBytes(length);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new PumpDecodingError(
        'PUMP_BORSH_INVALID',
        false,
        'Chaîne Borsh UTF-8 invalide.',
        null,
        cause,
      );
    }
  }

  public readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new PumpDecodingError(
        'PUMP_BORSH_INVALID',
        false,
        `Longueur Borsh invalide: ${length}.`,
      );
    }
    if (this.remaining < length) {
      throw new PumpDecodingError(
        'PUMP_BORSH_TRUNCATED',
        true,
        `Données Borsh tronquées à l’octet ${this.position}.`,
      );
    }
    const result = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return result;
  }
}
```

- [ ] **Step 5: Run tests, check, and lint**

```bash
npx tsx --test tests/pumpfun-borsh-reader.test.ts
npm run check
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/launchpads/pumpfun/constants.ts \
  src/launchpads/pumpfun/errors.ts \
  src/launchpads/pumpfun/borsh-reader.ts \
  tests/pumpfun-borsh-reader.test.ts
git commit -m "feat: add strict Pump.fun Borsh primitives"
```

---

### Task 4: Decode generated IDL values and supported instructions

**Files:**
- Create: `src/launchpads/pumpfun/idl-codec.ts`
- Create: `src/launchpads/pumpfun/types.ts`
- Create: `src/launchpads/pumpfun/instruction-decoder.ts`
- Create: `tests/pumpfun-instruction-decoder.test.ts`

- [ ] **Step 1: Write table-driven failing instruction tests**

For every key in `PUMP_INSTRUCTIONS`, build data from its generated
discriminator plus Borsh-encoded arguments and provide the exact required
account count. Assert:

```ts
void test('décode toutes les instructions Pump du périmètre depuis le module généré', () => {
  for (const [name, definition] of Object.entries(PUMP_INSTRUCTIONS)) {
    const instruction = pumpInstructionFixture(name, definition);
    const decoded = decodePumpInstruction(instruction);
    assert.ok(decoded);
    assert.equal(decoded.name, name);
    assert.equal(decoded.instruction, instruction);
    assert.deepEqual(
      Object.keys(decoded.accounts),
      definition.accounts.map((account) => account.name),
    );
  }
});

void test('ignore une instruction Pump hors périmètre', () => {
  assert.equal(
    decodePumpInstruction(normalizedInstruction(Uint8Array.of(1, 2, 3))),
    null,
  );
});

void test('refuse un compte obligatoire manquant', () => {
  const definition = PUMP_INSTRUCTIONS.create_v2;
  const instruction = pumpInstructionFixture('create_v2', definition);
  assert.throws(
    () => decodePumpInstruction({
      ...instruction,
      accounts: instruction.accounts.slice(0, -1),
    }),
    isPumpError('PUMP_ACCOUNT_MISSING'),
  );
});
```

Also assert exact decoded create strings/pubkey/Mayhem/Cashback and each trade's
`u64` args above the safe-number limit.

- [ ] **Step 2: Run and verify missing decoder failure**

```bash
npx tsx --test tests/pumpfun-instruction-decoder.test.ts
```

Expected: FAIL because the decoder does not exist.

- [ ] **Step 3: Define Pump-specific contracts**

```ts
import type { QuoteAsset } from '../../domain/types.js';
import type { NormalizedInstruction, NormalizedTransaction } from '../../solana/rpc/types.js';

export type PumpInstructionName =
  | 'buy'
  | 'buy_exact_quote_in_v2'
  | 'buy_exact_sol_in'
  | 'buy_v2'
  | 'create'
  | 'create_v2'
  | 'sell'
  | 'sell_v2';

export type PumpInstructionFamily = 'CREATE' | 'BUY' | 'SELL';
export type PumpIdlValue =
  | string
  | boolean
  | bigint
  | readonly PumpIdlValue[]
  | Readonly<Record<string, PumpIdlValue>>;

export interface DecodedPumpInstruction {
  readonly name: PumpInstructionName;
  readonly family: PumpInstructionFamily;
  readonly instruction: NormalizedInstruction;
  readonly accounts: Readonly<Record<string, string>>;
  readonly args: Readonly<Record<string, PumpIdlValue>>;
}

export interface DecodedPumpTransaction {
  readonly transaction: NormalizedTransaction;
  readonly creations: readonly DecodedPumpCreation[];
  readonly trades: readonly DecodedPumpTrade[];
}
```

Define `DecodedPumpCreateEvent`, `DecodedPumpTradeEvent`,
`DecodedPumpCreation`, and `DecodedPumpTrade` with explicit properties matching
every field listed in the pinned IDL. Amounts, fees, reserves, basis points, and
timestamps use `bigint`; pubkeys and strings use `string`; shareholders use:

```ts
export interface DecodedPumpShareholder {
  readonly address: string;
  readonly shareBps: bigint;
}

export interface DecodedPumpCreateEvent {
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly mint: string;
  readonly bondingCurve: string;
  readonly user: string;
  readonly creator: string;
  readonly timestamp: bigint;
  readonly virtualTokenReserves: bigint;
  readonly virtualSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly tokenTotalSupply: bigint;
  readonly tokenProgram: string;
  readonly isMayhemMode: boolean;
  readonly isCashbackEnabled: boolean;
  readonly quoteMint: string;
  readonly virtualQuoteReserves: bigint;
}

export interface DecodedPumpTradeEvent {
  readonly mint: string;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly isBuy: boolean;
  readonly user: string;
  readonly timestamp: bigint;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly feeRecipient: string;
  readonly feeBasisPoints: bigint;
  readonly fee: bigint;
  readonly creator: string;
  readonly creatorFeeBasisPoints: bigint;
  readonly creatorFee: bigint;
  readonly trackVolume: boolean;
  readonly totalUnclaimedTokens: bigint;
  readonly totalClaimedTokens: bigint;
  readonly currentSolVolume: bigint;
  readonly lastUpdateTimestamp: bigint;
  readonly ixName: string;
  readonly mayhemMode: boolean;
  readonly cashbackFeeBasisPoints: bigint;
  readonly cashback: bigint;
  readonly buybackFeeBasisPoints: bigint;
  readonly buybackFee: bigint;
  readonly shareholders: readonly DecodedPumpShareholder[];
  readonly quoteMint: string;
  readonly quoteAmount: bigint;
  readonly virtualQuoteReserves: bigint;
  readonly realQuoteReserves: bigint;
}

export type DecodedPumpCpiEvent =
  | {
      readonly kind: 'CREATE';
      readonly event: DecodedPumpCreateEvent;
      readonly instruction: NormalizedInstruction;
      readonly trailingDataHex: string;
    }
  | {
      readonly kind: 'TRADE';
      readonly event: DecodedPumpTradeEvent;
      readonly instruction: NormalizedInstruction;
      readonly trailingDataHex: string;
    };

export interface DecodedPumpCreation {
  readonly action: DecodedPumpInstruction & { readonly family: 'CREATE' };
  readonly event: DecodedPumpCreateEvent;
  readonly eventCpi: Extract<DecodedPumpCpiEvent, { readonly kind: 'CREATE' }>;
  readonly quoteAsset: QuoteAsset;
}

export interface DecodedPumpTrade {
  readonly action: DecodedPumpInstruction & {
    readonly family: 'BUY' | 'SELL';
  };
  readonly event: DecodedPumpTradeEvent;
  readonly eventCpi: Extract<DecodedPumpCpiEvent, { readonly kind: 'TRADE' }>;
  readonly quoteAsset: QuoteAsset;
}
```

- [ ] **Step 4: Implement a recursive generated-IDL codec**

`decodeIdlFields` accepts generated field descriptors and a
`PumpBorshReader`. It supports only `bool`, `u16`, `u64`, `i64`, `pubkey`,
`string`, `{ defined: { name } }`, and `{ vec: type }`. A named struct returns
an immutable record; a tuple struct such as `OptionBool` returns an immutable
array. Any other descriptor throws `PUMP_SCHEMA_UNSUPPORTED`.

Use runtime narrowing functions with `unknown`; do not use `any` or cast
unvalidated input to a financial value.

```ts
export function decodeIdlFields(
  fields: unknown,
  reader: PumpBorshReader,
): Readonly<Record<string, PumpIdlValue>> {
  const namedFields = requireNamedFields(fields);
  return Object.freeze(Object.fromEntries(namedFields.map((field) => [
    field.name,
    decodeIdlValue(field.type, reader),
  ])));
}
```

Resolve named types exclusively from `PUMP_TYPES`. Bound strings at 1,024 bytes
and vectors at 64 entries, which exceeds the current Pump maximum of ten
shareholders while preventing hostile allocations.

- [ ] **Step 5: Implement instruction classification and account mapping**

Build one map keyed by the hexadecimal eight-byte discriminator generated from
`PUMP_INSTRUCTIONS`. For a supported discriminator:

1. require all generated accounts;
2. decode bytes after the discriminator with generated args;
3. require zero trailing bytes;
4. assign family from an exhaustive `switch`;
5. freeze the returned maps and object.

`create_v2` may contain exactly zero or three remaining quote accounts after
the generated sixteen accounts. Expose them under:

```ts
{
  quote_mint: string;
  associated_quote_bonding_curve: string;
  quote_token_program: string;
}
```

Any other remaining-account count throws `PUMP_ACCOUNT_MISSING`.

- [ ] **Step 6: Run focused tests, check, and lint**

```bash
npx tsx --test tests/pumpfun-instruction-decoder.test.ts
npm run check
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/launchpads/pumpfun/idl-codec.ts \
  src/launchpads/pumpfun/types.ts \
  src/launchpads/pumpfun/instruction-decoder.ts \
  tests/pumpfun-instruction-decoder.test.ts
git commit -m "feat: decode Pump.fun instructions from official schemas"
```

---

### Task 5: Decode CreateEvent and TradeEvent CPI evidence

**Files:**
- Create: `src/launchpads/pumpfun/event-decoder.ts`
- Create: `tests/pumpfun-event-decoder.test.ts`
- Modify: `src/launchpads/pumpfun/types.ts`

- [ ] **Step 1: Write failing event tests**

Generate CPI data as:

```ts
const eventTag = Uint8Array.from(
  createHash('sha256')
    .update('anchor:event')
    .digest()
    .subarray(0, 8),
).reverse();
```

Then append the official event discriminator and Borsh payload. Assert:

```ts
void test('décode CreateEvent avec Token-2022, Mayhem, Cashback et quote mint', () => {
  const decoded = decodePumpCpiEvent(createEventInstruction());
  assert.ok(decoded);
  assert.equal(decoded.kind, 'CREATE');
  assert.equal(decoded.event.mint, MINT);
  assert.equal(decoded.event.tokenProgram, TOKEN_2022_PROGRAM_ADDRESS);
  assert.equal(decoded.event.isMayhemMode, true);
  assert.equal(decoded.event.isCashbackEnabled, true);
  assert.equal(decoded.event.virtualQuoteReserves, 30_000_000_001n);
});

void test('décode TradeEvent avec montants réels, réserves et frais', () => {
  const decoded = decodePumpCpiEvent(tradeEventInstruction());
  assert.ok(decoded);
  assert.equal(decoded.kind, 'TRADE');
  assert.equal(decoded.event.tokenAmount, 9_007_199_254_740_993n);
  assert.equal(decoded.event.quoteAmount, 250_000_001n);
  assert.equal(decoded.event.isBuy, true);
  assert.equal(decoded.event.shareholders[0]?.shareBps, 1_250n);
});
```

Add tests for wrong Anchor tag returning `null`, known event with truncated data
throwing `PUMP_BORSH_TRUNCATED`, unknown event returning `null`, and known
prefix with trailing bytes setting `trailingDataHex` rather than failing.

- [ ] **Step 2: Run and verify failure**

```bash
npx tsx --test tests/pumpfun-event-decoder.test.ts
```

Expected: FAIL because `decodePumpCpiEvent` does not exist.

- [ ] **Step 3: Implement CPI tag and generated event dispatch**

```ts
import { createHash } from 'node:crypto';
import type { NormalizedInstruction } from '../../solana/rpc/types.js';
import { PUMP_EVENTS, PUMP_TYPES } from './generated/pump-idl.js';

export const ANCHOR_EVENT_CPI_TAG = Object.freeze(
  Uint8Array.from(
    createHash('sha256')
      .update('anchor:event')
      .digest()
      .subarray(0, 8),
  ).reverse(),
);

export function decodePumpCpiEvent(
  instruction: NormalizedInstruction,
): DecodedPumpCpiEvent | null {
  if (!startsWith(instruction.data, ANCHOR_EVENT_CPI_TAG)) return null;
  const eventDiscriminator = instruction.data.subarray(8, 16);
  if (equal(eventDiscriminator, PUMP_EVENTS.CreateEvent.discriminator)) {
    return decodeCreateEvent(instruction, instruction.data.subarray(16));
  }
  if (equal(eventDiscriminator, PUMP_EVENTS.TradeEvent.discriminator)) {
    return decodeTradeEvent(instruction, instruction.data.subarray(16));
  }
  return null;
}
```

Decode fields with `PUMP_TYPES.CreateEvent.type.fields` or
`PUMP_TYPES.TradeEvent.type.fields`, then use strict extractor functions such
as `requiredBigInt`, `requiredBoolean`, `requiredString`, and
`requiredShareholders`. Freeze nested shareholders and every returned event.

- [ ] **Step 4: Run focused tests, check, and lint**

```bash
npx tsx --test tests/pumpfun-event-decoder.test.ts
npm run check
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/launchpads/pumpfun/event-decoder.ts \
  src/launchpads/pumpfun/types.ts \
  tests/pumpfun-event-decoder.test.ts
git commit -m "feat: decode Pump.fun CPI events"
```

---

### Task 6: Resolve quote assets from local transaction evidence

**Files:**
- Create: `src/launchpads/pumpfun/quote-asset.ts`
- Create: `tests/pumpfun-quote-asset.test.ts`

- [ ] **Step 1: Write failing quote tests**

```ts
void test('normalise le pubkey par défaut Pump en WSOL local', () => {
  assert.deepEqual(resolvePumpQuoteAsset(DEFAULT_PUBLIC_KEY, transaction()), {
    mint: WSOL_MINT,
    decimals: 9,
    tokenProgram: 'SPL_TOKEN',
  });
});

void test('résout un quote générique depuis les balances de transaction', () => {
  assert.deepEqual(resolvePumpQuoteAsset(USDC, transaction({
    postTokenBalances: [{
      accountIndex: 3,
      account: 'quote-account',
      mint: USDC,
      owner: 'owner',
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
      amountRaw: 25_000_000n,
      decimals: 6,
    }],
  })), {
    mint: USDC,
    decimals: 6,
    tokenProgram: 'SPL_TOKEN',
  });
});

void test('refuse des preuves de décimales contradictoires', () => {
  assert.throws(
    () => resolvePumpQuoteAsset(USDC, transactionWithQuoteDecimals(6, 9)),
    isPumpError('PUMP_QUOTE_ASSET_CONFLICT'),
  );
});
```

Also cover Token-2022 quote, unknown token program, missing non-native balance,
and event WSOL versus default-key normalization.

- [ ] **Step 2: Run and verify failure**

```bash
npx tsx --test tests/pumpfun-quote-asset.test.ts
```

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement local-only resolution**

```ts
export function normalizePumpQuoteMint(mint: string): string {
  return mint === DEFAULT_PUBLIC_KEY ? WSOL_MINT : mint;
}

export function resolvePumpQuoteAsset(
  rawMint: string,
  transaction: NormalizedTransaction,
): QuoteAsset {
  const mint = normalizePumpQuoteMint(rawMint);
  if (mint === WSOL_MINT) {
    return Object.freeze({
      mint,
      decimals: 9,
      tokenProgram: 'SPL_TOKEN',
    });
  }
  const evidence = [
    ...transaction.preTokenBalances,
    ...transaction.postTokenBalances,
  ].filter((balance) => balance.mint === mint);
  if (evidence.length === 0) {
    throw pumpError('PUMP_QUOTE_ASSET_UNRESOLVED', true, transaction);
  }
  const decimals = new Set(evidence.map((balance) => balance.decimals));
  const programs = new Set(evidence.map((balance) => balance.tokenProgram));
  if (decimals.size !== 1 || programs.size !== 1) {
    throw pumpError('PUMP_QUOTE_ASSET_CONFLICT', true, transaction);
  }
  return Object.freeze({
    mint,
    decimals: requireOnly(decimals),
    tokenProgram: mapTokenProgram(requireOnly(programs), transaction.signature),
  });
}
```

`mapTokenProgram` accepts only the exact SPL Token and Token-2022 addresses and
returns the domain values `SPL_TOKEN` or `TOKEN_2022`.

- [ ] **Step 4: Run tests, check, and lint**

```bash
npx tsx --test tests/pumpfun-quote-asset.test.ts
npm run check
npm run lint
```

Expected: PASS with no RPC mock because the resolver has no network dependency.

- [ ] **Step 5: Commit**

```bash
git add src/launchpads/pumpfun/quote-asset.ts \
  tests/pumpfun-quote-asset.test.ts
git commit -m "feat: resolve Pump.fun quote assets locally"
```

---

### Task 7: Pair actions and CPI events fail-closed

**Files:**
- Create: `src/launchpads/pumpfun/transaction-decoder.ts`
- Create: `tests/pumpfun-transaction-decoder.test.ts`
- Modify: `src/launchpads/pumpfun/types.ts`

- [ ] **Step 1: Write failing pairing tests**

Build normalized synthetic transactions with explicit outer and inner indexes.
Cover:

```ts
void test('apparie une action externe à son événement interne', () => {
  const decoded = decodePumpTransaction(transaction([
    createV2Instruction({ instructionIndex: 2, stackHeight: 1 }),
    createEventInstruction({
      instructionIndex: 2,
      innerInstructionIndex: 22,
      stackHeight: 2,
    }),
  ]));
  assert.equal(decoded.creations.length, 1);
  assert.equal(decoded.creations[0]?.action.instruction.innerInstructionIndex, null);
});

void test('apparie une action CPI à son événement enfant grâce au stackHeight', () => {
  const decoded = decodePumpTransaction(transaction([
    buyV2Instruction({
      instructionIndex: 3,
      innerInstructionIndex: 0,
      stackHeight: 2,
    }),
    createTokenAccountCpi({
      instructionIndex: 3,
      innerInstructionIndex: 1,
      stackHeight: 3,
    }),
    tradeEventInstruction({
      instructionIndex: 3,
      innerInstructionIndex: 7,
      stackHeight: 3,
    }),
  ]));
  assert.equal(decoded.trades.length, 1);
});

void test('décode création puis achat initial dans la même transaction', () => {
  const decoded = decodePumpTransaction(createAndInitialBuyTransaction());
  assert.equal(decoded.creations.length, 1);
  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.event.mint, decoded.creations[0]?.event.mint);
});
```

Add separate tests for multiple Pump actions under one wrapper, failed
transaction returning empty arrays, null transaction index, missing event,
duplicate event, orphan event, missing inner stack height, event outside the
action scope, and mint/user/side/quote/program mismatches. Assert the exact
stable error code for every failure.

- [ ] **Step 2: Run and verify failure**

```bash
npx tsx --test tests/pumpfun-transaction-decoder.test.ts
```

Expected: FAIL because the transaction decoder does not exist.

- [ ] **Step 3: Implement canonical action scopes**

```ts
function isEventInsideActionScope(
  action: NormalizedInstruction,
  event: NormalizedInstruction,
  instructions: readonly NormalizedInstruction[],
): boolean {
  if (event.instructionIndex !== action.instructionIndex) return false;
  if (event.innerInstructionIndex === null) return false;
  const actionHeight = requireActionStackHeight(action);
  if (event.stackHeight !== actionHeight + 1) return false;
  if (action.innerInstructionIndex === null) return true;
  if (event.innerInstructionIndex <= action.innerInstructionIndex) return false;
  const boundary = instructions.find((candidate) =>
    candidate.instructionIndex === action.instructionIndex
    && candidate.innerInstructionIndex !== null
    && candidate.innerInstructionIndex > action.innerInstructionIndex
    && candidate.stackHeight !== null
    && candidate.stackHeight <= actionHeight);
  return (
    boundary === undefined
    || event.innerInstructionIndex < (boundary.innerInstructionIndex ?? 0)
  );
}
```

Do not use `find` alone to select an event. Collect all compatible candidates,
require exactly one, then mark its full cursor key as consumed. After all
actions, reject every unconsumed Create/Trade event.

- [ ] **Step 4: Implement cross-evidence validation**

For creation, validate:

- event mint equals instruction `mint` account;
- event name, symbol, URI, and creator equal decoded args;
- event token program equals instruction token-program account;
- `create_v2` Mayhem and Cashback values equal decoded args;
- non-native quote event equals all three remaining-account evidence fields;
- legacy `create` resolves to SOL/WSOL.

For trades, validate:

- `isBuy` matches the instruction family;
- event mint and user equal named instruction accounts;
- V2 event quote normalizes to the named `quote_mint`;
- legacy trade quote normalizes to WSOL;
- base and quote token-program accounts are supported;
- the quote asset resolves from the same transaction.

Do not require `TradeEvent.ixName` to equal the V2 instruction name. Preserve it
as evidence and validate only that it denotes the same BUY/SELL semantic,
because the current program emits semantic names such as `buy` or
`buy_exact_quote_in`.

- [ ] **Step 5: Return immutable complete evidence**

```ts
export function decodePumpTransaction(
  transaction: NormalizedTransaction,
): DecodedPumpTransaction {
  if (transaction.error !== null) {
    return Object.freeze({
      transaction,
      creations: Object.freeze([]),
      trades: Object.freeze([]),
    });
  }
  if (transaction.transactionIndex === null) {
    throw new PumpDecodingError(
      'PUMP_TRANSACTION_INDEX_REQUIRED',
      true,
      `Transaction ${transaction.signature} sans index canonique.`,
      transaction.signature,
    );
  }
  return pairAndValidatePumpEvidence(transaction);
}
```

Freeze the arrays, each pair, each named-account map, event shareholders, and
trailing-data evidence.

- [ ] **Step 6: Run focused tests and the PR B service tests**

```bash
npx tsx --test \
  tests/pumpfun-transaction-decoder.test.ts \
  tests/launchpad-observation.service.test.ts
npm run check
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/launchpads/pumpfun/transaction-decoder.ts \
  src/launchpads/pumpfun/types.ts \
  tests/pumpfun-transaction-decoder.test.ts
git commit -m "feat: pair Pump.fun actions with CPI evidence"
```

---

### Task 8: Map complete evidence through the generic LaunchpadAdapter

**Files:**
- Create: `src/launchpads/pumpfun/pumpfun-launchpad.adapter.ts`
- Create: `tests/pumpfun-launchpad-adapter.test.ts`

- [ ] **Step 1: Write a failing adapter/service integration test**

Define the specialized wrapper without changing generic transaction contracts:

```ts
export interface PumpFunObservedTransaction extends ObservedChainTransaction {
  readonly raw: NormalizedTransaction;
}

export interface PumpFunBondingCurveStateReader {
  readonly read: (launch: TokenLaunch) => Promise<BondingCurveState>;
}
```

The test wraps the create-plus-initial-buy fixture, invokes
`LaunchpadObservationService`, and asserts ordered event types:

```ts
assert.deepEqual(
  recorded.events.map((event) => event.type),
  ['TokenLaunchDetected', 'BondingCurveTradeObserved'],
);
assert.equal(recorded.events[0]?.mint, MINT);
assert.equal(
  recorded.events[1]?.payload.trade.trader,
  recorded.events[0]?.payload.launch.creator,
);
```

Also test:

- a tracked trade-only mint is emitted;
- an untracked trade is filtered;
- the launch contains exactly one exact quote asset;
- `create_v2` maps name, symbol, URI, bonding curve, reserves, Cashback, and
  Mayhem into `parameters`;
- `LaunchpadTrade` uses `tokenAmount` and `quoteAmount`;
- two adapter passes decode the same wrapper only once;
- `readBondingCurveState` delegates to the injected reader;
- importing `src/app.ts` does not instantiate the adapter.

- [ ] **Step 2: Run and verify failure**

```bash
npx tsx --test tests/pumpfun-launchpad-adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement mapping and per-observation memoization**

Expose one wrapper factory so callers cannot invent mismatched generic and
normalized envelopes:

```ts
const CONFIRMATION_STATUS = {
  PROCESSED: 'processed',
  CONFIRMED: 'confirmed',
  FINALIZED: 'finalized',
  ORPHANED: 'orphaned',
} as const;

export function createPumpFunObservedTransaction(
  raw: NormalizedTransaction,
  observedAtMs: number,
): PumpFunObservedTransaction {
  if (raw.transactionIndex === null) {
    throw new PumpDecodingError(
      'PUMP_TRANSACTION_INDEX_REQUIRED',
      true,
      `Transaction ${raw.signature} sans index canonique.`,
      raw.signature,
    );
  }
  assertValidTimestampMs('observedAtMs', observedAtMs);
  return Object.freeze({
    signature: raw.signature,
    confirmationStatus: CONFIRMATION_STATUS[raw.confirmationStatus],
    blockTimeMs: raw.blockTimeMs,
    observedAtMs,
    cursor: Object.freeze({
      slot: raw.slot,
      transactionIndex: raw.transactionIndex,
    }),
    raw,
  });
}
```

Then implement the adapter:

```ts
export class PumpFunLaunchpadAdapter
implements LaunchpadAdapter<PumpFunObservedTransaction> {
  public readonly source = 'pumpfun';
  public readonly programId = PUMP_PROGRAM_ID;
  private readonly decoded = new WeakMap<
    PumpFunObservedTransaction,
    Promise<DecodedPumpTransaction>
  >();

  public constructor(
    private readonly bondingCurveReader: PumpFunBondingCurveStateReader,
    private readonly decode: (
      transaction: NormalizedTransaction,
    ) => DecodedPumpTransaction = decodePumpTransaction,
  ) {}

  public readonly detectLaunches = async (
    transaction: PumpFunObservedTransaction,
  ): Promise<readonly TokenLaunch[]> =>
    (await this.decodeOnce(transaction)).creations.map(projectTokenLaunch);

  public readonly decodeTrades = async (
    transaction: PumpFunObservedTransaction,
    trackedMints: ReadonlySet<string>,
  ): Promise<readonly LaunchpadTrade[]> =>
    (await this.decodeOnce(transaction)).trades
      .filter((trade) => trackedMints.has(trade.event.mint))
      .map((trade) => projectLaunchpadTrade(
        transaction.raw,
        trade,
      ));

  public readonly readBondingCurveState = async (
    launch: TokenLaunch,
  ): Promise<BondingCurveState> => this.bondingCurveReader.read(launch);

  private decodeOnce(
    transaction: PumpFunObservedTransaction,
  ): Promise<DecodedPumpTransaction> {
    const cached = this.decoded.get(transaction);
    if (cached !== undefined) return cached;
    const decoding = Promise.resolve().then(() => this.decode(transaction.raw));
    this.decoded.set(transaction, decoding);
    return decoding;
  }
}
```

Before decoding, validate wrapper and raw signature, slot, transaction index,
and normalized confirmation status agree. Use a deterministic SHA-256 tuple for
`LaunchpadTrade.id`; the outer domain event still computes its own canonical
event ID.

- [ ] **Step 4: Map launch parameters without floats**

Use exact `LaunchParameterObject` values:

```ts
parameters: Object.freeze({
  instruction: creation.action.name,
  name: event.name,
  symbol: event.symbol,
  uri: event.uri,
  bondingCurve: event.bondingCurve,
  user: event.user,
  blockchainTimestampSeconds: event.timestamp,
  virtualTokenReservesRaw: event.virtualTokenReserves,
  virtualQuoteReservesRaw: event.virtualQuoteReserves,
  realTokenReservesRaw: event.realTokenReserves,
  tokenTotalSupplyRaw: event.tokenTotalSupply,
  mayhem: event.isMayhemMode,
  cashback: event.isCashbackEnabled,
  rawQuoteMint: event.quoteMint,
  trailingEventDataHex: creation.eventCpi.trailingDataHex,
}),
```

`tokenProgram` maps only exact SPL Token or Token-2022 program IDs. `createdAt`
and trade cursors use the action instruction indexes and the transaction's
canonical slot/index.

- [ ] **Step 5: Run focused and generic integration tests**

```bash
npx tsx --test \
  tests/pumpfun-launchpad-adapter.test.ts \
  tests/launchpad-ports.test.ts \
  tests/launchpad-observation.service.test.ts \
  tests/bootstrap-safety.test.ts
npm run check
npm run lint
```

Expected: PASS and `src/app.ts` unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/launchpads/pumpfun/pumpfun-launchpad.adapter.ts \
  tests/pumpfun-launchpad-adapter.test.ts
git commit -m "feat: add inactive Pump.fun launchpad adapter"
```

---

### Task 9: Capture sanitized public fixtures and prove offline behavior

**Files:**
- Modify: `scripts/capture-fixture.ts`
- Create: `tests/helpers/pumpfun-fixture.ts`
- Create: `tests/fixtures/pumpfun/create-v2-initial-buy-mainnet.json`
- Create: `tests/fixtures/pumpfun/sell-cpi-mainnet.json`
- Create: `tests/fixtures/pumpfun/buy-exact-quote-v2-cpi-mainnet.json`
- Modify: `tests/pumpfun-transaction-decoder.test.ts`
- Modify: `tests/pumpfun-launchpad-adapter.test.ts`
- Modify: `docs/architecture/pumpfun-v1.md`

- [ ] **Step 1: Write a failing strict fixture-loader test**

```ts
void test('décode hors ligne la création et son achat initial mainnet', async () => {
  const fixture = await loadPumpFixture('create-v2-initial-buy-mainnet.json');
  const decoded = decodePumpTransaction(fixture.transaction);
  assert.equal(fixture.provenance.transactionIndex, 946);
  assert.equal(decoded.creations.length, 1);
  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.event.isBuy, true);
});

void test('décode hors ligne une vente CPI avec stackHeight 3', async () => {
  const fixture = await loadPumpFixture('sell-cpi-mainnet.json');
  const decoded = decodePumpTransaction(fixture.transaction);
  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.event.isBuy, false);
  assert.equal(decoded.trades[0]?.eventCpi.instruction.stackHeight, 3);
});
```

The V2 CPI buy fixture asserts `buy_exact_quote_in_v2`, action
`stackHeight: 2`, event `stackHeight: 3`, and `transactionIndex: 1188`.

- [ ] **Step 2: Implement strict fixture parsing**

Follow the existing `tests/helpers/fixture.ts` pattern. Parse JSON as `unknown`;
validate every string, safe index, nullable index, boolean, hex byte string,
decimal bigint string, confirmation status, token balance, and provenance
field. Supply empty immutable arrays for normalized fields intentionally omitted
from the sanitized JSON.

The fixture root is:

```ts
export interface PumpFixture {
  readonly provenance: {
    readonly source: 'solana-mainnet';
    readonly signature: string;
    readonly slot: bigint;
    readonly transactionIndex: number;
    readonly capturedAt: string;
  };
  readonly transaction: NormalizedTransaction;
}
```

- [ ] **Step 3: Replace the disabled capture script with an explicit safe tool**

The script accepts only:

```text
npm run fixture:capture -- pumpfun <signature> <transactionIndex> <output-name>
```

It:

1. requires `SOLANA_RPC_HTTP_URL`;
2. validates the signature, nonnegative safe transaction index, and filename;
3. fetches one confirmed transaction through `TransactionFetcher`;
4. verifies the returned signature and supplied canonical index;
5. serializes only normalized instructions, pre/post token balances, status,
   signature, slot, version, block time, error, and provenance;
6. encodes bytes as hex and bigint values as decimal strings;
7. refuses to overwrite an existing file;
8. never reads a wallet or submits a transaction.

Use the existing `SolanaRpcClient` and `TransactionFetcher`; do not add another
RPC client or explorer dependency.

- [ ] **Step 4: Capture exactly the three pinned transactions**

Run each command once against the configured RPC:

```bash
npm run fixture:capture -- pumpfun \
  5e5t9JwautKTqCNKqHmDiZhJx9K2x85kd7RbFfbtGZ4DtcLwPW4U18ZWoinYcCuUQzZ3WRmEiMe3BDsSewVwto8h \
  946 create-v2-initial-buy-mainnet.json
npm run fixture:capture -- pumpfun \
  3tVQzGUFNsAHoTcfiCbuX87y7Ta9rdY2BdTvgeSGwbEu7Nok8bfAGSCDwZMkuVMjjRniXyx6VKfYnPQXUCSC7yHG \
  763 sell-cpi-mainnet.json
npm run fixture:capture -- pumpfun \
  57qfbsAcVGdenmgVq2sySpVcgyNDCx1aXLQvwz2kuX4fr8V5twxzdCdvWK2RjsZUuArCdneB4WzcSotaWVE8Forw \
  1188 buy-exact-quote-v2-cpi-mainnet.json
```

Inspect each fixture before staging. It must contain no RPC URL, authorization
header, environment variable, private key, or full raw RPC response.

- [ ] **Step 5: Document the implemented boundary**

Update `docs/architecture/pumpfun-v1.md` to state:

- PR C pins official IDL commit
  `9c82f61cb711b044a17f770ab8ce9f9bdf78f333`;
- supported creation/trade instruction names;
- actual amounts come from paired CPI events;
- multi-quote observation remains enabled;
- the decoder makes zero runtime RPC calls;
- the adapter remains uncomposed;
- canonical transaction-index resolution, curve account reading, persistence,
  migration, and PumpSwap remain later work.

- [ ] **Step 6: Run the complete acceptance suite**

```bash
npm install
npm run pumpfun:check-generated
npm run build
npm run check
npm run lint
npm test
git diff --check
git status --short
```

Expected:

- every command exits `0`;
- all 109 pre-existing tests plus the new Pump tests pass;
- no generated diff appears;
- `src/app.ts` remains unchanged;
- no private-key or transaction-submission dependency appears in new code.

Run focused safety scans:

```bash
rg -n "sendTransaction|sendRawTransaction|Keypair|private.?key|secret" \
  src/launchpads/pumpfun scripts/generate-pumpfun-idl.ts \
  tests/fixtures/pumpfun vendor/pumpfun
rg -n "number|parseFloat|Math\\." src/launchpads/pumpfun
```

Expected: no execution/secret path; any `number` occurrence is limited to
bounded indexes, lengths, decimals, or stack heights and never represents a
financial amount.

- [ ] **Step 7: Commit fixtures, documentation, and final verification**

```bash
git add scripts/capture-fixture.ts \
  tests/helpers/pumpfun-fixture.ts \
  tests/fixtures/pumpfun \
  tests/pumpfun-transaction-decoder.test.ts \
  tests/pumpfun-launchpad-adapter.test.ts \
  docs/architecture/pumpfun-v1.md
git commit -m "test: verify Pump.fun decoder with mainnet fixtures"
```

---

## Final review gate

Before push or PR creation:

1. use `verification-before-completion`;
2. review the complete diff against
   `docs/superpowers/specs/2026-07-28-pr-c-pumpfun-decoder-design.md`;
3. use `requesting-code-review`;
4. address only evidence-backed review findings;
5. rerun the full acceptance suite;
6. confirm `main` and the PR A/Raydium paths were not modified unintentionally;
7. push `codex/pr-c-pumpfun-decoder` and open PR C without merging until the
   configured review/merge workflow is complete.
