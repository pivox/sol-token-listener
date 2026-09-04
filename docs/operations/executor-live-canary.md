# Executor live — préparation du canary Mainnet (#51-G)

**Version :** 1.2.1 — 2026-09-04

Ce document décrit l'état réellement livré et la procédure qui deviendra
applicable après composition du runtime signable. #51-H2a publie uniquement
`executor:live:recovery:start`, un processus de finalité read-only sans keypair,
signature ni soumission. Le script signable `executor:live:start` reste absent.
Il est interdit de contourner ce verrou avec un script ad hoc.

La validation paper Mainnet #49 reste `NON_EXECUTED / NON_VALIDATED`. Les
briques #51-G ne prouvent ni rentabilité, ni sellabilité générale, ni avantage
de position. Leur présence ne crée aucun armement, ne change pas `ENTRY_STOP`
et n'autorise aucune dépense. Aucune commande ci-dessous ne les enchaîne
automatiquement.

## État et frontière de sécurité

La migration 036, le ledger live, la signature locale, la soumission exacte,
la confirmation, la réconciliation et la sortie à deadline disposent de
contrats testables séparés. Il manque encore une composition production qui
valide configuration et schéma avant de charger le secret, injecte tous les
ports réels, respecte l'ordre réconciliation → confirmation → SELL → deadline
→ BUY, puis ferme les ressources dans un délai borné.

Tant que le graphe signable H2b n'est pas livré et revu, les commandes opérateur restent
inertes et aucun canary réel ne doit être tenté.

## Démarrer uniquement la récupération de finalité H2a

Utiliser un environnement dédié qui ne contient aucun nom de variable de
keypair, clé privée ou secret wallet, même vide. Les valeurs suivantes sont
publiques mais doivent être vérifiées par l'opérateur :

```dotenv
EXECUTOR_LIVE_RECOVERY_ENABLED=true
EXECUTOR_MODE=live
SOLANA_CLUSTER=mainnet-beta
DATABASE_URL=postgresql://sol_token_executor_live:...@127.0.0.1:5432/solanabot
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

Le runtime H2a traite, dans l'ordre, une réconciliation finalized, une
confirmation ou une échéance par passe. Il ne réclame jamais `LIVE_RECOVER`,
`LIVE_EXECUTE/SELL` ou `LIVE_EXECUTE/BUY`; il ne peut donc ni reprendre des
bytes signés, ni créer une signature, ni envoyer une transaction. Son
démarrage ne vaut ni armement ni autorisation de canary.

La migration 037 et les repositories #51-H1 ajoutent uniquement les claims
`LIVE_EXECUTE` SELL/BUY et `LIVE_RECOVER`, les read-models durables de
confirmation et réconciliation, ainsi que le scan atomique des sorties à
deadline. Ils ne composent aucun RPC, signer, appel de soumission, runtime de
production ou entrypoint. Ces capacités restent réservées à #51-H2 ; tout
canary restera en plus soumis à un armement manuel distinct.

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

Cette livraison ne compose volontairement aucun appel RPC réel pour produire
cette preuve. La PR de composition suivante devra appeler immédiatement avant
le verrou les méthodes Solana officielles `isBlockhashValid` et
`getBlockHeight`, propager le `contextSlot`, relire le genesis hash et injecter
les timestamps causaux de la quote. Une valeur inventée, mise en cache ou
réutilisée au-delà de cinq secondes doit être refusée; le binaire live reste
indémarrable jusque-là.

## PostgreSQL et rétention

Après les migrations, un administrateur peut appliquer
`scripts/provision-executor-roles.sql`. Il crée des rôles de groupe `NOLOGIN`,
sans mot de passe ni privilège cluster. Le compte LOGIN du futur processus live
doit recevoir seulement `sol_token_executor_live`.

La rétention utilise un second compte LOGIN dédié qui doit recevoir seulement
`sol_token_retention_worker`. Il ne doit jamais être partagé avec le listener,
l'API, les opérations ou l'exécuteur live. Sa `DATABASE_URL` est injectée
uniquement dans le job planifié, puis celui-ci lance
`npm run db:purge:compiled` ou `npm run retention:start:compiled`. Le script de
provisioning doit être rejoué par l'administrateur après toute migration qui
ajoute une table à la purge ; le job reste arrêté si ce provisioning échoue.

Le rôle `sol_token_executor_live` est le seul rôle applicatif autorisé à lire
les octets signés et les détails de positions live. Listener, worker dry-run,
opérations, lecteur opérateur et API publique n'y ont aucun accès. Seul le rôle
de rétention reçoit les `DELETE` nécessaires à la purge. Il n'obtient qu'une
lecture par colonnes
de l'identifiant, de l'état, de l'échéance et de l'autorisation de sortie sur
`execution_signed_transactions` : `signed_transaction_bytes` lui reste
inaccessible, y compris via `RETURNING`.

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

## Préparation publique, sans secret

Le fichier `.env.example` liste les limites publiques. Un futur déploiement
devra épingler notamment le build, la configuration, la stratégie, le wallet,
le provider, le genesis hash, le quote mint WSOL et le plafond brut en
lamports. Le keypair dédié restera hors du dépôt dans un fichier régulier non
symlink, propriétaire du processus et mode exact `0400` ou `0600`.

Ne jamais écrire le contenu du keypair dans `.env`, PostgreSQL, un log, une
preuve ou un ticket. Ne pas financer le wallet avant que le runtime composé et
ses gates complets aient passé la revue.

## Séquence opérateur réservée au futur runtime

Après livraison et revue du graphe manquant, l'ordre manuel obligatoire sera :

```bash
npm run live:preflight
npm run live:status
npm run live:report
npm run live:resume
npm run live:status
npm run live:arm -- \
  --maximum-lamports=500000 \
  --holding-ms=300000 \
  --reason='Mainnet canary manually approved.'
npm run live:status
```

`resume` et `arm` nécessitent chacun un vrai TTY et une confirmation distincte.
Le montant montré est un exemple technique, pas une recommandation. Le plafond
doit être validé humainement en lamports. Avant l'armement, chacune des onze
gates #51-F doit être fraîche et `PASSED`, sans `UNKNOWN`, `AMBIGUOUS` ou
`UNKNOWN_HELD`.

Le démarrage du futur binaire ne devra ni exécuter `resume`, ni armer, ni
modifier l'état de contrôle. Après démarrage manuel séparé, la surveillance
reposera sur :

```bash
npm run live:status
npm run live:report
```

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
ni réarmement. Le futur arrêt normal appliquera d'abord `entry-stop`, enverra
`SIGTERM`, attendra l'arrêt borné, puis relira `live:status` et `live:report`.

Après redémarrage, l'état durable décide du seul chemin autorisé. En
particulier, `SUBMISSION_STARTED` devient `AMBIGUOUS` sans nouvel appel RPC,
puis la signature persistée est confirmée et réconciliée. Les états
`ACCEPTED`, `AMBIGUOUS` et `REVOKED_NO_SEND` sont rejoués sans nouvelle
signature ni nouvelle soumission.

Le worker de reprise découvre l'artefact à partir du claim durable
intent/tentative et recharge depuis PostgreSQL les bytes exacts ainsi que la
preuve non signée canonique. Il ne dépend pas d'un candidat opaque resté en
mémoire avant le crash. La future composition devra reconstruire les comptes
de simulation depuis le plan canonique inspecté, sans reconstruire la
transaction et sans résigner.

## Critère de constat futur

Un canary ne pourra être déclaré `PASS` qu'avec un BUY et un SELL finalisés et
réconciliés, zéro double ordre, zéro résiduel inattendu, position `CLOSED`,
autorisation et armement consommés, et aucun état inconnu. Une absence
d'opportunité, un BUY refusé ou une fermeture sans transaction ne vaut pas
`PASS`.

Pour l'instant, le constat obligatoire est :
`LIVE_RECOVERY_RUNTIME_COMPOSED`, `LIVE_EXECUTION_RUNTIME_NOT_COMPOSED`,
`CANARY_NOT_STARTED`, `NON_EXECUTED / NON_VALIDATED`.
