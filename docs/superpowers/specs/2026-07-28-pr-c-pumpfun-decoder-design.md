# PR C — Décodage Pump.fun des créations et trades

## Objectif

PR C ajoute un décodeur Pump.fun auditable pour les créations et les trades de
bonding curve. Il s'appuie exclusivement sur une révision épinglée de l'IDL
officiel et sur les données de transaction Solana déjà normalisées.

La PR produit les projections génériques `TokenLaunch` et `LaunchpadTrade` sans
activer le listener Pump.fun dans `src/app.ts`. Elle ne lit pas encore les
comptes de bonding curve, ne persiste aucune nouvelle projection et ne rend
possible aucune exécution réelle.

## Décisions validées

- L'IDL officiel épinglé est la source de vérité.
- Les discriminators et schémas retenus sont générés depuis cet IDL.
- Anchor et le SDK Pump.fun ne sont pas des dépendances d'exécution.
- Le décodage accepte plusieurs quote mints ; chaque lancement conserve son
  quote mint exact.
- SOL/WSOL est le seul quote asset initialement autorisé pour le paper trading,
  mais cette restriction ne s'applique pas à l'observation.
- Les montants exécutés proviennent uniquement des événements CPI officiels.
- Une instruction Pump.fun réussie sans événement CPI appariable échoue avec
  une erreur typée et rejouable. Aucun montant n'est estimé et aucun trade
  incomplet n'est ignoré silencieusement.
- PR C reste hors du bootstrap de production.

## Source officielle épinglée

La révision de référence est :

- dépôt :
  <https://github.com/pump-fun/pump-public-docs> ;
- commit :
  `9c82f61cb711b044a17f770ab8ce9f9bdf78f333` ;
- fichier :
  <https://github.com/pump-fun/pump-public-docs/blob/9c82f61cb711b044a17f770ab8ce9f9bdf78f333/idl/pump.json> ;
- adresse du programme :
  `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` ;
- SHA-256 du fichier JSON officiel :
  `b90bc471327f671449271d5d1d42354d1fae6f5a06502f5834459a3108138e49`.

Le snapshot complet est conservé dans
`vendor/pumpfun/idl/pump-9c82f61.json`. Un fichier d'accompagnement documente
la provenance, le checksum, la date de vérification et la commande de
régénération.

Le package officiel `@pump-fun/pump-sdk@1.36.0` ne sert pas de source
d'exécution. Son IDL publié est légèrement antérieur à la révision publique
ci-dessus et il introduirait Anchor ainsi que plusieurs dépendances transitives.

## Périmètre des instructions

PR C reconnaît les instructions actives suivantes telles qu'elles apparaissent
dans l'IDL épinglé :

| Famille | Instructions |
| --- | --- |
| Création | `create`, `create_v2` |
| Achat | `buy`, `buy_v2`, `buy_exact_sol_in`, `buy_exact_quote_in_v2` |
| Vente | `sell`, `sell_v2` |

`buy_exact_sol_in` est le nom présent dans l'IDL pour l'ancienne instruction
d'achat exact en SOL. Le code utilise ce nom officiel et documente son
équivalence fonctionnelle avec l'ancienne terminologie
`buy_exact_quote_in`.

`migrate` et `migrate_v2` sont vérifiés dans le snapshot mais leur décodage
métier appartient à PR G. Les instructions PumpSwap ne font pas partie de PR C.

## Architecture

### Snapshot et génération

Les fichiers ajoutés sont organisés ainsi :

```text
vendor/pumpfun/
  README.md
  idl/pump-9c82f61.json

scripts/
  generate-pumpfun-idl.ts

src/launchpads/pumpfun/
  constants.ts
  errors.ts
  generated/pump-idl.ts
  borsh-reader.ts
  instruction-decoder.ts
  event-decoder.ts
  transaction-decoder.ts
  quote-asset.ts
  pumpfun-launchpad.adapter.ts
  types.ts
```

`generate-pumpfun-idl.ts` :

1. vérifie l'adresse du programme et le checksum du snapshot ;
2. sélectionne les instructions, comptes, arguments, événements et types
   nécessaires ;
3. produit un fichier TypeScript déterministe ;
4. échoue si un élément requis est absent, dupliqué ou incompatible ;
5. ne contacte jamais le réseau.

Le fichier généré contient les discriminators, l'ordre des comptes et les
descriptions de champs nécessaires. Il porte la révision et le checksum de
provenance. Le build normal consomme le fichier généré et reste entièrement
hors ligne.

### Décodeur Borsh

Le lecteur Borsh local est petit, strict et spécialisé pour les types utilisés :

- `bool`, `u16`, `u32`, `u64`, `i64` ;
- `pubkey` ;
- `string` UTF-8 avec longueur `u32` ;
- `vec<Shareholder>` ;
- `OptionBool`, struct Pump.fun contenant un booléen.

Tous les montants, réserves, frais, timestamps on-chain et basis points sont
décodés en `bigint`. Les longueurs de chaînes et tableaux restent des entiers
JavaScript bornés et validés avant toute allocation. Les données tronquées, les
longueurs excessives et les octets résiduels non couverts par la politique
d'extension ci-dessous produisent des erreurs typées.

Les événements sont acceptés lorsqu'ils contiennent au moins tout le préfixe
décrit par l'IDL épinglé. Des octets finaux inconnus sont signalés dans la
preuve de décodage, afin de tolérer une extension append-only sans prétendre
l'avoir comprise. Toute modification des champs connus reste une
incompatibilité explicite.

### Événements CPI

PR C décode :

- `CreateEvent` ;
- `TradeEvent`.

Les CPI `emit_cpi!` commencent par le tag Anchor dérivé de
`sha256("anchor:event")`, encodé selon la convention little-endian Anchor, puis
par le discriminator d'événement provenant de l'IDL Pump.fun. Le générateur
calcule et valide ces valeurs ; aucune constante issue d'un projet tiers n'est
copiée.

Les objets Pump.fun décodés conservent tous les champs officiels utiles,
notamment :

- nom, symbole, URI, mint, bonding curve, utilisateur et créateur ;
- Token Program, quote mint, Cashback et Mayhem ;
- réserves initiales et supply ;
- montants token et quote réellement exécutés ;
- réserves réelles et virtuelles après trade ;
- frais protocole, créateur, cashback et buyback ;
- shareholders et `ix_name`.

Le mapping générique peut n'exposer qu'une partie de ces champs dans PR C. Le
résultat public de `PumpFunTransactionDecoder` conserve les objets Pump.fun
complets ; PR D pourra donc construire ses snapshots à partir de ce résultat
plutôt que de réimplémenter les codecs.

## Normalisation Solana

`TransactionFetcher` conserve déjà les instructions externes et internes avec
leur index canonique. PR C corrige un défaut ciblé : le `stackHeight` réel
fourni par `getTransaction` doit être conservé pour chaque instruction interne,
au lieu d'être remplacé systématiquement par `2`.

La structure de curseur ne change pas :

```text
slot
transactionIndex
instructionIndex
innerInstructionIndex
```

Solana groupe les instructions internes par instruction externe et fournit un
ordre plat d'exécution. Le couple ordre interne plus `stackHeight` permet de
délimiter la portée d'une CPI sans inventer un parent que le RPC ne fournit pas.

Un `transactionIndex` nul empêche toute émission métier et produit une erreur
typée. La résolution de cet index canonique avant activation du listener reste
une responsabilité d'infrastructure distincte.

## Algorithme d'appariement

Le décodeur parcourt toutes les instructions normalisées dans l'ordre canonique.
Il ne suppose ni une seule instruction Pump.fun, ni une seule création par
transaction.

Une instruction du programme Pump.fun hors du périmètre de PR C est ignorée si
elle ne produit ni `CreateEvent` ni `TradeEvent`. Cela permet aux instructions
d'administration, de cashback ou de collecte de frais de coexister dans une
transaction. À l'inverse, un `CreateEvent` ou `TradeEvent` sans action reconnue
est une erreur : il peut révéler une nouvelle variante de trade qui exige une
mise à jour du snapshot.

Pour chaque instruction Pump.fun d'action :

1. classifier le discriminator et décoder ses arguments et comptes ;
2. déterminer sa portée d'exécution dans le groupe d'instruction externe ;
3. rechercher dans cette portée exactement un événement CPI Pump.fun du type
   attendu ;
4. imposer au CPI d'événement un `stackHeight` immédiatement supérieur à celui
   de l'action ;
5. vérifier que l'événement apparaît après l'action et avant la fermeture de sa
   portée ;
6. recouper les champs communs entre instruction, comptes et événement ;
7. marquer l'événement comme consommé.

Une action externe a un `stackHeight` de `1` et son événement est interne à
hauteur `2`. Une action Pump.fun invoquée par un autre programme peut être à
hauteur `2` et son événement à hauteur `3`. La portée d'une action interne se
termine à la première instruction interne suivante dont le `stackHeight` est
inférieur ou égal à celui de l'action.

Après le parcours :

- toute action réussie reconnue doit avoir exactement un événement ;
- tout `CreateEvent` ou `TradeEvent` reconnu doit avoir été consommé ;
- les événements dupliqués, orphelins ou ambigus font échouer le décodage.

Le curseur de l'événement métier est celui de l'instruction d'action, jamais
celui du CPI `emit_cpi!`. Deux actions distinctes gardent donc des identités
distinctes même si elles appartiennent à la même transaction.

## Flux métier

### Transaction échouée

Une transaction dont `error` n'est pas nul n'a modifié aucun état on-chain. Le
décodeur retourne une observation vide, sans transformer cet échec attendu en
événement métier.

### Création

Une paire instruction plus `CreateEvent` produit un `TokenLaunch` :

- `mint` et `creator` viennent de l'événement et sont recoupés avec
  l'instruction ;
- `tokenProgram` est détecté depuis le programme de token exact ;
- `quoteAssets` contient l'unique quote asset de la courbe, sans hypothèse
  globale sur SOL ;
- `createdAt` est le curseur de l'instruction de création ;
- `parameters` conserve la variante d'instruction, le nom, le symbole, l'URI,
  la bonding curve, l'utilisateur, les modes, les réserves et les paramètres
  on-chain disponibles.

Une transaction peut produire plusieurs `TokenLaunch`.

### Achat ou vente

Une paire instruction plus `TradeEvent` produit un `LaunchpadTrade` lorsque le
mint vient d'être créé dans la transaction ou appartient aux mints déjà suivis.

- `kind` provient de `is_buy` et doit être cohérent avec l'instruction ;
- `trader` provient de `user` et doit correspondre au compte utilisateur ;
- `baseAmountRaw` provient de `token_amount` ;
- `quoteAmountRaw` provient de `quote_amount` ;
- `quoteAsset` conserve le quote mint, ses décimales et son Token Program ;
- le curseur et l'identifiant sont déterministes.

Les champs historiques `sol_amount` et les seuils d'instruction comme
`max_sol_cost` ou `min_sol_output` sont conservés comme preuves, mais ne
remplacent jamais les montants effectivement exécutés.

Une transaction `create_v2` suivie d'un achat initial produit un
`TokenLaunchDetected` puis un `BondingCurveTradeObserved`. Le service générique
de PR B ajoute les mints nouvellement détectés à l'ensemble faisant autorité
avant de filtrer les trades.

Le port générique appelle actuellement `detectLaunches` puis `decodeTrades` sur
le même objet transaction. L'adaptateur mutualise le
`PumpFunTransactionDecoder` avec un `WeakMap` privé indexé par cet objet. Le
scan et le décodage Borsh ne sont donc exécutés qu'une fois pendant une
observation, sans cache global, minuterie ni rétention supplémentaire.

## Quote assets et Token Programs

Les adresses reconnues sont :

- SPL Token ;
- Token-2022 ;
- WSOL comme représentation de domaine de SOL natif.

`Pubkey::default()` dans l'état ou l'événement Pump.fun est normalisé en WSOL.
Les instructions V2 utilisent leur compte `quote_mint` exact ; pour une courbe
SOL, ce compte doit être WSOL même si le transfert effectif est natif.

Pour un quote mint non natif, les décimales et le Token Program sont déduits des
balances token pré/post normalisées de la même transaction. Toutes les
occurrences doivent être cohérentes. L'ordre de résolution est :

1. WSOL connu localement ;
2. balances token de la transaction ;
3. erreur typée rejouable si la preuve manque ou se contredit.

PR C ne fait aucun appel RPC additionnel. Cette politique économise les quotas
sans inventer de métadonnée. Un futur cache de comptes mint pourra être ajouté
en amont, sans modifier le décodeur pur.

Une instruction V2 doit aussi concorder avec ses comptes
`base_token_program`, `quote_token_program` et `quote_mint`. Pour `create_v2`,
les trois remaining accounts d'un quote non natif doivent être tous présents
dans l'ordre officiel. Les instructions legacy sont limitées aux courbes SOL
qu'elles savent représenter.

## Erreurs

Les erreurs Pump.fun sont des classes explicites portant au minimum :

- code stable ;
- signature ;
- curseur lorsque disponible ;
- variante d'instruction ou type d'événement ;
- cause technique éventuelle ;
- caractère rejouable ou définitif.

Le jeu initial couvre :

| Code | Cas | Rejouable sans déploiement |
| --- | --- | --- |
| `PUMP_TRANSACTION_INDEX_REQUIRED` | index canonique absent | oui |
| `PUMP_SCHEMA_UNSUPPORTED` | événement connu incompatible avec l'IDL épinglé | non |
| `PUMP_BORSH_TRUNCATED` | données incomplètes | oui |
| `PUMP_BORSH_INVALID` | longueur ou valeur Borsh invalide | non |
| `PUMP_ACCOUNT_MISSING` | compte obligatoire absent | oui |
| `PUMP_STACK_HEIGHT_REQUIRED` | hauteur CPI nécessaire absente | oui |
| `PUMP_STACK_HEIGHT_INVALID` | portée CPI contradictoire | oui |
| `PUMP_EVENT_MISSING` | action reconnue sans événement | oui |
| `PUMP_EVENT_DUPLICATE` | plusieurs copies du même événement | oui |
| `PUMP_EVENT_ORPHANED` | événement connu sans action reconnue | non |
| `PUMP_EVENT_AMBIGUOUS` | plusieurs appariements possibles | oui |
| `PUMP_EVENT_MISMATCH` | mint, sens, utilisateur ou comptes incohérents | non |
| `PUMP_QUOTE_ASSET_UNRESOLVED` | décimales ou programme sans preuve | oui |
| `PUMP_QUOTE_ASSET_CONFLICT` | preuves de quote contradictoires | oui |
| `PUMP_TOKEN_PROGRAM_UNSUPPORTED` | programme Token inconnu | non |

Ces erreurs sont enveloppées par `LaunchpadObservationError` à la frontière
applicative existante. Aucun échec d'une action Pump.fun reconnue n'est réduit
à un simple log.

## Quotas et performance

Le décodeur est pur et local :

- aucun téléchargement d'IDL au démarrage ;
- aucun appel RPC pendant la classification ou le décodage ;
- aucun SDK distant ou API payante ;
- une seule normalisation de la transaction en amont ;
- déduplication des quote mints avant toute future résolution externe ;
- fixtures capturées une fois puis rejouées hors ligne ;
- scans linéaires bornés par le nombre d'instructions d'une transaction.

Les vérifications de qualité ne sont pas retirées pour économiser des quotas.
Les comptes, discriminators, schémas, curseurs, montants et appariements restent
tous validés.

## Tests

### Tests unitaires

Les tests synthétiques dérivés de l'IDL couvrent :

- chaque instruction du périmètre ;
- `CreateEvent` et `TradeEvent` ;
- valeurs `u64` et `i64` au-delà de `Number.MAX_SAFE_INTEGER` ;
- chaînes UTF-8, `OptionBool` et shareholders ;
- données tronquées, longueurs invalides et champs finaux inconnus ;
- génération déterministe et cohérence du snapshot.

### Tests de transaction

Les scénarios couvrent :

- instruction Pump.fun externe ;
- instruction Pump.fun invoquée par CPI ;
- conservation du vrai `stackHeight` ;
- plusieurs actions Pump.fun dans un groupe externe ;
- plusieurs créations dans une transaction ;
- `create_v2` plus achat initial ;
- achat et vente ;
- SOL, USDC et quote mint générique ;
- SPL Token et Token-2022 ;
- filtrage par mints suivis ;
- transaction échouée ;
- `transactionIndex` absent ;
- événement absent, dupliqué, orphelin, ambigu ou contradictoire.

### Fixtures

Un petit nombre de transactions mainnet publiques est capturé puis normalisé et
assaini. Les fixtures ne contiennent aucun secret ni donnée hors chaîne et
retirent les informations non nécessaires au scénario. Elles couvrent au
minimum :

- une création avec achat initial ;
- un trade V2 invoqué par CPI ;
- une vente V2 ;
- un cas multi-instruction.

Les signatures publiques servant de provenance peuvent être documentées. Les
tests n'accèdent jamais au réseau.

## Critères d'acceptation

PR C est prête lorsque :

- le snapshot correspond au commit et au checksum documentés ;
- la génération est déterministe ;
- toutes les instructions du périmètre sont reconnues depuis l'IDL officiel ;
- les événements CPI fournissent les montants réellement exécutés ;
- les instructions externes, internes et multiples sont appariées sans
  ambiguïté ;
- création plus achat initial est détectée dans une transaction ;
- quote mints et Token Programs sont conservés exactement ;
- tous les calculs financiers utilisent `bigint` ;
- les erreurs de preuve sont explicites et rejouables ;
- `src/app.ts` ne compose toujours pas l'adaptateur Pump.fun ;
- Raydium CPMM et ses tests restent inchangés ;
- `npm install`, `npm run build`, `npm run check`, `npm run lint` et
  `npm test` réussissent ;
- aucun test existant ne régresse ;
- aucune clé privée, signature ou soumission de transaction n'est introduite.

## Hors périmètre

PR C n'implémente pas :

- l'abonnement WebSocket et l'activation du listener Pump.fun ;
- la résolution du `transactionIndex` depuis un bloc ;
- la lecture RPC de la bonding curve ;
- les snapshots PostgreSQL et la rétention ;
- les métadonnées ;
- la qualification ;
- le paper trading et les quotes ;
- la graduation et PumpSwap ;
- l'historique antérieur du créateur ;
- toute construction, signature ou soumission de transaction.
