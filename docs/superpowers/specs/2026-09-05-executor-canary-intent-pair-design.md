# Paire d'intentions canary non signante — conception #51-H2k

**Version de spécification :** 1.2.0

**Version de la spécification parente :** 1.12.1

**Version de la spécification canary :** 1.3.1

**Date :** 2026-09-08

**Statut :** H2k-a LIVRÉE — H2k-b À LIVRER

**Issue parente :** #51

## Historique des versions

- **1.2.0 — 2026-09-08 :** versionne le contrat public de préparation avec
  les liaisons persistantes de l'assessment cible et de l'artefact de
  simulation, puis la terminalisation `PREPARED` liée au fingerprint du
  manifeste. Chaque mutation emploie une CAS exacte et une reprise après
  commit incertain qui interdit la substitution de preuve. La sélection
  verrouille désormais la première paire chronologique avant toute gate et
  échoue fermée si cette paire est invalide, sans essayer la suivante.
- **1.1.2 — 2026-09-08 :** retire au listener la lecture inutile de
  `execution_intents.live_reserved`; le trigger H2k effectue seul cette lecture
  sous son autorité SQL dédiée.
- **1.1.1 — 2026-09-06 :** précise la garantie de replay : la migration
  audite la forme persistée des tables et contraintes, puis recrée les
  triggers H2k nommés ; elle ne prétend pas inventorier les triggers étrangers.
- **1.1.0 — 2026-09-06 :** constate H2k-a disponible après merge avec la
  migration 041, l'émission atomique target/probe, les fences de claim et de
  promotion, ainsi que l'expiration et la purge coordonnée après quatre
  heures. Le flag reste faux et H2k-b reste à livrer.
- **1.0.0 — 2026-09-05 :** approuve la conception H2k en deux PR.

## 1. But

H2k prépare une cible BUY issue du flux paper normal sans attendre une saisie
SQL et sans permettre au worker de simulation de consommer cette cible. La
simulation Mainnet non signée utilise une seconde intention, liée durablement
à la même décision et économiquement identique.

Le lot est divisé en deux PR séquentielles, chacune fusionnable et sûre avec
son flag désactivé :

- **H2k-a**, désormais disponible, crée le contrat de paire, son émission
  atomique et les fences de persistance ;
- **H2k-b** ajoute la commande one-shot qui évalue la cible et simule seulement
  le sibling avant de produire le handoff H2h.

Les deux PR restent sans wallet, keypair, signer, armement, bytes signés ou
transport de soumission. `CANARY_NOT_STARTED` reste obligatoire.

## 2. Constat

Le worker `simulation-only` fait passer son intention de `PENDING` à
`SUCCEEDED` ou `FAILED` avec une tentative durable. H2h exige au contraire que
la cible canary reste un BUY `PENDING`, tentative zéro, sans lease. Une même
intention ne peut donc pas servir de preuve de simulation et de cible.

Les workers existants choisissent globalement la plus ancienne intention. Ils
ne savent ni cibler un identifiant exact ni publier toutes les identités
requises par H2h. Un simple chaînage manuel peut ainsi traiter la mauvaise
ligne.

## 3. Approches écartées

### 3.1 Chaînage manuel des workers existants

Écarté : les claims globaux et la boucle continue créent une course avec le
backlog. La cible pourrait être terminalisée avant H2h.

### 3.2 Simulation intégrée au listener

Écartée : elle mélangerait ingestion, décision paper et RPC d'exécution, et
élargirait l'autorité du listener H2i.

### 3.3 Pré-promotion `live_reserved`

Écartée : H2c reste seul propriétaire de la promotion atomique vers le live au
moment de l'armement. H2k ne crée aucune capacité live implicite.

## 4. Modèle retenu

Pour un OPEN paper admissible, le listener peut, derrière un flag désactivé
par défaut, persister dans sa transaction métier :

1. l'intention canonique existante, qui devient la **cible** ;
2. un **sibling de simulation** dérivé de la même décision ;
3. une ligne `execution_preflight_intent_pairs` qui lie les deux.

L'identité actuelle de la cible ne change pas. Le sibling reçoit un
`logicalCommandId` déterministe dérivé de l'identifiant cible et d'une lane
`simulation-probe:v1`. Les deux intentions diffèrent uniquement par les champs
d'identité et, après traitement, par les champs de cycle de vie.

La paire exige l'égalité exacte des champs économiques et causaux suivants :

- `strategy_id`, `strategy_version`, `position_id` ;
- `mint`, `side=BUY`, `venue_policy=PUMP_FUN_ONLY` ;
- `quote_mint`, `quote_token_program`, `quote_decimals` ;
- `quote_amount_raw`, `base_amount_raw=NULL`, `minimum_amount_out_raw` ;
- `decision_event_id`, `decision_fingerprint` ;
- `requested_at` et `expires_at`.

Les identités utilisent les domaines UTF-8 suivants, encodés par la même
fonction à champs préfixés par leur longueur que les intentions v1 :

- commande probe : `execution-preflight-simulation-probe-command-v1`, puis
  l'identifiant cible ;
- paire : `execution-preflight-intent-pair-v1`, puis identifiant cible,
  identifiant probe, `decision_event_id`, `decision_fingerprint` et
  `expires_at` en millisecondes décimales ;
- fingerprint : SHA-256 du JSON canonique v1 contenant `payloadVersion`,
  `pairId`, `targetIntentId`, `simulationIntentId`, `decisionEventId`,
  `decisionFingerprint` et `expiresAtMs`. Les nombres y sont des entiers JSON ;
  aucune valeur bigint ou nulle n'entre dans cette identité.

Les identifiants sont respectivement préfixés
`execution_preflight_probe_` et `execution_preflight_intent_pair_`. Le
`logicalCommandId` du probe est son identifiant de commande ; son
`logicalOrderKey` en découle par le constructeur existant. `created_at` vient
de `statement_timestamp()` PostgreSQL, `expires_at` est strictement celui de
la cible et `purge_after = expires_at + interval '4 hours'`.

Un rejeu exact relit la paire immutable et valide seulement son identité, même
si le probe a depuis été simulé. Il ne demande pas de verrou d'écriture : la
paire ne peut être modifiée et son guard de purge interdit sa disparition tant
que la cible n'est pas terminale et réconciliée. Une disparition concurrente
est donc un rejet fermé. Le chemin de création, et lui seul, réexige les deux
parents pristine. Une collision divergente échoue fermée.

## 5. Persistance H2k-a

La migration 041 crée `execution_preflight_intent_pairs` avec au minimum :

- `pair_id` primaire et déterministe ;
- `payload_version=1` ;
- `pair_fingerprint` ;
- `target_intent_id` et `simulation_intent_id` distincts ;
- `decision_event_id` et `decision_fingerprint` ;
- `created_at`, `expires_at`, `purge_after`.

Après chaque `CREATE TABLE IF NOT EXISTS`, la migration audite la forme
effective des colonnes, clés, uniques, FK `RESTRICT` et checks, puis recrée les
triggers H2k sous leurs noms canoniques. Elle ne garantit pas l'absence de
triggers étrangers ajoutés par un rôle disposant déjà de droits DDL. Un objet
homonyme préexistant incomplet fait échouer le replay ; il n'est jamais accepté
comme équivalent.

Les deux références pointent vers `execution_intents` avec `ON DELETE
RESTRICT`. Une table de membership normalisée porte `UNIQUE(intent_id)` et une
lane `TARGET | SIMULATION`, afin qu'une intention ne puisse apparaître dans
aucune seconde paire ou lane, y compris lors d'insertions concurrentes
inversées.

La paire et ses memberships sont immutables et append-only. Ils ne peuvent
être supprimés que dans la même transaction de rétention, immédiatement avant
leurs deux parents déjà éligibles à leur purge terminale. Ils ne disparaissent
donc jamais pendant qu'un parent existe ; les tombstones d'intentions
existants ferment ensuite le rejeu. La paire ne contient ni URL RPC, mint,
montant, clé, token de lease ou payload signé.

Le trigger d'insertion verrouille les deux parents dans un ordre stable,
vérifie qu'ils sont pristine (`PENDING`, tentative zéro, sans lease,
`state_revision=0`, raison/terminal/réconciliation/purge nuls,
`live_reserved=false`) et compare leur tuple économique exact. Le rejet se
produit dans la même transaction que l'émission : aucune moitié de paire ne
peut être visible.

## 6. Fences des workers

Le claim non-live `purpose=EXECUTE`, utilisé par `simulation-only`, exclut toute
intention référencée comme `target_intent_id`. Le sibling reste éligible. Le
claim `DRY_RUN` reste non consommant et peut évaluer la cible. Les claims live,
qui exigent déjà `live_reserved=true`, ne reçoivent pas cet anti-join : ils
doivent pouvoir consommer la cible après le futur armement H2c. H2k-b ajoutera
des claims exactement ciblés afin de produire un handoff déterministe.

Une cible expirée n'est jamais rendue exécutable par la disparition de la
paire : les predicates temporels existants restent obligatoires. H2c est le
seul flux qui peut promouvoir la cible vers `live_reserved=true`. La base
refuse toute promotion du sibling de simulation. Le contrat H2c v1 reste
compatible avec les intentions historiques non appairées ; son repository
refuse seulement tout identifiant connu comme sibling. H2k-b introduira un
handoff H2c v2 qui verrouillera paire et cible dans la même transaction, puis
exigera explicitement le côté `target_intent_id` avant promotion.

L'activation ne rétroforme ni ne backfill les intentions déjà émises. Seules
les nouvelles décisions OPEN persistées après activation produisent une
paire. Les CLOSE et les rejeux de décisions paper déjà terminalisées restent
inchangés.

Le cycle productif de rétention expire d'abord, par lots bornés et transitions
journalisées existantes, toute cible ou probe dont `expires_at` est dépassé et
dont la lease est absente ou échue. Une paire jamais préparée, une préparation
échouée ou un crash ne peut donc laisser deux `PENDING` immortels. La purge
attend que la paire ait dépassé `expires_at + 4 hours` et que chaque parent
terminal et réconcilié ait dépassé son propre `purge_after`, soit quatre heures
après sa terminalisation. Elle supprime ensuite leurs enfants, memberships et
paire dans l'ordre compatible avec les FK, écrit les tombstones d'intentions,
puis supprime les parents.

Le rôle H2j est considéré compromis possible : ses droits SQL non-live peuvent
encore provoquer un déni de service en terminalisant directement une cible.
Cette action fait échouer H2h fermé et ne donne ni signature ni soumission. Le
guard de promotion en base empêche en revanche le sibling d'acquérir une
capacité live.

## 7. Validation H2h v2 dans H2k-b

H2k-a ne modifie pas le contrat H2h v1. H2k-b versionnera la source et le draft
en v2. H2h relira alors la paire et l'intention parent de l'artefact sous son snapshot
`REPEATABLE READ READ ONLY`. Il refuse l'export sauf si :

- la cible et le probe correspondent exactement à la paire ;
- `simulation.intentId` est distinct du `targetIntentId` ;
- la cible est encore pristine et non réservée live ;
- un assessment dry-run evaluator v1 exact existe pour la cible ;
- le probe est BUY, WSOL/SPL Token à 9 décimales, `PUMP_FUN_ONLY`,
  `SUCCEEDED` avec une unique tentative ;
- l'artefact `SUCCESS` appartient au probe et à sa tentative ;
- les deux tuples économiques et causaux restent identiques ;
- la décision source et son événement raw sont tous deux `finalized`, ni
  orphaned ni remplacés ;
- les TTL existants, dont la limite de 30 secondes de l'artefact, restent
  valides avec la marge de publication.

Un artefact arbitraire, même réussi, ne peut donc plus satisfaire H2h.

## 8. Commande H2k-b

La PR suivante ajoutera un processus one-shot sous le rôle H2j. Au démarrage,
il capture un watermark `statement_timestamp()` PostgreSQL, attend pendant une
fenêtre bornée la première paire OPEN admissible créée après ce watermark,
ordonnée par `(created_at, pair_id)`, puis la verrouille par une lease de
préparation dédiée. Si cette paire perd une gate, le run échoue sans
substitution :

```text
première paire exacte après watermark
  -> dry-run exact de la cible, sans la consommer
  -> simulation exacte du sibling
  -> relecture et validation de la paire
  -> manifeste redacted pour H2h
  -> arrêt
```

La commande n'accepte aucun identifiant saisi librement, aucun fallback
`latest`, aucune sélection par SQL libre
et aucun retry ouvert. Une deadline absolue issue de l'horloge PostgreSQL
conserve au moins cinq secondes pour le handoff H2h. Un 429, un mauvais
genesis, une simulation non réussie, une cible louée/modifiée ou une capacité
provider insuffisante ferme le passage sans cible de remplacement.

Le manifeste `execution-preflight-intent-preparation-manifest.v1` est publié
hors dépôt par création atomique `0600`, sans overwrite ni suivi de symlink,
n'est jamais journalisé et est supprimable après quatre heures. Il contient les
identifiants et fingerprints de paire, cible, assessment et artefact, les
horodatages bornés et les constantes :

```json
{
  "state": "PREFLIGHT_INTENT_PREPARED",
  "canaryStatus": "CANARY_NOT_STARTED",
  "paperMainnet49Status": "NON_EXECUTED_NON_VALIDATED",
  "liveCapabilityPresent": false
}
```

Il n'expose ni mint, montant, URL, lease token ou secret.

Le repository de préparation est seul autorisé à lier les preuves au run. Son
API n'accepte aucun identifiant d'assessment ou d'artefact fourni par
l'appelant : elle dérive sous verrou l'unique assessment evaluator v1 de la
cible et l'unique artefact `SUCCESS` de la tentative 1 du sibling. Les trois
mutations `bindTargetAssessment`, `bindSimulationArtifact` et `markPrepared`
font une CAS sur le run, sa révision et la lease exacte. Un rejeu après commit
incertain restitue uniquement la preuve déjà liée et identique ; une autre
preuve, même valide isolément, est un conflit.

## 9. Autorités PostgreSQL

- le listener H2i reçoit uniquement les colonnes nécessaires pour insérer et
  vérifier une paire qu'il vient de dériver ;
- le worker H2j reçoit la lecture minimale de la paire et les mutations déjà
  nécessaires au dry-run/simulation ;
- H2h v2 reçoit les colonnes minimales de paire, de `live_reserved`, assessment,
  attempt et finalité, sans payload brut ni lecture table-wide ;
- les rôles opérations, API publique et readiness ne gagnent aucune mutation ;
- H2h peut lire l'adresse et les snapshots publics déjà autorisés ; aucun rôle
  H2k n'accède à une clé privée, seed, keypair, signer, armement, bytes signés,
  table live sensible ou transport de soumission.

Le provisioning reconstruit ces droits depuis zéro et refuse les privilèges
résiduels, `PUBLIC`, ownership, grant options et schémas homonymes.

## 10. Configuration

`EXECUTION_PREFLIGHT_PAIR_EMISSION_ENABLED=false` est le défaut. La valeur
`true` est admise uniquement avec :

- `EXECUTION_MODE=paper` ;
- `EXECUTION_INTENT_EMISSION_ENABLED=true` ;
- quote allowlist exacte WSOL ;
- `PAPER_MINIMUM_CONFIRMATION=finalized` ;
- listener H2i correctement provisionné.

Le flag ne démarre aucun executor et ne contacte aucun RPC supplémentaire.
Le déploiement normal reste inchangé lorsque le flag est absent ou faux.

## 11. Erreurs de préparation stables

H2k réutilise les codes métier existants pour le cycle de vie des intentions.
Les échecs suivants appartiennent au type séparé
`ExecutionPreflightPreparationErrorCode` et ne sont pas ajoutés aux CHECK ou
transitions `ExecutionIntentReasonCode` :

- `PREFLIGHT_PAIR_NOT_FOUND` ;
- `PREFLIGHT_PAIR_CONFLICT` ;
- `PREFLIGHT_PAIR_LINEAGE_INVALID` ;
- `PREFLIGHT_TARGET_NOT_PRISTINE` ;
- `PREFLIGHT_PROBE_NOT_PRISTINE` ;
- `PREFLIGHT_TARGET_FENCE_LOST` ;
- `PREFLIGHT_PREPARATION_LEASE_LOST` ;
- `PREFLIGHT_PREPARATION_DEADLINE_EXCEEDED` ;
- `PREFLIGHT_RPC_CAPACITY_UNVERIFIED` ;
- `PREFLIGHT_ASSESSMENT_INVALID` ;
- `PREFLIGHT_SIMULATION_FAILED` ;
- `PREFLIGHT_RECOVERY_CONFLICT` ;
- `PREFLIGHT_PREPARATION_EXPORT_FAILED`.

Les erreurs publiques restent typées et redacted.

## 12. Tests d'acceptation

H2k-a prouve :

- migration vide, upgrade 040 vers 041, rejeu et hash catalogue ;
- identité déterministe, collision divergente et unicité 1:1 ;
- insertion atomique des deux intentions et de la paire ;
- validation hostile de chaque champ économique ;
- cible toujours `PENDING`, tentative zéro, sans lease et non live ;
- exclusion de la cible du claim `EXECUTE`, y compris avec backlog et course ;
- sibling seul consommable par simulation ;
- H2c v1 et le trigger de promotion refusent le sibling comme cible live sans
  casser les intentions historiques non appairées ;
- orphaning, expiration, mutation ou substitution : aucun export ;
- rétention de quatre heures et replay protégé ;
- rôles réels PostgreSQL 16 et absence de capacité signante/live ;
- flag absent : comportement et tests existants inchangés.

H2k-b ajoutera les tests de sélection après watermark, lease exacte,
crash/reprise, deadline, 429, contrats H2c/H2h v2, finalité causale, manifeste
redacted et handoff de bout en bout.

## 13. Limites explicites

La simulation du sibling prouve la chaîne de préparation Mainnet sur le tuple
économique appairé ; elle ne garantit ni prix futur, ni sellabilité future, ni
profit. H2b doit encore refaire une quote BUY, obtenir une quote SELL inverse,
simuler la transaction cible juste avant signature et repasser tous les gates
H2c. Le wallet ne sera chargé qu'après le checkpoint humain final dans un vrai
TTY.

Chaque PR H2k utilise au plus deux cycles de revue GitHub.
