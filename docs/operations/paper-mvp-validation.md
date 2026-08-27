# Runbook de validation paper MVP Mainnet

Cette procédure produit une preuve `paper-mvp.v1` autour du runtime paper
existant. Elle ne signe et ne soumet aucune transaction.

## Préparation

1. Appliquer les migrations avec `npm run db:migrate`.
2. Configurer `SOLANA_CLUSTER=mainnet-beta`, `EXECUTION_MODE=paper`,
   `LISTENER_ENABLED=true`, `CREATION_STRATEGY_ENABLED=true`,
   `PAPER_STRATEGY_ENABLED=false`, `PAPER_STRATEGY_VERSION=1` et
   `PAPER_QUOTE_MINT_ALLOWLIST` avec exactement `WSOL_MINT`.
3. Configurer les seuils paper/création requis décrits dans le README, sans
   clé privée ni capacité de signature/soumission.
4. Choisir un chemin `.json` inexistant. La commande ne l'écrase jamais.

Lancer :

```bash
npm run paper:mvp -- \
  --target-closed=50 \
  --max-duration-seconds=14400 \
  --poll-seconds=5 \
  --initial-capital-raw=1000000000 \
  --network-fee-raw-per-transaction=5000 \
  --report-file=paper-mvp.json
```

Les bornes inclusives sont : cible 1–1000, durée 60–14400 secondes, poll
1–60 secondes, capital initial positif et frais réseau non négatifs sur au
plus 78 chiffres décimaux. Les six arguments sont obligatoires, une seule fois,
sous la forme canonique `--nom=valeur`.

## Arrêt, reprise et résultat

Le processus acquiert son verrou PostgreSQL de runner avant de démarrer le
listener ou l'API, puis collecte sériellement. Une perte de la session du verrou
terminalise le run `FAILED` avec `RUNNER_LOCK_LOST` avant toute reprise.
Après crash, la même commande reprend uniquement la configuration immuable
exacte du run `RUNNING`. Une configuration différente ou un second runner
échoue sans adopter ni faire progresser le run.

La cible produit le rapport terminal. Deadline, `SIGINT` et `SIGTERM` demandent
une dernière collecte. Si la cible n'est pas atteinte, le rapport contient
`CLOSED_POSITIONS_BELOW_TARGET`. Si une interruption gagne alors qu'une dernière
collecte vient d'atteindre la cible, le run devient `FAILED` avec un code stable
au lieu de publier un `PASS` accidentel.

Codes processus :

- `0` : verdict `PASS` uniquement ;
- `2` : résultat terminal honnête `FAIL` ou `DEGRADED` ;
- `1` : erreur de configuration, données, ressource, concurrence ou export.

L'usage fournisseur est `UNAVAILABLE` par défaut (`null` pour les crédits,
zéro 429 observé). Ce zéro n'est pas une preuve de santé et le rapport reste
`DEGRADED` jusqu'à l'ajout explicite d'un adaptateur autoritatif.

## Échec d'export

La transaction PostgreSQL est terminale avant la création du fichier. Si le
chemin existe, si ses permissions échouent ou si le stockage devient
indisponible, le processus sort `1` mais ne modifie pas le résultat durable.
Ne relancez pas le runner : exportez `report_payload` du run terminal vers un
nouveau fichier inexistant avec permissions `0600`, puis vérifiez le JSON et
son hash. Aucun URL, secret, credential ou message d'erreur brut ne fait partie
du payload.
