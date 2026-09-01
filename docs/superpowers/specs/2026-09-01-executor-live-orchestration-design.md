# Orchestration persistante de l'exécuteur live — conception #51-H1

**Version de spécification :** 1.0.2

**Version de la spécification parente :** 1.7.15

**Version de la fondation live :** 1.0.15

**Date :** 2026-09-01

**Statut :** APPROUVÉ — recommandation V1 appliquée conformément à la décision
opérateur de poursuivre les choix recommandés sans pause intermédiaire.

## Historique des versions

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

#51-H2 réutilisera ces primitives pour composer les gateways RPC et les lanes.
Un canary Mainnet reste interdit avant la fusion de #51-H2, la validation de
tous les gates compensatoires et un armement manuel distinct.

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
8. Le scan de deadline utilise exclusivement l'heure DB et respecte l'ordre de
   verrous : scan global, génération, puis lignes métier.
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
dépend donc pas seulement de l'ordre des closures du runtime.

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
2. capture une heure PostgreSQL tronquée à la milliseconde ;
3. sélectionne la plus ancienne position `OPEN` dont `exit_deadline_at <= now` ;
4. prend le verrou advisory de sa génération ;
5. relit et verrouille la position ;
6. factorise la mutation existante de `createDeadlineExitIntent` ;
7. crée ou rejoue l'unique intention SELL
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

Ces éléments appartiennent à #51-H2. Le checksum du catalogue de migrations
sera également traité avant publication du binaire ; H1 ne revendique que la
présence et le comportement de la migration 037 dans une base vide et rejouée.

## 11. Critères de livraison

#51-H1 est livrable uniquement si les quatre primitives persistantes sont
testées sur PostgreSQL réel, les contrats antérieurs restent compatibles, la
CI est verte et la documentation affirme encore :

```text
LIVE_RUNTIME_NOT_COMPOSED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```
