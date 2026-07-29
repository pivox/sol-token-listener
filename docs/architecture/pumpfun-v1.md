# Architecture Pump.fun V1

## Périmètre produit

Le flux principal cible :

```text
création Pump.fun
  -> token + bonding curve
  -> métadonnées et preuves sociales publiques
  -> créateur et premiers wallets depuis la détection
  -> suivi de courbe
  -> qualification expliquée
  -> paper trading
  -> graduation
  -> pool PumpSwap canonique
```

La V1 n’analyse pas l’historique antérieur du créateur. Elle commence à
l’arrivée du token et conserve les événements nécessaires jusqu’à la fermeture
du suivi. L’observation accepte plusieurs quote mints ; le paper trading est
initialement limité à SOL/WSOL par `PAPER_QUOTE_MINT_ALLOWLIST`.

## État après PR G

La PR C épingle l’IDL officiel Pump.fun au commit
`9c82f61cb711b044a17f770ab8ce9f9bdf78f333` et décode localement `create`,
`create_v2`, `buy`, `buy_v2`, `buy_exact_sol_in`,
`buy_exact_quote_in_v2`, `sell` et `sell_v2`. Les montants réels, réserves et
frais viennent exclusivement des événements CPI `CreateEvent` et `TradeEvent`
appairés ; aucun delta global de transaction n’est utilisé comme estimation.

L’observation multi-quote est conservée (SPL Token et Token-2022), tandis que
le paper trading reste limité à SOL/WSOL par configuration. Le décodeur ne fait
aucun appel RPC à l’exécution. `PumpFunLaunchpadAdapter` est présent mais non
composé dans `src/app.ts`; il ne déclenche donc aucun abonnement, lecture RPC ou
ordre réel. Raydium CPMM demeure un adaptateur secondaire isolé et testé.

La PR G ajoute un pipeline passif et invocable :

```text
Pump migration observed
  -> preuve create_pool PumpSwap dans la même portée CPI
  -> validation du compte et du PDA canonique index 0
  -> MIGRATION_PENDING -> PUMPSWAP_ACTIVE
  -> réserves, trades et quotes paper passifs
```

`src/app.ts` ne l’abonne encore à aucun flux réseau. Le bootstrap distingue
`pumpSwapPipelineAvailable: true` de `pumpFunListenerActive: false`.
L’activation opérationnelle et l’API de ces projections relèvent de la PR H.

## Dépendances autorisées

```text
domain <- ports <- application <- adapters
                              <- interfaces HTTP/SSE

infrastructure Solana/PostgreSQL -> application
bootstrap -> composition observation-only
```

- `domain` ne dépend d’aucun programme Solana concret ;
- `ports` dépend uniquement du domaine ;
- chaque adaptateur dépend de son port et de l’infrastructure ;
- Pump.fun, PumpSwap et Raydium ne s’importent jamais entre eux ;
- aucune dépendance de signature ou d’envoi n’est accessible depuis le
  bootstrap.

## Modules cibles

| Module | Responsabilité |
| --- | --- |
| `LaunchpadAdapter` | créations, paramètres, trades pré-migration, état et fin de courbe |
| `MarketAdapter` | pool post-migration, réserves effectives, quotes et swaps |
| `MetadataProvider` | URI on-chain, JSON, médias, liens, snapshot immuable |
| `SocialVerificationProvider` | preuves publiques typées, jamais un booléen opaque |
| `CreatorProfiler` | activité observée depuis la détection et ventes précoces |
| `WalletGraphAnalyzer` | funders communs, relations, clusters et concentration |
| `QualificationEngine` | scores configurables, blockers, verdict et preuves |
| `PaperTradingEngine` | entrée/sortie simulées, frais, slippage et PnL estimé |
| API HTTP/SSE | projections publiques, versionnées et en lecture seule |

## Contrats Solana

Une transaction peut contenir plusieurs instructions Pump.fun externes et
internes. La normalisation conserve :

- signature, slot et `transactionIndex` ;
- `instructionIndex` et `innerInstructionIndex` ;
- balances token avant/après et lamports avant/après ;
- programme Token SPL ou Token-2022 ;
- statut `processed`, `confirmed`, `finalized` ou `orphaned`.

Un identifiant déterministe inclut la source, le programme, la signature et le
curseur complet. Les deltas globaux d’une transaction ne devront être agrégés
qu’une fois par marché/courbe.

Les montants financiers restent entiers. PumpSwap calcule :

```text
effectiveQuoteReserves = quoteVaultAmount + virtualQuoteReserves
```

Le quote mint est toujours une valeur de domaine (`mint`, `decimals`,
`tokenProgram`), jamais une hypothèse globale SOL.

Le décodage de graduation reste multi-quote ; l’allowlist paper V1 reste
SOL/WSOL. `PUMPSWAP_ACTIVE` exige la concordance de `create_pool`, de
`CreatePoolEvent`, du compte pool, de ses vaults, des programmes token et du
PDA canonique. Les frais viennent des comptes officiels ; réserves, frais,
slippage et impact sont calculés en `bigint`. Une quote est une estimation
issue d’un snapshot, pas une garantie de sellabilité.

## Source officielle et décodeur Pump.fun

Vérification effectuée le 28 juillet 2026. La documentation publique officielle
indique une interface multi-quote avec `buy_v2`, `sell_v2` et
`buy_exact_quote_in_v2`, tout en maintenant les anciennes instructions. Elle
documente également `migrate` comme migration permissionless et idempotente
vers PumpSwap.

La source épinglée est
[pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs),
commit `9c82f61cb711b044a17f770ab8ce9f9bdf78f333`. Les discriminators et schémas
sont générés depuis cet IDL, jamais copiés depuis un projet tiers. Les fixtures
normalisées publiques couvrent une création avec achat initial, une vente CPI
et un achat V2 CPI ; elles se rejouent hors ligne.

## Qualification

Les trois scores sont indépendants :

- préparation du lancement : 15 ;
- authenticité sociale : 25 ;
- santé et comportement on-chain : 60.

Le jeu initial est `UNVALIDATED_RULE_SET` et tous les poids/seuils seront
configurables. `QUALIFICATION_MIN_SCORE` vaut 60 par défaut ; il est non
calibré et ne déclenche jamais à lui seul le paper trading. Les métadonnées ne
prouvent jamais le sérieux du projet.

Les conditions éliminatoires utilisent les codes stables de
`src/domain/qualification-reasons.ts`. Un blocker actif décide du rejet sans
pouvoir être compensé par le score. Chaque rapport conserve les preuves, les
valeurs de règles et leur version.

## Machine d’état et événements

Les états publics sont définis dans `src/domain/launch-status.ts`. Chaque
transition persistée contient date, événement déclencheur, ancien/nouvel état,
reason code, message humain et preuves.

## Paper trading

Le moteur Pump.fun V1 est un ledger comptable indépendant du
`TradeExecutor` Raydium historique. Il ne construit et ne simule aucune
transaction Solana et ne dépend d’aucun wallet. Il ouvre uniquement en mode
`paper`, après qualification sans blocker et pour un quote mint autorisé.

Les entrées et sorties utilisent `minimumAmountOutRaw`. Frais, slippage,
perte aller-retour et PnL restent en `bigint`. Position, trade et événement
métier sont persistés atomiquement ; les replays sont idempotents. Une
position fermée est conservée quatre heures avant purge. Une montée de finalité
enrichit l’événement paper existant. Si le déclencheur d’une ouverture ou d’une
fermeture non finalisée devient `orphaned`, la projection passe à
`PAPER_RETRACTED`, devient inactive et reste auditable pendant la même fenêtre
de rétention.

Les événements métier sont source-indépendants :

- `TokenLaunchDetected`, `TokenMetadataResolved`, `TokenMetadataFailed` ;
- `SocialEvidenceCollected`, `CreatorProfileUpdated`,
  `WalletClusterDetected` ;
- `BondingCurveTradeObserved`, `BondingCurveStateUpdated`,
  `BondingCurveCompleted` ;
- `QualificationUpdated` ;
- `PaperPositionOpened`, `PaperPositionUpdated`, `PaperPositionClosed` ;
- `MigrationObserved`, `PumpSwapPoolActivated`.

## Persistance, reprise et rétention

`raw_chain_events` garde l’entrée technique ; `domain_events`,
`token_launches`, `migrations`, `market_pools`, `market_reserve_snapshots`,
`market_trades` et `state_transitions` sont des projections métier. Les
checkpoints sont indépendants de la source.

Le traitement réclame un événement avec un lease et reste idempotent.
`raw_chain_events` est alimenté séparément : le batch du sink conserve les
événements métier et leur lien vers cette entrée d’audit, sans embarquer le
payload brut. Un événement `orphaned` vu pour la première fois ne crée aucun
état actif. Pour un événement existant, la rétraction de ses transitions
n’intervient qu’après une réconciliation réussie de `processed` ou `confirmed`
vers `orphaned`, sans effacer l’événement ni l’historique d’invalidation.
`finalized -> orphaned` et toute sortie de `orphaned` rejettent atomiquement le
batch avant rétraction.

L’identité de la transition reste stable lors des replays. Indépendamment du
résultat d’écriture de l’événement, le temps blockchain prime sur le temps
d’observation de secours et le plus petit temps gagne à source égale. La fusion
est ainsi commutative : un replay de même confirmation peut enrichir la
transition avec le temps blockchain, qu’un fallback ultérieur ne remplace
jamais. Le repository PumpSwap applique ces garanties dans une transaction
PostgreSQL, avec verrou advisory par transaction. Un orphaning non finalisé
rétracte le pool et ses projections.

Quand un lancement est terminal et qu’aucune position paper n’est ouverte,
`terminal_at` est fixé et `purge_after = terminal_at + 4 heures`. Le purgeur ne
supprime que les lignes arrivées à échéance, dans l’ordre des dépendances. Les
preuves sociales V1 sont limitées aux contenus publics ; aucune API payante X
ou Telegram n’est obligatoire.

## Invariants de sécurité

- modes possibles : `observe`, `paper` ;
- aucune clé privée ;
- aucune signature ni soumission ;
- API et dashboard en lecture seule ;
- aucune garantie de timing, sortie ou profit ;
- aucune promesse de même slot entre création, graduation et snapshot RPC ;
- simulation inverse indisponible = preuve inconnue ou blocker configuré, jamais
  affirmation de sellabilité.
