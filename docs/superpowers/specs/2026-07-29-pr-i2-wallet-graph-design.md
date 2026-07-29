# PR I2 — Funders observés, relations et clusters de wallets

## Décision

PR I2 complète PR I1 avec un graphe construit uniquement depuis les
transactions Pump.fun reçues après la détection du token.

Elle ne consulte aucun historique RPC, ne recherche pas les anciens
financements d'un wallet et ne transforme pas une absence de preuve en preuve
d'indépendance. Les résultats décrivent donc des relations **observées**, pas
l'identité réelle des propriétaires.

Les deux reason codes suivants restent inactifs :

- `SHARED_FUNDER_CLUSTER` ;
- `RELATED_WALLET_CLUSTER_EXCEEDED`.

PR I2 produit leurs preuves et leurs métriques, mais aucun seuil, score,
blocker ou verdict n'est modifié avant le dry run.

## Périmètre de vérité

Les sources autorisées sont :

- les transactions Pump.fun observées depuis `TokenLaunchDetected` ;
- les achats Pump.fun déjà décodés et appariés à leur instruction ;
- les transferts SOL, SPL Token ou Token-2022 présents dans ces mêmes
  transactions ;
- les positions observées de PR I1.

Les sources interdites sont :

- l'historique antérieur à la création observée ;
- une exploration récursive des transactions des wallets ;
- une inférence à partir des deltas globaux de balances ;
- une API tierce d'identification ;
- la similarité de noms, métadonnées ou réseaux sociaux.

La fenêtre d'observation finit avec la rétention du lancement. Les données I2
suivent la politique existante : jusqu'à quatre heures après l'état terminal,
puis purge en cascade.

## Architecture

PR I2 introduit cinq unités isolées :

| Unité | Responsabilité |
| --- | --- |
| `WalletFundingEvidenceExtractor<TTransaction>` | port générique qui associe des transferts explicites aux achats observés |
| `SolanaWalletFundingEvidenceExtractor` | décodage SOL, SPL Token et Token-2022 depuis une transaction normalisée |
| `WalletEvidenceObservationService` | validation, déduplication et persistance des preuves au moment de l'observation |
| `WalletGraphAnalyzer` | calcul pur des relations, composantes et concentrations |
| `WalletGraphRebuildService` / `WalletGraphRepository` | reconstruction PostgreSQL transactionnelle et idempotente |

Le flux passif est :

```text
transaction Pump.fun normalisée + achats décodés
  -> extraction des preuves de financement explicites
  -> persistance et réconciliation de finalité
  -> verrou transactionnel PostgreSQL par mint
  -> lecture des preuves canoniques et positions I1
  -> relations déterministes
  -> composantes connexes sur les seules arêtes fortes
  -> remplacement atomique des projections courantes
  -> événement agrégé WalletClusterDetected
  -> projections HTTP/SSE existantes
```

Le service est invocable, mais PR I2 ne le compose pas dans `src/app.ts`.
Cette limite évite de prétendre que le listener Pump.fun est actif alors que
le bootstrap de production reste volontairement passif. La future PR
d'appairage transactionnel appellera I2 avec la transaction normalisée avant
qu'elle ne soit libérée.

Pump.fun ne connaît pas le graphe. L'extracteur reçoit le résultat métier des
achats décodés et dépend seulement des contrats génériques et de
l'infrastructure Solana.

## Preuves de financement

### Types et confiance

Deux preuves V1 sont reconnues :

| Type | Confiance | Effet sur un cluster |
| --- | --- | --- |
| `DIRECT_QUOTE_TRANSFER` | `STRONG` | crée une arête non orientée |
| `FEE_PAYER_FOR_BUYER` | `MEDIUM` | preuve exposée, mais aucune fusion |

Un transfert direct est fort seulement si :

1. il précède l'achat associé dans l'ordre complet des instructions ;
2. il appartient à la même transaction ;
3. sa destination appartient exactement au wallet acheteur ;
4. son actif correspond exactement au quote asset de l'achat ;
5. son émetteur peut être attribué sans ambiguïté à un wallet ;
6. le funder est différent de l'acheteur ;
7. aucun compte technique connu n'est utilisé comme wallet métier.

Plusieurs transferts valides restent plusieurs preuves. Ils ne sont pas
additionnés entre quote assets. Toute preuve conserve :

- mint du lancement ;
- acheteur et funder ;
- quote mint, décimales et Token Program ;
- type et confiance ;
- identifiant et curseur de l'achat associé ;
- source, programme et finalité ;
- dates blockchain et d'observation lorsqu'elles existent ;
- version de payload.

Une preuve `DIRECT_QUOTE_TRANSFER` conserve en plus son montant brut entier et
le curseur complet du transfert. Une preuve `FEE_PAYER_FOR_BUYER` ne prétend
pas être un transfert : son montant et son curseur de transfert sont `null`.

L'identifiant déterministe inclut le type, la source, le programme, la
signature, le curseur du transfert, le mint, l'acheteur, le funder et le quote
asset. Une même preuve rejouée avec une finalité supérieure garde son
identité.

### SOL

Une instruction System Program `Transfer` est décodée avec le décodeur
officiel `SystemInstruction.decodeTransfer`.

Elle ne peut financer un achat que si le quote asset de celui-ci représente
SOL/WSOL dans l'abstraction métier. Le montant en lamports reste un `bigint`.
Les transferts avec seed, allocations et autres instructions System Program
ne sont pas assimilés à un financement V1.

### SPL Token et Token-2022

Les instructions `Transfer` et `TransferChecked` sont décodées avec les
décodeurs de `@solana/spl-token`, en passant explicitement le programme SPL
Token ou Token-2022 attendu.

Le mint et le propriétaire de destination sont résolus depuis les balances
token normalisées de la transaction. Le propriétaire doit être exactement
l'acheteur et le mint doit correspondre au quote asset de l'achat. Pour
`Transfer`, dont l'instruction ne transporte pas le mint, une résolution
absente ou contradictoire rend la preuve inconnue.

Le propriétaire canonique du compte token source devient le funder uniquement
si son attribution est non ambiguë. L'autorité de transfert ne suffit pas,
car elle peut être un delegate. Un multisig, un owner absent ou une
contradiction de balances ne crée aucune arête.

Un transfert entre deux comptes token appartenant au même acheteur est une
consolidation interne. Il est compté comme transfert ignoré dans le ledger
d'extraction, mais ne produit ni `DIRECT_QUOTE_TRANSFER`, ni couverture forte,
ni relation.

Les extensions Token-2022 non reconnues ne sont pas devinées. Une future
version pourra ajouter leurs décodeurs officiels sans modifier le port.

### Fee payer

Le premier signataire payeur de la transaction produit une preuve
`FEE_PAYER_FOR_BUYER` lorsque son adresse diffère de celle de l'acheteur.

Cette coïncidence est informative, mais insuffisante pour fusionner deux
wallets : relayers, services et sponsors peuvent légitimement payer plusieurs
transactions.

### Instructions internes et achats multiples

L'extracteur parcourt les instructions externes et internes avec leur curseur
complet. Il ne suppose ni une seule instruction Pump.fun ni un seul achat par
transaction.

Chaque transfert est consommé au plus une fois : il est associé au premier
achat postérieur compatible dans l'ordre canonique. Plusieurs transferts
peuvent financer le même achat. L'identité de la preuve inclut l'achat cible ;
un replay ne double-compte jamais un delta global. L'ordre canonique est celui
déjà défini par le socle :

1. slot ;
2. transaction index ;
3. instruction index ;
4. inner instruction index, instruction externe avant internes ;
5. identifiant déterministe.

## Comptes techniques et nœuds du graphe

Les nœuds métier possibles sont :

- le créateur ;
- les traders connus de PR I1 ;
- les funders observés.

Un funder sans position est un nœud auxiliaire de montant nul. Il peut relier
des participants, mais n'augmente jamais la concentration.

Sont exclus :

- programmes System, SPL Token, Token-2022 et Pump.fun ;
- mint et bonding curve ;
- comptes token, vaults et comptes techniques explicitement identifiés par
  les instructions décodées ;
- autres rôles techniques prouvés par la transaction.

PR I2 ne classe pas automatiquement toute adresse hors courbe Ed25519 comme
PDA : cela produirait des faux positifs pour certains comptes légitimes.
L'exclusion repose sur un rôle technique explicite et vérifiable.

## Relations et clusters

### Relations

Une relation persistée agrège les preuves canoniques pour :

```text
mint + wallet gauche + wallet droit + type de relation
```

Les adresses sont triées pour rendre la relation non orientée et déterministe.
Elle conserve la confiance maximale, le nombre de preuves, les quote assets
distincts et les curseurs premier/dernier. Les montants restent groupés par
quote asset et ne sont jamais additionnés entre devises.

Une relation forte provient uniquement d'un
`DIRECT_QUOTE_TRANSFER`. Une relation fee payer reste moyenne.

### Composantes connexes

`WalletGraphAnalyzer` calcule les composantes connexes déterministes en
utilisant seulement les relations fortes.

Une composante devient un cluster exposé si elle contient au moins deux
participants, où un participant est un créateur ou un wallet ayant une
position I1. Un funder auxiliaire seul avec un unique acheteur ne suffit donc
pas à déclarer un cluster partagé.

L'identifiant du cluster est le hash du mint et de la liste triée de ses
membres. Une modification des membres crée une nouvelle identité de cluster.
L'ordre des entrées, preuves et appels n'influence pas le résultat.

### Concentration

La concentration d'un cluster est :

```text
clusterPositiveBaseRaw =
  somme(max(observedNetBaseRaw, 0)) des participants membres

clusterConcentrationBps =
  clusterPositiveBaseRaw * 10_000 / totalPositiveNetBaseRaw I1
```

La division est entière et tronquée. Les positions nulles ou négatives et les
funders auxiliaires contribuent zéro.

Chaque cluster expose au minimum :

- nombre total de membres ;
- nombre de participants ;
- nombre de funders auxiliaires ;
- nombre de détenteurs observés positifs ;
- concentration en basis points ;
- présence du créateur ;
- nombre de funders partagés ;
- nombre de relations et de preuves fortes ;
- quote assets observés.

### Couverture

Une analyse réussie avec zéro cluster donne `AVAILABLE` et une liste vide.
Elle ne signifie pas « aucun risque ».

La couverture expose :

- achats et acheteurs connus ;
- achats et acheteurs avec preuve forte ;
- achats et acheteurs avec preuve moyenne seulement ;
- achats et acheteurs analysés sans preuve de financement ;
- achats et acheteurs dont l'extraction n'a pas été exécutée ;
- achats et acheteurs explicitement indisponibles après une ambiguïté ou une
  donnée normalisée insuffisante ;
- transactions et preuves analysées ;
- méthodologie `OBSERVED_PUMPFUN_TRANSACTIONS`.

Les catégories par acheteur sont mutuellement exclusives. La priorité
conservatrice est `STRONG`, `MEDIUM_ONLY`, `NOT_PROCESSED`, `UNAVAILABLE`,
puis `NO_EVIDENCE`. Un acheteur n'est donc classé `NO_EVIDENCE` que si tous
ses achats canoniques ont été analysés sans preuve externe. Les compteurs par
achat restent exposés séparément pour ne pas masquer une couverture partielle.

Un résultat sans reconstruction reste `NOT_AVAILABLE`.

## Reconstruction, idempotence et finalité

L'approche est une reconstruction déterministe, pas un graphe incrémental.

Pour un mint, le repository :

1. ouvre une transaction ;
2. acquiert le verrou advisory transactionnel du mint ;
3. relit le lancement, les positions I1, le ledger d'observation et les
   preuves de financement ;
4. exclut les preuves `orphaned` ;
5. calcule une empreinte des entrées canoniques ordonnées ;
6. construit relations, clusters et couverture ;
7. remplace les projections courantes ;
8. insère ou retrouve le snapshot agrégé ;
9. upsert l'événement dérivé borné ;
10. commit.

Une erreur rollback toutes les écritures I2. Les événements et projections I1
restent intacts.

Les statuts `processed`, `confirmed` et `finalized` participent au calcul.
`orphaned` est exclu. Une montée de finalité modifie l'empreinte sans compter
deux fois un transfert. Un orphaning peut retirer une relation ou dissoudre un
cluster et produit alors une nouvelle projection canonique.

L'empreinte inclut au minimum :

- le lancement ;
- l'empreinte courante des positions I1 ;
- chaque observation d'achat, y compris `NO_EVIDENCE` et `UNAVAILABLE` ;
- chaque preuve active, sa finalité et son quote asset ;
- la version de méthodologie.

Le statut de la projection est le statut actif le plus faible parmi le
lancement, les positions I1 et les preuves contributrices :

```text
processed < confirmed < finalized
```

## Événement dérivé

PR I2 utilise `WalletClusterDetected`, déjà réservé dans le domaine et dans la
contrainte SSE.

Malgré son nom, cet événement représente une mise à jour d'analyse, y compris
un résultat valide sans cluster. Son payload reste borné :

- empreinte d'entrée ;
- méthodologie et couverture ;
- nombre de relations fortes et moyennes ;
- nombre de clusters ;
- concentration maximale ;
- nombre de clusters contenant le créateur ;
- compteurs de finalité.

Son `asOf` est le dernier curseur actif parmi le lancement, la projection I1,
les observations d'achat et les preuves contributrices. S'il ne reste aucun
élément I2 actif, il retombe sur le curseur I1, puis sur celui du lancement.

Son identité déterministe utilise :

```text
WalletClusterDetected + mint + source/programme du lancement
  + signature et curseur asOf
```

Un replay identique ne produit aucune nouvelle révision. Si l'empreinte ou la
finalité change au même `asOf`, l'événement existant est upserté et le trigger
outbox crée une révision. Si un orphaning fait reculer `asOf`, l'identité
correspondant au nouveau curseur canonique est upsertée avec la nouvelle
empreinte, selon le même modèle que les événements analytiques I1.

Les membres complets et les relations restent dans PostgreSQL. La route HTTP
ne renvoie que des membres bornés et des compteurs de relations ; elle ne
renvoie pas la liste complète des relations. Ils ne sont pas copiés dans
l'outbox SSE.

## Persistance PostgreSQL

La migration `008_wallet_graph.sql` crée :

### `wallet_funding_observations`

Ledger canonique par achat observé :

- mint, identifiant du trade et signature ;
- curseur complet et finalité de l'achat ;
- statut `STRONG`, `MEDIUM_ONLY`, `NO_EVIDENCE` ou `UNAVAILABLE` ;
- compteurs de transferts inspectés, acceptés et ignorés ;
- reason codes techniques bornés, notamment ambiguïté de propriétaire,
  instruction reconnue invalide et auto-transfert ignoré ;
- version de méthodologie, timestamps et `purge_after`.

Le graphe compare ce ledger à tous les achats canoniques I1. Un achat sans
ligne est `NOT_PROCESSED`, distinct d'un achat analysé sans preuve. Cela reste
vrai lorsque le service d'observation n'est pas encore composé.

### `wallet_funding_evidence`

Preuves explicites et réconciliables :

- identifiant déterministe ;
- mint et achat associé ;
- funder, acheteur, type et confiance ;
- quote asset et montant direct nullable `NUMERIC(78,0)` ;
- signature, curseur de transfert nullable, curseur d'achat et finalité ;
- payload versionné ;
- timestamps et `purge_after`.

Les champs immuables sont vérifiés au replay. Seules la finalité et les dates
d'enrichissement autorisées peuvent progresser.

### `wallet_relationships`

Projection courante par relation :

- mint, wallets triés et type ;
- confiance, compteurs et quote totals groupés ;
- premiers/derniers curseurs ;
- empreinte de reconstruction ;
- `purge_after`.

### `wallet_graph_profiles`

Projection courante unique par mint :

- empreinte courante, méthodologie et couverture ;
- compteurs agrégés de relations et clusters ;
- événement et curseur `asOf` ;
- statut de confirmation ;
- `purge_after`.

Cette ligne désigne explicitement l'empreinte courante, y compris lorsque
l'analyse produit zéro cluster ou lorsqu'un orphaning fait reculer `asOf`.
L'historique ne sert jamais implicitement à choisir la projection active.

### `wallet_clusters`

Projection courante par cluster :

- identifiant déterministe et mint ;
- métriques agrégées ;
- empreinte de reconstruction ;
- `purge_after`.

### `wallet_cluster_members`

Projection courante normalisée par `(mint, cluster_id, wallet)` :

- rôle participant ou funder auxiliaire ;
- indicateur créateur ;
- position observée signée ;
- part positive du cluster ;
- empreinte de reconstruction ;
- `purge_after`.

Les listes de membres ne sont jamais stockées en JSONB dans
`wallet_clusters`, ni dans l'événement SSE. Les lectures API paginent et
bornent directement les lignes membres.

### `wallet_graph_snapshots`

Snapshot agrégé immuable par `(mint, input_fingerprint)` :

- méthodologie et couverture ;
- nombres de relations et clusters ;
- concentration maximale ;
- statut de confirmation ;
- événement et curseur `asOf` ;
- date d'observation et `purge_after`.

Les FK vers `token_launches` utilisent la cascade. Le purgeur supprime les
projections I2 avant leurs événements dérivés. La migration est compatible
avec une base vide et rejouable proprement après 001 à 007.

Tous les montants, lamports et basis points sont des entiers en domaine et
`NUMERIC(78,0)` dans PostgreSQL.

## Contrat API V1

Avant reconstruction :

```json
{
  "status": "AVAILABLE",
  "clusters": [],
  "clusterAnalysisStatus": "NOT_AVAILABLE"
}
```

Après reconstruction :

```json
{
  "status": "AVAILABLE",
  "clusters": [],
  "clusterAnalysisStatus": "AVAILABLE",
  "clusterMethodology": "OBSERVED_PUMPFUN_TRANSACTIONS",
  "clusterCoverage": {
    "knownBuyerCount": 0,
    "strongEvidenceBuyerCount": 0,
    "mediumOnlyBuyerCount": 0,
    "noEvidenceBuyerCount": 0,
    "unavailableBuyerCount": 0,
    "notProcessedBuyerCount": 0
  },
  "clusterCount": 0,
  "clustersTruncated": false
}
```

Les clusters sont triés par concentration décroissante puis identifiant. Les
membres sont triés par position positive décroissante puis wallet.

Trois limites configurables et bornées sont ajoutées :

- `API_WALLET_CLUSTER_LIMIT`, défaut 50, maximum 100 ;
- `API_WALLET_CLUSTER_MEMBER_LIMIT`, défaut 50, maximum 100 ;
- `API_WALLET_CLUSTER_TOTAL_MEMBER_LIMIT`, défaut 500, maximum 1 000.

Le budget total est partagé dans l'ordre canonique des clusters après
application de la limite par cluster. La réponse expose `clusterCount` et
`clustersTruncated`. Chaque cluster expose `memberCount`,
`membersTruncated` et seulement des compteurs de relations. Une réponse bornée
ne paraît donc jamais complète à tort, et ne peut pas contenir plus de 1 000
membres, même avec la configuration maximale. Les `bigint` sont des chaînes
décimales et les curseurs Solana restent des chaînes.

Une ligne PostgreSQL invalide produit l'erreur de projection typée existante.

## Qualification et dry run

PR I2 expose les données candidates :

- nombre de clusters ;
- concentration maximale par cluster ;
- cluster du créateur ;
- funders partagés ;
- couverture de l'analyse.

Elle ne :

- déclenche aucun reason code ;
- ajoute ou retire aucun point ;
- change aucun verdict ;
- ouvre ou ferme aucune position paper.

Le dry run devra mesurer les distributions, la couverture et les faux positifs
avant toute configuration de `SHARED_FUNDER_CLUSTER` ou
`RELATED_WALLET_CLUSTER_EXCEEDED`.

## Erreurs et observabilité

Les erreurs sont typées par étape :

- transaction ou achat incohérent ;
- instruction de transfert reconnue mais invalide ;
- attribution de propriétaire ambiguë ;
- preuve contradictoire au replay ;
- entrée de graphe invalide ;
- projection PostgreSQL invalide ;
- transaction de reconstruction échouée.

Une instruction sans rapport est ignorée. Une preuve insuffisante reste
absente et diminue explicitement la couverture ; elle ne crée pas une relation
faible inventée.

Les logs sont structurés et n'incluent ni transaction RPC intégrale, ni secret,
ni clé privée.

## Tests

Les tests unitaires de l'extracteur couvrent :

- transfert SOL externe et interne avant un achat ;
- transfert après achat ignoré ;
- mauvais bénéficiaire ou mauvais quote asset ;
- `Transfer` et `TransferChecked` SPL Token ;
- SPL Token et Token-2022 ;
- owner ou mint absent et contradictoire ;
- fee payer moyen sans fusion ;
- plusieurs achats et transferts sans double comptage ;
- comptes techniques exclus ;
- identités stables et objets immuables.

Les tests du graphe couvrent :

- funder partagé entre deux acheteurs ;
- preuve moyenne exclue des composantes ;
- relation forte transitive ;
- créateur dans un cluster ;
- funder auxiliaire à position nulle ;
- multi-quote séparé ;
- position négative exclue de la concentration ;
- zéro cluster disponible ;
- couverture partielle ;
- résultat indépendant de l'ordre d'entrée.

Les tests repository et PostgreSQL couvrent :

- migration sur base vide et second passage ;
- preuve idempotente et montée de finalité ;
- exclusion d'une preuve orphaned ;
- remplacement atomique des projections ;
- cluster dissous après orphaning ;
- replay identique ;
- concurrence par mint ;
- rollback sans état partiel ;
- purge à quatre heures et cascade.

Les tests API et SSE couvrent :

- `NOT_AVAILABLE` avant reconstruction ;
- `AVAILABLE` avec zéro cluster ;
- limites et troncature explicites ;
- ordre déterministe ;
- payload SSE agrégé et borné ;
- donnée PostgreSQL corrompue refusée.

La validation finale exécute :

```text
npm install
npm run build
npm run check
npm run lint
TEST_DATABASE_URL=postgresql:///postgres npm test
```

Les 406 tests présents au démarrage de PR I2 doivent rester verts.

## Hors périmètre

PR I2 n'ajoute pas :

- d'historique RPC ;
- d'analyse d'anciens tokens du créateur ;
- de recherche récursive de funders ;
- d'heuristique IP, appareil ou identité ;
- d'API payante ;
- de seuil de cluster ;
- de blocker ou score de qualification ;
- de branchement du listener dans `src/app.ts` ;
- de transaction réelle, signature ou clé privée.

La PR suivante d'appairage transactionnel composera les services passifs avec
les checkpoints et la réconciliation existants. Les seuils resteront une
décision distincte, fondée sur le dry run.
