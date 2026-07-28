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

## État de la PR A

Cette PR installe les contrats, la sécurité et la persistance. Elle n’implémente
pas encore `PumpFunLaunchpadAdapter` ni `PumpSwapMarketAdapter`. Le décodeur de
swaps Raydium CPMM est conservé et testé comme infrastructure secondaire. Les
wrappers de cotation et construction Raydium incomplets sont isolés et échouent
explicitement ; ils ne sont pas importés par `src/app.ts`.

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

Les montants financiers restent entiers. PumpSwap devra calculer :

```text
effectiveQuoteReserves = quoteVaultAmount + virtualQuoteReserves
```

Le quote mint est toujours une valeur de domaine (`mint`, `decimals`,
`tokenProgram`), jamais une hypothèse globale SOL.

## Source officielle du futur décodeur

Vérification effectuée le 28 juillet 2026. La documentation publique officielle
indique une interface multi-quote avec `buy_v2`, `sell_v2` et
`buy_exact_quote_in_v2`, tout en maintenant les anciennes instructions. Elle
documente également `migrate` comme migration permissionless et idempotente
vers PumpSwap.

La PR de décodage devra :

1. épingler une révision de
   [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs) ;
2. générer/valider les discriminators depuis
   [l’IDL Pump officiel](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json) ;
3. vérifier `create`, `create_v2`, `buy`, `buy_v2`,
   `buy_exact_quote_in`, `buy_exact_quote_in_v2`, `sell`, `sell_v2` et
   `migrate` contre cette révision ;
4. utiliser le SDK officiel pour les frais dynamiques au lieu de constantes ;
5. ajouter des fixtures assainies couvrant instructions externes, CPI,
   multi-instructions et achat initial dans la transaction de création.

Aucun discriminator Pump.fun tiers n’est copié dans la PR A.

## Qualification

Les trois scores sont indépendants :

- préparation du lancement : 15 ;
- authenticité sociale : 25 ;
- santé et comportement on-chain : 60.

Le jeu initial est `UNVALIDATED_RULE_SET` et tous les poids/seuils seront
configurables. Les métadonnées ne prouvent jamais le sérieux du projet.

Les conditions éliminatoires utilisent les codes stables de
`src/domain/qualification-reasons.ts`. Un blocker actif décide du rejet sans
pouvoir être compensé par le score. Chaque rapport conserve les preuves, les
valeurs de règles et leur version.

## Machine d’état et événements

Les états publics sont définis dans `src/domain/launch-status.ts`. Chaque
transition persistée contient date, événement déclencheur, ancien/nouvel état,
reason code, message humain et preuves.

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
`token_launches` et `state_transitions` sont des projections métier. Les
checkpoints sont indépendants de la source.

Le traitement réclame un événement avec un lease et reste idempotent. Une
réconciliation ultérieure propage `finalized` ou `orphaned` sans supprimer
silencieusement la trace.

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
- simulation inverse indisponible = preuve inconnue ou blocker configuré, jamais
  affirmation de sellabilité.
