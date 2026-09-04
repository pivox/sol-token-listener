# Armement opérateur exact et préparation du canary — conception #51-H2c

**Version de spécification :** 1.0.0

**Version de la spécification parente :** 1.10.0

**Date :** 2026-09-04

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-H2b fusionnée par la PR #78 (`bcc983b`)

## Historique des versions

- **1.0.0 — 2026-09-04 :** lie l'autorisation TTY à la requête d'armement
  complète et à une intention BUY exacte, déplace le verrou durable du canary
  avant la première signature BUY, ferme la reprise d'un verrou abandonné et
  versionne la procédure opérateur sans exécuter de transaction Mainnet.

## 1. Décision

H2c ferme les dernières frontières compensatoires avant qu'un opérateur puisse
envisager un canary Mainnet. Les primitives #51-F/#51-G/H2b sont conservées :
qualification Ed25519 à onze gates, contrôle durable, confirmation TTY,
armement, réservation, artefact signé persisté avant envoi, soumission unique
et réconciliation H2a.

Deux écarts empêchent toutefois d'utiliser ces primitives avec un vrai wallet :

1. l'autorisation `ARM` porte actuellement sur la seule qualification ; elle ne
   lie ni le plafond en lamports, ni la durée, ni la raison, ni la cible ;
2. H2b signe actuellement le BUY avant le CAS `ARMED -> LOCKED`, alors que la
   capacité mono-BUY doit être durablement réservée avant la première signature.

H2c corrige ces écarts avec un armement CANARY V2 exact-target et un verrou de
signature durable. La PR prépare l'opération mais ne l'exécute pas. Son constat
final reste obligatoirement :

```text
LIVE_SIGNABLE_RUNTIME_COMPOSED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```

## 2. Approches évaluées

| Approche | Décision | Motif |
| --- | --- | --- |
| Documentation seule autour de l'armement V1 | Rejetée | Laisse le plafond et la cible hors de la confirmation opérateur et conserve la signature avant verrou durable. |
| Étendre l'autorité PostgreSQL et TTY existante | Retenue | Ferme les écarts sans créer de service réseau, de second moteur d'armement ou de nouvelle autorité de soumission. |
| Service externe d'approbation, HSM ou daemon d'armement | Reportée | Intéressant après le canary, mais ajoute disponibilité, credentials et protocoles hors du risque minimal accepté. |

## 3. Périmètre

### 3.1 Inclus

- requête d'armement CANARY V2 déterministe et immuable ;
- cible BUY exacte : intention, révision, décision, mint, quote mint et montant
  quote brut ;
- fingerprint couvrant toutes les valeurs réellement autorisées ;
- confirmation TTY affichant le wallet complet, la cible, les limites,
  l'expiration et le fingerprint de requête ;
- persistance PostgreSQL compatible avec l'historique V1 terminal ;
- refus de toute armement V1 encore actif lors de l'upgrade ;
- claim BUY limité à la cible de l'unique armement CANARY V2 actif ;
- CAS durable `ARMED -> LOCKED` avant l'appel au signer ;
- liaison du verrou à l'intention, la tentative, la réservation et le lease ;
- révocation transactionnelle fail-closed d'un verrou abandonné sans artefact ;
- validation H2b avant ouverture du keypair : travail signable ou sortie à
  protéger obligatoire ;
- runbook H2c manuel, dossier de preuves et critères PASS/non-PASS ;
- tests unitaires, PostgreSQL, concurrence, crash boundaries, architecture et
  documentation.

### 3.2 Exclus

- exécution de `live:resume`, `live:arm`, H2a ou H2b pendant la PR ou la CI ;
- installation, génération, financement ou lecture d'un vrai keypair ;
- appel à un endpoint Mainnet ou à une méthode de soumission réelle ;
- conversion USDT/EUR/SOL dans le runtime ou dépendance à un oracle fiat ;
- route HTTP d'opération, armement non interactif ou enchaînement automatique ;
- multi-wallet, promotion automatique, MICRO_LIVE, PILOT ou augmentation de
  plafond ;
- modification de l'ordre des lanes H2b ou des responsabilités H2a ;
- déclaration de réussite de #49 ou du canary.

## 4. Requête d'armement CANARY V2

La commande devient explicitement ciblée :

```bash
npm run live:arm -- \
  --intent-id=execution_intent_<sha256> \
  --maximum-lamports=<u64 explicite> \
  --holding-ms=<30000..900000> \
  --reason='<raison opérateur>'
```

Le repository relit l'intention sous le verrou advisory de génération. Elle
doit être un BUY non expiré, encore `PENDING` ou `RETRY_READY`, utiliser le quote
mint WSOL autorisé et avoir un `quote_amount_raw` strictement positif et
inférieur ou égal au plafond manuel. Son identité de stratégie et sa décision
immuable sont capturées par la requête ; la réservation et le gate pré-signature
établissent ensuite la liaison effective à la génération qualifiée. Une
intention déjà louée, terminale, signée ou divergente est refusée.

`armamentRequestFingerprint` est le SHA-256 canonique et length-prefixed de :

```text
contract version, qualification id/fingerprint, phase,
build/configuration/strategy fingerprints,
generation id, wallet public key complet, cluster, genesis, provider,
target intent id/state revision/strategy id+version/decision fingerprint,
target mint/quote mint/quote amount raw,
maximum buys/capital lamports/exposure bps/open positions/holding ms,
armed at, expires at, operator id, operator reason
```

Pour V2, `execution_operator_authorizations.context_fingerprint` est exactement
ce fingerprint. L'autorisation reste mono-usage et expire après 60 secondes.
L'armement et sa cible ne sont insérés qu'après relecture transactionnelle de
l'autorisation, de la qualification, du contrôle `RUNNING`, du risque connu et
de l'intention exacte.

La phrase TTY contient sans troncature : action, phase, wallet, intent id, mint,
montant brut en lamports, durée, expiration, fingerprint et nonce. Une variation
d'un seul champ produit une phrase et une autorisation différentes. Il n'existe
ni flag `--yes`, ni stdin pipe accepté, ni valeur permissive implicite.

Le libellé `EXECUTOR_OPERATOR_ID` reste un identifiant d'audit public, pas une
preuve d'identité humaine. La séparation entre le signataire Ed25519 du
preflight et le compte PostgreSQL/terminal opérateur est un gate de déploiement
documenté ; H2c ne prétend pas résoudre la compromission simultanée des deux.

## 5. Compatibilité PostgreSQL

La migration `039_execution_canary_operator_binding.sql` ajoute à
`execution_activation_armaments` :

```text
armament_request_fingerprint
target_intent_id
target_intent_state_revision
target_strategy_id
target_strategy_version
target_decision_fingerprint
target_mint
target_quote_mint
target_quote_amount_raw
locked_intent_id
locked_attempt_number
locked_reservation_id
locked_lease_token
locked_at
```

Les lignes historiques V1 terminales restent lisibles et purgeables. La
migration échoue volontairement si une ligne V1 est encore `ARMED` ou `LOCKED` :
l'opérateur doit d'abord appliquer `ENTRY_STOP`/`HARD_STOP` et obtenir un état
terminal. Après migration, toute nouvelle insertion doit être V2 avec l'ensemble
des bindings non nuls et canoniques. Les triggers rendent ces identités
immuables ; seules les transitions d'état, le compteur et les colonnes de lock
peuvent évoluer selon la matrice fermée.

Le catalogue de migrations, les rôles opérations/live/rétention et leurs listes
de colonnes sont mis à jour. Aucun rôle listener, API ou H2a ne reçoit les bytes
signés ou une nouvelle capacité de mutation. La rétention conserve quatre
heures les lignes terminales et ne supprime jamais un verrou actif ou ambigu.

## 6. Verrou avant signature

Le callback `BEFORE_SIGNING` ne fait plus une lecture simple. Pour un BUY il
appelle une opération transactionnelle unique qui :

1. prend le verrou de présence SELL puis le verrou génération ;
2. revalide claim, tentative, intention cible, qualification, contrôle,
   armement V2, risque, réservation, quota, provider et expiration ;
3. effectue le CAS `ARMED -> LOCKED`, incrémente `consumed_buys` et lie
   intention, tentative, réservation et lease ;
4. journalise `ARMAMENT_LOCKED` ;
5. retourne le binding opaque nécessaire au signer.

L'appel au signer n'arrive qu'après commit de cette transaction. Une seconde
instance ou une autre intention ne peut donc pas signer sous le même armement.
`persistSigned` exige ensuite `LOCKED` et la liaison exacte ; il ne déplace plus
l'armement et n'incrémente plus son compteur.

Si le même lease rejoue la demande avant persistance, la même autorité est
retournée. Si un nouveau lease rencontre un lock antérieur sans artefact signé,
aucune résignature n'est autorisée. Le chemin de reprise pré-signer et cette
défense dans le gate utilisent une transaction PostgreSQL unique qui :

- marque l'armement `REVOKED` ;
- abandonne la tentative ;
- termine le BUY avec `PRE_SUBMISSION_REVOKED_NO_SEND` ;
- libère la réservation et l'exposition ;
- journalise les transitions et la preuve `SIGNING_LOCK_ABANDONED` ;
- laisse le contrôle au moins en `ENTRY_STOP`.

Cette conclusion `NO_SEND` est valide parce que le gateway de soumission ne
peut recevoir que des bytes relus depuis `execution_signed_transactions`, et
qu'aucun artefact n'existe. Dès qu'un artefact existe, les règles H2b normales
prévalent ; après `SUBMISSION_STARTED`, toute incertitude reste `AMBIGUOUS`.

## 7. Claim et démarrage fail-closed

La claim BUY live ne sélectionne que `target_intent_id` de l'armement V2
`ARMED` actif. Elle conserve le verrou de présence SELL et `READ COMMITTED`.
Sans armement exact, aucune intention BUY n'est louée ni altérée.

Avant d'ouvrir le keypair, H2b réconcilie d'abord sans signer l'éventuel lock BUY
dont le lease est expiré et qui ne possède aucun artefact. Il applique alors la
révocation `NO_SEND` décrite en section 6. Un lock dont le lease appartient
encore à une autre instance fait échouer ce démarrage concurrent avant ouverture
du secret.

Après cette reprise, le startup H2b exige au moins un des états suivants, lié
exactement au runtime :

- armement CANARY V2 frais et cible BUY encore éligible ;
- position/autorisation de sortie ouverte nécessitant la capacité SELL ;
- artefact persisté à reprendre.

Sinon il échoue avec un code redacted stable et ferme PostgreSQL sans charger le
signer. Le démarrage ne consomme pas l'armement et ne remplace jamais la
confirmation TTY.

## 8. Limites financières et « 10 USDT »

« 10 USDT » est uniquement une enveloppe de risque décidée hors chaîne. H2c ne
convertit jamais ce montant. L'opérateur fournit un plafond entier en lamports
au moment exact de l'armement. Ce plafond couvre le BUY ; le gate signé
`WALLET_CHAIN_LIMITS_VERIFIED` doit aussi attester hors runtime que le wallet
reste faiblement financé tout en conservant les frais, le débit maximal SELL et
le rent buffer nécessaires à une sortie.

Aucune valeur fiat, aucun float JavaScript et aucun prix d'oracle ne deviennent
une autorité d'exécution. Le quote mint live initial reste exclusivement WSOL.

## 9. Séquence opérateur H2c

Les environnements sont séparés et hors Git :

- opérations : aucun nom de variable keypair, `LIVE_TRADING_ENABLED=false` ;
- H2a : rôle recovery, aucun nom de variable keypair ;
- H2b : rôle live, keypair externe, `EXECUTOR_MODE=live` et activation explicite.

La procédure ne contient aucune commande englobante. Chaque étape impose une
inspection humaine et un point d'arrêt :

```text
build exact -> onze preuves fraîches -> live:preflight -> live:status
-> live:resume (TTY) -> live:arm exact-target (TTY) -> live:status/report
-> démarrage H2a -> démarrage H2b -> monitoring continu
```

`ENTRY_STOP` bloque toute nouvelle entrée mais préserve SELL et réconciliation.
`HARD_STOP` est réservé au cas où continuer à signer/envoyer est plus dangereux
qu'une position potentiellement bloquée. Un kill switch n'annule jamais une
transaction déjà soumise.

## 10. Verdict du canary

Le dossier de preuve H2c est versionné. `PASS` exige simultanément :

- exactement un BUY et un SELL finalisés et réconciliés ;
- zéro double ordre, état inconnu ou résiduel inattendu ;
- position `CLOSED` ;
- autorisation de sortie et armement `CONSUMED` ;
- mêmes build, configuration, stratégie, wallet, provider et genesis ;
- chronologie complète des gates, autorisations, locks, soumissions et
  réconciliations.

Une absence d'opportunité, un BUY refusé, un lock révoqué, une fermeture sans
transaction, une confirmation seule ou une ambiguïté ne vaut pas `PASS`. La PR
H2c elle-même produit seulement `READY_FOR_EXTERNAL_PREFLIGHT`, jamais `PASS`.

## 11. Tests obligatoires

- fingerprint de requête déterministe, exact et sensible à chaque champ ;
- phrase TTY complète et refus non-TTY/bypass ;
- cible absente, SELL, expirée, louée, mauvais mint/quote/décision/révision ou
  montant supérieur au plafond refusée avant armement ;
- replay exact et concurrence de deux armements ;
- migration vide, replay, upgrade 038 -> 039 et refus d'un V1 actif ;
- claims BUY limitées à la cible, sans altérer les autres intentions ;
- deux workers concurrents : un seul lock et un seul appel au signer ;
- crash avant lock, après lock/avant signature, après signature/avant
  persistance, après persistance et après `SUBMISSION_STARTED` ;
- reprise d'un lock abandonné : révocation et libération atomiques, aucun signer
  ni provider contacté ;
- races expiration/révocation/`ENTRY_STOP` au lock, à la persistance et au gate
  final ;
- startup sans travail échoue avant `loadSigner` ;
- architecture source/dist, rôles PostgreSQL, rétention et documentation ;
- build, check, lint, tests backend/frontend, docs et smoke ;
- aucun test ne charge une vraie clé ou ne contacte Mainnet.

## 12. Critères d'acceptation

- l'autorisation opérateur couvre exactement la dépense et la cible ;
- aucun BUY ne peut être signé sans lock durable mono-usage ;
- un crash pré-persist ne permet ni résignature, ni nouvelle tentative ;
- les bytes persistés et les états ambigus conservent les garanties H2b ;
- H2a, listener, API, paper et simulation-only restent inchangés dans leur
  autorité ;
- les exemples restent dry-run, désarmés et sans secret ;
- la procédure H2c est manuelle, bornée et auditée ;
- le canary réel n'est ni lancé ni déclaré validé par cette PR ;
- #49 reste `NON_EXECUTED / NON_VALIDATED`.
