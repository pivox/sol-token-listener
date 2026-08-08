# sol-token-listener

Backend TypeScript d'observation de tokens Pump.fun et de projections PumpSwap
et paper trading. Il expose aussi une API publique V1 HTTP/SSE, strictement en
lecture seule.

Le listener durable Pump.fun/PumpSwap est composé et activé par défaut. Il
combine souscriptions WebSocket, rattrapage HTTP borné, inbox PostgreSQL avec
leases et réconciliation de finalité. Raydium CPMM demeure un adaptateur
secondaire isolé; son code n'est pas activé par ce bootstrap.

## Sécurité et limites

- `EXECUTION_MODE=observe` est la valeur par défaut; seules les valeurs
  `observe` et `paper` sont admises.
- Aucun wallet ou secret de clé privée n'est accepté, et aucune transaction
  live n'est signée ou envoyée.
- Le paper trading est une projection simulée, initialement limitée à SOL/WSOL
  par allowlist; il ne démontre ni profit ni sellabilité.
- Aucune promesse de première position, même slot, sortie ou profit.
- L'observation accepte plusieurs quote assets, mais le paper trading refuse
  tout mint hors de l'allowlist initiale SOL/WSOL.
- Raydium CPMM reste non composé.

## Installation

Prérequis : Node.js 22+ et PostgreSQL.

```bash
npm install
cp .env.example .env
npm run build
npm run check
npm run lint
npm test
```

Renseigner `SOLANA_HTTP_RPC_URL`, `SOLANA_WS_RPC_URL` et `DATABASE_URL`, sans
secret de wallet. Les migrations ne sont pas lancées automatiquement par
défaut. `npm run build` les embarque dans `dist/migrations`, de sorte que
`POSTGRES_AUTO_MIGRATE=true npm start` fonctionne avec l'artefact compilé.
Les exécuter explicitement si nécessaire :

```bash
npm run db:migrate
```

Avec `LISTENER_ENABLED=true`, PostgreSQL et les endpoints Solana HTTP/WebSocket
sont des dépendances de démarrage. L'ordre est : migrations optionnelles,
health check RPC, baseline bornée, souscriptions, second rattrapage de fermeture
de fenêtre, worker, réconciliation de finalité, heartbeat, puis API. Un échec
de dépendance ou de composant interrompt le
démarrage et ferme les ressources déjà ouvertes. `LISTENER_ENABLED=false`
désactive explicitement le listener et expose un pipeline `STOPPED` si l'API
reste active.

Le WebSocket est le chemin nominal. Sans checkpoint, le premier rattrapage
prend une seule page récente comme baseline au lieu de parcourir l'historique.
Après l'ouverture des souscriptions, un second rattrapage ferme la fenêtre de
course et converge par l'inbox idempotente. Chaque rattrapage HTTP est borné
par `LISTENER_CATCH_UP_MAX_PAGES` pages de
`LISTENER_CATCH_UP_PAGE_SIZE` signatures pour chacun des programmes Pump.fun
et PumpSwap (20 × 100 par défaut). Une panne retryable est replanifiée avec un
délai exponentiel piloté par `RPC_RETRY_BASE_DELAY_MS` et plafonné à 60 s.
`RPC_RETRY_MAX_ATTEMPTS` compte les prises de lease d'un cycle, première
tentative comprise (5 par défaut, maximum 100). La policy est persistée avec la
transaction : un redémarrage ne modifie pas silencieusement un cycle actif.
Après épuisement, l'échec devient terminal et sort du backlog automatique. La
consommation RPC dépend du trafic, des déconnexions et des reprises.
L'arrêt ferme les producteurs, empêche de nouvelles prises de lease, draine le
worker puis relit les compteurs de l'inbox et écrit le heartbeat final, dans la limite de
`LISTENER_SHUTDOWN_TIMEOUT_MS`.

### Reprise manuelle d'une transaction épuisée

La reprise est une commande opérateur locale, jamais une route HTTP publique.
Elle exige deux fois la signature exacte :

```bash
npm run inbox:recover -- --signature=<SIGNATURE> --confirm=<SIGNATURE>
```

Seul un échec retryable épuisé et encore retenu peut être replanifié. La
commande conserve le compteur total, remet à zéro uniquement le cycle courant,
applique la policy configurée au nouveau cycle et écrit une preuve d'audit
atomique. Une répétition pendant que ce cycle est déjà `PENDING` ou
`PROCESSING` est idempotente. La sortie JSON utilise des codes stables et ne
contient ni URL de base, ni endpoint RPC, ni erreur brute.

## Qualification d'un endpoint RPC

La commande bornée `npm run rpc:soak` vérifie un endpoint HTTP/WebSocket dédié
avant son utilisation par le listener. Elle appelle uniquement `getSlot` et
observe, après accusé de réception, les logs des programmes Pump.fun et PumpSwap; elle ne lit aucun corps
de transaction et n'accède ni à PostgreSQL ni à un wallet. Sa sortie est un
unique rapport JSON redacted. Un verdict `PASS`, `DEGRADED` ou `FAIL` produit
respectivement le code de sortie 0, 2 ou 1.

Les valeurs par défaut sont 60 secondes et un échantillon HTTP par seconde.
`RPC_SOAK_DURATION_SECONDS` et `RPC_SOAK_INTERVAL_MS` permettent un test plus
long tout en conservant des bornes strictes. Voir le
[guide de qualification RPC](docs/operations/rpc-qualification.md) avant tout
soak réel : les quotas et tableaux de bord du fournisseur restent la source de
vérité pour la capacité et la facturation.

## API V1

L'API est activée par défaut (`API_ENABLED=true`) et écoute sur
`127.0.0.1:3000` par défaut. Les variables `API_HOST` et `API_PORT` contrôlent
l'écoute. Utiliser une adresse accessible publiquement est un choix de
déploiement explicite : l'API n'est pas authentifiée et doit être placée
derrière les contrôles réseau/TLS appropriés.

Les huit routes JSON sont `launches`, détail/timeline/risk/social/holders d'un
lancement, `paper-positions` et `health`; `/api/v1/events` est le flux SSE.
Les montants et `bigint` sont des chaînes décimales. La projection sociale
retourne honnêtement `NOT_AVAILABLE`. La projection holders devient
`AVAILABLE` après une reconstruction explicite des trades Pump.fun persistés;
sinon elle reste `NOT_AVAILABLE`.

```bash
npm start
curl -i http://127.0.0.1:3000/api/v1/health
curl -N -H 'Accept: text/event-stream' http://127.0.0.1:3000/api/v1/events
```

Conserver le champ SSE `id` et le fournir dans `Last-Event-ID` pour reprendre
le transport. Ce n'est pas `data.eventId`, qui reste l'identité métier
déterministe. En cas de `EVENT_CURSOR_EXPIRED` (409), recharger les projections
HTTP puis se reconnecter sans curseur; la rétention du flux est de quatre
heures.

Voir le contrat complet : [API V1](docs/api/v1.md).

## Preuves mainnet des décodeurs

Les IDLs Pump.fun/PumpSwap sont épinglés au dépôt public officiel avec un
manifeste SHA-256. Cinq fixtures mainnet minimisées valident hors ligne la
création et les trades Pump.fun, puis la migration, l’activation de pool et un
trade PumpSwap. Elles conservent signatures et comptes publics nécessaires au
décodage exact, mais aucune URL RPC, aucun log brut et aucun secret.

Une nouvelle preuve peut être capturée explicitement, jamais au démarrage :

```bash
npm run fixture:capture -- pumpswap <signature> <transactionIndex> <nom.json>
```

La commande exige `SOLANA_HTTP_RPC_URL`, une transaction `FINALIZED`, un index
retrouvé et vérifié dans les signatures de son bloc, un nom inédit et un
décodage sans erreur avant l’écriture. Elle n’écrase aucun fichier et sa sortie
ne révèle ni endpoint ni contenu de transaction.

## Analytics participants et graphe observé

Le service I1 reconstruit de façon déterministe le profil du créateur, ses
achats initiaux, sa première vente, les positions nettes observées et les
concentrations top 1/5/10. Il n'utilise que les trades de bonding curve
persistés depuis la détection du token : il ne consulte ni historique antérieur
ni RPC supplémentaire. Un flux net négatif est conservé comme preuve valide,
pas ramené silencieusement à zéro.

I2 ajoute un ledger de preuves de financement et un graphe passif. Un transfert
direct du quote asset vers l'acheteur, antérieur à son achat dans la même
transaction, est une preuve forte. Un fee payer distinct est une preuve
moyenne exposée, mais ne fusionne jamais deux wallets. Les auto-transferts sont
ignorés. SOL, SPL Token et Token-2022 sont décodés ; les quote assets restent
séparés et ne sont jamais additionnés entre eux.

La couverture distingue `NOT_PROCESSED`, `UNAVAILABLE` et `NO_EVIDENCE`.
Seules les arêtes fortes forment les composantes connexes. Leur concentration
utilise les flux positifs observés par I1 depuis l'arrivée du token, pas un
solde SPL certifié ou un historique antérieur. Une analyse réussie sans
cluster est `AVAILABLE` avec `clusters: []`.

Le pipeline actif enchaîne détection launchpad, preuves de financement,
reconstructions I1/I2 et PumpSwap. Une transaction échouée est rejouée depuis
le début de ce pipeline; les écritures déterministes rendent ce replay complet
idempotent, sans saut d'étape. Les reason codes
`SHARED_FUNDER_CLUSTER` et `RELATED_WALLET_CLUSTER_EXCEEDED` existent comme
contrats stables, mais restent désactivés jusqu'au calibrage dry run.

`API_HOLDER_POSITION_LIMIT` et `API_HOLDER_SNAPSHOT_LIMIT` valent 100. Les
limites clusters/membres valent respectivement 50/50, avec un budget total de
500 membres, 8 quote assets par cluster et 64 au total ; les troncatures sont
explicites.
Toutes les projections et preuves I2 suivent la rétention terminale de quatre
heures. Les transactions `finalized`, `orphaned`, non retryables ou épuisées
devenues terminales sont purgeables; une transaction `processed` ou `confirmed`
en attente de finalité ne l'est jamais. Cette fenêtre limite aussi la durée de conservation des
données publiques de wallets observées; elle ne constitue pas un historique
on-chain exhaustif.

`GET /api/v1/health` publie l'état courant des composants, le backlog, les
leases, le compteur `exhaustedCount`, checkpoints et slots observés, sans URL
RPC/DB ni secret. `RUNNING`
exige tous les composants actifs; une dépendance, un heartbeat périmé ou un
nettoyage incomplet produit `DEGRADED`; `STOPPED` désigne l'arrêt ou la
désactivation explicite.

## Architecture

- [Vue complète du système (HTML Bootstrap hors ligne)](docs/system-overview.html)
- [Architecture Pump.fun V1](docs/architecture/pumpfun-v1.md)
- [Contrat API V1](docs/api/v1.md)
- [Qualification RPC](docs/operations/rpc-qualification.md)
- [Manifeste IDL officiel](vendor/pumpfun/idl/manifest.json)

Les montants bruts, réserves et lamports utilisent `bigint`; PostgreSQL les
stocke en `NUMERIC(78,0)` et l'API les expose comme chaînes décimales.
