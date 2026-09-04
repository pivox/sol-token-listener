# Runtime signable de l'exécuteur live — conception #51-H2b

**Version de spécification :** 1.0.3

**Version de la spécification parente :** 1.10.1

**Version de l'orchestration persistante H1 :** 1.2.0

**Version du runtime de finalité H2a :** 1.1.6

**Version de la fondation live :** 1.1.0

**Date :** 2026-09-04

**Statut :** LIVRÉE — runtime signable désarmé, aucun canary démarré

**Issue parente :** #51

## Historique des versions

- **1.0.3 — 2026-09-04 :** réserve durablement le dernier appel
  `sendTransaction` pendant l'état `SIGNED_SIMULATED`, avant le fence
  `SUBMISSION_STARTED`. Ce prépaiement mono-usage ne peut être consommé que
  par le fetch `sendTransaction`; un crash avant envoi le laisse consommé de
  manière conservatrice et une soumission sans prépaiement ne contacte pas le
  provider.
- **1.0.2 — 2026-09-04 :** rend terminal l'épuisement du budget RPC durable
  avant le verrou de soumission. Le code `RPC_CALL_BUDGET_EXHAUSTED` reste
  typé jusqu'au worker, qui persiste `REVOKED_NO_SEND`; une reprise de cet
  état ne contacte plus le provider. Après `SUBMISSION_STARTED`, toute
  incertitude reste `AMBIGUOUS` et ne peut pas être reclassée en révocation.
- **1.0.1 — 2026-09-04 :** persiste le budget RPC total de chaque tentative
  dans la migration 038 et réserve chaque appel avant son émission. Les lanes
  de reprise partagent ainsi le compteur déjà consommé au lieu de recréer un
  budget en mémoire.
- **1.0.0 — 2026-09-04 :** livre le runtime signable H2b désarmé et ses quatre
  lanes ordonnées.

## 1. Décision et état livré

#51-H2b compose le processus séparé capable de charger la keypair locale,
préparer une transaction signée, persister ses octets exacts, effectuer sa
simulation signée, franchir le dernier verrou PostgreSQL puis soumettre ces
mêmes octets. La livraison du binaire n'arme aucune génération, ne modifie
aucun contrôle et ne déclenche aucune transaction par elle-même.

L'état opérationnel livré est exactement :

```text
LIVE_SIGNABLE_RUNTIME_COMPOSED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```

Cet état ne constitue ni une validation économique, ni une preuve de
rentabilité ou de sellabilité, ni un résultat de canary.

## 2. Frontières H2a, H2b et H2c

H2b exécute exactement quatre lanes, dans cet ordre :

1. recover SELL ;
2. execute SELL ;
3. recover BUY ;
4. execute BUY.

La première lane qui retourne `WORKED` termine la passe. Aucune cinquième lane
n'est admise dans ce graphe.

H2a reste un binaire séparé, sous son login PostgreSQL read-only distinct. Il
reste seul responsable de la finalité, de la confirmation, de la
réconciliation et de la deadline. H2b n'importe ni les lanes ni les façades
applicatives H2a et n'obtient aucune méthode permettant d'exécuter ces tâches.
Le contrat métier H2a reste inchangé ; sa spécification 1.1.6 aligne seulement
le head du catalogue partagé sur la migration 038, sans nouvelle autorité.

H2c reste seul responsable de la validation opérateur, de l'armement manuel et
de la préparation ou du démarrage d'un canary. H2b ne peut appeler ni `arm`, ni
`resume`, ni une mutation du contrôle, et ne crée aucune intention.

## 3. Périmètre H2b

### 3.1 Inclus

- validation fail-closed de PostgreSQL, du rôle effectif, des ACL, des
  migrations, de la génération et des bindings avant ouverture du secret ;
- chargement borné de la keypair locale et vérification de la clé publique ;
- claims `LIVE_RECOVER` et `LIVE_EXECUTE` filtrés atomiquement par SELL ou BUY ;
- quote, route, build, simulation non signée et préparation à partir des
  données déjà admises et réservées par les fondations précédentes ;
- persistance des octets signés avant simulation signée et avant soumission ;
- reprise exacte d'un artefact persisté sans reconstruction, nouvelle
  signature ou double envoi ;
- preuve fraîche de validité du blockhash, transition `SUBMISSION_STARTED` et
  envoi exact avec `maxRetries=0` ;
- persistance du résultat immédiat de soumission `ACCEPTED` ou `AMBIGUOUS` ;
- arrêt borné fermant le signer avant PostgreSQL.

### 3.2 Exclus

- `admitBuy`, création d'intention, réservation initiale et armement ;
- `arm`, `resume`, qualification opérateur ou démarrage du canary ;
- confirmation, réconciliation, finalité et création de sortie à deadline ;
- mutation de `confirmed_at`, `confirmed_slot` ou `reconciled_at` ;
- retry de soumission, changement de provider après signature, nouveau
  blockhash, re-signature ou reconstruction d'une transaction persistée ;
- WebSocket, nouvelle stratégie, nouveau venue ou modification économique.

Les mutations de risque, réservation, position, autorisation de sortie et
armement ne sont possibles que lorsqu'elles appartiennent atomiquement à la
persistance signée, au dernier verrou de soumission, à son résultat immédiat ou
à une révocation pré-soumission. Elles ne constituent pas une API d'admission,
d'armement ou de réconciliation.

## 4. Façades exactes

Le runtime ne reçoit que des façades gelées, à prototype nul :

- intents : `claim`, `transition`, `beginAttempt`, `finishAttempt`, `renew`,
  `release` ;
- venue : `findFinalizedCanonicalPumpSwapPool` ;
- simulation : `complete` ;
- live : `readPreparationBinding`, `persistSigned`, `reserveRpcCall`,
  `inspectSignedTransaction`, `recordSignedSimulation`,
  `revokeBeforeSubmission`, `beginSubmission`, `recordSubmissionOutcome`.

Les méthodes `create`, `admitBuy`, `recordFault`, `readConfirmationWork`,
`recordConfirmation`, `readReconciliationWork`, `reconcile`,
`createNextDeadlineExitIntent`, les commandes canary et les contrôles opérateur
sont absents de ces façades et du graphe d'import H2b.

## 5. Autorité PostgreSQL 16

Le déploiement utilise PostgreSQL 16. Le rôle de groupe
`sol_token_executor_live` est `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
NOINHERIT NOREPLICATION NOBYPASSRLS`, sans rôle parent et sans ownership. Le
login de déploiement, lui-même sans privilège, est membre uniquement de ce rôle
avec `ADMIN FALSE`, `INHERIT FALSE` et `SET TRUE`. Chaque checkout applique
`SET ROLE` et fixe `search_path=pg_catalog,public` avant d'exposer le client.

L'allowlist est rejouable et limitée aux colonnes réellement utilisées par les
façades H2b. Elle refuse toute autorité table-wide et inventorie les
privilèges DATABASE, SCHEMA, TABLE, COLUMN, SEQUENCE, FUNCTION, TYPE, LANGUAGE,
les default ACL, ownerships, grant options et memberships dans tous les
schémas utilisateur. Les fonctions utilisateur `SECURITY DEFINER` exécutables
et tout `PUBLIC CREATE` sont interdits.

Le privilège PostgreSQL intrinsèque `PUBLIC TEMP` au niveau DATABASE n'est pas
une baseline acceptable pour H2b : une relation temporaire homonyme peut
masquer une table `public` référencée sans qualification. Le provisioning
partagé doit donc révoquer `TEMPORARY` sur la base de données de déploiement
pour `PUBLIC`, puis réaccorder seulement les accès nécessaires aux autres
identités explicitement autorisées. Cette révocation est DB-scoped ; elle ne
doit jamais être appliquée globalement à d'autres bases. Le démarrage H2b
refuse toute capacité TEMP effective. Les baselines PUBLIC intrinsèques qui ne
créent aucune autorité exploitable peuvent être tolérées explicitement.

`COPY TO` n'est pas traité comme un privilège séparé : pour les colonnes
SELECTables, il découle intrinsèquement de `SELECT`. La deadline peut partager
certaines colonnes lisibles avec H2b, mais elle reste inaccessible parce que sa
méthode et son graphe d'import appartiennent exclusivement à H2a.

## 6. Exécution fraîche et reprise

Une lane execute renouvelle le claim, démarre une tentative, relit les bindings
de préparation, puis utilise le plan et le snapshot canoniques sans les
reconstruire après signature. L'artefact signé et la preuve de simulation non
signée sont persistés avant toute simulation signée. Une simulation signée
divergente produit une révocation durable `REVOKED_NO_SEND` et aucun envoi.

Une lane recover ne sélectionne que `SIGNED_NOT_SUBMITTED` du côté demandé. Un
artefact `PERSISTED` reprend à la simulation signée ; un artefact
`SIGNED_SIMULATED` reprend au dernier preflight. `SUBMISSION_STARTED` n'est
jamais renvoyé : son issue appartient à la finalité H2a. `ACCEPTED` et
`AMBIGUOUS` sont également laissés à H2a, sans nouvelle soumission.

Le SELL garde la priorité. Un BUY frais ou repris reste bloqué tant qu'un SELL
exécutable ou récupérable existe. Le runtime ne crée pas les SELL de deadline :
H2a les produit durablement, puis H2b peut seulement les exécuter ou les
reprendre.

## 7. Secrets, RPC et arrêt

Le chemin de keypair est absolu et canonique. Le fichier est régulier, non
symlink, appartenant à l'identité effective et en mode exact `0400` ou `0600`.
Le format est un tableau JSON canonique de 64 octets et la clé dérivée doit
égaler `EXECUTOR_PUBLIC_KEY`. Les buffers mutables sont écrasés lors de la
fermeture. Aucun secret, chemin, octet signé, URL, message d'erreur brut ou
signature n'entre dans les logs.

Chaque tentative utilise une session RPC provider-affine et bornée. Le budget
total `EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT`, compris entre 12 et 16, est créé
atomiquement avec l'artefact signé par la migration 038. Il est initialisé avec
les appels de préparation non signée déjà consommés. Avant chaque appel RPC du
tail signable, `reserveRpcCall` incrémente ce compteur sous verrou PostgreSQL.
Le redémarrage d'un processus, une nouvelle passe ou une lane recover ne
réinitialise jamais ce budget.

Après la preuve de blockhash et le dernier renouvellement de claim, H2b réserve
explicitement le slot de l'unique `sendTransaction` tant que l'artefact est
encore `SIGNED_SIMULATED`. Seulement après ce commit durable peut-il persister
`SUBMISSION_STARTED`. Le transport ne peut consommer ce prépaiement mono-usage
que pour l'enveloppe JSON-RPC `sendTransaction`; le genesis, la simulation et
les lectures de blockhash continuent chacun à effectuer leur propre
réservation. Une soumission sans ce prépaiement échoue avant le réseau et reste
`AMBIGUOUS`, puisque le fence durable a déjà été franchi.

La réservation précède le contact provider. Un crash entre ces deux opérations
consomme donc conservativement un appel, sans remboursement ; cette perte
bornée est préférée à un dépassement silencieux. Lorsque la limite est atteinte
avant `SUBMISSION_STARTED`, l'appel provider n'est pas exécuté, le code typé
`RPC_CALL_BUDGET_EXHAUSTED` atteint le worker et l'artefact devient
`REVOKED_NO_SEND`. Toute reprise de ce terminal relit seulement PostgreSQL,
sans nouvel appel provider. Si la limite est rencontrée après le verrou
`SUBMISSION_STARTED`, le résultat demeure `AMBIGUOUS` : l'émission peut avoir
eu lieu et aucune révocation n'est permise. Le plafond local de six appels du
tail reste une défense secondaire et ne remplace pas le compteur durable.
Un crash entre la réservation du slot d'envoi et son utilisation ne rembourse
jamais ce slot : la reprise réserve conservativement un nouveau slot ou devient
`REVOKED_NO_SEND` si le plafond est atteint.

Le genesis hash est vérifié avant le secret et avant toute opération signable.
La soumission utilise exactement les octets persistés, `skipPreflight=true` et
`maxRetries=0`. Une réponse incertaine devient `AMBIGUOUS`, jamais un retry.

`SIGINT` ou `SIGTERM` interdit une nouvelle lane, annule le travail courant et
ferme d'abord le signer, puis PostgreSQL. Une échéance de shutdown bornée évince
les connexions et force une sortie non nulle si une opération reste bloquée.

## 8. Vérification et non-activation

La livraison exige des tests unitaires et d'architecture, des scénarios RPC
locaux et les tests d'ACL sous PostgreSQL 16. Ces tests utilisent uniquement
des keypairs éphémères et des bases isolées. Ils ne contactent aucun endpoint
Mainnet, n'utilisent aucun wallet réel et ne prouvent aucun comportement
économique.

Publier `executor:live:start` ne vaut ni `live:resume`, ni `live:arm`. Tant que
H2c n'a pas apporté les preuves opérateur puis explicitement armé un canary, le
seul constat autorisé reste celui défini en section 1 ; aucun état plus avancé
ne peut être déduit de la seule présence du binaire H2b.
