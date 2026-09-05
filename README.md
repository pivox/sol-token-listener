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

## Fondation d'intentions d'exécution (#51-B)

La migration `031_execution_intents.sql` ajoute un ledger PostgreSQL séparé
d'intentions, de tentatives et de transitions, avec identité déterministe,
leases clôturés par révision monotone et rétention terminale réconciliée de
quatre heures. La purge conserve durablement un tombstone anti-rejeu minimal
(identifiants et empreinte seulement, sans mint, wallet, montant ni payload),
afin qu'un ordre logique ne puisse pas être recréé avec des preuves fraîches.
Un mapper pur sait dériver un draft depuis l'événement canonique
`PaperStrategySessionUpdated`, sa qualification et sa quote causale.

L'émission d'intentions est composée dans le listener mais reste strictement
désactivée par défaut avec `EXECUTION_INTENT_EMISSION_ENABLED=false`. Son
activation explicite exige `EXECUTION_MODE=paper` et l'allowlist initiale
SOL/WSOL uniquement ; lorsque le flag reste à `false`, le repository paper ne
reçoit aucun producteur d'intention. Ce chemin n'effectue lui-même aucun
chargement de clé, signature ou envoi. Le lot #51-C livre désormais le dry-run
executor PostgreSQL séparé,
sans construction ni simulation de transaction et sans consommer l'intention.
#51-D livre un second mode executor `simulation-only`, disponible pour produire
une preuve non signée sans soumission. #51-E livre désormais uniquement la
fondation domaine/PostgreSQL de sizing, quota provider, admission, réservation,
réconciliation, compteur de pannes et rétention. Aucun script ni processus
courant ne compose ou n'appelle `admitBuy`, `recordFault`, `reconcile` ou
`recordReconciledSuccess` : cette fondation reste inerte. #51-F livre désormais
un preflight durable, des arrêts opérateur et un armement manuel strictement
inerte. Les gates du preflight doivent être fournis dans une enveloppe Ed25519
signée et liée au déploiement. Ses six commandes `live:*` refusent les secrets et ne sont importées
par aucun worker. #51-G fournit ses briques live isolées et ses protections
PostgreSQL. #51-H2a compose séparément la finalité read-only, et #51-H2b
compose le runtime signable désarmé. H2b ne possède que quatre lanes, dans cet
ordre : recover SELL, execute SELL, recover BUY, execute BUY. H2a conserve
finalité, confirmation, réconciliation et deadline. #51-H2c livre maintenant
les gates, l'armement exact et le lock durable pré-signature dans l'état
`READY_FOR_EXTERNAL_PREFLIGHT`; aucun canary n'a démarré. Les seuls modes du listener restent
`observe` et `paper` ; le processus H2b est un exécutable séparé. Le
[runbook canary #51-G](docs/operations/executor-live-canary.md) décrit les
frontières et l'état non activé.

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
  `observe` et `paper` sont admises pour le listener.
- La configuration par défaut reste `EXECUTOR_MODE=dry-run` et
  `LIVE_TRADING_ENABLED=false`. Elle ne lance aucun exécuteur signable et ne
  contient aucune clé réelle.
- H2b est isolé du listener, de H2a et des commandes H2c ; H2c est préparé mais sa présence ne vaut
  ni armement, ni canary, ni transaction exécutée.
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

## Exécuteur dry-run PostgreSQL (#51-C)

L'exécuteur est un processus séparé, PostgreSQL-only, qui ne requiert ni RPC Solana ni wallet. Il ne charge aucune clé, ne signe rien et ne soumet aucune transaction. Le listener reste limité à `observe`|`paper`; l'exécuteur ne modifie pas ce contrat et le live est impossible dans #51-C.

Après avoir configuré un `DATABASE_URL` PostgreSQL, appliquer ce runbook exact :

```bash
npm run build:backend
npm run db:migrate
EXECUTOR_MODE=dry-run DATABASE_URL=postgresql://... npm run executor:start
```

Les paramètres de ce mode sont `EXECUTOR_MODE=dry-run`, `DATABASE_URL`,
`EXECUTOR_POLL_MS=1000`, `EXECUTOR_LEASE_MS=30000`,
`EXECUTOR_DB_STATEMENT_TIMEOUT_MS=3000`,
`EXECUTOR_SHUTDOWN_GRACE_MS=10000` et `LIVE_TRADING_ENABLED=false`.
La dernière valeur doit rester `false`; aucune clé, keypair, endpoint RPC ou
réglage de signature/soumission ne doit être ajouté à l'environnement de ce
mode PostgreSQL-only.

### Récupération de finalité live read-only (#51-H2a)

Le processus séparé `executor:live:recovery:start` confirme et réconcilie les
soumissions déjà persistées, puis crée les intentions SELL arrivées à échéance.
Il ne charge aucune clé privée, ne signe et ne soumet aucune transaction. Il
utilise une session RPC bornée par passe dans l'ordre réconciliation,
confirmation, échéance.

Sa connexion PostgreSQL utilise un login de déploiement dédié et non hérité,
membre uniquement du rôle `sol_token_executor_live_recovery`. Le runtime
applique ce rôle à chaque checkout. Ses ACL et ses façades minimales lui
interdisent les bytes signés ainsi que toute mutation de signature,
simulation signée, préflight ou soumission.

Sa configuration exacte et la commande avec fichier d'environnement dédié
sont documentées dans
[`docs/operations/executor-live-canary.md`](docs/operations/executor-live-canary.md).
Le fichier d'environnement H2a ne doit contenir aucun nom de variable de
keypair ou de secret wallet, même avec une valeur vide. Ce runtime ne constitue
ni un armement, ni un canary exécuté, ni une validation du trading live.

### Runtime signable désarmé (#51-H2b)

Les commandes séparées `npm run executor:live:dev` et
`npm run executor:live:start` composent le runtime H2b. Une passe ne contient
exactement que recover SELL, execute SELL, recover BUY, execute BUY ; elle
s'arrête après le premier résultat `WORKED`. H2b récupère ou exécute les
artefacts durablement admissibles, mais ne confirme, ne réconcilie et ne crée
aucune sortie à deadline : ces responsabilités restent dans H2a.

La configuration exemple est volontairement désarmée (`EXECUTOR_MODE=dry-run`,
`LIVE_TRADING_ENABLED=false` et aucun chemin de keypair réel) : elle ne permet
pas de démarrer H2b. La publication de ces commandes n'exécute ni
`live:resume`, ni `live:arm`, ni un canary. H2c fournit séparément la procédure
manuelle, les gates et l'armement opérateur exact ; aucune clé réelle n'est
fournie dans le dépôt.

L'état actuellement documentable est strictement :

```text
LIVE_SIGNABLE_RUNTIME_COMPOSED
READY_FOR_EXTERNAL_PREFLIGHT
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```

### Préparation opérateur exacte (#51-H2c)

H2c lie un sidecar Ed25519 frais, une intention BUY exacte, les snapshots
wallet/provider, les limites du runtime et une réservation d'exposition dans
un armement V2 atomique. Avant la première signature BUY, H2b persiste un lock
contenant les octets non signés exacts. Un lock abandonné ou toute ambiguïté
déclenche `ENTRY_STOP` sans contacter le signer ni le RPC.

Les commandes `live:*` utilisent un login PostgreSQL dédié, membre uniquement
de `sol_token_executor_operations`; chaque checkout impose ce rôle et un
`search_path` fermé. Le listener, l'API, H2a et ce rôle opérations ne peuvent
pas lire les bytes signés ni accéder au keypair. La séquence complète, les
points d'arrêt humains et les preuves à conserver sont dans le
[runbook canary](docs/operations/executor-live-canary.md).

Pour chaque intention `PENDING` ou `RETRY_READY` éligible, #51-C enregistre
une assessment déterministe `FOUNDATION_VALIDATED` à couverture
`INTENT_AND_LEASE_ONLY`. Ses gates sont `NOT_RUN` pour la quote, `NOT_RUN` pour
la construction, `NOT_RUN` pour la simulation, `NOT_RUN` pour la signature et
`NOT_RUN` pour la soumission. Ce rapport n'est ni une simulation Solana ni un
`PASS` de trading : il ne consomme pas l'intention, ne crée ni tentative ni
transition, et libère seulement son lease technique. L'intention reste donc
disponible pour le mode #51-D de quote, build et `simulateTransaction` ; les
étapes #51-E à #51-G ne sont pas livrées par ce processus.

### Exécuteur `simulation-only` sans signature (#51-D)

#51-D livre un mode séparé qui produit une preuve de quote, de build non signé
et de simulation Solana. Il est disponible sans capacité live, signature ou
soumission. Sa configuration publique est :

```dotenv
EXECUTOR_MODE=simulation-only
EXECUTOR_LEASE_MS=35000
EXECUTOR_DB_STATEMENT_TIMEOUT_MS=3000
EXECUTOR_PUBLIC_KEY=<ADRESSE_PUBLIQUE_BASE58>
EXECUTOR_RPC_PROVIDER_ID=primary
SOLANA_HTTP_RPC_URL=https://<endpoint-qualifie>
SOLANA_EXPECTED_GENESIS_HASH=<HASH_GENESIS_BASE58_VERIFIE>
EXECUTOR_QUOTE_MAX_AGE_MS=3000
EXECUTOR_SLIPPAGE_BPS=500
EXECUTOR_SNAPSHOT_MAX_SLOT_LAG=8
EXECUTOR_MAX_COMPUTE_UNITS=300000
EXECUTOR_MAX_FEE_LAMPORTS=100000
EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT=2500000
EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS=0
EXECUTOR_RPC_TIMEOUT_MS=5000
EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT=8
LIVE_QUOTE_MINT_ALLOWLIST=So11111111111111111111111111111111111111112
LIVE_TRADING_ENABLED=false
```

`EXECUTOR_PUBLIC_KEY` est seulement l'adresse d'un compte public, pas un wallet
connecté. Ce compte doit être financé extérieurement en SOL natif pour un BUY,
les frais et la rent, et détenir les base tokens nécessaires pour un SELL. Le
builder n'admet que les branches ATA idempotentes attendues. Pour un SELL
PumpSwap WSOL, il inspecte la création éventuelle de l'ATA WSOL et le
`CloseAccount` terminal exact du SDK audité ; aucun wrap/unwrap auxiliaire,
signer additionnel ou compte arbitraire n'est accepté.

Chaque tentative reste sur un seul endpoint positionnel. Elle vérifie le hash
de genesis attendu, n'effectue ni retry automatique ni failover au milieu de
quote → build → simulation, et échoue fermé sur timeout, 429 ou réponse
invalide. Le lease doit couvrir trois timeouts RPC séquentiels, les cinq phases
bornées du renouvellement PostgreSQL (acquisition, `BEGIN`, verrouillage,
`UPDATE`, `COMMIT`) et une marge fixe de 1 seconde ; une configuration plus
courte est rejetée. Le défaut `simulation-only` est donc 35 secondes ; le
défaut historique `dry-run` reste 30 secondes.
La simulation utilise une transaction v0 éphémère avec une signature
nulle, `sigVerify=false` et aucune méthode d'envoi. Le message, la transaction
et les instructions sérialisées ne sont jamais persistés.

Une simulation réussie termine l'intention `simulation-only` et écrit un
artefact versionné non signable. Cet artefact ne pourra jamais être repris pour
signer ou envoyer la transaction : une future exécution armée devra créer une
nouvelle intention et refaire quote, build et simulation sous les gates alors
applicables. Aucun secret n'est accepté et aucun `signTransaction`,
`sendTransaction` ou mode live n'existe dans ce graphe.

La validation terrain #49 des 50 positions Mainnet a été sautée : son statut
reste explicitement `NON_EXECUTED` et `NON_VALIDATED`, jamais `PASS`. La
fondation #51-E et le preflight inerte #51-F ne changent pas ce statut et
n'activent aucun canary ni validation économique. Le runtime H2b composé reste
désarmé ; le [runbook canary](docs/operations/executor-live-canary.md) conserve
la frontière avec H2a et H2c.

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

Renseigner `SOLANA_HTTP_RPC_URL`, `SOLANA_WS_RPC_URL`, `DATABASE_URL` et, lorsque
`LISTENER_ENABLED=true`, `SOLANA_EXPECTED_GENESIS_HASH`, sans secret de wallet.
Cette dernière valeur est le hash de genèse canonique base58 de 32 octets du
cluster ciblé : l’opérateur l’obtient avec `getGenesisHash` auprès de plusieurs
sources de confiance et compare les résultats avant le déploiement. Le listener
ne l’apprend jamais pendant son démarrage et ne l’écrit jamais dans les logs.
Pour un basculement HTTP optionnel en production, définir
`SOLANA_HTTP_RPC_FALLBACK_URLS` comme une liste ordonnée séparée par des
virgules de maximum trois fallbacks; l'endpoint principal reste
`SOLANA_HTTP_RPC_URL`, les doublons canoniques sont refusés et toutes les URLs
HTTP doivent utiliser le même schéma.
Sans fallback, le comportement single-endpoint web3.js et son rate-limit retry
restent exactement inchangés. Avec des fallbacks, la rotation est limitée aux
rejets réseau et aux statuts 429/502/503/504; elle ne s'applique ni aux autres
4xx, ni à une erreur JSON-RPC en HTTP 200, ni à un résultat archive `null`.
Le superviseur WebSocket actif utilise la même chaîne positionnelle HTTP/WS :
`primary`, puis `fallback-1` à `fallback-3`, sans exposer les URL. Les événements sans secret `rpc.http_endpoint_degraded`,
`rpc.http_failover` et `rpc.http_endpoints_exhausted` sont la source des
métriques V1 dérivées des logs. Voir le [guide d'exploitation RPC](docs/operations/rpc-qualification.md)
pour les délais de refroidissement, les limites et la qualification mono-fournisseur du soak.

## Finalité affine au fournisseur (#61, v1.0.9, migrations 027–030)

La finalité utilise un pass HTTP épinglé au fournisseur promu : statuts,
racine <code>finalized</code> et signatures du bloc sont toujours lus par ce
même fournisseur, sans failover HTTP. Si ce fournisseur ou le bloc finalized
exact est indisponible, le slot concerné reste nonterminal et ne produit jamais
<code>orphaned</code>. Les autres slots de la passe continuent séquentiellement,
dans la limite de 16, puis le composant signale <code>DEGRADED</code> et réessaie
à l’intervalle suivant en mode observe.
L’orphaning exige N statuts absents consécutifs du même fournisseur, une racine
finalized strictement supérieure au slot, le bloc finalized exact disponible et
l’absence de la signature dans ce bloc. Un changement de fournisseur remet le
compteur à 1. La preuve durable conserve l’identifiant public positionnel du
fournisseur, le compteur et une version ; chaque transition est un CAS exact.
La page bornée est ordonnée par la dernière tentative durable
<code>updated_at</code>. Chaque poll avance cette horloge avec le temps PostgreSQL
en plus du temps observé, de sorte qu’une ligne durablement indisponible tourne
derrière les autres candidates au lieu de monopoliser la première page.

Au bootstrap, observe et paper restent visibles en <code>DEGRADED</code> pendant
une indisponibilité initiale et programment une reprise bornée. Paper reste
fermé tant que le superviseur n’est pas <code>RUNNING</code>, qu’aucun fournisseur
n’est promu, ou qu’une passe de finalité courante n’a pas réussi sur ce même
fournisseur. La barrière est vérifiée avant chaque claim et mutation paper ;
elle ne crée aucun chemin d’exécution réelle.

Avant toute simulation, la lignée paper vérifie aussi le replay de finalité
jusqu’au curseur source complet. Toutes les raw antérieures ou égales sont
incluses, même orphaned : leur pipeline peut avoir rétracté la raw avant
d’échouer sur une projection ultérieure, tandis que l’inbox reste non traitée.
Le claim et la barrière examinent au plus 4 097 raw par job, tous statuts
confondus, refusent au-dessus de 4 096 et utilisent un index couvrant complet
dont la borne cursor est une condition d’index, sans scan, tri complet ni join
filter du mint. Une inbox présente reste autoritaire : elle doit être
<code>PROCESSED</code> et exactement alignée. Après sa purge terminale à quatre
heures, une raw <code>finalized</code> ou <code>orphaned</code> peut utiliser une
receipt durable exacte écrite atomiquement par le replay; une preuve absente ou
nonterminale reste fermée. Les verrous de lecture sont conservés jusqu’au
commit. La receipt sert aussi de tombstone terminale : une découverte finalized
identique après purge est un no-op, tandis qu’une notification après tombstone
orphaned ou une identité divergente est refusée; avant purge, un doublon
finalized terminal peut seulement enrichir ses sources/programmes et ne change
jamais la cible, la version de preuve, le timestamp traité ou la receipt. Toute
révision <code>PENDING</code>/<code>PROCESSING</code>/
<code>FAILED</code> ou décalée produit donc un retry sans candidate, session,
position ni trade. Les sources <code>confirmed</code> alignées restent autorisées.

À la version maximale de preuve, polls manquants et orphaning restent refusés,
mais une vraie transition <code>confirmed → finalized</code> est rejouée en
conservant la version saturée, sans addition susceptible de dépasser
<code>BIGINT</code>.

Pour le rollout de `027_listener_provider_affine_finality.sql`, arrêter les
anciennes réplicas avant d’appliquer la migration, puis démarrer le nouveau
binaire. La migration est rejouable et remplace l’index partiel de finalité par
<code>(updated_at, observed_slot, signature)</code>. Les identifiants de
fournisseur sont publics et positionnels ; les URLs restent secrètes. Cette
capacité reste observe/paper uniquement : aucune signature ni soumission de
transaction n’est ajoutée. La migration
`028_paper_finality_replay_evidence.sql`, également rejouable, ajoute la receipt
durable pour les deux états terminaux `finalized` et `orphaned`, ainsi que
l’index couvrant de la barrière, sans prolonger la rétention de l’inbox au-delà
de quatre heures. `029_paper_finality_claim_scheduler.sql` ajoute une génération
monotone durable et un index d’échéance effectif : chaque claim verrouille au
plus seize jobs avant les jointures de replay, annule les leases épuisés de ce
seul lot, réclame le premier job prêt et fait tourner uniquement les jobs
bloqués, même si plusieurs appels partagent exactement le même timestamp.

Les migrations ne sont pas lancées automatiquement par
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

La validation terrain Issue #49 des 50 positions Mainnet reste non exécutée et
non validée; elle ne constitue donc ni une preuve de préparation opérationnelle
ni de profitabilité. Le produit reste observe/paper only, sans wallet, signature
ni soumission de transaction.

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

### Santé WebSocket durable

Le backend actif ajoute l’objet requis `heartbeat.websocket`; le client le garde
optionnel pendant un déploiement progressif. Il publie les cinq états publics
`STOPPED`, `CONNECTING`, `ACKNOWLEDGED`, `RECOVERING` et `DEGRADED`, la phase
détaillée, des identifiants de fournisseur uniquement positionnels
(`primary`, `fallback-1`, `fallback-2`, `fallback-3`) et des reason codes
fixes. La fraîcheur du heartbeat WebSocket est limitée à 30 secondes et les
preuves résolues sont supprimées après quatre heures. Une erreur stricte non
résolue dégrade la santé ; `heartbeat.lastSignature` reste toujours `null`.

La dernière observation est un diagnostic après mise en file durable, pas une
preuve de continuité ni une frontière de complétude. Le slot PostgreSQL
`NUMERIC` est décodé comme un entier mathématique, tandis que les champs
`BIGINT` restent strictement canoniques. Un `disconnectReasonCode` non nul
signale un nouvel incident, même si le code est identique au précédent ;
`disconnectReasonCode=null` conserve la preuve déjà persistée. La cadence des
touches reste indépendante de la latence de persistance avec une seule relance
coalescée. La projection est calculée depuis un snapshot cohérent et son
horloge de fraîcheur est capturée après les lectures.

Le superviseur est `ACTIVE` : il acquiert d’abord son propriétaire durable,
attend le double ACK Pump.fun/PumpSwap, exécute ensuite une frontière stricte
HTTP des deux programmes avant de publier `RUNNING`. Il lance une vérification
de frontière périodique toutes les 30 secondes. Une rotation parcourt une fois
les fournisseurs positionnels et applique un equal jitter borné de 1–60 secondes
après un cycle transitoire. Seule une frontière strictement identique et
dépassée auprès de tous les fournisseurs conduit à `UNRECOVERABLE`; tout cycle
mixte reste `DEGRADED`. Aucun fallback legacy automatique n’est disponible :
un même processus ne revient jamais à `SolanaProgramSubscriber`. Cette
projection n’expose ni matériel de connexion ni capacité d’exécution.
`SOLANA_EXPECTED_GENESIS_HASH` est vérifié avant toute connexion lorsque le
listener est activé et n’est jamais exposé par cette santé.

## Architecture

- [Vue complète du système (HTML Bootstrap hors ligne)](docs/system-overview.html)
- [Architecture Pump.fun V1](docs/architecture/pumpfun-v1.md)
- [Contrat API V1](docs/api/v1.md)
- [Qualification RPC](docs/operations/rpc-qualification.md)
- [Preflight executor inerte](docs/operations/executor-preflight.md)
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
