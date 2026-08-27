# sol-token-listener

Backend TypeScript d'observation de tokens Pump.fun et de projections PumpSwap
et paper trading. Il expose aussi une API publique V1 HTTP/SSE, strictement en
lecture seule.

Le listener durable Pump.fun/PumpSwap est composé et activé par défaut. Il
combine souscriptions WebSocket, rattrapage HTTP borné, inbox PostgreSQL avec
leases et réconciliation de finalité. Raydium CPMM demeure un adaptateur
secondaire isolé; son code n'est pas activé par ce bootstrap.

Le parcours paper E2E est opt-in. Après une qualification sans blocker, un
worker durable produit un candidat, ouvre une position simulée, compte les
achats externes confirmés après l'entrée puis cote et simule la sortie. Avec
`creation-entry-v1`, un wallet distinct n'est compté qu'une fois et seulement
au-dessus du montant brut minimal configuré. La
venue de cotation est Pump.fun tant que la bonding curve est active, puis le
pool PumpSwap canonique après graduation. Aucun de ces chemins ne construit,
ne signe ou n'envoie une transaction Solana.

Configuration minimale de la stratégie de création, toujours simulée :

```dotenv
EXECUTION_MODE=paper
CREATION_STRATEGY_ENABLED=true
PAPER_STRATEGY_ENABLED=false
PAPER_ENTRY_QUOTE_AMOUNT_RAW=10000000
PAPER_SLIPPAGE_BPS=500
PAPER_QUOTE_MINT_ALLOWLIST=So11111111111111111111111111111111111111112
EXTERNAL_UNIQUE_BUYERS_TARGET=10
EXTERNAL_MIN_BUY_AMOUNT_RAW=1000000
CREATION_TAKE_PROFIT_MULTIPLIER_BPS=20000
CREATION_MANUAL_KILL_SWITCH=false
QUALIFICATION_PROFILE_PATH=config/qualification/pumpfun-v1-unvalidated.json
RISK_MAX_ROUNDTRIP_LOSS_BPS=3000
```

L'entrée expire 45 secondes après l'observation de la création et reste soumise
à la qualification canonique sans blocker, aux deux quotes et à la simulation
aller-retour. Les sorties sont arbitrées dans l'ordre : kill switch, vente du
créateur, ×2 exécutable, puis cible de wallets uniques. Le ×2 utilise
`minimumAmountOutRaw` d'une quote SELL sur la position complète, pas un prix
théorique. Une quote indisponible conserve la cause de sortie en attente. Cette
première mesure d'unicité ne détecte pas encore les Sybil ou clusters liés.

## Profil de qualification Pump.fun

Le profil chargé par défaut est
`config/qualification/pumpfun-v1-unvalidated.json`. On peut sélectionner un
fichier local différent avec `QUALIFICATION_PROFILE_PATH`; `QUALIFICATION_MIN_SCORE`
remplace le minimum effectif lorsqu'il est défini (de 0 à 100). En son absence,
le minimum du profil sélectionné est conservé; celui du profil initial vaut 60. Le
profil initial porte le statut `UNVALIDATED_RULE_SET`: c'est une calibration
initiale NONVALIDATED, pas une calibration officiellement ou
empiriquement validée.

Le chargeur construit un fingerprint SHA-256 du profil canonique effectif,
donc y compris le remplacement `QUALIFICATION_MIN_SCORE`; le fingerprint est
hexadécimal lowercase. Un profil illisible ou invalide fait échouer le
démarrage fail-closed avant l'ouverture de PostgreSQL, du listener ou de
l'API. Le journal ne publie que l'identité, la version, le statut, le
fingerprint et le minimum effectif: il redacte l'erreur et ne journalise ni le
chemin ni le contenu du profil.

Exemple de configuration local, sans secret :

```dotenv
QUALIFICATION_PROFILE_PATH=config/qualification/pumpfun-v1-unvalidated.json
QUALIFICATION_MIN_SCORE=
```

Pour dépanner, corriger le JSON local ou retirer l'override puis redémarrer;
ne copiez jamais son chemin ou son contenu dans les logs. Une valeur de score
n'est pas une instruction de trading: l'application reste observe/paper only,
sans clé privée, signature, soumission ni live; elle n'appelle ni
`sendTransaction` ni `signTransaction`.

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
- Les métadonnées et liens sociaux ne sont que des signaux de préparation et
  d'authenticité : ils ne prouvent jamais le sérieux, la sellabilité ou le
  potentiel de profit d'un token.
- Raydium CPMM reste non composé.

## Installation

Prérequis : Node.js 22.13+ et PostgreSQL. Le déploiement conteneurisé de
référence épingle Node.js 22.22.0 par digest.

```bash
npm install
cp .env.example .env
npm run build
npm run check
npm run lint
npm test
```

## Console frontend indépendante

Le workspace `frontend/` fournit maintenant la console opérateur React/Vite
publique en lecture seule. Elle se déploie comme un artefact statique séparé,
lit son `apiBaseUrl` dans `frontend/public/config.json`, puis consomme les huit
projections JSON et le flux SSE reprenable. Ses routes produit sont le radar
`/`, la fiche `/launches/:mint`, les simulations `/paper-positions` et la santé
`/health`.

```bash
npm run frontend:dev
npm run frontend:e2e
```

La console ne charge aucun wallet et ne propose aucune action de trading. Elle
affiche les blockers avant les scores, les absences de preuve explicitement et
un statut visible lors d’une resynchronisation SSE. Voir le
[guide frontend](frontend/README.md).

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
de fenêtre, worker inbox, worker social public, réconciliation de finalité,
heartbeat, puis API. Un échec
de dépendance ou de composant interrompt le
démarrage et ferme les ressources déjà ouvertes. `LISTENER_ENABLED=false`
désactive explicitement le listener et expose un pipeline `STOPPED` si l'API
reste active.

Le WebSocket est le chemin nominal. Sans checkpoint, le premier rattrapage
prend une seule page récente comme baseline au lieu de parcourir l'historique.
Après l'ouverture des souscriptions, un second rattrapage ferme la fenêtre de
course et converge par l'inbox idempotente. La politique V1 par défaut,
`LISTENER_CATCH_UP_POLICY=live-edge`, lit au plus une page de
`LISTENER_CATCH_UP_PAGE_SIZE` signatures par programme et par scan. Si un
checkpoint ancien n'est plus dans cette page, aucune transaction historique
abandonnée n'est publiée comme nouvelle : le listener persiste atomiquement
la lacune pendant quatre heures, déplace son checkpoint au bord courant et
émet `listener.catch_up_gap_recorded` sans signature ni URL RPC. La politique
`strict` conserve le parcours borné à `LISTENER_CATCH_UP_MAX_PAGES` pages et
échoue avec `CATCH_UP_WINDOW_EXCEEDED` si la frontière reste introuvable.

Une panne retryable est replanifiée avec un
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

## Dry run paper borné

Le dry run démarre le bootstrap réel avec `EXECUTION_MODE=paper` et
`PAPER_STRATEGY_ENABLED=true`, observe une fenêtre de 5 à 3 600 secondes, lit
au plus 1 000 sessions mises à jour pendant cette fenêtre, puis ferme le
listener avec le même chemin logique qu'un `SIGTERM`. Il écrit une seule fois
un fichier JSON en mode création exclusive (`0600`) : un fichier existant
n'est jamais écrasé.

La configuration paper reste volontairement explicite : profil de
qualification, perte aller-retour maximale, montant d'entrée, slippage et
allowlist quote mint. Exemple à adapter avant un essai :

```bash
EXECUTION_MODE=paper \
PAPER_STRATEGY_ENABLED=true \
QUALIFICATION_PROFILE_PATH=config/qualification/pumpfun-v1-unvalidated.json \
RISK_MAX_ROUNDTRIP_LOSS_BPS=3000 \
PAPER_ENTRY_QUOTE_AMOUNT_RAW=1000000 \
PAPER_SLIPPAGE_BPS=100 \
npm run paper:dry-run -- \
  --duration-seconds=60 \
  --max-sessions=100 \
  --report-file=paper-dry-run.json
```

Le rapport `paper-dry-run.v1` ne contient que les timestamps, les compteurs
de sessions et positions, les états, les indisponibilités de quote et le PnL
agrégé par quote mint sous forme de chaînes décimales. Il ne contient ni URL
RPC/DB, ni transaction, signature, contenu social brut ou message d'erreur.
`NO_CLOSED_POSITION` est un résultat de couverture valide, pas une panne
technique. Un rapport dry run ne prouve ni profit, ni sellabilité.

## Validation paper MVP Mainnet

La commande reprenable `paper:mvp` exécute le même bootstrap production et la
stratégie `creation-entry-v1`; elle n'ajoute ni moteur de trading, ni wallet,
ni signature ou soumission. Elle refuse de démarrer avant toute ressource si
le cluster n'est pas exactement `mainnet-beta`, si le listener ou la stratégie
de création sont désactivés, si le mode n'est pas `paper`, ou si l'allowlist
quote n'est pas exactement le seul mint WSOL configuré.

Après application des migrations, lancer avec les six arguments fermés :

```bash
npm run paper:mvp -- \
  --target-closed=50 \
  --max-duration-seconds=14400 \
  --poll-seconds=5 \
  --initial-capital-raw=1000000000 \
  --network-fee-raw-per-transaction=5000 \
  --report-file=paper-mvp.json
```

Un seul processus collecte un run à la fois; il acquiert le verrou avant le
démarrage du listener ou de l'API et échoue fermé si la session du verrou est
perdue. Un redémarrage reprend uniquement
le run `RUNNING` dont la configuration immuable est identique; tout autre run
actif ou second collecteur échoue explicitement. Les créations observées sont
les mints distincts de `token_launches.detected_at` dans la fenêtre. Les entrées
rejetées sont les mints distincts de cette fenêtre ayant produit au moins une
projection candidate `CREATION_ENTRY_REJECTED` ou `CREATION_ENTRY_EXPIRED` pour
la stratégie/version. Une régression de ces projections retenues est une panne
technique fail-closed, jamais un compteur inventé.

La reprise compare la configuration effective durable v3 : taille d'entrée,
slippage, finalité, fenêtres/limites de quote et de slot, minimum d'achat,
seuils de sortie, kill switch, risque aller-retour, paramètres du worker et
fingerprint du profil de qualification. Les anciens runs v1/v2 sont refusés
sans backfill afin de ne jamais mélanger des échantillons non comparables.

La cible, la deadline, `SIGINT` et `SIGTERM` déclenchent une dernière collecte
quand elle reste faisable. Le rapport terminal est recalculé depuis le snapshot
PostgreSQL durable et revérifié dans la transaction de terminalisation avant
son export JSON exclusif en mode `0600`. Le code de sortie vaut `0` uniquement
pour `PASS`, `2` pour un résultat terminal `FAIL`/`DEGRADED`, et `1` pour une
panne de configuration, de données, de ressource ou d'export. L'adaptateur
provider par défaut publie honnêtement `UNAVAILABLE` avec crédits inconnus :
zéro réponse 429 ne constitue alors aucune preuve de santé et empêche `PASS`.

PostgreSQL et le fichier ne peuvent pas être validés atomiquement. Si la
création exclusive du fichier échoue, le résultat terminal reste immuable dans
`paper_mvp_runs.report_payload`; ne relancez pas la collecte. Exportez ce JSON
déjà durable vers un nouveau chemin, toujours en création exclusive, puis
vérifiez son contenu/hash. Voir le
[runbook paper MVP](docs/operations/paper-mvp-validation.md).

## API V1

L'API est activée par défaut (`API_ENABLED=true`) et écoute sur
`127.0.0.1:3000` par défaut. Les variables `API_HOST` et `API_PORT` contrôlent
l'écoute. Utiliser une adresse accessible publiquement est un choix de
déploiement explicite : l'API n'est pas authentifiée et doit être placée
derrière les contrôles réseau/TLS appropriés.

Les huit routes JSON sont `launches`, détail/timeline/risk/social/holders d'un
lancement, `paper-positions` et `health`; `/api/v1/events` est le flux SSE.
Les montants et `bigint` sont des chaînes décimales. La projection sociale vaut
`NOT_AVAILABLE` avant la première collection canonique, puis `AVAILABLE` avec
un `collectionStatus` `COMPLETE`, `PARTIAL` ou `FAILED`, des preuves typées et
des limites/troncatures explicites. La projection holders devient
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

Le détail d'un lancement expose de façon additive le candidat paper courant et
la progression de la stratégie. Les positions exposent leur lignée de
qualification, le nombre d'acheteurs externes, leur venue d'entrée
`PUMP_FUN_BONDING_CURVE`, `PUMPSWAP` ou `UNKNOWN`, et des reason codes stables.
La santé sépare `pipeline.paperDecision` et `paperDecisionJobs`. Les événements
SSE `TradingCandidateUpdated`, `PaperStrategySessionUpdated` et
`PaperExternalBuyCounted` sont des résumés bornés : aucune quote complète ni
liste exhaustive de trades n'est publiée.

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
contrats stables et sont `REPORT_ONLY` pendant le calibrage dry run : leurs
preuves et déclenchements sont rapportés, mais ils ne peuvent ajouter aucun
blocker ni modifier le verdict ou la décision paper.

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

Les métadonnées et preuves sociales publiques utilisent un transport HTTP
borné qui revalide DNS et redirections afin d'écarter les destinations privées.
Le worker ne dépend d'aucune API payante X ou Telegram, ni token, cookie ou
proxy. Il persiste uniquement des URL normalisées, empreintes et preuves
structurées : aucun corps HTTP brut, header, résultat DNS ou adresse IP. Les
collections et jobs sociaux terminaux sont conservés quatre heures puis purgés
dans l'ordre des dépendances.

`GET /api/v1/health` publie l'état courant des composants, le backlog, les
leases, le compteur `exhaustedCount`, `pipeline.social`, les compteurs
`socialJobs`, checkpoints et slots observés, sans URL
RPC/DB ni secret. `RUNNING`
exige tous les composants actifs; une dépendance, un heartbeat périmé ou un
nettoyage incomplet produit `DEGRADED`; `STOPPED` désigne l'arrêt ou la
désactivation explicite.

## Architecture

- [Vue complète du système (HTML Bootstrap hors ligne)](docs/system-overview.html)
- [Architecture Pump.fun V1](docs/architecture/pumpfun-v1.md)
- [Contrat API V1](docs/api/v1.md)
- [Qualification RPC](docs/operations/rpc-qualification.md)
- [Guide de déploiement](docs/operations/deployment.md)
- [Manifeste IDL officiel](vendor/pumpfun/idl/manifest.json)

## Déploiement de référence

Le compose de référence démarre une seule application listener, un worker de
rétention et un frontend same-origin ; PostgreSQL et l’API backend restent
privés. Il est strictement observe/paper : il ne charge aucun wallet, ne signe
et n’envoie aucune transaction. Le worker conserve les données terminales 4
heures et les purge à cadence bornée. TLS externe et sauvegarde externe restent
sous la responsabilité de l’opérateur.

Avant une livraison, exécuter le smoke isolé puis suivre le
[guide de déploiement](docs/operations/deployment.md) pour les secrets, la
migration, le rollback et l’arrêt :

```bash
npm run deployment:smoke
```

Le déploiement est limité à un réplica unique. Il n’offre aucune promesse de
première position, de sellabilité ou de profit ; le smoke ne contacte aucun RPC
mainnet et ne constitue pas une validation de performance.

Les montants bruts, réserves et lamports utilisent `bigint`; PostgreSQL les
stocke en `NUMERIC(78,0)` et l'API les expose comme chaînes décimales.
