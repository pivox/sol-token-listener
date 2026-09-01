# Exécuteur Solana V1 — conception

**Version de spécification :** 1.7.12

**Date :** 2026-08-31

**Statut :** APPROUVÉE

**Issue parente :** #51

**Périmètre livré à cette version :** #51-A à #51-F et conception détaillée
#51-G (graphe live fermé, signature, soumission et canary manuel)

## Historique des versions

- **1.7.12 — 2026-09-01 :** complète le rejeu des sorties à deadline par une
  comparaison contextuelle avec la position verrouillée et par une politique
  temporelle fermée : demande comprise entre deadline et observation, puis TTL
  exact de 120 secondes.
- **1.7.11 — 2026-09-01 :** ferme le rejeu des sorties à deadline sur
  l'intention immuable stockée : toutes les propriétés sont relues et validées,
  notamment les dates de demande et d'expiration, au lieu de provenir d'un
  nouveau brouillon.
- **1.7.10 — 2026-09-01 :** aligne le contrat borné de rétention avec ses 66
  compteurs effectifs après ajout des preuves live de simulation. La capacité
  reste explicitement limitée à 128 entrées et le smoke vérifie la liste
  canonique complète.
- **1.7.9 — 2026-09-01 :** isole la purge complète dans un rôle PostgreSQL de
  rétention `NOLOGIN`, privé des bytes signés et des mutations d'état métier,
  avec sérialisation transactionnelle par verrou advisory. La reprise live
  découvre également l'artefact par intent/tentative et réhydrate la preuve
  non signée durable au lieu de dépendre d'un objet conservé en mémoire.
- **1.7.8 — 2026-09-01 :** complète les garanties #51-G avec les preuves
  append-only des simulations non signée et signée, les baselines immuables du
  dernier gate risque/provider et une reprise par état durable qui interdit
  tout nouvel envoi après un crash post-fence.
- **1.7.7 — 2026-09-01 :** ferme le premier cycle de revue #51-G avec un
  dernier préflight atomique et immuable, la révocation durable avant envoi,
  la réconciliation BUY/SELL rejouable, un graphe SQL fermé, des privilèges
  minimaux et une rétention terminale par cohorte. Le runtime RPC production
  demeure un incrément séparé obligatoire avant tout canary.
- **1.7.6 — 2026-08-31 :** acte que #51-G livre un runtime injectable et les
  capacités isolées, sans publier de binaire production avant la composition
  des ports de claim/read-model, du gateway RPC et du pipeline live complet.
- **1.7.5 — 2026-08-31 :** ferme les protections opérationnelles livrables de
  #51-G (rôle live executor-only, rétention terminale et inventaire smoke),
  tout en maintenant le binaire production explicitement non composé.
- **1.7.4 — 2026-08-31 :** active uniquement la capacité de projection
  neutre #51-G, désactivée par défaut et limitée au paper WSOL. Le commit de la
  décision et la création idempotente de l'intention sont atomiques ; aucun
  import de signature, secret ou transport live n'entre dans le listener.
- **1.7.3 — 2026-08-31 :** ferme la reprise post-soumission #51-G :
  confirmation provider avec slot durable, réconciliation finalisée BUY/SELL
  atomique et idempotente, position et autorisation de sortie explicites, puis
  intention SELL unique à la deadline de détention.
- **1.7.2 — 2026-08-31 :** ferme la soumission #51-G autour des seuls octets
  signés persistés et authentifiés, avec simulation signée préalable, fence
  PostgreSQL avant RPC, zéro retry provider et réconciliation obligatoire de
  toute issue réseau ou de commit indéterminée.
- **1.7.1 — 2026-08-31 :** ferme la frontière entre simulation-only et live :
  une tentative live reste `STARTED` et son commit signé journalise
  atomiquement `PROCESSING -> SIMULATED -> SIGNED_NOT_SUBMITTED`, sans réutiliser
  l'artefact terminal non signable de #51-D.
- **1.7.0 — 2026-08-31 :** spécifie #51-G : exécutable live séparé,
  émission neutre optionnelle, secret local fermé, persistance avant envoi,
  soumission exacte, confirmation/réconciliation et canary manuel minimal.
- **1.6.4 — 2026-08-31 :** ferme la projection wallet #51-E à deux positions
  relationnelles explicites et confirme que l'état quota est recalculé lors de
  l'admission plutôt que persisté dans la mesure provider.
- **1.6.3 — 2026-08-31 :** interdit `NUMERIC(p,0)` pour les entiers financiers
  #51-E et exige un `NUMERIC` non scalé avec contrôles d'intégralité et bornes,
  afin d'empêcher l'arrondi silencieux des entrées décimales par PostgreSQL.
- **1.6.2 — 2026-08-31 :** aligne le décompte du schéma #51-E sur sa liste
  normative de onze tables durables ; le périmètre et les invariants restent
  inchangés.
- **1.6.1 — 2026-08-31 :** rend les périodes provider ordonnables et
  vérifiables en ajoutant leurs bornes UTC milliseconde à chaque snapshot
  d'usage #51-E ; un identifiant opaque seul ne peut pas prouver qu'une période
  n'a pas régressé.
- **1.6.0 — 2026-08-31 :** spécifie #51-E comme une fondation inerte : policy
  de sizing en entiers, admission BUY transactionnelle, réservations
  d'exposition, quota provider pessimiste, observations wallet finalisées,
  preuves de réconciliation et matrice de fautes. Aucun composant #51-E n'est
  composé dans le runtime et aucune capacité de signature ou d'envoi n'est
  ajoutée.
- **1.5.0 — 2026-08-31 :** spécifie #51-D : mode `simulation-only`, provider
  épinglé, snapshot causal, quote fraîche, plan officiel inspecté, message v0
  éphémère sans ALT ni signature, simulation avec blockhash explicite et preuve
  durable non signable. Les intentions propres à cette phase sont
  terminalisées et ne pourront jamais être réutilisées pour signer. Trois
  reason codes techniques sont ajoutés de façon append-only. Signature et
  soumission restent réservées à #51-G.
- **1.4.0 — 2026-08-30 :** spécifie #51-C : processus executor séparé et
  évaluation dry-run annexe déterministe. Le claim reste temporaire, le commit
  atomique persiste l'évaluation et libère le lease sans transition, tentative
  ou consommation de l'intention. Quote, build, simulation RPC, signature et
  soumission restent réservés à #51-D et suivantes.
- **1.3.1 — 2026-08-30 :** applique la preuve
  `RECONCILIATION_PROVED_NO_EFFECT` à toute transition qui lève l'état inconnu :
  vers `FAILED` comme vers `RETRY_READY`. Une autorisation de retry seule ne
  constitue pas une preuve et ne peut pas rendre un BUY de nouveau exécutable.
  La ligne parent `RETRY_READY` conserve obligatoirement la preuve afin qu'une
  corruption ou insertion directe ne contourne pas le journal de transitions.
- **1.3.0 — 2026-08-30 :** ajoute la preuve stable
  `RECONCILIATION_PROVED_NO_EFFECT` et l'exige pour terminaliser en `FAILED`
  une intention auparavant inconnue. Un timeout, une soumission ambiguë ou une
  réconciliation encore requise ne peuvent plus lever le blocage global ni
  rendre l'intention purgeable.
- **1.2.0 — 2026-08-30 :** ajoute un tombstone anti-rejeu durable et minimal
  pour l'identité et la clé logique d'une intention purgée. Le plafond TTL de
  quatre heures reste une défense en profondeur mais n'est plus présenté comme
  une preuve suffisante lorsqu'un producteur réémet une décision avec des
  timestamps frais.
- **1.1.1 — 2026-08-30 :** borne l'échéance immutable d'une intention à
  quatre heures et rend les reason codes positifs obligatoires par état et par
  tentative, afin de réduire la fenêtre de rejeu et de fermer le journal
  contradictoire identifiés par la revue finale.
- **1.1.0 — 2026-08-30 :** ajoute sans changer l'identité V1 une révision
  d'état monotone contre les reprises ABA, fixe la décision et son fingerprint
  sur l'événement canonique `PaperStrategySessionUpdated` avec un TTL borné,
  et épingle la cohorte PostgreSQL supprimée par une passe de rétention.
- **1.0.0 — 2026-08-30 :** conception initiale approuvée et découpage
  #51-A à #51-G.

## 1. Décision

La capacité d'exécution réelle sera développée comme un processus séparé du
listener Pump.fun/PumpSwap. Le listener conserve ses seuls modes
`observe` et `paper`, ne charge aucune clé privée, ne signe rien et ne soumet
aucune transaction.

Le chemin cible est :

```text
listener observe/paper
  -> décisions de stratégie et preuves durables
  -> intentions d'exécution PostgreSQL idempotentes
  -> processus executor séparé
  -> construction et simulation Solana
  -> signature et soumission, uniquement après activation explicite future
  -> confirmation et réconciliation on-chain
```

L'étape paper Mainnet de #49 est explicitement sautée. Elle n'est ni déclarée
`PASS`, ni remplacée par une prétendue preuve de rentabilité. Cette décision
augmente l'incertitude opérationnelle sur les conditions Mainnet réelles. Elle
est compensée par des gates techniques fail-closed, un dry-run, une simulation
sans envoi, une réconciliation obligatoire et une activation réelle distincte,
manuelle et progressive.

La présente spécification n'autorise aucune exécution réelle. Les PR #51-B à
#51-F doivent rester incapables de signer ou d'envoyer une transaction. La PR
#51-G pourra introduire cette capacité dans le seul exécutable séparé, mais elle
devra rester désactivée par défaut et inutilisable sans armement explicite.

## 2. Objectif et non-objectifs

### 2.1 Objectif

Permettre à une décision issue du flux Pump.fun de devenir un ordre logique
durable, simulable, exécutable une seule fois et réconciliable après crash,
timeout ou redémarrage. La V1 couvre :

- BUY sur la bonding curve Pump.fun ;
- SELL sur la bonding curve Pump.fun ;
- SELL sur le pool PumpSwap canonique si la position a migré ;
- un seul wallet dédié ;
- SOL/WSOL comme quote asset autorisé initialement ;
- des montants, réserves, frais et basis points exclusivement entiers.

Le domaine conserve toutefois `quoteMint`, `quoteTokenProgram` et
`quoteDecimals` comme valeurs explicites. Il ne généralise pas implicitement
SOL à tous les marchés et ne bloque pas une extension multi-quote ultérieure.

### 2.2 Non-objectifs

La V1 ne cherche pas à :

- prouver une rentabilité ou un avantage statistique ;
- garantir la sellabilité, le profit, la première position ou le même slot ;
- analyser l'historique antérieur du créateur ou des wallets ;
- exécuter Raydium CPMM ;
- supporter plusieurs wallets ou plusieurs signers ;
- utiliser une clé stockée dans `.env`, PostgreSQL, les logs ou Git ;
- fournir des contrôles live dans l'API publique du futur front-end ;
- livrer d'abord l'architecture générique réseau des issues #18 à #23 ;
- convertir automatiquement SOL en USD/USDC sans oracle versionné et fiable.

La mention « 10 USDT équivalent en SOL » est une limite opérationnelle de
financement manuel. L'exécuteur reçoit un plafond canonique en lamports ; il ne
calcule pas lui-même un équivalent fiat. L'objectif expérimental « 100 USDC »
de l'issue #51 est reporté, car il nécessiterait un oracle et une politique de
valorisation absents de ce MVP.

## 3. Approches évaluées

| Approche | Décision | Motif |
| --- | --- | --- |
| Ajouter le wallet et l'envoi au listener | Rejetée | Mélange observation et effet irréversible, agrandit le graphe d'import et rend une mauvaise configuration dangereuse. |
| PostgreSQL durable et exécuteur séparé | Retenue | Réutilise les décisions et la reprise existantes, isole le secret et permet une progression dry-run → simulation → live. |
| Livrer d'abord l'outbox/gateway générique #18–#23 | Reportée | Architecture utile pour le hardening, mais trop large pour le chemin MVP ; les contrats V1 doivent permettre son adoption ultérieure. |

## 4. Frontières de sécurité

### 4.1 Listener

Le bootstrap `src/app.ts` et tout son graphe transitif doivent rester :

- limités à `EXECUTION_MODE=observe|paper` ;
- sans import de `Keypair`, signer, keypair loader, `sendTransaction`,
  `sendRawTransaction` ou transport de soumission ;
- sans variable de clé privée ;
- fonctionnels sans wallet ;
- capables au plus de persister une intention neutre, derrière une
  configuration désactivée par défaut.

Une intention exprime une décision auditable. Elle ne contient ni transaction
signée, ni secret, ni autorisation durable de dépenser. Le test d'architecture
actuel doit être étendu à chaque nouveau bootstrap et aux artefacts compilés.

Les rôles PostgreSQL sont séparés : le listener peut insérer les intentions
prévues par son contrat sans lire les artefacts d'exécution ; l'exécuteur peut
claim et muter ses lignes ; la consultation opérateur reste en lecture seule.
Le rôle public de l'API n'accède à aucune table d'exécution sensible.

### 4.2 Executor

L'exécuteur possède son propre point d'entrée, sa configuration, son cycle de
vie, ses logs et sa connexion PostgreSQL. Il n'est jamais importé par le
listener. Son mode par défaut est :

```dotenv
EXECUTOR_MODE=dry-run
LIVE_TRADING_ENABLED=false
```

Avant #51-G, la valeur `live` doit être rejetée. Après #51-G, un nouveau BUY
nécessite simultanément :

1. `EXECUTOR_MODE=live` ;
2. `LIVE_TRADING_ENABLED=true` ;
3. un armement durable, borné dans le temps et correspondant à la phase ;
4. un preflight immédiatement antérieur réussi ;
5. un wallet et une chaîne correspondant exactement à l'armement ;
6. aucune condition d'arrêt active.

L'absence ou l'incohérence d'un seul contrôle interdit tout nouveau BUY. À
l'ouverture, l'exécuteur crée une autorisation de sortie durable, liée à cette
position, ce wallet, ce cluster et sa quantité maximale réconciliée. Cette
autorisation n'ouvre aucune nouvelle exposition et reste valide jusqu'à la
fermeture de la position.

Un SELL autorisé exige `EXECUTOR_MODE=live`, `LIVE_TRADING_ENABLED=true`, la
correspondance wallet/cluster, l'autorisation de sortie de la position et
l'absence de `HARD_STOP`. Il ne dépend ni d'un armement d'entrée encore valide,
ni de `ENTRY_STOP`, ni d'un preflight encore dans son TTL. Il reconstruit et
revalide néanmoins la transaction exacte selon les règles courantes. Les SELL
et la réconciliation restent ainsi disponibles en mode `EXIT_ONLY`, sauf
impossibilité cryptographique ou réseau explicite.

L'armement durable fixe exactement : phase, wallet, cluster `mainnet-beta`,
hash du build, fingerprint de stratégie/configuration, provider, nombre maximal
de BUY, plafond absolu en lamports, exposition, date d'expiration, identité et
raison opérateur. L'exécuteur applique ces bornes ; elles ne sont pas de simples
champs de rapport.

### 4.3 Secrets

La future clé doit être fournie par un fichier secret hors dépôt, par exemple :

```dotenv
EXECUTOR_PUBLIC_KEY=
EXECUTOR_KEYPAIR_PATH=/run/secrets/solana-executor-keypair.json
```

Règles normatives :

- aucun secret ou seed dans `.env`, PostgreSQL, les logs, les rapports ou Git ;
- chemin absolu, fichier régulier, sans lien symbolique ;
- propriétaire attendu et permissions maximales `0600` ;
- correspondance exacte entre clé publique configurée et keypair ;
- lecture uniquement par le processus executor ;
- erreurs structurées fixes, sans chemin, contenu ou credential ;
- effacement des buffers temporaires lorsque la bibliothèque le permet.

## 5. Contrat de l'intention durable

### 5.1 Identité

Une intention représente un ordre logique, pas une tentative réseau. Son ID est
déterministe à partir d'un schéma versionné :

```text
sha256(
  "execution-intent-v1" |
  strategyId | strategyVersion |
  positionId | side | logicalCommandId
)
```

`logicalCommandId` réutilise l'identité canonique de la commande d'ouverture
ou de fermeture paper. Une contrainte unique protège cette clé logique. Une
nouvelle tentative ne crée jamais une seconde intention.

### 5.2 Champs minimum

`execution_intents` conserve au minimum :

```text
id
payload_version
logical_order_key
strategy_id
strategy_version
position_id
mint
side                         BUY | SELL
venue_policy                 PUMP_FUN_ONLY | CANONICAL_EXIT
quote_mint
quote_token_program
quote_decimals
quote_amount_raw
base_amount_raw
minimum_amount_out_raw
decision_event_id
decision_fingerprint
requested_at
expires_at
status
attempt_count
state_revision
lease_owner
lease_expires_at
last_reason_code
created_at
updated_at
purge_after
```

Après purge de ce payload métier, `execution_intent_tombstones` conserve
uniquement `intent_id`, `payload_version`, `logical_order_key`,
`decision_fingerprint` et `retired_at`. Il ne conserve ni mint, ni wallet, ni
montant, ni quote, ni payload de décision. `intent_id` et
`decision_fingerprint` sont déjà des empreintes ; `logical_order_key` est la
clé minimale nécessaire pour préserver la contrainte d'ordre logique entre
des identités éventuellement différentes.

Une intention BUY exige `quote_amount_raw`; une intention SELL exige
`base_amount_raw`. Les deux quantités ne sont jamais des nombres JavaScript.
`minimum_amount_out_raw` vient d'une quote causale et bornée, puis doit être
rafraîchi par l'exécuteur avant simulation. La valeur finale utilisée est la
plus protectrice des limites encore valides prévues par la stratégie et par la
quote fraîche.

La venue effective appartient à chaque tentative, pas à l'identité immutable
de l'ordre. Un BUY V1 utilise `PUMP_FUN_ONLY`. Un SELL utilise
`CANONICAL_EXIT` : l'exécuteur choisit Pump.fun tant que la courbe canonique est
active, ou PumpSwap uniquement après preuve canonique de migration. Ce
reroutage ne crée jamais un second ordre logique.

Chaque nouvelle tentative ajoute une ligne dans `execution_attempts` et ne
remplace jamais une tentative antérieure. Sa seule mutation autorisée est un
CAS unique de `STARTED` vers son résultat terminal ; toutes les transitions
restent append-only. Les tentatives conservent
l'identité de l'intention, le numéro de tentative, le blockhash, la dernière
hauteur valide, le hash du message, la signature publique lorsqu'elle existe,
les résultats bornés de simulation/confirmation/réconciliation et leurs reason
codes. Les bytes exacts d'une transaction signée sont conservés dans un
artefact executor-only afin de pouvoir renvoyer exactement la même transaction
après un résultat réseau ambigu. Cet artefact est une capacité de soumission :
il est inaccessible au listener et à l'API, jamais journalisé, protégé par le
rôle PostgreSQL executor et purgé après expiration irréversible du blockhash et
réconciliation. Aucun byte de clé privée n'est stocké.

### 5.3 États

Les états canoniques V1 sont :

```text
PENDING
PROCESSING
SIMULATED
RETRY_READY
SIGNED_NOT_SUBMITTED
SUBMITTED
CONFIRMED
RECONCILING
SUCCEEDED
FAILED
EXPIRED
CANCELLED
UNKNOWN_REQUIRES_RECONCILIATION
```

Transitions principales :

```text
PENDING -> PROCESSING | EXPIRED | CANCELLED
RETRY_READY -> PROCESSING | EXPIRED | CANCELLED
PROCESSING -> SIMULATED | FAILED | EXPIRED | CANCELLED
SIMULATED -> SUCCEEDED | FAILED | EXPIRED | CANCELLED    dry-run/pré-signature
SIMULATED -> SIGNED_NOT_SUBMITTED              live seulement
SIGNED_NOT_SUBMITTED -> SUBMITTED
SIGNED_NOT_SUBMITTED -> UNKNOWN_REQUIRES_RECONCILIATION
SUBMITTED -> CONFIRMED -> RECONCILING -> SUCCEEDED
SUBMITTED -> UNKNOWN_REQUIRES_RECONCILIATION
UNKNOWN_REQUIRES_RECONCILIATION -> CONFIRMED|FAILED|RETRY_READY
CONFIRMED|RECONCILING -> UNKNOWN_REQUIRES_RECONCILIATION|SUCCEEDED
```

`SUCCEEDED`, `FAILED`, `EXPIRED` et `CANCELLED` sont terminaux. Une intention
inconnue n'est pas terminale et bloque tout nouveau BUY globalement. Aucun
retry de soumission n'est autorisé tant que l'ancienne signature peut encore
atterrir ou que son résultat n'est pas prouvé. `RETRY_READY` nécessite cette
preuve durable. Un BUY ambigu ne l'atteint jamais automatiquement ; un SELL
peut l'atteindre selon la politique de sortie après extinction finalisée de la
tentative précédente.

Chaque transition est persistée avec : ancien/nouvel état, date PostgreSQL,
reason code stable, message humain borné, phase d'activation, tentative et
preuves structurées versionnées.

Les transitions nominales utilisent obligatoirement le reason code du nouvel
état : `PROCESSING/EXECUTION_STARTED`, `SIMULATED/SIMULATION_SUCCEEDED`,
`SIGNED_NOT_SUBMITTED/SIGNATURE_PERSISTED`,
`SUBMITTED/SUBMISSION_ACCEPTED`, `CONFIRMED/CONFIRMATION_OBSERVED`,
`RECONCILING/RECONCILIATION_STARTED`, `SUCCEEDED/INTENT_SUCCEEDED` et
`CANCELLED/INTENT_CANCELLED`. `EXPIRED` exige `INTENT_EXPIRED` et
`UNKNOWN_REQUIRES_RECONCILIATION` exige `RECONCILIATION_REQUIRED`. Un état
`FAILED` exige un code d'échec et refuse tout code positif. Une tentative
`COMPLETED` exige `ATTEMPT_COMPLETED`; une tentative `ABANDONED` exige un code
d'échec et refuse `ATTEMPT_COMPLETED` ainsi que les autres codes positifs.
Ces couples sont validés avant toute connexion PostgreSQL, au décodage et par
les contraintes des tables durables concernées.

Les transitions `UNKNOWN_REQUIRES_RECONCILIATION -> FAILED|RETRY_READY` sont
plus strictes : elles exigent exactement `RECONCILIATION_PROVED_NO_EFFECT`,
preuve durable que la transaction auparavant ambiguë ne peut plus produire
aucun effet on-chain. Dans ce cas contextuel, l'intention durable
`RETRY_READY` conserve obligatoirement ce code de preuve comme dernier reason
code. Le code append-only `RETRY_AUTHORIZED` reste réservé à une évolution du
graphe mais n'autorise aucun état ni transition de la V1 actuelle.
`SUBMISSION_AMBIGUOUS`, `CONFIRMATION_TIMEOUT` et
`RECONCILIATION_REQUIRED` maintiennent l'intention dans un état non terminal ;
ils ne fixent jamais `reconciliation_completed_at` et ne planifient jamais sa
purge. Le code de preuve ne peut pas être réutilisé pour une autre transition.

### 5.4 Leases et crash/reprise

Le claim utilise `FOR UPDATE SKIP LOCKED`, l'heure PostgreSQL et un lease
renouvelable. Le lease est orthogonal à l'état métier : tous ses champs sont
présents ou absents ensemble, aucun état terminal ne peut en porter, et un
worker conserve le même lease lorsqu'il traverse plusieurs états non terminaux.
Le claim ne modifie jamais l'état métier. Un worker qui réclame une intention
`PENDING` ou `RETRY_READY` appelle ensuite la transition atomiquement
journalisée vers `PROCESSING` ; un crash entre ces deux opérations laisse donc
un état exact et re-claimable, sans transition manquante.
Le propriétaire, la génération et l'expiration sont contrôlés par CAS pour
empêcher un worker périmé de muter l'intention. Les claims de travail normal,
de confirmation et de réconciliation ont des sélections explicites. Toute
ligne pré-signature `PENDING`, `RETRY_READY`, `PROCESSING` ou `SIMULATED`
expirée, sans lease frais, est sweepée atomiquement vers `EXPIRED` avec sa
transition et la preuve qu'aucune signature n'a pu exister.

Un claim ne constitue pas une tentative d'exécution. `attempt_count` est
incrémenté seulement lorsque l'exécuteur crée atomiquement une ligne append-only
`execution_attempts`. Un crash entre claim et tentative ne consomme donc aucun
numéro.

`state_revision` commence à zéro et augmente atomiquement à chaque transition
métier, y compris l'expiration pré-soumission. Toutes les mutations sous lease
comparent aussi la révision portée par le claim. Le retour ultérieur vers un
statut déjà observé ne permet donc pas à un ancien worker de rejouer une
transition ABA, même s'il présente encore le même token de lease.

Après crash :

- avant signature, l'intention peut être reprise après expiration du lease ;
- après signature, elle passe par la réconciliation de cette signature ;
- après un timeout de soumission, elle devient
  `UNKNOWN_REQUIRES_RECONCILIATION` ;
- tant que le blockhash reste valide, seul le renvoi des bytes signés exacts et
  de la même signature peut être envisagé ;
- une nouvelle transaction avec un nouveau blockhash n'est permise qu'après
  dépassement finalisé de `lastValidBlockHeight`, recherche historique de la
  signature sur le fournisseur épinglé et preuve qu'aucun delta réel n'existe ;
- un BUY ambigu n'est jamais reconstruit automatiquement avec un nouveau
  blockhash ;
- toute ambiguïté conserve l'état inconnu et interdit le BUY.

## 6. Production des intentions

La production réutilise les décisions canoniques `creation-entry-v1`, leurs
qualifications, leurs quotes causales et les identités de commandes paper.
Elle doit être atomique avec la transition source ou protégée par une projection
rejouable déterministe. Elle ne relit pas une qualification obsolète et ne
transforme pas une simple présence de métadonnées en autorisation.

En #51-B, le mapper pur accepte uniquement l'événement canonique et immuable
`PaperStrategySessionUpdated` dont le payload correspond exactement à la
session courante. `requested_at` est le temps observé de cet événement et doit
égaler `session.updatedAtMs`; le fingerprint est le SHA-256 de sa
représentation JSON canonique. `expires_at - requested_at` doit rester dans le
TTL maximal fourni au mapper, lui-même borné par le maximum dur
`14_400_000 ms`. Toute lignée, qualification, quote ou échéance
incohérente est refusée fail-closed. Ce mapper n'est composé dans aucun runtime
et ne persiste lui-même aucune intention.

Configuration initiale :

```dotenv
EXECUTION_INTENT_EMISSION_ENABLED=false
LIVE_QUOTE_MINT_ALLOWLIST=So11111111111111111111111111111111111111112
```

La PR #51-B livre le domaine, le schéma, le repository et ce mapper pur inerté.
Aucun producteur n'est composé et aucun executor n'est alors capable de
signer ou envoyer. La règle d'émission live sera activée seulement lorsque le
processus executor et tous les gates correspondants existent.

Une vente prioritaire conserve les reason codes paper actuels, notamment vente
du créateur, kill switch, retournement de flux et sortie de sécurité. Si la
bonding curve est complète, seule une preuve canonique `PUMPSWAP_ACTIVE` permet
de router un SELL vers PumpSwap. L'absence de venue vendable laisse la sortie en
attente et bloque les nouvelles entrées ; elle ne devient jamais une promesse
de sellabilité.

## 7. Construction, simulation et soumission

### 7.1 Sources de vérité

L'exécuteur :

- récupère une quote fraîche depuis l'adaptateur officiel correspondant ;
- lit les frais dynamiques on-chain ou via le SDK officiel épinglé ;
- utilise les réserves effectives PumpSwap ;
- détecte SPL Token ou Token-2022 ;
- construit lui-même le message à signer ;
- refuse une transaction opaque fournie par le listener ou la base ;
- vérifie programme, instructions, mint, quote mint, venue, fee payer,
  authority, comptes destinataires, montant maximal débité, priority fee,
  comptes supplémentaires, limites et expiration ;
- refuse toute instruction ou compte inscriptible inattendu ;
- utilise `bigint` pour toutes les valeurs financières.

### 7.2 Dry-run

Le dry-run réclame et valide les intentions, produit une quote fraîche, applique
le sizing et enregistre un résultat déterministe sans construire de capacité de
signature ni appeler une méthode de soumission. Il doit fonctionner sans
keypair.

#51-C livre d'abord le processus, les claims, leases, reprises et évaluations
annexes déterministes. Il ne change pas le statut métier, ne crée aucune
tentative et laisse l'intention disponible pour #51-D. Son évaluation porte
`FOUNDATION_VALIDATED`, avec une couverture limitée à `INTENT_AND_LEASE_ONLY`,
et marque quote, build, simulation, signature et soumission `NOT_RUN`. Elle ne
constitue donc aucune preuve de marché et n'est jamais présentée comme un
`PASS` de trading. #51-D remplace ces absences par une quote fraîche, un build
non signé et une simulation sans envoi. La conception de #51-C est versionnée
dans [2026-08-30-executor-dry-run-design.md](2026-08-30-executor-dry-run-design.md)
et celle de #51-D dans
[2026-08-31-executor-quote-build-simulation-design.md](2026-08-31-executor-quote-build-simulation-design.md).
La conception de #51-E est versionnée dans
[2026-08-31-executor-risk-reconciliation-design.md](2026-08-31-executor-risk-reconciliation-design.md).
La conception de #51-F est versionnée dans
[2026-08-31-executor-preflight-operations-design.md](2026-08-31-executor-preflight-operations-design.md)
et celle de #51-G dans
[2026-08-31-executor-live-canary-design.md](2026-08-31-executor-live-canary-design.md).

### 7.3 Simulation sans envoi

La phase suivante construit une transaction non signée avec la clé publique
attendue et appelle `simulateTransaction` avec une configuration explicitement
sans vérification de signature lorsqu'elle est nécessaire. Elle vérifie :

- réussite de la simulation ;
- compute units et frais estimés bornés ;
- `minimumAmountOutRaw` ;
- quote, blockhash et snapshot encore frais ;
- programmes et comptes attendus ;
- absence d'extension token non supportée ;
- possibilité d'obtenir une quote SELL complète après un BUY.

Cette phase ne charge aucun keypair et ne peut appeler aucune méthode d'envoi.

### 7.4 Live futur

En live, l'exécuteur signe localement, persiste avant envoi la signature, le
hash du message, le blockhash, sa dernière hauteur valide et les bytes exacts,
puis simule une dernière fois cette transaction exacte avec vérification des
signatures. Immédiatement avant envoi, un BUY revérifie son armement d'entrée ;
un SELL revérifie à la place l'autorisation de sortie durable de sa position.
Les deux revérifient `HARD_STOP`, wallet, cluster, la fraîcheur de leur quote et
les contraintes applicables, puis soumettent les bytes persistés. Le BUY
revérifie en plus quota d'entrée, drawdown, plafonds et exposition. Le SELL
revérifie que sa quantité ne dépasse pas la quantité ouverte réconciliée et
autorisée ; il n'est jamais bloqué par un plafond d'exposition ou de drawdown
destiné aux entrées. `ENTRY_STOP` et l'expiration de l'armement d'entrée ne
bloquent donc pas un SELL autorisé. Une erreur entre signature et confirmation
devient ambiguë par défaut.

La confirmation ne suffit pas à fermer l'intention. La réconciliation compare
les balances réelles du wallet, les comptes token, la signature, les frais et
les montants effectivement débités/reçus. Le PnL utilise ces deltas réconciliés,
jamais le fill théorique. `CONFIRMED` correspond au commitment Solana
`confirmed`, mais le capital et le PnL ne deviennent réutilisables qu'après
preuve `finalized` obtenue depuis un fournisseur épinglé. Un reorg avant
finalisation conserve l'exposition et impose la réconciliation.

## 8. Sizing et exposition

La V1 utilise un capital réalisé et réconcilié, exprimé en lamports. Les gains
non réalisés et les quotes fiat n'augmentent jamais le sizing.

Configuration cible, sans valeur live implicite :

```dotenv
LIVE_INITIAL_CAPITAL_LAMPORTS=
LIVE_MAX_CAPITAL_LAMPORTS=
LIVE_POSITION_SIZE_BPS=1000
LIVE_MAX_OPEN_POSITIONS=2
LIVE_MAX_TOTAL_EXPOSURE_BPS=2000
LIVE_DRAWDOWN_PAUSE_BPS=2500
LIVE_FEE_RESERVE_LAMPORTS=
```

Contraintes :

- `LIVE_MAX_CAPITAL_LAMPORTS` est requis et ne dépasse pas le financement
  manuel correspondant à environ 10 USDT au moment de l'armement ;
- 10 % maximum du capital réalisé et réconcilié par position en pilote ;
- deux positions et 20 % d'exposition maximum en pilote ;
- la réserve de frais est soustraite avant sizing ;
- le drawdown de 25 % bloque les nouveaux BUY ;
- le drawdown inclut les positions ouvertes à leur valeur de liquidation
  complète conservatrice ; une quote SELL absente valorise la position à zéro ;
- une position inconnue ou non réconciliée compte à son exposition maximale ;
- aucune conversion `number` ou float n'est permise.

Les valeurs canary et micro-live sont plus restrictives que le pilote et ne
peuvent pas être relâchées par la configuration générale.

Chaque admission BUY prend un verrou transactionnel global pour le wallet et
réserve atomiquement son exposition durable avant de libérer ce verrou. Tous
les exécuteurs utilisent la même génération de wallet ; deux intentions
différentes ne peuvent donc pas valider simultanément des plafonds à partir du
même solde. La réservation d'un BUY ambigu reste comptée jusqu'à résolution.

## 9. Quota provider et santé

Le saut de #49 retire une mesure terrain du provider. Avant tout canary, la V1
exige donc un usage provider connu, horodaté et dans le TTL configuré, obtenu par
une sonde autoritative ou un relevé opérateur conservé avec sa provenance.
La mesure contient le plan, la période de facturation, la limite, la valeur,
`measuredAt` et son TTL. `PROVIDER_USAGE_MAX_AGE_SECONDS` vaut 300 par défaut et
reste borné entre 30 et 900 secondes. Les compteurs locaux sont durables et ne
repartent pas à zéro après restart. Une valeur périmée, non monotone ou issue
d'une autre période est inconnue.

États :

```text
NORMAL
ENTRY_BLOCKED
EXIT_ONLY
UNKNOWN
```

`UNKNOWN` bloque les BUY. Les seuils sont configurables en entiers. Les
capacités SELL, confirmation et réconciliation disposent d'une réserve qui ne
peut être consommée par les entrées. Cette réserve est calculée de façon
pessimiste pour toutes les positions ouvertes, leurs confirmations et leurs
réconciliations ; un seuil absolu comme 850k/950k ne suffit pas à lui seul. Un
budget entier configurable additionne, par position, le pire coût mesuré de
SELL, confirmation et réconciliation, puis une marge de sécurité. Aucun BUY
n'est admis si les crédits restants après son coût pessimiste passent sous ce
budget. Trois HTTP 429 consécutifs sur une fenêtre glissante de 30 secondes, ou
l'épuisement des endpoints, provoquent au minimum
`ENTRY_BLOCKED`, puis `EXIT_ONLY` selon le seuil. Les appels de sortie et de
réconciliation sont prioritaires sur les quotes d'entrée et la télémétrie non
essentielle.

Les logs exposent uniquement des identifiants publics positionnels de provider,
les compteurs et reason codes. Ils ne contiennent aucune URL ou credential.

## 10. Gates remplaçant #49

Le saut de #49 ne produit aucun `PASS` de substitution. L'activation réelle
reste interdite tant que tous les gates ci-dessous ne sont pas satisfaits :

1. build, check, lint, docs et tests complets verts ;
2. migrations rejouables sur base vide et upgrade sans perte ;
3. tests d'architecture prouvant l'absence de signer/envoi dans le listener,
   le dry-run et la simulation-only ;
4. dry-run déterministe avec replay, crash et leases ;
5. simulation BUY Pump.fun, SELL Pump.fun et SELL PumpSwap réussie sur fixtures
   officielles assainies, sans envoi ;
6. matrice de fautes timeout/429/crash/reorg sans double ordre ;
7. aucune intention inconnue, position résiduelle ou balance incohérente ;
8. quota provider connu, frais disponibles et capacité de sortie réservée ;
9. kill switch testé et `EXIT_ONLY` testé ;
10. wallet, cluster, genesis hash, plafond de capital et permissions validés ;
11. preflight Mainnet sans envoi empruntant le chemin exact de quote, build,
    validation statique et simulation de l'exécuteur déployé ;
12. armement explicite, limité à une phase, un wallet, un cluster et une durée.

Le preflight produit un `SafetyQualificationRecord` versionné, horodaté et lié
au hash du build, au fingerprint de configuration et stratégie, au cluster, au
wallet, au provider et à la phase. Il devient invalide au moindre changement
d'une de ces valeurs. Sa durée de validité V1 est de cinq
minutes et elle n'est pas configurable au-delà. Son transport Mainnet est
structurellement incapable de soumettre. Les gates 1 à 11 peuvent être
automatisés. Le gate 12 nécessite une décision opérateur distincte. Aucun
déploiement ou simple changement de variable ne doit armer automatiquement le
live.

## 11. Activation progressive future

### 11.1 Canary

```text
maximum : 1 BUY + 1 SELL
taille : 5 % maximum du capital, plafond absolu d'environ 0,50 USDT en lamports
concurrence : 1 position
deadline de détention : 300 secondes, configurable entre 30 et 900 secondes
```

Le plafond en lamports est saisi et validé au moment de l'armement. Le canary
est techniquement réussi seulement si la signature, la confirmation, les
balances, les frais et le PnL sont réconciliés, sans résiduel, double ordre ou
état inconnu. Une deadline de détention bornée force la demande de SELL même si
les sorties stratégiques habituelles ne sont pas atteintes. Le PnL peut être
négatif. L'armement s'auto-verrouille après son unique BUY puis se termine après
la clôture ; il ne peut jamais promouvoir la phase suivante.

### 11.2 Micro-live

Après un canary techniquement propre : trois positions clôturées au maximum,
5 % par position et une seule simultanément. Toute anomalie referme le gate et
repasse en `EXIT_ONLY`.

### 11.3 Pilote

Après trois clôtures techniquement propres : capital financé manuellement
plafonné à environ 10 USDT en SOL, 10 % par position, deux positions et 20 %
d'exposition totale maximum. Cette phase ne constitue toujours aucune promesse
de rentabilité.

Chaque changement de phase requiert un nouvel armement. Les autorisations ne se
propagent pas automatiquement.

## 12. Conditions d'arrêt

Les nouveaux BUY sont bloqués immédiatement pour :

- kill switch actif ;
- drawdown au plafond ;
- usage provider inconnu, périmé ou au seuil ;
- état `UNKNOWN_REQUIRES_RECONCILIATION` ;
- intention dupliquée ou signature incohérente ;
- balance, position ou capital non réconcilié ;
- mismatch wallet, cluster ou genesis hash ;
- simulation, reverse quote ou sell quote indisponible ;
- quote, décision ou qualification périmée ;
- extension token ou quote mint non supporté ;
- deux tentatives techniques consécutives en échec pour le même wallet et la
  même phase ; seules les erreurs de build, simulation, soumission,
  confirmation, provider ou réconciliation comptent, et seule une intention
  entièrement finalisée et réconciliée remet ce compteur à zéro ;
- expiration ou révocation de l'armement.

Le kill switch interdit les nouveaux BUY mais ne supprime pas les intentions et
ne désactive pas les SELL, confirmations ou réconciliations nécessaires. La
reprise refuse tout état inconnu ou résiduel. Deux arrêts durables existent :

- `ENTRY_STOP`, qui impose `EXIT_ONLY` et laisse fonctionner les sorties et la
  réconciliation ;
- `HARD_STOP`, réservé notamment à une compromission de clé ou une transaction
  malformée, qui interdit toute nouvelle signature et toute soumission.

Les deux survivent au restart et sont revérifiés juste avant l'envoi. Aucune
reprise n'est automatique ; `live:resume` relance un preflight complet et exige
un nouvel armement.

## 13. Commandes opérateur

Les commandes restent locales au processus executor et ne sont pas exposées
par l'API publique :

```bash
npm run executor:start
npm run live:preflight
npm run live:status
npm run live:arm -- --phase=canary
npm run live:kill-switch -- --mode=entry-stop --reason=<reason-code>
npm run live:kill-switch -- --mode=hard-stop --reason=<reason-code>
npm run live:resume
npm run live:report
```

`live:arm` et `live:resume` doivent être interactifs ou recevoir une preuve
d'autorisation explicite non réutilisable. Ils refusent un terminal non TTY par
défaut. Une intégration automatisée ultérieure nécessitera un mécanisme
d'autorisation distinct et versionné.

## 14. Données, rétention et API

Les données brutes d'exécution sont séparées des projections observe/paper.
Une intention ouverte, inconnue ou non réconciliée n'est jamais purgée. Après
terminalisation, `reconciliation_completed_at` atteste soit la réconciliation
on-chain, soit la preuve qu'aucun effet on-chain n'a été possible. C'est
seulement alors que `purge_after` est fixé à quatre heures. Un
artefact signé reste conservé au minimum jusqu'à la preuve finalisée que son
blockhash ne peut plus atterrir, puis suit cette même fenêtre. La purge supprime
d'abord évaluations dry-run, artefacts, transitions et tentatives, puis
l'intention, dans une transaction rejouable. Elle publie seulement des
compteurs agrégés.

Le plafond dur d'échéance réduit la fenêtre d'exécution et reste une défense en
profondeur :

```text
expires_at <= requested_at + 4h
requested_at <= terminal_at <= reconciliation_completed_at
purge_after = reconciliation_completed_at + 4h
donc expires_at <= purge_after
```

Cette relation ne suffit pas à empêcher un producteur de recréer le même ordre
logique avec un nouvel événement et des timestamps frais. Avant de supprimer
une intention réconciliée, la purge insère donc dans la même transaction un
tombstone durable de son ID et de sa clé logique. `create()` vérifie le
tombstone après sa tentative d'insertion, toujours dans la même transaction :
si l'ID ou la clé logique a déjà été retiré, l'insertion éventuelle est annulée
et `INTENT_DUPLICATE` est retourné. Ce contrôle post-insertion ferme aussi la
course entre une création concurrente et une purge qui détenait le verrou sur
la ligne parente.

La fondation #51-B fige une heure de coupure PostgreSQL puis verrouille une
cohorte ordonnée d'identifiants terminaux et réconciliés. Les tombstones de
cette cohorte exacte sont insérés avant que les évaluations dry-run,
transitions, tentatives puis intentions soient supprimées dans la même
transaction. Une collision de tombstone fait échouer toute la purge, sans
suppression partielle. Une ligne
devenue éligible pendant la passe attend la passe suivante; une ligne ouverte,
inconnue ou non réconciliée n'entre jamais dans la cohorte.

Les tombstones ne suivent pas la fenêtre de quatre heures : ils restent utiles
à la garantie « un ordre logique au plus une fois » et sont donc conservés
durablement. Leur minimisation explicite satisfait la rétention des données
métier devenues inutiles sans affaiblir l'idempotence.

Le front-end public reste indépendant et en lecture seule. La V1 n'ajoute
aucune route publique d'armement, de clé, de soumission ou de contrôle. Les
signatures, chemins de secrets, wallet executor et preuves détaillées restent
hors de l'API publique. Une future surface opérateur devra être authentifiée,
séparée et spécifiée dans une autre version.

## 15. Reason codes stables initiaux

```text
INTENT_EXPIRED
INTENT_DUPLICATE
INTENT_LEASE_LOST
QUALIFICATION_STALE
DECISION_STALE
QUOTE_STALE
QUOTE_MINT_NOT_ALLOWED
VENUE_UNAVAILABLE
BUY_SIMULATION_FAILED
SELL_SIMULATION_FAILED
SELL_QUOTE_UNAVAILABLE
MINIMUM_AMOUNT_OUT_VIOLATED
UNSUPPORTED_TOKEN_EXTENSION
WALLET_MISMATCH
GENESIS_MISMATCH
EXECUTION_PROVIDER_FAILED
EXECUTION_BUILD_FAILED
EXECUTION_EVIDENCE_INVALID
CAPITAL_LIMIT_EXCEEDED
EXPOSURE_LIMIT_EXCEEDED
DRAWDOWN_LIMIT_EXCEEDED
PROVIDER_USAGE_UNKNOWN
PROVIDER_ENTRY_LIMIT_REACHED
PROVIDER_EXIT_ONLY
KILL_SWITCH_ACTIVE
HARD_STOP_ACTIVE
ARMING_REQUIRED
ARMING_EXPIRED
SIGNATURE_PERSIST_FAILED
SUBMISSION_AMBIGUOUS
CONFIRMATION_TIMEOUT
RECONCILIATION_REQUIRED
BALANCE_MISMATCH
RESIDUAL_TOKEN_BALANCE
DOUBLE_ORDER_SUSPECTED
EXECUTION_STARTED
SIMULATION_SUCCEEDED
ATTEMPT_COMPLETED
RETRY_AUTHORIZED
SIGNATURE_PERSISTED
SUBMISSION_ACCEPTED
CONFIRMATION_OBSERVED
RECONCILIATION_STARTED
INTENT_SUCCEEDED
INTENT_CANCELLED
RECONCILIATION_PROVED_NO_EFFECT
```

La liste est append-only dans la version majeure 1. Un code n'est jamais
réaffecté à une autre signification.

## 16. Découpage en PR indépendantes

| PR | Livraison | Capacité de signature/envoi |
| --- | --- | --- |
| #51-A | Cette spécification et le plan versionné | Aucune |
| #51-B | Domaine, migration des intentions/tentatives/tombstones, repository, idempotence et rétention | Aucune |
| #51-C | Processus executor dry-run, claim temporaire et évaluation annexe sans consommer l'intention | Aucune |
| #51-D | Quotes fraîches, build et `simulateTransaction` sans keypair ni envoi | Aucune |
| #51-E | Réconciliation, verrou/réservation wallet, sizing, exposition, quota provider et matrice de fautes | Aucune |
| #51-F | Preflight, status, kill switch, armement inerte, rapports opérateur et rôles PostgreSQL séparés | Aucune |
| #51-G | Chargement secret, signature et soumission dans l'exécutable séparé, live désactivé et non armé | Présente mais inaccessible par défaut |

Chaque PR est fusionnable seule, garde le listener opérationnel et passe trois
cycles de revue au maximum. Une PR ne peut pas anticiper l'activation de la
suivante.

## 17. Tests obligatoires cumulés

- identité déterministe et unicité de l'ordre logique ;
- claim concurrent, perte de lease, crash/reprise à chaque transition ;
- aucune double soumission après replay ou timeout ambigu ;
- migration base vide, replay et upgrade depuis la migration 030 ;
- montants maximums PostgreSQL et `bigint` sans float ;
- BUY/SELL Pump.fun et SELL PumpSwap ;
- graduation pendant une position ;
- quote causale, fraîcheur, minimum out, frais et slippage ;
- SPL Token et Token-2022 supportés ou refus explicite ;
- allowlist SOL/WSOL initiale ;
- sizing, réserve de frais, exposition et drawdown ;
- quota inconnu, seuil BUY et `EXIT_ONLY` ;
- kill switch, armement absent/expiré et reprise refusée ;
- keypair absent, invalide, permissions faibles et wallet mismatch ;
- signature persistée avant tentative d'envoi ;
- confirmation et balances réelles réconciliées ;
- rétention du payload métier quatre heures après réconciliation seulement,
  avec tombstone anti-rejeu minimal conservé durablement ;
- aucune fuite de secret dans logs, erreurs, rapports ou API ;
- aucun import live depuis le listener, l'API publique, le paper ou la
  simulation-only ;
- aucun test automatisé ne peut joindre une méthode d'envoi Mainnet réelle.

## 18. Critères d'acceptation de #51-A

- la décision de sauter #49 et son risque résiduel sont explicites ;
- les frontières listener/executor sont normatives ;
- le contrat durable, les états et l'idempotence sont définis ;
- les gates compensatoires et l'activation progressive sont testables ;
- SOL/WSOL est l'allowlist initiale sans coupler le domaine à SOL ;
- la rétention terminale de quatre heures est documentée ;
- les lots #51-B à #51-G sont indépendants ;
- aucun code de production, comportement, secret ou mode live n'est ajouté ;
- `npm run build`, `npm run check`, `npm run lint`, `npm test` et
  `npm run docs:check` restent verts.

## 19. Versionnement et évolution

- **patch** : clarification sans changement de comportement attendu ;
- **minor** : ajout compatible d'état, reason code ou gate ;
- **major** : changement d'identité, de transition, d'autorité ou de sécurité.

Chaque rapport et ligne durable conserve sa `payload_version`, l'identité de la
stratégie, le fingerprint de décision et la version de cette spécification. Une
version inconnue est refusée fail-closed.

## 20. Risques résiduels acceptés

Même après tous les gates, la première transaction réelle peut rencontrer des
conditions non reproduites localement : congestion, priorité concurrente,
changement de frais, volatilité, token hostile ou indisponibilité provider. Le
saut de #49 rend cette incertitude plus forte. Le canary minimise l'exposition,
mais ne la supprime pas.

La seule conclusion autorisée d'un canary propre est : « le chemin technique
observé a été exécuté et réconcilié dans ce cas ». Elle ne valide ni la
stratégie, ni la rentabilité, ni les performances futures.
