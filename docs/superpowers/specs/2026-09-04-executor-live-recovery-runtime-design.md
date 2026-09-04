# Runtime live de finalité en lecture seule — conception #51-H2a

**Version de spécification :** 1.1.4

**Version de la spécification parente :** 1.9.4

**Version de l'orchestration persistante :** 1.1.3

**Date :** 2026-09-04

**Statut :** APPROUVÉ — recommandation V1 appliquée conformément à la décision
opérateur de poursuivre les choix recommandés sans pause intermédiaire.

## Historique des versions

- **1.1.4 — 2026-09-04 :** accepte le champ standard optionnel `apiVersion`
  dans `RpcResponseContext` tout en exigeant une chaîne et en refusant tout
  autre champ inconnu. Les lectures de finalité restent strictes et bornées.
- **1.1.3 — 2026-09-04 :** ferme l'autorité effective sur tous les schémas
  non système. Les objets sont identifiés avec leur schéma, le provisioning
  révoque les anciens grants hors `public` et le démarrage refuse tout droit,
  ownership ou `GRANT OPTION` résiduel hors de l'allowlist qualifiée.
- **1.1.2 — 2026-09-04 :** inclut dans l'allowlist `SELECT` les colonnes que
  les triggers `SECURITY INVOKER` de confirmation et de résolution lisent au
  commit. Cette autorité transitive explicite permet les écritures H2a prévues
  sans droit de table, sans bytes signés et sans capacité de soumission. Le
  checkout fixe aussi `search_path=pg_catalog,public`, le démarrage refuse tout
  droit ou ownership direct du login et toute routine `SECURITY DEFINER`
  exécutable hors schémas système. Il exige enfin que les deux helpers
  `SECURITY INVOKER` du ledger restent exécutables, refuse tout privilège
  `SET` sur `session_replication_role` et vérifie sa valeur `origin` à chaque
  checkout. L'allowlist distingue enfin un privilège simple de son `GRANT
  OPTION` et refuse toute capacité de redélégation.
- **1.1.1 — 2026-09-04 :** ferme le graphe d'appartenance PostgreSQL 16 :
  l'unique arête directe du login est `WITH ADMIN FALSE, INHERIT FALSE, SET
  TRUE` vers recovery et recovery n'est membre d'aucun rôle parent. Elle rend
  aussi normative l'allowlist effective complète des tables, colonnes et
  séquences ; tout privilège supplémentaire, y compris reçu de `PUBLIC`, par
  ownership ou membership, fait échouer le démarrage. La signature publique
  reste lisible pour la finalité, seules ses mutations sont interdites.
- **1.1.0 — 2026-09-04 :** isole l'autorité PostgreSQL de H2a dans le rôle de
  groupe dédié `sol_token_executor_live_recovery`. Un login de déploiement
  externe, sans héritage et sans privilège direct, obtient ce rôle exact ;
  chaque checkout exécute et vérifie `SET ROLE` avant d'exposer le client. Les
  ACL de colonnes interdisent notamment `signed_transaction_bytes` et les
  mutations de signature, simulation signée, préflight ou soumission. Le
  runtime ne reçoit que des façades gelées à prototype nul et aux méthodes
  exactes de finalité. Cette défense en profondeur remplace l'hypothèse
  insuffisante selon laquelle un `Pick<>` TypeScript réduirait l'objet à
  l'exécution.
- **1.0.9 — 2026-09-04 :** rend le report de lane typé et gelé : un résultat
  `DEFERRED` associe toujours sa `lane` à un `errorCode` RPC retryable
  explicitement allowlisté (`RPC_RATE_LIMITED`, `RPC_TIMEOUT`,
  `RPC_UNAVAILABLE`, `RPC_RESPONSE_TOO_LARGE`, `RPC_RESPONSE_INVALID`,
  `CALL_BUDGET_EXCEEDED` ou `SESSION_FAILED`), ou à `null`. `NOT_FOUND` reste sans code et
  laisse l'échéance continuer. Les finalités `UNKNOWN` ou incohérentes restent
  fermées, tandis que `CONFIRMED` et `FINALIZED` exigent un slot `bigint` non négatif ; toute violation produit `GATEWAY_FAILED`. Les logs n'exposent ni message, ni URL, ni signature.
- **1.0.8 — 2026-09-04 :** durcit le contrat `getTransaction` base64
  finalized : la réponse reconnaît les champs officiels `version` et `meta`,
  dont les balances Token-2022 avec `programId`, sans accepter de forme
  inconnue. Pour une transaction v0, les clés de compte sont les clés statiques
  suivies des adresses chargées writable puis readonly ; les cardinalités
  déclarées doivent correspondre aux index des LUT du message, les index de
  balance token restent des u8 et une identité owner/mint ne peut pas changer
  entre pré- et post-balance au même index. Le timeout et l'abort couvrent la
  lecture complète du corps et le parsing ; les sorties HTTP avant corps
  annulent le corps au mieux. Le flux reste borné à 16 MiB sans rétention de
  chunks et son UTF-8 est décodé fatalement. Ces contrôles refusent une réponse
  invalide ; ils ne constituent ni une lecture de compte supplémentaire ni une
  capacité de signature ou de soumission.
- **1.0.7 — 2026-09-04 :** `recordConfirmation` libère atomiquement la lease
  dans sa transition durable ; la lane ne fait donc aucun `release` après un
  commit réussi. Un replay exact accepte la lease déjà nulle ou la même lease.
- **1.0.6 — 2026-09-04 :** ferme la récupération de plusieurs preuves SELL
  non terminales consécutives : le commit libère la lease même lorsque l'état
  était déjà `UNKNOWN_REQUIRES_RECONCILIATION`.
- **1.0.5 — 2026-09-04 :** aligne les noms de configuration sur les contrats
  executor déjà publiés et impose une seule session RPC neuve par passe,
  partagée par toutes les lanes. Le budget d'appels et la mémoïsation de la
  transaction finalized sont ainsi réellement communs à la passe.
- **1.0.4 — 2026-09-04 :** précise la discipline des claims entre lanes :
  chaque appel réseau est encadré par des renouvellements et utilise le claim
  actif le plus récent ; confirmation libère son claim après commit ou report,
  tandis que chaque résultat de réconciliation libère atomiquement sa lease.
  Un travail différé ne peut donc pas affamer la lane d'échéance suivante.
- **1.0.3 — 2026-09-04 :** précise la frontière des bytes : H2a ne lit jamais
  les bytes privés persistés avant soumission, mais désérialise éphémèrement la
  transaction publique retournée par `getTransaction` finalized afin de
  vérifier exactement signature, blockhash et hash du message. Le gateway
  impose timeout, abort, budget, taille et parsing fermés.
- **1.0.2 — 2026-09-04 :** ferme deux frontières découvertes à l'audit : les
  commits de finalité retournent une référence d'artefact sans bytes et leurs
  requêtes ne sélectionnent jamais les bytes signés ; l'observation RPC de la
  transaction contient seulement signature, blockhash et hash du message.
  Les fingerprints build/snapshot sont rattachés explicitement depuis la
  lignée durable, sans être présentés comme observables on-chain.
- **1.0.1 — 2026-09-04 :** limite les bindings de démarrage à ceux qui
  déterminent réellement la finalité : génération, wallet, cluster, genesis
  et provider. Les fingerprints build/configuration/stratégie historiques
  restent validés par les read-models durables ; les épingler au binaire H2a
  empêcherait à tort de finaliser un ordre ancien après un déploiement.
- **1.0.0 — 2026-09-04 :** sépare la composition live en deux capacités. H2a
  publie un runtime de finalité strictement incapable de signer ou soumettre ;
  H2b restera propriétaire de la reprise signée et des lanes d'exécution.

## 1. But et frontière

#51-H2a rend exécutables les traitements sans dépense déjà fermés par #51-H1 :

```text
PostgreSQL
  ├─ RECONCILE -> lectures RPC finalized -> preuve durable
  ├─ CONFIRM   -> lecture du statut de signature -> preuve durable
  └─ échéance  -> intention SELL déterministe en PostgreSQL
```

Le processus est publié sous une commande distincte
`executor:live:recovery:start`. Ce nom décrit une récupération de finalité, pas
une capacité d'exécution. L'état livré est :

```text
LIVE_RECOVERY_RUNTIME_COMPOSED
LIVE_EXECUTION_RUNTIME_NOT_COMPOSED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```

Le runtime H2a n'importe ni keypair loader, ni signer, ni transaction signée privée,
ni simulation signée, ni transport de soumission. Il n'appelle jamais
`beginSubmission`, `sendRawTransaction`, `LIVE_EXECUTE` ou `LIVE_RECOVER`.
Il ne lit jamais la colonne PostgreSQL `signed_transaction_bytes`.

## 2. Approches étudiées

### 2.1 Composer immédiatement tout le live

Relier dans la même PR le secret, la signature, la reprise, les cinq lanes et
le transport rendrait difficile la preuve qu'une voie de finalité ne peut pas
dépenser. Cette approche est différée à H2b.

### 2.2 Réutiliser le gateway live combiné avec un transport inerte

Un objet qui expose `sendRawTransaction`, même injecté avec une implémentation
inerte, élargit inutilement le graphe d'autorité. Une erreur d'injection ou un
appel après `beginSubmission` créerait un état ambigu sans envoi réel. Approche
rejetée.

### 2.3 Runtime finalité à ports étroits — retenue puis durcie

H2a compose uniquement des ports RPC de lecture et des façades PostgreSQL
minimales. Les tests d'architecture inspectent le graphe source et compilé.
H2b ajoutera plus tard un exécutable séparé pour la reprise et l'exécution
signables.

### 2.4 Réutiliser `sol_token_executor_live` avec un simple `Pick<>` — rejetée

Le rôle live possède volontairement les pouvoirs nécessaires à H2b. Un
`Pick<>` disparaît à l'exécution et une instance complète de repository garde
ses méthodes signables. Réutiliser ce rôle ne constitue donc pas une frontière
d'autorité.

### 2.5 Dupliquer tous les repositories de finalité — différée

Réécrire immédiatement toutes les requêtes H1 fournirait une séparation
lexicale maximale, mais dupliquerait une logique transactionnelle déjà revue
et augmenterait le risque de divergence. H2a peut instancier ces repositories
derrière son module de composition privé, mais seul un client SQL restreint
leur est injecté et seules des façades exactes sont exportées. PostgreSQL reste
la frontière d'autorité effective. Une extraction ultérieure de repositories
dédiés pourra réduire encore le graphe sans changer le port.

### 2.6 Rôle recovery dédié, `SET ROLE`, ACL et façades — retenue

Le rôle de groupe `sol_token_executor_live_recovery` est `NOLOGIN`,
`NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION` et
`NOBYPASSRLS`. Le login de déploiement est créé hors dépôt, avec `LOGIN`,
`NOINHERIT`, les mêmes indicateurs privilégiés à faux, aucun privilège direct
et une appartenance exacte au seul rôle recovery. Sur PostgreSQL 16, cette
arête porte exactement `WITH ADMIN FALSE, INHERIT FALSE, SET TRUE` : le login
peut activer recovery mais n'en hérite pas et ne peut le déléguer. Recovery
n'est lui-même membre d'aucun autre rôle. Aucun mot de passe n'est versionné.

## 3. Invariants de sécurité

1. L'entrypoint et les façades accessibles au runtime H2a ne chargent aucun
   secret et n'exposent aucune méthode de signature ou de soumission.
2. Aucun claim H2a n'utilise `LIVE_EXECUTE` ou `LIVE_RECOVER`.
3. Une passe traite au plus une unité, dans l'ordre réconciliation,
   confirmation, échéance.
4. Les read-models proviennent exclusivement des claims atomiques H1.
5. Le provider du read-model est identique au provider RPC configuré.
6. La réconciliation utilise des lectures `finalized`; la confirmation est une
   observation et ne fabrique jamais un statut.
7. Le lease est renouvelé avant et après toute séquence RPC. Si le
   renouvellement échoue, aucune écriture métier n'est tentée.
8. Toute mutation revalide le claim dans le repository H1 avec l'heure
   PostgreSQL.
9. Le genesis hash est vérifié au démarrage avant le lancement des lanes.
10. Les slots, hauteurs, réserves, deltas et frais restent des `bigint`.
11. Une erreur RPC, un timeout, un 429 ou une réponse non canonique produit un
    résultat fermé et rejouable ; jamais une donnée synthétique.
12. Les logs ne contiennent ni URL RPC, ni signature, ni mint, ni montant, ni
    octets de transaction, ni secret.
13. Le démarrage ne modifie ni armement, ni contrôle, ni génération wallet.
14. Aucun endpoint HTTP public n'est ajouté.
15. Chaque client PostgreSQL est rendu au code applicatif uniquement après
    `SET ROLE sol_token_executor_live_recovery`, fixation de
    `search_path=pg_catalog,public` et vérification des deux valeurs ; un échec
    évince le client.
16. Le rôle recovery ne peut ni sélectionner `signed_transaction_bytes`, ni
    insérer une transaction signée, une preuve de simulation signée ou de
    préflight, ni initier une transition `SUBMISSION_STARTED`. Les événements
    durables de confirmation et réconciliation restent autorisés.
17. Les façades runtime ont un prototype nul, sont gelées et possèdent
    exactement les méthodes autorisées ; elles ne fuient ni pool, ni client,
    ni repository complet.

## 4. Configuration fermée

La configuration H2a est distincte de `LiveExecutorConfig`. Elle accepte
exactement les paramètres publics nécessaires :

- `EXECUTOR_LIVE_RECOVERY_ENABLED=true` ;
- `EXECUTOR_MODE=live` ;
- `SOLANA_CLUSTER=mainnet-beta` ;
- `DATABASE_URL` ;
- `EXECUTOR_RPC_PROVIDER_ID` ;
- `SOLANA_HTTP_RPC_URL` ;
- `SOLANA_EXPECTED_GENESIS_HASH` ;
- `EXECUTOR_WALLET_GENERATION_ID` ;
- `EXECUTOR_PUBLIC_KEY` ;
- `EXECUTOR_LIVE_RECOVERY_OWNER_ID` ;
- intervalles, timeouts, lease et budget d'appels bornés.

Les noms d'environnement liés aux secrets (`KEYPAIR`, `PRIVATE_KEY`,
`SECRET`) sont refusés s'ils sont présents, même vides. L'URL RPC est validée
mais jamais journalisée. Les clés inconnues du processus ne sont pas
interdites ; seul l'objet de configuration normalisé est fermé et immuable.

## 5. Validation de démarrage

L'ordre est obligatoire :

1. parser la configuration ;
2. ouvrir PostgreSQL avec des timeouts bornés ;
3. appliquer puis vérifier le rôle recovery sur le client courant ;
4. vérifier que l'historique de migrations correspond exactement au catalogue
   versionné jusqu'à `037_execution_live_orchestration.sql` ;
5. vérifier la génération wallet, le provider et l'absence de travail ouvert
   lié à une autre génération, un autre wallet ou un autre provider ;
6. créer le client RPC de lecture ;
7. vérifier le genesis hash ;
8. créer les lanes puis lancer la boucle.

Une divergence ferme le processus avant toute mutation métier. H2a n'applique
pas les migrations et ne provisionne pas les rôles au démarrage.

La connexion n'utilise pas un callback asynchrone `pool.on('connect')`, que
`EventEmitter` n'attend pas. Un wrapper de pool prend chaque client, exécute
statiquement `SET ROLE sol_token_executor_live_recovery`, fixe `search_path` à
`pg_catalog, public`, vérifie l'identité et ce chemin, puis seulement le
transmet au repository. En cas d'échec, le client est relâché comme défectueux
et n'est jamais exposé.

La validation exige simultanément :

- PostgreSQL 16 ou supérieur, afin que les options d'arête de membership soient
  observables et vérifiables ;
- `current_user = sol_token_executor_live_recovery` ;
- un `session_user` distinct, `LOGIN`, `NOINHERIT` et sans attribut privilégié ;
- le rôle cible `NOLOGIN`, `NOINHERIT` et sans attribut privilégié ;
- une appartenance directe et exacte du login au seul rôle recovery, avec
  `admin_option=false`, `inherit_option=false`, `set_option=true` ;
- aucune appartenance sortante de recovery vers un rôle parent ;
- aucun ACL, ownership ou privilège par défaut accordé directement au login de
  session sur les objets de la base ;
- aucun ACL de paramètre direct au login, ni privilège effectif `SET` sur
  `session_replication_role` pour le login ou recovery ; sa valeur effective
  doit rester `origin` ;
- aucune routine `SECURITY DEFINER` exécutable par recovery ou par le login
  hors de `pg_catalog` et `information_schema` ;
- `execution_live_state_transition_allowed(text,text,text)` et
  `execution_submission_event_matches_transition(text,text,text)` existent,
  restent `SECURITY INVOKER` et sont exécutables par recovery ;
- l'allowlist effective exacte décrite ci-dessous, en tenant compte de
  `PUBLIC`, de l'ownership et des memberships ; aucun privilège autorisé ne
  peut porter `WITH GRANT OPTION`. Le scan couvre tous les schémas non système,
  avec des identités de relation qualifiées ; seul `public` peut contenir les
  droits listés ci-dessous.

Le nom du login de session est une donnée de déploiement privée : il est
comparé dans PostgreSQL mais n'est jamais renvoyé dans l'évidence ni journalisé.

### 5.1 Matrice normative des ACL effectives

Toutes les autorisations de relations sont accordées par colonne ; aucun droit
de table `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` ou
`TRIGGER` n'est admis. Le schéma `public` autorise `USAGE` et refuse `CREATE`.
Recovery ne possède aucune relation. Une seule séquence autorise `USAGE` :
`execution_intent_transitions_sequence_seq`; elle refuse `SELECT` et `UPDATE`.

La matrice de colonnes est l'union exacte suivante :

| Table | SELECT | INSERT | UPDATE |
|---|---|---|---|
| `migration_history` | `version` | — | — |
| `execution_intents` | `id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,decision_event_id,decision_fingerprint,requested_at,expires_at,status,attempt_count,state_revision,lease_owner,lease_token,lease_expires_at,last_reason_code,terminal_at,reconciliation_completed_at,created_at,updated_at,purge_after` | `id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,decision_event_id,decision_fingerprint,requested_at,expires_at,status` | `status,state_revision,last_reason_code,lease_owner,lease_token,lease_expires_at,terminal_at,reconciliation_completed_at,purge_after,updated_at` |
| `execution_signed_transactions` | toutes sauf `signed_transaction_bytes` | — | `state,state_revision,submitted_at,confirmed_at,confirmed_slot,reconciled_at,purge_after` |
| `execution_attempts` | `intent_id,attempt_number,status,effective_venue,provider_id,reconciliation_signature,reconciliation_blockhash,reconciliation_last_valid_block_height,reconciliation_message_hash,reconciliation_build_fingerprint,reconciliation_snapshot_fingerprint,reconciliation_maximum_fee_lamports,reconciliation_maximum_fee_payer_lamport_debit` | — | `status,completed_at,reason_code` |
| `execution_wallet_generations` | `generation_id,payload_version,wallet_public_key,generation,cluster,genesis_hash,retired_at` | — | — |
| `execution_live_positions` | `position_id,buy_intent_id,generation_id,armament_id,wallet_public_key,mint,quote_mint,state,state_revision,exit_intent_id,remaining_base_raw,quote_cost_raw,exit_deadline_at,entry_reconciliation_fingerprint` | `position_id,payload_version,buy_intent_id,generation_id,armament_id,wallet_public_key,mint,quote_mint,entry_venue,quote_cost_raw,base_amount_raw,remaining_base_raw,fee_lamports,maximum_holding_ms,opened_at,exit_deadline_at,entry_reconciliation_fingerprint,state,state_revision` | `state,state_revision,exit_intent_id,remaining_base_raw,exit_reconciliation_fingerprint,closed_at,purge_after` |
| `execution_activation_armaments` | `armament_id,provider_id,state,state_revision,maximum_holding_ms` | — | `state,state_revision,terminal_at,purge_after` |
| `execution_exit_authorizations` | `authorization_id,position_id,state,state_revision` | `authorization_id,payload_version,position_id,generation_id,wallet_public_key,mint,quote_mint,maximum_base_amount_raw,state,state_revision,created_at` | `state,state_revision,locked_intent_id,locked_attempt_number,terminal_at,purge_after` |
| `execution_wallet_risk_state` | `generation_id,state_revision,reserved_exposure_raw,open_positions,unknown_block` | — | `state_revision,reserved_exposure_raw,open_positions,unknown_block,updated_at` |
| `execution_exposure_reservations` | `reservation_id,intent_id,generation_id,state,state_revision,maximum_amount_raw,wallet_snapshot_fingerprint` | — | `state,state_revision,reconciled_at,purge_after` |
| `execution_reconciliation_evidence` | toutes les colonnes (requis par le `SELECT *` du trigger `guard_execution_reconciliation_evidence_resolution`) | `evidence_id,payload_version,evidence_fingerprint,intent_id,attempt_number,reservation_id,generation_id,provider_id,side,signature,blockhash,last_valid_block_height,message_hash,build_fingerprint,snapshot_fingerprint,maximum_fee_lamports,maximum_fee_payer_lamport_debit,signature_history,confirmation_status,finalized_block_height,observed_slot,observed_transaction_fingerprint,fee_lamports,wallet_lamport_delta,base_delta_raw,quote_delta_raw,unexpected_residual_token_balance_raw,observed_at,finalized_at,result,reason_code,purge_after` | `resolved_by_evidence_id,resolved_at,purge_after` |
| `execution_intent_transitions` | — | `intent_id,previous_status,next_status,reason_code,human_message,activation_phase,attempt_number,evidence,occurred_at` | — |
| `execution_submission_events` | `artifact_id,generation_id,previous_state,next_state,reason_code` (requis par les triggers du ledger) | `event_id,payload_version,event_fingerprint,artifact_id,generation_id,previous_state,next_state,reason_code,occurred_at` | — |
| `execution_activation_events` | — | `event_id,payload_version,event_fingerprint,armament_id,generation_id,previous_state,next_state,reason_code,occurred_at` | — |

Ces listes sont matérialisées et testées dans le code de policy ; elles ne sont
pas interprétées dynamiquement depuis le schéma. Toute colonne ou relation
future est interdite jusqu'à une nouvelle version de cette spécification.

Les fingerprints build, configuration et stratégie restent inclus et validés
dans chaque read-model H1. Ils ne sont pas épinglés à la version courante de
H2a : une confirmation ou réconciliation historique doit rester possible
après le déploiement d'un nouveau build.

Le catalogue de migrations associe chaque nom au SHA-256 de son contenu. Cette
preuve détecte aussi une migration historique modifiée après déploiement. Le
schéma existant `migration_history(version, applied_at)` ne stockant pas les
checksums, H2a vérifie le catalogue logiciel et l'ensemble exact des versions
appliquées ; l'ajout durable des checksums historiques nécessiterait une
migration séparée et n'est pas simulé implicitement.

## 6. Gateway RPC de lecture

Le gateway concret utilise JSON-RPC HTTP avec `AbortSignal`, timeout par appel,
taille maximale de réponse, budget par passe et parsing fermé. Le runtime crée
une session neuve au début de chaque passe et la partage entre les trois lanes ;
aucune lane ne peut réinitialiser isolément le compteur ou la mémoïsation.

Méthodes autorisées :

- `getGenesisHash` au démarrage ;
- `getSignatureStatuses` avec historique pour la confirmation ;
- `getBlockHeight` avec engagement `finalized` ;
- `getSignatureStatuses` avec historique pour la présence finalized ;
- `getTransaction` avec engagement `finalized`, encodage `base64` et version 0 ;
  ses balances finalized servent aux deltas wallet définis par
  `ExecutionReconciliationGateway`.

Les quatre lectures de réconciliation doivent représenter une observation
cohérente. Si la transaction ou les deltas ne peuvent pas être prouvés au
niveau attendu, le résultat reste `UNKNOWN` ou la lane est rejouée. Aucune
lecture `processed` ne produit une preuve durable.

L'identité RPC normalisée contient uniquement `signature`, `blockhash` et
`messageHash`. `buildFingerprint` et `snapshotFingerprint` ne sont pas
reconstructibles depuis la chaîne : le service les rattache depuis le
read-model durable avant le calcul de la preuve. Les résultats des commits de
finalité contiennent une référence d'artefact sans `signedTransactionBytes`.

Chaque réponse doit être JSON-RPC 2.0, correspondre à l'identifiant de requête,
respecter les bornes de taille et les types entiers. Les nombres Solana au-delà
de la précision sûre sont lus depuis des chaînes décimales ou refusés.
La transaction publique base64 est bornée à 1 232 octets, désérialisée en
mémoire pour vérifier son message puis abandonnée ; elle n'est ni persistée,
ni signée, ni simulée, ni envoyée.

Pour `getTransaction`, la racine contient exactement `slot`, `blockTime`,
`meta`, `transaction` et `version`; `version` vaut `legacy` ou `0` et doit
correspondre au message désérialisé. Les champs consommés de `meta` et des
balances token sont validés, tandis que les champs optionnels officiels connus
sont seulement contrôlés de forme. Pour v0, l'ordre RPC des comptes est clés
statiques, `loadedAddresses.writable`, puis `loadedAddresses.readonly`; les
deux longueurs chargées doivent égaler séparément les sommes d'index LUT du
message, les pré/post-balances couvrent exactement ces comptes et chaque
`accountIndex` token est un u8 dans cette plage. Une même position token ne
peut pas changer d'owner ou de mint entre les deux tableaux.

Le délai et l'abort restent actifs jusqu'à la fin de la lecture et du parsing.
Les réponses 429, non-OK ou à `content-length` invalide/trop grand arrêtent le
contrôleur et initient l'annulation du corps sans attendre cette annulation. Le
corps est copié dans un buffer contigu borné à 16 MiB, puis décodé en UTF-8
fatal : une séquence invalide, comme toute structure refusée, produit une erreur
RPC redacted. Ces règles bornent le transport ; elles ne garantissent pas une
preuve métier lorsque les données finalized manquent ou divergent.

## 7. Lanes

### 7.1 Réconciliation

La lane appelle `claim(... purpose: 'RECONCILE')`, puis
`readReconciliationWork(claim)`. Elle refuse une divergence de `providerId`,
renouvelle le lease, collecte les preuves finalized via le gateway, renouvelle
à nouveau et appelle `commitReconciliation` avec le claim actif retourné par
ce dernier renouvellement. Le commit libère atomiquement la lease pour tous
les résultats, y compris `UNKNOWN` et `MISMATCH`. Toute erreur avant commit
libère explicitement le claim avant report ou échec fermé.

`SIGNED_NOT_SUBMITTED` n'est pas éligible. La reprise exacte de cet état reste
réservée à H2b via `LIVE_RECOVER`.

### 7.2 Confirmation

La lane appelle `claim(... purpose: 'CONFIRM')`, puis
`readConfirmationWork(claim)`. Elle observe uniquement la signature fournie par
le read-model, renouvelle le lease avant et après l'appel puis persiste avec le
claim actif retourné par ce dernier renouvellement dans `recordConfirmation`.
`recordConfirmation` libère atomiquement `lease_owner`, `lease_token` et
`lease_expires_at` dans cette même transition ; la lane ne fait aucun `release`
post-commit et `RECONCILE` peut donc réclamer immédiatement l'intention. Un
replay exact de confirmation accepte une lease déjà nulle ou la même lease.
`NOT_FOUND` libère explicitement le claim, reste sans code d'erreur, ne
provoque aucune transition terminale et sera rejoué. Une erreur RPC retryable
produit aussi un report, mais son `DEFERRED` gelé associe la `lane` et le seul
`errorCode` RPC retryable allowlisté correspondant, ou `null` lorsqu'aucun code
allowlisté n'est disponible. Ces reports ne sont pas `WORKED` et la boucle
continue vers l'échéance, afin de ne pas l'affamer. Un statut `UNKNOWN`, une
finalité incohérente, ou un `CONFIRMED`/`FINALIZED` sans slot `bigint` non
négatif échoue fermé : aucune finalité synthétique n'est persistée.

### 7.3 Échéance

La lane appelle le scanner atomique H1 `createNextDeadlineExitIntent`. Elle ne
consulte pas le réseau et ne réclame pas l'intention SELL créée. Le fence de
présence SELL protège toujours les BUY concurrents.

## 8. Boucle, logs et arrêt

La boucle crée une factory de lanes liée à une session RPC unique, appelle les
lanes dans l'ordre strict et attend l'intervalle de poll
après une passe. Une erreur est journalisée sous un code typé puis la boucle
continue, sauf erreur de démarrage ou signal d'arrêt.

Événements structurés minimaux :

- `executor_live_recovery.started` ;
- `executor_live_recovery.lane_completed` ;
- `executor_live_recovery.lane_failed` ;
- `executor_live_recovery.stopping` ;
- `executor_live_recovery.stopped`.

Les champs autorisés sont `lane`, `result`, `errorCode`, `providerPosition`,
`executionMode` et durées bornées. Les identifiants métier sensibles ne sont
pas journalisés ; aucun log ne contient de message d'erreur, URL RPC ou
signature.

`SIGINT` et `SIGTERM` interrompent les appels RPC, empêchent une nouvelle
passe, ferment PostgreSQL et terminent dans un délai borné. Au dépassement, la
connexion DB est évincée puis le processus sort avec code 1. Aucun signer
n'existe à fermer.

## 9. Tests d'acceptation

H2a est livrable uniquement si :

- config exacte, bornes, secrets interdits et défaut fail-closed sont testés ;
- le démarrage valide rôle, migrations, bindings et genesis dans l'ordre ;
- chaque lane utilise son claim/read-model H1 et traite une seule unité ;
- la priorité réconciliation → confirmation → échéance est prouvée ;
- provider affinity et perte de lease échouent fermées ;
- timeout, abort, 429, réponse RPC invalide et genesis divergent sont testés
  avec un serveur RPC local ;
- aucune suite de tests ou CI ne joint un endpoint Solana public ;
- les tests d'architecture source et `dist` prouvent l'absence de keypair,
  signer, lecture des bytes signés PostgreSQL, simulation signée, `beginSubmission` et
  `sendRawTransaction` ;
- PostgreSQL réel valide les claims, commits, concurrence et reprise ;
- le provisioning du rôle recovery est rejouable deux fois et une connexion de
  test sans appartenance est refusée puis évincée ;
- deux checkouts successifs, dont un après réacquisition, observent toujours le
  login attendu comme `session_user` et le rôle recovery comme `current_user` ;
- PostgreSQL répond `42501` aux lectures des bytes signés ainsi qu'aux écritures
  de signature, simulation signée, préflight et soumission ;
- les propres clés des façades runtime sont exactement allowlistées, leurs
  prototypes sont nuls et cette propriété est testée dans `src` puis `dist` ;
- confirmation, réconciliation et création à échéance fonctionnent réellement
  au travers de ces façades et de leurs ACL minimales ;
- build, check, lint, tests backend/frontend, migrations vides/rejouées et
  documentation passent ;
- aucun test existant ne régresse.

## 10. Non-objectifs et suite

H2a ne signe, ne simule signé, ne soumet, ne reprend
`SIGNED_NOT_SUBMITTED`, ne réclame BUY/SELL, n'arme pas et ne démarre aucun
canary. Il ne change pas l'API publique, la stratégie ou les plafonds.

#51-H2b composera dans un autre exécutable les lanes de reprise signée, SELL,
deadline SELL et BUY, avec gateway de soumission isolé, leases renouvelés,
gates transactionnels, exact bytes et `maxRetries=0`. #51-H2c restera la
validation opérateur puis la préparation manuelle du canary minimal.
