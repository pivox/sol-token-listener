# Console opérateur Pump.fun

Application React/Vite/Bootstrap publique et indépendante du processus backend.
Elle consomme exclusivement l’API HTTP/SSE V1 en lecture seule. La console ne
demande aucun wallet, aucune clé privée et ne construit, signe ou envoie aucune
transaction. Le libellé permanent `Simulation uniquement` rappelle que le PnL
paper est estimé et qu’il n’existe aucune garantie de profit ou de sellabilité.

## Démarrage local

Depuis la racine du dépôt :

```bash
npm install
npm run build
npm run frontend:dev
```

Le backend écoute par défaut sur `http://127.0.0.1:3000` et Vite sur son port
de développement. Le fichier public `public/config.json` est lu et validé avant
la création de l’application :

```json
{ "apiBaseUrl": "http://127.0.0.1:3000" }
```

Seules les URL absolues HTTP(S), sans credentials, query ni fragment sont
acceptées. Ce fichier est une configuration publique : aucun secret ne doit y
être placé. Une configuration invalide arrête le bootstrap avant toute requête
métier ou connexion SSE.

## Routes produit

- `/` : radar paginé des lancements retenus ;
- `/launches/:mint` : aperçu, timeline, risque, social et détenteurs ;
- `/paper-positions` : positions et PnL paper estimés ;
- `/health` : état public du listener, des workers et checkpoints.

Les montants financiers restent des chaînes décimales et sont formatés via
`bigint`, jamais via des floats JavaScript. Les conditions éliminatoires sont
affichées avant les scores. Une preuve sociale absente ou inconnue reste
explicitement `NOT_AVAILABLE`/`UNKNOWN` et n’est jamais transformée en preuve
d’authenticité.

## Temps réel reprenable

La console utilise `fetch` streaming pour envoyer le dernier curseur de
transport dans `Last-Event-ID`. Elle valide la trame et planifie les
invalidations HTTP avant de persister son `id`; `data.eventId` n’est jamais
utilisé comme curseur. Sur `EVENT_CURSOR_EXPIRED`, elle affiche
`RESYNCING`, efface uniquement le curseur de cette origine/version, recharge
les projections actives puis se reconnecte sans ancien curseur.

Pour un déploiement statique sur une origine différente du backend, l’API doit
autoriser l’origine du frontend et le préflight doit inclure :

```http
Access-Control-Allow-Headers: Last-Event-ID
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
```

Aucune méthode d’écriture n’est requise ou autorisée par l’application.

## Vérification

```bash
npm run check --workspace frontend
npm run lint --workspace frontend
npm test --workspace frontend
npm run build --workspace frontend
npm run frontend:e2e
```

Le test Playwright démarre un mock API/SSE sur une autre origine et vérifie la
reprise, l’expiration de curseur, la resynchronisation et l’absence de requêtes
d’écriture issues du navigateur.

## Déploiement statique

Le build utilise `BrowserRouter`. L’hébergeur ou le proxy doit donc réécrire
toute route inconnue (`/launches/*`, `/paper-positions`, `/health`) vers
`index.html`, tout en servant normalement les assets existants. Sans ce fallback
SPA, un accès direct ou un rafraîchissement d’une route produit retourne 404.
