# Taxonomie durable des échecs du pipeline observé

Version : 1.0.0 — 2026-09-12 — issue #108.

## Contrat de stockage

Chaque nouvel échec pipeline transmis à `markFailed` respecte exactement :

- `error_code = PIPELINE_STAGE_FAILED` ;
- `error_name = ObservedPipelineFailure.v1.<stage>.<origin-code>` ;
- `error_retryable = false` pour un code interne connu, `true` pour `UNKNOWN`.

Le domaine valide le nom, la version, les deux segments fermés et la décision
de retry avant toute acquisition de connexion PostgreSQL. Un nom legacy,
une version future, un suffixe ou une décision contradictoire sont refusés.
Les anciennes lignes `ObservedPipelineError` restent lisibles/rejouables ;
elles ne sont pas réécrites en masse et ne justifient aucune migration.

Les stages autorisés sont `create_observation`, `load_tracked_mints`,
`launchpad_observation`, `sync_tracked_mint`, `reload_active_events`,
`funding_observation`, `participant_analytics`, `wallet_graph`,
`pumpswap_observation`, `qualification` et `paper_decision_enqueue`.
Le sentinel `unclassified` est réservé au code `UNKNOWN` lorsque le worker
reçoit un échec sans wrapper pipeline authentifié.

## Table exhaustive des codes origine

La décision ci-dessous concerne un échec qui sort du pipeline exécuté par le
worker sur sa vue issue du snapshot durable, pas une simple issue métier.
Le champ historique `PumpDecodingError.retryable` n'est pas une autorité pour
ce contexte : un snapshot tronqué ne change pas entre deux tentatives.

| Code origine | Retryable |
| --- | --- |
| `PUMP_TRANSACTION_INDEX_REQUIRED` | false |
| `PUMP_SCHEMA_UNSUPPORTED` | false |
| `PUMP_BORSH_TRUNCATED` | false |
| `PUMP_BORSH_INVALID` | false |
| `PUMP_ACCOUNT_MISSING` | false |
| `PUMP_STACK_HEIGHT_REQUIRED` | false |
| `PUMP_STACK_HEIGHT_INVALID` | false |
| `PUMP_EVENT_MISSING` | false |
| `PUMP_EVENT_DUPLICATE` | false |
| `PUMP_EVENT_ORPHANED` | false |
| `PUMP_EVENT_AMBIGUOUS` | false |
| `PUMP_EVENT_MISMATCH` | false |
| `PUMP_QUOTE_ASSET_UNRESOLVED` | false |
| `PUMP_QUOTE_ASSET_CONFLICT` | false |
| `PUMP_TOKEN_PROGRAM_UNSUPPORTED` | false |
| `PUMPSWAP_ACCOUNT_MISSING` | false |
| `PUMPSWAP_BORSH_INVALID` | false |
| `PUMPSWAP_BORSH_TRUNCATED` | false |
| `PUMPSWAP_EVENT_AMBIGUOUS` | false |
| `PUMPSWAP_EVENT_DUPLICATE` | false |
| `PUMPSWAP_EVENT_MISMATCH` | false |
| `PUMPSWAP_EVENT_MISSING` | false |
| `PUMPSWAP_EVENT_ORPHANED` | false |
| `PUMPSWAP_SCHEMA_UNSUPPORTED` | false |
| `PUMPSWAP_STACK_HEIGHT_REQUIRED` | false |
| `PUMPSWAP_TOKEN_PROGRAM_UNSUPPORTED` | false |
| `UNKNOWN` | true |

Les erreurs DB, RPC et étrangères sont `UNKNOWN`, même si leur objet déclare
un code connu ou `retryable=false`. Une issue absorbée dans
`DecodedPumpSwapTransaction.issues` reste une issue métier : elle ne fait pas
échouer artificiellement le worker.

Les lecteurs `RpcPumpSwapPoolValidator`, `PumpSwapReserveReader` et
`PumpSwapFeeStateReader` sont des frontières distinctes : leurs comptes RPC
sont mutables et ne figurent pas dans le snapshot transaction. Ils enveloppent
donc seulement les échecs de décodage internes dans une erreur fixe non
enregistrée, avec cause non énumérable en mémoire ; les erreurs étrangères et
métier sont relancées sans altération. Même `PUMPSWAP_BORSH_TRUNCATED` issu du
décodeur de compte ou de frais perd ici son autorité terminale et produit
`ObservedPipelineFailure.v1.pumpswap_observation.UNKNOWN`, retryable. Le même
code émis sur des preuves immuables conserve la décision terminale de la table.

## Autorité et architecture

Le module bas niveau `domain/observed-pipeline-failure.ts` possède la table
fermée et un registre `WeakMap` privé. Il ne dépend d'aucun adaptateur.
Les factories internes des décodeurs enregistrent l'identité de l'erreur et
son code avant de la retourner. Les constructeurs publics, sous-classes et
faux prototypes ne donnent aucune autorité terminale.

`LaunchpadObservationService` conserve l'autorité de la cause enregistrée
lorsqu'il crée son propre wrapper. Son ancienne reconnaissance par
`instanceof` est remplacée par un registre d'identité et de contexte ; une
construction publique portant une cause interne ne devient pas authentifiée.
Le pipeline crée ensuite son wrapper et enregistre une copie immuable des
trois seules données persistables. Le worker consulte cette copie, sans lire
les propriétés publiques de l'erreur. Les fonctions d'enregistrement sont
des capacités internes du code de confiance, pas une API à exposer à une
dépendance injectée ; ceci n'est pas un sandbox pour du code JavaScript ayant
accès aux imports internes de l'application.

La classification ne parcourt ni prototype, ni chaîne de causes, ni champs
duck-typed. Les proxies hostiles ou révoqués ne déclenchent aucun trap. La
modification ultérieure de `code`, `name`, `stage`, `retryable` ou `cause` ne
modifie pas la classification enregistrée.

La cause originale reste disponible en mémoire via `Error.cause` ; celle du
wrapper pipeline est non énumérable. Le worker ne persiste ni cause, ni message,
ni stack, ni URL, ni signature de cause, ni texte provider. Le stage et le
code origine ne sont jamais dérivés de texte libre.

## Exécution et vérifications

Le worker construit sa vue depuis le snapshot avant le premier pipeline et
ne l'exécute qu'après `saveSnapshot`. En replay, il restaure directement le
snapshot sans appeler le locator. Un code connu devient `FAILED` terminal à
son premier passage pipeline, sans `next_attempt_at` ni épuisement artificiel.
La rétention existante reste de quatre heures après terminalisation.

Les tests couvrent les 26 codes, tous les stages, fresh/replay, les objets
hostiles, les constructions publiques et les altérations de métadonnées.
Des fixtures purement synthétiques traversent le vrai décodeur Pump, l'adapter,
le service, le pipeline et le worker pour `PUMP_BORSH_INVALID`,
`PUMP_BORSH_TRUNCATED` et `PUMP_ACCOUNT_MISSING`. PostgreSQL couvre ces chemins,
les 26 décisions terminales au premier claim, les retries DB/RPC et le replay
d'une ligne legacy. La validation refuse les nouvelles écritures hors contrat
avant I/O.
Un test traverse aussi la frontière RPC mutable avec le même code Borsh pour
vérifier explicitement les deux décisions opposées selon la provenance.

L'audit offline H2i de la session a identifié 34 erreurs de décodage
(28 tronquées, 5 invalides, 1 compte manquant), 86 transactions décodables
échouant plus loin et 21 erreurs chaîne sans observation. Seules les 34
premières relèvent de la terminalisation connue ; les causes des 86 autres
restent inconnues/retryables. Aucun snapshot H2i brut n'est ajouté au dépôt.

## Hors périmètre

Aucun changement de layout Borsh, throttle, admission RPC, wallet, signer,
armement ou envoi. Aucun nouveau schéma SQL, aucune migration, aucune
réinterprétation automatique des anciennes erreurs durables.
