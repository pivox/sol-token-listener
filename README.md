# sol-token-listener

Backend TypeScript destiné à détecter, qualifier et simuler le suivi de nouveaux
tokens Pump.fun, de leur création jusqu’à leur éventuelle activation sur
PumpSwap.

Le projet compile et teste les contrats génériques, la normalisation Solana,
la persistance PostgreSQL, le décodeur Pump.fun et Raydium CPMM historique.
L’adaptateur Pump.fun reste volontairement non composé dans le bootstrap : le
programme ne démarre donc pas encore de listener de production.

## Limites de sécurité V1

- `EXECUTION_MODE=observe` par défaut ;
- seuls `observe` et `paper` sont acceptés ;
- le paper trading est initialement limité à SOL/WSOL par allowlist ;
- aucune clé privée n’est lue ou acceptée ;
- aucune transaction n’est signée ou envoyée ;
- le dashboard historique est strictement en lecture seule ;
- aucune promesse de première position, de même slot, de sellabilité ou de
  profit.

Le code Raydium CPMM est conservé comme adaptateur secondaire. Son décodage de
fixtures reste testé, mais sa construction de transactions et ses cotations ne
sont pas composées dans le bootstrap Pump.fun V1.

## Installation

Prérequis : Node.js 22+ et PostgreSQL pour les commandes de migration.

```bash
npm install
cp .env.example .env
npm run build
npm run check
npm run lint
npm test
```

Renseigner `SOLANA_HTTP_RPC_URL`, `SOLANA_WS_RPC_URL` et `DATABASE_URL` sans
ajouter de secret de wallet. Les migrations sont désactivées par défaut au
démarrage :

```bash
npm run db:migrate
```

`npm start` valide actuellement la configuration, applique éventuellement les
migrations et publie un événement structuré `listener.foundation_ready`. Il ne
compose pas encore l’adaptateur Pump.fun ni aucun listener réseau.

## Architecture

- [Architecture Pump.fun V1](docs/architecture/pumpfun-v1.md)
- [Contrats API V1](docs/api/v1.md)
- [Décisions de conception PR A](docs/superpowers/specs/2026-07-28-pr-a-foundation-design.md)

Les montants bruts, réserves et lamports utilisent `bigint`. Dans PostgreSQL ils
sont stockés en `NUMERIC(78,0)` ; dans les futurs contrats JSON ils seront
exposés comme chaînes décimales.

## Persistance et rétention

Les migrations sont ordonnées, transactionnelles et idempotentes. Les événements
bruts sont séparés des projections métier. Une ligne ne reçoit `purge_after`
qu’une fois le suivi terminal et toute position paper fermée ; elle devient
supprimable quatre heures plus tard. Le purgeur supprime dans l’ordre les
transitions, événements métier, événements bruts non référencés, puis les
lancements.

Le jeu de règles de qualification initial est explicitement marqué
`UNVALIDATED_RULE_SET`. Les seuils devront être calibrés sur des données réelles
avant d’être présentés comme significatifs.
