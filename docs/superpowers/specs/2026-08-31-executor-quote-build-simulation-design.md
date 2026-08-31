# Exécuteur quote, build et simulation V1 — conception #51-D

**Version de spécification :** 1.0.2

**Date :** 2026-08-31

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-C fusionnée par la PR #71

## Historique des versions

- **1.0.2 — 2026-08-31 :** ferme le code interne des erreurs programme, la
  traduction d'une réponse provider malformée avant snapshot et l'usage de
  `NUMERIC` non typé afin d'empêcher l'arrondi PostgreSQL avant validation.
- **1.0.1 — 2026-08-31 :** ferme la politique WSOL PumpSwap, les contextes
  blockhash/fee, l'orientation du pool canonique, les recipients SDK, la
  matrice d'échec, les reason codes techniques, les fingerprints et la preuve
  SQL d'absence d'effet après revue des SDK officiels et du modèle durable.
- **1.0.0 — 2026-08-31 :** conception initiale de la quote fraîche, du build
  éphémère non signé et de la simulation Solana sans envoi.

## 1. Décision et preuve produite

#51-D ajoute au processus executor un mode explicite `simulation-only`, séparé
du mode `dry-run` de #51-C. Il transforme une intention durable en preuve de
marché et de transaction sans charger de secret, signer ou soumettre :

```text
claim EXECUTE
  -> PENDING|RETRY_READY -> PROCESSING
  -> tentative STARTED
  -> provider épinglé + genesis vérifié
  -> snapshot causal + quote fraîche
  -> plan d'instructions officiel inspecté
  -> message v0 éphémère non signé
  -> simulateTransaction(sigVerify=false)
  -> commit atomique de la preuve et de la tentative
  -> SIMULATED -> SUCCEEDED
```

`SIMULATED` signifie qu'une simulation Solana a réellement réussi. La
transition immédiate vers `SUCCEEDED` signifie uniquement que l'intention
**simulation-only** est terminée. Elle ne signifie ni transaction envoyée, ni
fill, ni profit, ni sellabilité future.

Une intention terminée par #51-D ne peut jamais être reprise par #51-G pour
être signée. Une future exécution armée devra créer une nouvelle intention
logique et obtenir une nouvelle quote, un nouveau build et une nouvelle
simulation sous les gates alors applicables.

Le mode par défaut reste `dry-run`. Aucun producteur d'intention n'est activé
par cette PR.

## 2. Périmètre

### 2.1 Inclus

- BUY Pump.fun sur bonding curve active ;
- SELL Pump.fun sur bonding curve active ;
- SELL PumpSwap après preuve durable de migration et pool canonique actif ;
- instruction Pump.fun `buy_v2` ou `sell_v2` ;
- instruction PumpSwap `sell` via le SDK officiel épinglé ;
- modèle multi-quote, avec allowlist opérationnelle V1 limitée à WSOL ;
- SPL Token Program classique ou Token-2022 avec extensions explicitement
  autorisées ;
- quote, frais et réserves issus d'un snapshot causal ;
- message Solana v0 sans Address Lookup Table ;
- simulation RPC sans vérification de signature et sans envoi ;
- preuve durable versionnée, bornée et non signable ;
- reprise après crash et perte d'accusé PostgreSQL.

### 2.2 Exclus

- BUY PumpSwap ;
- Raydium CPMM dans le chemin executor ;
- wrap/unwrap ajouté par le projet hors instructions exactes du SDK PumpSwap ;
- Address Lookup Tables ;
- priorité dynamique, Jito, bundle ou transaction durable nonce ;
- retry global, quota provider durable, sizing et exposition, réservés à #51-E ;
- preflight/armement, réservés à #51-F ;
- clé privée, signature et soumission, réservées à #51-G ;
- activation automatique d'un mode live.

Le compte public d'exécution doit être financé en SOL natif pour les frais, la
rent et le plafond BUY, et détenir les base tokens nécessaires pour un SELL.
Les ATA requises sont présentes ou créées uniquement par les instructions
officielles auditées. Pour la paire SOL du protocole V2, le quote mint de
normalisation est WSOL `So11111111111111111111111111111111111111112`, tandis
que le BUY Pump.fun débite du SOL natif selon l'instruction officielle. Cette
politique ne transforme pas le domaine en domaine SOL-only.

## 3. Sources normatives

Les instructions et comptes sont dérivés des artefacts officiels épinglés et
des IDL publiques, jamais de discriminators tiers :

- `@pump-fun/pump-sdk` 1.36.0 ;
- `@pump-fun/pump-swap-sdk` 1.19.0 ;
- [BUY V2 Pump.fun](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/BUY.md) ;
- [SELL V2 Pump.fun](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/SELL.md) ;
- [IDL Pump.fun](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json) ;
- [documentation PumpSwap](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md) ;
- [IDL PumpSwap](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.ts) ;
- [programme de frais Pump](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md) ;
- [simulateTransaction Solana](https://solana.com/docs/rpc/http/simulatetransaction).

Les versions npm restent exactes dans `package-lock.json`. Un changement de
SDK impose une nouvelle version de cette spécification et la régénération des
fixtures d'instructions.

## 4. Frontières de capacité

Le graphe `simulation-only` est distinct du listener, du paper trading et de
`src/execution` historique. Il autorise seulement :

- domaine et ports executor explicitement listés ;
- repositories PostgreSQL executor ;
- adaptateurs Pump.fun/PumpSwap audités ;
- un gateway RPC étroit ;
- `PublicKey`, `TransactionInstruction`, `TransactionMessage`,
  `VersionedTransaction` et les primitives de décodage SPL.

Il interdit dans les sources **et** dans `dist` :

- `Keypair`, `Signer`, wallet ou secret loader ;
- variables privées, fichier de keypair ou secret PostgreSQL ;
- `.sign`, `signTransaction`, `signAllTransactions`, `signMessage` ;
- `sendTransaction`, `sendRawTransaction`, `sendAndConfirmTransaction` ;
- toute méthode nommée `send*`, `submit*` ou équivalent calculé ;
- import de l'ancien `src/execution`, du builder Raydium ou du listener ;
- import dynamique, `require`, `eval`, `Function` ou acquisition réflexive
  d'une capacité interdite.

`simulateTransaction` n'est autorisé que dans un adaptateur audité. Le port RPC
n'expose aucune méthode d'envoi. Une `Connection` complète ne traverse jamais
le port.

## 5. Configuration

Le parseur conserve `dry-run` et ajoute :

```dotenv
EXECUTOR_MODE=simulation-only
EXECUTOR_PUBLIC_KEY=
EXECUTOR_RPC_PROVIDER_ID=primary
SOLANA_HTTP_RPC_URL=
SOLANA_EXPECTED_GENESIS_HASH=
EXECUTOR_QUOTE_MAX_AGE_MS=3000
EXECUTOR_SNAPSHOT_MAX_SLOT_LAG=8
EXECUTOR_MAX_COMPUTE_UNITS=300000
EXECUTOR_MAX_FEE_LAMPORTS=100000
EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT=2500000
EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS=0
EXECUTOR_RPC_TIMEOUT_MS=5000
EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT=8
LIVE_QUOTE_MINT_ALLOWLIST=So11111111111111111111111111111111111111112
LIVE_TRADING_ENABLED=false
```

Les seuils sont des entiers décimaux canoniques, bornés et fingerprintés. Les
valeurs exactes ci-dessus sont des valeurs de développement, pas une validation
Mainnet. Une valeur privée non vide reste rejetée quel que soit le mode.

`EXECUTOR_PUBLIC_KEY` est une adresse publique uniquement. L'URL RPC peut
contenir un credential opérateur mais n'est jamais journalisée, persistée ou
incluse dans une erreur publique. `EXECUTOR_RPC_PROVIDER_ID` est positionnel et
public.

## 6. Provider, causalité et budget RPC

Une tentative utilise exactement un provider :

- aucun failover au milieu de quote → build → simulation ;
- aucun retry automatique en #51-D ;
- timeout et nombre d'appels bornés ;
- le premier appel vérifie `getGenesisHash` contre la valeur attendue ;
- un 429, timeout, transport indisponible ou réponse malformée échoue
  fail-closed avec un code normalisé ;
- les erreurs programmes déterministes ne sont jamais retryées.

Toutes les données nécessaires à une venue sont lues par un seul
`getMultipleAccountsInfoAndContext` à commitment `confirmed`. Les comptes
partagent donc un `context.slot`. `getLatestBlockhashAndContext`,
`getFeeForMessage` et la simulation utilisent `minContextSlot=snapshotSlot` à
commitment `confirmed`. Le gateway conserve leur contexte et exige :

```text
snapshotSlot <= blockhashContextSlot <= simulationSlot
blockhashContextSlot - snapshotSlot <= EXECUTOR_SNAPSHOT_MAX_SLOT_LAG
feeContextSlot >= snapshotSlot
```

Un slot RPC est converti en `bigint` immédiatement.

Le budget compte chaque appel dispatché, succès ou échec. Son usage et sa
limite sont persistés. La réservation durable de quota et la priorité des
sorties appartiennent à #51-E.

## 7. Sélection de venue

### 7.1 BUY

Un BUY V1 exige `venuePolicy=PUMP_FUN_ONLY`. La bonding curve doit exister,
être détenue par le programme officiel et avoir `complete=false`.

### 7.2 SELL

Avec `venuePolicy=CANONICAL_EXIT` :

1. si la bonding curve canonique est active, la venue est Pump.fun ;
2. si elle est complète, un pool PumpSwap n'est accepté qu'avec une migration
   durable non orphaned et un `market_pool` actif cohérent ;
3. le pool relu on-chain doit avoir index 0, `baseMint=intent.mint`,
   `quoteMint=WSOL` en V1, l'orientation base→quote, les mêmes token programs et
   vaults, et `creator=pumpPoolAuthorityPda(baseMint)[0]` ;
4. son adresse doit être le PDA attendu pour ces valeurs et sa migration doit
   référencer ce même pool ;
5. toute ambiguïté produit `VENUE_UNAVAILABLE`.

Le choix appartient à la tentative. Il ne modifie pas l'identité de
l'intention.

## 8. Quote fraîche

Le port retourne un DTO gelé `ExecutionQuoteV1`, sans classe SDK :

```text
payloadVersion
venue
providerId
mint / quoteMint
baseTokenProgram / quoteTokenProgram / quoteDecimals
side
amountInRaw / expectedAmountOutRaw / protectedAmountOutRaw
feesRaw / slippageBps
snapshotSlot / observedAtMs / expiresAtMs
snapshotFingerprint / quoteFingerprint
```

Tous les montants, réserves, frais, bps et slots sont des `bigint`. Les dates
sont des entiers sûrs en millisecondes. Aucun montant financier n'est converti
en float JavaScript.

La quote vérifie :

- quote mint, token program et décimales identiques à l'intention ;
- bonding curve legacy avec `quoteMint=PublicKey.default` normalisée en WSOL
  avant comparaison, allowlist et build ; le System Program n'est jamais un
  quote mint ;
- allowlist opérationnelle exacte WSOL + SPL Token + 9 décimales ;
- réserves et frais dynamiques issus de la même snapshot ;
- PumpSwap avec
  `effectiveQuoteReserves = quoteVaultAmount + virtualQuoteReserves` ;
- quantité d'entrée égale à celle de l'intention ;
- résultat positif et borné par u64 ;
- âge au build et à la simulation inférieur ou égal au plafond ;
- lag de slot inférieur ou égal au plafond ;
- limite finale de sortie égale au maximum de
  `intent.minimumAmountOutRaw` et de la limite de la quote fraîche.

Si cette limite finale dépasse la sortie attendue, la tentative échoue avec
`MINIMUM_AMOUNT_OUT_VIOLATED`.

Après un BUY, une quote inverse SELL complète sur la même snapshot est
obligatoire. Elle couvre la quantité base attendue entière et prouve seulement
que le calcul de sortie est disponible à cet instant.

## 9. Token Program et extensions

Le propriétaire du mint détermine SPL Token ou Token-2022. Pour Token-2022,
les TLV sont décodées et comparées à une allowlist versionnée. La V1 accepte
uniquement les extensions déjà validées par le détecteur de pool :

- MintCloseAuthority ;
- MetadataPointer et TokenMetadata ;
- GroupPointer et TokenGroup ;
- GroupMemberPointer et TokenGroupMember.

TransferFee, TransferHook, ConfidentialTransfer, NonTransferable,
DefaultAccountState, PermanentDelegate et toute extension inconnue sont
refusées avec `UNSUPPORTED_TOKEN_EXTENSION`.

## 10. Build logique et instruction officielle

Le builder produit d'abord un `UnsignedBuildPlanV1` éphémère. Il utilise :

- Pump.fun `getBuyV2InstructionRaw` / `getSellV2InstructionRaw` avec des `BN`
  construits depuis des `bigint` décimaux ;
- PumpSwap `sellInstructions` avec `baseAmountIn` et `minQuoteAmountOut`
  exacts ;
- aucun helper prenant un slippage `number`.

Pour Pump.fun, les recipients de frais et de buyback sont choisis de façon
déterministe à partir du fingerprint de quote parmi les listes officielles
décodées on-chain, puis injectés dans les builders raw. Pour PumpSwap, l'API
1.19.0 sélectionne elle-même ses recipients ; l'inspecteur exige après build
leur appartenance exacte à la liste on-chain normal/reserved correspondant au
mode et à la liste buyback. Le fingerprint couvre les recipients effectivement
produits. Une liste vide ou un recipient hors liste échoue fail-closed ; aucune
adresse recopiée d'une source tierce n'est admise.

Le plan contient les instructions, fee payer attendu, snapshot et limites,
mais n'est jamais persisté. Avant compilation, l'inspecteur reconstruit et
vérifie :

- programme, discriminator et ordre des instructions ;
- fee payer et unique signer requis égaux à `EXECUTOR_PUBLIC_KEY` ;
- mint, quote mint, bonding curve ou pool canonique ;
- token programs, ATA, vaults, autorités et destinataires ;
- comptes cashback/user-volume, `poolV2` lorsque `coinCreator` n'est pas la clé
  par défaut, buyback recipient + ATA, et recipient normal/reserved selon
  mayhem ;
- flags signer/writable exacts ;
- montant entrant, plafond BUY ou minimum SELL encodé ;
- absence d'ALT, de priority fee non nulle et d'instruction inconnue ;
- taille sérialisée sous la limite Solana ;
- débit maximal et frais estimés sous les plafonds.

Les créations d'ATA idempotentes produites par le SDK sont autorisées seulement
pour les ATA attendues. Pour un SELL PumpSwap WSOL, le `CloseAccount` terminal
exact produit par le SDK 1.19.0 est autorisé et inspecté : il unwrap les
proceeds et tout solde WSOL préexistant de cette ATA vers le compte public
d'exécution. Aucun autre wrap, `SyncNative`, close ou transfert auxiliaire
n'est admis. Pump.fun raw ne crée aucune ATA ; une création éventuelle doit
être un préfixe ATA idempotent construit et inspecté séparément. Toute sortie
SDK non conforme produit `BUILD_POLICY_REJECTED`.

## 11. Message et blockhash

Après inspection seulement, le gateway :

1. obtient via `getLatestBlockhashAndContext` un blockhash récent,
   `lastValidBlockHeight` et `blockhashContextSlot` du provider épinglé ;
2. compile un message v0 sans Address Lookup Table ;
3. vérifie à nouveau le header, la liste des comptes et l'unique signer ;
4. calcule le hash SHA-256 du message ;
5. construit une `VersionedTransaction` avec exactement une signature de 64
   octets à zéro pour l'unique signer requis ;
6. ne retourne ni l'objet transaction, ni le message, ni leurs bytes.

Le blockhash, la dernière hauteur valide et le hash du message peuvent être
persistés ; ils ne permettent pas de reconstruire le message. Les bytes du
message, de la transaction ou des instructions ne le sont jamais.

## 12. Simulation

La simulation utilise exactement :

```text
commitment = confirmed
encoding = base64
sigVerify = false
replaceRecentBlockhash = false
minContextSlot = snapshotSlot
innerInstructions = true
```

Le blockhash explicite rend la simulation fidèle au message hashé. Une erreur
`BlockhashNotFound` échoue ; elle ne déclenche pas un remplacement silencieux.
Cette décision diffère des exemples génériques qui utilisent
`replaceRecentBlockhash=true`, car #51-D doit lier la preuve au blockhash et au
message exacts. `sigVerify=false` reste obligatoire et est incompatible avec
toute prétention de preuve cryptographique.

Le résultat vérifie :

- `context.slot >= blockhashContextSlot >= snapshotSlot` et fee context au
  moins égal à la snapshot ;
- `err === null` ;
- unités consommées présentes, entières et sous plafond ;
- fee estimée présente, entière et sous plafond ;
- compte fee payer et comptes token observés avant/après, avec débit lamports
  du fee payer sous le plafond et deltas token cohérents avec le côté ;
- programmes internes et comptes retournés bornés et attendus ;
- minimum out protégé par l'instruction ;
- quote et intention non expirées à la fin de l'appel ;
- aucun contenu provider non borné.

Les logs bruts ne sont pas persistés. Seuls un fingerprint, le nombre de lignes
et des codes normalisés sont conservés. Les URLs, headers et messages d'erreur
provider sont supprimés.

## 13. Artefact durable

La migration 033 crée `execution_simulation_artifacts`, append-only, unique par
`(intent_id, attempt_number)` et référencée à la tentative. Payload V1 :

```text
artifact_id / payload_version / specification_version / evaluator_version
intent_id / attempt_number / intent_state_revision
strategy_id / strategy_version / decision_fingerprint
effective_venue / provider_id / executor_public_key
expected_genesis_hash / observed_genesis_hash / configuration_fingerprint
quote_fingerprint / snapshot_fingerprint / build_fingerprint
message_hash / blockhash / last_valid_block_height / blockhash_context_slot
snapshot_slot / fee_context_slot / simulation_slot
amount_in_raw / expected_amount_out_raw / protected_amount_out_raw / fees_raw
estimated_fee_lamports / simulated_fee_payer_lamport_debit / units_consumed
simulated_base_delta_raw / simulated_quote_delta_raw
rpc_calls_used / rpc_calls_limit
quote_status / build_status / simulation_status
failure_stage / failure_code
terminal_reason_code / logs_fingerprint / logs_line_count
result_fingerprint / recorded_at
```

Les identités et fingerprints utilisent SHA-256 sur des segments UTF-8
préfixés par leur longueur u32 big-endian :

```text
artifactId = "execution_simulation_artifact_" + sha256(
  "execution-simulation-artifact-id-v1", intentId, attemptNumber
)
configurationFingerprint = sha256(
  "execution-simulation-config-v1", specificationVersion, evaluatorVersion,
  providerId, executorPublicKey, expectedGenesisHash, allowlist triée,
  tous les plafonds numériques
)
snapshotFingerprint = sha256(
  "execution-snapshot-v1", snapshotSlot,
  chaque compte dans l'ordre demandé: address, owner, lamports, sha256(data)
)
quoteFingerprint = sha256("execution-quote-v1", tous les champs de quote)
buildFingerprint = sha256(
  "execution-build-v1", feePayer, chaque instruction dans l'ordre:
  programId, metas ordonnées, sha256(data)
)
messageHash = sha256(bytes exacts du message v0)
resultFingerprint = sha256(
  "execution-simulation-result-v1", tous les champs persistés sauf
  artifactId, resultFingerprint et recordedAt
)
```

La matrice SQL de nullabilité et de statuts est fermée :

| Résultat | quote/build/simulation | Champs obligatoires supplémentaires | Champs obligatoirement nuls | Reason code terminal |
| --- | --- | --- | --- | --- |
| `PROVIDER_FAILED` avant snapshot | `FAILED/NOT_RUN/NOT_RUN` | identité, config, genesis disponible, RPC usage, failure | tous les champs quote/build/blockhash/fee/simulation | `GENESIS_MISMATCH`, `EXECUTION_PROVIDER_FAILED` ou `EXECUTION_EVIDENCE_INVALID` |
| `QUOTE_FAILED` | `FAILED/NOT_RUN/NOT_RUN` | identité, config, genesis, snapshot si obtenue, RPC usage, failure | build, message, blockhash, fee et simulation | code quote spécifique ou `EXECUTION_PROVIDER_FAILED`/`EXECUTION_EVIDENCE_INVALID` |
| `BUILD_FAILED` | `SUCCEEDED/FAILED/NOT_RUN` | quote et snapshot complets, failure | message, blockhash, fee et simulation | `EXECUTION_BUILD_FAILED` ou `EXECUTION_EVIDENCE_INVALID` |
| `BLOCKHASH_FAILED` | `SUCCEEDED/SUCCEEDED/NOT_RUN` | quote/build complets, failure | message, blockhash, fee et simulation | `EXECUTION_PROVIDER_FAILED` ou `EXECUTION_EVIDENCE_INVALID` |
| `FEE_FAILED` | `SUCCEEDED/SUCCEEDED/NOT_RUN` | blockhash, hauteur, contexte et message hash, failure | fee et simulation | `EXECUTION_PROVIDER_FAILED` ou `EXECUTION_EVIDENCE_INVALID` |
| `SIMULATION_FAILED` | `SUCCEEDED/SUCCEEDED/FAILED` | blockhash/message/fee complets ; contexte/logs/units/deltas seulement s'ils existent dans une réponse validée | uniquement les mesures absentes de la réponse | `BUY_SIMULATION_FAILED`, `SELL_SIMULATION_FAILED`, `EXECUTION_PROVIDER_FAILED` ou `EXECUTION_EVIDENCE_INVALID` |
| `SUCCESS` | `SUCCEEDED/SUCCEEDED/SUCCEEDED` | tous les champs, failure stage/code nuls, logs fingerprint/count | aucun champ de preuve | `INTENT_SUCCEEDED` |

Les montants quote sont présents dès que `quote_status=SUCCEEDED`. Les champs
genesis sont présents après une vérification réussie ; lors d'un mismatch,
attendu et observé sont tous deux présents. `OPERATION_ABORTED` authentifié par
le signal et les erreurs PostgreSQL ne terminalisent pas : ils ne créent donc
aucun artefact d'échec.

Les valeurs numériques financières sont des `NUMERIC` non typés, transportés
en chaînes décimales et contraints par `scale(value)=0`, `value=trunc(value)`,
`value <> NaN` et les bornes du domaine. `NUMERIC(p,0)` est interdit car
PostgreSQL pourrait arrondir une fraction avant le `CHECK`. Les slots et
hauteurs sont `BIGINT` non négatifs. Les enums et cohérences succès/échec sont
protégés par contraintes SQL.

Sont interdits dans cette table : bytes de transaction/message/instruction,
signature, secret, URL, header RPC, logs bruts, payload SDK et JSON opaque.

## 14. Commit, crash et idempotence

Le résultat est appliqué par une opération PostgreSQL atomique qui :

- fence id, statut `PROCESSING`, lease owner/token, expiration, révision et
  champs immuables ;
- exige la tentative `STARTED` courante ;
- insère exactement un artefact déterministe ;
- termine la tentative en `COMPLETED` ou `ABANDONED` ;
- journalise et applique `PROCESSING -> SIMULATED` ou `PROCESSING -> FAILED` ;
- pour un succès, journalise et applique aussi `SIMULATED -> SUCCEEDED` dans la
  même transaction ;
- libère le lease et pose exactement
  `terminal_at=reconciliation_completed_at=commit_at` puis
  `purge_after=commit_at + 4 heures`. Cette égalité est la preuve SQL qu'aucun
  effet on-chain n'était possible dans un graphe sans méthode d'envoi.

Une perte d'ACK produit `COMMIT_OUTCOME_UNKNOWN`. Le worker lit l'artefact exact :

- même identité et mêmes fingerprints : `COMMIT_RECOVERED` ;
- absent : la tentative reste récupérable après expiration du lease ;
- différent : `ARTIFACT_CONFLICT`, fail-closed.

Avant le commit, un crash ne crée aucun effet on-chain et peut refaire quote,
build et simulation. Après le commit, l'intention terminale n'est plus
réclamable. Aucun timeout RPC ne crée une ambiguïté de soumission car aucune
méthode d'envoi n'existe dans le graphe.

## 15. Erreurs stables

Les reason codes métier réutilisés sont :

- `QUOTE_STALE` ;
- `QUOTE_MINT_NOT_ALLOWED` ;
- `VENUE_UNAVAILABLE` ;
- `SELL_QUOTE_UNAVAILABLE` ;
- `MINIMUM_AMOUNT_OUT_VIOLATED` ;
- `UNSUPPORTED_TOKEN_EXTENSION` ;
- `BUY_SIMULATION_FAILED` ;
- `SELL_SIMULATION_FAILED` ;
- `GENESIS_MISMATCH` ;
- `EXECUTION_PROVIDER_FAILED` ;
- `EXECUTION_BUILD_FAILED` ;
- `EXECUTION_EVIDENCE_INVALID`.

Les trois derniers codes sont ajoutés de façon append-only au domaine V1 et
aux contraintes SQL des intentions, tentatives et transitions par la migration
033. Ils ne sont jamais réaffectés à une autre signification.

Les erreurs techniques internes sont fermées :

```text
INVALID_INPUT
INVALID_DATA
QUOTE_REJECTED
BUILD_POLICY_REJECTED
RPC_RATE_LIMITED
RPC_TIMEOUT
RPC_UNAVAILABLE
RPC_RESPONSE_INVALID
SIMULATION_EVIDENCE_INVALID
SIMULATION_PROGRAM_ERROR
INTENT_FENCE_LOST
ARTIFACT_CONFLICT
COMMIT_OUTCOME_UNKNOWN
DATABASE_FAILURE
OPERATION_ABORTED
```

Un message dynamique de provider n'est jamais utilisé comme code, preuve ou
log.

La traduction terminale est normative :

| Failure interne | Reason code |
| --- | --- |
| `RPC_RATE_LIMITED`, `RPC_TIMEOUT`, `RPC_UNAVAILABLE` | `EXECUTION_PROVIDER_FAILED` |
| `RPC_RESPONSE_INVALID`, `SIMULATION_EVIDENCE_INVALID`, `INVALID_DATA` provenant d'une réponse externe | `EXECUTION_EVIDENCE_INVALID` |
| `BUILD_POLICY_REJECTED` | `EXECUTION_BUILD_FAILED` |
| `SIMULATION_PROGRAM_ERROR` pendant un BUY | `BUY_SIMULATION_FAILED` |
| `SIMULATION_PROGRAM_ERROR` pendant un SELL | `SELL_SIMULATION_FAILED` |
| genesis différent | `GENESIS_MISMATCH` |
| quote expirée / mint / venue / sortie / extension | reason code quote spécifique listé ci-dessus |

`INVALID_INPUT`, `INTENT_FENCE_LOST`, `ARTIFACT_CONFLICT`,
`COMMIT_OUTCOME_UNKNOWN`, `DATABASE_FAILURE` et `OPERATION_ABORTED` ne sont pas
rabattus sur un faux échec de marché. Ils interrompent la passe ou déclenchent
la récupération durable prévue.

## 16. Rétention

Les artefacts sont purgés dans la cohorte terminale, avant leur intention :

```text
execution_simulation_artifacts
  -> execution_dry_run_assessments
  -> execution_intent_transitions
  -> execution_attempts
  -> execution_intents
```

La purge n'a lieu qu'après quatre heures et après cohérence terminale. Le
tombstone anti-rejeu minimal reste permanent. `ON DELETE CASCADE` est une
défense supplémentaire, pas le mécanisme de cohorte.

## 17. Tests obligatoires

### Domaine et math

- vecteurs déterministes et fingerprints ;
- BUY/SELL, deux venues, u64 max et valeurs au-delà de 2^53 ;
- limite de sortie la plus protectrice et bornes de fraîcheur ;
- quote inverse complète après BUY ;
- réserves effectives PumpSwap et frais dynamiques ;
- WSOL autorisé, autre quote refusée sans coupler le domaine ;
- SPL Token et extensions Token-2022 acceptées/refusées.

### Build et simulation

- fixtures assainies BUY/SELL Pump.fun V2 et SELL PumpSwap ;
- décodage de chaque instruction et de chaque compte meta ;
- fee payer, unique signer, programmes, mints, vaults et min/max exacts ;
- SDK hostile, instruction/comptes/writable/signer supplémentaires refusés ;
- transaction trop grande et ALT refusées ;
- blockhash, minContextSlot et config de simulation exacts ;
- succès, erreur programme, blockhash expiré, 429, timeout et réponse hostile ;
- unités, fee, logs et résultats bornés.

### Persistance et reprise

- migration 033 sur base vide, upgrade 032 et replay ;
- contraintes SQL hostiles et valeurs maximales ;
- claim concurrent, lease perdu, ABA et crash à chaque frontière ;
- commit atomique, perte d'ACK, reprise exacte et conflit ;
- cohorte de purge et tombstone conservé.

### Architecture et processus

- graphe source et `dist` sans secret, keypair, signer ou send/submit ;
- `simulateTransaction` présent dans un seul adaptateur ;
- aucun import `src/execution`, Raydium, listener ou paper ;
- exécutable compilé avec PostgreSQL, RPC scripté et clé publique seulement ;
- `dry-run` inchangé et `simulation-only` inerte sans sélection explicite ;
- aucune suite automatisée ne contacte un endpoint Mainnet réel.

## 18. Critères d'acceptation

- build, check, lint, docs et tests complets verts ;
- migrations base vide, upgrade et replay verts ;
- les trois fixtures obligatoires réussissent sans envoi ;
- la preuve durable ne contient aucun artefact signable ;
- les erreurs et logs ne révèlent aucune URL ou donnée provider ;
- aucun secret n'est requis ou accepté ;
- aucun chemin d'envoi n'est importable depuis le processus #51-D ;
- une intention réussie est terminale et explicitement étiquetée
  `simulation-only` ;
- README et architecture disent que #49 reste sauté et que #51-E à #51-G
  restent nécessaires avant toute transaction réelle.

## 19. Décisions opérateur différées

Les valeurs Mainnet de provider, compte public d'exécution, fraîcheur, compute,
fees et budget RPC devront être fournies et qualifiées avant le preflight #51-F. Leur
absence n'empêche pas les tests déterministes de #51-D et n'autorise aucun
choix implicite de production.
