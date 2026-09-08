# Préparation déterministe d'une intention de préflight — H2k-b

Version : 1.2.0
Statut : validé pour implémentation  
Date : 2026-09-08

## 1. Objectif

H2k-b prépare hors ligne la première paire d'intentions Pump.fun admissible
créée après le démarrage d'un run. Il évalue exactement la cible sans la
consommer, simule exactement son sibling, vérifie leurs preuves puis publie un
manifeste redacted. Il ne charge aucun wallet, ne signe rien, n'arme rien et
n'envoie aucune transaction.

Le comportement reste désactivé par défaut et n'est accessible que par une
commande one-shot dédiée. Le listener et les executors existants ne la
démarrent jamais implicitement.

## 2. Invariants de sécurité

- PostgreSQL fournit le watermark, les deadlines et les horodatages d'autorité.
- Seule une paire créée strictement après le watermark du run est admissible.
- La première paire est déterminée par `(created_at, pair_id)` ; sa perte d'une
  gate fait échouer le run sans substitution.
- La cible et le sibling sont revendiqués par leur identifiant exact sous la
  lease de préparation ; aucun sélecteur global n'est utilisé.
- Les workers génériques `EXECUTE` et `DRY_RUN` excluent les deux lanes
  `TARGET` et `SIMULATION`.
- La cible reste `PENDING`, `attempt_count=0`, `state_revision=0`, sans lease
  d'intention et `live_reserved=false` après son assessment.
- Le sibling seulement peut passer par `PROCESSING` puis `SUCCEEDED` ou
  `FAILED` avec exactement une tentative et un artefact de simulation.
- Une deadline absolue conserve au moins 5 secondes pour le handoff H2h.
- Une erreur RPC, un 429, un mauvais genesis, une simulation non réussie, une
  preuve périmée, une perte de fence ou une capacité RPC non vérifiée ferme le
  run sans retry ouvert.
- Les données sont supprimables quatre heures après leur fin ; aucune donnée
  brute ou clé privée n'est ajoutée à cette rétention.

## 3. Modèle persistant — migration 042

`execution_preflight_intent_preparation_runs` est la source d'autorité du run.
Elle conserve une identité de run, `payload_version=1`, le watermark DB, la
deadline absolue, la paire figée, l'état `WAITING`, `PREPARING`, `PREPARED` ou
`FAILED`, une révision monotone, une lease dédiée active dès `WAITING`, les
identifiants de l'assessment et de l'artefact,
le code d'échec, les dates de fin et `purge_after`.

Les contraintes imposent :

- une paire au plus par run et un run au plus par paire ;
- un seul run `WAITING` ou `PREPARING` à la fois ;
- paire absente uniquement en `WAITING` ;
- lease complète et non expirée en `WAITING` et `PREPARING` ;
- preuves complètes uniquement en `PREPARED` ;
- reason code et date de fin obligatoires en `FAILED` ;
- horodatages milliseconde, finis, ordonnés et rétention exacte de quatre
  heures ;
- transitions monotones et champs d'identité immuables.

La sélection sérialise la décision sur la première paire, sans `SKIP LOCKED`
qui pourrait autoriser la seconde paire. Elle fige la paire et la lease dans
la même transaction. La reprise n'est admise que pour le même run et la même
paire après expiration authentifiée de sa lease ; elle ne relance jamais une
tentative réseau déjà terminale et relit les preuves exactes avant de décider.

## 4. Revendications exactes

Le repository de préparation expose des opérations bornées :

1. créer un run et capturer `statement_timestamp()` ;
2. sélectionner et verrouiller la première paire après watermark ;
3. revendiquer exactement la cible pour `DRY_RUN` ;
4. revendiquer exactement le sibling pour `SIMULATION` ;
5. renouveler la lease de préparation ;
6. terminer en `PREPARED` ou `FAILED` avec comparaison du token de lease ;
7. relire un snapshot de preuves sans mutation.

Chaque opération vérifie le run, la paire, la lane, le tuple économique et
causal, la deadline, la lease et l'état courant. Les erreurs publiques utilisent
uniquement les codes stables :

- `PREFLIGHT_PAIR_NOT_FOUND`
- `PREFLIGHT_PAIR_CONFLICT`
- `PREFLIGHT_PAIR_LINEAGE_INVALID`
- `PREFLIGHT_TARGET_NOT_PRISTINE`
- `PREFLIGHT_PROBE_NOT_PRISTINE`
- `PREFLIGHT_TARGET_FENCE_LOST`
- `PREFLIGHT_PREPARATION_LEASE_LOST`
- `PREFLIGHT_PREPARATION_DEADLINE_EXCEEDED`
- `PREFLIGHT_ASSESSMENT_INVALID`
- `PREFLIGHT_SIMULATION_FAILED`
- `PREFLIGHT_RECOVERY_CONFLICT`
- `PREFLIGHT_RPC_CAPACITY_UNVERIFIED`
- `PREFLIGHT_PREPARATION_EXPORT_FAILED`

Les messages restent constants et redacted.

## 5. Orchestrateur one-shot H2k-b

Le processus suit exactement ce flux :

```text
watermark PostgreSQL et deadline absolue
  -> première paire exacte après watermark
  -> dry-run exact de TARGET, non consommant
  -> simulation exacte de SIMULATION
  -> manifeste redacted atomique
  -> état PREPARED avec fingerprint du manifeste
  -> arrêt
```

Sa configuration accepte uniquement des durées bornées, un owner technique et
un chemin de sortie absolu hors dépôt. Elle n'accepte ni mint, ni identifiant de
paire/intention, ni SQL libre, ni URL RPC en argument ad hoc, ni option live.

Le polling ne change jamais le watermark et renouvelle la lease avant toute
opération réseau. Si aucune paire n'existe à la deadline, le même run passe en
`FAILED/PREFLIGHT_PAIR_NOT_FOUND` : aucun nouveau run n'est créé pour contourner
la fenêtre. Après reprise, un assessment ou artefact déjà lié est relu et n'est
jamais réexécuté.

Le manifeste est déterministe à partir des horodatages PostgreSQL : `createdAt`
vient du run, `preparedAt` est le `updated_at` produit par la liaison de
l'artefact, `expiresAt` est le minimum entre deadline et expiration de paire,
et `purgeAfter=preparedAt+4h`. Il est publié avant `markPrepared`. Une panne
entre ces deux opérations rejoue uniquement un fichier canonique byte-exact,
puis termine le même run par CAS ; une sortie différente est refusée.

## 6. Validation H2h v2 et handoff H2c

H2h v2 ouvre `REPEATABLE READ READ ONLY` et relit la paire, les deux intentions,
l'assessment, la tentative, l'artefact, la décision source et l'événement raw.
L'export est refusé sauf si :

- les identifiants appartiennent à la paire exacte ;
- la cible est pristine et le sibling est un BUY WSOL/SPL Token 9 décimales
  `PUMP_FUN_ONLY`, réussi en une tentative ;
- assessment et artefact sont les preuves exactes, cohérentes avec les
  fingerprints et révisions attendus ;
- les tuples économiques et causaux sont identiques ;
- décision et événement raw sont `finalized`, non orphaned et non remplacés ;
- toutes les TTL sont valides, l'artefact a au plus 30 secondes et la marge de
  publication de 5 secondes subsiste ;
- la capacité provider réservée à la sortie est encore vérifiée.

Les contrats historiques v1 restent lisibles mais ne peuvent pas autoriser une
cible appairée. H2c adopte un contrat versionné qui exige la preuve H2h v2 et
verrouille paire plus cible avant toute future promotion `live_reserved`.

Le wire contract H2c correspondant utilise `payloadVersion=3`. La désignation
produit « H2c v2 » décrit l'étape fonctionnelle ; `payloadVersion=2` reste
historique et est explicitement limité aux cibles non appairées.

### 6.1 Lignée causale attestée — migration 043

`execution_intents.candidate_id` est nullable pour préserver les archives mais
obligatoire pour toute nouvelle paire de préflight. La migration ajoute des FK
`NOT VALID` vers `trading_candidates(candidate_id)` et de
`execution_intents.decision_event_id` vers `domain_events(event_id)`. Le
backfill n'atteste que les chaînes historiques uniques et cohérentes ; une ligne
ambiguë reste `NULL` et ne peut pas entrer dans H2k-b.

La validation transactionnelle suit exclusivement :

```text
execution_intent.candidate_id
  -> trading_candidate.report_id/source_event_id/candidate_event_id
  -> qualification_report.raw_event_id
  -> domain_event.raw_event_id
  -> raw_chain_event finalisé et non orphaned
```

Le `decision_event_id` doit référencer l'événement de session attendu, de même
mint, dont le payload confirme les mêmes candidate et report. Le candidat, le
rapport et les événements ne doivent pas être superseded. Cette chaîne est
revalidée à la sélection H2k-b, à l'export H2h et immédiatement avant toute
promotion H2c ; une FK seule n'est jamais considérée comme une preuve de
fraîcheur.

## 7. Manifeste

`execution-preflight-intent-preparation-manifest.v1` est écrit par création
atomique, mode `0600`, sans overwrite, sans suivre de symlink, avec `fsync` du
fichier puis du dossier. Une relecture finale précède la publication.

Il contient seulement les identifiants et fingerprints de run, paire, cible,
assessment et artefact, les bornes temporelles et :

```json
{
  "state": "PREFLIGHT_INTENT_PREPARED",
  "canaryStatus": "CANARY_NOT_STARTED",
  "paperMainnet49Status": "NON_EXECUTED_NON_VALIDATED",
  "liveCapabilityPresent": false
}
```

Il ne contient jamais mint, montant, URL, token de lease, payload brut, secret,
clé, transaction sérialisée ou donnée signée.

## 8. Autorités et observabilité

Le rôle H2j obtient uniquement les lectures de paire nécessaires et les
fonctions exactes de préparation. H2h v2 obtient une lecture colonnaire minimale
et aucune mutation. Listener, readiness, API publique et rôles live ne gagnent
aucun droit. `PUBLIC`, grant options, ownership et schémas homonymes sont
refusés.

Les logs structurés exposent seulement run ID, état, reason code et durées. Ils
n'exposent pas le manifeste, les paramètres économiques ou la configuration
RPC.

## 9. Acceptation

- migrations 001–043 sur base vide, upgrades 041→042→043 et rejeu idempotent ;
- concurrence : la seconde paire n'est jamais substituée à la première ;
- crash/reprise : même run, même paire, lease authentifiée ;
- workers génériques incapables de prendre TARGET ou SIMULATION ;
- dry-run exact non consommant et simulation exacte terminale ;
- refus des courses, deadlines, 429, genesis divergent, finalité insuffisante,
  preuves périmées ou incohérentes ;
- manifeste atomique `0600`, redacted, non écrasable et supprimable après 4 h ;
- provisioning PostgreSQL 16 à privilèges minimaux ;
- `npm run build`, `npm run check`, `npm run lint`, `npm test` verts ;
- aucun wallet, armement, signer ou transport de soumission accessible.

Deux cycles de revue maximum sont autorisés pour cette PR.

## Historique

- 1.2.0 — fixe le polling et la reprise one-shot, les horodatages déterministes
  du manifeste, la lignée causale migration 043 et le wire contract H2c v3.
- 1.1.0 — ferme les résultats de reprise, lease, assessment et simulation par
  des reason codes de préparation distincts.
- 1.0.1 — précise l'unicité du run actif, la lease dès le watermark et la
  révision monotone nécessaire aux reprises CAS.
- 1.0.0 — conception H2k-b initiale.
