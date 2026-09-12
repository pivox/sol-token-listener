# Horodatage d’observation durable de l’inbox

**Version :** 1.0.0 — 2026-09-12

## Contexte

Une exécution peut persister une partie de ses projections puis échouer. Lors
de sa reprise, le pipeline reconstruisait l’observation depuis `Date.now()`.
Les événements immuables déjà écrits conservent pourtant leur premier
`observedAt`; une étape ultérieure, notamment `funding_observation`, peut donc
recevoir une observation contradictoire et refuser le rejeu.

## Décision

`chain_transaction_inbox.observed_at` est l’autorité temporelle de chaque
signature. Le repository le retourne avec chaque lease dans
`ClaimedTransaction.observedAtMs`. Le worker le transmet, sans transformation,
à `TransactionInboxWorkerPipeline.process(transaction, observedAtMs)`.
`ObservedTransactionPipeline.process` exige ce second argument et l’emploie
exclusivement pour `createSolanaObservedTransaction`; il ne possède plus de
clock de fallback.

Une montée de finalité, un redémarrage, une reprise après persistance partielle
et une lecture du snapshot durable conservent ainsi le même instant. La
finalité peut changer, jamais l’instant d’observation.

## Hors périmètre

La colonne existe déjà : aucune migration n’est ajoutée. Les filtres, appels
RPC, décodeurs, indices d’ingestion et taxonomies d’événements ne changent pas.

## Vérification

Les régressions couvrent le contrat de claim, le passage worker → pipeline et
l’emploi exact du timestamp dans le pipeline. Un test PostgreSQL vérifie aussi
que le claim relit l’`observed_at` persistant, plutôt que l’heure du retry.
