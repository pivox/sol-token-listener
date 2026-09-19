# Cache cohérent de blocs normalisés

Version : 1.1.0 — 2026-09-19 — issues #112, #127.

## Statut et périmètre

`CachedSolanaBlockTransactionLocator` est un consommateur explicite de
`TransactionBlockRpc` enrichi de `httpTransportEpoch`. La factory de production
peut l'activer uniquement au redémarrage ; il reste désactivé par défaut.
`SolanaTransactionLocator`, le locator direct `SolanaBlockTransactionLocator`,
les scans catch-up stricts et la réconciliation de finalité conservent leur
comportement. La sérialisation #127 n'ajoute aucun paramètre d'environnement,
wiring de factory, heartbeat, lease, classifier ou changement de persistance.

Cette étape prolonge la
[source cohérente par slot v1.0.0](2026-09-12-coherent-slot-block-hydration-design.md).

## Clé et cohérence

Une instance partagée possède un cache et une table single-flight indexés par
`(slot, commitment effectif, epoch HTTP)`. `PROCESSED` utilise le commitment
effectif `CONFIRMED`; le statut restitué reste celui demandé par le caller.
`FINALIZED` utilise une entrée indépendante : aucune promotion d'un bloc
confirmed en bloc finalized n'est possible.

Une requête froide effectue un seul `getBlockTransactions`, partagé par les
callers concurrents de la même clé. Une signature absente d'une entrée déjà
retenue invalide cette entrée et autorise exactement un rafraîchissement forcé,
qui rejoint le même single-flight. Une absence dans la réponse fraîche reste
`TransactionIndexNotFoundError`, sans boucle et sans fallback
`getTransaction`/`getBlockSignatures`.

La réponse n'est retenue qu'après une sélection cible réussie. Les réponses
nulles, erreurs RPC, enveloppes invalides, signatures dupliquées, normalisations
invalides et résultats négatifs ne sont jamais retenus. Les classifications
fermées du locator restent inchangées et chaque caller reçoit son propre objet
d'erreur trusted, même lorsqu'un fetch partagé échoue. Aucune erreur fournisseur
ou exception de sérialisation/désérialisation n'est exposée.

## Snapshot immutable et frontière fournisseur

La construction parcourt une fois l'enveloppe et les signatures primaires du
bloc, avec les mêmes primitives défensives que le locator direct. Chaque
transaction est projetée par des descripteurs data-only puis normalisée. Les
méthodes, accesseurs, proxys et graphes bruts RPC ne sont jamais retenus. Les
versions legacy/v0, ALT, instructions internes et soldes Token-2022 utilisent le
normaliseur existant.

Les transactions normalisées sont sérialisées avec `node:v8`, puis encodées en
chaînes base64 immutables dans un tableau gelé d'enregistrements gelés. Seuls les
signatures, payloads texte, marqueurs locaux et compteurs primitifs subsistent.
Il ne s'agit pas d'un format persistant ni d'un contrat inter-version de Node.
La désérialisation d'un payload construit localement produit une nouvelle copie
indépendante pour chaque caller, en préservant les `bigint` et `Uint8Array`.
Cette copie garde la mutabilité historique de `NormalizedTransaction`; aucune
mutation de son statut, erreur ou instruction ne peut modifier le cache.

Une transaction non ciblée dont la normalisation échoue désactive la rétention
du bloc entier, mais une cible valide dans cette réponse peut encore réussir.
Le marqueur de normalisation n'existe que pendant la réponse single-flight,
jamais dans le LRU. L'enveloppe et toutes les signatures doivent cependant être
valides, comme pour le locator direct. Les erreurs sur la cible restent
terminales. Le locator direct conserve son inspection limitée aux métadonnées
de la seule cible, sans modification.

## Bornes et expiration

Les defaults internes, surchargeables uniquement au constructeur pour tests et
composition explicite, sont :

| Limite | Valeur |
| --- | --- |
| Entrées retenues | 64 |
| Octets retenus cumulés | 64 MiB |
| Octets retenus par bloc | 8 MiB |
| TTL confirmed | 10 000 ms |
| TTL finalized | 60 000 ms |
| Intervalle minimal entre départs fetch | 250 ms |

Le poids charge la longueur ASCII/UTF-8 des payloads **après** expansion base64,
les octets UTF-8 des signatures, 32 octets par enregistrement et 64 octets par
snapshot. C'est une borne comptable de la représentation retenue, pas une
mesure exacte du heap V8 ni une limite du corps HTTP. La réponse SDK brute et
la sérialisation transitoire sont hors de cette borne; leurs tailles réelles
doivent encore être mesurées avant activation.

Le LRU évince les entrées les moins récemment utilisées jusqu'au respect des
deux plafonds globaux. Un bloc trop gros n'est pas retenu et n'évince pas les
autres blocs; sa cible peut néanmoins réussir pour le caller courant. Le TTL
part de la fin du fetch et de la projection, avec une horloge monotone par
défaut. Un hit ne prolonge pas le TTL. L'expiration est paresseuse à l'accès et
à la lecture des compteurs, sans timer périodique.

## Pacing et cycle de vie

Une seule file FIFO par instance partagée couvre tous les slots, commitments,
misses et rafraîchissements. Les départs sont espacés d'au moins 250 ms, soit au
plus quatre départs dans toute fenêtre semi-ouverte d'une seconde. Une admission
attend aussi la fin de l'admission précédente : il existe donc au plus un
`getBlockTransactions` actif par instance. Pour deux admissions FIFO A puis B,
le départ de B est postérieur ou égal à la fois à la fin de A et au départ de A
augmenté de l'intervalle minimal. Les hits et callers rejoignant un
single-flight ne consomment pas un nouveau départ. Une erreur de A rejette
uniquement ses callers puis libère B ; elle ne vide pas la file.

Cette cadence concerne les appels logiques de cette source, pas les tentatives
HTTP internes de failover ni les autres consommateurs RPC. Le débit est borné
par le minimum entre quatre départs par seconde et l'inverse de la latence RPC.
Cette sérialisation assume volontairement le head-of-line blocking : #127
n'introduit ni timeout ni annulation d'un appel SDK déjà parti.

`clear()` supprime valeurs et références single-flight et avance une génération
locale : une réponse commencée avant ce nettoyage ne peut plus être retenue.
Les admissions encore en file sont rejetées immédiatement et ne consomment pas
les créneaux de pacing du nouvel epoch ; un fetch déjà démarré conserve toutefois
son créneau passé. Comme cet appel SDK ne peut pas être annulé, une admission du
nouvel epoch attend sa fin avant de partir ; son ancienne réponse ne peut pas
être retenue.
`close()` est idempotent, annule le timer de pacing et rejette les admissions
restantes; aucun nouveau caller n'est accepté. Les requêtes SDK déjà parties
peuvent se terminer pour leurs callers, mais sans rétention. Les promesses en
échec sont retirées par identité, afin qu'un ancien fetch ne supprime pas une
nouvelle génération.

La profondeur de la file d'admission ne reçoit volontairement aucun plafond
supplémentaire dans #127. La concurrence RPC active est strictement bornée à un,
exposée par `inFlightFetches`; `queuedFetches` et `queueDelayMs` rendent visible
le head-of-line blocking. Les limites de concurrence appelante et le canary
opérationnel restent ceux de l'activation #114.

## Epoch HTTP

`SolanaRpcClient.httpTransportEpoch` commence à zéro et avance lorsque le
transport sélectionne effectivement un endpoint différent. Le hook interne
observe chaque tentative HTTP, y compris le retour au primaire après un reset
sticky sans événement public de failover. La configuration Connection
mono-endpoint ne change pas. L'epoch ne contient ni URL ni credential et ne
repose pas sur la bonne exécution des observateurs d'événements publics.

Le cache compare l'epoch avant accès, admission et rétention. Un changement
invalide logiquement toutes les anciennes clés et détache les anciens flights.
Une réponse dont l'epoch a changé pendant le fetch peut servir son caller
initial mais ne peut être retenue sous aucune epoch. Une ancienne admission
encore en file échoue de façon retryable au lieu de partir avec une identité
obsolète. Aucun claim de cohérence provider-affine n'est ajouté aux scans stricts
de catch-up ou de finalité.

## Vérification

Les tests déterministes couvrent single-flight et hits séquentiels, commitments,
TTL distincts, LRU octets/entrées, oversize global/par bloc, résultats négatifs,
rafraîchissement unique, FIFO, latence et erreur sous concurrence strictement
unitaire, mutations caller/fournisseur, changements d'epoch avant et pendant un
fetch, nettoyage et annulation d'admission, classification trusted par caller,
legacy/v0/ALT et entrée non ciblée non normalisable. Les tests du locator direct,
du client RPC et du transport restent exécutés.
