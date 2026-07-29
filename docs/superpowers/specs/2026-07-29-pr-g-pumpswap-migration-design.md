# PR G — Graduation Pump.fun et suivi PumpSwap V1

## Objectif

Détecter la graduation d'une bonding curve Pump.fun, prouver la migration,
activer le pool PumpSwap canonique puis fournir les réserves, swaps et
cotations passives nécessaires à la poursuite du paper trading.

La PR conserve Pump.fun comme launchpad principal, PumpSwap comme marché
post-migration principal et Raydium CPMM comme adaptateur secondaire. Le
domaine ne dépend directement d'aucun de ces protocoles.

## Périmètre

La PR ajoute :

- le décodage de `migrate` et `migrate_v2`, instructions externes ou internes ;
- l'événement métier `MigrationObserved` ;
- la validation du `create_pool` PumpSwap associé ;
- l'événement métier `PumpSwapPoolActivated` ;
- la persistance des migrations, pools, réserves et swaps de marché ;
- un `PumpSwapMarketAdapter` en lecture seule ;
- la lecture des réserves effectives, y compris les réserves virtuelles ;
- le décodage des achats et ventes PumpSwap ;
- des cotations BUY et SELL passives, compatibles avec le paper trading ;
- la réconciliation de finalité, l'idempotence et la reprise après arrêt ;
- le support des quote mints explicitement encodés par `migrate_v2`, avec
  WSOL pour la migration historique ;
- le support SPL Token et Token-2022 selon les comptes réellement fournis.

La PR n'ajoute pas :

- de wallet, clé privée ou signer ;
- de construction, signature, simulation ou envoi de transaction ;
- d'exécution réelle ou de nouveau mode d'exécution ;
- d'inférence de migration à partir des seuls soldes ;
- d'historique antérieur à l'arrivée du token dans le listener ;
- de stratégie paper supplémentaire ;
- d'API front-end, réservée à la PR H ;
- d'analyse avancée du créateur ou des clusters, réservée à la PR I.

## Sources officielles et reproductibilité

Le décodage est généré depuis le dépôt officiel
[`pump-fun/pump-public-docs`](https://github.com/pump-fun/pump-public-docs)
à la révision :

```text
9c82f61cb711b044a17f770ab8ce9f9bdf78f333
```

Les fichiers officiels épinglés sont vérifiés avant génération :

```text
idl/pump.json
sha256 b90bc471327f671449271d5d1d42354d1fae6f5a06502f5834459a3108138e49

idl/pump_amm.json
sha256 6b5c7ec4e5ef9742fa99dc57b0d75b1031b379bba02a7e1b3c5a4cad68d77e56
```

Programmes attendus :

```text
Pump.fun  6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
PumpSwap  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
```

Les discriminators ne sont pas copiés depuis un projet tiers. Les tests
vérifient notamment les instructions officielles suivantes :

- `migrate` : `[155, 234, 231, 146, 236, 158, 162, 30]` ;
- `migrate_v2` : `[187, 203, 18, 31, 206, 237, 254, 41]` ;
- `create_pool`, `buy`, `buy_exact_quote_in` et `sell` PumpSwap depuis l'IDL
  Pump AMM épinglé.

L'IDL publique épinglée est l'autorité de décodage. L'IDL embarquée dans
`@pump-fun/pump-swap-sdk@1.19.0` ne contient pas encore le champ append-only
`base_supply` des événements `BuyEvent` et `SellEvent` présents dans l'IDL
publique. Elle ne doit donc pas être utilisée pour décoder ces événements.

Le générateur échoue si une révision, une somme, un programme, une instruction,
un compte ou un type requis diverge.

## Architecture

### PumpFunLaunchpadAdapter

L'adaptateur launchpad reste responsable du pré-marché. Il :

1. parcourt toutes les instructions externes et internes ;
2. décode `migrate` et `migrate_v2` depuis l'IDL Pump officiel ;
3. normalise le mint, le quote mint, les programmes token, la bonding curve,
   le pool annoncé et le curseur complet ;
4. produit une observation de migration indépendante de PumpSwap ;
5. ne déclare jamais le pool actif par lui-même.

La migration historique utilise WSOL comme quote mint conformément aux comptes
de `migrate`. `migrate_v2` utilise les base et quote mints explicites et ne
suppose pas que la quote est SOL.

### MigrationMatcher

Un service d'application sans accès wallet rapproche, dans une même
transaction :

- une instruction Pump.fun `migrate` ou `migrate_v2` valide ;
- l'invocation PumpSwap `create_pool` située dans son périmètre CPI ;
- les comptes base, quote, programmes token, vaults et pool ;
- le `CreatePoolEvent` Anchor correspondant.

Le rapprochement est local au groupe CPI : aucune association n'est faite avec
un événement ou des deltas globaux appartenant à une autre instruction de la
transaction.

Le service persiste d'abord `MigrationObserved`. Il ne produit
`PumpSwapPoolActivated` que lorsque toutes les preuves concordent. Une
migration valide sans preuve d'activation reste en `MIGRATION_PENDING` et peut
être complétée par un replay enrichi, sans déduire l'activation des soldes.

### PumpSwapPoolValidator

Le validateur contrôle :

- le propriétaire PumpSwap et le discriminator du compte pool ;
- l'index canonique `0` ;
- l'adresse PDA canonique dérivée de `pool`, de l'index `u16`, du créateur de
  pool, du base mint et du quote mint ;
- les base et quote mints ;
- les base et quote vaults ;
- le LP mint et la LP supply lorsqu'ils sont disponibles ;
- les programmes SPL Token ou Token-2022 de chaque mint ;
- la cohérence entre instruction, événement, compte pool et migration.

La lecture tolère uniquement des champs ajoutés en fin de compte. Elle refuse
un layout tronqué, un discriminator inconnu ou toute divergence sur les champs
connus. Un pool non canonique peut être observé comme donnée brute, mais ne
peut pas activer le suivi canonique du token.

### PumpSwapMarketAdapter

`PumpSwapMarketAdapter` implémente le port générique `MarketAdapter`. Il dépend
de ports RPC en lecture seule et de décodeurs PumpSwap, jamais du domaine
Pump.fun.

Il fournit :

- `detectPools` pour les créations PumpSwap validables ;
- `decodeTrades` pour les achats et ventes des pools suivis ;
- `readReserves` pour un snapshot cohérent à un slot donné ;
- `quote` pour une cotation passive sur les deux directions.

Raydium CPMM reste une autre implémentation de `MarketAdapter`. Aucun code
Raydium n'est supprimé ou redirigé vers PumpSwap.

### PumpSwapQuoteProvider

La formule de cotation et les frais sont isolés derrière un port
`PumpSwapQuoteProvider`. Son implémentation utilise l'état de frais on-chain ou
les méthodes officielles du SDK PumpSwap épinglé. Les règles de frais ne sont
pas codées en dur dans le domaine ou l'adaptateur.

Si le SDK officiel est nécessaire, il est épinglé exactement et encapsulé dans
ce provider. Ses types `BN` et ses types Anchor ne franchissent pas la
frontière d'infrastructure. Le provider ne reçoit ni wallet ni signer et
n'expose aucune méthode de construction ou d'envoi.

Une cotation qui ne peut pas prouver ses paramètres de frais échoue avec une
erreur typée ; elle ne réutilise pas une valeur par défaut silencieuse.

## Dépendances autorisées

```text
domain
  dépend de rien dans launchpads/, markets/, infrastructure/ ou legacy/

ports
  dépend seulement du domaine

launchpads/pumpfun
  dépend du domaine, des ports et des artefacts IDL Pump générés

markets/pumpswap
  dépend du domaine, des ports, du RPC read-only et des artefacts IDL Pump AMM

application/migrations
  orchestre LaunchpadAdapter, MarketAdapter et repositories par leurs ports

infrastructure/postgres
  implémente les ports de persistance

legacy/raydium
  reste un adaptateur secondaire sans dépendance vers Pump.fun ou PumpSwap
```

Toute dépendance `markets/pumpswap -> launchpads/pumpfun` ou
`domain -> markets/pumpswap` est interdite.

## Contrats métier

### MigrationObserved V1

Le payload contient au minimum :

```text
version: 1
instruction: MIGRATE | MIGRATE_V2
bondingCurve: string
pool: string
baseMint: string
quoteAsset:
  mint: string
  decimals: integer
  tokenProgram: SPL_TOKEN | TOKEN_2022
baseTokenProgram: SPL_TOKEN | TOKEN_2022
```

L'enveloppe commune apporte l'identifiant déterministe, le programme Pump, la
signature, le slot, les index transaction/instruction/interne, la finalité et
les dates.

### PumpSwapPoolActivated V1

Le payload contient au minimum :

```text
version: 1
migrationEventId: string
pool: string
poolIndex: 0
poolCreator: string
baseMint: string
quoteAsset: QuoteAsset
baseVault: string
quoteVault: string
lpMint: string
baseTokenProgram: SPL_TOKEN | TOKEN_2022
quoteTokenProgram: SPL_TOKEN | TOKEN_2022
```

Son identité on-chain utilise le curseur de l'instruction `create_pool`
PumpSwap, pas celui de l'instruction Pump qui l'a déclenchée. Le lien
`migrationEventId` conserve la causalité.

### MarketPool

Le contrat générique est enrichi uniquement avec les données réellement
nécessaires à la lecture sûre des réserves : programmes token, vaults, index et
créateur. Les données spécifiques facultatives restent dans une projection
PumpSwap versionnée, sans union dépendante du protocole dans le moteur paper.

### MarketTrade

Un trade PumpSwap contient :

- un identifiant déterministe ;
- le pool ;
- le sens `BUY` ou `SELL` vu depuis le token lancé ;
- le trader lorsqu'il est observable ;
- les montants base et quote bruts en `bigint` ;
- le quote asset ;
- le curseur complet et le statut de confirmation.

`BuyEvent` et `SellEvent` sont rapprochés de leur instruction dans le même
périmètre CPI. Le décodeur valide le pool, le trader, les mints, la direction
et les montants. Un événement orphelin ou ambigu n'est pas projeté. Les deltas
globaux d'une transaction ne sont jamais réappliqués pour chaque instruction.

## Réserves et calculs

Le compte Pool PumpSwap officiel expose notamment :

- `index: u16` ;
- `base_mint` et `quote_mint` ;
- les vaults base et quote ;
- `lp_supply: u64` ;
- `is_mayhem` et `is_cashback` ;
- `virtual_quote_reserves: i128`.

Tous les montants restent des `bigint`. Pour un snapshot cohérent :

```text
baseReservesRaw = baseVaultAmountRaw
effectiveQuoteReservesRaw =
  quoteVaultAmountRaw + virtualQuoteReservesRaw
```

La conversion `i128` est signée. Une valeur hors plage, un résultat négatif ou
nul, des comptes lus à des slots incompatibles ou un mint inattendu font
échouer le snapshot. Aucune conversion en `number` n'est autorisée pour les
réserves, montants, frais, slippage, impact prix ou basis points.

Les cotations :

- acceptent soit le base mint soit le quote mint comme entrée ;
- refusent tout autre mint ;
- lisent un snapshot et une configuration de frais identifiables ;
- exposent `amountOutRaw`, `minimumAmountOutRaw`, frais, impact et slot ;
- documentent et testent chaque arrondi ;
- restent déterministes pour des entrées et un snapshot identiques.

## Persistance PostgreSQL

La migration `005` est additive, rejouable sur base vide et sans perte des
données existantes. Elle crée :

### migrations

- identité déterministe de la migration ;
- mint, bonding curve, pool annoncé et quote asset ;
- type `MIGRATE` ou `MIGRATE_V2` ;
- événement déclencheur et curseur complet ;
- statut de confirmation ;
- preuve versionnée ;
- dates d'observation, blockchain et purge.

### market_pools

- adresse et marché ;
- programme, index, créateur ;
- base/quote mints et programmes token ;
- vaults et LP mint ;
- événement de migration et événement d'activation ;
- statut de confirmation et état actif/rétracté ;
- curseur d'activation ;
- données spécifiques versionnées ;
- dates et purge.

Une contrainte garantit un seul pool PumpSwap canonique actif par base mint et
quote mint. Un conflit ne remplace jamais silencieusement le pool existant.

### market_reserve_snapshots

- pool et slot ;
- réserves base, quote vault, quote virtuelles et quote effectives ;
- statut de confirmation ;
- payload versionné et dates.

Les colonnes financières utilisent `NUMERIC(78,0)`.

### market_trades

- identité déterministe ;
- pool, mint, quote mint et trader ;
- sens et montants bruts ;
- curseur complet et statut de confirmation ;
- payload versionné et dates.

Les données RPC et événements Anchor bruts restent dans `raw_chain_events`.
Les événements métier restent dans `domain_events`. Les projections ne
remplacent jamais les preuves brutes.

Les entités restent conservées tant que le token est suivi. Après un état
terminal, `purge_after` vaut la date terminale plus quatre heures. La purge
respecte l'ordre des clés étrangères et ne supprime pas silencieusement une
projection encore active.

## Transactions, ordre et idempotence

Pour une transaction contenant migration et création du pool, une transaction
PostgreSQL unique persiste dans cet ordre :

1. événement brut ;
2. `MigrationObserved` et projection `migrations` ;
3. transition vers `MIGRATION_PENDING` ;
4. preuve PumpSwap validée ;
5. `PumpSwapPoolActivated` et projection `market_pools` ;
6. transition vers `PUMPSWAP_ACTIVE` ;
7. snapshots ou trades observés dans le même flux, ordonnés par curseur.

Les identifiants sont dérivés du type, du mint, de la source, du programme, de
la signature et du curseur complet. Deux instructions Pump ou PumpSwap dans la
même transaction conservent donc des identités distinctes.

Un replay identique est sans effet. Un replay enrichi peut uniquement faire
progresser la confirmation ou compléter une preuve compatible. Un payload
contradictoire échoue et annule la transaction PostgreSQL.

## États et finalité

Le chemin nominal est :

```text
BONDING_CURVE_COMPLETE
  -> MIGRATION_PENDING
  -> PUMPSWAP_ACTIVE
```

Une migration peut aussi être observée pendant `OBSERVING` lorsque la
complétion de courbe n'a pas encore été projetée localement. Dans ce cas, la
preuve de migration permet la transition vers `MIGRATION_PENDING`, mais aucune
transition intermédiaire fictive n'est créée.

Chaque transition conserve l'ancien état, le nouvel état, l'événement
déclencheur, la date, le message humain et les preuves. Les transitions sont
insérées dans la même transaction que l'événement et sa projection.

Réconciliation :

- `processed -> confirmed -> finalized` enrichit les mêmes lignes ;
- une première observation `orphaned` est conservée comme preuve brute mais ne
  crée aucune projection active ;
- `processed` ou `confirmed -> orphaned` rétracte atomiquement la migration, le
  pool, ses projections dépendantes et les transitions correspondantes ;
- `finalized -> orphaned` est un conflit de finalité explicite ;
- la reprise utilise les checkpoints existants et rejoue idempotemment.

La rétractation marque les lignes comme rétractées ; elle ne détruit pas
immédiatement la preuve. Les positions paper dépendantes sont traitées selon
les règles de rétractation déjà définies par la PR F.

## Erreurs typées

Les erreurs stables couvrent au minimum :

- instruction ou événement Pump/PumpSwap non supporté ;
- événement Anchor manquant, orphelin ou ambigu ;
- pool non canonique ;
- adresse PDA ou index incohérent ;
- base mint, quote mint, vault ou programme token incohérent ;
- compte pool tronqué ou discriminator inconnu ;
- extension Token-2022 non supportée ;
- réserve virtuelle hors plage ;
- réserve effective non positive ;
- lecture RPC incohérente entre slots ;
- configuration de frais indisponible ;
- quote mint ou input mint non supporté ;
- replay contradictoire ;
- conflit de finalité.

Une erreur de décodage locale n'interrompt pas les autres instructions de la
transaction. Elle est journalisée de façon structurée avec signature, curseur,
programme et code stable, sans secret.

## Tests

### Génération et contrats

- révision et sommes SHA-256 des deux IDL officielles ;
- programmes et discriminators attendus ;
- génération reproductible sans diff ;
- TypeScript strict, ESM et absence de `any` injustifié.

### Migration

- `migrate` historique avec WSOL ;
- `migrate_v2` avec quote mint distinct de WSOL ;
- SPL Token et Token-2022 ;
- instructions externes, internes et multiples dans une transaction ;
- migration et création de pool dans la même transaction ;
- maintien en attente lorsque la preuve PumpSwap est absente ;
- rejet des associations CPI ambiguës.

### Pool et réserves

- pool canonique index `0` ;
- rejet d'un PDA, index, mint, vault ou programme incohérent ;
- compte avec champs append-only inconnus ;
- quote virtuelle positive, nulle et négative ;
- dépassement `i128` et réserve effective non positive ;
- cohérence du slot des comptes.

### Swaps et cotations

- BUY et SELL PumpSwap ;
- événements externes/internes et plusieurs swaps par transaction ;
- Token-2022 et multi-quote ;
- absence de double comptage des deltas ;
- événement orphelin ou ambigu non projeté ;
- cotations déterministes sans float ;
- arrondis, slippage et impact en `bigint` ;
- frais lus on-chain ou par méthode officielle ;
- indisponibilité des frais sans valeur silencieuse.

### Persistance et finalité

- migration `005` sur base vide et après `004` ;
- écriture atomique migration, activation et transitions ;
- replay identique et concurrence ;
- progression de confirmation ;
- rétractation `processed|confirmed -> orphaned` ;
- conflit `finalized -> orphaned` ;
- reprise par checkpoint ;
- rétention quatre heures après état terminal.

### Sécurité

Une vérification statique et les tests garantissent que le flux PumpSwap
n'importe ou n'appelle aucun wallet, signer, transaction builder,
`sendTransaction`, `sendRawTransaction` ou méthode équivalente.

## Critères d'acceptation

La PR est acceptable lorsque :

- une fixture officielle ou assainie prouve chaque variante de migration ;
- le pool PumpSwap canonique est activé uniquement avec les preuves concordantes ;
- les swaps ne sont ni perdus silencieusement ni comptés plusieurs fois ;
- les réserves effectives et cotations utilisent exclusivement des entiers ;
- le paper trading peut demander une quote BUY ou SELL après migration ;
- le flux reste strictement `observe|paper` et ne nécessite aucune clé privée ;
- Raydium CPMM et tous les tests existants restent fonctionnels ;
- `npm run build`, `npm run check`, `npm run lint` et `npm test` passent ;
- les migrations fonctionnent sur une base vide ;
- les hypothèses de protocole et la révision officielle sont documentées.
