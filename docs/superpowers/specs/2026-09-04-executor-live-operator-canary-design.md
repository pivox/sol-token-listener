# Armement opérateur exact et préparation du canary — conception #51-H2c

**Version de spécification :** 1.1.0

**Version de la spécification parente :** 1.11.0

**Date :** 2026-09-04

**Statut :** LIVRÉE — `READY_FOR_EXTERNAL_PREFLIGHT`, canary non démarré

**Issue parente :** #51

**Dépendance :** #51-H2b fusionnée par la PR #78 (`bcc983b`)

## Historique des versions

- **1.1.0 — 2026-09-05 :** livre les contrats H2c, la migration 039,
  l'armement V2 exact, le lock durable avant signature, sa récupération
  périodique fail-closed et les frontières de rôles. Cette livraison autorise
  uniquement la préparation manuelle d'un préflight externe ; elle ne vaut ni
  exécution, ni validation économique, ni verdict `PASS`.

- **1.0.1 — 2026-09-04 :** ferme la faisabilité de l'admission BUY avec un
  sidecar canonique signé, lie la requête aux limites financières du runtime,
  réserve l'exposition dans la même transaction que l'armement, précise la
  révision cible, la reprise périodique des locks abandonnés et le passage
  système borné à `ENTRY_STOP`.
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
- sidecar CANARY V1 signé contenant politique, snapshots wallet/provider et
  cible exacte, sans accès RPC ni keypair depuis le processus opérations ;
- cible BUY exacte : intention, révision, décision, mint, quote mint et montant
  quote brut ;
- fingerprint couvrant toutes les valeurs réellement autorisées ;
- confirmation TTY affichant le wallet complet, la cible, les limites,
  l'expiration et le fingerprint de requête ;
- persistance PostgreSQL compatible avec l'historique V1 terminal ;
- refus de toute armement V1 encore actif lors de l'upgrade ;
- claim BUY limité à la cible de l'unique armement CANARY V2 actif ;
- admission BUY et réservation d'exposition créées atomiquement avec
  l'armement, jamais supposées préexistantes ;
- CAS durable `ARMED -> LOCKED` avant l'appel au signer ;
- liaison du verrou à l'intention, la tentative, la réservation et le lease ;
- révocation transactionnelle fail-closed d'un verrou abandonné sans artefact ;
- validation H2b avant ouverture du keypair : reprise pré-signature périodique,
  puis travail signable ou sortie à protéger obligatoire ;
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

H2c ne crée pas de collecteur de quota provider ou de wallet Mainnet. Le
gateway H2b ne possède pas ces preuves : une simulation `confirmed` ne remplace
pas un snapshot wallet `finalized`, et un RPC Solana ne révèle pas le quota du
fournisseur. Ces preuves proviennent donc du producteur de preflight externe et
restent authentifiées par la même clé Ed25519 de confiance.

## 4. Requête d'armement CANARY V2

La commande devient explicitement ciblée :

```bash
npm run live:arm -- \
  --intent-id=execution_intent_<sha256> \
  --maximum-lamports=<u64 explicite> \
  --holding-ms=<30000..900000> \
  --reason='<raison opérateur>'
```

La commande lit aussi `EXECUTOR_CANARY_EVIDENCE_PATH`, chemin absolu hors Git
vers une enveloppe Ed25519 canonique CANARY V1. Son payload contient exactement
la qualification, l'identifiant cible, la politique de risque canonique, un
snapshot wallet `finalized`, un snapshot provider `OPERATOR_REPORT` ou
`AUTHORITATIVE_PROBE`, `allEndpointsUnavailable=false`, sa date de capture et
son expiration. Les fingerprints et identifiants des snapshots doivent être
ceux des gates `WALLET_CHAIN_LIMITS_VERIFIED` et
`PROVIDER_EXIT_CAPACITY_VERIFIED` de la qualification signée. Le sidecar est
borné à 131 072 octets, rejette toute clé inconnue et utilise la même clé
publique de confiance que le preflight.

Le snapshot wallet acquiert un constructeur canonique de domaine qui recalcule
son ID et son fingerprint sur tous ses champs, comme le snapshot provider. Le
décodage du sidecar et le repository utilisent ce même constructeur. Un ID ou
fingerprint simplement bien formé n'est jamais accepté. Les deux gates de la
qualification doivent égaler exactement l'ID et le fingerprint recalculés.

Le repository relit l'intention sous le verrou de présence SELL puis le verrou
advisory de génération. Elle doit être un BUY non expiré, encore `PENDING`, non
loué, utiliser le quote mint WSOL autorisé et avoir un `quote_amount_raw`
strictement positif et inférieur ou égal au plafond manuel. Son identité de
stratégie et sa décision immuable sont capturées par la requête. La politique,
les deux snapshots, l'admission `ADMITTED`, la réservation d'exposition et
l'armement sont persistés dans une transaction unique. Une admission rejetée
annule toute la transaction ; aucun armement ni exposition orpheline n'est
laissé. Une intention déjà louée, terminale, signée ou divergente est refusée.

La révision cible persistée est la révision `PENDING` observée lors de
l'armement. Le claim n'incrémente pas cette révision ; la transition unique
`PENDING -> PROCESSING` l'incrémente exactement de un. Le lock pré-signature
exige donc cette révision cible plus un, la même décision et la tentative 1.
Un retry ou une deuxième tentative exige un nouvel intent et un nouvel
armement ; le canary n'autorise pas une réinterprétation implicite de la cible.

`armamentRequestFingerprint` est le SHA-256 canonique et length-prefixed de :

```text
contract version, qualification id/fingerprint, phase,
build/configuration/strategy fingerprints,
generation id, wallet public key complet, cluster, genesis, provider,
canary evidence id/fingerprint/captured at/expires at,
target intent id/state revision/strategy id+version/decision fingerprint,
target mint/quote mint/quote amount raw,
maximum buys/capital lamports/exposure bps/open positions/holding ms,
policy/wallet snapshot/provider snapshot fingerprints,
quote max age/slippage/snapshot max slot lag/compute unit limit,
fee limit/fee-payer debit limit/RPC call limit/lease duration,
armed at, expires at, operator id, operator reason
```

Pour V2, l'autorisation opérateur utilise `payload_version=2`, le domaine de
hash `execution-operator-authorization-v2` et
`execution_operator_authorizations.context_fingerprint` est exactement ce
fingerprint. Les autorisations V1 terminales restent lisibles ; aucune V1 ne
peut armer un armement V2. L'autorisation reste mono-usage et expire après 60 secondes.
L'armement et sa cible ne sont insérés qu'après relecture transactionnelle de
l'autorisation, de la qualification, du contrôle `RUNNING`, du risque connu et
de l'intention exacte.

La phrase TTY contient sans troncature : action, version, phase, wallet, intent
id, mint, quote mint, montant brut en lamports, plafond en lamports, durée,
expiration, fingerprint et nonce. L'écran précédant la saisie expose aussi les
fingerprints policy/snapshots et toutes les limites runtime liées. Les
identifiants d'admission et de réservation sont des résultats transactionnels :
ils sont liés à l'armement et affichés après commit, mais ne sont pas faussement
présentés comme connus avant la confirmation. Une variation d'un seul champ
d'entrée produit une phrase et une autorisation différentes. Il n'existe ni
flag `--yes`, ni stdin pipe accepté, ni valeur permissive implicite.

Le libellé `EXECUTOR_OPERATOR_ID` reste un identifiant d'audit public, pas une
preuve d'identité humaine. La séparation entre le signataire Ed25519 du
preflight et le compte PostgreSQL/terminal opérateur est un gate de déploiement
documenté, non un dual-control techniquement imposé. H2c ne prétend pas
résoudre la compromission simultanée des deux.

## 5. Compatibilité PostgreSQL

La migration `039_execution_canary_operator_binding.sql` ajoute à
`execution_activation_armaments` :

```text
armament_request_fingerprint
canary_evidence_fingerprint
target_intent_id
target_intent_state_revision
target_strategy_id
target_strategy_version
target_decision_fingerprint
target_mint
target_quote_mint
target_quote_amount_raw
target_admission_report_id
target_reservation_id
target_policy_fingerprint
target_wallet_snapshot_fingerprint
target_provider_snapshot_fingerprint
runtime_quote_max_age_ms
runtime_slippage_bps
runtime_snapshot_max_slot_lag
runtime_max_compute_units
runtime_max_fee_lamports
runtime_max_fee_payer_lamport_debit
runtime_max_rpc_calls_per_attempt
runtime_lease_ms
locked_intent_id
locked_attempt_number
locked_reservation_id
locked_lease_token
locked_at
```

La migration crée aussi `execution_pre_signature_locks`. Chaque ligne V1 lie
de façon déterministe intention, tentative, révision, armement, réservation,
génération, wallet, provider, message hash, bytes du message non signé, hash et
bytes de la transaction non signée, build/snapshot/quote fingerprints,
blockhash et dernière hauteur valide. Sa machine d'état fermée est
`AUTHORIZED -> SIGNED_PERSISTED | REVOKED`, avec unicité par
`(intent_id, attempt_number)` et par armement. Les bytes ne sont lisibles que
par le rôle H2b live ; opérations, H2a, listener, API et rétention n'y accèdent
pas.

Les lignes historiques V1 terminales restent lisibles et purgeables grâce au
discriminateur `payload_version=1`. La migration échoue volontairement si une
ligne V1 est encore `ARMED` ou `LOCKED` : l'opérateur doit d'abord appliquer
`ENTRY_STOP`/`HARD_STOP`, puis réconcilier tout artefact signé ou ambigu et
obtenir un état terminal prouvé. Après migration, toute nouvelle insertion doit
être `payload_version=2`, utiliser les domaines de hash `*-v2` et renseigner l'ensemble
des bindings non nuls et canoniques. Les triggers rendent ces identités
immuables ; seules les transitions d'état, le compteur et les colonnes de lock
peuvent évoluer selon la matrice fermée.

Le catalogue de migrations, les rôles opérations/live/rétention et leurs listes
de colonnes sont mis à jour. Aucun rôle listener, API ou H2a ne reçoit les bytes
signés ou une nouvelle capacité de mutation. La rétention conserve quatre
heures les lignes terminales et ne supprime jamais un verrou actif ou ambigu.
Son rôle peut supprimer une ligne de lock terminale sans `SELECT` sur les
colonnes BYTEA, après la cohorte artefact associée ; il ne peut ni lire les
bytes ni supprimer un lock `AUTHORIZED`.

Pour garantir l'atomicité sans dupliquer la politique, H2c extrait du repository
risque les primitives transactionnelles d'append wallet/provider et
`admitBuyInTransaction`, qui reçoivent le client PostgreSQL déjà verrouillé.
Les méthodes publiques continuent à ouvrir leur propre transaction puis
délèguent. Le repository opérations V2 utilise un adaptateur transaction-bound
et appelle réellement `ExecutionAdmissionService` avant l'insertion de
l'armement ; toute exception rollback snapshots, rapport, réservation,
compteur provider, exposition et armement ensemble. L'ordre global des verrous
reste présence SELL, génération, puis provider.

## 6. Verrou avant signature

Le callback `BEFORE_SIGNING` ne fait plus une lecture simple. Pour un BUY il
appelle une opération transactionnelle unique qui :

1. prend le verrou de présence SELL puis le verrou génération ;
2. revalide claim, tentative, intention cible, qualification, contrôle,
   armement V2, risque, réservation, quota, provider et expiration ;
3. persiste les bytes non signés exacts et leurs identités dans un lock
   `AUTHORIZED` ;
4. effectue le CAS `ARMED -> LOCKED`, incrémente `consumed_buys` et lie
   intention, tentative, réservation, lock et lease ;
5. journalise `ARMAMENT_LOCKED` ;
6. retourne une capability opaque portant uniquement les bytes persistés et
   l'identité du lock nécessaire au signer.

L'appel au signer n'arrive qu'après commit de cette transaction. Une seconde
instance ou une autre intention ne peut donc pas signer sous le même armement.
Le signer signe les bytes retournés par la capability, jamais une copie mémoire
non autorisée. `persistSigned` exige ensuite armement `LOCKED`, lock
`AUTHORIZED`, mêmes bytes/message/fingerprints et liaison exacte ; il passe le
lock à `SIGNED_PERSISTED`, mais ne déplace plus l'armement et n'incrémente plus
son compteur.

Deux fingerprints de snapshot restent distincts : la réservation compare son
snapshot wallet risque au `target_wallet_snapshot_fingerprint` de l'armement ;
l'artefact compare son snapshot de marché causal à la simulation non signée.
Ils ne sont jamais comparés entre eux.

Le lock exige que l'intention, l'armement, les snapshots, l'admission, la
réservation et la qualification restent frais pendant au moins
`runtime_lease_ms` après l'heure PostgreSQL du lock. Il ne suffit pas qu'ils
soient simplement non expirés.

L'armement impose déjà une marge d'au moins deux fois `runtime_lease_ms` sur la
qualification, l'intention, le snapshot provider et le sidecar. Pour le wallet,
qui n'a pas d'`expiresAt`, la condition exacte est
`observedAtMs + walletSnapshotMaxAgeMs >= databaseNowMs + 2 * runtimeLeaseMs` à
l'armement, puis `>= databaseNowMs + runtimeLeaseMs` au lock. Le premier lease
couvre démarrage/claim/préparation ; le second laisse au lock une fenêtre
complète. Un opérateur qui attend et consomme cette marge obtient un refus
fail-closed et doit produire une nouvelle qualification, jamais une extension
implicite.

Pour CANARY, les configs opérations et H2b refusent `runtime_lease_ms` supérieur
à 120 000 ms ; la qualification fixe de cinq minutes conserve ainsi la marge de
deux leases. Les autres phases ne sont pas promues par H2c.

Si le même lease rejoue la demande avant persistance, la même autorité est
retournée. Si un nouveau lease rencontre un lock antérieur sans artefact signé,
aucune résignature n'est autorisée. Le chemin de reprise pré-signer et cette
défense dans le gate utilisent une transaction PostgreSQL unique qui :

- marque l'armement `REVOKED` ;
- abandonne la tentative ;
- termine le BUY avec `PRE_SUBMISSION_REVOKED_NO_SEND` ;
- libère la réservation et l'exposition ;
- passe le lock à `REVOKED` ;
- journalise les transitions et la preuve
  `SYSTEM_PRE_SIGNATURE_LOCK_STRANDED` ;
- laisse le contrôle au moins en `ENTRY_STOP`.

Ces mutations forment une seule transaction. Toute voie qui terminalise un
armement `LOCKED` sans artefact doit aussi abandonner la tentative, terminer le
BUY, libérer réservation et exposition et journaliser le stop ; il n'existe pas
de branche d'expiration ou de révocation partielle. La migration ajoute les
reason codes stables `SYSTEM_PRE_SIGNATURE_LOCK_STRANDED`,
`SYSTEM_SUBMISSION_AMBIGUOUS` et `SYSTEM_RECONCILIATION_UNKNOWN` aux événements
de contrôle et un chemin SQL système strictement borné à
`RUNNING -> ENTRY_STOP` ou au maintien de `ENTRY_STOP`. Les deux derniers sont
aussi appliqués dans les transactions H2b qui rendent une soumission ambiguë ou
une réconciliation inconnue. Le helper ne peut jamais reprendre `RUNNING`,
abaisser `HARD_STOP`, armer, signer ou soumettre.

Les événements de contrôle ajoutent `actor_type=OPERATOR|SYSTEM`, un
`actor_id` obligatoire uniquement pour l'opérateur et des références causales
optionnelles vers intent, tentative, lock et artefact. Leur identité système est
déterministe sur génération, état précédent/suivant, reason code, source et
heure PostgreSQL. Les CHECK et le trigger refusent un acteur système pour
`RESUME`, `ARM`, `HARD_STOP` ou toute transition autre que l'arrêt d'entrée
décrit ci-dessus.

Cette conclusion `NO_SEND` est valide parce que le gateway de soumission ne
peut recevoir que des bytes relus depuis `execution_signed_transactions`, et
qu'aucun artefact n'existe. Dès qu'un artefact existe, les règles H2b normales
prévalent ; après `SUBMISSION_STARTED`, toute incertitude reste `AMBIGUOUS`.

## 7. Claim et démarrage fail-closed

La claim BUY live reçoit la `generationId` du runtime et ne sélectionne que le
`target_intent_id` de l'armement V2 `ARMED` actif, avec admission et réservation
exactes. Elle conserve le verrou de présence SELL et `READ COMMITTED`.
Sans armement exact, aucune intention BUY n'est louée ni altérée.

Avant d'ouvrir le keypair, H2b exécute un pre-pass PostgreSQL sans signer sur
l'éventuel lock BUY dont le lease est expiré ou absent et qui ne possède aucun
artefact. Le même pre-pass est exécuté avant chaque tour des quatre lanes H2b ;
ce n'est ni une cinquième lane ni une responsabilité H2a. Il applique alors la
révocation `NO_SEND` décrite en section 6. Un lock dont le lease appartient
encore à une autre instance fait échouer le démarrage concurrent avant ouverture
du secret. H2a reste incapable de lire les bytes et ne reçoit aucune capacité
pour effacer un lock pré-signature.

Après cette reprise, le startup H2b exige au moins un des états suivants, lié
exactement au runtime :

- armement CANARY V2 frais et cible BUY encore éligible ;
- position/autorisation de sortie ouverte nécessitant la capacité SELL ;
- artefact persisté à reprendre.

Sinon il échoue avec un code redacted stable et ferme PostgreSQL sans charger le
signer. Ce comportement fait volontairement de H2b un exécuteur à la demande,
pas un daemon idle attendant une future entrée. Le démarrage ne consomme pas
l'armement et ne remplace jamais la confirmation TTY.

## 8. Limites financières et « 10 USDT »

« 10 USDT » est uniquement une enveloppe de risque décidée hors chaîne. H2c ne
convertit jamais ce montant. L'opérateur fournit un plafond entier en lamports
au moment exact de l'armement. Ce plafond couvre le principal du BUY. Les
plafonds `maxFeeLamports` et `maxFeePayerLamportDebit` sont liés séparément à
la requête et revalidés par H2b ; le gate signé
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
listener observe/paper sans keypair + émission temporaire d'intentions
-> sélection et gel de l'intention exacte -> arrêt du listener ou désactivation
   vérifiée de l'émission -> build exact -> sidecar + onze preuves fraîches
-> live:preflight -> live:status -> live:resume (TTY)
-> live:arm exact-target + admission atomique (TTY) -> live:status/report
-> démarrage H2a -> démarrage H2b -> monitoring continu
```

L'émission utilise le producteur neutre existant, uniquement avec
`EXECUTION_MODE=paper` et `EXECUTION_INTENT_EMISSION_ENABLED=true`. Le listener
ne reçoit aucun keypair. Elle doit être remise à `false`, ou le listener arrêté,
avant l'armement. La cible n'est jamais fabriquée par `INSERT`/`UPDATE` manuel.

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
- enveloppe sidecar signée, canonique, bornée, reliée aux deux gates de
  snapshot et refusant toute divergence ;
- phrase TTY complète et refus non-TTY/bypass ;
- cible absente, SELL, expirée, louée, mauvais mint/quote/décision/révision ou
  montant supérieur au plafond refusée avant armement ;
- admission rejetée, snapshot obsolète/supplanté, policy divergente ou
  réservation non atomique : zéro armement et zéro exposition résiduelle ;
- replay exact et concurrence de deux armements ;
- migration vide, replay, upgrade 038 -> 039 et refus d'un V1 actif ;
- claims BUY limitées à la cible, sans altérer les autres intentions ;
- deux workers concurrents : un seul lock et un seul appel au signer ;
- crash avant lock, après lock/avant signature, après signature/avant
  persistance, après persistance et après `SUBMISSION_STARTED` ;
- reprise bootstrap et périodique d'un lock abandonné : révocation, stop et
  libération atomiques, aucun signer ni provider contacté ;
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
