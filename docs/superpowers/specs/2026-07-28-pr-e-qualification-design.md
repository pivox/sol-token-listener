# PR E — Qualification minimale explicable

## But

Introduire un moteur de qualification pur et configurable pour les launches
Pump.fun, sans brancher encore de paper trading ni de décision de production.

## Décision

Le rapport V1 contient trois scores indépendants : préparation (15),
authenticité sociale (25) et santé on-chain (60). Les valeurs sont des entiers
en points ; leur somme est bornée à 100. Le seuil total par défaut est 60.

Les règles produisent des preuves immuables et des reason codes stables. Un
blocker mène toujours à `REJECTED`, quel que soit le score. Sans blocker mais
avec des données requises inconnues, le verdict est `WATCHLISTED` ;
`QUALIFIED` exige le seuil atteint et toutes les exigences configurées.

## Limites de la PR

- Le moteur reçoit des signaux déjà normalisés ; il ne collecte ni social,
  ni créateur, ni holders.
- Les rapports sont des contrats de domaine et ne sont pas encore persistés.
- Aucun ordre réel, aucune clé privée, aucun déclenchement de paper trading.

## Contrat

`QualificationEngine.evaluate(input)` renvoie un rapport gelé contenant
l’identité/version/statut du ruleset, les scores et maxima, les preuves, les
blockers dédupliqués, le verdict et une date d’évaluation canonique.

Les poids, seuils et exigences sont validés au constructeur. Un code de
blocker hors du registre est rejeté avant tout verdict.
