# Autorité PostgreSQL du worker de simulation — conception #51-H2j

**Version de spécification :** 1.0.3

**Version de la spécification parente visée :** 1.11.19

**Date :** 2026-09-05

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-H2i fusionnée par la PR #85

## Historique des versions

- **1.0.3 — 2026-09-05 :** ferme le replay après renommage du rôle worker :
  inventaire non ambigu des cinq policies, quarantaine atomique de l'ancien
  OID et reliaison exclusive au rôle canonique.
- **1.0.2 — 2026-09-05 :** lie les policies au rôle worker par OID lors du
  provisioning, remplace la détection de session par des guards
  `SECURITY INVOKER` sous RLS et ferme les dérives de forme, `REVOKE` et
  renommage observées pendant les revues P1/P2/P3.
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

Avant `ADD COLUMN IF NOT EXISTS`, la migration 040 valide la forme d'une
éventuelle colonne `live_reserved` préexistante : type `BOOLEAN`, contrainte
`NOT NULL` et `DEFAULT FALSE`. Toute forme divergente échoue avant le backfill.
Celui-ci pose `true` pour toute intention déjà reliée à une racine live : cible ou lock d'un
armement, lock pré-signature, transaction signée, BUY ou sortie d'une position
live, ou autorisation de sortie lockée. La migration n'ajoute ni backfill ni
colonne aux quatre tables enfants.

Les cinq tables ont `ENABLE ROW LEVEL SECURITY` sans `FORCE ROW LEVEL SECURITY`.
Une policy permissive conserve le filtrage par ACL pour les autres rôles ; une
policy `AS RESTRICTIVE` limite le worker à l'intention
`live_reserved=false`, directement sur le parent et via un `EXISTS` corrélé par
`intent_id` sur chaque enfant, en lecture comme en `WITH CHECK`.

PostgreSQL stocke les cibles de policy comme des OID de rôles. La migration 040
installe donc les policies directement si `sol_token_executor_worker` existe
déjà. Si le rôle est absent sur une base vide, elle installe à la place un
placeholder restrictif `TO PUBLIC USING (TRUE) WITH CHECK (TRUE)`, neutre pour
le comportement mais visible dans l'inventaire. Le provisioning, exécuté après
la création du groupe `NOLOGIN`, remplace toujours ces cinq policies par leurs
versions `TO sol_token_executor_worker`, désormais liées à son OID.

Avant toute reliaison, chaque replay du provisioning prend un verrou advisory
transactionnel puis exige un inventaire exact **5/5** : les cinq policies
restrictives nommées sur les cinq relations attendues doivent viser un **OID
unique**. Un inventaire incomplet, dupliqué ou multi-OID échoue fermé. La cible
`PUBLIC` du placeholder vaut l'OID spécial `0` ; elle est remplacée directement
par la cible canonique.

Si cet OID unique désigne un ancien rôle renommé plutôt que le rôle canonique,
le provisioning met l'ancien OID en quarantaine avant le `DROP OWNED` et le
rebind. Il le démote en `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOINHERIT`, `NOREPLICATION` et `NOBYPASSRLS`, réinitialise ses réglages globaux
et par base, révoque avec `CASCADE` ses memberships entrants et sortants, puis
retire ses droits dans la base courante. La démotion, ces révocations et les
contrôles de dépendances forment le bloc atomique exécuté avant la suppression
des anciennes policies et leur reliaison ; toute erreur de quarantaine annule
ce bloc et fait échouer fermé le replay.

Un ancien rôle système, actif comme `session_user`/`current_user`, privilégié
ou propriétaire d'un objet est refusé. Un ownership ou une dépendance résiduelle
dans une autre base, de même qu'un membership ou réglage non supprimable, fait
échouer fermé le provisioning. Une session active stale conserve techniquement
son ancien `current_user`, mais perd toute autorité après la quarantaine : ses
memberships, réglages, droits et policies ont disparu. Le rôle canonique reçoit
seul les cinq policies finales liées à son OID. Un nouveau renommage sera traité
de la même manière au replay suivant.

Les quatre tables enfants ont en plus un guard `BEFORE INSERT OR UPDATE`
`SECURITY INVOKER`, avec `search_path` fermé et privilège `EXECUTE` révoqué à
`PUBLIC` et au worker. Une fonction de trigger n'exige pas ce grant direct. Sa
lecture du parent s'exécute sous le rôle appelant et reste donc soumise à RLS :
le worker ne peut verrouiller qu'un parent non live visible. Le `WITH CHECK` de
la policy enfant refuse ensuite toute écriture dont le parent est masqué. Le
verrou parent sérialise avec une promotion concurrente : une écriture enfant
finit avant la promotion, ou observe le parent réservé et échoue fermée.

Le worker reçoit `SELECT(live_reserved)` parce que les requêtes de claim
explicites et la policy du parent en ont techniquement besoin. Cette lecture ne
révèle jamais une ligne `true`, déjà masquée par RLS, et le marqueur n'est exposé
par aucun contrat domaine ou API.

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

Le `owner`, un superuser ou un rôle doté de `BYPASSRLS` contourne RLS par
définition PostgreSQL. Cette limite est une frontière de confiance
intentionnelle : le migrateur administratif reste propriétaire, tandis que les
logins de service et leurs groupes sont validés non propriétaires,
`NOSUPERUSER` et `NOBYPASSRLS` à chaque checkout.

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
- rejet d'une colonne `live_reserved` préexistante dont le type, la nullabilité
  ou le défaut diffère de `BOOLEAN NOT NULL DEFAULT FALSE` ;
- test RLS sous le login dédié sur les cinq tables, incluant lecture, mutation,
  insertion enfant et course avec la promotion ;
- application de migration sans rôle via placeholder, puis remplacement des
  policies par le provisioning et vérification de leurs OID cibles ;
- inventaire exact 5/5 visant un OID unique avant reliaison ;
- replay après renommage : ancien OID démoté, memberships, réglages et droits
  révoqués atomiquement avant `DROP OWNED` et rebind vers le rôle canonique ;
- échec fermé sur ownership ou dépendance résiduelle dans une autre base ;
- perte de toute autorité par une session active stale et vérification que le
  rôle canonique reçoit seul les cinq policies finales ;
- avant replay, conservation de la partition pour une session active après
  `REVOKE` du membership ou renommage ; au replay, quarantaine de l'OID stale ;
- vérification des guards enfants `SECURITY INVOKER` réellement soumis à RLS ;
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
