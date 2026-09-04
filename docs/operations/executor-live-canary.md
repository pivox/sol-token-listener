# Executor live — préparation du canary Mainnet (#51-G)

**Version :** 1.4.3 — 2026-09-04

Ce document décrit l'état réellement livré. #51-H2a publie
`executor:live:recovery:start`, un processus de finalité read-only sans keypair,
signature ni soumission. #51-H2b publie séparément
`executor:live:dev` et `executor:live:start`, sans armer ni démarrer un canary.
H2c conserve les gates, l'armement opérateur et la préparation du canary.

La validation paper Mainnet #49 reste `NON_EXECUTED / NON_VALIDATED`. Les
briques #51-G ne prouvent ni rentabilité, ni sellabilité générale, ni avantage
de position. Leur présence ne crée aucun armement, ne change pas `ENTRY_STOP`
et n'autorise aucune dépense. Aucune commande ci-dessous ne les enchaîne
automatiquement.

## État et frontière de sécurité

Le constat livré obligatoire est :
`LIVE_SIGNABLE_RUNTIME_COMPOSED`, `CANARY_NOT_STARTED`,
`NON_EXECUTED / NON_VALIDATED`.

H2b est un processus signable isolé. Sa passe expose exactement quatre lanes,
dans cet ordre : recover SELL, execute SELL, recover BUY, execute BUY. Le
premier résultat `WORKED` arrête la passe. H2a reste le processus séparé de
finalité, confirmation, réconciliation et deadline. H2c reste le seul
propriétaire des gates, de l'armement et du canary.

La configuration livrée reste désarmée : `.env.example` conserve
`EXECUTOR_MODE=dry-run`, `LIVE_TRADING_ENABLED=false` et aucun chemin de
keypair réel. Elle ne permet pas de démarrer H2b. La publication de H2b ne
crée aucune intention, ne lance ni `live:resume` ni `live:arm`, et n'exécute
aucun canary.

Les commandes H2b existantes sont :

```bash
npm run executor:live:dev
npm run executor:live:start
```

Elles ne sont pas une procédure d'armement. Aucun secret réel, armement ou
séquence de canary n'est documenté dans le périmètre H2b.

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
`sol_token_executor_live_recovery`.

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
de l'identifiant, de l'état, de l'échéance et de l'autorisation de sortie sur
`execution_signed_transactions` : `signed_transaction_bytes` lui reste
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
- les autorisations `CONSUMED` ou `REVOKED` sans artefact restant ;
- les positions `CLOSED` sans autorisation restante.

Un artefact `AMBIGUOUS`, une position `OPEN`, `EXIT_PENDING` ou `UNKNOWN`, et
une autorisation `ACTIVE` ou `LOCKED` ne sont jamais candidats. Les tombstones
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

## Gates et canary : hors H2b

H2c devra vérifier les gates et décider explicitement tout armement ou canary.
H2b ne modifie pas l'état de contrôle, n'exécute pas `live:resume` ou
`live:arm` et n'a pas l'autorité de les remplacer. Aucun canary n'est démarré
par cette livraison.

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
