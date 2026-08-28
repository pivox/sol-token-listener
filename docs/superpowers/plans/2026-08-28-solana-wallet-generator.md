# Solana Wallet Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated local utility that generates a Phantom-compatible Solana wallet and writes its documented public address, Base58 secret, byte-array secret, and recovery phrase to both the terminal and a protected JSON file.

**Architecture:** `wallet-generator/` is a small standalone ESM TypeScript package with its own dependencies, source, tests, and README. A pure wallet module handles BIP39/Ed25519 derivation and output construction; a file module performs collision-safe protected persistence; the CLI composes both and reports failures. The root project exposes a convenience npm command and ignores generated secrets.

**Tech Stack:** Node.js 22, TypeScript, tsx, Node test runner, `@solana/web3.js`, `bip39`, `ed25519-hd-key`, `bs58`.

---

## File map

- Create `wallet-generator/package.json`: isolated scripts and dependencies.
- Create `wallet-generator/tsconfig.json`: strict ESM TypeScript configuration.
- Create `wallet-generator/src/wallet.ts`: mnemonic generation, deterministic derivation, validation, and documented output model.
- Create `wallet-generator/src/wallet-file.ts`: unique filename selection and atomic `0600` JSON persistence.
- Create `wallet-generator/src/create-wallet.ts`: CLI orchestration, terminal output, warnings, and exit status.
- Create `wallet-generator/tests/wallet.test.ts`: derivation and output contract tests.
- Create `wallet-generator/tests/wallet-file.test.ts`: persistence, collision, and permission tests.
- Create `wallet-generator/README.md`: usage, Phantom import, application import, and security guidance.
- Modify `.gitignore`: exclude `wallet-generator/output/`.
- Modify `package.json`: add the root convenience command `wallet:create`.

### Task 1: Scaffold the isolated package

**Files:**
- Create: `wallet-generator/package.json`
- Create: `wallet-generator/tsconfig.json`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Create the standalone package manifest**

```json
{
  "name": "solana-wallet-generator",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "create": "tsx src/create-wallet.ts",
    "check": "tsc --noEmit",
    "test": "tsx --test tests/*.test.ts"
  },
  "dependencies": {
    "@solana/web3.js": "1.98.4",
    "bip39": "3.1.0",
    "bs58": "6.0.0",
    "ed25519-hd-key": "1.3.0"
  },
  "devDependencies": {
    "@types/node": "24.0.0",
    "tsx": "4.23.12",
    "typescript": "5.8.3"
  },
  "engines": {
    "node": ">=22.13.0"
  }
}
```

- [ ] **Step 2: Create the strict TypeScript configuration**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Connect the isolated tool to the root project**

Add this script to the root `package.json`:

```json
"wallet:create": "npm run create --prefix wallet-generator"
```

Add this line to the root `.gitignore`:

```gitignore
wallet-generator/output/
```

- [ ] **Step 4: Install only the isolated package dependencies**

Run: `npm install --prefix wallet-generator`

Expected: `wallet-generator/package-lock.json` is created and installation exits with code 0.

- [ ] **Step 5: Verify the empty package type-checks**

Run: `npm run check --prefix wallet-generator`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 6: Commit the scaffold**

```bash
git add .gitignore package.json wallet-generator/package.json wallet-generator/package-lock.json wallet-generator/tsconfig.json
git commit -m "chore: scaffold isolated Solana wallet generator"
```

### Task 2: Implement deterministic wallet derivation with TDD

**Files:**
- Create: `wallet-generator/tests/wallet.test.ts`
- Create: `wallet-generator/src/wallet.ts`

- [ ] **Step 1: Write the failing wallet contract tests**

Create tests using the fixed valid mnemonic `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about`. Assert that `createWalletDetails(mnemonic)` returns a 12-word valid BIP39 phrase, a Base58 address equal to `deriveWallet(mnemonic).publicKey.toBase58()`, a Base58 secret decoding to 64 bytes, a 64-item byte array accepted by `Keypair.fromSecretKey`, and a non-empty French description on every output field. Also assert that `createWalletDetails("invalid")` throws `Phrase de récupération BIP39 invalide`.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import * as bip39 from "bip39";
import bs58 from "bs58";
import { createWalletDetails, deriveWallet } from "../src/wallet.js";

const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("creates coherent documented wallet details", () => {
  const details = createWalletDetails(mnemonic);
  assert.equal(details.recoveryPhrase.value.split(" ").length, 12);
  assert.equal(bip39.validateMnemonic(details.recoveryPhrase.value), true);
  assert.equal(details.address.value, deriveWallet(mnemonic).publicKey.toBase58());
  assert.equal(bs58.decode(details.privateKeyBase58.value).length, 64);
  assert.equal(details.privateKeyBytes.value.length, 64);
  assert.equal(Keypair.fromSecretKey(Uint8Array.from(details.privateKeyBytes.value)).publicKey.toBase58(), details.address.value);
  for (const field of Object.values(details)) assert.ok(field.description.length > 0);
});

test("rejects an invalid recovery phrase", () => {
  assert.throws(() => createWalletDetails("invalid"), /Phrase de récupération BIP39 invalide/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --prefix wallet-generator`

Expected: FAIL because `../src/wallet.js` does not exist.

- [ ] **Step 3: Implement the minimal wallet module**

Define `DERIVATION_PATH = "m/44'/501'/0'/0'"`, `DocumentedValue<T>`, and `WalletDetails`. Implement `deriveWallet(mnemonic)` by validating with `bip39.validateMnemonic`, calculating `bip39.mnemonicToSeedSync(mnemonic)`, passing the seed hex and path to `derivePath`, and calling `Keypair.fromSeed(derived.key)`. Implement `createWalletDetails(mnemonic = bip39.generateMnemonic(128))`, build all four documented fields, then reconstruct the keypair from its secret bytes and throw if its public address differs.

```ts
import { Keypair } from "@solana/web3.js";
import * as bip39 from "bip39";
import bs58 from "bs58";
import { derivePath } from "ed25519-hd-key";

export const DERIVATION_PATH = "m/44'/501'/0'/0'";
export interface DocumentedValue<T> { value: T; description: string }
export interface WalletDetails {
  address: DocumentedValue<string>;
  privateKeyBase58: DocumentedValue<string>;
  privateKeyBytes: DocumentedValue<number[]>;
  recoveryPhrase: DocumentedValue<string>;
}

export function deriveWallet(mnemonic: string): Keypair {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error("Phrase de récupération BIP39 invalide");
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  return Keypair.fromSeed(derivePath(DERIVATION_PATH, seed.toString("hex")).key);
}

export function createWalletDetails(mnemonic = bip39.generateMnemonic(128)): WalletDetails {
  const wallet = deriveWallet(mnemonic);
  const bytes = Array.from(wallet.secretKey);
  const address = wallet.publicKey.toBase58();
  if (Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey.toBase58() !== address) {
    throw new Error("La vérification du wallet généré a échoué");
  }
  return {
    address: { value: address, description: "Adresse publique Solana à recevoir et surveiller." },
    privateKeyBase58: { value: bs58.encode(wallet.secretKey), description: "Clé privée Base58 importable dans Phantom." },
    privateKeyBytes: { value: bytes, description: "Clé privée Solana au format tableau de 64 octets, utilisable par Keypair.fromSecretKey()." },
    recoveryPhrase: { value: mnemonic, description: `Phrase de récupération BIP39 de 12 mots utilisant le chemin Phantom/Solana ${DERIVATION_PATH}.` }
  };
}
```

- [ ] **Step 4: Run wallet tests and type-check**

Run: `npm test --prefix wallet-generator && npm run check --prefix wallet-generator`

Expected: all wallet tests PASS and TypeScript exits with code 0.

- [ ] **Step 5: Commit wallet derivation**

```bash
git add wallet-generator/src/wallet.ts wallet-generator/tests/wallet.test.ts
git commit -m "feat: derive Phantom-compatible Solana wallets"
```

### Task 3: Implement protected collision-safe persistence with TDD

**Files:**
- Create: `wallet-generator/tests/wallet-file.test.ts`
- Create: `wallet-generator/src/wallet-file.ts`

- [ ] **Step 1: Write failing persistence tests**

Use `mkdtemp`, a fixed timestamp, and a minimal `WalletDetails` fixture. Assert that `writeWalletFile(details, directory, now)` creates `solana-wallet-2026-08-28T10-20-30-000Z.json`, parses back to the exact fixture, has POSIX mode `0600`, and a second call creates a distinct `-1.json` file without changing the first.

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeWalletFile } from "../src/wallet-file.js";
import type { WalletDetails } from "../src/wallet.js";

const details: WalletDetails = {
  address: { value: "address", description: "address description" },
  privateKeyBase58: { value: "secret", description: "base58 description" },
  privateKeyBytes: { value: Array(64).fill(1), description: "bytes description" },
  recoveryPhrase: { value: "words", description: "phrase description" }
};

test("writes protected JSON without overwriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallet-generator-"));
  const now = new Date("2026-08-28T10:20:30.000Z");
  const first = await writeWalletFile(details, directory, now);
  const second = await writeWalletFile(details, directory, now);
  assert.notEqual(first, second);
  assert.deepEqual(JSON.parse(await readFile(first, "utf8")), details);
  if (process.platform !== "win32") assert.equal((await stat(first)).mode & 0o777, 0o600);
});
```

- [ ] **Step 2: Run the persistence test to verify it fails**

Run: `npm test --prefix wallet-generator`

Expected: FAIL because `../src/wallet-file.js` does not exist.

- [ ] **Step 3: Implement atomic unique persistence**

Implement `writeWalletFile(details, outputDirectory, now = new Date())`. Create the directory with mode `0700`, sanitize the ISO timestamp by replacing `:` and `.` with `-`, then attempt filenames with no suffix, `-1`, `-2`, and so on. Use `open(path, "wx", 0o600)` so existing files cannot be overwritten; write `JSON.stringify(details, null, 2) + "\n"`, close in `finally`, and retry only when the error code is `EEXIST`.

- [ ] **Step 4: Run persistence and wallet tests**

Run: `npm test --prefix wallet-generator && npm run check --prefix wallet-generator`

Expected: all tests PASS and TypeScript exits with code 0.

- [ ] **Step 5: Commit persistence**

```bash
git add wallet-generator/src/wallet-file.ts wallet-generator/tests/wallet-file.test.ts
git commit -m "feat: persist generated wallets securely"
```

### Task 4: Add the CLI and usage documentation

**Files:**
- Create: `wallet-generator/src/create-wallet.ts`
- Create: `wallet-generator/README.md`

- [ ] **Step 1: Implement CLI orchestration**

Resolve `wallet-generator/output` from `import.meta.url`, call `createWalletDetails()`, then call `writeWalletFile()`. Print a French warning, the full details object with `JSON.stringify(details, null, 2)`, and the resolved file path. Catch unknown errors, print `Échec de création du wallet: <message>` to stderr, and set `process.exitCode = 1`.

```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createWalletDetails } from "./wallet.js";
import { writeWalletFile } from "./wallet-file.js";

async function main(): Promise<void> {
  const details = createWalletDetails();
  const output = join(dirname(fileURLToPath(import.meta.url)), "..", "output");
  const file = await writeWalletFile(details, output);
  console.warn("ATTENTION : ne partagez jamais la clé privée ou la phrase de récupération et ne committez pas ce fichier.");
  console.log(JSON.stringify(details, null, 2));
  console.log(`Wallet enregistré dans : ${file}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Échec de création du wallet : ${message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Write the README**

Document these exact workflows:

```bash
# From sol-token-listener
npm run wallet:create

# Directly from the isolated directory
npm install --prefix wallet-generator
npm run create --prefix wallet-generator
```

Explain that Phantom can import `privateKeyBase58.value`, while project code can load `privateKeyBytes.value` using:

```ts
const wallet = Keypair.fromSecretKey(Uint8Array.from(privateKeyBytes));
```

State that `address.value` is public, both private-key fields and `recoveryPhrase.value` are secrets, output files are ignored by Git, and users should move backups to encrypted storage.

- [ ] **Step 3: Run static verification**

Run: `npm run check --prefix wallet-generator && npm test --prefix wallet-generator`

Expected: TypeScript exits with code 0 and all tests PASS.

- [ ] **Step 4: Run the real CLI once and inspect output safely**

Run: `npm run wallet:create`

Expected: exit code 0; terminal shows four described fields and a path under `wallet-generator/output/`. Do not paste generated secrets into logs, commits, issues, or the final response.

- [ ] **Step 5: Validate file metadata without printing secrets**

Run: `find wallet-generator/output -type f -maxdepth 1 -exec stat -f '%Sp %N' {} \;`

Expected on macOS: one file with permissions `-rw-------`.

- [ ] **Step 6: Commit CLI and documentation**

```bash
git add wallet-generator/src/create-wallet.ts wallet-generator/README.md
git commit -m "feat: add local Solana wallet creation command"
```

### Task 5: Final verification

**Files:**
- Verify: `wallet-generator/`
- Verify: `.gitignore`
- Verify: `package.json`

- [ ] **Step 1: Run all isolated checks**

Run: `npm run check --prefix wallet-generator && npm test --prefix wallet-generator`

Expected: both commands exit 0 and every test passes.

- [ ] **Step 2: Confirm secrets cannot be staged accidentally**

Run: `git check-ignore -v wallet-generator/output/*.json`

Expected: `.gitignore` reports the `wallet-generator/output/` rule for every generated JSON file.

- [ ] **Step 3: Inspect the scoped diff**

Run: `git status --short && git diff --check`

Expected: no whitespace errors; unrelated pre-existing working-tree changes remain untouched.

- [ ] **Step 4: Commit any final documentation-only corrections**

```bash
git add wallet-generator/README.md
git commit -m "docs: clarify Solana wallet secret handling"
```

Skip this commit when no correction is required.
