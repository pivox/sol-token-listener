# PR I1 — Profils créateur et détenteurs observés

## Décision

PR I est scindée en deux livraisons indépendantes :

- PR I1 calcule le profil du créateur et la distribution des participants
  observés depuis la détection du token ;
- PR I2 ajoutera les relations entre wallets, funders communs et clusters.

PR I1 ne consulte aucun historique antérieur à la création observée. Elle
n'ajoute aucun appel RPC et reconstruit ses projections exclusivement depuis
les lancements et trades Pump.fun déjà persistés.

## Périmètre de vérité

Une position I1 n'est pas un solde SPL certifié. Elle représente le flux net
observé sur la bonding curve :

```text
observedNetBaseRaw =
  somme(BUY.baseAmountRaw) - somme(SELL.baseAmountRaw)
```

Les transferts SPL directs, burns, airdrops et mouvements extérieurs à la
bonding curve ne sont pas suivis. Le domaine, la base, l'API et la
documentation utilisent donc les termes `observed`, `flow` et
`OBSERVED_BONDING_CURVE_TRADES`. Ils ne présentent jamais ces valeurs comme
des soldes on-chain complets.

Une position observée peut être négative. Cela constitue une preuve qu'un
wallet a vendu plus de tokens qu'il n'en a acheté dans le périmètre observé,
par exemple après un transfert externe. La valeur ne doit jamais être ramenée
artificiellement à zéro.

## Architecture

PR I1 introduit quatre unités isolées :

| Unité | Responsabilité |
| --- | --- |
| `CreatorProfiler` | calcul pur du comportement observé du créateur |
| `ObservedHolderAnalyzer` | calcul pur des positions et concentrations |
| `LaunchParticipantAnalyticsService` | validation de l'entrée et orchestration d'une reconstruction |
| `ParticipantAnalyticsRepository` | reconstruction et remplacement atomiques des projections PostgreSQL |

Le flux passif est :

```text
TokenLaunchDetected / BondingCurveTradeObserved réconcilié
  -> verrou transactionnel PostgreSQL par mint
  -> lecture canonique des trades non orphaned
  -> calcul pur et déterministe
  -> remplacement des projections courantes
  -> insertion idempotente du snapshot agrégé
  -> upsert des événements dérivés
  -> trigger outbox SSE existant
```

Le service est invocable, mais PR I1 ne le compose pas dans `src/app.ts`.
Cette limite est cohérente avec l'état après PR H : le listener RPC Pump.fun
reste inactif. Une future PR de composition appellera le service après la
réconciliation canonique du lancement ou du trade.

## Entrée canonique

La reconstruction reçoit :

- le lancement : mint, créateur, signature et curseur de création, finalité ;
- tous les trades du mint dont la finalité n'est pas `orphaned` ;
- pour chaque trade : identifiant, signature, curseur, finalité, trader, sens,
  montant base et quote asset complet ;
- l'identifiant et la finalité de l'événement qui a demandé la reconstruction.

Le repository relit ces valeurs après avoir acquis son verrou. Il ne fait
confiance à aucun agrégat fourni par l'appelant.

Les trades sont ordonnés par :

1. slot ;
2. transaction index ;
3. instruction index ;
4. inner instruction index, avec l'instruction externe avant les internes ;
5. identifiant de trade.

Cet ordre et les adresses wallet servent de départage déterministe partout.

## Profil du créateur

Le profil version 1 contient :

- mint et créateur ;
- `buyCount` et `sellCount` ;
- `totalBoughtBaseRaw` ;
- `totalSoldBaseRaw` ;
- `observedNetBaseRaw`, signé ;
- `hasSold` ;
- première vente observée : signature, curseur et montants, ou `null` ;
- achats initiaux observés dans la transaction de création ;
- flux quote regroupés par quote asset ;
- nombre d'acheteurs externes uniques connus ;
- nombre de trades dont le trader est inconnu ;
- curseur et empreinte de la reconstruction.

Un achat initial est un trade `BUY` :

- dont le trader est exactement le créateur ;
- dont la signature est exactement la signature de création.

Plusieurs achats initiaux dans la même transaction restent plusieurs preuves.
Le profil expose leur liste ordonnée et leurs totaux par quote asset. Il
n'additionne jamais deux quote mints différents.

Les flux quote sont groupés par la clé :

```text
quote mint + decimals + token program
```

Chaque groupe conserve séparément quote dépensée en achats et quote récupérée
en ventes. Tous les montants sont des `bigint`.

`hasSold` signifie seulement qu'une vente du créateur a été observée depuis la
création. Le profil ne décide pas seul si elle est « précoce » au sens d'une
règle de qualification configurable.

## Positions et concentrations observées

Les trades dont `trader` est `null` incrémentent
`unknownTraderTradeCount`, mais ne créent aucun wallet fictif.

Pour chaque wallet connu, l'analyse produit :

- base achetée ;
- base vendue ;
- flux net base signé ;
- nombre d'achats et de ventes ;
- flux quote par quote asset ;
- premier et dernier curseur observés ;
- indicateur `isCreator`.

Les concentrations utilisent uniquement les flux nets strictement positifs :

```text
totalPositiveNetBaseRaw =
  somme(max(observedNetBaseRaw, 0))

shareBps =
  observedNetBaseRaw * 10_000 / totalPositiveNetBaseRaw
```

La division est entière et tronquée. Quand le dénominateur est nul, toutes les
concentrations valent zéro.

Les wallets positifs sont triés par flux net décroissant, puis adresse
croissante. Les métriques sont :

- `top1Bps` : somme du premier wallet ;
- `top5Bps` : somme des cinq premiers ;
- `top10Bps` : somme des dix premiers ;
- `creatorBps` : part positive du créateur ;
- `uniqueKnownBuyers` ;
- `uniqueExternalBuyers` ;
- `positivePositionCount` ;
- `unknownTraderTradeCount`.

Les basis points sont des `bigint` dans le domaine et
`NUMERIC(78,0)` dans PostgreSQL.

## Reconstruction, idempotence et finalité

L'approche choisie est une reconstruction déterministe, pas des compteurs
incrémentaux.

Pour un mint, le repository :

1. ouvre une transaction ;
2. acquiert un verrou advisory transactionnel dérivé du mint ;
3. relit le lancement et les trades ;
4. exclut les trades `orphaned` ;
5. calcule une empreinte des entrées canoniques ordonnées ;
6. exécute les deux analyseurs purs ;
7. remplace le profil courant et les positions courantes ;
8. insère ou retrouve le snapshot correspondant à l'empreinte ;
9. upsert les événements dérivés ;
10. commit.

Une erreur rollback toutes les écritures I1. Les événements source déjà
réconciliés restent disponibles et permettent un retry ; aucune projection I1
partielle ne devient visible.

Les statuts `processed`, `confirmed` et `finalized` participent au calcul.
`orphaned` est exclu. La validation `finalized -> orphaned` reste la
responsabilité du socle existant et continue d'être rejetée avant la
reconstruction.

L'empreinte inclut au minimum :

- l'identité du lancement ;
- l'identité, la finalité et les données financières de chaque trade ;
- le trader ;
- le quote asset.

Un replay identique retrouve la même empreinte et ne crée ni snapshot ni
révision SSE supplémentaire. Une montée de finalité modifie l'empreinte sans
modifier deux fois les montants. Un orphaning retire le trade de l'entrée et
produit une nouvelle projection canonique.

## Curseur et événements dérivés

PR I1 utilise :

- `CreatorProfileUpdated`, déjà réservé ;
- `HolderDistributionUpdated`, nouveau type métier versionné.

Le curseur `asOf` est celui du dernier trade actif. En l'absence de trade
actif, il est celui du lancement. L'identité déterministe de chaque événement
dérivé utilise son type, le mint, la source et le programme du lancement,
ainsi que la signature et le curseur `asOf`.

Le statut de confirmation de la projection est le statut actif le plus faible
parmi le lancement et les trades contributeurs :

```text
processed < confirmed < finalized
```

Les événements dérivés ne prennent pas le statut `orphaned`, car leur payload
décrit précisément l'ensemble actif après exclusion. Si un événement
antérieur devient orphaned, le même événement dérivé `asOf` peut recevoir un
nouveau payload. L'upsert de `domain_events` déclenche alors une nouvelle
révision dans l'outbox SSE existant.

Le payload contient l'empreinte d'entrée et les compteurs de finalité. Cela
rend les montées de finalité observables même quand les agrégats financiers
restent identiques.

## Persistance PostgreSQL

La migration `007_participant_analytics.sql` crée :

### `creator_profiles`

Une projection courante par mint :

- `mint` clé primaire et FK vers `token_launches` avec cascade ;
- créateur ;
- version de payload ;
- empreinte d'entrée ;
- données du profil en colonnes financières et JSONB structuré ;
- événement et curseur `asOf` ;
- statut de confirmation ;
- timestamps et `purge_after`.

### `observed_wallet_positions`

Une position courante par `(mint, wallet)` :

- achats, ventes et flux net base en `NUMERIC(78,0)` ;
- compteurs structuraux entiers ;
- flux quote JSONB ;
- premiers/derniers curseurs ;
- `is_creator` ;
- empreinte de reconstruction ;
- `purge_after`.

Le remplacement supprime puis réinsère uniquement les positions du mint sous
le même verrou et dans la même transaction.

### `token_holders_snapshots`

Une évolution agrégée immuable :

- identifiant déterministe ;
- mint et empreinte d'entrée ;
- événement et curseur `asOf` ;
- compteurs ;
- total positif ;
- top 1, top 5, top 10 et créateur en basis points ;
- statut de confirmation ;
- date d'observation et `purge_after`.

Une contrainte unique `(mint, input_fingerprint)` rend le replay idempotent.

La migration étend également la liste de types SSE à
`HolderDistributionUpdated`. Elle est rejouable sur une base vide et sur une
base ayant déjà appliqué les migrations 001 à 006.

Les FK avec cascade garantissent la suppression avec `token_launches`. Le
purgeur existant est étendu pour propager `purge_after` et conserver au plus
quatre heures après l'état terminal.

## Contrat API V1

`ApiHolders` devient une union discriminée.

Sans reconstruction :

```json
{
  "status": "NOT_AVAILABLE",
  "snapshots": [],
  "positions": [],
  "clusters": [],
  "clusterAnalysisStatus": "NOT_AVAILABLE"
}
```

Avec reconstruction :

```json
{
  "status": "AVAILABLE",
  "methodology": "OBSERVED_BONDING_CURVE_TRADES",
  "creatorProfile": {},
  "latestSnapshot": {},
  "snapshots": [],
  "positions": [],
  "clusters": [],
  "clusterAnalysisStatus": "NOT_AVAILABLE"
}
```

Les `bigint` sont des chaînes décimales. Les curseurs Solana utilisent aussi
des chaînes pour slot et indices publics.

Les positions sont triées par flux net décroissant puis wallet. Les snapshots
sont triés du plus récent au plus ancien. Deux limites configurables et
bornées contrôlent la réponse :

- `API_HOLDER_POSITION_LIMIT`, défaut 100, maximum 500 ;
- `API_HOLDER_SNAPSHOT_LIMIT`, défaut 100, maximum 500.

La route ne conclut jamais que les clusters sont absents. Elle indique
explicitement que leur analyse n'est pas disponible avant PR I2.

Une donnée PostgreSQL invalide produit l'erreur de projection typée existante,
jamais une normalisation silencieuse.

## Qualification

PR I1 produit les preuves nécessaires à :

- `creatorHasNotSold` ;
- `externalBuyersObserved` ;
- `CREATOR_EARLY_SELL` ;
- `HOLDER_CONCENTRATION_EXCEEDED`.

Elle ne choisit pas de nouveaux seuils et ne recalcule pas automatiquement un
rapport de qualification. Les seuils restent une décision de configuration et
de calibration. Une future composition pourra mapper le profil et le snapshot
vers le `QualificationEngine` sans modifier les analyseurs.

## Erreurs

Les erreurs sont typées par étape :

- entrée de reconstruction invalide ;
- lancement absent ;
- trade incohérent avec le mint ou le quote asset ;
- données PostgreSQL invalides ;
- conflit de finalité déjà rejeté par le socle ;
- transaction de projection échouée.

Les logs restent structurés et ne contiennent ni payload RPC intégral ni
secret. Un échec est retryable depuis l'événement source canonique.

## Tests

Les tests unitaires couvrent :

- achat initial du créateur dans la transaction de création ;
- plusieurs achats initiaux ;
- achats/ventes créateur et première vente ;
- multi-quote sans addition entre devises ;
- traders inconnus ;
- positions négatives conservées ;
- top 1, top 5 et top 10 ;
- dénominateur nul ;
- égalités départagées par wallet ;
- immutabilité des résultats.

Les tests repository et PostgreSQL couvrent :

- verrou par mint et transaction atomique ;
- remplacement des positions ;
- snapshot idempotent ;
- replay identique ;
- montée de finalité ;
- retrait d'un trade orphaned ;
- rollback sans état partiel ;
- rétention et cascade ;
- migration sur base vide et second passage.

Les tests API et SSE couvrent :

- `NOT_AVAILABLE` avant reconstruction ;
- `AVAILABLE` après reconstruction ;
- chaînes décimales signées ;
- limites bornées ;
- ordre déterministe ;
- `HolderDistributionUpdated` et révisions ;
- payload PostgreSQL corrompu refusé.

La validation finale exécute :

```text
npm install
npm run build
npm run check
npm run lint
TEST_DATABASE_URL=postgresql:///postgres npm test
```

Tous les tests existants Raydium, Pump.fun, PumpSwap, qualification, paper
trading et API doivent rester verts.

## Hors périmètre

PR I1 n'ajoute pas :

- d'historique antérieur du créateur ;
- de `creator_launch_history` ;
- de lecture de soldes SPL ;
- de suivi des transferts directs ;
- de recherche de funders ;
- de `wallet_relationships` ou `wallet_clusters` ;
- de branchement RPC dans `src/app.ts` ;
- de seuils de qualification non validés ;
- d'exécution réelle.

PR I2 consommera de nouvelles preuves explicites pour les relations et
clusters sans redéfinir les positions observées de PR I1.
