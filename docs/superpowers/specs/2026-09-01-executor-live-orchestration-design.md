# Orchestration persistante de l'exécuteur live — conception #51-H1

**Version de spécification :** 1.2.0

**Version de la spécification parente :** 1.10.0

**Version de la fondation live :** 1.1.0

**Date :** 2026-09-01

**Statut :** APPROUVÉ — recommandation V1 appliquée conformément à la décision
opérateur de poursuivre les choix recommandés sans pause intermédiaire.

## Historique des versions

- **1.2.0 — 2026-09-04 :** constate la composition H2b avec les quatre seules
  lanes signables, dans l'ordre recover SELL, execute SELL, recover BUY,
  execute BUY. Les primitives de finalité, confirmation, réconciliation et
  deadline demeurent exécutées exclusivement par le binaire H2a séparé ;
  l'armement opérateur et le canary demeurent réservés à H2c.
- **1.1.5 — 2026-09-04 :** référence la clôture `NO_EFFECT` de H2a pour une
  absence finalisée après expiration ; les transactions H1 restent inchangées.
- **1.1.4 — 2026-09-04 :** référence la compatibilité
  `RpcResponseContext.apiVersion` de H2a ; les transactions H1 restent
  inchangées.
- **1.1.3 — 2026-09-04 :** référence la fermeture multi-schémas de l'autorité
  H2a ; les transactions H1 restent inchangées.
- **1.1.2 — 2026-09-04 :** explicite les lectures par colonne requises par les
  triggers `SECURITY INVOKER` des commits H1 ; les transactions et les ports
  restent inchangés, sans lecture des bytes signés ni soumission.
- **1.1.1 — 2026-09-04 :** référence la fermeture des memberships PostgreSQL
  16 et la matrice effective exacte des ACL H2a ; les primitives H1 et leurs
  transactions ne changent pas.
- **1.1.0 — 2026-09-04 :** réserve les primitives H1 de finalité à une façade
  H2a exacte et au rôle PostgreSQL `sol_token_executor_live_recovery`. Les ACL
  minimales autorisent les claims `CONFIRM`/`RECONCILE`, leurs read-models et
  commits, ainsi que le scanner d'échéance, sans accorder la lecture des bytes
  signés ni les mutations de signature, simulation signée ou soumission.
- **1.0.10 — 2026-09-04 :** référence les reports H2a gelés et typés : un
  `DEFERRED` associe la lane à un code RPC retryable allowlisté nullable,
  `NOT_FOUND` n'a pas de code et n'arrête pas l'échéance. Les finalités
  inconnues ou incohérentes échouent fermées ; `CONFIRMED` et `FINALIZED`
  portent un slot `bigint` non négatif et les logs restent sans message, URL ni
  signature. Les primitives et transitions persistantes H1 restent inchangées.
- **1.0.9 — 2026-09-04 :** référence le durcissement du seul gateway read-only
  H2a : contrat `getTransaction` v0 et Token-2022, cardinalités LUT, index u8,
  identité pré/post, transport borné et UTF-8 fatal. Les contrats persistants
  H1, leurs claims et leurs transitions restent inchangés.
- **1.0.8 — 2026-09-04 :** la confirmation libère désormais atomiquement sa
  lease dans `recordConfirmation`; un replay exact accepte une lease nulle ou
  identique et la lane H2a ne relâche rien après ce commit.
- **1.0.7 — 2026-09-04 :** libère atomiquement la lease après chaque preuve
  SELL non terminale, y compris lorsqu'une intention est déjà dans l'état
  `UNKNOWN_REQUIRES_RECONCILIATION`. Plusieurs observations `UNKNOWN` ou
  `MISMATCH` consécutives restent ainsi immédiatement récupérables.
- **1.0.6 — 2026-09-04 :** rétrécit les retours des commits confirmation et
  réconciliation à une référence d'artefact sans bytes. Leurs projections SQL
  ne chargent plus `signed_transaction_bytes`, ce qui rend leur réutilisation
  par H2a conforme à la frontière read-only sans secret transactionnel.
- **1.0.5 — 2026-09-04 :** référence le découpage du successeur : #51-H2a
  compose uniquement réconciliation, confirmation et échéances derrière des
  ports read-only ; #51-H2b conservera `LIVE_RECOVER`, le signer et les lanes
  d'exécution. Les garanties historiques H1 restent inchangées.
- **1.0.4 — 2026-09-04 :** étend le fence de présence SELL aux transitions
  qui rendent une intention bloquante. La persistance signée SELL, la
  réconciliation SELL `NO_EFFECT` et le port générique
  `UNKNOWN_REQUIRES_RECONCILIATION -> RETRY_READY` prennent le verrou avant
  tout verrou génération ou métier ; un claim BUY concurrent observe donc le
  SELL activé après son commit, y compris si son état `PROCESSING` a expiré.
- **1.0.3 — 2026-09-04 :** sérialise toute création d'intention SELL et tout
  claim BUY live par le verrou advisory partagé
  `execution-live-sell-presence:v1`. Le snapshot `NOT EXISTS` du claim BUY ne
  peut ainsi ignorer un SELL concurrent non encore commité, même si le rôle
  PostgreSQL configure par défaut `REPEATABLE READ` : la transaction BUY
  impose explicitement `READ COMMITTED`. Le scanner de deadline respecte
  l'ordre global, présence SELL, horloge DB, génération.
- **1.0.2 — 2026-09-01 :** impose aux read-models le recalcul de l'identité
  causale de l'artefact sans lire ses bytes, le décodage base58 canonique des
  valeurs Solana et une matrice fermée intention/artefact. L'API ciblée de
  deadline refuse une observation postérieure à l'heure PostgreSQL fraîche et
  rejoue avec la borne originale, sans élargissement temporel implicite.
- **1.0.1 — 2026-09-01 :** constate la livraison des seules primitives
  persistantes H1 : claims `LIVE_EXECUTE` SELL/BUY et `LIVE_RECOVER`,
  read-models worker-ready de confirmation et réconciliation, puis scan
  atomique et idempotent des sorties à deadline. RPC, signer, simulation
  signée, soumission, composition du runtime, entrypoint live et canary restent
  explicitement différés à #51-H2 et à une opération manuelle distincte.
- **1.0.0 — 2026-09-01 :** définit les primitives PostgreSQL qui manquent à la
  composition live : claims d'exécution par côté, reprise séparée,
  read-models worker-ready et scan atomique des sorties à deadline.

## 1. But et frontière

#51-H1 rend le ledger #51-G orchestrable depuis des données persistées sans
ajouter de capacité réseau ou cryptographique. La livraison ne publie pas
`executor:live:start` et ne compose ni RPC, ni keypair, ni signature, ni
simulation signée, ni soumission.

Le flux livré s'arrête aux entrées worker-ready :

```text
PostgreSQL
  ├─ claim LIVE_EXECUTE(SELL | BUY)
  ├─ claim LIVE_RECOVER
  ├─ claim CONFIRM + readConfirmationWork
  ├─ claim RECONCILE + readReconciliationWork
  └─ scan deadline -> intention SELL déterministe
```

#51-H2a réutilise les seules primitives sans envoi pour composer un runtime de
finalité read-only. #51-H2b réutilise `LIVE_RECOVER` et les claims
`LIVE_EXECUTE` dans l'exécutable signable séparé, sans importer les lanes H2a.
Sa passe contient exactement recover SELL, execute SELL, recover BUY, execute
BUY. #51-H2c reste propriétaire de la validation opérateur, de l'armement et de
la préparation du canary Mainnet.

La validation paper Mainnet #49 reste `NON_EXECUTED / NON_VALIDATED`.

## 2. Approches étudiées

### 2.1 Composition complète en une PR

Ajouter simultanément les claims, read-models, RPC, pipeline et entrypoint
réduirait le nombre de PR, mais créerait un diff trop large pour vérifier les
courses PostgreSQL séparément du comportement RPC irréversible. Approche
rejetée.

### 2.2 Wrapper externe autour des workers existants

Un wrapper pourrait fabriquer les inputs depuis plusieurs lectures ad hoc.
Il contournerait les fences transactionnels et autoriserait des données
incohérentes entre claim, tentative et artefact. Approche rejetée.

### 2.3 Persistance puis composition — retenue

#51-H1 ferme d'abord les contrats durables et leurs courses. #51-H2 ajoute
ensuite le réseau et l'entrypoint. Cette séparation conserve une preuve locale
complète sans rendre le dépôt démarrable en live prématurément.

## 3. Invariants

1. Chaque claim est atomique, utilise l'heure PostgreSQL, `FOR UPDATE SKIP
   LOCKED`, un token UUID et un lease borné.
2. Une lane SELL ne peut jamais réclamer un BUY et une lane BUY ne peut jamais
   réclamer un SELL.
3. Tant qu'une intention SELL exécutable non terminale existe, aucun nouveau
   BUY live n'est réclamé, même si ce SELL est déjà loué ou attend une reprise.
4. `SIGNED_NOT_SUBMITTED` appartient à `LIVE_RECOVER`, jamais au read-model de
   réconciliation on-chain.
5. Les read-models sont dérivés uniquement du ledger verrouillé. La lane ne
   fournit aucun champ causal.
6. Confirmation et réconciliation ne lisent ni ne retournent les bytes signés.
7. Toute lecture worker-ready revalide owner, token, statut, révision et
   expiration du lease après les verrous avec une heure DB fraîche.
8. Toute création ou activation d'un statut SELL bloquant et tout claim BUY live prennent le
   verrou advisory partagé `execution-live-sell-presence:v1` avant de décider
   de la présence d'un SELL. La persistance signée et une réactivation
   `NO_EFFECT` le prennent avant le verrou génération. Le scan de deadline
   respecte l'ordre : scan global, présence SELL, horloge DB, génération, puis
   lignes métier.
9. Les montants, slots, hauteurs, frais et révisions restent des `bigint`.
10. Un commit inconnu, un crash ou un lease expiré se résout par rejeu exact ;
    jamais par création d'un second ordre.

## 4. Claims live fermés

Le contrat existant reste compatible avec dry-run et simulation-only. Il est
étendu par des options discriminées :

```ts
export type ExecutionClaimOptions =
  | Readonly<{
      ownerId: string;
      leaseMs: number;
      purpose: 'LIVE_EXECUTE';
      side: 'BUY' | 'SELL';
    }>
  | Readonly<{
      ownerId: string;
      leaseMs: number;
      purpose: 'LIVE_RECOVER' | 'CONFIRM' | 'RECONCILE' | 'EXECUTE' | 'DRY_RUN';
    }>;
```

`EXECUTE` conserve son comportement historique pour le processus
simulation-only. Le runtime live doit utiliser exclusivement `LIVE_EXECUTE`.

### 4.1 Sélection SELL

`LIVE_EXECUTE + SELL` sélectionne uniquement une intention SELL dans
`PENDING | RETRY_READY | PROCESSING`, par `(requested_at, id)`.

### 4.2 Sélection BUY

`LIVE_EXECUTE + BUY` sélectionne uniquement un BUY dans les mêmes statuts et
ajoute un `NOT EXISTS` sur toute intention SELL live exécutable. La priorité ne
dépend donc pas seulement de l'ordre des closures du runtime. Avant ce
snapshot, la transaction prend
`hashtextextended('execution-live-sell-presence:v1', 51008)`. Toute création
SELL prend le même verrou avant son insertion ; un SELL concurrent ne peut
donc rester invisible dans un snapshot antérieur à son commit. La transaction
du claim BUY commence explicitement avec `BEGIN ISOLATION LEVEL READ
COMMITTED` afin que la requête suivant l'attente forme un snapshot frais,
indépendamment de la configuration par défaut de la session PostgreSQL.

Le même fence précède toute transition d'un SELL depuis
`UNKNOWN_REQUIRES_RECONCILIATION` vers `RETRY_READY`, qu'elle passe par la
réconciliation live atomique ou le port de transition générique. Le verrou est
pris avant le verrou génération puis avant les row locks ; aucune voie de
réactivation ne peut ainsi commiter derrière le snapshot d'un claim BUY
concurrent qui attend déjà le fence.

La persistance d'un artefact signé SELL prend également ce fence avant le
verrou génération. Cette règle est nécessaire lorsqu'un `PROCESSING` expire
pendant son lease : il cesse alors de bloquer les BUY, tandis que sa transition
vers `SIGNED_NOT_SUBMITTED` redevient bloquante sans condition d'expiration.

### 4.3 Reprise

`LIVE_RECOVER` sélectionne uniquement `SIGNED_NOT_SUBMITTED`. La reprise relit
l'artefact et la preuve de simulation non signée déjà persistés via
`inspectSignedTransaction`; elle ne crée ni tentative, ni bytes, ni signature.

`RECONCILE` ne sélectionne plus `SIGNED_NOT_SUBMITTED`. Il reste limité aux
statuts ayant une soumission ou une preuve on-chain à résoudre :
`CONFIRMED | RECONCILING | UNKNOWN_REQUIRES_RECONCILIATION`.

### 4.4 Index

La migration 037 ajoute un index partiel rejouable sur
`(side, requested_at, id)` pour les statuts live exécutables. Elle ne modifie
aucune table financière et ne supprime aucune donnée.

## 5. Read-model de confirmation

```ts
export interface ExecutionLiveConfirmationWorkV1 {
  readonly payloadVersion: 1;
  readonly artifactId: string;
  readonly expectedRevision: bigint;
  readonly signature: string;
  readonly providerId: string;
}
```

`readConfirmationWork(claim)` verrouille et croise intention, tentative et
artefact. Il exige : claim `SUBMITTED` actif, tentative `STARTED`, artefact
`ACCEPTED`, même tentative, même provider et même signature. Une absence ou
divergence est une erreur fermée ; `null` n'est pas autorisé après un claim.

Le résultat contient exactement les champs attendus par
`confirmLiveSubmission`, plus `providerId` pour imposer l'affinité RPC.

## 6. Read-model de réconciliation

```ts
export interface ExecutionLiveReconciliationWorkV1 {
  readonly payloadVersion: 1;
  readonly providerId: string;
  readonly request: ExecutionReconciliationRequestV1;
}
```

`readReconciliationWork(claim)` construit la requête complète sous verrou :

- identité, limites de frais et fingerprints depuis la tentative ;
- wallet, génération, côté et artefact depuis le ledger live ;
- mint et quote mint depuis l'intention ;
- signature et blockhash depuis tentative et artefact, avec égalité obligatoire.

Le read-model refuse `SIGNED_NOT_SUBMITTED`, toute divergence de provider,
tentative, génération, wallet ou identité causale, et toute valeur PostgreSQL
hors des bornes du domaine. Il ne retourne aucun byte signé.

## 7. Scan atomique des deadlines

Le port live ajoute :

```ts
createNextDeadlineExitIntent(): Promise<ExecutionDeadlineExitResultV1 | null>;
```

La transaction :

1. prend le verrou advisory global
   `hashtextextended('execution-live-deadline-scan:v1', 51007)` ;
2. prend le verrou de présence SELL
   `hashtextextended('execution-live-sell-presence:v1', 51008)` ;
3. capture une heure PostgreSQL tronquée à la milliseconde ;
4. sélectionne la plus ancienne position `OPEN` dont `exit_deadline_at <= now` ;
5. prend le verrou advisory de sa génération ;
6. relit et verrouille la position ;
7. factorise la mutation existante de `createDeadlineExitIntent` ;
8. crée ou rejoue l'unique intention SELL
   `maximum-holding:<positionId>` et passe la position à `EXIT_PENDING`.

Si aucune position n'est due, la méthode retourne `null`. Deux scanners, un
scanner et un appel ciblé, ou une reprise après commit inconnu ne peuvent créer
qu'une intention et une transition.

## 8. Erreurs et observabilité

Les nouvelles erreurs restent dans les vocabulaires fermés des repositories :

- input invalide avant connexion ;
- données persistées incohérentes ;
- lease perdu ;
- conflit de rejeu ;
- échec DB ou outcome de commit inconnu.

Aucune erreur n'expose SQL, URL, signature, mint, montant ou contenu signé. H1
n'ajoute pas encore de logger de runtime ; H2 branchera des événements
structurés redacted autour des lanes.

## 9. Tests obligatoires

### 9.1 Claims

- BUY plus ancien et SELL plus récent : SELL ne réclame que SELL ;
- BUY reste indisponible tant qu'un SELL exécutable existe ;
- BUY et SELL concurrents restent uniques ;
- abort, expiration et reclaim conservent les fences ;
- les usages `EXECUTE`, `CONFIRM`, `RECONCILE` et `DRY_RUN` existants ne
  régressent pas.

### 9.2 Read-models

- confirmation `ACCEPTED` produit exactement l'input worker ;
- réconciliation BUY et SELL conserve les `bigint` au-delà de `Number.MAX_SAFE_INTEGER` ;
- owner, token, expiration, tentative, provider, signature, artefact ou
  génération divergents échouent sans mutation ;
- aucune projection ou requête de confirmation/réconciliation ne contient les
  bytes signés.

### 9.3 Deadlines

- aucune position due retourne `null` ;
- la frontière exacte est due ;
- ordre oldest-first déterministe ;
- deux scanners concurrents et la course scanner/appel ciblé créent une seule
  intention ;
- un commit indéterminé est rejouable ;
- l'heure applicative ne peut pas avancer artificiellement la deadline.

### 9.4 Acceptation

- migration 037 sur base vide et rejeu propre ;
- PostgreSQL réel pour claims, locks, leases et courses ;
- `npm run build`, `npm run check`, `npm run lint`, `npm test`,
  `npm run docs:check` et `git diff --check` ;
- graphes source et `dist` toujours sans nouvel entrypoint, RPC, signer ou
  soumission dans H1.

## 10. Hors périmètre

- gateway RPC live et appel d'un endpoint Solana ;
- extraction/refactor du pipeline quote/route/build/simulation ;
- composition des cinq lanes ;
- logger/health du processus live ;
- validation startup rôle/génération/bindings/genesis ;
- publication de `executor:live:start` ;
- armement, financement du wallet ou canary Mainnet.

Ces éléments signables appartiennent à #51-H2b. Le catalogue checksum et la
validation read-only du démarrage appartiennent à #51-H2a ; H1 ne revendique que la
présence et le comportement de la migration 037 dans une base vide et rejouée.

## 11. Critères de livraison

#51-H1 est livrable uniquement si les quatre primitives persistantes sont
testées sur PostgreSQL réel, les contrats antérieurs restent compatibles, la
  CI est verte et la documentation affirme désormais :

```text
LIVE_SIGNABLE_RUNTIME_COMPOSED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```
