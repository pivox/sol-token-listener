# Risque, quota et réconciliation Executor V1 — conception #51-E

**Version de spécification :** 1.0.2

**Version de la spécification parente :** 1.6.2

**Date :** 2026-08-31

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-D fusionnée par la PR #72

## Historique des versions

- **1.0.2 — 2026-08-31 :** corrige le décompte du schéma durable : la liste
  normative contient onze tables, dont `execution_wallet_risk_state` et les
  tombstones minimaux.
- **1.0.1 — 2026-08-31 :** ajoute les bornes temporelles exactes de la période
  de facturation provider afin de détecter une régression sans interpréter son
  identifiant opaque.
- **1.0.0 — 2026-08-31 :** conception initiale de la fondation #51-E.

## 1. Décision

#51-E livre une fondation durable, déterministe et testable pour les gates de
risque qui précèdent toute future exécution réelle. Elle reste inerte : aucun
nouveau mode n'est composé dans `src/executor/main.ts`, aucun keypair n'est
chargé, aucune transaction n'est signée et aucun RPC de soumission n'existe.

Le flux futur préparé est :

```text
intention durable
  -> snapshot wallet finalisé et cohérent
  -> état quota provider frais et pessimiste
  -> policy sizing/exposition bigint
  -> admission transactionnelle sous verrou wallet
  -> réservation durable d'exposition et de capacité de sortie
  -> quote/build/simulation futurs
  -> effet on-chain futur
  -> observation read-only finalisée
  -> réconciliation durable
  -> libération ou consommation de la réservation
```

Les artefacts `simulation-only` de #51-D restent terminaux et non signables.
Ils ne peuvent ni être admis rétroactivement, ni être convertis en capacité
live. #51-F réutilisera les ports de #51-E pour un preflight sans soumission ;
#51-G devra créer une nouvelle tentative et refaire tous les gates.

## 2. Approches évaluées

| Approche | Décision | Motif |
| --- | --- | --- |
| Transformer le worker #51-D en worker live progressif | Rejetée | Contredit le caractère terminal et non signable de ses artefacts. |
| Ajouter un mode `risk-only` au runtime | Rejetée pour #51-E | Créerait un comportement opérateur sans preflight, rôle DB ni armement #51-F. |
| Livrer domaine, migration, repositories et services non composés | Retenue | Ferme les invariants transactionnels tout en conservant exactement le comportement de production. |

## 3. Périmètre

### 3.1 Inclus

- policy V1 de sizing et exposition en `bigint` ;
- génération singleton du wallet executor, sans secret ;
- snapshots de balances finalisés, versionnés et immuables ;
- admission BUY transactionnelle sous verrou global wallet ;
- réservation durable pessimiste par intention ;
- état provider `NORMAL | ENTRY_BLOCKED | EXIT_ONLY | UNKNOWN` ;
- snapshots d'usage provider autoritatifs et compteurs locaux durables ;
- réserve provider dédiée à SELL, confirmation et réconciliation ;
- preuves de réconciliation `MATCHED | NO_EFFECT | MISMATCH | UNKNOWN` ;
- policy de retry/fautes sans exécuter de retry réseau ;
- purge des payloads devenus inutiles après quatre heures ;
- tests base vide, replay, concurrence, crash et corruption ;
- garde d'architecture source et `dist` sans signature ni soumission.

### 3.2 Exclus

- composition dans `src/executor/main.ts` ;
- lecture de keypair, signature, bytes signés ou envoi ;
- commandes `live:*`, kill switch, armement et rôles DB, réservés à #51-F ;
- retry automatique du worker #51-D ;
- oracle fiat ou conversion SOL/USDT ;
- plusieurs wallets ou plusieurs quote mints live ;
- publication des données executor dans l'API publique ;
- réutilisation d'un artefact terminal #51-D.

## 4. Frontière de capacités

Le graphe #51-E peut importer les domaines executor, les ports read-only, les
repositories PostgreSQL, `node:crypto`, `node:util/types` et les primitives de
décodage Solana nécessaires aux preuves. Il ne peut importer ni listener,
paper runtime, API publique, ancien `src/execution`, Raydium, `Keypair`,
`Signer`, wallet adapter ou fonction `send*`/`submit*`.

Les services sont construits explicitement dans les tests et, plus tard, par
#51-F. Le bootstrap actuel doit rester fonctionnel sans modification dans ses
modes `dry-run` et `simulation-only`. La configuration #51-E est un objet de
domaine explicite ; aucune variable live n'est ajoutée à `.env.example` avant
#51-F.

## 5. Policy de risque V1

### 5.1 Entrées exactes

`ExecutionRiskPolicyV1` est immuable et fingerprintée :

```text
payloadVersion = 1
quoteMintAllowlist = [WSOL]
initialCapitalLamports
maximumCapitalLamports
positionSizeBps
maximumOpenPositions
maximumTotalExposureBps
drawdownPauseBps
feeReserveLamports
walletSnapshotMaxAgeMs
providerUsageMaxAgeMs
providerEntryCostUnits
providerExitCostUnitsPerPosition
providerConfirmationCostUnitsPerPosition
providerReconciliationCostUnitsPerPosition
providerSafetyMarginUnits
maximumConsecutiveTechnicalFailures = 2
```

Tous les montants et unités sont des entiers non négatifs. Les lamports et
agrégats financiers sont des `bigint`; les basis points sont des `bigint`
bornés à `0..10_000`. Les compteurs bornés sont des entiers sûrs. Le domaine
rejette les floats, `NaN`, infinis, nombres financiers JavaScript, objets
mutables, accessors, proxies, clés inconnues et décimaux non canoniques.

La policy ne contient aucune valeur live implicite. Le profil canary futur est
plus restrictif que le pilote et sera figé par l'armement #51-F.

### 5.2 Capital et sizing

```text
reconciledCapital = min(initialCapital + realizedNetPnl, maximumCapital)
capitalAfterFeeReserve = max(0, reconciledCapital - feeReserve)
positionLimit = floor(capitalAfterFeeReserve * positionSizeBps / 10_000)
totalExposureLimit = floor(reconciledCapital * maximumTotalExposureBps / 10_000)
```

Une intention BUY est admise uniquement si son `quoteAmountRaw` est inférieur
ou égal à `positionLimit`. #51-E ne réécrit jamais le montant immuable de
l'intention. L'exposition après réservation doit rester sous
`totalExposureLimit`, le nombre de positions sous son plafond et le drawdown
conservateur strictement sous `drawdownPauseBps`.

Les gains non réalisés n'augmentent jamais le capital. Une position ouverte
est valorisée par sa quote SELL conservatrice nette. Sans quote SELL fraîche,
elle vaut zéro pour le drawdown mais conserve sa réservation maximale pour
l'exposition. Une intention ambiguë ou non réconciliée conserve également sa
réservation maximale.

### 5.3 SELL

Les plafonds d'entrée, d'exposition et de drawdown ne bloquent jamais un SELL
lié à une position ouverte. Le SELL reste soumis à la cohérence wallet/cluster,
au `HARD_STOP` futur et à la capacité provider réservée. #51-E ne crée encore
aucune autorisation de sortie et n'exécute aucun SELL.

## 6. Wallet et snapshots finalisés

`execution_wallet_generations` contient une génération active unique :

```text
generation_id
payload_version
wallet_public_key
cluster
genesis_hash
generation
created_at
retired_at
```

Le wallet est une adresse publique uniquement. Une nouvelle génération exige
que l'ancienne soit retirée et qu'aucune réservation, ambiguïté ou
réconciliation ouverte ne subsiste. Le numéro de génération augmente sans
retour arrière.

`execution_wallet_risk_state` contient exactement une ligne par génération.
Elle matérialise seulement les agrégats transactionnels nécessaires à
l'admission : révision monotone, capital réconcilié, exposition réservée,
positions ouvertes, drawdown conservateur, compteur de fautes et éventuel
blocage inconnu. Les détails restent dans les snapshots et ledgers append-only.

`execution_wallet_snapshots` est append-only. Chaque snapshot porte le
provider positionnel, le slot, le block time éventuel, l'heure d'observation,
le commitment exactement `finalized`, le solde SOL, les soldes token utiles,
les positions ouvertes, le PnL net réalisé, un fingerprint et la génération.
Les payloads sont bornés et ne contiennent ni URL, credential, historique de
transactions brut, métadonnées token ou secret.

Un snapshot est utilisable si :

- la génération, le wallet, le cluster et le genesis correspondent ;
- le commitment est `finalized` ;
- son âge est inférieur ou égal au TTL de policy ;
- sa révision est la dernière révision cohérente ;
- aucun état inconnu, résidu token ou mismatch n'est actif.

## 7. Admission et réservation transactionnelles

`execution_exposure_reservations` contient au plus une réservation par
intention et une clé logique unique par position/côté. États :

```text
RESERVED
CONSUMED
RELEASED
UNKNOWN_HELD
```

Une réservation porte la génération wallet, le montant maximal, le mint, le
quote mint, les fingerprints intent/policy/wallet/provider, la révision, la
date de création et, lorsqu'elle est terminale, `reconciled_at` et
`purge_after = reconciled_at + 4h`.

`PostgresExecutionRiskRepository.admitBuy()` effectue une seule transaction :

1. acquiert un advisory xact lock dérivé de la génération wallet ;
2. verrouille l'intention, la génération et leurs agrégats courants ;
3. relit le snapshot wallet et le snapshot provider par identités/fingerprints ;
4. vérifie qu'aucune intention inconnue ou réservation incohérente n'existe ;
5. recalcule sizing, drawdown, exposition et quota avec les valeurs relues ;
6. insère un rapport d'admission déterministe append-only ;
7. insère ou rejoue exactement la réservation ;
8. incrémente la révision de l'agrégat wallet ;
9. committe avec l'heure PostgreSQL unique de la transaction.

Aucun RPC ne s'exécute sous le verrou. Les snapshots sont obtenus avant la
transaction puis authentifiés par ID, fingerprint et révision. Une concurrence
modifiant l'un d'eux produit un refus/retry borné, jamais une admission sur une
lecture périmée.

Le résultat est `ADMITTED | REJECTED | REPLAYED`. Un replay exact retourne la
même admission et la même réservation. Une identité identique avec un payload
différent échoue `INVALID_DATA`; aucune insertion partielle n'est conservée.

## 8. Quota provider

`execution_provider_usage_snapshots` est append-only et contient :

```text
provider_id
plan_id
billing_period_id
billing_period_started_at
billing_period_ends_at
limit_units
used_units
measured_at
expires_at
provenance = AUTHORITATIVE_PROBE | OPERATOR_REPORT
fingerprint
```

Le TTL est compris entre 30 et 900 secondes, 300 par défaut futur. Une mesure
non monotone dans la même période, une régression de période, un changement de
plan non explicite, un dépassement de limite ou une provenance inconnue rend
l'état `UNKNOWN`. La période est semi-ouverte
`[billingPeriodStartedAt, billingPeriodEndsAt)` ; `measuredAt` doit lui
appartenir. Une nouvelle période cohérente commence au plus tôt à la fin de la
précédente. `billingPeriodId` reste opaque et n'est jamais trié lexicalement.

`execution_provider_usage_counters` conserve les consommations locales depuis
la dernière mesure par catégories `ENTRY`, `EXIT`, `CONFIRMATION`,
`RECONCILIATION` et `TELEMETRY`. Les écritures sont idempotentes par
`operation_id`; un restart ne remet rien à zéro.

```text
remaining = limit - measuredUsed - localUsedSinceMeasurement
protected = openPositions * (
  exitCost + confirmationCost + reconciliationCost
) + safetyMargin
```

Une entrée est admise seulement si
`remaining - providerEntryCostUnits >= protected`. La capacité protégée ne peut
pas être consommée par `ENTRY` ou `TELEMETRY`. Une mesure absente/périmée donne
`UNKNOWN`. Avec une mesure cohérente, l'état est `NORMAL` lorsque l'entrée et
la réserve protégée tiennent, `ENTRY_BLOCKED` lorsque la réserve tient mais pas
le coût d'une nouvelle entrée, et `EXIT_ONLY` lorsque le restant est inférieur
à la réserve protégée. Ces états n'affirment jamais qu'un appel futur réussira.

Trois 429 consécutifs dans une fenêtre glissante de 30 secondes créent au
minimum `ENTRY_BLOCKED`. L'épuisement de tous les endpoints ou l'impossibilité
de garantir `protected` produit `EXIT_ONLY` ou `UNKNOWN` selon la preuve
disponible. Les URL et credentials ne sont jamais persistés ni journalisés.

## 9. Réconciliation

Le port `ExecutionReconciliationGateway` est read-only et fermé. Il expose
uniquement des lectures bornées de statut de signature, hauteur finalisée,
transaction observée et balances wallet/token. Il n'expose ni transaction
complète opaque au domaine, ni méthode de signature ou soumission.

`ExecutionReconciliationEvidenceV1` porte :

```text
intentId, attemptNumber, walletGeneration
providerId, signature, blockhash, lastValidBlockHeight
signatureStatus, confirmationStatus, observedSlot
feeLamports, walletLamportDelta, baseDeltaRaw, quoteDeltaRaw
expected fingerprints, observed fingerprints
result = MATCHED | NO_EFFECT | MISMATCH | UNKNOWN
reasonCode
observedAt, finalizedAt, fingerprint
```

Les deltas sont signés et bornés en `bigint`. Une preuve `MATCHED` exige une
signature finalisée, une transaction dont message/programmes/comptes
correspondent aux fingerprints persistés et des balances cohérentes. Elle
consomme la réservation avec les deltas réels. `NO_EFFECT` exige à la fois la
hauteur finalisée strictement supérieure à `lastValidBlockHeight`, l'absence
historique de signature sur le provider épinglé et l'absence de delta ; elle
libère la réservation et autorise le reason code
`RECONCILIATION_PROVED_NO_EFFECT`.

`MISMATCH` conserve la réservation en `UNKNOWN_HELD`, signale
`BALANCE_MISMATCH`, `RESIDUAL_TOKEN_BALANCE` ou `DOUBLE_ORDER_SUSPECTED` et
bloque tout BUY. `UNKNOWN` conserve également la réservation et ne peut jamais
devenir une preuve de non-effet par TTL ou simple absence courante.

Le repository persiste preuve, transition d'intention future, mutation de
réservation et agrégat wallet dans une transaction fenced. #51-E teste cette
opération sur des états durables construits par fixtures ; aucun runtime actuel
ne peut produire les états signés nécessaires.

## 10. Matrice de fautes et retry

La classification est pure, fermée et versionnée :

| Étape | Classe | BUY | SELL/exit | Effet durable |
| --- | --- | --- | --- | --- |
| build/simulation avant signature | transitoire prouvé | retry technique borné | retry prioritaire borné | compteur technique +1 |
| validation/policy | déterministe | terminal/refus | terminal/refus si non vendable | reason code stable |
| provider timeout/429 avant signature | transitoire | retry borné si quota frais | priorité sortie | compteur + quota |
| après signature ou soumission ambiguë | ambiguë | aucun nouvel ordre | mêmes bytes seulement, sinon réconciliation | `UNKNOWN_HELD` |
| confirmation timeout/reorg | ambiguë | réconciliation | réconciliation prioritaire | exposition conservée |
| preuve finalisée `NO_EFFECT` | résolue | retry seulement si policy future l'autorise | retry possible | libération réservation |
| mismatch/double ordre | critique | blocage global BUY | sortie seulement si sûre | `UNKNOWN_HELD` |

Deux échecs techniques consécutifs pour la même génération wallet et la même
phase bloquent les nouveaux BUY. Seuls build, simulation, provider,
confirmation et réconciliation comptent. Une intention entièrement finalisée
et réconciliée remet le compteur à zéro ; un succès de quote, un restart ou un
simple délai ne le remet pas à zéro.

#51-E ne déclenche aucun retry RPC. Il produit seulement une décision
`DO_NOT_RETRY | RETRY_PRE_SIGNATURE | RECONCILE_ONLY | RETRY_EXACT_BYTES` et
les preuves durables nécessaires. `RETRY_EXACT_BYTES` ne sera utilisable qu'en
#51-G après persistance des bytes signés exacts.

## 11. Modèle PostgreSQL

La migration `034_execution_risk_reconciliation.sql` ajoute :

- `execution_wallet_generations` ;
- `execution_wallet_risk_state` ;
- `execution_wallet_snapshots` ;
- `execution_provider_usage_snapshots` ;
- `execution_provider_usage_counters` ;
- `execution_provider_rate_limit_events` ;
- `execution_risk_admission_reports` ;
- `execution_exposure_reservations` ;
- `execution_reconciliation_evidence` ;
- `execution_fault_ledger` ;
- `execution_risk_tombstones` minimaux.

Les tables brutes/snapshots append-only sont séparées des agrégats courants.
Les enums sont fermées par `CHECK`; les timestamps sont UTC, finis et tronqués
à la milliseconde ; les entiers financiers sont `NUMERIC(20,0)` ou
`NUMERIC(39,0)` selon leur signe. Aucune valeur `DOUBLE PRECISION`, `REAL`,
JSON financier numérique, URL provider ou secret n'est autorisée.

La migration est compatible base vide et upgrade depuis 033, rejouable sans
réécrire les lignes. Les contraintes de FK ne permettent jamais de supprimer
une intention, génération ou réservation encore utile à une ambiguïté.

## 12. Rétention

Une admission rejetée, un snapshot supplanté et une réservation réconciliée
deviennent purgeables quatre heures après leur fin d'utilité. Une réservation
`RESERVED` ou `UNKNOWN_HELD`, une preuve `UNKNOWN`/`MISMATCH`, une génération
active et les compteurs de la période provider courante ne sont jamais purgés.

La purge verrouille une cohorte, insère d'abord un tombstone minimal pour les
identités d'admission/réservation, puis supprime enfants avant parents dans une
transaction. Les tombstones conservent uniquement les IDs/fingerprints
nécessaires à l'idempotence, sans mint, wallet, montant ou payload.

## 13. Contrats et erreurs

Les objets publics internes sont exacts, gelés, sans `any`, accessors ni clés
supplémentaires. Les erreurs sont typées, à message fixe et sans cause publique
sensible :

```text
ExecutionRiskValidationError
ExecutionRiskRepositoryError
ExecutionProviderQuotaError
ExecutionReconciliationError
```

Les reason codes existants sont réutilisés sans changement de sens :
`CAPITAL_LIMIT_EXCEEDED`, `EXPOSURE_LIMIT_EXCEEDED`,
`DRAWDOWN_LIMIT_EXCEEDED`, `PROVIDER_USAGE_UNKNOWN`,
`PROVIDER_ENTRY_LIMIT_REACHED`, `PROVIDER_EXIT_ONLY`, `BALANCE_MISMATCH`,
`RESIDUAL_TOKEN_BALANCE`, `DOUBLE_ORDER_SUSPECTED`,
`RECONCILIATION_REQUIRED` et `RECONCILIATION_PROVED_NO_EFFECT`.

Aucun nouveau reason code n'est requis en version 1.0.0. Un besoin ultérieur
est ajouté de façon append-only dans la spécification parente.

## 14. Tests obligatoires

- policy exacte, objets hostiles et arithmétique aux bornes `u64/i128` ;
- sizing, fee reserve, positions, exposition, drawdown et quote SELL absente ;
- allowlist initiale WSOL sans couplage du domaine ;
- provider frais, périmé, non monotone, période changée, 429 et `EXIT_ONLY` ;
- budget de sortie pessimiste pour 0, 1 et maximum de positions ;
- admission concurrente de deux BUY sur la même génération ;
- replay exact, conflit, lease/CAS perdu et crash à chaque frontière ;
- réservation conservée pour ambiguïté, mismatch et reorg ;
- preuve `NO_EFFECT` seulement après hauteur finalisée, absence historique et
  zéro delta ;
- preuve `MATCHED` avec deltas réels et frais exacts ;
- deux fautes techniques, reset uniquement après succès final réconcilié ;
- migration base vide, replay, upgrade 033 et contraintes de corruption ;
- rétention à la frontière exacte de quatre heures ;
- scan source/dist sans secret, signer, send, submit ou nouveau runtime ;
- `npm run build`, `npm run check`, `npm run lint`, `npm test` et
  `npm run docs:check`.

## 15. Critères d'acceptation

- le comportement des modes `dry-run` et `simulation-only` ne change pas ;
- aucune capacité de signature/soumission ou variable de secret n'apparaît ;
- une admission BUY concurrente ne peut dépasser aucune limite ;
- le quota de sortie est durable et inaccessible aux entrées ;
- un état inconnu conserve l'exposition et bloque les BUY ;
- aucun timeout ou TTL ne prouve seul l'absence d'effet ;
- les réservations sont libérées uniquement par preuve réconciliée ;
- tous les calculs financiers utilisent `bigint` et les données PostgreSQL
  sont décodées depuis du texte canonique ;
- les payloads devenus inutiles sont supprimés après quatre heures ;
- #49 reste `NON_EXECUTED / NON_VALIDATED` et #51-F/#51-G restent obligatoires ;
- trois cycles de revue GitHub au maximum sont exécutés avant fusion.

## 16. Risques résiduels

#51-E prouve les invariants locaux et transactionnels, pas la qualité réelle du
provider ni les effets d'une transaction Mainnet. Sans composition #51-F et
sans capacité #51-G, les preuves de réconciliation live ne peuvent pas être
produites par le runtime. Le saut de #49 reste une incertitude explicite ; il
ne devient pas un `PASS` grâce à ces tests.
