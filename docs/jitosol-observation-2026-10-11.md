# Observation JitoSOL du 11 octobre 2026

L'étude est **inconclusive pour une décision de trading**. Aucun signal au seuil demandé n'a été relevé, et aucune transaction n'a été exécutée. Le bot livré reste désactivé.

Trois sessions distinctes ont produit 35 captures primaires : 34 calculables, dont 25 avec les contrôles de fraîcheur validés. Ces points corrélés ne sont pas des trades indépendants.

| Session | Captures | Calculables | Fraîcheur validée | Étendue observée |
|---|---:|---:|---:|---|
| Pilote | 3 | 3 | 3 | environ 60 s |
| Campagne initialement prévue sur 24 h, arrêtée à la demande | 2 | 2 | 1 | environ 60 s |
| Campagne prévue sur 30 min, terminée à 30 captures | 30 | 29 | 21 | environ 29 min |

La dernière session s'étend de 11:19:27 à 11:48:28, heure de Paris, à une cadence d'une minute. Une capture présente une erreur RPC et huit autres une fraîcheur de route non démontrée. Un ancien slot de mise à jour peut correspondre à une route inchangée ; ces points restent indicatifs.

Pour 3 SOL, toutes les quotes calculables de cette dernière session restituent moins de 3 SOL après les frais de retrait, même en retenant la quantité optimiste cotée : déficit d'environ **0,001113 SOL avant réseau**. En retenant le minimum de réception de l'API, le budget réseau de 0,001 SOL et un coût d'immobilisation conventionnel de 72 h à 6,5 % annuel, le surplus calculé va de **−0,006715189 à −0,006714479 SOL**. Le seuil requis était +0,009 SOL.

Les calculs sont entiers, avec frais de retrait arrondis vers le haut et conversion en SOL vers le bas. Les frais DEX déjà présents dans la quote ne sont pas déduits une seconde fois. Le bot utilise une borne de réception encore plus prudente pouvant différer d'une unité atomique JitoSOL de l'arrondi de l'API employé par ce rapport.

Cette fenêtre courte ne permet pas d'estimer une fréquence d'opportunités ou un rendement annuel. La cadence peut manquer des décotes brèves. La capacité de sortie, le coût effectif et un cycle financé n'ont pas été validés par cette observation. Aucun calcul de performance passée sur douze mois n'en découle.

Les 70 réponses publiques brutes ont été contrôlées par SHA256. Le rapport détaillé, ses manifestes et les données restent disponibles localement :

```text
~/.sol-token-listener/lot5/evidence/research/jitosol-discount/
  observation-20261011T090532Z/final-report/report-fr.md
  observation-20261011T090532Z/final-report/report.json
```

Les scripts de recherche et leurs tests sont dans `scripts/research/` du répertoire de travail d'origine. Les données brutes privées ne sont pas copiées dans Git. La collecte est terminée ; aucun observateur n'est laissé en arrière-plan.
