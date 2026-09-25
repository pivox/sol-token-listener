# Runbook de validation paper MVP Mainnet

Cette procédure produit une preuve one-shot `paper-mvp.v3` autour du runtime
paper existant. Elle ne charge aucune clé, ne signe et ne soumet aucune
transaction. La campagne historique de 50 positions reste distincte et non
validée.

## Préparation

1. Appliquer les migrations avec `npm run db:migrate`.
2. Configurer `SOLANA_CLUSTER=mainnet-beta`, `EXECUTION_MODE=paper`,
   `LISTENER_ENABLED=true`, `CREATION_STRATEGY_ENABLED=true`,
   `PAPER_STRATEGY_ENABLED=true`, `PAPER_STRATEGY_ID=creation-entry-v1`,
   `PAPER_STRATEGY_VERSION=1` et
   `PAPER_QUOTE_MINT_ALLOWLIST` avec exactement `WSOL_MINT`.
3. Sélectionner explicitement
   `QUALIFICATION_PROFILE_PATH=config/qualification/pumpfun-mvp-technical-v1.json`.
   Ne pas définir `QUALIFICATION_MIN_SCORE` : le minimum appartient au profil
   versionné et à son fingerprint.
4. Configurer explicitement le montant d'entrée, le slippage, la perte
   aller-retour, `EXTERNAL_UNIQUE_BUYERS_TARGET` (1–1000), le minimum par achat
   externe et la prise de profit (10000–1000000 bps). Aucun de ces nombres ne
   constitue une recommandation financière.
5. Choisir un chemin `.json` inexistant. La commande ne l'écrase jamais.

Lancer :

```bash
npm run paper:mvp -- \
  --target-closed=1 \
  --max-duration-seconds=14400 \
  --poll-seconds=5 \
  --initial-capital-raw=1000000000 \
  --network-fee-raw-per-transaction=5000 \
  --report-file=paper-mvp.json
```

Dans l'image de production déjà compilée, utiliser la même liste d'arguments
avec `npm run paper:mvp:compiled --`. Le run one-shot exige
`--target-closed=1`; toute autre cible produit honnêtement un cycle fonctionnel
`INCOMPLETE` dans le rapport v3.

Les bornes inclusives sont : cible 1–1000, durée 60–14400 secondes, poll
1–60 secondes, capital initial positif et frais réseau non négatifs sur au
plus 78 chiffres décimaux. Les six arguments sont obligatoires, une seule fois,
sous la forme canonique `--nom=valeur`.

## Arrêt, reprise et résultat

Le processus acquiert son verrou PostgreSQL de runner, applique les migrations,
revendique le run durable, puis seulement démarre le listener ou l'API. Il
vérifie sa propriété avant et après chaque étape de démarrage, puis collecte
sériellement. Chaque mutation durable porte aussi l'identifiant
opaque du propriétaire courant. Une perte de la session du verrou arrête donc
le processus avec le code `1` sans terminaliser le run : il reste `RUNNING` et
reprenable, tandis qu'un propriétaire remplacé ne peut plus progresser ni
terminaliser la ligne.
Après crash, la même commande reprend uniquement la configuration immuable
exacte du run `RUNNING`. La configuration durable v3 fige les montants d'entrée,
slippage, finalité minimale, fenêtres et fraîcheur des quotes, limites de slot,
minimum d'achat externe, cibles de dix acheteurs et de prise de profit à 2x,
kill switch, perte aller-retour maximale, paramètres de poll/lease/retry et
fingerprint du profil de qualification effectif. Ces valeurs sont dupliquées
dans des colonnes contrôlées et un payload versionné, sans chemin local, URL ni
secret. Une ligne v1 ou v2 ne contient pas tous ces faits et est refusée sans
revendication ni backfill. Une configuration différente ou un second runner
échoue sans adopter ni faire progresser le run.

La cible produit le rapport terminal historique v2 durable, puis l'export
additif v3. `oneShotCycle.functionalStatus=COMPLETED` exige exactement un BUY,
un SELL, aucune position restante, aucune terminalité inconnue et aucun
doublon logique. Le PnL est séparé dans `profitability`; une perte n'est jamais
masquée, mais ne transforme pas à elle seule une preuve fonctionnelle complète
en cycle incomplet. Le seuil N effectif et son atteinte figurent dans
`externalUniqueBuyers`.

Deadline, `SIGINT` et `SIGTERM` demandent
une dernière collecte bornée à cinq secondes, puis produisent toujours un run
`COMPLETED` et un rapport exporté non-PASS. Le champ `completionReason` vaut `TARGET_REACHED`, `TIMEOUT`,
`SIGINT` ou `SIGTERM`. `TIMEOUT` ajoute la gate `RUN_TIMED_OUT`; les deux signaux
ajoutent `RUN_INTERRUPTED`. Ces trois raisons imposent `technicalStatus=DEGRADED`
et `verdict=FAIL`, même si la dernière collecte atteint la cible. Si la cible
reste incomplète, `CLOSED_POSITIONS_BELOW_TARGET` s'ajoute également.
Un second signal force la fin de cette dernière tentative. La perte du verrou
reste prioritaire et laisse le run reprenable.

`LEGACY` est réservé au backfill des rapports terminaux antérieurs à la migration
021 et n'est jamais produit par cette commande. Il ajoute uniquement le champ de
compatibilité : verdict, statut technique et gates historiques restent inchangés.

Le rapport v2 expose aussi `openedPositions` (positions `creation-entry-v1`
ouvertes dans la fenêtre inclusive allant du début du run au minimum entre le
snapshot courant et sa deadline immuable) et `openPositions` (sous-ensemble
encore `PAPER_HOLDING` lors du snapshot). Les moyennes de slippage et d'impact
sont des divisions entières arrondies vers le bas des seuls samples clos, et
valent zéro sans sample. La migration 024 initialise uniquement les nouvelles
colonnes de compteurs. Les payloads historiques `paper-mvp.v1` restent immuables
et ne contiennent ni ces deux compteurs ni les quatre moyennes d'exécution.
Pendant qu'un run reste `RUNNING`, la purge protège toutes ses positions ouvertes
dans sa fenêtre, leurs trades et jobs, y compris les positions déjà échantillonnées
ou encore ouvertes. La rétention normale reprend seulement après terminalisation.

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
