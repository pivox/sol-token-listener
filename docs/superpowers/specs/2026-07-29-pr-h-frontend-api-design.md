# PR H — API publique HTTP et flux SSE reprenable

## Objectif

Exposer les projections Pump.fun, paper trading et PumpSwap sous des contrats
JSON V1 stables, puis diffuser leurs événements métier par un flux SSE durable
et reprenable.

L'API est publique, sans authentification, strictement en lecture seule. Elle
n'ajoute aucune capacité de signature, de simulation de transaction Solana ou
d'envoi. Elle ne promet ni exhaustivité avant la détection, ni position dans un
slot, ni sellabilité, ni profit.

## Périmètre

La PR ajoute :

- les huit routes HTTP `/api/v1` documentées ;
- une pagination bornée par curseur opaque ;
- des projections PostgreSQL dédiées à la lecture publique ;
- une outbox append-only des révisions d'événements métier ;
- `GET /api/v1/events` en Server-Sent Events ;
- la reprise stricte via `Last-Event-ID` ;
- un heartbeat SSE et une fermeture explicite sur curseur expiré ;
- la diffusion des corrections `finalized` et `orphaned` ;
- des erreurs publiques à codes stables ;
- un bootstrap HTTP avec arrêt gracieux ;
- la purge de l'outbox après quatre heures ;
- des tests de contrats, sérialisation, pagination, HTTP, SSE et sécurité.

La PR n'ajoute pas :

- d'interface HTML produit ;
- de mutation HTTP ;
- de clé API, compte utilisateur ou contrôle d'accès ;
- de CORS avec credentials ;
- de WebSocket ;
- de cache distribué ou broker externe ;
- d'abonnement RPC Pump.fun ou PumpSwap ;
- de nouvelles analyses sociales, holders, créateurs ou clusters ;
- de construction, signature, simulation ou envoi de transaction.

Les routes sociales et holders existent dès la V1, mais retournent un état
explicite `NOT_AVAILABLE` et des collections vides tant que leurs projections
ne sont pas produites. Elles n'inventent aucune preuve.

## Choix d'architecture

### Serveur HTTP

Le serveur utilise `node:http`. Les huit routes, le flux SSE et les méthodes
autorisées ne justifient pas l'ajout d'un framework. Le routage, les limites et
la validation restent isolés de la composition applicative.

```text
interfaces/http
  -> application/api
     -> ports/api
        <- storage/postgresql
```

`interfaces/http` ne construit pas de SQL et ne connaît pas Pump.fun,
PumpSwap ou Raydium. Le repository API ne contient aucune décision de
qualification ou de paper trading : il lit les projections déjà décidées par
le domaine.

### Composition

`src/app.ts` compose le serveur seulement lorsque PostgreSQL est disponible.
Le processus reste vivant jusqu'à un signal `SIGINT` ou `SIGTERM`, ferme
d'abord les connexions SSE, puis le serveur HTTP et enfin le pool PostgreSQL.

La PR H ne branche aucun abonnement Solana. L'état de santé indique
explicitement que le pipeline PumpSwap est disponible et que le listener RPC
est inactif. Une PR ultérieure pourra injecter un producteur d'observations
sans modifier les contrats HTTP/SSE.

## Configuration

La configuration ajoute :

```text
API_ENABLED=true
API_HOST=127.0.0.1
API_PORT=3000
API_PAGE_LIMIT_DEFAULT=50
API_PAGE_LIMIT_MAX=200
API_SSE_HEARTBEAT_MS=15000
API_SSE_POLL_MS=1000
```

Les durées et limites sont des entiers positifs bornés. `API_HOST` reste
loopback par défaut ; le déploiement peut choisir une interface publique.
« API publique » signifie qu'aucune authentification applicative n'est requise,
pas que le processus doit écouter toutes les interfaces par défaut.

`API_ENABLED=false` conserve un bootstrap de vérification qui initialise puis
ferme la base comme avant la PR H. L'API ne demande jamais de clé privée.

## Contrats JSON

Toutes les réponses utilisent :

```json
{
  "apiVersion": "v1",
  "data": {},
  "meta": {
    "generatedAt": "2026-07-29T12:00:00.000Z",
    "nextCursor": null
  }
}
```

Les erreurs utilisent :

```json
{
  "apiVersion": "v1",
  "error": {
    "code": "LAUNCH_NOT_FOUND",
    "message": "Launch not found."
  }
}
```

Règles de sérialisation :

- `NUMERIC`, `bigint`, slots, montants, réserves, frais et basis points sont
  des chaînes décimales ;
- les dates sont ISO 8601 UTC ;
- une valeur inconnue est `null`, jamais zéro ou chaîne vide ;
- les objets et tableaux ont une forme stable ;
- aucun champ PostgreSQL interne, stack trace ou message SQL n'est exposé ;
- les payloads JSON lus en base sont validés avant émission.

## Routes

### `GET /api/v1/launches`

Retourne le radar ordonné par détection décroissante puis mint. Les paramètres
`limit` et `cursor` sont bornés. Chaque élément contient l'identité du
lancement, son état, ses quote assets, la dernière metadata, la dernière
bonding curve, la dernière qualification et la migration ou le pool courant
lorsqu'ils existent.

### `GET /api/v1/launches/:mint`

Retourne la fiche agrégée d'un mint exact. Un mint absent produit
`LAUNCH_NOT_FOUND`. La route ne lance aucune récupération RPC ou HTTP externe.

### `GET /api/v1/launches/:mint/events`

Retourne la timeline persistée, ordonnée par curseur Solana complet puis ID
métier. Les transitions d'état sont incluses comme projections explicables.

### `GET /api/v1/launches/:mint/risk`

Retourne le dernier rapport de qualification, ses trois scores, son ruleset,
ses blockers et preuves. L'absence de rapport est `null`, pas une acceptation.

### `GET /api/v1/launches/:mint/social`

Retourne :

```json
{
  "status": "NOT_AVAILABLE",
  "links": [],
  "evidence": []
}
```

jusqu'à l'introduction des projections sociales.

### `GET /api/v1/launches/:mint/holders`

Retourne :

```json
{
  "status": "NOT_AVAILABLE",
  "snapshots": [],
  "clusters": []
}
```

jusqu'à l'introduction des projections holders et clusters.

### `GET /api/v1/paper-positions`

Retourne les positions paper paginées, y compris `PAPER_RETRACTED`. Les
montants et PnL sont des chaînes décimales. Aucun endpoint de création ou de
fermeture de position n'est exposé.

### `GET /api/v1/health`

Expose uniquement des informations techniques non sensibles :

- état HTTP et PostgreSQL ;
- état disponible/inactif des pipelines ;
- dernier checkpoint et heartbeat connus ;
- retard en slots lorsqu'il est calculable ;
- date du contrôle.

La route ne révèle ni URL RPC, URL PostgreSQL, variables d'environnement ou
contenu d'erreur interne. Une base indisponible produit HTTP `503` avec
`DEPENDENCY_UNAVAILABLE`.

## Pagination HTTP

Les curseurs sont des chaînes Base64URL versionnées et signées par aucune
clé : ils encodent seulement une position de tri non sensible et sont validés
strictement. Leur opacité est contractuelle ; un client ne doit pas les
construire.

Un curseur mal formé produit `INVALID_CURSOR`. Un `limit` absent utilise la
valeur par défaut ; une valeur non entière, nulle, négative ou supérieure au
maximum produit `INVALID_LIMIT`. Les requêtes SQL utilisent une pagination par
clé, jamais `OFFSET`.

## Outbox temps réel

### Table

La migration `006_api_event_stream.sql` crée une outbox append-only :

```text
api_event_stream
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
  stream_event_id TEXT UNIQUE NOT NULL
  domain_event_id TEXT NOT NULL
  event_type TEXT NOT NULL
  mint TEXT NOT NULL
  confirmation_status TEXT NOT NULL
  payload_version INTEGER NOT NULL
  event JSONB NOT NULL
  emitted_at TIMESTAMPTZ NOT NULL
  purge_after TIMESTAMPTZ NOT NULL
```

`stream_event_id` identifie une révision diffusée. `domain_event_id` reste
l'identifiant métier déterministe commun aux changements de finalité.

Un trigger PostgreSQL `AFTER INSERT OR UPDATE` sur `domain_events` ajoute
atomiquement une révision lorsque l'enveloppe publique change. Un replay
strictement identique n'ajoute rien. Une montée vers `confirmed` ou
`finalized`, ou une correction `orphaned`, ajoute une nouvelle ligne.

L'identité de révision est déterministe à partir de l'ID métier, du statut de
confirmation, de la version et du contenu public canonique. La contrainte
unique élimine un replay concurrent.

La migration initialise l'outbox à partir des événements encore retenus. Elle
est rejouable et compatible avec une base vide.

### Curseur SSE

L'ID de trame SSE est un curseur de transport opaque dérivé de `sequence`. Il
n'est pas l'ID métier :

```text
id: <opaque-resume-cursor>
event: QualificationUpdated
data: {"eventId":"evt_...","payloadVersion":1,"mint":"...","confirmationStatus":"confirmed","payload":{}}
```

À la connexion :

1. sans `Last-Event-ID`, le serveur prend le high-water mark courant et ne
   rejoue pas l'historique ; le client charge d'abord les projections HTTP ;
2. avec un curseur valide et retenu, il envoie strictement les lignes suivantes
   dans l'ordre de `sequence` ;
3. avec un curseur antérieur à la fenêtre disponible, il répond HTTP `409`
   `EVENT_CURSOR_EXPIRED` avant d'ouvrir le flux ;
4. avec un curseur supérieur au high-water mark ou mal formé, il répond
   `INVALID_CURSOR`.

Le serveur lit des lots bornés. Il n'avance le curseur de connexion qu'après
écriture réussie de la trame dans la réponse. Une reconnexion reprend après la
dernière trame accusée implicitement par `Last-Event-ID`.

### Cycle de vie SSE

Les en-têtes sont :

```text
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Un commentaire heartbeat est envoyé toutes les quinze secondes par défaut.
La déconnexion annule immédiatement timers et requêtes futures. L'arrêt du
serveur envoie un événement `server_shutdown`, ferme les connexions et libère
les ressources dans un délai borné.

Une erreur PostgreSQL après ouverture produit un événement `stream_error` avec
un code public stable, puis ferme la connexion. Le client reprend depuis sa
dernière trame ; aucune lacune n'est masquée.

## Erreurs publiques stables

La V1 définit au minimum :

- `ROUTE_NOT_FOUND` ;
- `METHOD_NOT_ALLOWED` ;
- `INVALID_MINT` ;
- `INVALID_LIMIT` ;
- `INVALID_CURSOR` ;
- `LAUNCH_NOT_FOUND` ;
- `EVENT_CURSOR_EXPIRED` ;
- `DEPENDENCY_UNAVAILABLE` ;
- `INTERNAL_ERROR`.

Les erreurs internes sont journalisées avec un identifiant de corrélation. La
réponse publique contient ce même identifiant, sans détail sensible.

## Rétention

Chaque révision de l'outbox reçoit `purge_after = emitted_at + 4 hours`. La
purge existante supprime les lignes expirées par lots avant les projections
parents. La suppression ne doit pas transformer un curseur expiré en reprise
silencieuse.

Une connexion déjà ouverte ne constitue pas une archive. Le front-end doit
recharger les projections HTTP lorsqu'il ne possède pas de curseur ou reçoit
`EVENT_CURSOR_EXPIRED`.

## Sécurité HTTP

- seules les méthodes `GET`, `HEAD` et `OPTIONS` sont acceptées ;
- `OPTIONS` ne permet que les lectures sans credentials ;
- aucune route ne consomme de body ;
- URL, paramètres et en-têtes utiles sont bornés ;
- les erreurs ne reflètent pas les entrées non assainies ;
- `Cache-Control: no-store` protège les projections volatiles ;
- CORS autorise les lectures publiques sans cookies ;
- aucun endpoint de diagnostic historique pouvant exécuter une action n'est
  monté sous `/api/v1`.

Le dashboard HTML historique reste un outil séparé et n'est pas servi par
l'API produit.

## Tests et critères d'acceptation

La PR est acceptable lorsque :

- `npm install`, `npm run build`, `npm run check`, `npm run lint` et
  `npm test` réussissent ;
- la migration 006 passe sur une base vide et au second passage lorsqu'une URL
  PostgreSQL de test est disponible ;
- tous les montants financiers sortent en chaînes décimales ;
- les huit routes respectent leurs enveloppes et erreurs ;
- une méthode de mutation est refusée ;
- un événement persisté est repris exactement une fois après son curseur ;
- un replay identique n'ajoute aucune révision ;
- `confirmed`, `finalized` et `orphaned` produisent des révisions ordonnées ;
- un curseur expiré produit `409` avant ouverture SSE ;
- heartbeat, déconnexion et arrêt gracieux ne laissent aucun timer actif ;
- une erreur après ouverture ferme explicitement le flux ;
- aucune clé privée, signature ou soumission Solana n'est accessible depuis
  l'API ;
- les tests existants ne régressent pas.

## Risques maîtrisés

- **Trigger et repositories multiples** : le trigger garantit la capture
  atomique sans dupliquer la logique dans chaque repository.
- **Révisions d'un même événement** : le curseur de transport est distinct de
  l'identité métier.
- **Rétention** : le serveur vérifie l'existence du curseur avant les en-têtes
  SSE.
- **Client lent** : les lots sont bornés et respectent la contre-pression de
  la réponse HTTP.
- **Projections incomplètes** : les routes retournent `NOT_AVAILABLE` ou
  `null`, jamais une conclusion positive inventée.
- **Dépendance PostgreSQL** : HTTP `503` avant ouverture ou `stream_error`
  après ouverture, avec reprise possible.
