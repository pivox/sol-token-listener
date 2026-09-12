# Priorité durable des trades Pump.fun suivis

**Version :** 1.0.3 — 2026-09-12

## Contexte

La migration 044 donne la priorité aux créations détectées depuis le
`CreateEvent` officiel. La migration 046 rend le rattrapage strict paginé et
reprenable. Ces protections garantissent la découverte, mais le listener peut
encore récupérer le corps RPC de chaque trade Pump.fun, y compris lorsque son
mint ne fait pas partie des lancements conservés par le produit. Cette charge
fait croître le backlog et consomme le quota nécessaire au suivi des créations
récentes.

Le produit intervient à l'arrivée d'un token, le suit jusqu'à son achat et sa
vente, puis conserve ses preuves quatre heures. Il n'a pas besoin de décoder
les trades de tokens créés avant sa fenêtre d'observation.

## Approches évaluées

Un simple changement d'ordre du claim préserverait le quota consommé par les
transactions non pertinentes. Un registre uniquement en mémoire serait rapide,
mais perdrait son autorité après un redémarrage et classerait mal un trade reçu
avant la projection de sa création.

La solution retenue est une classification durable différée. Le transport
extrait un indice borné depuis les événements officiels. PostgreSQL confronte
le mint public de cet indice à la projection canonique, conserve la décision et
évite la récupération RPC tant que le mint n'est pas suivi. La projection de la
création resynchronise ensuite les décisions déjà reçues pour ce mint.

## Contrat du hint WebSocket

Le vocabulaire fermé devient `NONE | PUMPFUN_CREATE | PUMPFUN_TRADE`.
`PUMPFUN_TRADE` transporte séparément un `hintMint` canonique ; les deux autres
valeurs exigent `hintMint = null`. Le mint est lu dans les 32 octets qui suivent
le discriminator `TradeEvent` du snapshot IDL officiel versionné.

Le parseur inspecte la totalité du tableau de logs borné avant de conclure. Une
création rencontrée dans n'importe quelle ligne l'emporte sur tout trade afin
qu'une transaction composée création + achat initial soit récupérée et décodée
en entier. Si le tableau, le base64, le discriminator, la longueur ou la clé
publique est ambigu, le résultat est `NONE`. `NONE` reste une transaction
normale et n'est jamais filtré.

Le marqueur exact `Log truncated`, émis sans préfixe par le runtime Solana
lorsque son budget de logs est épuisé, rend également l'indice ambigu et force
`NONE`. Un `CreateEvent` complet observé avant ce marqueur garde toutefois la
priorité. Le texte applicatif préfixé `Program log: Log truncated` reste un log
ordinaire et ne doit pas être confondu avec le marqueur du runtime.

Une invocation runtime exacte de PumpSwap rend également tout indice de trade
ambigu : la signature peut contenir une activité pertinente pour un autre
adaptateur, même si le mint Pump.fun n'est pas suivi. Ce veto utilise seulement
l'identifiant officiel du programme et les lignes `Program … invoke [n]`, sans
décoder ses événements ni confondre un texte `Program log:` avec le runtime.
Le coordinateur WebSocket fournit les programmes veto au parseur via une liste
bornée à 16 clés canoniques, validée sans accéder aux getters. Le parseur reste
indépendant des autres adaptateurs ; une configuration invalide force `NONE`.
Un `CreateEvent` complet conserve toujours la priorité création.

L'indice n'est pas une preuve métier. Le décodeur de transaction complète reste
la seule autorité de `TokenLaunchDetected` et
`BondingCurveTradeObserved`. Aucun log WebSocket n'est persisté.

## Modèle durable

La migration 047 étend la priorité avec `TRACKED_TRADE` et ajoute à
`chain_transaction_inbox` :

- `ingestion_hint`, fermé à `NONE`, `PUMPFUN_CREATE` ou `PUMPFUN_TRADE` ;
- `ingestion_hint_mint`, nullable et présent uniquement pour un trade ;
- le statut `DEFERRED`, sans lease, erreur ni snapshot ;
- une terminaison et une purge exactement quatre heures après la décision
  différée.

Les lignes existantes sont dérivées sans ambiguïté : `LAUNCH_CANDIDATE` devient
`PUMPFUN_CREATE`, le reste devient `NONE`. Le schéma refuse toute combinaison
contradictoire de statut, hint, mint, lease, erreur, snapshot ou rétention.

## Règles d'enqueue

Chaque signature reste sérialisée par son advisory lock actuel.

- `PUMPFUN_CREATE` produit une ligne `PENDING` et `LAUNCH_CANDIDATE`.
- `PUMPFUN_TRADE` dont le mint possède un `token_launches.terminal_at IS NULL`
  produit une ligne `PENDING` et `TRACKED_TRADE`.
- `PUMPFUN_TRADE` non suivi produit une ligne `DEFERRED`, sans récupération RPC,
  avec rétention quatre heures.
- `NONE` produit une ligne `PENDING` et `NORMAL`.

Une découverte WebSocket plus précise peut enrichir une découverte exclusivement catch-up.
Une création ne peut jamais être dégradée par un trade ou par `NONE`. Un
catch-up limité à Pump.fun ne réactive pas une décision différée. Une création tardive
pour la même signature réactive la ligne et l'élève en candidat de création.
Une ligne déjà louée ou traitée n'est jamais réécrite en décision différée.

L'inbox est commune à tous les adaptateurs de la signature. L'union durable des
`program_ids` fait donc autorité : plusieurs programmes observés interdisent
`DEFERRED`, dans les deux ordres de découverte. Le hint fournit la provenance
Pump.fun ; la cardinalité des identifiants uniques suffit sans importer un
adaptateur dans la couche stockage. Hors création,
la décision devient `NORMAL/NONE/null`; une ligne différée redevient `PENDING`
et perd ses timestamps terminaux, sans modifier le cycle d'une ligne déjà louée
ou traitée. Le catch-up multi-programme a la même autorité.

Deux hints de trade visant des mints différents ne constituent pas un conflit
d'identité de transaction : ils rendent le classement ambigu et produisent la
même décision conservatrice `NORMAL/NONE/null`. Un `NONE` observé par WebSocket
est durable : les hints de trade ultérieurs ne peuvent plus filtrer cette
signature, y compris après redémarrage. Cela couvre aussi un `NONE` WebSocket
arrivé après un premier hint trade. Seul un `NONE` provenant exclusivement du
catch-up peut être enrichi par un trade ; la priorité création reste possible.

## Synchronisation avec la projection canonique

Le port d'inbox expose `syncTrackedMint(mint)`. Après la persistance launchpad
et avant les analyses dérivées, le pipeline appelle ce port pour chaque mint
affecté, dans l'ordre lexical.

Sous un advisory lock par mint, le repository relit `token_launches` :

- si le mint est actif, ses lignes `DEFERRED/PUMPFUN_TRADE` deviennent
  `PENDING/TRACKED_TRADE` et perdent leur rétention terminale ;
- s'il est absent ou terminal, seules ses lignes `PENDING/PUMPFUN_TRADE` jamais
  louées, sans snapshot et sans tentative deviennent `DEFERRED` ;
- les lignes `PROCESSING`, `PROCESSED` ou ayant déjà une tentative restent
  inchangées pour les reclassements de suivi Pump.fun.

La synchronisation normalise aussi les anciennes lignes multi-programme
`DEFERRED/PENDING` en `PENDING/NORMAL/NONE/null`, que le mint soit actif ou non.
Elle ne les rediffère jamais et conserve leur preuve de finalité existante.

L'index partiel `chain_transaction_inbox_tracked_mint_idx` porte sur
`ingestion_hint_mint` pour `PUMPFUN_TRADE` aux statuts `DEFERRED` et `PENDING`.
Il couvre activation et désactivation sans parcourir les lignes d'autres mints.
La migration valide sa définition exacte sur les objets préexistants et au
rejeu ; un index absent au rejeu ou incompatible n'est pas réparé silencieusement.
Une régression PostgreSQL 16 explique l'UPDATE réel du repository au milieu de
100 000 lignes non pertinentes et exige un accès indexé sélectif dans les deux
directions, sans désactiver les scans séquentiels.

Un crash après la projection mais avant la synchronisation fait échouer le
pipeline. Le replay idempotent de la transaction de création recommence la
synchronisation. Un trade arrivé avant sa création est donc récupéré sans
course silencieuse.

La purge et les écritures de cette projection partagent un verrou de rétention
transactionnel versionné `foundation-retention-fence:v1`. La purge prend ce
verrou en mode exclusif avant toute autre ressource ; `record`, `enqueue` et
`syncTrackedMint` le prennent en mode partagé comme premier verrou. L'ordre est
donc uniforme et auditable : fence de fondation, puis signature ou mint, puis
lignes métier.

La purge conserve en outre toute ligne `DEFERRED/PUMPFUN_TRADE` expirée dont le
mint possède encore un lancement actif. Cette protection couvre l'intervalle
entre le commit de la création et sa synchronisation, y compris après un crash.
Elle ne décale aucun timestamp : les lignes absentes ou terminales restent
supprimables exactement quatre heures après leur décision différée, tandis
qu'une ligne active perd sa rétention dès que la synchronisation réussit.

## Ordonnancement et équité

`LAUNCH_CANDIDATE` et `TRACKED_TRADE` forment une cohorte urgente commune,
ordonnée par slot puis signature. Le nom historique du compteur PostgreSQL est
remplacé par `consecutive_urgent_claims`. Après 32 claims urgents, le prochain
claim éligible tente une ligne `NORMAL`. En l'absence de ligne normale prête,
la cohorte urgente continue.

`DEFERRED` n'est jamais claimable et ne fait pas partie du backlog actionnable.
Les compteurs historiques de pending, processing, failed et exhausted gardent
leur signification. Le nombre différé reste observable directement dans la
base pour H2i sans modifier le contrat public V1 dans cette PR.

## Catch-up, finalité et reprise

Le catch-up ne fabrique jamais de hint. S'il rejoue une signature déjà classée
différée par le WebSocket, la décision durable empêche sa résurrection. Une
signature réellement inconnue reste `NORMAL` et sera récupérée afin que
l'absence de logs ne crée aucune perte silencieuse.

Les règles existantes de confirmation, de replay, de finalité et d'orphaning
restent inchangées pour les lignes traitées. Une décision différée est une
décision d'ingestion réversible, pas un événement métier ni une affirmation de
finalité.

## Sécurité et confidentialité

Seuls le type d'indice, le mint public, la signature, le slot et les métadonnées
d'ingestion existantes sont persistés. Les logs ne le sont jamais. Les décisions
différées sont supprimées après quatre heures par la rétention existante
étendue.

Cette livraison n'ajoute ni wallet, ni clé, ni signer, ni armement, ni
simulation live, ni soumission. Elle ne démarre aucun canary et ne constitue
pas une validation de la campagne paper Mainnet #49.

## Critères d'acceptation

- 2 000 trades explicitement non suivis ne provoquent aucun claim RPC ;
- une création tardive et les trades de son mint passent avant le backlog
  normal ;
- un trade arrivé avant sa création est réactivé après projection ;
- une transaction création + achat initial conserve le hint création et produit
  les deux événements après décodage complet ;
- toute entrée ambiguë reste `NORMAL` ;
- le marqueur runtime exact `Log truncated` force le chemin sûr `NORMAL` ;
- les doublons WebSocket/catch-up convergent sans downgrade ni résurrection ;
- une transaction composée Pump.fun/PumpSwap reste claimable dans les deux
  ordres de découverte, après redémarrage, doublon et synchronisation inactive ;
- un conflit inter-notifications ou un `NONE` WebSocket reste durablement
  conservateur, tandis qu'un `NONE` exclusivement catch-up reste enrichissable ;
- une purge concurrente ne peut supprimer un trade différé devenu suivi ;
- les décisions différées absentes ou terminales restent purgées à quatre
  heures sans extension silencieuse ;
- l'équité urgente/normal est bornée à 32 pour 1 ;
- migration 047 base vide, upgrade 046 et rejeu sont verts sur PostgreSQL 16 ;
- build, check, lint, tests, documentation et smoke sont verts ;
- deux cycles de revue maximum avant fusion.

## Suite opérationnelle

Après fusion, l'opérateur applique les migrations et rôles Mainnet puis lance
H2i pendant quinze minutes. Les gates exigent zéro 429, un backlog actionnable
non croissant, un superviseur `RUNNING` et un p95 création vers BUY/SELL
inférieur ou égal à 45 secondes. Aucun wallet n'est chargé avant cette preuve.
