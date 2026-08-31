# Preflight et opérations Executor V1 — conception #51-F

**Version de spécification :** 1.0.5

**Version de la spécification parente :** 1.6.4

**Date :** 2026-08-31

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-E fusionnée par la PR #73

## Historique des versions

- **1.0.5 — 2026-08-31 :** verrou de génération acquis dans les triggers SQL,
  autorisation resume fraîche et mono-usage, et refus des états armement non
  `ARMED` à l'insertion.
- **1.0.4 — 2026-08-31 :** attestation Ed25519 des onze gates, garde SQL
  des transitions de contrôle et armements, et replay concurrent des
  autorisations opérateur.
- **1.0.3 — 2026-08-31 :** sérialisation du replay preflight, liaison du
  build simulé, recontrôle atomique du risque lors de l'armement, rejet des
  replays terminaux et compatibilité effective avec le rôle opérations.
- **1.0.2 — 2026-08-31 :** correction du contrat CLI documenté pour aligner
  `live:arm` sur la phase configurée et ses trois options réellement acceptées.
- **1.0.1 — 2026-08-31 :** liaison vérifiable de la preuve de simulation #51-D,
  immutabilité SQL des identités, expiration/révocation transactionnelle et
  purge bornée des payloads #51-F après quatre heures.
- **1.0.0 — 2026-08-31 :** conception initiale du preflight compensatoire,
  des contrôles opérateur, de l'armement inerte et des rôles PostgreSQL V1.

## 1. Décision

#51-F rend les gates compensatoires observables, durables et opérables sans
introduire la moindre capacité de signature ou de soumission. La PR ajoute des
preuves versionnées, un état de contrôle durable et des commandes locales. Elle
ne compose aucun chemin réel : `EXECUTOR_MODE=live` reste invalide,
`LIVE_TRADING_ENABLED=true` reste invalide et toute variable de keypair reste
refusée.

```text
preuves CI/déploiement + état #51-E + simulation-only #51-D
  -> qualification de sécurité durable, TTL <= 5 minutes
  -> décision opérateur locale distincte
  -> armement CANARY/MICRO_LIVE/PILOT durable mais inerte
  -> status et rapport redacted
  -> #51-G seulement : consommation future sous tous les gates
```

Le saut du paper Mainnet #49 reste `NON_EXECUTED / NON_VALIDATED`. Une
qualification #51-F atteste uniquement que les contrôles demandés ont fourni
les preuves prévues ; elle n'atteste ni profit, ni sellabilité future, ni
absence de risque Mainnet.

## 2. Périmètre

### 2.1 Inclus

- modèle fermé des onze gates compensatoires de la spécification parente ;
- `SafetyQualificationRecord` déterministe, versionné et valable cinq minutes
  au maximum ;
- liaison exacte au build, configuration, stratégie, phase, wallet, cluster,
  genesis hash et provider ;
- états durables `RUNNING | ENTRY_STOP | HARD_STOP` ;
- armements durables `ARMED | LOCKED | CONSUMED | REVOKED | EXPIRED`, mais
  sans aucun consommateur dans le runtime de production ;
- nonce d'autorisation opérateur à usage unique et confirmation TTY ;
- commandes locales `live:preflight`, `live:status`, `live:arm`,
  `live:kill-switch`, `live:resume` et `live:report` ;
- rapport JSON borné et redacted, écrit sur stdout seulement ;
- provisioning PostgreSQL explicite pour listener, executor, opérateur
  read-only et API publique ;
- tests PostgreSQL réels, concurrence, replay, expiration, arrêt et absence de
  capacité live dans les graphes source et compilés.

### 2.2 Exclus

- keypair, secret, signature, bytes signés ou RPC de soumission ;
- mode executor `live` ou variable permettant de l'activer ;
- consommation d'un armement par un worker ;
- autorisation de sortie et mutation live d'une position ;
- routes HTTP publiques d'opération ;
- automatisation GitHub ou dépendance à une API SaaS pour déclarer un gate ;
- création automatique de rôles PostgreSQL par la migration applicative ;
- validation paper Mainnet #49.

## 3. Modèle de preuves

Les gates ont les identifiants stables suivants :

```text
QUALITY_GATES_PASSED
MIGRATIONS_VERIFIED
ARCHITECTURE_BOUNDARIES_VERIFIED
DRY_RUN_RECOVERY_VERIFIED
SIMULATION_MATRIX_VERIFIED
FAULT_MATRIX_VERIFIED
RECONCILIATION_CLEAN
PROVIDER_EXIT_CAPACITY_VERIFIED
STOP_CONTROLS_VERIFIED
WALLET_CHAIN_LIMITS_VERIFIED
MAINNET_PREFLIGHT_SIMULATED
```

Chaque preuve contient : `gateId`, `status=PASSED`, `evidenceType`,
`evidenceId`, `evidenceFingerprint`, `observedAtMs` et `expiresAtMs`. Les onze
preuves sont obligatoires, uniques, dans l'ordre canonique et non expirées au
moment du commit. Aucun score ou booléen global fourni par l'appelant ne peut
remplacer une preuve manquante.

Le fichier complet est une enveloppe Ed25519 signée hors du runtime opérateur
par le pipeline de confiance. La clé privée ne se trouve ni dans le dépôt, ni
dans le processus #51-F. Seule sa clé publique SPKI DER encodée en base64 est
configurée. La signature porte sur les octets JSON exacts de la qualification,
donc sur les onze preuves et toutes les liaisons de déploiement. Un tableau de
gates brut, un payload modifié ou une signature issue d'une autre clé est
refusé avant toute écriture PostgreSQL.

Le fingerprint de qualification couvre :

- version de contrat et version d'évaluateur ;
- les onze preuves complètes ;
- `buildHash`, `configurationFingerprint`, `strategyFingerprint` ;
- phase ;
- génération et clé publique wallet ;
- `mainnet-beta` et genesis hash ;
- provider positionnel ;
- date de qualification et expiration.

Le TTL exact est de cinq minutes. Une qualification plus longue est rejetée.
Une qualification passée n'est jamais modifiée ; une nouvelle exécution crée
un nouveau record. Le preflight n'interroge pas GitHub : les preuves CI ou de
déploiement sont produites par un outil séparé et vérifiées par identité et
fingerprint, ce qui garde le cœur déterministe et testable hors réseau.

## 4. Contrôles durables

`execution_control_state` possède une ligne par génération wallet. Son état
initial est `ENTRY_STOP`, jamais `RUNNING`. Toute transition est sérialisée par
génération et journalisée dans `execution_control_events`.

```text
ENTRY_STOP -> HARD_STOP
RUNNING    -> ENTRY_STOP | HARD_STOP
HARD_STOP  -> ENTRY_STOP uniquement par resume validé
ENTRY_STOP -> RUNNING uniquement par resume validé
```

Un kill switch ne supprime rien et ne libère aucune réservation. `ENTRY_STOP`
bloquera les futurs BUY tout en laissant les sorties et la réconciliation à
#51-G. `HARD_STOP` interdira toute future signature/soumission. #51-F ne fait
qu'enregistrer et exposer ces états.

`live:resume` exige une qualification fraîche, aucun état inconnu de #51-E et
une nouvelle preuve opérateur. Il révoque tout armement antérieur et ramène
l'état à `RUNNING`; il n'arme pas le live. Un restart ne modifie jamais l'état.

Les reason codes opérateur V1 sont fermés :

```text
OPERATOR_ENTRY_STOP
OPERATOR_HARD_STOP
PREFLIGHT_FAILED
PREFLIGHT_EXPIRED
ARMAMENT_REVOKED
ARMAMENT_EXPIRED
RESUME_PREFLIGHT_REQUIRED
OPERATOR_AUTHORIZATION_INVALID
```

## 5. Armement inerte

Un armement référence une qualification fraîche et fixe exactement :

- phase `CANARY | MICRO_LIVE | PILOT` ;
- wallet, génération, cluster et genesis hash ;
- build, configuration et stratégie ;
- provider ;
- nombre maximal de BUY ;
- plafond absolu en lamports ;
- exposition maximale en basis points ;
- positions simultanées maximales ;
- durée de détention maximale ;
- date d'expiration ;
- opérateur et raison bornés ;
- hash d'un nonce d'autorisation à usage unique.

Les bornes V1 sont fermées :

| Phase | BUY max | Positions | Exposition | Détention |
| --- | ---: | ---: | ---: | ---: |
| CANARY | 1 | 1 | 500 bps | 30–900 s |
| MICRO_LIVE | 3 | 1 | 500 bps | 30–900 s |
| PILOT | configurable 1–10 | 2 | 2 000 bps | 30–900 s |

Le plafond lamports est obligatoire, strictement positif et borné en u64. Le
TTL d'armement est au plus quinze minutes et ne dépasse jamais la qualification
référencée ; une nouvelle phase exige une nouvelle qualification et un nouvel
armement. Un seul armement non terminal existe par génération. Sous le verrou
advisory partagé avec #51-E, la création relit immédiatement `unknown_block`
et les réservations `UNKNOWN_HELD`. Toute incertitude apparue depuis le resume
refuse l'armement avant consommation de l'autorisation. Le replay d'un
armement révoqué ou expiré est également refusé.

En #51-F, aucune méthode ne marque un armement `LOCKED` ou `CONSUMED`. Ces états
sont réservés au CAS transactionnel de #51-G. Les commandes peuvent seulement
créer `ARMED`, révoquer ou constater l'expiration.

## 6. Autorisation opérateur

`live:arm` et `live:resume` refusent un stdin non TTY. L'opérateur doit saisir
une phrase contenant l'action, la phase, le wallet tronqué de façon publique et
un nonce aléatoire affiché une seule fois. Seul le SHA-256 du nonce et de son
contexte est persisté ; le nonce brut n'est ni loggé ni stocké.

Le test et l'automatisation utilisent un port terminal injecté, jamais un flag
de contournement en production. Une confirmation expirée, rejouée ou liée à un
autre contexte échoue de manière fixe et redacted.

## 7. Commandes locales

Les commandes partagent un entrypoint séparé du listener et du worker :

```bash
npm run live:preflight
npm run live:status
npm run live:arm -- \
  --maximum-lamports=<u64> \
  --holding-ms=<30000..900000> \
  --reason='<raison opérateur>'
npm run live:kill-switch -- --mode=entry-stop --reason=OPERATOR_ENTRY_STOP
npm run live:kill-switch -- --mode=hard-stop --reason=OPERATOR_HARD_STOP
npm run live:resume
npm run live:report
```

Elles utilisent `DATABASE_URL`, des identités publiques explicites et aucune
variable de secret. Les sorties sont un unique JSON versionné, sans URL RPC,
montant de position, contenu de preuve, erreur brute ou chemin local. Les
mutations retournent un identifiant et un fingerprint publics.

`live:preflight` ne soumet rien. Il valide les preuves préparées, relit l'état
durable #51-E dans une transaction cohérente et persiste uniquement la
qualification. La preuve `MAINNET_PREFLIGHT_SIMULATED` doit référencer un
artefact #51-D `simulation-only` réussi, lié aux mêmes build/config/wallet,
provider et genesis hash.

## 8. PostgreSQL

La migration `035_execution_preflight_operations.sql` ajoute :

- `execution_safety_qualifications` ;
- `execution_safety_gate_evidence` ;
- `execution_control_state` ;
- `execution_control_events` ;
- `execution_operator_authorizations` ;
- `execution_activation_armaments` ;
- `execution_activation_events`.

Les événements et qualifications sont append-only. Les agrégats courants sont
mutés par CAS sous advisory lock de génération. Les fingerprints sont SHA-256,
les nombres financiers sont `NUMERIC` entiers bornés, les dates sont à la
milliseconde et les payloads libres/JSON financiers sont interdits.

Des triggers gardent également la frontière SQL : `RUNNING` exige un événement
resume cohérent, une qualification fraîche, une autorisation consommée et un
risque connu ; un insert `ARMED` exige les mêmes liaisons, un contrôle
`RUNNING` et aucun `UNKNOWN_HELD`. Un `UPDATE` SQL isolé ne peut donc pas
contourner les transitions applicatives. Les deux triggers acquièrent le même
verrou advisory que #51-E avant de lire le risque. Une autorisation resume ne
peut référencer qu'un seul événement et doit rester fraîche au commit. En
#51-F, tout insert initial autre que `ARMED` est refusé.

Une qualification expirée sans armement actif, une autorisation consommée et
un armement terminal deviennent purgeables après quatre heures. Un état de
contrôle, un armement actif ou une preuve requise par un état non terminal ne
sont jamais purgés.

## 9. Rôles PostgreSQL

La migration applicative reste exécutable sans `CREATEROLE`. Un script SQL de
provisioning séparé, lancé par un administrateur, configure des rôles fournis
explicitement : listener writer, executor worker, operator read-only et API
publique. Il ne crée pas de mot de passe et n'accorde aucun `SUPERUSER`,
`CREATEDB`, `CREATEROLE`, `BYPASSRLS` ou droit sur les schémas système.

- listener : aucune table de preuve, armement, contrôle ou artefact executor ;
- executor : claim/mutation des tables executor nécessaires, sans DDL ;
- opérateur read-only : `SELECT` des rapports et états, aucune mutation ;
- API publique : aucun privilège sur les tables executor ;
- commandes mutantes : rôle opérationnel distinct avec seules fonctions SQL
  `SECURITY DEFINER` fermées ou tables explicitement nécessaires.

Le provisioning est testé par inspection SQL et par rôles temporaires lorsque
le compte de test possède les permissions suffisantes. Une impossibilité de
créer les rôles est un skip explicite, jamais un faux PASS.

## 10. Frontières d'architecture

- `src/app.ts`, l'API, paper et le listener n'importent aucun module #51-F ;
- le worker executor n'importe pas les commandes opérateur ;
- le graphe #51-F interdit `Keypair`, signer, secret, bytes signés,
  `sendTransaction`, `sendRawTransaction` et tout RPC autre que les lectures et
  `simulateTransaction` déjà auditées ;
- l'armement n'est lu par aucun worker avant #51-G ;
- les graphes `dist` sont vérifiés comme les sources ;
- aucun test automatisé n'a accès à une méthode de soumission Mainnet.

## 11. Critères d'acceptation

- migration 035 base vide, replay et upgrade depuis 034 ;
- onze gates exacts, fingerprints déterministes et TTL cinq minutes ;
- qualification refusée si une preuve manque, expire ou diverge ;
- kill switch concurrent, durable et idempotent ;
- resume sans qualification fraîche refusé ;
- armement sans TTY, nonce, qualification ou limites exactes refusé ;
- armement inerte absent du graphe runtime ;
- rapports bornés, stables et redacted ;
- provisioning PostgreSQL least-privilege documenté et testé ;
- rétention quatre heures sans purge d'état actif ;
- build, check, lint, docs, tests PostgreSQL et frontend verts ;
- aucun mode live, keypair, signer, soumission ou secret ajouté ;
- #49 reste explicitement `NON_EXECUTED / NON_VALIDATED`.

## 12. Suite

#51-G pourra ajouter le secret et le transport de soumission uniquement dans un
nouvel exécutable fermé. Il devra relire transactionnellement qualification,
contrôle, armement, risque, quota et intention immédiatement avant signature
et envoi. Aucun artefact de #51-F ne constitue à lui seul une autorisation de
dépense.
