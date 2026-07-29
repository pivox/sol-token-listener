# sol-token-listener

Backend TypeScript d'observation de tokens Pump.fun et de projections PumpSwap
et paper trading. Il expose aussi une API publique V1 HTTP/SSE, strictement en
lecture seule.

Le listener RPC Pump.fun n'est pas encore composé dans le bootstrap : démarrer
l'application ne souscrit à aucun flux réseau Pump.fun. L'API peut donc servir
des projections PostgreSQL existantes sans prétendre détecter de nouveaux
événements par elle-même. Raydium CPMM demeure un adaptateur secondaire isolé;
son code n'est pas activé par ce bootstrap.

## Sécurité et limites

- `EXECUTION_MODE=observe` est la valeur par défaut; seules les valeurs
  `observe` et `paper` sont admises.
- Aucun wallet ou secret de clé privée n'est accepté, et aucune transaction
  live n'est signée ou envoyée.
- Le paper trading est une projection simulée, initialement limitée à SOL/WSOL
  par allowlist; il ne démontre ni profit ni sellabilité.
- Aucune promesse de première position, même slot, sortie ou profit.
- Le listener RPC est inactif et Raydium CPMM reste non composé.

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
défaut; les exécuter explicitement si nécessaire :

```bash
npm run db:migrate
```

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

## Analytics participants I1

Le service I1 reconstruit de façon déterministe le profil du créateur, ses
achats initiaux, sa première vente, les positions nettes observées et les
concentrations top 1/5/10. Il n'utilise que les trades de bonding curve
persistés depuis la détection du token : il ne consulte ni historique antérieur
ni RPC supplémentaire. Un flux net négatif est conservé comme preuve valide,
pas ramené silencieusement à zéro.

Ce service est passif et n'est pas encore composé dans le bootstrap réseau.
Les clusters, funders communs et wallets liés restent explicitement
`NOT_AVAILABLE` jusqu'à I2. `API_HOLDER_POSITION_LIMIT` et
`API_HOLDER_SNAPSHOT_LIMIT` valent 100 par défaut et sont bornés à 500.
Les projections suivent la rétention terminale de quatre heures.

## Architecture

- [Architecture Pump.fun V1](docs/architecture/pumpfun-v1.md)
- [Contrat API V1](docs/api/v1.md)

Les montants bruts, réserves et lamports utilisent `bigint`; PostgreSQL les
stocke en `NUMERIC(78,0)` et l'API les expose comme chaînes décimales.
