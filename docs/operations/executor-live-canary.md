# Executor live — préparation opérateur du canary Mainnet (#51-H2c)

**Version :** 1.17.6 — 2026-09-09

La version 1.17.6 permet de rafraîchir H2d pour la même génération wallet tant
que l'état de risque n'a pas changé. Chaque observation reste immuable, la
nouvelle doit être strictement plus récente, un seul snapshot reste actif et
le précédent devient purgeable après quatre heures. Ce refresh ne modifie pas
l'état de risque et n'ajoute aucun privilège au rôle readiness.

La version 1.17.5 priorise durablement les créations Pump.fun signalées par le
`CreateEvent` officiel, avec une tranche d'équité après 32 claims prioritaires.
L'indice ne remplace jamais le décodage RPC, ne persiste aucun log WebSocket et
n'ajoute aucune capacité wallet, armement, signature ou soumission.

Le backlog par classe se mesure sans lire de payload ni de logs :

```sql
SELECT ingestion_priority, processing_status, count(*)::BIGINT AS count
FROM chain_transaction_inbox
GROUP BY ingestion_priority, processing_status
ORDER BY ingestion_priority DESC, processing_status;
```

La version 1.17.4 impose `LISTENER_INGESTION_SCOPE=launchpad-only` pour le
probe H2i. La valeur par défaut compatible reste `launchpad-and-market` pour
les déploiements existants. Le scope H2i conserve Pump.fun, exclut le flux
global PumpSwap des chemins WebSocket et catch-up et publie
`pipeline.pumpswap=IDLE`. Cette valeur est un état volontaire, pas une panne.
Le changement ne donne aucun droit, wallet, armement, capacité de signature ou
de soumission et laisse `CANARY_NOT_STARTED` inchangé.

La version 1.17.3 force la transaction H2d en `READ COMMITTED`. Une exécution
qui attend le mutex de génération observe ainsi le dernier état risque commité,
même si le rôle ou la session PostgreSQL utilise par défaut `REPEATABLE READ`.
Le rôle readiness ne reçoit toujours aucun privilège `UPDATE`.

La version 1.17.2 corrige le prérequis PostgreSQL H2d observé sur le terrain :
la validation de l'état risque s'appuie sur le mutex transactionnel de
génération déjà commun aux writers et n'utilise plus un verrou de ligne qui
exigerait un privilège `UPDATE`. Le rôle readiness conserve donc zéro capacité
de mise à jour sur cet état.

La version 1.17.1 constatait que H2e accepte strictement le contrat historique
`usage` et le contrat courant
`creditCycle + credits + requests + dataTransfer` ; dans ce dernier,
`creditCycle` est l'autorité du cycle. Ce complément documentaire ne change
aucune procédure ni frontière de sécurité.

H2k-b reste disponible mais désactivé par défaut : son
runner one-shot prépare une paire target/probe exacte et H2h v2 l'exporte par
`preparationRunId`. Le head de migration est 044. Aucune clé n'est chargée,
aucune transaction n'est signée, armée ou soumise par H2k-b, et le canary
reste non démarré.

Ce document décrit l'état réellement livré. #51-H2a publie
`executor:live:recovery:start`, un processus de finalité read-only sans keypair,
signature ni soumission. #51-H2b publie séparément
`executor:live:dev` et `executor:live:start`. #51-H2c ajoute les gates, une
requête d'armement wire V3 liée à une intention BUY exacte, sa persistance en
armement V2, le lock durable avant signature et sa récupération fail-closed.
#51-H2d ajoute le bootstrap non signant des
snapshots wallet/provider. #51-H2e produit l'attestation de quota Helius
consommée par H2d. #51-H2f valide et signe hors ligne les deux enveloppes H2c
dans un paquet atomique. #51-H2g assemble son draft depuis deux artefacts
canoniques protégés, sans accès DB ou réseau. #51-H2h exporte sa source depuis
une photographie PostgreSQL read-only. #51-H2i ferme l'autorité PostgreSQL du
listener paper qui produit l'intention canary normale. #51-H2j ferme celle du
worker commun aux modes `dry-run` et `simulation-only`. #51-H2k-a ajoute la
paire durable entre la cible canary et son probe de simulation. #51-H2k-b
ajoute sa sélection et sa préparation one-shot exactes, mais le runner n'est
jamais démarré automatiquement. Ces livraisons préparent un preflight externe
sans armer ni démarrer un canary.

La validation paper Mainnet #49 reste `NON_EXECUTED / NON_VALIDATED`. Les
briques #51-G ne prouvent ni rentabilité, ni sellabilité générale, ni avantage
de position. Leur présence ne crée aucun armement, ne change pas `ENTRY_STOP`
et n'autorise aucune dépense. Aucune commande ci-dessous ne les enchaîne
automatiquement.

## Exporter la source persistée H2h

Utiliser un environnement dédié dont le login PostgreSQL 16 est membre
uniquement de `sol_token_operator_reader` :

```dotenv
DATABASE_URL=postgresql://...
EXECUTOR_PREFLIGHT_PREPARATION_RUN_ID=execution_preflight_preparation_<sha256>
EXECUTOR_PREFLIGHT_SOURCE_PATH=/chemin/hors-git/execution-preflight-source.json
```

Rejouer auparavant `scripts/provision-executor-roles.sql` en administrateur,
puis exécuter immédiatement avant H2g :

```bash
npm run build:backend
DOTENV_CONFIG_PATH=/chemin/hors-git/preflight-source.env \
  npm run executor:preflight-source:start
```

La commande ne sélectionne jamais « le dernier » objet : seul le run H2k-b
exact est accepté. Elle reconstruit dans une photographie unique la lignée
run/pair/candidate/assessment/artifact, la génération, les snapshots,
l'intention BUY `PENDING` non louée et la simulation `SUCCESS`. Elle vérifie
leurs fingerprints, leur finalité et leurs échéances, puis publie exclusivement
un nouveau fichier `0600` au schéma `execution-preflight-draft-source.v2`.
Elle refuse tout nom de variable RPC, wallet, keypair, mode live ou armement.
Son succès signifie seulement `PREFLIGHT_SOURCE_EXPORTED` et
`CANARY_NOT_STARTED`.

## Assemblage offline H2g

Après production de la source persistée par H2h, placer la source et le
catalogue de gates hors du checkout, en fichiers owner-only `0600`, puis lancer
`npm run executor:preflight-draft:start`. La commande exige les trois chemins
absolus `EXECUTOR_PREFLIGHT_SOURCE_PATH`,
`EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH` et `EXECUTOR_PREFLIGHT_DRAFT_PATH`.
Elle refuse DB, RPC, credentials Helius, wallet et configuration live, ne
remplace jamais un draft existant et affiche seulement un manifeste redacted.

Le draft produit reste non signé et n'autorise aucune dépense. Il est ensuite
fourni séparément à H2f. Une source saisie manuellement avant H2h ne constitue
pas une preuve opératoire.

## État et frontière de sécurité

Le constat livré obligatoire est :
`LIVE_SIGNABLE_RUNTIME_COMPOSED`, `READY_FOR_EXTERNAL_PREFLIGHT`, `CANARY_NOT_STARTED`,
`NON_EXECUTED / NON_VALIDATED`.

H2b est un processus signable isolé. Sa passe expose exactement quatre lanes,
dans cet ordre : recover SELL, execute SELL, recover BUY, execute BUY. Le
premier résultat `WORKED` arrête la passe. H2a reste le processus séparé de
finalité, confirmation, réconciliation et deadline. H2c fournit la préparation
opérateur, mais seul un opérateur externe peut autoriser le canary.

La configuration livrée reste désarmée : `.env.example` conserve
`EXECUTOR_MODE=dry-run`, `LIVE_TRADING_ENABLED=false` et aucun chemin de
keypair réel. Elle ne permet pas de démarrer H2b. La publication de H2b ne
crée aucune intention, ne lance ni `live:resume` ni `live:arm`, et n'exécute
aucun canary.

Les commandes du runtime signable existantes sont :

```bash
npm run executor:live:dev
npm run executor:live:start
```

Elles ne sont pas une procédure d'armement. La procédure H2c ci-dessous reste
séquentielle, interactive et sans commande englobante.

## Frontières des sept environnements PostgreSQL

Créer sept fichiers hors Git, lisibles seulement par leur compte de service :

- listener H2i : login `NOINHERIT` membre uniquement de
  `sol_token_listener_writer`, connexion avec
  `options=-c role=sol_token_listener_writer`,
  `POSTGRES_AUTO_MIGRATE=false`,
  `LISTENER_INGESTION_SCOPE=launchpad-only` et aucun keypair ;

- worker H2j : login `NOINHERIT` membre uniquement de
  `sol_token_executor_worker`, connexion avec
  `options=-c role=sol_token_executor_worker`, `POSTGRES_AUTO_MIGRATE=false`,
  `LIVE_TRADING_ENABLED=false` et aucun keypair ;

- readiness H2d : login membre uniquement de
  `sol_token_executor_readiness`, endpoint HTTP Mainnet qualifié, adresse
  publique et preuve provider signée ; aucun nom de variable live ou secret ;
- opérations : login membre uniquement de `sol_token_executor_operations`,
  `LIVE_TRADING_ENABLED=false`, aucun nom de variable keypair et aucun RPC ;
- export H2h : login membre uniquement de `sol_token_operator_reader`, aucune
  variable RPC, wallet, keypair, mode live ou armement ;
- H2a : login membre uniquement de `sol_token_executor_live_recovery`, aucun
  nom de variable keypair ;
- H2b : login membre uniquement de `sol_token_executor_live`, keypair externe
  `0400` ou `0600`, `EXECUTOR_MODE=live` et activation explicite.

Après les migrations 040 et 041, l'administrateur rejoue
`scripts/provision-executor-roles.sql`. Chaque login doit être `NOINHERIT`, ne
recevoir qu'un seul rôle de groupe avec `ADMIN FALSE, INHERIT FALSE, SET TRUE`,
et ne posséder aucun objet. Les processus forcent `SET ROLE`,
`search_path=pg_catalog,public` et `session_replication_role=origin` à chaque
checkout. Le rôle opérations ne peut ni lire les bytes signés ou non signés,
ni armer des champs runtime arbitraires, ni modifier les intents ; H2a,
listener et API ne gagnent aucune autorité H2c.

Depuis la racine du dépôt, utiliser cette commande canonique :

```bash
psql -X -v ON_ERROR_STOP=1 -f scripts/provision-executor-roles.sql
```

`-X` ignore tout `psqlrc` local et `ON_ERROR_STOP` interrompt l'exécution à la
première erreur. La connexion administrative doit être injectée par le mécanisme
libpq de l'environnement opérateur, par exemple `PGSERVICE` et un `PGPASSFILE`
externe en mode `0600`, ou par le gestionnaire de secrets du déploiement. Ne
jamais placer une URL, un login ou un mot de passe dans la commande, le dépôt ou
l'historique du shell.

Après succès, exécuter avec la même connexion le contrôle d'inventaire read-only
suivant :

```sql
WITH expected(policy_name, relation_name) AS (VALUES
  ('execution_intents_worker_partition', 'execution_intents'),
  ('execution_dry_run_assessments_worker_partition', 'execution_dry_run_assessments'),
  ('execution_attempts_worker_partition', 'execution_attempts'),
  ('execution_intent_transitions_worker_partition', 'execution_intent_transitions'),
  ('execution_simulation_artifacts_worker_partition', 'execution_simulation_artifacts')
), targets AS (
  SELECT target.role_oid
  FROM expected
  JOIN pg_catalog.pg_namespace namespace ON namespace.nspname = 'public'
  JOIN pg_catalog.pg_class relation
    ON relation.relnamespace = namespace.oid
    AND relation.relname = expected.relation_name
  JOIN pg_catalog.pg_policy policy
    ON policy.polrelid = relation.oid
    AND policy.polname = expected.policy_name
    AND NOT policy.polpermissive
    AND policy.polcmd = '*'
  CROSS JOIN LATERAL pg_catalog.unnest(policy.polroles) AS target(role_oid)
)
SELECT COUNT(*) AS policy_count,
  COUNT(DISTINCT role_oid) AS target_oid_count,
  BOOL_AND(role_oid = 'sol_token_executor_worker'::regrole::oid) AS canonical_only
FROM targets;
```

Le résultat exigé est exactement :

```text
policy_count | target_oid_count | canonical_only
5            | 1                | t
```

Toute autre valeur interdit de démarrer le worker et impose une investigation
administrative ; ne pas corriger manuellement les policies.

Le listener H2i utilise le paramètre de connexion PostgreSQL pour fixer son
rôle sur chaque connexion du pool. Il peut écrire ses projections métier et
insérer une intention, mais ne peut ni modifier une intention existante, ni
lire ou écrire génération wallet, risque live, contrôle, armement, lock,
transaction signée, soumission ou réconciliation. Arrêter le listener, ou
remettre `EXECUTION_INTENT_EMISSION_ENABLED=false`, avant le preflight H2c.

Son environnement doit contenir explicitement :

```dotenv
LISTENER_INGESTION_SCOPE=launchpad-only
```

Ne pas omettre cette ligne : le défaut `launchpad-and-market` préserve la
compatibilité générale et réactiverait donc le flux global PumpSwap. En
`launchpad-only`, Pump.fun reste observé et une migration Pump.fun peut encore
apporter sa preuve PumpSwap dans la même transaction ; le suivi global des
swaps PumpSwap est volontairement inactif et l'API doit exposer
`pipeline.pumpswap=IDLE`. Aucune preuve market antérieure ne doit dégrader cet
état. Ce scope ne change aucune gate H2c et n'autorise aucune action réelle.

## Exécuter H2j sans autorité live

L'administrateur rejoue d'abord `scripts/provision-executor-roles.sql`, puis
crée un login de service mono-membre sans privilège direct. Le fichier
d'environnement reste hors Git, appartient au compte du worker et porte un
mode exact `0600`. La `DATABASE_URL` est propre à ce worker ; son paramètre
`options` active le groupe et fixe aussi le `search_path` :

```dotenv
DATABASE_URL=postgresql://<login-worker-dedie>:<secret>@<postgres16>/<database>?options=-c%20role%3Dsol_token_executor_worker%20-c%20search_path%3Dpg_catalog%2Cpublic
POSTGRES_AUTO_MIGRATE=false
LIVE_TRADING_ENABLED=false
```

```bash
chmod 0600 /chemin/hors-git/executor-worker.env
npm run build:backend
DOTENV_CONFIG_PATH=/chemin/hors-git/executor-worker.env \
  EXECUTOR_MODE=dry-run npm run executor:start
DOTENV_CONFIG_PATH=/chemin/hors-git/executor-worker.env \
  EXECUTOR_MODE=simulation-only npm run executor:start
```

Le second mode exige en plus les paramètres de simulation non signants déjà
documentés : adresse `EXECUTOR_PUBLIC_KEY`, provider positionnel, URL RPC,
genesis attendu, limites et allowlist quote. Cette URL RPC potentiellement
confidentielle doit rester dans un fichier externe `0600` et n'est jamais
journalisée. Ces paramètres peuvent résider dans un second fichier de ce type,
avec la même `DATABASE_URL` dédiée. Aucun des deux fichiers ne contient de
keypair, seed, armement ou configuration live.

Le rôle peut louer puis restituer une intention, écrire l'assessment dry-run ou
la tentative, la transition et l'artefact de simulation non signé attendus. Il
ne peut ni migrer le schéma, ni accéder aux tables de wallet, risque, contrôle,
armement, lock, bytes signés, budget RPC live, soumission, position live ou
réconciliation. Le résultat opérationnel reste `CANARY_NOT_STARTED`.

La migration 040 porte `live_reserved` uniquement sur `execution_intents` et
filtre les quatre tables enfants par `intent_id`. Le worker ne peut jamais lire
ni altérer une intention `live_reserved=true` ou ses enfants. Les claims
`DRY_RUN` et `EXECUTE` exigent `live_reserved=false`; `LIVE_EXECUTE`,
`LIVE_RECOVER`, `CONFIRM` et `RECONCILE` exigent `live_reserved=true`. Le
propriétaire administratif et migrateur conserve son bypass avec RLS sans
`FORCE ROW LEVEL SECURITY`. `SELECT(live_reserved)` est exigé techniquement par
PostgreSQL pour les predicates de claim et la policy, mais RLS masque toute
ligne `true` et la colonne ne devient jamais un contrat domaine ou API. La
migration refuse une
forme préexistante différente de `BOOLEAN NOT NULL DEFAULT FALSE`. Lorsque le
rôle worker est absent, elle installe un placeholder restrictif neutre ; le
provisioning le remplace par cinq policies liées à l'OID du groupe. Au replay,
l'inventaire doit être exactement 5/5 et viser un OID unique. Un ancien OID
renommé est démoté ; ses memberships, réglages et droits sont révoqués
atomiquement avant `DROP OWNED` et rebind. Un ownership ou une dépendance dans
une autre base fait échouer fermé. Une session active stale perd toute autorité
et le rôle canonique reçoit les cinq policies finales. Les guards enfants sont
`SECURITY INVOKER` et restent soumis à RLS. Le `owner`, les superusers et rôles
`BYPASSRLS` constituent une limite de confiance intentionnelle réservée à
l'administration. Le déni de service pré-promotion reste possible, sans
capacité de signature ni de soumission.

## Activer l'émission H2k-a uniquement après déploiement contrôlé

H2k-a est disponible après merge, mais sa configuration sûre reste :

```dotenv
EXECUTION_PREFLIGHT_PAIR_EMISSION_ENABLED=false
```

La valeur `true` n'est acceptée qu'avec `EXECUTION_MODE=paper`,
`EXECUTION_INTENT_EMISSION_ENABLED=true`, l'allowlist quote limitée à WSOL/SPL
Token 9 décimales et `PAPER_MINIMUM_CONFIRMATION=finalized`. Avant toute
activation, appliquer les migrations jusqu'au head 043, rejouer le
provisioning des rôles et redémarrer le listener H2i. L'activation ne lance ni
le worker H2j, ni H2h, ni
un runtime live, et ne provoque aucun appel RPC supplémentaire.

Pour chaque nouvel OPEN admissible, une transaction atomique persiste :

1. la cible `TARGET`, BUY `paper_open_…`, qui reste `PENDING`, tentative zéro,
   sans lease et `live_reserved=false` ;
2. le probe `SIMULATION`, BUY `execution_preflight_probe_…`, économiquement et
   causalement identique mais doté d'une identité distincte ;
3. la paire append-only et ses deux memberships uniques.

Le claim générique `EXECUTE` de `simulation-only` exclut la cible et peut
consommer seulement le probe. Le `dry-run` reste non consommant. Un trigger
PostgreSQL interdit de promouvoir le probe vers `live_reserved=true`, et le
repository opérations refuse aussi ce probe comme cible H2c. Les intentions
historiques non appairées restent compatibles.

À expiration, le job de rétention fait passer par lots les intentions encore
pré-signature vers `EXPIRED`, avec transition persistée. La purge de la paire
attend `expires_at + 4 hours` ainsi que le `purge_after` de chaque parent
terminal et réconcilié, soit quatre heures après sa terminalisation. Elle
supprime ensuite enfants, memberships, paire et parents dans l'ordre des FK et
conserve les tombstones anti-rejeu.

La migration 042 ajoute les runs persistés H2k-b et la migration 043, head
canonique, ajoute la lignée `candidate_id` finalisée de l'intention. H2k-a
n'ajoute aucun wallet, keypair, signer, armement, byte signé ou transport de
soumission ; le constat reste `CANARY_NOT_STARTED`.

## Préparer exactement une paire avec H2k-b

Le runner H2k-b est une commande one-shot séparée et désactivée par défaut.
Il ne faut jamais ajouter de sélecteur pair, target, simulation, mint ou SQL :
la commande choisit elle-même une unique paire éligible dans sa fenêtre
persistée, exécute le dry-run non consommant de la cible puis la simulation du
probe, et termine en `PREPARED` ou `FAILED`.

Étendre un environnement `simulation-only` H2j dédié, owner-only et hors Git,
avec les seules variables H2k-b suivantes :

```dotenv
EXECUTOR_PREFLIGHT_PREPARATION_ENABLED=true
EXECUTOR_PREFLIGHT_PREPARATION_SELECTION_WINDOW_MS=120000
EXECUTOR_PREFLIGHT_PREPARATION_LEASE_MS=60000
EXECUTOR_PREFLIGHT_PREPARATION_OUTPUT_PATH=/chemin/hors-git/execution-preflight-preparation.json
```

Puis lancer explicitement :

```bash
npm run build:backend
DOTENV_CONFIG_PATH=/chemin/hors-git/preflight-preparation.env \
  npm run executor:preflight-preparation:start
```

Le fichier de sortie est créé exclusivement en `0600`. Le résumé terminal
redacted fournit le `runId`; ce seul identifiant est transmis à H2h v2. Le
runner n'est importé par aucun bootstrap, ne charge aucune clé, ne signe,
n'arme et ne soumet rien. L'exemple suivi conserve le flag à `false` et l'état
reste `CANARY_NOT_STARTED`.

## Produire la preuve Helius H2e

Créer trois fichiers hors Git dans un répertoire privé : la clé API Helius, une
clé d'attestation Ed25519 dédiée et la future enveloppe. La clé d'attestation
n'est pas une clé Solana. Les deux entrées doivent appartenir au compte courant
et avoir un mode exact `0400` ou `0600`.

La clé Ed25519 peut être créée hors dépôt avec Node.js 22, déjà requis par le
projet. La création exclusive refuse d'écraser une clé existante :

```bash
node --input-type=module -e "
  import { generateKeyPairSync } from 'node:crypto';
  import { writeFileSync } from 'node:fs';
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(
    '/chemin/hors-git/provider-attestation-key.pem',
    privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { flag: 'wx', mode: 0o600 },
  );
"
chmod 0600 /chemin/hors-git/provider-attestation-key.pem
chmod 0600 /chemin/hors-git/helius-api-key
```

Créer un environnement H2e séparé :

```dotenv
HELIUS_PROJECT_ID=<uuid-visible-dans-le-dashboard-helius>
HELIUS_API_KEY_PATH=/chemin/hors-git/helius-api-key
EXECUTOR_RPC_PROVIDER_ID=helius-primary
EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH=/chemin/hors-git/provider-attestation-key.pem
EXECUTOR_PROVIDER_EVIDENCE_PATH=/chemin/hors-git/provider-evidence.json
EXECUTOR_PROVIDER_EVIDENCE_TTL_MS=300000
EXECUTOR_PROVIDER_EVIDENCE_TIMEOUT_MS=5000
```

Ce fichier ne doit contenir aucun nom de variable wallet, live, RPC Solana ou
PostgreSQL, même vide. Les trois chemins sont refusés s'ils se trouvent dans le
checkout, directement ou via un parent symlink. Exécuter immédiatement avant
H2d :

```bash
npm run build:backend
DOTENV_CONFIG_PATH=/chemin/hors-git/provider-evidence.env \
  npm run executor:provider-evidence:start
```

Auditer le manifeste redacted puis recopier uniquement sa
`evidencePublicKeyBase64` et le chemin de sortie dans l'environnement H2d. La
commande fait exactement une lecture Helius Admin API, sans retry, et n'expose
ni clé API, ni projet UUID, ni quota détaillé. Son succès signifie seulement
`PROVIDER_EVIDENCE_COLLECTED / CANARY_NOT_STARTED`.

## Collecter les preuves publiques H2d

Créer un environnement dédié hors Git contenant exactement les variables
publiques et credentials d'infrastructure nécessaires :

```dotenv
DATABASE_URL=postgresql://<login-readiness-dedie>:...@<postgres16>/<database>
SOLANA_CLUSTER=mainnet-beta
SOLANA_HTTP_RPC_URL=https://<endpoint-mainnet-qualifie>
SOLANA_EXPECTED_GENESIS_HASH=<genesis-mainnet-verifie-independamment>
EXECUTOR_RPC_PROVIDER_ID=helius-primary
EXECUTOR_PUBLIC_KEY=<adresse-publique-base58>
EXECUTOR_WALLET_GENERATION_NUMBER=1
EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64=<cle-publique-ed25519-spki-der-base64>
EXECUTOR_PROVIDER_EVIDENCE_PATH=/chemin/absolu/hors-git/provider-evidence.json
EXECUTOR_READINESS_MAX_SLOT_LAG=8
EXECUTOR_RPC_TIMEOUT_MS=5000
```

Le fichier ne doit contenir aucun nom `EXECUTOR_MODE`,
`LIVE_TRADING_ENABLED`, keypair, clé privée, mnemonic ou recovery phrase,
même avec une valeur vide. Après migrations 001–040, rejouer deux fois le
provisioning, créer un login `NOINHERIT` sans autorité directe et lui accorder
uniquement `sol_token_executor_readiness` avec
`ADMIN FALSE, INHERIT FALSE, SET TRUE`. Lancer ensuite :

```bash
npm run build:backend
DOTENV_CONFIG_PATH=/chemin/hors-git/readiness.env \
  npm run executor:readiness:start
```

Conserver le manifeste redacted. Le succès signifie uniquement
`READINESS_EVIDENCE_COLLECTED / CANARY_NOT_STARTED`. La commande n'accepte ni
wallet secret ni signer et ne lance jamais `live:preflight`, `live:resume`,
`live:arm`, H2a ou H2b. Les snapshots remplacés deviennent purgeables après
quatre heures ; la génération active et les preuves référencées sont gardées.

## Produire le paquet d'attestations H2f

Après sélection de l'intention BUY et production réelle des onze preuves,
créer hors Git un draft canonique conforme à
`execution-preflight-bundle-draft.v1`. Il contient le manifeste H2d exact, les
champs d'entrée de qualification, la policy, les snapshots complets persistés
et l'identifiant d'intention. Les entiers `bigint` utilisent le marqueur JSON
versionné du projet. H2f ne génère ni ne déclare une preuve `PASSED` à la place
de l'opérateur.

Créer un environnement séparé qui ne contient aucun accès RPC, base, Helius
ou live :

```dotenv
EXECUTOR_PREFLIGHT_DRAFT_PATH=/chemin/hors-git/draft.json
EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH=/chemin/hors-git/provider-attestation-key.pem
EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY=/chemin/hors-git/bundle-unique
```

Le draft et la clé sont owner-only `0400` ou `0600`. Le répertoire final doit
être absent et extérieur au checkout. Exécuter :

```bash
npm run build:backend
DOTENV_CONFIG_PATH=/chemin/hors-git/preflight-bundle.env \
  npm run executor:preflight-bundle:start
```

Le répertoire est publié atomiquement en `0700` avec
`qualification.json`, `canary.json` et `manifest.json` en `0600`. La commande
auto-vérifie les deux signatures et affiche uniquement le manifeste redacted.
Elle refuse aussi les délais de fraîcheur dérivés de la policy déjà consommés
et retire le répertoire final si son fence de durabilité parent échoue.
Son succès signifie `PREFLIGHT_EVIDENCE_PACKAGED / CANARY_NOT_STARTED`, jamais
un armement ou un verdict de sécurité économique.

## Procédure H2c manuelle, avec arrêt après chaque étape

1. Exécuter H2d, auditer son manifeste et transmettre ses identités exactes au
   producteur externe de qualification et de sidecar H2c.
2. Démarrer le listener sans keypair en `EXECUTION_MODE=paper` avec
   `EXECUTION_INTENT_EMISSION_ENABLED=true` et
   `LISTENER_INGESTION_SCOPE=launchpad-only`. Cette émission temporaire utilise
   le producteur normal ; ne jamais fabriquer une cible par SQL. Vérifier que
   l'API expose `pipeline.pumpswap=IDLE` avant de poursuivre.
3. Arrêter le listener ou remettre l'émission à `false`, puis lancer une fois
   H2k-b. Vérifier son run `PREPARED`, auditer le manifeste
   `PREFLIGHT_INTENT_PREPARED` et la paire sélectionnée, puis conserver son
   `runId`; ne jamais fabriquer ni sélectionner la cible par SQL.
4. Exécuter H2h v2 avec ce seul `preparationRunId`. Auditer son manifeste
   redacted et conserver la source `execution-preflight-draft-source.v2` en
   `0600`.
5. Construire le catalogue réel des huit gates statiques, exécuter H2g avec la
   source H2h, puis auditer le draft canonique obtenu. H2g ne déclare aucune
   preuve à la place de l'opérateur.
6. Exécuter H2f sur ce draft afin de produire le paquet Ed25519 frais qui lie
   l'intention, les onze gates, les snapshots wallet/provider, le genesis, le
   build, la stratégie et la configuration. Recopier les deux chemins du
   paquet vers l'environnement opérations ; H2f ne fournit pas la clé de
   preuve.
7. Depuis l'environnement opérations, exécuter séparément :

   ```bash
   DOTENV_CONFIG_PATH=/chemin/hors-git/operations.env npm run live:preflight
   DOTENV_CONFIG_PATH=/chemin/hors-git/operations.env npm run live:status
   ```

   Le résultat attendu à ce point reste `ENTRY_STOP`, sans armement actif.
   Vérifier manuellement tous les fingerprints et les expirations.
8. Exécuter `live:resume` dans un vrai TTY, recopier exactement la phrase
   affichée, puis relire `live:status`. Cette étape n'arme aucune intention.
9. Renseigner temporairement `EXECUTOR_CANARY_EVIDENCE_PATH` dans
   `operations.env`, puis armer la seule cible avec des entiers audités :

   ```bash
   DOTENV_CONFIG_PATH=/chemin/hors-git/operations.env npm run live:arm -- \
     --intent-id=execution_intent_<sha256> \
     --maximum-lamports=<plafond-entier-valide-hors-chaine> \
     --holding-ms=<30000-a-900000> \
     --reason=<motif-operateur-sans-secret>
   DOTENV_CONFIG_PATH=/chemin/hors-git/operations.env npm run live:status
   DOTENV_CONFIG_PATH=/chemin/hors-git/operations.env npm run live:report
   ```

   `live:arm` exige un TTY et fait afficher la cible complète, les limites, les
   fingerprints et un nonce. Sa requête wire porte `payloadVersion: 3`; après
   validation, la réservation d'exposition et l'armement persisté V2 sont
   atomiques. Tout écart laisse zéro capacité live.
10. Seulement après inspection humaine de l'armement, démarrer H2a avec son
   environnement dédié, puis H2b avec le sien. Le démarrage H2b valide rôle,
   migration 043, génération, genesis, les huit limites runtime exactes et
   absence d'état incohérent avant de charger le signer. Il ne doit traiter
   que la cible armée, y compris après redémarrage sur un artefact persisté.
11. Surveiller continuellement les sorties structurées H2a/H2b et les commandes
   `live:status`/`live:report`. Toute dérive, lock pré-signature abandonné,
   expiration, échec de gate ou ambiguïté impose au minimum `ENTRY_STOP`.
12. Après fermeture ou incident, appliquer `ENTRY_STOP`, arrêter H2b, laisser
   H2a finaliser/réconcilier, puis collecter les preuves et relire les états.
   Un état inconnu n'autorise jamais un nouvel armement.

Cette procédure ne démarre rien par elle-même. Les placeholders doivent être
remplacés et validés hors dépôt ; aucune valeur fiat n'est convertie par le
programme et tous les montants financiers restent des entiers.

## Démarrer uniquement la récupération de finalité H2a

Utiliser un environnement dédié qui ne contient aucun nom de variable de
keypair, clé privée ou secret wallet, même vide. Les valeurs suivantes sont
publiques mais doivent être vérifiées par l'opérateur :

```dotenv
EXECUTOR_LIVE_RECOVERY_ENABLED=true
EXECUTOR_MODE=live
SOLANA_CLUSTER=mainnet-beta
DATABASE_URL=postgresql://<login-recovery-dedie>:...@127.0.0.1:5432/solanabot
EXECUTOR_WALLET_GENERATION_ID=execution_wallet_generation_<sha256>
EXECUTOR_PUBLIC_KEY=<adresse-publique-base58>
EXECUTOR_RPC_PROVIDER_ID=primary
SOLANA_HTTP_RPC_URL=https://<endpoint-qualifie>
SOLANA_EXPECTED_GENESIS_HASH=<hash-genesis-mainnet-verifie>
EXECUTOR_POLL_MS=1000
EXECUTOR_LEASE_MS=60000
EXECUTOR_DB_STATEMENT_TIMEOUT_MS=3000
EXECUTOR_SHUTDOWN_GRACE_MS=10000
EXECUTOR_RPC_TIMEOUT_MS=5000
EXECUTOR_MAX_RPC_CALLS_PER_PASS=8
EXECUTOR_LIVE_RECOVERY_OWNER_ID=<instance-unique>
```

Après build, lancer seulement :

```bash
DOTENV_CONFIG_PATH=/chemin/hors-git/live-recovery.env \
  npm run executor:live:recovery:start
```

Cette commande vérifie rôle, migrations, génération, provider et genesis avant
la première claim. Elle ne charge aucun signer, n'arme rien et ne soumet aucune
transaction.

Avant ce démarrage, un administrateur rejoue
`scripts/provision-executor-roles.sql`, crée hors dépôt un login dédié
`LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS`, puis lui accorde uniquement `sol_token_executor_live_recovery`
avec PostgreSQL 16 `WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`. Le mot de passe
et le nom du login ne sont jamais committés. Recovery ne doit être membre
d'aucun autre rôle. Le runtime contrôle ce graphe et l'allowlist effective
complète à chaque démarrage ; il refuse toute autorité supplémentaire, tout
droit ou ownership direct du login et toute routine `SECURITY DEFINER`
accessible hors schémas système. Chaque checkout force également
`search_path=pg_catalog,public`. Le démarrage vérifie aussi l'exécutabilité des
deux helpers `SECURITY INVOKER` du ledger, refuse le privilège `SET` sur
`session_replication_role`, interdit tout `GRANT OPTION` sur l'autorité recovery
et exige la valeur `origin` avant toute claim. L'allowlist couvre tous les
schémas non système et refuse tout droit résiduel hors `public`, y compris via
une vue exposant indirectement des colonnes sensibles.

Les réponses de statut Solana acceptent `RpcResponseContext.apiVersion`
lorsqu'il s'agit d'une chaîne ; tout autre champ de contexte inconnu reste
rejeté afin de détecter une dérive de contrat RPC.

Une lecture `getTransaction` finalisée sans transaction porte la date de cette
preuve. Combinée à une absence historique, des deltas nuls et un blockhash
expiré au niveau finalisé, elle clôt la réconciliation en `NO_EFFECT`.

Le runtime H2a traite, dans l'ordre, une réconciliation finalized, une
confirmation ou une échéance par passe. Il ne réclame jamais `LIVE_RECOVER`,
`LIVE_EXECUTE/SELL` ou `LIVE_EXECUTE/BUY`; il ne peut donc ni reprendre des
bytes signés, ni créer une signature, ni envoyer une transaction. Son
démarrage ne vaut ni armement ni autorisation de canary.

La migration 037 et les repositories #51-H1 fournissent les claims
`LIVE_EXECUTE` SELL/BUY et `LIVE_RECOVER`, les read-models durables de
confirmation et réconciliation, ainsi que le scan atomique des sorties à
deadline. H2b les compose seulement pour la reprise et l'exécution signables ;
H2a conserve les read-models de finalité et le scan à deadline.

La migration 038 persiste le budget RPC total H2b par tentative. Les appels
déjà utilisés par la préparation non signée initialisent ce budget ; chaque
appel du tail signable est ensuite réservé avant le contact provider. Une
reprise, une nouvelle passe ou un redémarrage ne remet donc jamais le compteur
à zéro. Une réservation perdue par crash reste consommée et l'épuisement ferme
la tentative avant tout nouvel appel réseau. Avant `SUBMISSION_STARTED`, cet
épuisement est persisté en `REVOKED_NO_SEND` et sa reprise ne contacte plus le
provider. Après `SUBMISSION_STARTED`, il reste `AMBIGUOUS`, car une émission
ne peut plus être exclue ; il n'est jamais reclassé en révocation.
Le slot du seul `sendTransaction` est réservé séparément après la preuve de
blockhash et avant `SUBMISSION_STARTED`. Seul le fetch `sendTransaction` peut
consommer ce prépaiement. Un crash dans cet intervalle conserve le slot comme
consommé ; la reprise ne le rembourse pas et doit en réserver un nouveau.

La migration 039 lie l'armement canary V2 à une intention BUY et à sa révision
exacte, aux snapshots signés, à la politique et aux limites runtime. Elle
ajoute le lock pré-signature qui persiste les octets non signés avant l'appel
au signer et relie ensuite l'artefact signé au même lock. La récupération au
bootstrap puis périodique révoque atomiquement tout lock échoué ou abandonné,
libère sa réservation et place le contrôle en `ENTRY_STOP`, sans signer ni
contacter le provider. Un événement système conserve la justification.

La priorité SELL est protégée transactionnellement : chaque création SELL et
chaque claim BUY live prennent le même verrou advisory de présence SELL. Le
claim BUY impose `READ COMMITTED`, forme ensuite un nouveau snapshot PostgreSQL
et reste vide dès qu'un SELL exécutable existe, même lorsque le rôle configure
une isolation par défaut plus forte. Le scanner de deadline prend ses verrous
dans l'ordre global scan, présence SELL, génération afin d'éviter inversion et
interblocage.

Une réconciliation SELL qui prouve `NO_EFFECT` ne rend pas l'intention
`RETRY_READY` hors de ce fence. Elle prend d'abord le verrou de présence SELL,
puis le verrou génération et les lignes métier. La transition générique
équivalente applique le même ordre avant son row lock.

La persistance signée d'un SELL prend elle aussi le verrou de présence avant la
génération. Un SELL `PROCESSING` expiré pendant son lease ne peut donc devenir
`SIGNED_NOT_SUBMITTED` en concurrence invisible avec un claim BUY.

Le dernier verrou PostgreSQL est atomique : avant `SUBMISSION_STARTED`, il
revalide la génération active, les bindings runtime/déploiement, le provider,
la quote non expirée, les plafonds BUY ou l'autorisation de sortie SELL, ainsi
qu'une preuve fraîche de validité du blockhash. La preuve complète est écrite
dans `execution_submission_preflight_evidence` dans la même transaction que
la transition et ne peut pas être modifiée.

Pour un BUY, l'admission conserve aussi les baselines risque, drawdown, quota
local et compteur 429. Toute dérive défavorable avant l'envoi ferme le gate.
Les simulations non signée et signée sont deux preuves append-only liées au
même artefact ; une altération ou une liaison incomplète empêche
`SIGNED_SIMULATED`.

H2b vérifie le genesis au démarrage et obtient immédiatement avant ce verrou
une preuve fraîche de validité du blockhash. Il persiste les mêmes octets
signés avant simulation signée puis soumission, utilise `maxRetries=0` et
classe toute issue incertaine comme `AMBIGUOUS`; il ne reconstruit ni ne
resigne un artefact récupéré.

## PostgreSQL et rétention

Après les migrations, un administrateur peut appliquer
`scripts/provision-executor-roles.sql`. Il crée des rôles de groupe `NOLOGIN`,
sans mot de passe ni privilège cluster. Le compte LOGIN H2b reçoit seulement
`sol_token_executor_live`; le compte H2a distinct reçoit seulement
`sol_token_executor_live_recovery`; les commandes opérateur utilisent un
troisième compte recevant seulement `sol_token_executor_operations`. Le worker
H2j possède encore un login distinct, membre uniquement de
`sol_token_executor_worker`, pour `dry-run` et `simulation-only`.

La rétention utilise un second compte LOGIN dédié qui doit recevoir seulement
`sol_token_retention_worker`. Il ne doit jamais être partagé avec le listener,
l'API, les opérations ou l'exécuteur live. Sa `DATABASE_URL` est injectée
uniquement dans le job planifié, puis celui-ci lance
`npm run db:purge:compiled` ou `npm run retention:start:compiled`. Le script de
provisioning doit être rejoué par l'administrateur après toute migration qui
ajoute une table à la purge ; le job reste arrêté si ce provisioning échoue.

Le rôle signable `sol_token_executor_live` est le seul rôle applicatif autorisé
à lire les octets signés. Le rôle H2a recovery ne reçoit que les colonnes et
mutations de finalité nécessaires ; `signed_transaction_bytes`, mutation de
signature, simulation signée, préflight et démarrage de soumission lui sont
interdits. Listener, worker `dry-run`/`simulation-only`, opérations, lecteur
opérateur et API publique n'ont aucun accès aux bytes signés. Seul le rôle de
rétention reçoit les `DELETE` nécessaires à la purge. Il n'obtient qu'une
lecture par colonnes
de l'identifiant, de l'état, de l'échéance, de l'autorisation de sortie, de
l'identifiant de lock et de la réservation sur `execution_signed_transactions` :
`signed_transaction_bytes` lui reste
inaccessible, y compris via `RETURNING`.

Le provisioning H2b révoque aussi `TEMPORARY` de `PUBLIC` sur la seule base de
données provisionnée. `PUBLIC TEMP` est un prérequis de sécurité DB-scoped sur
cette base de données :
une table temporaire homonyme pourrait masquer une table `public`. Cette
révocation ne s'applique ni globalement aux autres bases ni à d'autres rôles ;
les accès explicitement nécessaires sont réaccordés par l'administrateur.

La transaction de purge prend d'abord le verrou advisory
`foundation-retention-fence:v1`. Un seul job de rétention peut donc former des
cohortes à la fois, sans `SELECT ... FOR UPDATE` et sans droit de mise à jour
sur les états live/risk. Les seuls `UPDATE` accordés au rôle sont les colonnes
que la rétention remet effectivement à zéro ou terminalise dans
`execution_intents`, `execution_attempts`, `paper_mvp_runs`,
`listener_websocket_health`, `chain_transaction_inbox` et
`api_event_stream_state`. Pour H2k-a, elle expire d'abord les intentions
pré-signature échues, puis ne purge une paire que lorsque target et probe sont
tous deux terminaux, réconciliés, sans lease et arrivés au terme de leur fenêtre
de quatre heures.

La purge supprime après quatre heures, par cohorte et dans l'ordre enfant
d'abord, uniquement :

- les artefacts `RECONCILED` ou `REVOKED_NO_SEND` et leurs événements ;
- les locks pré-signature `SIGNED_PERSISTED` ou `REVOKED`, uniquement lorsque
  plus aucun artefact ou événement de contrôle ne les référence ;
- les autorisations `CONSUMED` ou `REVOKED` sans artefact restant ;
- les positions `CLOSED` sans autorisation restante.

Un artefact `AMBIGUOUS`, un lock `LOCKED`, une position `OPEN`, `EXIT_PENDING`
ou `UNKNOWN`, et une autorisation `ACTIVE` ou `LOCKED` ne sont jamais
candidats. Les tombstones
anti-rejeu minimaux des intentions restent durables.

## Configuration H2b désarmée

Le fichier `.env.example` liste les limites publiques, mais sa configuration
reste dry-run et désarmée. H2b valide le build, la configuration, la stratégie,
la génération wallet, le provider et le genesis avant d'ouvrir son secret. Si
un déploiement H2b est préparé ultérieurement dans le cadre de H2c, son keypair
reste hors dépôt dans un fichier régulier non symlink, propriétaire du
processus et mode exact `0400` ou `0600`.

Ne jamais écrire le contenu du keypair dans `.env`, PostgreSQL, un log, une
preuve ou un ticket. H2b ne fournit ici ni clé réelle, ni financement, ni
armement, ni procédure de canary.

## Gates H2c et canary non démarré

H2c vérifie les preuves et lie l'armement exact, mais H2b ne modifie jamais
l'état de contrôle et n'exécute pas `live:resume` ou `live:arm`. Le dépôt ne
contient ni secret, ni endpoint réel, ni armement actif. L'état livré est
`READY_FOR_EXTERNAL_PREFLIGHT`, jamais `PASS`.

## Kill switches et arrêt

L'arrêt d'entrée bloque les nouveaux BUY mais préservera sorties et
réconciliation :

```bash
npm run live:kill-switch -- \
  --mode=entry-stop \
  --reason=OPERATOR_ENTRY_STOP
```

L'arrêt dur est réservé au cas où continuer à signer ou envoyer est plus
risqué qu'une position non clôturée :

```bash
npm run live:kill-switch -- \
  --mode=hard-stop \
  --reason=OPERATOR_HARD_STOP
```

Une soumission incertaine impose la réconciliation des mêmes octets et de la
même signature. Elle n'autorise ni nouveau blockhash, ni nouvel ordre logique,
ni réarmement. Un arrêt normal applique d'abord `entry-stop`, enverra
`SIGTERM`, attendra l'arrêt borné, puis relira `live:status` et `live:report`.

Après redémarrage, l'état durable décide du seul chemin autorisé. En
particulier, `SUBMISSION_STARTED` devient `AMBIGUOUS` sans nouvel appel RPC,
puis la signature persistée est confirmée et réconciliée. Les états
`ACCEPTED`, `AMBIGUOUS` et `REVOKED_NO_SEND` sont rejoués sans nouvelle
signature ni nouvelle soumission.

La lane H2b de reprise découvre l'artefact à partir du claim durable
intent/tentative et recharge depuis PostgreSQL les bytes exacts ainsi que la
preuve non signée canonique. Il ne dépend pas d'un candidat opaque resté en
mémoire avant le crash. Elle reprend la simulation signée ou le dernier
preflight depuis cet artefact, sans reconstruire la transaction ni résigner.

## Critère de canary H2c

Un canary ne pourra être déclaré `PASS` qu'avec un BUY et un SELL finalisés et
réconciliés, zéro double ordre, zéro résiduel inattendu, position `CLOSED`,
autorisation et armement consommés, et aucun état inconnu. Une absence
d'opportunité, un BUY refusé ou une fermeture sans transaction ne vaut pas
`PASS`.

Ce critère H2c ne modifie pas le constat livré défini en tête de ce runbook.
