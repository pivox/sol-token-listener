# PumpSwap Migration PR G Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Détecter et persister les migrations Pump.fun, activer uniquement le pool PumpSwap canonique prouvé, puis exposer ses réserves, swaps et cotations passives en entiers.

**Architecture:** Le décodeur Pump.fun produit une preuve de migration sans dépendre de PumpSwap. Un matcher d'application rapproche cette preuve du `create_pool` et du `CreatePoolEvent` PumpSwap dans le même périmètre CPI, puis un repository transactionnel persiste les événements, projections et transitions. `PumpSwapMarketAdapter` implémente le port de marché générique avec un lecteur RPC strictement passif et un provider de quote qui décode les frais officiels on-chain mais effectue tous les calculs financiers en `bigint`.

**Tech Stack:** TypeScript 5 strict, ESM, Node.js 22 test runner, `@solana/web3.js`, `@solana/spl-token`, `@pump-fun/pump-swap-sdk@1.19.0` épinglé, PostgreSQL, IDL officielles Pump.fun/PumpSwap épinglées.

---

## Structure des fichiers

### Sources officielles et génération

- `vendor/pumpfun/idl/pump-amm-9c82f61.json` — snapshot PumpSwap officiel.
- `vendor/pumpfun/README.md` — provenance, révision et checksums.
- `scripts/generate-pumpfun-idl.ts` — inclut `migrate` et `migrate_v2`.
- `scripts/generate-pumpswap-idl.ts` — valide et génère le sous-ensemble PumpSwap.
- `src/markets/pumpswap/generated/pumpswap-idl.ts` — artefact généré.

### Domaine et ports

- `src/domain/migration-events.ts` — preuves et événements métier V1.
- `src/domain/market.ts` — projections de pool, réserve et trade génériques.
- `src/domain/market-errors.ts` — erreurs stables et typées.
- `src/domain/state-transitions.ts` — transitions migration/activation.
- `src/domain/types.ts` — réexport ou suppression des anciennes formes minimales.
- `src/ports/market-adapter.ts` — contrat générique enrichi.
- `src/ports/market-observation-repository.ts` — transaction atomique et finalité.
- `src/ports/market-rpc-reader.ts` — lecture cohérente de comptes sans écriture.
- `src/ports/pumpswap-quote-provider.ts` — frontière de cotation passive.

### Décodage et orchestration

- `src/launchpads/pumpfun/types.ts` — famille `MIGRATE`.
- `src/launchpads/pumpfun/instruction-decoder.ts` — décodage des deux migrations.
- `src/launchpads/pumpfun/transaction-decoder.ts` — collecte de migrations sans exiger un événement Pump.
- `src/markets/pumpswap/constants.ts` — programme et limites de layout.
- `src/markets/pumpswap/types.ts` — formes décodées internes.
- `src/markets/pumpswap/instruction-decoder.ts` — `create_pool`, `buy`, `sell`.
- `src/markets/pumpswap/event-decoder.ts` — événements Anchor CPI.
- `src/markets/pumpswap/transaction-decoder.ts` — association action/événement par portée CPI.
- `src/markets/pumpswap/pool-account-decoder.ts` — compte Pool append-only.
- `src/markets/pumpswap/pool-validator.ts` — PDA canonique et cohérence.
- `src/application/pumpswap-migration-matcher.ts` — rapprochement Pump/PumpSwap.
- `src/application/market-observation.service.ts` — batch transactionnel.

### Marché, quotes et persistance

- `src/markets/pumpswap/pumpswap-market.adapter.ts` — `MarketAdapter` passif.
- `src/markets/pumpswap/pumpswap-reserve-reader.ts` — comptes pool/vaults au même contexte.
- `src/markets/pumpswap/pumpswap-fee-state.ts` — décodage config globale et fee tiers.
- `src/markets/pumpswap/pumpswap-quote.provider.ts` — calculs BUY/SELL `bigint`.
- `src/storage/market-observation.repository.ts` — repository PostgreSQL.
- `migrations/005_pumpswap_market.sql` — migrations, pools, réserves et swaps.
- `src/storage/database.ts` — purge ordonnée des nouvelles projections.

### Tests

- `tests/pumpswap-idl-generation.test.ts`
- `tests/pumpfun-migration-decoder.test.ts`
- `tests/pumpswap-instruction-decoder.test.ts`
- `tests/pumpswap-event-decoder.test.ts`
- `tests/pumpswap-pool-validator.test.ts`
- `tests/pumpswap-migration-matcher.test.ts`
- `tests/pumpswap-market-migration.test.ts`
- `tests/market-observation.repository.test.ts`
- `tests/pumpswap-trade-decoder.test.ts`
- `tests/pumpswap-reserve-reader.test.ts`
- `tests/pumpswap-quote.provider.test.ts`
- `tests/pumpswap-market-adapter.test.ts`
- `tests/pumpswap-safety.test.ts`
- `tests/fixtures/pumpfun/migrate-wsol-sanitized.json`
- `tests/fixtures/pumpfun/migrate-v2-multiquote-sanitized.json`
- `tests/fixtures/pumpswap/buy-sell-token2022-sanitized.json`

## Task 1: Épingler les contrats officiels Pump et PumpSwap

**Files:**

- Create: `vendor/pumpfun/idl/pump-amm-9c82f61.json`
- Create: `scripts/generate-pumpswap-idl.ts`
- Create: `src/markets/pumpswap/generated/pumpswap-idl.ts`
- Modify: `scripts/generate-pumpfun-idl.ts`
- Modify: `vendor/pumpfun/README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/pumpfun-idl-generation.test.ts`
- Create: `tests/pumpswap-idl-generation.test.ts`

- [ ] **Step 1: Ajouter les tests de provenance et de sélection**

Ajouter des assertions qui fixent :

```typescript
assert.equal(OFFICIAL_PUMP_AMM_IDL_REVISION, '9c82f61cb711b044a17f770ab8ce9f9bdf78f333');
assert.equal(
  OFFICIAL_PUMP_AMM_IDL_SHA256,
  '6b5c7ec4e5ef9742fa99dc57b0d75b1031b379bba02a7e1b3c5a4cad68d77e56',
);
assert.deepEqual(Object.keys(PUMP_INSTRUCTIONS).slice(-2), [
  'migrate',
  'migrate_v2',
]);
assert.deepEqual(Object.keys(PUMPSWAP_INSTRUCTIONS), [
  'buy',
  'buy_exact_quote_in',
  'create_pool',
  'sell',
]);
assert.deepEqual(Object.keys(PUMPSWAP_EVENTS), [
  'BuyEvent',
  'CreatePoolEvent',
  'SellEvent',
]);
```

Le test PumpSwap doit aussi vérifier l'adresse
`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, le type `Pool`, les types
d'événement et le type de configuration de frais requis par le SDK. Comparer
les définitions `Pool`, `GlobalConfig`, `FeeConfig`, `FeeTier` et `Fees` de
l'IDL publique à `pumpAmmJson` exporté par le SDK avant d'autoriser
`PUMP_AMM_SDK.decodePool/decodeGlobalConfig/decodeFeeConfig`. Les événements
ne sont volontairement pas comparés, car l'IDL SDK manque `base_supply`.

- [ ] **Step 2: Vérifier que les tests échouent**

Run:

```bash
npm test -- --test-name-pattern='IDL Pump|IDL PumpSwap'
```

Expected: FAIL parce que le snapshot PumpSwap, le générateur et les deux
instructions Pump n'existent pas encore dans les artefacts générés.

- [ ] **Step 3: Ajouter les snapshots et générateurs déterministes**

Le nouveau générateur doit reprendre le contrôle de checksum du générateur
Pump et sélectionner exactement :

```typescript
export const OFFICIAL_PUMP_AMM_IDL_REVISION =
  '9c82f61cb711b044a17f770ab8ce9f9bdf78f333';
export const OFFICIAL_PUMP_AMM_IDL_SHA256 =
  '6b5c7ec4e5ef9742fa99dc57b0d75b1031b379bba02a7e1b3c5a4cad68d77e56';

const REQUIRED_INSTRUCTIONS = [
  'buy',
  'buy_exact_quote_in',
  'create_pool',
  'sell',
] as const;
const REQUIRED_EVENTS = ['BuyEvent', 'CreatePoolEvent', 'SellEvent'] as const;
const REQUIRED_ACCOUNTS = ['FeeConfig', 'GlobalConfig', 'Pool'] as const;
const REQUIRED_TYPES = [
  'BuyEvent',
  'CreatePoolEvent',
  'FeeTier',
  'Fees',
  'Pool',
  'SellEvent',
] as const;
```

Le rendu doit exporter `PUMPSWAP_INSTRUCTIONS`, `PUMPSWAP_EVENTS`,
`PUMPSWAP_ACCOUNTS` et `PUMPSWAP_TYPES`. Ajouter à `package.json` :

```json
{
  "scripts": {
    "pumpswap:generate": "tsx scripts/generate-pumpswap-idl.ts",
    "pumpswap:check-generated": "tsx scripts/generate-pumpswap-idl.ts --check",
    "check": "npm run pumpfun:check-generated && npm run pumpswap:check-generated && tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@pump-fun/pump-swap-sdk": "1.19.0"
  }
}
```

Le SDK n'est autorisé que dans `src/markets/pumpswap/`.
L'IDL publique générée reste l'autorité pour les instructions et événements :
l'IDL du SDK `1.19.0` ne possède pas encore `base_supply` dans `BuyEvent` et
`SellEvent`. Le générateur et les tests rendent toute substitution impossible.

- [ ] **Step 4: Générer et vérifier**

Run:

```bash
npm install
npm run pumpfun:generate
npm run pumpswap:generate
npm run pumpfun:check-generated
npm run pumpswap:check-generated
npm test -- --test-name-pattern='IDL Pump|IDL PumpSwap'
```

Expected: PASS, avec un `package-lock.json` qui épingle
`@pump-fun/pump-swap-sdk@1.19.0`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts vendor src/markets/pumpswap/generated tests/pumpfun-idl-generation.test.ts tests/pumpswap-idl-generation.test.ts
git commit -m "build: pin official PumpSwap contracts"
```

## Task 2: Introduire les contrats métier de migration et de marché

**Files:**

- Create: `src/domain/migration-events.ts`
- Create: `src/domain/market.ts`
- Create: `src/domain/market-errors.ts`
- Modify: `src/domain/events.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/ports/market-adapter.ts`
- Create: `src/ports/market-observation-repository.ts`
- Create: `src/ports/market-rpc-reader.ts`
- Create: `src/ports/pumpswap-quote-provider.ts`
- Modify: `tests/domain-contracts.test.ts`
- Create: `tests/migration-events.test.ts`
- Create: `tests/market-ports.test.ts`

- [ ] **Step 1: Écrire les tests des objets immuables et identifiants**

Les tests construisent deux événements de même signature avec des curseurs
internes différents et exigent des IDs différents. Ils vérifient aussi que les
payloads sont gelés, que tous les montants sont des `bigint` et que
`orphaned` reste un statut de confirmation valide.

Contrats attendus :

```typescript
export interface MigrationObservation {
  readonly instruction: 'MIGRATE' | 'MIGRATE_V2';
  readonly mint: string;
  readonly bondingCurve: string;
  readonly announcedPool: string;
  readonly baseTokenProgram: TokenProgramKind;
  readonly quoteAsset: QuoteAsset;
  readonly cursor: ChainCursor;
}

export interface CanonicalMarketPool extends MarketPool {
  readonly programId: string;
  readonly index: number;
  readonly creator: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly lpMint: string;
  readonly baseTokenProgram: TokenProgramKind;
  readonly confirmationStatus: ChainConfirmationStatus;
}

export interface RawMarketObservation {
  readonly id: string;
  readonly source: string;
  readonly program: string;
  readonly mint: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTimeMs: number | null;
  readonly observedAtMs: number;
  readonly payloadVersion: 1;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface MarketQuote {
  readonly id: string;
  readonly pool: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  readonly minimumAmountOutRaw: bigint;
  readonly feesRaw: bigint;
  readonly slippageBps: bigint;
  readonly priceImpactBps: bigint;
  readonly observedAtMs: number;
  readonly observedSlot: bigint;
}

export interface MarketReserves {
  readonly pool: string;
  readonly baseReservesRaw: bigint;
  readonly quoteVaultAmountRaw: bigint;
  readonly virtualQuoteReservesRaw: bigint;
  readonly effectiveQuoteReservesRaw: bigint;
  readonly observedSlot: bigint;
  readonly observedAtMs: number;
}

export interface MarketTrade {
  readonly id: string;
  readonly pool: string;
  readonly mint: string;
  readonly quoteAsset: QuoteAsset;
  readonly kind: 'BUY' | 'SELL';
  readonly trader: string | null;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly blockchainTimeMs: number | null;
  readonly observedAtMs: number;
}
```

- [ ] **Step 2: Vérifier l'échec des tests**

Run:

```bash
npm test -- --test-name-pattern='migration event|market port'
```

Expected: FAIL avec des modules ou exports absents.

- [ ] **Step 3: Implémenter les contrats et factories**

Créer :

```typescript
export type MigrationObservedEventV1 = TypedDomainEvent<
  'MigrationObserved',
  Readonly<{ migration: MigrationObservation }>,
  1
>;

export type PumpSwapPoolActivatedEventV1 = TypedDomainEvent<
  'PumpSwapPoolActivated',
  Readonly<{
    migrationEventId: string;
    pool: CanonicalMarketPool;
  }>,
  1
>;
```

Les factories utilisent `createDeterministicChainEventId`, prennent des
snapshots profonds et valident les timestamps et curseurs comme
`src/domain/launchpad-events.ts`.

Le port RPC doit être entièrement passif :

```typescript
export interface ReadonlyAccountSnapshot {
  readonly address: string;
  readonly owner: string;
  readonly data: Uint8Array;
  readonly lamports: bigint;
  readonly slot: bigint;
}

export interface MarketRpcReader {
  readAccountsAtSameSlot(
    addresses: readonly string[],
  ): Promise<readonly (ReadonlyAccountSnapshot | null)[]>;
}
```

Le tableau conserve exactement l'ordre demandé. Un compte absent vaut `null` ;
le slot commun est porté par chaque compte présent et l'implémentation refuse
des contextes divergents.

Le provider de quote reçoit uniquement des snapshots normalisés et un
`slippageBps: bigint`; il ne reçoit ni `Connection`, ni wallet, ni signer.

```typescript
export interface PumpSwapQuoteRequest {
  readonly pool: CanonicalMarketPool;
  readonly reserves: MarketReserves;
  readonly inputMint: string;
  readonly amountInRaw: bigint;
  readonly slippageBps: bigint;
}

export interface PumpSwapQuotePort {
  quote(request: PumpSwapQuoteRequest): Promise<MarketQuote>;
}

export interface MarketQuoteRequest {
  readonly pool: CanonicalMarketPool;
  readonly inputMint: string;
  readonly amountInRaw: bigint;
  readonly slippageBps: bigint;
}
```

Rendre aussi le port marché générique sur l'enveloppe observée, selon le même
patron que `LaunchpadAdapter` :

```typescript
export interface MarketAdapter<
  in TTransaction extends ObservedChainTransaction =
    ObservedChainTransaction,
> {
  readonly source: string;
  readonly programId: string;
  readonly detectPools: (
    transaction: TTransaction,
  ) => Promise<readonly CanonicalMarketPool[]>;
  readonly decodeTrades: (
    transaction: TTransaction,
    trackedPools: ReadonlyMap<string, CanonicalMarketPool>,
  ) => Promise<readonly MarketTrade[]>;
  readonly readReserves: (
    pool: CanonicalMarketPool,
  ) => Promise<MarketReserves>;
  readonly quote: (request: MarketQuoteRequest) => Promise<MarketQuote>;
}
```

- [ ] **Step 4: Vérifier les contrats**

Run:

```bash
npm test -- --test-name-pattern='migration event|market port|domain contracts'
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain src/ports tests/domain-contracts.test.ts tests/migration-events.test.ts tests/market-ports.test.ts
git commit -m "feat: add migration and market contracts"
```

## Task 3: Décoder `migrate` et `migrate_v2` côté Pump.fun

**Files:**

- Modify: `src/launchpads/pumpfun/types.ts`
- Modify: `src/launchpads/pumpfun/instruction-decoder.ts`
- Modify: `src/launchpads/pumpfun/transaction-decoder.ts`
- Modify: `src/launchpads/pumpfun/pumpfun-launchpad.adapter.ts`
- Create: `src/solana/rpc/observed-transaction.ts`
- Create: `tests/pumpfun-migration-decoder.test.ts`
- Create: `tests/fixtures/pumpfun/migrate-wsol-sanitized.json`
- Create: `tests/fixtures/pumpfun/migrate-v2-multiquote-sanitized.json`
- Modify: `tests/helpers/pumpfun-fixture.ts`

- [ ] **Step 1: Écrire les tests de décodage multi-instruction**

Les tests couvrent :

```typescript
assert.equal(legacy.instruction, 'MIGRATE');
assert.equal(legacy.quoteAsset.mint, WSOL_MINT);
assert.equal(v2.instruction, 'MIGRATE_V2');
assert.equal(v2.quoteAsset.mint, fixtureQuoteMint);
assert.equal(v2.baseTokenProgram, 'TOKEN_2022');
assert.equal(v2.quoteAsset.tokenProgram, 'SPL_TOKEN');
assert.notEqual(first.id, second.id);
```

Créer aussi une transaction contenant deux migrations et une migration CPI. Le
résultat doit préserver l'ordre du curseur complet. Une transaction échouée
doit produire zéro migration.

- [ ] **Step 2: Vérifier que les tests échouent**

Run:

```bash
npm test -- --test-name-pattern='Pump migration'
```

Expected: FAIL car la famille `MIGRATE` n'existe pas.

- [ ] **Step 3: Étendre les types et le décodeur**

Étendre les unions :

```typescript
export type PumpInstructionName =
  | 'buy'
  | 'buy_exact_quote_in_v2'
  | 'buy_exact_sol_in'
  | 'buy_v2'
  | 'create'
  | 'create_v2'
  | 'migrate'
  | 'migrate_v2'
  | 'sell'
  | 'sell_v2';

export type PumpInstructionFamily =
  | 'CREATE'
  | 'BUY'
  | 'SELL'
  | 'MIGRATE';

export interface DecodedPumpMigration {
  readonly action: DecodedPumpInstruction & { readonly family: 'MIGRATE' };
  readonly instruction: 'MIGRATE' | 'MIGRATE_V2';
  readonly mint: string;
  readonly bondingCurve: string;
  readonly announcedPool: string;
  readonly baseTokenProgram: TokenProgramKind;
  readonly quoteAsset: QuoteAsset;
}
```

`decodePumpTransaction` doit retourner `migrations` en plus de `creations` et
`trades`. Contrairement aux créations et trades, une migration ne requiert pas
d'événement Pump : elle est validée par ses comptes, puis enrichie par la
preuve PumpSwap à l'étape suivante.

Pour `migrate`, résoudre WSOL et SPL Token depuis les comptes officiels. Pour
`migrate_v2`, lire `base_mint`, `quote_mint`, `base_token_program` et
`quote_token_program`, puis appeler les validateurs de programme existants.

- [ ] **Step 4: Extraire l'enveloppe observée et adapter le launchpad**

Extraire l'enveloppe générique actuellement locale à l'adaptateur Pump :

```typescript
export interface SolanaObservedTransaction extends ObservedChainTransaction {
  readonly raw: NormalizedTransaction;
}

export function createSolanaObservedTransaction(
  raw: NormalizedTransaction,
  observedAtMs: number,
): SolanaObservedTransaction;
```

Conserver `PumpFunObservedTransaction` comme alias de compatibilité et utiliser
la factory partagée. Ajouter ensuite à `PumpFunLaunchpadAdapter` :

```typescript
public decodeMigrations(
  transaction: SolanaObservedTransaction,
): Promise<readonly MigrationObservation[]> {
  return this.decodeOnce(transaction).then((decoded) =>
    decoded.migrations.map((migration) =>
      toMigrationObservation(transaction.raw, migration)));
}
```

Ne pas injecter ces migrations dans le batch création/trade existant tant que
le service transactionnel de Task 8 n'est pas disponible.

- [ ] **Step 5: Vérifier**

Run:

```bash
npm test -- --test-name-pattern='Pump migration|Pump transaction decoder|Pump launchpad adapter'
npm run check
```

Expected: PASS, y compris pour les tests création/achat/vente existants.

- [ ] **Step 6: Commit**

```bash
git add src/launchpads/pumpfun src/solana/rpc/observed-transaction.ts tests/pumpfun-migration-decoder.test.ts tests/fixtures/pumpfun tests/helpers/pumpfun-fixture.ts
git commit -m "feat: decode Pump migration instructions"
```

## Task 4: Décoder les actions et événements PumpSwap par portée CPI

**Files:**

- Create: `src/markets/pumpswap/constants.ts`
- Create: `src/markets/pumpswap/types.ts`
- Create: `src/markets/pumpswap/errors.ts`
- Create: `src/markets/pumpswap/instruction-decoder.ts`
- Create: `src/markets/pumpswap/event-decoder.ts`
- Create: `src/markets/pumpswap/transaction-decoder.ts`
- Create: `src/solana/anchor/borsh-reader.ts`
- Create: `src/solana/anchor/idl-codec.ts`
- Create: `src/solana/anchor/cpi-scope.ts`
- Modify: `src/launchpads/pumpfun/borsh-reader.ts`
- Modify: `src/launchpads/pumpfun/idl-codec.ts`
- Modify: `src/launchpads/pumpfun/transaction-decoder.ts`
- Create: `tests/pumpswap-instruction-decoder.test.ts`
- Create: `tests/pumpswap-event-decoder.test.ts`
- Create: `tests/pumpswap-trade-decoder.test.ts`
- Create: `tests/fixtures/pumpswap/buy-sell-token2022-sanitized.json`

- [ ] **Step 1: Écrire les tests action/événement**

Les tests exigent :

- décodage exact de `create_pool`, `buy`, `buy_exact_quote_in` et `sell` ;
- prise en charge outer et inner instruction ;
- association d'un seul événement au même groupe CPI ;
- deux swaps sous le même wrapper sans mélange ;
- rejet d'un événement manquant, dupliqué, orphelin ou ambigu ;
- validation pool, trader, mints, direction et montants ;
- conservation des montants `u64` en `bigint`.

Exemple d'assertion :

```typescript
const [buy, sell] = decoded.trades;
assert.equal(buy?.kind, 'BUY');
assert.equal(sell?.kind, 'SELL');
assert.equal(typeof buy?.quoteAmountRaw, 'bigint');
assert.notEqual(buy?.cursor.innerInstructionIndex, sell?.cursor.innerInstructionIndex);
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap instruction|PumpSwap event|PumpSwap trade'
```

Expected: FAIL car les décodeurs PumpSwap sont absents.

- [ ] **Step 3: Implémenter les décodeurs IDL**

Déplacer les primitives Borsh/IDL génériques vers `src/solana/anchor/`.
Conserver les exports Pump existants comme façades de compatibilité :

```typescript
export { BorshReader as PumpBorshReader } from '../../solana/anchor/borsh-reader.js';
export { decodeIdlFields } from '../../solana/anchor/idl-codec.js';
```

Extraire aussi la portée CPI commune :

```typescript
export function isInstructionInsideCpiScope(
  parent: NormalizedInstruction,
  child: NormalizedInstruction,
  instructions: readonly NormalizedInstruction[],
): boolean;
```

Les décodeurs Pump et PumpSwap utilisent cette même fonction, ce qui empêche
une divergence future des règles de parenté CPI.

La forme interne doit rester :

```typescript
export interface DecodedPumpSwapTransaction {
  readonly poolCreations: readonly DecodedPumpSwapPoolCreation[];
  readonly trades: readonly DecodedPumpSwapTrade[];
}

export interface DecodedPumpSwapTrade {
  readonly action: DecodedPumpSwapInstruction;
  readonly event: DecodedPumpSwapBuyEvent | DecodedPumpSwapSellEvent;
  readonly kind: 'BUY' | 'SELL';
  readonly pool: string;
  readonly trader: string | null;
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
}
```

`buy` et `buy_exact_quote_in` produisent tous deux un `BuyEvent`, validé contre
les arguments propres à l'instruction. `base_supply` est lu depuis l'IDL
publique et reste un `bigint`.

L'association doit reprendre les invariants de `isEventInsideActionScope` :
même instruction externe, événement à `stackHeight + 1`, borne au prochain
frère CPI. Aucun delta de balance global n'est utilisé.

- [ ] **Step 4: Ajouter les erreurs stables**

Créer des codes :

```typescript
export type PumpSwapDecodingErrorCode =
  | 'PUMPSWAP_ACCOUNT_MISSING'
  | 'PUMPSWAP_BORSH_INVALID'
  | 'PUMPSWAP_EVENT_AMBIGUOUS'
  | 'PUMPSWAP_EVENT_DUPLICATE'
  | 'PUMPSWAP_EVENT_MISMATCH'
  | 'PUMPSWAP_EVENT_MISSING'
  | 'PUMPSWAP_EVENT_ORPHANED'
  | 'PUMPSWAP_STACK_HEIGHT_REQUIRED'
  | 'PUMPSWAP_TOKEN_PROGRAM_UNSUPPORTED';
```

Chaque erreur inclut signature et curseur lorsqu'ils existent.

- [ ] **Step 5: Vérifier**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap instruction|PumpSwap event|PumpSwap trade'
npm run check
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/markets/pumpswap src/solana/anchor src/launchpads/pumpfun/borsh-reader.ts src/launchpads/pumpfun/idl-codec.ts src/launchpads/pumpfun/transaction-decoder.ts tests/pumpswap-*.test.ts tests/fixtures/pumpswap
git commit -m "feat: decode PumpSwap actions and events"
```

## Task 5: Valider le compte Pool et le PDA canonique

**Files:**

- Create: `src/markets/pumpswap/pool-account-decoder.ts`
- Create: `src/markets/pumpswap/pool-validator.ts`
- Modify: `src/markets/pumpswap/types.ts`
- Create: `tests/pumpswap-pool-validator.test.ts`

- [ ] **Step 1: Écrire les tests du layout append-only**

Les tests construisent un compte avec :

```typescript
{
  index: 0,
  creator,
  baseMint,
  quoteMint,
  lpMint,
  baseVault,
  quoteVault,
  lpSupply: 1_000_000n,
  virtualQuoteReservesRaw: 25_000_000n,
}
```

Ils exigent l'acceptation de données supplémentaires en fin de compte et le
rejet d'un discriminator inconnu, d'un compte tronqué, d'un `i128` hors plage,
d'un index non nul et d'une adresse PDA différente. Ajouter un mint Token-2022
avec une extension qui modifie les transferts et exiger
`UNSUPPORTED_TOKEN_EXTENSION`.

- [ ] **Step 2: Vérifier que les tests échouent**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap pool'
```

Expected: FAIL avec modules absents.

- [ ] **Step 3: Implémenter le décodage strict**

Le décodeur retourne :

```typescript
export interface DecodedPumpSwapPoolAccount {
  readonly poolBump: number;
  readonly index: number;
  readonly creator: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly lpMint: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly lpSupplyRaw: bigint;
  readonly coinCreator: string;
  readonly isMayhemMode: boolean;
  readonly isCashbackCoin: boolean;
  readonly virtualQuoteReservesRaw: bigint;
  readonly trailingDataHex: string;
}
```

Vérifier d'abord le discriminator et la taille minimale du layout épinglé, puis
utiliser `PUMP_AMM_SDK.decodePool` uniquement comme décodeur officiel de
compte. Convertir immédiatement `BN` en chaîne décimale puis en `bigint`, et
valider `-(2n ** 127n) <= value && value < 2n ** 127n`. Ne laisser aucun `BN`
sortir du module.

- [ ] **Step 4: Implémenter la validation canonique**

Le validateur utilise `poolPda` du SDK officiel et exige :

```typescript
if (pool.index !== 0) {
  throw new NonCanonicalPumpSwapPoolError(address, pool.index);
}
if (poolPda(0, creatorKey, baseKey, quoteKey).toBase58() !== address) {
  throw new PumpSwapPoolPdaMismatchError(address);
}
```

Comparer ensuite instruction, `CreatePoolEvent`, compte pool, vaults, LP mint
et programmes token. L'owner du compte doit être le programme PumpSwap.

Décoder les extensions Token-2022 avec les helpers SPL officiels. Les
extensions purement descriptives peuvent être conservées comme preuve. Refuser
explicitement celles dont les effets ne sont pas intégrés au calcul de quote,
notamment `TransferFeeConfig`, `TransferHook`, `NonTransferable`,
`PermanentDelegate` et les extensions de transfert confidentiel :

```typescript
throw new UnsupportedTokenExtensionError(mint, extensionType);
```

Ne jamais ignorer silencieusement une extension inconnue.

- [ ] **Step 5: Vérifier**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap pool'
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/markets/pumpswap/pool-account-decoder.ts src/markets/pumpswap/pool-validator.ts src/markets/pumpswap/types.ts tests/pumpswap-pool-validator.test.ts
git commit -m "feat: validate canonical PumpSwap pools"
```

## Task 6: Rapprocher migration Pump et activation PumpSwap

**Files:**

- Create: `src/application/pumpswap-migration-matcher.ts`
- Modify: `src/domain/migration-events.ts`
- Modify: `src/domain/state-transitions.ts`
- Modify: `tests/launch-state-transitions.test.ts`
- Create: `tests/pumpswap-migration-matcher.test.ts`

- [ ] **Step 1: Écrire les tests de rapprochement**

Cas nominaux :

```text
migrate outer
  create_pool inner
    CreatePoolEvent inner child

wrapper outer
  migrate_v2 inner
    create_pool inner child
      CreatePoolEvent inner grandchild
```

Les tests exigent un `MigrationObserved` même si la preuve PumpSwap manque,
mais aucun `PumpSwapPoolActivated`. Ils rejettent un mauvais mint, quote mint,
programme token, pool ou événement pris dans une autre portée CPI.

- [ ] **Step 2: Vérifier l'échec**

Run:

```bash
npm test -- --test-name-pattern='migration matcher|migration transition'
```

Expected: FAIL.

- [ ] **Step 3: Implémenter le matcher pur**

API attendue :

```typescript
export interface MatchedMigration {
  readonly migrationEvent: MigrationObservedEventV1;
  readonly activationEvent: PumpSwapPoolActivatedEventV1 | null;
}

export function matchPumpSwapMigrations(
  transaction: ObservedChainTransaction,
  pumpMigrations: readonly DecodedPumpMigration[],
  pumpSwap: DecodedPumpSwapTransaction,
  validatedPools: ReadonlyMap<string, CanonicalMarketPool>,
): readonly MatchedMigration[];
```

Trier les résultats avec `compareCursors`. Une preuve `create_pool` ne peut être
consommée qu'une fois. Deux candidats compatibles dans la même portée
produisent `PUMPSWAP_MIGRATION_AMBIGUOUS`.

- [ ] **Step 4: Ajouter les transitions explicites**

Ajouter :

```typescript
createMigrationPendingTransition(
  current: 'BONDING_CURVE_COMPLETE' | 'OBSERVING',
  event: MigrationObservedEventV1,
): StateTransition;

createPumpSwapActiveTransition(
  event: PumpSwapPoolActivatedEventV1,
): StateTransition;
```

La seconde transition est strictement
`MIGRATION_PENDING -> PUMPSWAP_ACTIVE`. Les messages humains sont constants et
les IDs utilisent `createDeterministicTransitionId`.

- [ ] **Step 5: Vérifier**

Run:

```bash
npm test -- --test-name-pattern='migration matcher|migration transition|launch state'
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/pumpswap-migration-matcher.ts src/domain/migration-events.ts src/domain/state-transitions.ts tests/pumpswap-migration-matcher.test.ts tests/launch-state-transitions.test.ts
git commit -m "feat: match Pump migrations to canonical pools"
```

## Task 7: Ajouter la migration PostgreSQL `005`

**Files:**

- Create: `migrations/005_pumpswap_market.sql`
- Create: `tests/pumpswap-market-migration.test.ts`
- Modify: `scripts/migrate.ts`

- [ ] **Step 1: Écrire le test de contrat SQL**

Le test exige les quatre tables :

```typescript
for (const table of [
  'migrations',
  'market_pools',
  'market_reserve_snapshots',
  'market_trades',
]) {
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));
}
assert.match(sql, /NUMERIC\\(78,0\\)/u);
assert.match(sql, /pool_index INTEGER NOT NULL CHECK \\(pool_index = 0\\)/u);
assert.match(sql, /confirmation_status.*orphaned/su);
assert.match(sql, /COALESCE\\(inner_instruction_index, -1\\)/u);
```

Il vérifie aussi l'absence de clé, signer et envoi.

- [ ] **Step 2: Vérifier que le test échoue**

Run:

```bash
npm test -- --test-name-pattern='migration PostgreSQL PumpSwap'
```

Expected: FAIL car `005_pumpswap_market.sql` est absent.

- [ ] **Step 3: Créer les tables additives**

Colonnes indispensables :

```sql
CREATE TABLE IF NOT EXISTS migrations (
  migration_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  bonding_curve TEXT NOT NULL,
  announced_pool TEXT NOT NULL,
  instruction_kind TEXT NOT NULL CHECK (instruction_kind IN ('MIGRATE','MIGRATE_V2')),
  quote_mint TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  base_token_program TEXT NOT NULL,
  quote_token_program TEXT NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (
    confirmation_status IN ('processed','confirmed','finalized','orphaned')
  ),
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload JSONB NOT NULL,
  purge_after TIMESTAMPTZ
);
```

`market_pools` référence migration et activation, conserve les deux vaults,
les programmes token, le LP mint, le curseur et un statut `active|retracted`.
Créer un index unique partiel sur `(market, base_mint, quote_mint)` lorsque
`pool_state = 'active' AND pool_index = 0`.

`market_reserve_snapshots` et `market_trades` utilisent `NUMERIC(78,0)` pour
tous les montants et une clé unique fondée sur le curseur complet.

- [ ] **Step 4: Vérifier la chaîne des migrations**

Run:

```bash
npm test -- --test-name-pattern='migration|storage foundation'
```

Expected: PASS pour les contrats `001` à `005`.

Si `TEST_DATABASE_URL` est défini :

```bash
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate
```

Expected: les deux exécutions réussissent, la seconde n'applique aucune
migration supplémentaire.

- [ ] **Step 5: Commit**

```bash
git add migrations/005_pumpswap_market.sql tests/pumpswap-market-migration.test.ts scripts/migrate.ts
git commit -m "db: persist PumpSwap migration observations"
```

## Task 8: Persister atomiquement événements, projections et finalité

**Files:**

- Create: `src/storage/market-observation.repository.ts`
- Create: `src/application/market-observation.service.ts`
- Modify: `src/ports/market-observation-repository.ts`
- Modify: `src/storage/database.ts`
- Create: `tests/market-observation.repository.test.ts`
- Create: `tests/market-observation.service.test.ts`

- [ ] **Step 1: Écrire les tests du repository avec client instrumenté**

Les tests vérifient l'ordre :

```typescript
assert.deepEqual(statements, [
  'BEGIN',
  'INSERT raw_chain_events MigrationObserved',
  'INSERT domain_events MigrationObserved',
  'INSERT migrations',
  'INSERT state_transitions MIGRATION_PENDING',
  'INSERT raw_chain_events PumpSwapPoolActivated',
  'INSERT domain_events PumpSwapPoolActivated',
  'INSERT market_pools',
  'INSERT state_transitions PUMPSWAP_ACTIVE',
  'COMMIT',
]);
```

Ajouter les cas replay identique, progression
`processed -> confirmed -> finalized`, contradiction de payload, première
observation orphaned, `confirmed -> orphaned`, `finalized -> orphaned` et
rollback sur erreur intermédiaire.

- [ ] **Step 2: Vérifier l'échec**

Run:

```bash
npm test -- --test-name-pattern='market observation'
```

Expected: FAIL avec repository/service absents.

- [ ] **Step 3: Implémenter le port transactionnel**

Le batch doit être fermé et ordonné :

```typescript
export interface MarketObservationBatch {
  readonly rawEvents: readonly RawMarketObservation[];
  readonly matches: readonly MatchedMigration[];
  readonly reserveSnapshots: readonly MarketReserves[];
  readonly trades: readonly MarketTrade[];
}

export interface MarketObservationRepository {
  record(batch: MarketObservationBatch): Promise<MarketObservationResult>;
  loadActivePools(): Promise<readonly CanonicalMarketPool[]>;
}
```

Le service expose `loadActivePools()` et une méthode de validation/écriture :

```typescript
public record(
  transaction: SolanaObservedTransaction,
  observation: Omit<MarketObservationBatch, 'rawEvents'>,
): Promise<MarketObservationResult>;
```

Il crée exactement un `RawMarketObservation` par événement métier ou trade,
rejette les IDs dupliqués et les curseurs qui ne correspondent pas à la
transaction, trie par curseur complet puis appelle le repository.

- [ ] **Step 4: Implémenter les transactions et la finalité**

Le repository :

1. prend un advisory lock sur `source/program/signature` ;
2. verrouille `token_launches` et les événements existants ;
3. accepte `OBSERVING|BONDING_CURVE_COMPLETE -> MIGRATION_PENDING`, ou reconnaît
   le replay d'un état déjà plus avancé ;
4. appelle `reconcileConfirmationStatus` ;
5. compare le payload entrant au payload persisté ;
6. insère ou enrichit sans recréer d'identité ;
7. rétracte projections et transitions en cas d'orphaning ;
8. refuse `finalized -> orphaned` ;
9. commit ou rollback l'ensemble.

Une première observation orphaned écrit uniquement `raw_chain_events` avec
`confirmation_status='orphaned'`. Elle n'insère ni événement métier actif, ni
projection, ni transition.

Injecter `dataRetentionHours` et une horloge dans le repository. Une projection
active conserve `purge_after = NULL`. À la rétractation ou lorsque le lancement
devient terminal :

```typescript
const purgeAfterMs =
  terminalAtMs + dataRetentionHours * 60 * 60 * 1_000;
```

Le calcul temporel utilise des entiers sûrs, pas des montants financiers. La
valeur par défaut reste `DATA_RETENTION_HOURS=4` et le repository persiste le
même `terminal_at/purge_after` sur le pool, ses réserves, ses trades, les
événements et transitions concernés.

- [ ] **Step 5: Étendre la purge**

Dans `purgeExpiredPumpFunData`, supprimer dans cet ordre :

```text
market_trades
market_reserve_snapshots
market_pools
migrations
paper_positions
state_transitions
domain_events
raw_chain_events
token_launches
```

Inclure les compteurs des quatre nouvelles tables dans le résultat.

- [ ] **Step 6: Vérifier**

Run:

```bash
npm test -- --test-name-pattern='market observation|confirmation status|paper trading repository'
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/market-observation.repository.ts src/application/market-observation.service.ts src/ports/market-observation-repository.ts src/storage/database.ts tests/market-observation.repository.test.ts tests/market-observation.service.test.ts
git commit -m "feat: persist PumpSwap observations atomically"
```

## Task 9: Lire des réserves PumpSwap cohérentes

**Files:**

- Create: `src/solana/rpc/market-rpc-reader.ts`
- Create: `src/markets/pumpswap/pumpswap-reserve-reader.ts`
- Modify: `src/markets/pumpswap/errors.ts`
- Create: `tests/pumpswap-reserve-reader.test.ts`

- [ ] **Step 1: Écrire les tests de contexte RPC et réserves**

Les tests passent des comptes pool, base vault et quote vault au même slot et
exigent :

```typescript
assert.equal(snapshot.baseReservesRaw, 10_000_000n);
assert.equal(snapshot.quoteVaultAmountRaw, 20_000_000n);
assert.equal(snapshot.virtualQuoteReservesRaw, 5_000_000n);
assert.equal(snapshot.effectiveQuoteReservesRaw, 25_000_000n);
assert.equal(snapshot.observedSlot, 123n);
```

Rejeter un owner, mint ou token program incohérent, des slots différents, une
réserve virtuelle hors plage et une réserve effective `<= 0n`.

- [ ] **Step 2: Vérifier l'échec**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap reserves'
```

Expected: FAIL.

- [ ] **Step 3: Implémenter le lecteur RPC passif**

Utiliser `Connection.getMultipleAccountsInfoAndContext` avec un commitment
injecté. Convertir immédiatement lamports et slot en `bigint`. La méthode
retourne tous les comptes avec le même `context.slot` ou échoue :

```typescript
const response = await connection.getMultipleAccountsInfoAndContext(keys, {
  commitment,
});
return response.value.map((account, index) =>
  snapshotAccount(keys[index], account, BigInt(response.context.slot)));
```

Ce module n'expose aucune méthode d'écriture.

- [ ] **Step 4: Implémenter le calcul effectif**

Décoder les vaults avec `AccountLayout` ou les helpers SPL read-only, puis :

```typescript
const effectiveQuoteReservesRaw =
  quoteVaultAmountRaw + pool.virtualQuoteReservesRaw;
if (effectiveQuoteReservesRaw <= 0n) {
  throw new InvalidEffectiveQuoteReserveError(effectiveQuoteReservesRaw);
}
```

Valider les adresses des vaults et leurs mints contre le pool canonique avant
le calcul.

- [ ] **Step 5: Vérifier**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap reserves'
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/solana/rpc/market-rpc-reader.ts src/markets/pumpswap/pumpswap-reserve-reader.ts src/markets/pumpswap/errors.ts tests/pumpswap-reserve-reader.test.ts
git commit -m "feat: read effective PumpSwap reserves"
```

## Task 10: Produire des cotations officielles en `bigint`

**Files:**

- Create: `src/markets/pumpswap/pumpswap-fee-state.ts`
- Create: `src/markets/pumpswap/pumpswap-quote.provider.ts`
- Modify: `src/markets/pumpswap/errors.ts`
- Create: `tests/pumpswap-quote.provider.test.ts`

- [ ] **Step 1: Écrire les tests de conformité entière**

Créer des fixtures de `GlobalConfig`, `FeeConfig`, `Pool`, mint et réserves
décodées depuis le SDK officiel. Pour plusieurs tailles et fee tiers, comparer
les sorties brutes à `buyQuoteInput` et `sellBaseInput` du SDK avec
`slippage=0`, puis calculer le minimum local avec `slippageBps: bigint`.

Exiger :

```typescript
assert.equal(typeof quote.amountOutRaw, 'bigint');
assert.equal(typeof quote.feesRaw, 'bigint');
assert.equal(typeof quote.priceImpactBps, 'bigint');
assert.equal(
  quote.minimumAmountOutRaw,
  quote.amountOutRaw * (10_000n - slippageBps) / 10_000n,
);
```

Les tests couvrent zéro, bornes, arrondis, fee tier dynamique, quote inconnue,
configuration absente, vraie liquidité insuffisante à la vente et
déterminisme. Ils vérifient aussi qu'une extension Token-2022 affectant les
transferts bloque la quote au lieu de produire un montant incomplet.

- [ ] **Step 2: Vérifier l'échec**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap quote'
```

Expected: FAIL.

- [ ] **Step 3: Décoder l'état de frais officiel**

`pumpswap-fee-state.ts` utilise :

```typescript
PUMP_AMM_SDK.decodeGlobalConfig(globalConfigAccount);
PUMP_AMM_SDK.decodeFeeConfig(feeConfigAccount);
```

Il convertit immédiatement les `BN` et `PublicKey` vers :

```typescript
export interface PumpSwapFeeState {
  readonly lpFeeBps: bigint;
  readonly protocolFeeBps: bigint;
  readonly creatorFeeBps: bigint;
  readonly creatorFeeEnabled: boolean;
  readonly baseMintSupplyRaw: bigint;
  readonly tiers: readonly {
    readonly marketCapThresholdRaw: bigint;
    readonly lpFeeBps: bigint;
    readonly protocolFeeBps: bigint;
    readonly creatorFeeBps: bigint;
  }[];
  readonly observedSlot: bigint;
}
```

`creatorFeeEnabled` vaut `false` uniquement lorsque `Pool.coinCreator` est la
clé publique nulle officielle. Dans ce cas le calcul applique
`creatorFeeBps = 0n`, conformément au SDK.

Le lecteur est explicite et passif :

```typescript
export class PumpSwapFeeStateReader {
  public constructor(private readonly rpc: MarketRpcReader) {}

  public async read(pool: CanonicalMarketPool): Promise<PumpSwapFeeState> {
    return decodePumpSwapFeeState(
      await this.rpc.readAccountsAtSameSlot([
        GLOBAL_CONFIG_PDA.toBase58(),
        PUMP_AMM_FEE_CONFIG_PDA.toBase58(),
        pool.baseMint,
        pool.address,
      ]),
      pool,
    );
  }
}
```

Valider tous les basis points entre `0n` et `10_000n`, l'ordre strict des
seuils et le slot commun des comptes. Une absence de fee config ne retombe sur
la configuration globale que si le compte officiel est réellement absent et
que cette sémantique est confirmée par l'IDL/SDK épinglé.

Pour un pool migré canonique, sélectionner le fee tier officiel avec :

```typescript
const marketCapRaw =
  baseMintSupplyRaw * effectiveQuoteReservesRaw / baseReservesRaw;
const tier = tiers
  .filter((candidate) =>
    marketCapRaw >= candidate.marketCapThresholdRaw)
  .at(-1) ?? tiers[0];
```

Les tiers sont triés par seuil croissant après validation. Les flat fees d'un
pool créé hors Pump ne sont pas utilisées, car un tel pool ne peut pas être
activé par le matcher de migration.

- [ ] **Step 4: Implémenter les formules sans `number`**

La classe publique est déclarée avec la frontière de Task 2 :

```typescript
export class PumpSwapQuoteProvider implements PumpSwapQuotePort {
  public constructor(
    private readonly readFeeState: (
      pool: CanonicalMarketPool,
    ) => Promise<PumpSwapFeeState>,
    private readonly clock: () => number,
  ) {}

  public async quote(request: PumpSwapQuoteRequest): Promise<MarketQuote> {
    return createPumpSwapQuote(
      request,
      await this.readFeeState(request.pool),
      this.clock(),
    );
  }
}
```

`createPumpSwapQuote` est une fonction pure définie dans le même fichier. Pour
l'achat quote exact :

```typescript
const totalFeeBps = lpFeeBps + protocolFeeBps + creatorFeeBps;
let effectiveQuoteRaw =
  amountInRaw * 10_000n / (10_000n + totalFeeBps);
const lpFeeRaw = fee(effectiveQuoteRaw, lpFeeBps);
const protocolFeeRaw = fee(effectiveQuoteRaw, protocolFeeBps);
const creatorFeeRaw = fee(effectiveQuoteRaw, creatorFeeBps);
const feesRaw = lpFeeRaw + protocolFeeRaw + creatorFeeRaw;
if (effectiveQuoteRaw + feesRaw > amountInRaw) {
  effectiveQuoteRaw -= effectiveQuoteRaw + feesRaw - amountInRaw;
}
const amountOutRaw =
  baseReserveRaw * (effectiveQuoteRaw - 1n)
  / (effectiveQuoteReserveRaw + effectiveQuoteRaw - 1n);
```

Pour la vente base exacte :

```typescript
const grossQuoteRaw =
  effectiveQuoteReserveRaw * amountInRaw
  / (baseReserveRaw + amountInRaw);
const lpFeeRaw = fee(grossQuoteRaw, lpFeeBps);
const protocolFeeRaw = fee(grossQuoteRaw, protocolFeeBps);
const creatorFeeRaw = fee(grossQuoteRaw, creatorFeeBps);
const feesRaw = lpFeeRaw + protocolFeeRaw + creatorFeeRaw;
const amountOutRaw = grossQuoteRaw - feesRaw;
if (quoteVaultAmountRaw < grossQuoteRaw - lpFeeRaw) {
  throw new SellQuoteUnavailableError(pool.address);
}
```

`fee` utilise l'arrondi officiel `floor`. `minimumAmountOutRaw` utilise
`floor(amountOut * (10_000 - slippageBps) / 10_000)`.

L'impact compare la sortie effective, frais inclus, au prix spot pré-trade sans
matérialiser de fraction :

```typescript
const spotNumerator = inputIsQuote
  ? amountInRaw * baseReserveRaw
  : amountInRaw * effectiveQuoteReserveRaw;
const spotDenominator = inputIsQuote
  ? effectiveQuoteReserveRaw
  : baseReserveRaw;
const lostNumeratorCandidate =
  spotNumerator - amountOutRaw * spotDenominator;
const lostNumerator =
  lostNumeratorCandidate > 0n ? lostNumeratorCandidate : 0n;
const priceImpactBps = ceilDiv(
  lostNumerator * 10_000n,
  spotNumerator,
);
```

`ceilDiv` exige un numérateur non négatif et un dénominateur strictement
positif. Le résultat est borné à `10_000n`.

- [ ] **Step 5: Vérifier la conformité**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap quote'
npm run check
npm run lint
```

Expected: PASS pour toutes les fixtures de conformité au SDK.

- [ ] **Step 6: Commit**

```bash
git add src/markets/pumpswap/pumpswap-fee-state.ts src/markets/pumpswap/pumpswap-quote.provider.ts src/markets/pumpswap/errors.ts tests/pumpswap-quote.provider.test.ts
git commit -m "feat: quote PumpSwap trades with bigint math"
```

## Task 11: Implémenter `PumpSwapMarketAdapter`

**Files:**

- Create: `src/markets/pumpswap/pumpswap-market.adapter.ts`
- Create: `src/paper/market-paper-quote.ts`
- Modify: `src/ports/market-adapter.ts`
- Modify: `src/domain/market.ts`
- Create: `tests/pumpswap-market-adapter.test.ts`
- Create: `tests/market-paper-quote.test.ts`

- [ ] **Step 1: Écrire les tests du port complet**

Avec lecteurs injectés, vérifier :

- `detectPools` ne retourne que les créations canoniques prouvées ;
- `decodeTrades` ignore les pools non suivis ;
- BUY/SELL conservent quote asset, curseur et confirmation ;
- `readReserves` délègue au lecteur cohérent ;
- `quote` accepte base ou quote mint et refuse un autre mint ;
- aucun appel réseau n'est caché dans le domaine.

Exemple :

```typescript
const adapter: MarketAdapter<SolanaObservedTransaction> =
  new PumpSwapMarketAdapter(
  transactionDecoder,
  poolValidator,
  reserveReader,
  quoteProvider,
);
assert.equal(adapter.source, 'pumpswap');
assert.equal(adapter.programId, PUMPSWAP_PROGRAM_ID);
```

La classe implémente explicitement
`MarketAdapter<SolanaObservedTransaction>` ; elle n'accède jamais à
`transaction.raw` sans avoir validé la cohérence de l'enveloppe partagée.
Elle expose en plus, pour le pipeline PumpSwap uniquement :

```typescript
public decodeEvidence(
  transaction: SolanaObservedTransaction,
): Promise<DecodedPumpSwapTransaction>;
```

Un `WeakMap<SolanaObservedTransaction, Promise<DecodedPumpSwapTransaction>>`
garantit que `decodeEvidence`, `detectPools` et `decodeTrades` partagent le même
décodage sans refaire ou diverger.

- [ ] **Step 2: Vérifier l'échec**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap market adapter'
```

Expected: FAIL.

- [ ] **Step 3: Implémenter l'adaptateur**

Le constructeur n'accepte que des dépendances passives. Implémenter la requête
`MarketQuoteRequest` définie en Task 2. Adapter seulement les
implémentations/tests qui implémentent réellement ce port ; ne pas modifier le
comportement Raydium legacy.

L'adaptateur compose lecture et calcul sans les confondre :

```typescript
public async quote(request: MarketQuoteRequest): Promise<MarketQuote> {
  const reserves = await this.readReserves(request.pool);
  return this.quoteProvider.quote({
    ...request,
    reserves,
  });
}
```

Chaque trade reçoit un ID via `createDeterministicChainEventId` ou une factory
de même canonicalisation, incluant programme, signature et curseur complet.

- [ ] **Step 4: Ajouter la frontière vers le paper trading**

Créer une conversion sans recalcul :

```typescript
export function toPaperExecutionQuote(
  quote: MarketQuote,
): PaperExecutionQuote {
  return Object.freeze({
    id: quote.id,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    amountInRaw: quote.amountInRaw,
    amountOutRaw: quote.amountOutRaw,
    minimumAmountOutRaw: quote.minimumAmountOutRaw,
    feesRaw: quote.feesRaw,
    slippageBps: quote.slippageBps,
    priceImpactBps: quote.priceImpactBps,
    observedAtMs: quote.observedAtMs,
    observedSlot: quote.observedSlot,
  });
}
```

Le test appelle `validatePaperQuote` sur le résultat et vérifie qu'aucun champ
financier n'est converti.

- [ ] **Step 5: Vérifier**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap market adapter|market paper quote|market port|domain contracts'
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/markets/pumpswap/pumpswap-market.adapter.ts src/paper/market-paper-quote.ts src/ports/market-adapter.ts src/domain/market.ts tests/pumpswap-market-adapter.test.ts tests/market-paper-quote.test.ts
git commit -m "feat: add passive PumpSwap market adapter"
```

## Task 12: Assembler un pipeline invocable sans prétendre activer le runtime

**Files:**

- Create: `src/application/pumpswap-observation-pipeline.ts`
- Modify: `src/app.ts`
- Modify: `src/application/market-observation.service.ts`
- Modify: `docs/architecture/pumpfun-v1.md`
- Modify: `docs/api/v1.md`
- Create: `tests/pumpswap-safety.test.ts`
- Create: `tests/pumpswap-observation-pipeline.test.ts`
- Modify: `tests/bootstrap-safety.test.ts`

- [ ] **Step 1: Écrire les tests de sécurité et de bootstrap**

Scanner `src/markets/pumpswap`, `src/application/market-observation.service.ts`
et leurs imports directs :

```typescript
for (const forbidden of [
  /Keypair/u,
  /Wallet/u,
  /sendTransaction/u,
  /sendRawTransaction/u,
  /TransactionBuilder/u,
  /signTransaction/u,
]) {
  assert.doesNotMatch(source, forbidden);
}
```

Le bootstrap en mode `observe` doit réussir sans variable de clé privée.
Vérifier aussi que `EXECUTION_MODE` reste limité à `observe|paper`.

- [ ] **Step 2: Écrire le test d'intégration du pipeline**

Injecter un `NormalizedTransaction` contenant migration et création PumpSwap,
un lecteur de comptes déterministe et un repository en mémoire. Exiger :

```typescript
const result = await pipeline.observe(transaction);
assert.equal(result.migrations.length, 1);
assert.equal(result.activations.length, 1);
assert.equal(result.activations[0]?.payload.pool.index, 0);
assert.equal(repository.recordedBatches.length, 1);
```

Ajouter le cas d'une transaction sans Pump/PumpSwap : résultat vide et aucune
écriture.

- [ ] **Step 3: Vérifier les tests avant assemblage**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap safety|PumpSwap observation pipeline|bootstrap safety'
```

Expected: le test du pipeline échoue car son module n'existe pas encore ; les
tests de sécurité du bootstrap actuel restent verts.

- [ ] **Step 4: Assembler uniquement l'observation**

Créer une factory qui reçoit les dépendances déjà construites et expose une
seule méthode `observe(transaction)` :

```typescript
export class PumpSwapObservationPipeline {
  public constructor(
    private readonly pump: PumpFunLaunchpadAdapter,
    private readonly market: PumpSwapMarketAdapter,
    private readonly service: MarketObservationService,
    private readonly clock: () => number,
  ) {}

  public async observe(
    transaction: NormalizedTransaction,
  ): Promise<MarketObservationResult> {
    const observed = createSolanaObservedTransaction(
      transaction,
      this.clock(),
    );
    if (!invokesPumpOrPumpSwap(transaction)) {
      return EMPTY_MARKET_OBSERVATION_RESULT;
    }

    const [activePools, migrations, evidence, detectedPools] =
      await Promise.all([
        this.service.loadActivePools(),
        this.pump.decodeMigrations(observed),
        this.market.decodeEvidence(observed),
        this.market.detectPools(observed),
      ]);
    const detectedByAddress = indexPools(detectedPools);
    const matches = matchPumpSwapMigrations(
      observed,
      migrations,
      evidence,
      detectedByAddress,
    );
    const trackedPools = mergeTrackedPools(
      activePools,
      matches.flatMap((match) =>
        match.activationEvent === null
          ? []
          : [match.activationEvent.payload.pool]),
    );
    const trades = await this.market.decodeTrades(observed, trackedPools);
    const poolsToSnapshot = poolsChangedBy(matches, trades, trackedPools);
    const reserveSnapshots = await Promise.all(
      poolsToSnapshot.map((pool) => this.market.readReserves(pool)),
    );
    return this.service.record(observed, {
      matches,
      reserveSnapshots,
      trades,
    });
  }
}
```

Le pipeline retourne immédiatement un résultat vide si la transaction
n'invoque ni Pump ni PumpSwap. `indexPools`, `mergeTrackedPools` et
`poolsChangedBy` sont des fonctions pures dans le même fichier : elles
dédupliquent par adresse, refusent deux définitions contradictoires et ne lisent
les réserves que pour un pool activé ou échangé dans cette transaction. Le
pipeline ne crée aucune souscription, n'appelle pas le paper engine
automatiquement et ne modifie pas Raydium.

- [ ] **Step 5: Garder le bootstrap honnête**

Ne pas instancier le pipeline dans `main()` tant qu'aucun runtime de listener
ne lui fournit de transactions normalisées. Mettre à jour le log structuré :

```typescript
{
  pumpFunListenerActive: false,
  pumpSwapPipelineAvailable: true,
  transactionSubmissionEnabled: false,
}
```

Le message doit préciser que le pipeline est disponible mais non abonné. Ce
changement évite toute fausse déclaration de suivi actif.

- [ ] **Step 6: Documenter le comportement exact**

Mettre à jour l'architecture :

```text
Pump migration observed
  -> canonical PumpSwap proof
  -> PUMPSWAP_ACTIVE
  -> passive reserves/trades/quotes
```

Documenter que l'API/runtime PR H branchera ce pipeline et exposera ses
projections, que le listener ne garantit ni même slot, ni sellabilité, ni
profit, et que les quotes sont des estimations paper issues d'un snapshot.
Le décodage reste multi-quote, tandis que l'allowlist paper de la PR F reste
SOL/WSOL en V1.

- [ ] **Step 7: Exécuter la vérification ciblée**

Run:

```bash
npm test -- --test-name-pattern='PumpSwap|Pump migration|market observation|bootstrap safety'
```

Expected: PASS.

- [ ] **Step 8: Exécuter la vérification complète**

Run:

```bash
npm run build
npm run check
npm run lint
npm test
git diff --check
git status --short
```

Expected:

- build, check, lint et tous les tests PASS ;
- génération Pump et PumpSwap à jour ;
- aucun whitespace error ;
- uniquement les changements PR G attendus dans le worktree.

- [ ] **Step 9: Vérifier les migrations sur base vide**

Avec une base de test jetable explicitement dédiée :

```bash
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate
```

Expected: première exécution applique `001` à `005`, seconde exécution propre
et sans changement.

- [ ] **Step 10: Commit final**

```bash
git add src/app.ts src/application/market-observation.service.ts src/application/pumpswap-observation-pipeline.ts docs/architecture/pumpfun-v1.md docs/api/v1.md tests/pumpswap-safety.test.ts tests/pumpswap-observation-pipeline.test.ts tests/bootstrap-safety.test.ts
git commit -m "feat: observe PumpSwap after graduation"
```

## Revue avant publication

- [ ] Vérifier que chaque exigence de
  `docs/superpowers/specs/2026-07-29-pr-g-pumpswap-migration-design.md` est
  couverte par au moins un test.
- [ ] Vérifier qu'aucun fichier Raydium CPMM n'a été supprimé.
- [ ] Vérifier que le domaine n'importe ni Pump.fun, ni PumpSwap, ni Raydium.
- [ ] Vérifier que PumpSwap n'importe pas Pump.fun.
- [ ] Vérifier que tout montant, réserve, frais, slippage et basis point est un
  `bigint`.
- [ ] Vérifier que le SDK officiel est épinglé et confiné au dossier PumpSwap.
- [ ] Vérifier que les événements dupliqués sont idempotents et que les
  orphaned rétractent toutes les projections dépendantes.
- [ ] Vérifier que la rétention est de quatre heures après état terminal.
- [ ] Demander une revue de code avant push.
- [ ] Pousser la branche, ouvrir la PR G, attendre les checks et commentaires,
  corriger les blocages puis fusionner uniquement avec tous les checks verts.
