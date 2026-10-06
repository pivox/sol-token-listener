# Chemin simple — design

Date : 2026-10-06
Statut : approuvé en conversation, section par section
Base : `main` à `c4eb457` (inclut #235, tableau de bord live en lecture seule et migration 061)

## Problème

L'idée du projet tient en cinq étapes : voir un token créé, décider, acheter, surveiller ce token,
vendre sur conditions. Le système actuel fait autre chose : il ingère toutes les transactions
pump.fun (~150/s), les décode et les qualifie toutes (social, graphe de wallets, holders), puis trie.
Les runs du 2026-10-06 (#234) montrent qu'aucune configuration ne tient ce débit sur un seul RPC :
~9 500 lignes/min entrantes, 19 traitées, et aucun token n'atteint un état suivi.

Trois autres constats de la même journée, établis par lecture du code :

- Le chemin d'achat paper est cassé en production : le routeur de quotes exige
  `bonding_curve_snapshots.active`, et rien n'écrit cette table (issue ouverte à part).
- En live, la seule vente est l'échéance. Take-profit, vente du créateur et N acheteurs n'existent
  qu'en paper, et une sortie paper émet un SELL `live_reserved=FALSE` que le claim live ignore.
- Chaque achat réel exige un armement manuel (CLI `arm`, fichiers de preuve signés, autorisation à
  usage unique de 60 s, qualification de 5 min, un seul BUY), et le schéma impose une seule position
  live active par génération de wallet.

## Objectif

Un bot qui, pour chaque token créé, décide en quelques secondes avec des vérifications techniques,
achète pour de vrai un montant minimal dans une enveloppe pré-autorisée, suit ce token seul, vend
sur conditions, et mesure. Le volume RPC devient proportionnel au nombre de tokens suivis, pas au
marché. Un second mode d'entrée, « dossier complet », est prévu par un flag mais spécifié après la
mesure.

## Décisions

| Sujet | Décision |
|---|---|
| Argent | Réel dès le départ, montant minimal, dans une enveloppe signée par l'opérateur |
| Trigger entre modes | `ENTRY_MODE` lu au démarrage (restart-only) |
| Décision rapide | Vérifications techniques existantes, rien de social, pas de score |
| Dossier complet | Flag prévu, contenu spécifié après la mesure ; `ENTRY_MODE=dossier` refuse de démarrer |
| Front | Minimal : Radar, détail (Risque + Timeline), positions, santé ; plus de Social ni Holders |
| Positions simultanées | K = 1 dans ce chantier ; K > 1 en lot séparé |
| Approche | Décision directe devant l'exécuteur live existant ; moteur paper hors chemin critique, conservé |

## Architecture

Trois processus, comme aujourd'hui :

1. **Listener** : ingestion `creates-only`, poller de bonding curves et poller de pools pour les
   mints suivis, entrée rapide.
2. **Exécuteur live (H2b)** : lanes existantes, plus une lane `arm`.
3. **Recovery (H2a)** : confirmation, réconciliation, et une lane `exit` qui remplace la lane
   `deadline`.

L'API opérateur en lecture seule (H2h, #235) et sa page `/live` ne changent pas.

Flux : `create` → quotes → `entry_decisions` + intent BUY → lane `arm` (enveloppe) → BUY →
`execution_live_positions` → pollers (curve, puis pool) → lane `exit` → intent SELL → SELL →
réconciliation → compteurs d'enveloppe.

## Composants

### Ingestion `creates-only`

Nouvelle valeur de `LISTENER_INGESTION_SCOPE`, restart-only.

- WebSocket Pump seul. Seules les notifications dont l'indice de logs est `PUMPFUN_CREATE`
  (`pumpFunWebSocketHintFromLogs`, existant) sont enfilées. Les autres passent par la branche
  `filtered` existante du superviseur, avec une nouvelle raison `NOT_A_CREATE`, ce qui conserve la
  santé WebSocket et la progression de slot.
- Scanner de rattrapage strict désactivé dans ce scope. Un `create` manqué est une opportunité
  perdue, pas une erreur. Le curseur `processing_checkpoints` du launchpad n'avance plus ; la santé
  API ne doit pas le considérer comme dégradé dans ce scope.
- Admission bornée, classification catch-up et hydratation de blocs : non requises, flags laissés à
  `false`. Volume attendu : ~20 créations/min.
- Les transactions `create` suivent le pipeline existant : `raw_chain_events`, `domain_events`
  (`TokenLaunchDetected`, et `BondingCurveTradeObserved` pour l'achat initial du créateur),
  `token_launches`, `token_metadata_snapshots`.

### Pollers des mints suivis

Deux pollers, même mécanisme, toutes les 10 s, 5 pages max, sonde de frontière, ≤ 20 adresses :

- `TrackedPoolPoller` (existant, migration 060).
- `TrackedCurvePoller` (nouveau) : pour chaque mint suivi non migré, `getSignaturesForAddress`
  sur sa bonding curve (`launch.parameters.bondingCurve`, déjà dans l'événement de lancement).
  Checkpoint par adresse dans `listener_tracked_curve_checkpoints` (`bonding_curve TEXT PK`,
  `mint TEXT`, `slot NUMERIC(78,0)`, `signature TEXT`, `updated_at`), amorcé depuis la transaction
  `create`. Lignes enfilées avec `source: 'CATCH_UP'`, nouvel indice `PUMPFUN_CURVE_TRADE`
  (mint requis), `programIds: [PUMP_PROGRAM_ID]`, `confirmationStatus: 'finalized'`.
- `PUMPFUN_CURVE_TRADE` est calqué sur `PUMPSWAP_POOL_TRADE` : accepté par le validateur avec
  `CATCH_UP` seulement, priorité `TRACKED_TRADE`, verrou de mint à l'enfilage, exclu de
  `hasNonTerminalProgramWork`. Dans la lane `TRACKED_TRADE`, l'ordre devient `PUMPFUN_TRADE`, puis
  `PUMPFUN_CURVE_TRADE`, puis `PUMPSWAP_POOL_TRADE`.
- Mints suivis = `listWorkerTrackingMints` (existant), qui inclut déjà les positions live ouvertes
  et les intents non terminés. Aucune session paper n'est nécessaire.
- Le pipeline produit `BondingCurveTradeObserved` pour ces trades comme pour ceux du WebSocket ;
  l'inbox déduplique par signature.

Migration **062** : table de checkpoints, élargissement du CHECK `ingestion_hint`.

### Entrée rapide

`ENTRY_MODE=off|fast|dossier`, défaut `off`. `dossier` fait échouer le démarrage avec un message
explicite. `fast` exige `LISTENER_INGESTION_SCOPE=creates-only`.

Déclenchée dans le listener juste après l'observation d'un `create`, une fois par mint :

1. Refus immédiat, sans RPC : quote mint ≠ SOL, extension de token non supportée, créateur ayant
   déjà vendu dans la transaction `create`, aucune enveloppe `ACTIVE` avec capacité (vérification
   indicative ; l'exécuteur fait la vérification stricte à l'armement), décision déjà prise pour ce
   mint.
2. Une lecture RPC multi-comptes au même slot (global, frais, curve, mint), via
   `PumpFunPaperQuoteProvider` appelé directement : quote BUY pour `per_buy_quote_amount_raw` de
   l'enveloppe, puis quote SELL inverse de `minimumAmountOutRaw`. Refus si une quote manque ou si la
   perte aller-retour dépasse `RISK_MAX_ROUNDTRIP_LOSS_BPS` (3000 aujourd'hui).
3. Écriture atomique : ligne `entry_decisions`, événement de domaine `FastEntryDecided` (requis par
   la clé étrangère `execution_intents.decision_event_id`), intent BUY via
   `createExecutionIntentInTransaction` avec `strategyId='fast-entry-v1'`, `venuePolicy=PUMP_FUN_ONLY`,
   `quoteAmountRaw` et `minimumAmountOutRaw` des quotes, `positionId` déterministe, TTL 30 s.

`entry_decisions` : `decision_id TEXT PK`, `mint TEXT UNIQUE`, `launch_event_id TEXT REFERENCES
domain_events`, `create_slot NUMERIC(78,0)`, `create_block_time TIMESTAMPTZ NULL`, `observed_at`,
`decided_at`, `entry_mode TEXT CHECK ('fast')`, `decision TEXT CHECK ('BUY','REJECTED')`,
`reason_code TEXT NULL` parmi `UNSUPPORTED_QUOTE_MINT`, `UNSUPPORTED_TOKEN_EXTENSION`,
`CREATOR_ALREADY_SOLD`, `NO_ENVELOPE_CAPACITY`, `QUOTE_UNAVAILABLE`, `ROUND_TRIP_LOSS_EXCEEDED`,
`round_trip_loss_bps INTEGER NULL`, `buy_quote JSONB NULL`, `reverse_quote JSONB NULL`,
`intent_id TEXT NULL REFERENCES execution_intents`, `envelope_id TEXT NULL`, `purge_after`.

Migration **063** : table `entry_decisions`, `FastEntryDecided` ajouté au CHECK des types de
`api_event_stream` (le trigger copie chaque événement de domaine dans le flux SSE).

### Enveloppe

Table `execution_entry_envelopes` : `envelope_id TEXT PK`, `generation_id TEXT`, `operator_id TEXT`,
`payload_version INTEGER`, `fingerprint TEXT`, `per_buy_quote_amount_raw NUMERIC(78,0) > 0`,
`max_buys INTEGER > 0`, `max_open_positions INTEGER CHECK (= 1)` (assoupli au lot K > 1),
`max_total_exposure_raw NUMERIC(78,0) > 0`, `max_realized_loss_raw NUMERIC(78,0) > 0`,
`valid_from`, `valid_until` (durée ≤ 24 h), `state TEXT CHECK ('ACTIVE','EXHAUSTED','REVOKED',
'EXPIRED')`, `buys_armed INTEGER DEFAULT 0`, `realized_loss_raw NUMERIC(78,0) DEFAULT 0`,
`revoked_at`, `created_at`, `updated_at`. Index unique partiel : une seule enveloppe `ACTIVE` par
génération.

CLI `executor-operations envelope create|revoke|show`, signée comme les actions opérateur
existantes. Révoquer est le kill switch : plus aucun armement, et la lane `exit` vend les positions
ouvertes.

Compteurs : `buys_armed` incrémenté dans la transaction d'armement ; `realized_loss_raw` mis à
jour dans la transaction de réconciliation SELL, à partir de la ligne
`execution_live_position_ledger` qu'elle écrit déjà (#235 : deltas de lamports du BUY et du SELL).
`buys_armed = max_buys`, exposition ou perte au plafond → `EXHAUSTED`. `valid_until` dépassé →
`EXPIRED`, constaté par la lane `arm`.

Migration **064** : table d'enveloppes, colonnes `scope` et `envelope_id` de la qualification,
`LiveExitDecided` ajouté au CHECK des types de `api_event_stream`.

### Lane `arm` (exécuteur live)

Ajoutée avant la lane `buy` dans chaque passe, derrière `EXECUTOR_ENTRY_ENVELOPE_ENABLED`
(défaut `false`). Pour l'enveloppe `ACTIVE` de la génération, si la fenêtre et les compteurs le
permettent et qu'aucune position live n'est active (K = 1) :

1. Prend le plus ancien intent BUY `fast-entry-v1` en `PENDING`, `live_reserved=FALSE`, non expiré.
2. Rafraîchit le snapshot wallet par RPC (code de `executor-readiness` réutilisé) et produit le
   snapshot fournisseur depuis les compteurs d'usage de l'exécuteur, marqué comme produit par la
   lane.
3. Émet une autorisation v2 à usage unique (60 s, format existant, `operator_id` de l'enveloppe)
   dont le contexte est l'intent cible.
4. Dans une transaction : admission risque avec une politique dérivée de l'enveloppe, réservation
   d'exposition, armement v2 **sans source de préflight** (déjà accepté par le repository),
   `live_reserved=TRUE`, `buys_armed += 1`, événement d'activation.

La lane `buy` existante réclame ensuite l'intent sans modification.

### Qualification de sécurité portée par l'enveloppe

`execution_safety_qualifications` gagne `scope TEXT CHECK ('CANARY','ENVELOPE')` et
`envelope_id`. Expiration : ≤ 5 min pour `CANARY` (inchangé), ≤ `valid_until` de l'enveloppe pour
`ENVELOPE`. La qualification `ENVELOPE` est produite par l'opérateur à la création de l'enveloppe
(même CLI `preflight`, même preuve signée). Le trigger d'insertion des armements lie aujourd'hui la
qualification aux empreintes des snapshots wallet et fournisseur (gates 7 et 9) ; pour le scope
`ENVELOPE`, cette liaison porte sur la génération de wallet et l'identifiant de fournisseur, pas sur
l'instant d'un snapshot. C'est le seul garde-fou assoupli ; le plan détaille la modification du
trigger après lecture de la migration 039.

Inchangé : état de contrôle `RUNNING`, admission risque, réservation, une seule transaction signée
par intent, révocation sur blockhash expiré, blocage sur état inconnu, échéance de sortie.

### Lane `exit` (recovery)

Remplace la lane `deadline`. Pour chaque position `OPEN` de la génération, dans cet ordre, la
première condition vraie décide :

1. Enveloppe `REVOKED`.
2. Vente du créateur après l'entrée (`earliestCreatorSell`, exporté de `creation-entry-v1`).
3. Take-profit : quote SELL de `remaining_base_raw` sur la venue courante (curve si aucune migration
   observée, sinon pool via `migrations JOIN market_pools`) ;
   `minimumAmountOutRaw × 10000 ≥ quote_cost_raw × EXIT_TAKE_PROFIT_BPS`.
4. N acheteurs externes distincts après l'entrée (`canonicalBuys`, exporté : hors créateur, hors
   notre wallet, montant ≥ `EXIT_EXTERNAL_MIN_BUY_RAW`, un par wallet) ≥
   `EXIT_EXTERNAL_BUYERS_TARGET`.
5. Échéance : `exit_deadline_at ≤ now`.

Données : `BondingCurveTradeObserved` de `domain_events` et `market_trades`, après le curseur
d'entrée de la position ; créateur depuis l'événement de lancement.

Création du SELL : copie paramétrée de `createDeadlineExitIntentLocked` (`strategyId=
'fast-entry-exit-v1'`, raison, `minimumAmountOutRaw` de la quote pour le take-profit, `1n` pour
les autres raisons comme aujourd'hui), précédée de l'insertion de l'événement `LiveExitDecided`.
Cette insertion corrige aussi l'échéance existante, dont l'intent référence un événement que rien
n'écrit (clé étrangère `043`, présomption forte par lecture du code).

### Suppressions

| Part | Détail |
|---|---|
| Code mort | `src/dashboard/`, `src/strategy/session-engine.ts`, `src/execution/trade-executor.ts`, `src/security/token-risk.service.ts`, `src/storage/repositories.ts`, `src/storage/ignored-asset.repository.ts`, `src/executor-live/confirmation-worker.ts`, `src/executor-live/reconciliation-worker.ts`, leurs tests ; tables `discovered_pools`, `token_sessions`, `swap_events`, `trades`, `token_risk_reports`, `listener_checkpoints`, `risk_settings`, `ignored_assets` |
| Dossier | `src/social/`, worker d'enrichissement social, `HttpMetadataProvider` et vérification sociale, graphe de wallets (`wallet-graph-rebuild.service`, `wallet-graph.repository`, `wallet-evidence.repository`), analytics participants (`src/analytics/`, `participant-analytics.repository`), étapes correspondantes de `ObservedTransactionPipeline` (funding, participants, graphe), file `social_enrichment_jobs` dans `launchpad-event.repository`, signaux et conditions sociaux/holders/clusters de la qualification (profils réduits aux signaux techniques), `loadSnapshot` du paper allégé ; tables `social_*` (5), `creator_profiles`, `token_holders_snapshots`, `observed_wallet_positions`, `wallet_funding_observations`, `wallet_funding_evidence`, `wallet_graph_profiles`, `wallet_graph_snapshots`, `wallet_relationships`, `wallet_clusters`, `wallet_cluster_members` |
| Sans lecteur | `launch_trades`, `state_transitions` |
| Harnais paper MVP | `src/cli/paper-mvp*`, `paper-mvp.repository`, tables `paper_mvp_runs`, `paper_mvp_position_samples` |

`creatorHasNotSold` (profil technique) est recalculé depuis les `BondingCurveTradeObserved` du
mint, et non plus depuis `creator_profiles`.

Conservé : inbox et ses tables de correction, checkpoints, finalité, heartbeats, santé WebSocket,
attributions terminales ; `raw_chain_events`, `domain_events`, `token_launches`,
`token_metadata_snapshots`, `bonding_curve_snapshots` (non réparé ici), `market_pools`,
`migrations`, `market_trades`, `market_reserve_snapshots` ; tables paper et
`qualification_reports` ; toutes les tables `execution_*` existantes, état et preuves, sans
modification autre que celles décrites ci-dessus ; `api_event_stream` et le SSE.

Les suppressions de tables se font par migration `DROP TABLE` après retrait du code, avec les
triggers associés. Les listes de tables de `scripts/provision-executor-roles.sql`, des autorités
exactes (`executor-live-recovery/database-authority.ts`, tests `listener-database-authority`) et
des tests d'architecture sont mises à jour dans le même lot.

### API et front

- Routes supprimées : `/api/v1/launches/:mint/social`, `/api/v1/launches/:mint/holders`.
- `getLaunch` ne charge plus holders ni social ; `/launches/:mint/events` lit `domain_events`
  seul ; `/health` ne lit plus `social_enrichment_jobs` et n'attend plus le curseur launchpad en
  scope `creates-only`.
- Front : onglets Social et Holders retirés, schémas zod, mock e2e et spec Playwright ajustés ;
  la page `/live` et le client opérateur (#235) sont conservés.

### Configuration

| Variable | Processus | Valeurs | Défaut |
|---|---|---|---|
| `LISTENER_INGESTION_SCOPE` | listener | `launchpad-and-market`, `launchpad-only`, `creates-only` | inchangé |
| `ENTRY_MODE` | listener | `off`, `fast`, `dossier` | `off` |
| `EXIT_TAKE_PROFIT_BPS` | recovery | 10001–100000 | 20000 |
| `EXIT_EXTERNAL_BUYERS_TARGET` | recovery | 1–1000 | 10 |
| `EXIT_EXTERNAL_MIN_BUY_RAW` | recovery | > 0 | 1000000 |
| `EXECUTOR_ENTRY_ENVELOPE_ENABLED` | exécuteur live | booléen | `false` |

Les variables `CREATION_*` et `PAPER_*` restent pour le mode paper. Le montant par achat vient de
l'enveloppe, pas d'une variable.

## Erreurs

- Entrée rapide : toute erreur RPC ou de quote → `REJECTED` avec `QUOTE_UNAVAILABLE`, pas de retry.
  L'entrée n'empêche jamais l'observation du `create` ; une erreur d'écriture de l'intent annule la
  transaction et journalise.
- Lane `arm` : enveloppe sans capacité, expirée ou révoquée → l'intent reste `PENDING` et expire par
  son TTL ; admission refusée → intent `FAILED` avec la raison de l'admission ; erreur RPC → passe
  suivante.
- Lane `exit` : quote indisponible → take-profit indécidable ce cycle, autres conditions évaluées,
  l'échéance finit toujours par gagner ; échec du SELL → mécanique de recovery existante.
- Pollers : comme le poller de pools (échec isolé par adresse, `AWAITING_BOUNDARY`, `GAP_SKIPPED`).
- Enveloppe `EXHAUSTED` : plus aucun armement ; les positions ouvertes sortent normalement.

## Mesure

CLI `report`, lecture seule, sur `entry_decisions` et les tables d'exécution :

- entonnoir : créations vues → refus par raison → intents → armés → soumis → confirmés ;
- latences : heure de bloc du `create` → observé → décidé → armé → soumis → confirmé ;
- résultat par position : raison de sortie, durée de détention, PnL en lamports et en bps depuis
  `execution_live_position_ledger` ;
- erreurs RPC 429 sur la période.

Sortie tableau ou JSON, sans signature ni URL ni clé.

## Tests

- Fonctions pures : règles d'entrée, arbitrage des sorties, capacité d'enveloppe, poller de curves.
- Repositories sous Postgres : enveloppe et compteurs, `entry_decisions`, intent BUY avec sa clé
  étrangère, création de SELL avec `LiveExitDecided`, validateur et `convergeIngestion` pour
  `PUMPFUN_CURVE_TRADE`.
- Configuration : `creates-only`, `ENTRY_MODE`, dépendances entre flags.
- Architecture, API, front : mis à jour pour les suppressions.
- Chaque lot : suite complète verte avec `TEST_DATABASE_URL`, CI verte avant merge.

## Lots

1. Suppressions : code mort (PR courte), puis dossier + API/front (PR mécanique).
2. Ingestion `creates-only`, `TrackedCurvePoller`, `PUMPFUN_CURVE_TRADE`, migration 062.
3. Entrée rapide, `entry_decisions`, `FastEntryDecided`, `ENTRY_MODE`, migration 063.
4. Exécuteur : enveloppe et CLI, qualification `ENVELOPE`, lane `arm`, lane `exit`, correction de
   la clé étrangère de l'échéance, CLI `report`, migration 064.
5. Premier run réel, K = 1, enveloppe minimale (0,01 SOL par achat, 5 achats), puis bilan chiffré.

## Prérequis et hors périmètre

- Base de production à décider avant le lot 5 : `solanabot` est bloqué à la migration 050
  (Postgres < 15). Soit Docker PG16 avec volume persistant (compose existant), soit mise à niveau du
  Postgres natif.
- Hors périmètre : contenu du mode dossier ; K > 1 ; retrait de l'admission, de la classification
  et de l'hydratation ; réparation du lecteur de venue paper.

## Risques connus

- Autonomie : l'argent bouge sans validation par achat. Bornes : montant par achat, nombre
  d'achats, exposition, perte cumulée, fenêtre, kill switch.
- Première exécution live réelle de l'exécuteur : les protections existent mais n'ont jamais tourné
  en réel.
- Quotes sans simulation de transaction à l'entrée ; la simulation non signée de l'exécuteur
  attrape les achats qui échoueraient avant signature.
- Suffixe `TradeEvent` de 24 octets accepté en opaque (#232) : si ces octets changent le sens des
  montants, les quotes et le PnL en dépendent.
- Le bug de clé étrangère de l'échéance est une présomption par lecture ; le test du lot 4 le
  tranche.
