# Paper trading end-to-end V1 — conception

Date : 2026-08-10  
Issue : [#39](https://github.com/pivox/sol-token-listener/issues/39)  
Stratégie : `validated-external-buys-v1`, version `1`

## 1. Décision

La PR #39 livre une tranche verticale réellement composée dans le runtime :

```text
transaction Solana canonique
  -> projections Pump.fun et PumpSwap
  -> participants et graphe de wallets
  -> qualification reconstruite
  -> candidat de trading persistant
  -> BUY paper
  -> achats externes postérieurs à l'entrée (0..10)
  -> SELL paper
  -> position fermée et PnL
```

Cette tranche reste strictement passive vis-à-vis de Solana. Elle ne construit,
ne signe, ne simule avec `simulateTransaction` et n'envoie aucune transaction.
Une « simulation » paper désigne ici une cotation passive suivie d'une écriture
comptable locale. Aucun wallet et aucune clé privée ne sont introduits.

La PR consolide le périmètre fonctionnel des issues #15, #16, #17 et #28. Ces
issues ne seront fermées que si leurs critères sont couverts par les tests et le
dry run de cette PR. Les issues live #18 à #23 restent hors périmètre.

## 2. Principes non négociables

- `EXECUTION_MODE=observe` peut reconstruire qualification et candidat, mais ne
  crée jamais de session, position ou trade paper.
- `EXECUTION_MODE=paper` est le seul mode qui autorise les écritures paper.
- Aucun import de capacité de signature, wallet, construction ou soumission de
  transaction n'est permis depuis le bootstrap, le pipeline, la stratégie ou
  les fournisseurs de cotation.
- Tous les montants, réserves, frais, slots et basis points utilisent `bigint`
  dans le domaine et `NUMERIC(78,0)` ou des chaînes décimales aux frontières.
- Le quote mint reste une valeur métier. La première allowlist paper est
  SOL/WSOL, mais aucun calcul ne suppose globalement SOL.
- Un score élevé ne neutralise jamais une condition `ENFORCED` déclenchée.
- Les données absentes restent `UNKNOWN`. La reconstruction ne fabrique aucune
  preuve positive pour rendre un token éligible.
- Toute écriture porte une identité déterministe et supporte replay, concurrence,
  crash/reprise, finalité et orphaning.
- Une cotation indisponible ou périmée ne ferme jamais artificiellement une
  position et ne transforme jamais une preuve inconnue en preuve positive.
- La rétention métier reste quatre heures après état terminal, enfant avant
  parent, sans supprimer une lignée encore référencée.

## 3. Choix d'architecture

### 3.1 Tranche verticale dans le pipeline durable

`ObservedTransactionPipeline` conserve ses étapes actuelles puis ajoute, après
`pumpswap_observation`, une étape `paper_decision_enqueue` pour chaque mint
affecté. Cette étape crée un job déterministe lié au dernier événement canonique
de la transaction. Elle ne fait aucun second appel RPC.

Un `PaperDecisionWorker` durable traite ensuite, dans cet ordre :

1. `qualification_rebuild` pour le mint ;
2. `trading_candidate_rebuild` pour le rapport reconstruit ;
3. `paper_strategy_reconcile` pour le candidat et les trades actifs de la
   transaction.

Le marché est persisté avant le job afin qu'une transaction de
graduation puisse immédiatement basculer la source de cotation vers le pool
PumpSwap canonique. La création du job est une étape nommée de
`ObservedPipelineError` : son échec laisse la transaction inbox rejouable. Les
étapes de décision ont leurs propres erreurs typées, leases renouvelables,
backoff borné, plafond de tentatives, reprise manuelle et état de santé. Une
indisponibilité de quote ne bloque donc pas durablement l'ingestion Solana.

```mermaid
flowchart LR
  I[Inbox durable] --> L[Launchpad]
  L --> P[Participants]
  P --> G[Wallet graph]
  G --> M[PumpSwap]
  M --> J[Decision job]
  J --> Q[Qualification]
  Q --> C[Trading candidate]
  C --> S[Paper strategy]
  S --> I
```

### 3.2 Reconstruction, pas mutation incrémentale fragile

Qualification, candidat et compteur externe sont reconstruits depuis les
projections canoniques actives sous verrou PostgreSQL par mint/session. Un replay
ne dépend donc pas d'un compteur mémoire. Les identités des achats déjà comptés
sont persistées pour audit, mais le total courant est recalculable à partir de
ces identités et des trades canoniques non orphaned.

Une transaction `orphaned` déclenche la même reconstruction avec la politique
`dissolve_current`. Si la preuve racine disparaît :

- le rapport et le candidat courants deviennent rétractés ;
- une position seulement ouverte par ce déclencheur devient
  `PAPER_RETRACTED` si aucune fermeture n'a été comptabilisée ;
- une position déjà fermée n'est pas effacée : elle passe en réconciliation
  explicite et conserve son audit ;
- aucun deuxième SELL n'est produit.

## 4. Modèle métier

### 4.1 Qualification reconstruite

`QualificationRebuildService` lit, dans un snapshot PostgreSQL
`REPEATABLE READ`, le lancement courant et les dernières projections actives :

- métadonnées et preuves sociales publiques ;
- profil créateur et positions observées ;
- concentration des détenteurs ;
- graphe et clusters de wallets ;
- bonding curve ou pool PumpSwap canonique ;
- BUY et SELL quotes passives fraîches.

Il transforme uniquement les faits observables en
`QualificationEvaluationInput`, appelle `QualificationEngine.evaluateAuthorized`
et persiste un événement `QualificationUpdated` déterministe. Le sujet autorisé
est `(mint, triggerEventId)`. Après un crash, le service reconstruit et autorise
un nouveau rapport identique avant de le remettre au moteur paper ; il ne tente
pas de réutiliser une autorisation mémoire.

Le rapport est identifié par le mint, le profil effectif, l'empreinte complète
des preuves et le curseur `asOf`. Une répétition exacte ne crée aucune nouvelle
révision API/SSE. Une modification réelle des preuves crée une nouvelle identité.

### 4.2 Candidat de trading

Le domaine introduit `TradingCandidateV1` :

```text
NOT_ELIGIBLE | ELIGIBLE | EXPIRED | REVOKED
```

Un candidat est `ELIGIBLE` seulement lorsque :

- le rapport autorisé est `QUALIFIED` ;
- aucun blocker `ENFORCED` n'est actif ;
- toutes les preuves obligatoires sont satisfaites ;
- la confirmation atteint le minimum configuré ;
- le quote mint appartient à l'allowlist paper ;
- le BUY quote et le reverse SELL quote sont frais ;
- la perte aller-retour ne dépasse pas le seuil effectif ;
- aucune position active incompatible n'existe.

Le candidat contient son `strategy`, son rapport, son événement déclencheur, ses
deux quotes, `eligibleUntilMs`, ses reason codes et une empreinte de preuves. La
durée de validité est bornée et configurable. `EXPIRED` signifie que la fenêtre
d'entrée est passée ; `REVOKED` signifie qu'une preuve antérieurement positive
n'est plus canonique. Aucun état candidat ne représente un ordre réel.

### 4.3 Session de stratégie

`PaperStrategySessionV1` utilise les états :

```text
BUY_PENDING
PAPER_HOLDING
WAITING_EXTERNAL_BUYS
EXIT_PENDING_QUOTE
SELL_PENDING
PAPER_CLOSED
PAPER_RETRACTED
MANUAL_REVIEW
```

La session persiste :

- `strategyId`, `strategyVersion`, mint et quote asset ;
- candidat et rapport ayant autorisé l'entrée ;
- position et commandes BUY/SELL déterministes ;
- curseur logique d'entrée ;
- cible et nombre d'achats externes ;
- identités et curseurs des trades comptés ;
- dernière quote et dernière erreur typée sans détail sensible ;
- état courant, reason code, dates et rétention.

En paper mode, aucun achat propre n'apparaît on-chain. Le curseur logique
d'entrée est donc le curseur canonique du candidat qui déclenche le fill paper.
Tout BUY Pump.fun ou PumpSwap strictement postérieur est externe par définition.
La session stocke `actorKind=PAPER_SIMULATION`, pas une fausse adresse wallet.

### 4.4 Comptage des achats externes

Un trade compte si et seulement si :

- il concerne le mint et le quote asset de la session ;
- son type canonique est `BUY` ;
- son curseur complet est strictement supérieur au curseur d'entrée ;
- sa confirmation atteint le minimum configuré ;
- il n'est pas orphaned ;
- son identité déterministe n'a pas déjà été comptée.

Les ventes, transferts SPL, transactions échouées, événements antérieurs,
doublons et orphaned sont exclus. La V1 compte les événements, pas les wallets
uniques : plusieurs BUY distincts du même trader comptent séparément.

Le passage de `9` à `10` et la réservation de la commande SELL sont atomiques
sous verrou de session. Les achats 10, 11 ou concurrents produisent la même
identité de fermeture et au plus un trade SELL.

## 5. Cotations passives

### 5.1 Routeur de venue

`PaperQuoteRouter` choisit une source canonique :

- bonding curve Pump.fun tant qu'elle existe et `complete=false` ;
- pool PumpSwap canonique actif après migration ;
- aucune quote lorsque les deux sources se contredisent, sont absentes ou sont
  périmées.

La source, le slot commun, l'heure d'observation et les comptes lus participent
à l'identité de quote. Une route de migration ne mélange jamais les réserves
d'une venue avec les frais de l'autre.

### 5.2 Pump.fun

La lecture Pump.fun utilise un seul snapshot RPC
`getMultipleAccountsInfoAndContext` pour le compte `Global`, la bonding curve,
le mint et le `FeeConfig` requis. Les propriétaires, discriminators, tailles,
PDAs, quote mint et programmes token sont validés avant décodage.

La formule et le calcul des frais proviennent du SDK officiel exact
`@pump-fun/pump-sdk@1.36.0` et de ses comptes on-chain. La dépendance est épinglée
sans plage de version. Le code adapte explicitement `BN` vers `bigint` aux
frontières et refuse toute valeur négative, supérieure à `u64` ou non
canonique. Aucun `number` n'intervient dans les calculs financiers.

Sources autoritatives épinglées :

- [pump-public-docs au commit 9c82f61](https://github.com/pump-fun/pump-public-docs/tree/9c82f61cb711b044a17f770ab8ce9f9bdf78f333) ;
- [IDL Pump officiel](https://github.com/pump-fun/pump-public-docs/blob/9c82f61cb711b044a17f770ab8ce9f9bdf78f333/idl/pump.json) ;
- [`@pump-fun/pump-sdk@1.36.0`](https://www.npmjs.com/package/@pump-fun/pump-sdk/v/1.36.0).

Les quotes BUY/SELL utilisent les fonctions officielles de bonding curve. Les
frais sont dérivés du résultat officiel et de la variation exacte des réserves,
pas d'un taux codé en dur. Le slippage produit uniquement
`minimumAmountOutRaw`; il ne modifie pas le résultat théorique. Un BUY est borné
par `realTokenReserves` et un SELL par la liquidité quote réellement récupérable.

### 5.3 PumpSwap

Le routeur réutilise `PumpSwapMarketAdapter.quote`,
`PumpSwapReserveReader` et `PumpSwapFeeStateReader`. La réserve quote effective
reste :

```text
quoteVaultAmountRaw + virtualQuoteReservesRaw
```

La sellabilité vérifie en plus la réserve réelle du vault. Les frais dynamiques
sont lus via le SDK PumpSwap officiel déjà intégré. Aucune logique Raydium
n'entre dans le flux principal ; l'adaptateur Raydium reste intact et secondaire.

### 5.4 Fraîcheur et erreurs

Une quote est utilisable uniquement si son âge et son écart de slot sont dans
les bornes configurées. Les erreurs publiques restent stables :

```text
QUOTE_STATE_UNAVAILABLE
QUOTE_STATE_INCONSISTENT
QUOTE_STALE
BUY_QUOTE_UNAVAILABLE
SELL_QUOTE_UNAVAILABLE
ROUND_TRIP_LOSS_EXCEEDED
VENUE_MIGRATION_PENDING
UNSUPPORTED_QUOTE_MINT
```

Les causes RPC, URLs et payloads bruts ne sont ni persistés ni exposés.

## 6. Persistance PostgreSQL

La migration `013_paper_e2e.sql` est rejouable sur base vide et ajoute :

- `paper_decision_jobs` : travail durable, lease, retry borné et reprise ;
- `qualification_reports` : rapport immuable, empreinte, trigger et finalité ;
- `trading_candidates` : projection courante et historique terminal ;
- `paper_strategy_sessions` : état durable par mint/stratégie/version ;
- `paper_external_buy_events` : relation unique session/trade compté ;
- les colonnes de lignée et de stratégie manquantes dans `paper_positions` ;
- les index partiels de projection courante, claim/reprise et purge.

Les contraintes garantissent :

- une seule qualification courante par mint/profil ;
- un seul candidat courant par mint/stratégie/version ;
- une seule session active compatible ;
- une seule relation par trade externe compté ;
- dates terminales et `purge_after` cohérentes ;
- payload version `1` et enums fermés ;
- références vers les événements sources sans cascade prématurée.

Les écritures de qualification, candidat, session, paper position, paper trade,
événement domaine et révision SSE sont ordonnées enfant avant parent et
transactionnelles là où une décision et son effet doivent être indivisibles.
La purge supprime dans l'ordre inverse des références.

## 7. Configuration

La configuration V1 ajoute des valeurs explicitement validées :

```text
PAPER_STRATEGY_ENABLED=false
PAPER_STRATEGY_ID=validated-external-buys
PAPER_STRATEGY_VERSION=1
PAPER_ENTRY_QUOTE_AMOUNT_RAW=<obligatoire si enabled>
PAPER_EXTERNAL_BUY_TARGET=10
PAPER_MINIMUM_CONFIRMATION=confirmed
PAPER_ENTRY_WINDOW_SECONDS=45
PAPER_QUOTE_MAX_AGE_MS=5000
PAPER_QUOTE_MAX_SLOT_LAG=32
PAPER_SLIPPAGE_BPS=<obligatoire si enabled>
```

`PAPER_STRATEGY_ENABLED=true` est refusé en mode `observe`. Il est aussi refusé
si le montant, le slippage, le profil de qualification ou les seuils round-trip
ne sont pas explicitement configurés. Aucune valeur implicite dangereuse n'est
fournie pour le montant d'entrée.

## 8. API, SSE et santé

Les contrats V1 restent additifs et sérialisent les `bigint` en chaînes :

- la fiche launch expose le candidat et la progression paper courants ;
- `/api/v1/paper-positions` expose stratégie/version, progression externe,
  venue, frais et PnL ;
- la timeline expose les transitions qualification/candidat/session ;
- SSE ajoute des résumés bornés sans payload RPC brut ;
- `/api/v1/health` expose le worker `paperDecision`, les états `qualification`
  et `paper`, les comptes
  bornés de sessions en attente, les quotes indisponibles et le dernier succès.

Événements ajoutés :

```text
TradingCandidateUpdated
PaperStrategySessionUpdated
PaperExternalBuyCounted
```

Les événements paper existants `PaperPositionOpened` et
`PaperPositionClosed` restent les preuves comptables autoritatives.

## 9. Dry run terrain borné

Une commande observation-only `npm run paper:dry-run` :

- exige `EXECUTION_MODE=paper` et la configuration explicite de la stratégie ;
- utilise le même runtime compilé et la même base PostgreSQL ;
- refuse toute variable de clé privée ou mode live ;
- s'arrête après une durée et un nombre de sessions configurés ;
- écrit un rapport JSON assaini contenant couverture, candidats, ouvertures,
  progression, fermetures, quotes indisponibles et PnL paper ;
- retourne un code non nul si le listener ne devient pas sain, si les migrations
  échouent ou si une capacité interdite est chargée ;
- ne considère pas l'absence de dix achats dans une courte fenêtre comme une
  erreur technique.

Le test terrain prouve la composition et la sûreté du chemin ; il ne promet ni
première position, même slot, sellabilité, profit ou disponibilité permanente
du RPC.

## 10. Stratégie de tests

### Unitaires

- mapping strict des projections vers les signaux et faits de qualification ;
- états et reason codes du candidat ;
- calculs Pump.fun comparés aux sorties du SDK officiel ;
- routeur Pump.fun/PumpSwap et migration contradictoire ;
- comptage 0 à 10, même wallet multiple, exclusions et replays ;
- quote périmée ou indisponible ;
- calcul des frais, aller-retour et PnL en `bigint`.

### Intégration PostgreSQL

- migration 001 à 013 sur base vide puis replay ;
- reconstruction idempotente et révision réelle ;
- verrou concurrent sur candidat/session ;
- seuil atteint simultanément par plusieurs transactions ;
- crash entre décision et effet puis reprise ;
- confirmed vers finalized et orphaned ;
- graduation Pump.fun vers PumpSwap ;
- purge enfant avant parent après quatre heures.

### Runtime et sécurité

- `observe` ne produit aucune écriture paper ;
- `paper` réalise exactement un BUY et un SELL ;
- le pipeline et le worker exposent précisément leur étape fautive ;
- le graphe source du bootstrap ne référence aucun module local de signature,
  construction ou soumission ; la façade du SDK officiel n'appelle que ses
  décodeurs et fonctions de cotation, avec une connexion RPC en lecture seule ;
- `.env.example`, README, architecture, API et HTML diagnostic restent alignés ;
- fixtures Solana assainies et sans adresse RPC privée.

### Acceptation finale

```text
npm install
npm run build
npm run check
npm run lint
npm run docs:check
TEST_DATABASE_URL=... npm test
npm run paper:dry-run
```

La PR ne peut être fusionnée qu'après au maximum trois cycles de revue GitHub,
zéro thread bloquant et vérification du commit effectivement fusionné sur
`main`.

## 11. Risques et réponses

| Risque | Réponse |
|---|---|
| SDK ou comptes Pump évoluent | version exacte, manifest officiel et fixtures de layout |
| quote incohérente entre plusieurs slots | lecture multi-comptes à un slot commun, fail closed |
| double BUY/SELL sur replay | IDs déterministes, index uniques et verrou transactionnel |
| dixième BUY concurrent | compteur et réservation SELL dans la même transaction |
| reorg après décision | reconstruction canonique, rétraction ou revue manuelle explicite |
| graduation pendant une quote | routeur refuse le mélange des venues et retente |
| RPC limité ou 429 | erreur retryable bornée, état de santé dégradé, aucun faux fill |
| dérive vers le live | tests d'import, modes fermés, aucune interface de transaction |
| PR trop large | composants séparés, TDD et commits fusionnables par couche |

## 12. Critères de sortie

La PR #39 est terminée uniquement si :

1. le runtime compose le parcours complet en mode paper ;
2. `observe` demeure sans écriture paper ;
3. qualification, candidat, session, achats et positions sont persistés et
   reprenables ;
4. Pump.fun puis PumpSwap fournissent des quotes passives officielles ;
5. un replay/concurrent/reorg ne crée aucun double BUY ou SELL ;
6. les API/SSE expliquent chaque décision et progression ;
7. les migrations et la purge fonctionnent sur PostgreSQL réel ;
8. le dry run borné produit un rapport assaini ;
9. toutes les commandes d'acceptation passent ;
10. aucune capacité réelle, clé privée ou promesse financière n'est introduite.
