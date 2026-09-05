# Executor live — préparation opérateur du canary Mainnet (#51-H2c)

**Version :** 1.11.0 — 2026-09-05

Ce document décrit l'état réellement livré. #51-H2a publie
`executor:live:recovery:start`, un processus de finalité read-only sans keypair,
signature ni soumission. #51-H2b publie séparément
`executor:live:dev` et `executor:live:start`. #51-H2c ajoute les gates, un
armement V2 lié à une intention BUY exacte, le lock durable avant signature et
sa récupération fail-closed. #51-H2d ajoute le bootstrap non signant des
snapshots wallet/provider. #51-H2e produit l'attestation de quota Helius
consommée par H2d. #51-H2f valide et signe hors ligne les deux enveloppes H2c
dans un paquet atomique. #51-H2g assemble son draft depuis deux artefacts
canoniques protégés, sans accès DB ou réseau. #51-H2h exporte sa source depuis
une photographie PostgreSQL read-only. #51-H2i ferme l'autorité PostgreSQL du
listener paper qui produit l'intention canary normale. Ces livraisons préparent
un preflight externe sans armer ni démarrer un canary.

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
EXECUTOR_PREFLIGHT_GENERATION_ID=execution_wallet_generation_...
EXECUTOR_PREFLIGHT_TARGET_INTENT_ID=execution_intent_...
EXECUTOR_PREFLIGHT_SIMULATION_ARTIFACT_ID=execution_simulation_artifact_...
EXECUTOR_PREFLIGHT_SOURCE_PATH=/chemin/hors-git/execution-preflight-source.json
```

Rejouer auparavant `scripts/provision-executor-roles.sql` en administrateur,
puis exécuter immédiatement avant H2g :

```bash
npm run build:backend
DOTENV_CONFIG_PATH=/chemin/hors-git/preflight-source.env \
  npm run executor:preflight-source:start
```

La commande ne sélectionne jamais « le dernier » objet : les trois identités
sont obligatoires. Elle lit génération, snapshots, intention BUY `PENDING`
non louée et simulation `SUCCESS` dans une photographie unique, reconstruit
leurs fingerprints et publie exclusivement un nouveau fichier `0600`. Elle
refuse tout nom de variable RPC, wallet, keypair, mode live ou armement. Son
succès signifie seulement `PREFLIGHT_SOURCE_EXPORTED` et
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

## Frontières des six environnements PostgreSQL

Créer six fichiers hors Git, lisibles seulement par leur compte de service :

- listener H2i : login `NOINHERIT` membre uniquement de
  `sol_token_listener_writer`, connexion avec
  `options=-c role=sol_token_listener_writer`,
  `POSTGRES_AUTO_MIGRATE=false` et aucun keypair ;

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

Après la migration 039, l'administrateur rejoue
`scripts/provision-executor-roles.sql`. Chaque login doit être `NOINHERIT`, ne
recevoir qu'un seul rôle de groupe avec `ADMIN FALSE, INHERIT FALSE, SET TRUE`,
et ne posséder aucun objet. Les processus forcent `SET ROLE`,
`search_path=pg_catalog,public` et `session_replication_role=origin` à chaque
checkout. Le rôle opérations ne peut ni lire les bytes signés ou non signés,
ni armer des champs runtime arbitraires, ni modifier les intents ; H2a,
listener et API ne gagnent aucune autorité H2c.

Le listener H2i utilise le paramètre de connexion PostgreSQL pour fixer son
rôle sur chaque connexion du pool. Il peut écrire ses projections métier et
insérer une intention, mais ne peut ni modifier une intention existante, ni
lire ou écrire génération wallet, risque live, contrôle, armement, lock,
transaction signée, soumission ou réconciliation. Arrêter le listener, ou
remettre `EXECUTION_INTENT_EMISSION_ENABLED=false`, avant le preflight H2c.

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
même avec une valeur vide. Après migrations 001–039, rejouer deux fois le
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
   `EXECUTION_INTENT_EMISSION_ENABLED=true`. Cette émission temporaire utilise
   le producteur normal ; ne jamais fabriquer une cible par SQL.
3. Sélectionner une seule intention BUY `PENDING`, WSOL, non louée, dont la
   décision et la révision sont connues. Noter son `intentId`, son mint et son
   montant entier. Arrêter le listener ou remettre l'émission à `false`, puis
   vérifier qu'aucune nouvelle intention n'apparaît.
4. Produire la simulation Mainnet non signée exacte avec #51-D, puis exécuter
   H2h avec les identités explicites de la génération, de la cible canary et de
   cet artefact. Auditer le manifeste redacted et conserver la source `0600`.
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
   fingerprints et un nonce. La réservation d'exposition et l'armement V2 sont
   atomiques ; tout écart laisse zéro capacité live.
10. Seulement après inspection humaine de l'armement, démarrer H2a avec son
   environnement dédié, puis H2b avec le sien. Le démarrage H2b valide rôle,
   migration 039, génération, genesis, les huit limites runtime exactes et
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
troisième compte recevant seulement `sol_token_executor_operations`.

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
interdits. Listener,
worker dry-run, opérations, lecteur opérateur et API publique n'ont aucun accès
aux bytes signés. Seul le rôle de rétention reçoit les `DELETE` nécessaires à
la purge. Il n'obtient qu'une lecture par colonnes
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
`paper_mvp_runs`, `listener_websocket_health`, `chain_transaction_inbox` et
`api_event_stream_state`.

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
