# Autorité PostgreSQL du worker de simulation — conception #51-H2j

**Version de spécification :** 1.0.1

**Version de la spécification parente visée :** 1.11.16

**Date :** 2026-09-05

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-H2i fusionnée par la PR #85

## Historique des versions

- **1.0.1 — 2026-09-05 :** ajoute une partition de lignes monotone entre le
  worker non signant et les intentions réservées au live, avec RLS restrictive,
  promotion transactionnelle et verrouillage des écritures enfants.
- **1.0.0 — 2026-09-05 :** conception initiale de l'allowlist PostgreSQL par
  colonne du worker `dry-run` et `simulation-only`.

## 1. Objectif

Rendre les modes `dry-run` et `simulation-only` exécutables sous un login
PostgreSQL dédié sans réutiliser le propriétaire de la base et sans leur
donner une capacité live. H2j ne charge aucun wallet, ne construit aucune
signature et ne soumet aucune transaction.

## 2. Choix d'architecture

Un seul groupe `NOLOGIN` et `NOINHERIT`, `sol_token_executor_worker`, couvre
les deux modes non signants déjà composés par `src/executor/main.ts`. Deux
rôles distincts amélioreraient marginalement l'isolation, mais ajouteraient
deux déploiements et deux jeux de credentials avant le canary sans réduire la
frontière entre simulation et live. Des droits de table complets sont refusés :
chaque opération est accordée par colonne.

Les ACL de colonnes ne suffisent toutefois pas lorsque les mêmes tables
contiennent des intentions non signantes et live. La frontière comporte donc
aussi une partition de lignes durable `live_reserved`, monotone de `false`
vers `true`, et des politiques RLS qui s'ajoutent aux ACL sans les remplacer.

Le provisioning est rejouable et reconstruit l'autorité depuis zéro. Il retire
les appartenances, ACL directes, default ACL, propriétés, droits de paramètre,
droits hérités de `PUBLIC` sur les objets `execution_*`, création de schéma et
création sur la base courante avant d'accorder l'allowlist.

## 3. Allowlist exacte

### 3.1 Commun aux deux modes

- `USAGE` sur le schéma `public` ;
- `execution_intents` : `SELECT` sur la projection canonique ; `UPDATE`
  uniquement sur le lease, l'état, la révision, le compteur de tentatives, la
  raison terminale et les timestamps de cycle de vie ;
- aucun `INSERT`, `DELETE`, `TRUNCATE`, `REFERENCES` ou `TRIGGER` sur
  `execution_intents` ;
- aucun accès à `execution_intent_tombstones`.

### 3.2 Mode `dry-run`

- `execution_dry_run_assessments` : `SELECT` et `INSERT` sur son contrat
  persistant complet ; aucun `UPDATE` ni `DELETE`.

### 3.3 Mode `simulation-only`

- `execution_attempts` : `SELECT`, `INSERT` de l'identité de tentative et
  `UPDATE` de son résultat borné ;
- `execution_intent_transitions` : `SELECT(intent_id)` et `INSERT` de la
  transition complète ;
- `USAGE` sur `execution_intent_transitions_sequence_seq` uniquement ;
- `execution_simulation_artifacts` : `SELECT` et `INSERT` sur l'artefact non
  signé complet ; aucun `UPDATE` ni `DELETE` ;
- `migrations` et `market_pools` : `SELECT` uniquement sur les colonnes
  requises pour prouver le pool PumpSwap canonique.

### 3.4 Partition de lignes non signant/live

Seule la table parente `execution_intents` porte le marqueur
`live_reserved BOOLEAN NOT NULL DEFAULT FALSE`. Les quatre tables enfants
`execution_dry_run_assessments`, `execution_attempts`,
`execution_intent_transitions` et `execution_simulation_artifacts` restent liées
par `intent_id` et ne dupliquent pas ce booléen. Le marqueur de l'intention est
l'unique source de vérité.

Une transition `false -> true` est permise, mais aucune voie ne peut revenir à
`false`. La transaction `armCanary()` du rôle opérations verrouille et revalide
d'abord l'intention BUY cible dans son état pristine (`PENDING`, zéro tentative,
aucune lease, aucun état terminal et `live_reserved=false`), puis effectue la
promotion avant l'admission de risque et avant de publier l'armement, dans la
même transaction que ses autres preuves. Un échec d'admission ou de publication
annule donc aussi la promotion. La création d'une intention SELL par
`createDeadlineExitIntentLocked()` dans le repository live l'insère directement
avec `live_reserved=true`; son rejeu exige la même valeur. La promotion du
parent rend atomiquement inaccessibles au worker ses lignes enfants déjà
présentes, sans les réécrire.

La migration 040 backfill `true` pour toute intention déjà reliée à une
racine live : cible ou lock d'un armement, lock pré-signature, transaction
signée, BUY ou sortie d'une position live, ou autorisation de sortie lockée.
Elle n'ajoute ni backfill ni colonne aux quatre tables enfants.

Les cinq tables ont `ENABLE ROW LEVEL SECURITY` sans `FORCE ROW LEVEL SECURITY` :
le propriétaire administratif conserve ainsi le bypass nécessaire aux
migrations suivantes. Une policy permissive conserve le filtrage par ACL pour
les autres rôles ; une policy `AS RESTRICTIVE` limite toute session membre de
`sol_token_executor_worker` à l'intention `live_reserved=false`, directement
sur le parent et via un `EXISTS` corrélé par `intent_id` sur chaque enfant, en
lecture comme en `WITH CHECK`. La détection porte sur `session_user`, pas
seulement sur `current_user`, afin de couvrir le login mono-membre qui exécute
`SET ROLE`.
Elle résout d'abord l'OID dans `pg_roles`, puis appelle `pg_has_role` seulement
si le groupe existe : une base vide peut donc appliquer la migration 040 avant
le provisioning des rôles.

Les quatre tables enfants ont en plus un guard `BEFORE INSERT OR UPDATE`
`SECURITY DEFINER`, avec `search_path` fermé et privilège `EXECUTE` révoqué à
`PUBLIC`. Pour une session worker, le guard ne verrouille et ne retourne que le
parent portant `live_reserved=false`. Il ne révèle ni ne rend modifiable un
parent live. Pour les rôles administratifs/live autorisés, il verrouille le
parent sans dupliquer son état. Le verrou parent sérialise avec une promotion
concurrente : une écriture enfant finit avant la promotion, ou observe `true`
et devient inaccessible au worker.

Les claims constituent une seconde défense explicite. `DRY_RUN` et `EXECUTE`
exigent `live_reserved=false`; `LIVE_EXECUTE`, `LIVE_RECOVER`, `CONFIRM` et
`RECONCILE` exigent `live_reserved=true`. Un changement de purpose ne permet
donc pas de franchir silencieusement la partition, même sous un rôle plus large.

## 4. Exclusions live

Le worker n'accède à aucune génération ou photographie wallet, qualification
live, admission de risque, réservation d'exposition, contrôle, autorisation
opérateur, armement, lock pré-signature, transaction signée, budget RPC live,
soumission, révocation, position live, preuve de confirmation ou
réconciliation. Il n'obtient aucun droit de DDL, aucune autre séquence et aucun
`GRANT OPTION`. Il ne peut ni promouvoir `live_reserved`, ni lire ou modifier
une ligne après sa promotion. Cette isolation de lignes n'ajoute aucun import de
signer et aucune capacité de signature ou de soumission.

## 5. Connexion

Le login de déploiement est mono-membre, `NOINHERIT`, sans privilège direct.
Chaque connexion active le groupe avec l'option PostgreSQL
`-c role=sol_token_executor_worker`. La migration automatique reste désactivée
et appartient à un processus administratif distinct. Aucun login, mot de
passe ou URL n'est accepté par le script de provisioning.

## 6. Validation

- test statique de chaque colonne accordée et de chaque exclusion live ;
- test PostgreSQL 16 qui injecte des dérives de rôle, `PUBLIC`, default ACL,
  paramètre et propriété, puis vérifie leur suppression ou leur rejet fermé ;
- inventaire dynamique de toutes les relations et séquences `execution_*` ;
- test de migration et de backfill des racines live existantes ;
- test RLS sous le login dédié sur les cinq tables, incluant lecture, mutation,
  insertion enfant et course avec la promotion ;
- test des claims non signants sur `false` et live sur `true` ;
- test de rollback atomique de la promotion BUY et de création SELL live ;
- exécution réelle du flux `dry-run` sous le login dédié ;
- exécution réelle du flux `simulation-only` sous le même login, avec RPC
  simulé et artefact non signé ;
- build, check, lint, tests et documentation verts.

## 7. Hors périmètre

H2j ne collecte pas le quota Helius, ne produit pas le bundle H2c, ne choisit
pas une opportunité, ne convertit pas le wallet, n'arme pas une intention et
ne démarre pas le canary. `CANARY_NOT_STARTED` reste l'état obligatoire.

## 8. Risque résiduel

Avant sa promotion, une intention reste volontairement accessible au worker
non signant. Un worker compromis peut donc louer, retarder ou terminaliser une
future candidate et provoquer un déni de service avant `armCanary()`. La
transaction opérations verrouille et revalide l'intention exacte avant de la
promouvoir ; toute altération fait échouer l'armement fermé. Ce risque de
disponibilité ne devient jamais une capacité de signature ou d'envoi. La
procédure H2c arrête le worker non signant avant la sélection et la promotion
de l'intention canary.
