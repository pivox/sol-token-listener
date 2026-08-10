# Architecture Pump.fun V1

## Périmètre produit

Le flux principal cible :

```text
création Pump.fun
  -> token + bonding curve
  -> métadonnées et preuves sociales publiques
  -> créateur et premiers wallets depuis la détection
  -> suivi de courbe
  -> qualification expliquée
  -> paper trading
  -> graduation
  -> pool PumpSwap canonique
```

La V1 n’analyse pas l’historique antérieur du créateur. Elle commence à
l’arrivée du token et conserve les événements nécessaires jusqu’à la fermeture
du suivi. L’observation accepte plusieurs quote mints ; le paper trading est
initialement limité à SOL/WSOL par `PAPER_QUOTE_MINT_ALLOWLIST`.

## Runtime durable

La PR C épingle l’IDL officiel Pump.fun au commit
`9c82f61cb711b044a17f770ab8ce9f9bdf78f333` et décode localement `create`,
`create_v2`, `buy`, `buy_v2`, `buy_exact_sol_in`,
`buy_exact_quote_in_v2`, `sell` et `sell_v2`. Les montants réels, réserves et
frais viennent exclusivement des événements CPI `CreateEvent` et `TradeEvent`
appairés ; aucun delta global de transaction n’est utilisé comme estimation.

L’observation multi-quote est conservée (SPL Token et Token-2022), tandis que
le paper trading reste limité à SOL/WSOL par configuration. Le décodeur ne fait
aucun appel RPC à l’exécution. `PumpFunLaunchpadAdapter` est composé dans le
listener d'observation; il ne construit, ne signe et ne soumet aucun ordre.
Raydium CPMM demeure un adaptateur secondaire isolé et testé.

La PR G ajoute un pipeline passif et invocable :

```text
Pump migration observed
  -> preuve create_pool PumpSwap dans la même portée CPI
  -> validation du compte et du PDA canonique index 0
  -> MIGRATION_PENDING -> PUMPSWAP_ACTIVE
  -> réserves, trades et quotes paper passifs
```

Le bootstrap compose une interface `node:http` publique et non authentifiée, en
lecture seule, avec huit routes JSON versionnées sous `/api/v1` et le flux SSE
`/api/v1/events`. Il démarre d'abord le listener durable Pump.fun/PumpSwap :

```text
health RPC -> baseline bornée -> WebSocket -> catch-up de fermeture
           -> worker inbox
           -> réconciliation de finalité -> heartbeat -> API
```

Il ne compose ni wallet, ni exécution live, ni envoi de transaction. `observe`
et `paper` restent les seuls modes.
Raydium CPMM reste un adaptateur secondaire non composé dans ce bootstrap.

La projection sociale n'est pas encore produite et répond explicitement
`NOT_AVAILABLE`. I1 introduit une reconstruction passive des participants à
partir des seuls trades Pump.fun persistés depuis la création. La route holders
reste `NOT_AVAILABLE` avant reconstruction, puis expose le profil créateur,
les positions nettes observées et la concentration top 1/5/10. Elle ne prétend
pas être un état exhaustif des comptes token. I2 peut ensuite exposer un graphe
observé ; il reste `NOT_AVAILABLE` tant que sa reconstruction n'a pas eu lieu.
Le pipeline actif enchaîne launchpad, financement, I1, I2 et PumpSwap. L’API ne
formule aucune garantie de profit, de même slot ou de sellabilité.

## Dépendances autorisées

```text
domain <- ports <- application <- adapters
                              <- interfaces HTTP/SSE

infrastructure Solana/PostgreSQL -> application
bootstrap -> composition observation-only
```

- `domain` ne dépend d’aucun programme Solana concret ;
- `ports` dépend uniquement du domaine ;
- chaque adaptateur dépend de son port et de l’infrastructure ;
- Pump.fun, PumpSwap et Raydium ne s’importent jamais entre eux ;
- aucune dépendance de signature ou d’envoi n’est accessible depuis le
  bootstrap.

## Modules cibles

| Module | Responsabilité |
| --- | --- |
| `LaunchpadAdapter` | créations, paramètres, trades pré-migration, état et fin de courbe |
| `MarketAdapter` | pool post-migration, réserves effectives, quotes et swaps |
| `MetadataProvider` | URI on-chain, JSON, médias, liens, snapshot immuable |
| `SocialVerificationProvider` | preuves publiques typées, jamais un booléen opaque |
| `CreatorProfiler` | activité observée depuis la détection et ventes précoces |
| `WalletGraphAnalyzer` | funders communs, relations, clusters et concentration |
| `QualificationEngine` | scores configurables, blockers, verdict et preuves |
| `PaperTradingEngine` | entrée/sortie simulées, frais, slippage et PnL estimé |
| API HTTP/SSE | projections publiques V1, non authentifiées et en lecture seule |

Le `PaperTradingEngine` reçoit l’`EffectiveQualificationProfile` déjà chargé
comme autorité de politique et une `QualificationReportAuthority` process-local
portée par le `QualificationEngine` qui produit les rapports. Il ne relit aucun
fichier : avant toute transaction paper, il exige la référence exacte d’un
rapport autorisé pour le même mint et le même événement déclencheur, puis
compare l’identité du ruleset ainsi que les modes et seuils des conditions aux
policies du profil. Pour les policies `ENFORCED`, il exige également une
simulation BUY réussie, une quote SELL disponible, un loss observé égal au loss
recalculé et le respect du plafond round-trip du profil ; `REPORT_ONLY` reste
non bloquant et `DISABLED` n’exige pas d’observation. Une copie,
désérialisation ou réutilisation pour un autre
sujet est donc refusée. Après redémarrage, les inputs de confiance doivent être
réévalués pour le nouveau sujet ; le paper trading n’est pas encore composé dans
le bootstrap de production.

### Analytics participants I1

`LaunchParticipantAnalyticsService` charge, sous verrou PostgreSQL par mint,
la création et les trades de bonding curve non orphaned déjà persistés. Les
analyseurs purs reconstruisent ensuite un profil créateur et une distribution
des positions observées. L'empreinte des entrées rend les snapshots et
événements dérivés déterministes et idempotents; toute écriture est atomique.

Le périmètre commence à la détection du token. Aucun historique antérieur de
créateur, appel RPC additionnel ou lecture exhaustive des comptes token n'est
effectué. Les quotes restent séparées et tous les calculs financiers utilisent
`bigint`; une position nette négative est une observation valide. La
reconstruction est une étape idempotente du pipeline observé composé dans le
bootstrap.

### Graphe de wallets observé I2

I2 intervient uniquement à partir de l'arrivée du token. Il ne recherche
aucun historique antérieur de wallet. Pour chaque achat Pump.fun connu, le
ledger conserve une évaluation distincte :

- `STRONG` pour un transfert direct du quote asset vers l'acheteur avant
  l'achat dans la même transaction ;
- `MEDIUM_ONLY` pour un fee payer externe sans transfert direct prouvé ;
- `NO_EVIDENCE` lorsque l'extraction a réussi sans preuve externe ;
- `UNAVAILABLE` lorsque les données normalisées sont ambiguës ou insuffisantes ;
- l'absence de ligne est exposée séparément comme `NOT_PROCESSED`.

Les auto-transferts n'apportent aucune preuve. L'extracteur traite SOL, SPL
Token et Token-2022, instructions externes et internes. Les montants de quote
assets différents ne sont jamais additionnés.

`WalletGraphAnalyzer` agrège des arêtes non orientées déterministes. Seules les
preuves directes fortes construisent les composantes connexes ; le fee payer
moyen reste visible sans fusion. Un cluster exige au moins deux wallets
participants. Sa concentration est calculée en entier sur les positions nettes
positives observées par I1. Les funders auxiliaires ont une concentration
nulle. Ces nombres décrivent les flux observés, pas des soldes SPL certifiés.

Le rebuild relit les sources canoniques sous verrou PostgreSQL par mint,
exclut `orphaned`, remplace atomiquement les projections courantes et garde un
snapshot immuable par fingerprint. Une analyse réussie à zéro cluster reste
`AVAILABLE`. Les événements `WalletClusterDetected` ne contiennent que des
agrégats bornés ; les relations et membres complets restent en base.
Chaque relation conserve ses curseurs observés premier/dernier. Chaque cluster
persiste ses quote assets distincts ; l'API en expose au plus 8 par cluster et
64 au total avec compte total et indicateur de troncature.
Leur `asOf` et leur finalité minimale incluent explicitement la projection I1,
y compris lorsqu'une vente plus récente que le dernier achat modifie les
positions observées.

L'API limite par défaut la réponse à 50 clusters, 50 membres par cluster,
500 membres au total, 8 quote assets par cluster et 64 quote assets au total,
avec des indicateurs de troncature explicites. Les reason
codes `SHARED_FUNDER_CLUSTER` et `RELATED_WALLET_CLUSTER_EXCEEDED` sont
`REPORT_ONLY` pendant le calibrage dry run : I2 rapporte les preuves et les
déclenchements, sans ajouter de blocker ni changer le verdict, le score ou la
décision paper.

## Contrats Solana

Une transaction peut contenir plusieurs instructions Pump.fun externes et
internes. La normalisation conserve :

- signature, slot et `transactionIndex` ;
- `instructionIndex` et `innerInstructionIndex` ;
- balances token avant/après et lamports avant/après ;
- programme Token SPL ou Token-2022 ;
- statut `processed`, `confirmed`, `finalized` ou `orphaned`.

Un identifiant déterministe inclut la source, le programme, la signature et le
curseur complet. Les deltas globaux d’une transaction ne devront être agrégés
qu’une fois par marché/courbe.

Les montants financiers restent entiers. PumpSwap calcule :

```text
effectiveQuoteReserves = quoteVaultAmount + virtualQuoteReserves
```

Le quote mint est toujours une valeur de domaine (`mint`, `decimals`,
`tokenProgram`), jamais une hypothèse globale SOL.

Le décodage de graduation reste multi-quote ; l’allowlist paper V1 reste
SOL/WSOL. `PUMPSWAP_ACTIVE` exige la concordance de `create_pool`, de
`CreatePoolEvent`, du compte pool, de ses vaults, des programmes token et du
PDA canonique. Les frais viennent des comptes officiels ; réserves, frais,
slippage et impact sont calculés en `bigint`. Une quote est une estimation
issue d’un snapshot, pas une garantie de sellabilité.

## Source officielle et décodeur Pump.fun

Vérification renouvelée le 8 août 2026. La documentation publique officielle
indique une interface multi-quote avec `buy_v2`, `sell_v2` et
`buy_exact_quote_in_v2`, tout en maintenant les anciennes instructions. Elle
documente également `migrate` comme migration permissionless et idempotente
vers PumpSwap.

La source épinglée est
[pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs),
commit `9c82f61cb711b044a17f770ab8ce9f9bdf78f333`. Les discriminators et schémas
sont générés depuis cet IDL, jamais copiés depuis un projet tiers. Ce commit
était toujours le HEAD de `main` lors de la vérification. Le manifeste
`vendor/pumpfun/idl/manifest.json` lie hors ligne révision, chemins officiels,
SHA-256 et sous-ensembles générés Pump.fun/PumpSwap.

Les fixtures mainnet minimisées et versionnées couvrent une création avec
achat initial, une vente CPI, un achat V2 CPI, une migration V2 avec son
`create_pool` canonique et une vente PumpSwap dont le quote mint n’est pas
WSOL. Elles conservent les identifiants publics nécessaires à la preuve exacte,
mais excluent endpoints, en-têtes, logs, signers et tableaux globaux de
lamports. « Assainie » ne signifie donc pas « anonymisée » ; tout se rejoue
hors ligne sans RPC.

## Qualification

Les trois scores sont indépendants :

- préparation du lancement : 15 ;
- authenticité sociale : 25 ;
- santé et comportement on-chain : 60.

Le jeu initial est `UNVALIDATED_RULE_SET` et tous les poids/seuils seront
configurables. Son minimum vaut 60. `QUALIFICATION_MIN_SCORE` est un override
optionnel ; en son absence, le minimum du profil sélectionné est conservé. Ce
minimum est non calibré et ne déclenche jamais à lui seul le paper trading. Les
métadonnées ne prouvent jamais le sérieux du projet.

Les conditions éliminatoires utilisent les codes stables de
`src/domain/qualification-reasons.ts`. Un blocker actif décide du rejet sans
pouvoir être compensé par le score. Chaque rapport conserve les preuves, les
valeurs de règles et leur version.

### Profil effectif, calibration et décision

Le profil par défaut est
`config/qualification/pumpfun-v1-unvalidated.json`; `QUALIFICATION_PROFILE_PATH`
sélectionne un fichier local et `QUALIFICATION_MIN_SCORE` surcharge le minimum
effectif. Le chargeur échoue fail-closed avant toute ressource de runtime si le
profil ne se lit pas ou ne valide pas. Les diagnostics de démarrage sont
redacted: ni path ni contenu du profil ne sont logged.

Le fingerprint est le SHA-256 du JSON canonique du profil effectif, avec le
minimum remplacé par `QUALIFICATION_MIN_SCORE` lorsqu'il est défini. Il est un
hex lowercase de 64 caractères, versionne la règle réellement évaluée et non
le seul fichier brut. Le statut reste `UNVALIDATED_RULE_SET`: les valeurs sont
une calibration initiale NONVALIDATED, non une calibration officiellement ou
empiriquement validée.

Les maxima fixes sont préparation 15, authenticité sociale 25 et santé
on-chain 60, soit 100. Le minimum par défaut est 60 et est configurable. Les
signaux metadata/social ne contribuent qu'à préparation ou authenticité; ils
ne constituent jamais une preuve de sérieux. Un score ne peut jamais compenser
un blocker enforced: seuls les blockers `ENFORCED` déclenchés refusent le verdict.

| Mode | Condition | Effet sur le verdict |
| --- | --- | --- |
| `DISABLED` | Non évaluée, statut `DISABLED` | Aucun blocker |
| `REPORT_ONLY` | Évaluée et exposée, y compris `UNKNOWN` | Aucun blocker |
| `ENFORCED` | Évaluée | `TRIGGERED` crée un blocker, indépendamment du score |

Une observation inconnue donne `UNKNOWN`; un seuil absent donne
`NOT_CONFIGURED`. Pour un maximum, l'égalité passe et seul un dépassement strict
du seuil déclenche; pour le minimum shared funder,
l'égalité déclenche (`>=`). Les seuils holder et related cluster sont `null` et
`REPORT_ONLY` pendant le dry-run; `SHARED_FUNDER_CLUSTER` est `REPORT_ONLY`
avec minimumSharedFunders=1. Le seuil roundtrip par défaut est 3000 bps,
NONVALIDATED et calibration initiale: il n'est pas une garantie de profit, de
sellabilité, de première position ou de résultat dans le même slot.

Raydium legacy `RISK_*` reste isolé du calibrage Pump.fun; il ne modifie ni le
profil, ni les conditions, ni le verdict Pump.fun.

## Machine d’état et événements

Les états publics sont définis dans `src/domain/launch-status.ts`. Chaque
transition persistée contient date, événement déclencheur, ancien/nouvel état,
reason code, message humain et preuves.

## Paper trading

Le moteur Pump.fun V1 est un ledger comptable indépendant du
`TradeExecutor` Raydium historique. Il ne construit et ne simule aucune
transaction Solana et ne dépend d’aucun wallet. Il ouvre uniquement en mode
`paper`, après qualification sans blocker et pour un quote mint autorisé.

Les entrées et sorties utilisent `minimumAmountOutRaw`. Frais, slippage,
perte aller-retour et PnL restent en `bigint`. Position, trade et événement
métier sont persistés atomiquement ; les replays sont idempotents. Une
position fermée est conservée quatre heures avant purge. Une montée de finalité
enrichit l’événement paper existant. Si le déclencheur d’une ouverture ou d’une
fermeture non finalisée devient `orphaned`, la projection passe à
`PAPER_RETRACTED`, devient inactive et reste auditable pendant la même fenêtre
de rétention.

Les événements métier sont source-indépendants :

- `TokenLaunchDetected`, `TokenMetadataResolved`, `TokenMetadataFailed` ;
- `SocialEvidenceCollected`, `CreatorProfileUpdated`,
  `WalletClusterDetected` ;
- `BondingCurveTradeObserved`, `BondingCurveStateUpdated`,
  `BondingCurveCompleted` ;
- `QualificationUpdated` ;
- `PaperPositionOpened`, `PaperPositionUpdated`, `PaperPositionClosed` ;
- `MigrationObserved`, `PumpSwapPoolActivated`.

## Persistance, reprise et rétention

`raw_chain_events` garde l’entrée technique ; `domain_events`,
`token_launches`, `migrations`, `market_pools`, `market_reserve_snapshots`,
`market_trades` et `state_transitions` sont des projections métier. Les
checkpoints sont indépendants de la source.

L'inbox durable déduplique les notifications WebSocket et le rattrapage HTTP.
Sur une base vide, le scanner prend uniquement la page la plus récente de
chaque programme comme baseline, conformément au périmètre sans historique.
Une seconde passe après l'abonnement WebSocket ferme la fenêtre de démarrage.
Une reprise après panne rejoue toujours l'intégralité des étapes launchpad,
financement, I1, I2 et PumpSwap; les identités et écritures déterministes
garantissent des effets persistés exactement une fois, sans reprendre après
une étape intermédiaire. Les leases expirés rendent le travail réclamable.

Le WebSocket est le chemin nominal. Le catch-up initial est borné par
`LISTENER_CATCH_UP_MAX_PAGES * LISTENER_CATCH_UP_PAGE_SIZE` pour chacun des
programmes Pump.fun et PumpSwap, soit 20 × 100 signatures par programme par
défaut. Une panne retryable est replanifiée avec un délai exponentiel de 500 ms
plafonné à 60 s, sans plafond du nombre de tentatives. Les variables
`RPC_RETRY_MAX_ATTEMPTS` et `RPC_RETRY_BASE_DELAY_MS` sont parsées et validées
pour compatibilité, mais ne pilotent pas encore ce scheduler durable. Les lots
de finalité et durées d'arrêt sont bornés; le quota RPC réel dépend du trafic,
des déconnexions et des reprises.

Le traitement réclame un événement avec un lease et reste idempotent.
`raw_chain_events` est alimenté séparément : le batch du sink conserve les
événements métier et leur lien vers cette entrée d’audit, sans embarquer le
payload brut. Un événement `orphaned` vu pour la première fois ne crée aucun
état actif. Pour un événement existant, la rétraction de ses transitions
n’intervient qu’après une réconciliation réussie de `processed` ou `confirmed`
vers `orphaned`, sans effacer l’événement ni l’historique d’invalidation.
`finalized -> orphaned` et toute sortie de `orphaned` rejettent atomiquement le
batch avant rétraction.

L’identité de la transition reste stable lors des replays. Indépendamment du
résultat d’écriture de l’événement, le temps blockchain prime sur le temps
d’observation de secours et le plus petit temps gagne à source égale. La fusion
est ainsi commutative : un replay de même confirmation peut enrichir la
transition avec le temps blockchain, qu’un fallback ultérieur ne remplace
jamais. Le repository PumpSwap applique ces garanties dans une transaction
PostgreSQL, avec verrou advisory par transaction. Un orphaning non finalisé
rétracte le pool et ses projections.

Quand un lancement ou une transaction inbox devient terminale en état
`finalized` ou `orphaned`, `terminal_at` est fixé et
`purge_after = terminal_at + 4 heures`. Le purgeur ne supprime que les lignes
arrivées à échéance, dans l’ordre des dépendances. Une transaction `processed`
ou `confirmed` en attente de finalité ne reçoit aucune échéance et n'est jamais
purgée. Les
profils créateurs, positions observées, preuves de financement, relations,
clusters et snapshots suivent la date du lancement parent et sont supprimés
avant leurs événements. Les preuves sociales
V1 sont limitées aux contenus publics ; aucune API payante X ou Telegram n’est
obligatoire.

La PR H ajoute aussi un outbox SSE append-only. Chaque révision publique est
persistée avant diffusion et reçoit un curseur de transport monotone, distinct
de l’identité métier déterministe `eventId` incluse dans `data`. Le champ SSE
`id` transporte ce curseur et doit seul être renvoyé dans `Last-Event-ID`; une
montée de finalité peut donc publier plusieurs révisions du même `eventId`.
Sans curseur, le serveur démarre au high-water mark courant. Le transport est
retenu quatre heures. Un curseur invalide ou futur est rejeté, un curseur
expiré produit `EVENT_CURSOR_EXPIRED` (409) et le client recharge alors les
projections HTTP avant de se reconnecter.

Par défaut, l’API écoute seulement sur `127.0.0.1`; `API_HOST` et `API_PORT`
contrôlent le binding. Exposer une adresse publique requiert les protections de
déploiement appropriées, car le contrat est non authentifié. La route health
retourne 503 lorsque PostgreSQL est indisponible. Son pipeline vaut `RUNNING`
seulement lorsque tous ses composants tournent, `DEGRADED` lors d'une panne,
d'un nettoyage incomplet ou d'un heartbeat périmé, et `STOPPED` après arrêt ou
désactivation explicite. Le heartbeat rend visibles backlog, leases, échecs
épuisés, checkpoints, derniers slots et fraîcheur sans divulguer les endpoints.

## Invariants de sécurité

- modes possibles : `observe`, `paper` ;
- aucune clé privée ;
- aucune signature ni soumission ;
- API et dashboard en lecture seule ;
- aucune garantie de timing, sortie ou profit ;
- aucune promesse de même slot entre création, graduation et snapshot RPC ;
- simulation inverse indisponible = preuve inconnue ou blocker configuré, jamais
  affirmation de sellabilité.
