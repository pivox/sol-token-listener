# PR F — Paper trading Pump.fun V1

## Objectif

Ajouter un ledger paper Pump.fun sûr, explicable, persistant et reprenable.
Cette PR comptabilise des entrées et sorties simulées à partir de cotations
validées. Elle ne construit, ne signe, ne simule et n’envoie aucune transaction
Solana.

## Périmètre

La PR ajoute :

- des contrats immuables de cotation, position et trade paper ;
- un `PaperTradingEngine` indépendant du listener, du RPC et des wallets ;
- une persistance PostgreSQL transactionnelle ;
- des identifiants déterministes et une reprise idempotente ;
- des calculs conservateurs de coût et de PnL en `bigint` ;
- la rétention quatre heures après fermeture.

Elle n’ajoute pas :

- de stratégie automatique de trailing stop, take profit ou temporisation ;
- de collecte de données on-chain ;
- de construction ou simulation de transaction ;
- de mode live ou de clé privée ;
- de support paper hors allowlist SOL/WSOL.

## Architecture

### Domaine

`src/domain/paper-trading.ts` définit :

- `PaperExecutionQuote` : quote mint, input/output, montants bruts, minimum
  conservateur, frais, slippage, price impact et référence au snapshot ;
- `PaperPosition` : identité, mint, quote asset, stratégie, statut, quantité,
  coût, produit de sortie, PnL et dates ;
- `PaperTrade` : BUY ou SELL, quote utilisée, fill conservateur et raison ;
- les commandes d’ouverture et de fermeture ;
- les erreurs typées stables.

Les montants financiers et les basis points sont des `bigint`. Les dates sont
des millisecondes entières canoniques. Les objets produits sont gelés.

### Moteur

`PaperTradingEngine` dépend uniquement :

- d’une configuration `observe|paper`, allowlist et rétention ;
- d’un `PaperTradingRepository` ;
- de l’`EffectiveQualificationProfile` déjà chargé, injecté comme autorité de
  politique sans rechargement ni I/O implicite ;
- d’une `QualificationReportAuthority` process-local, fournie par le même
  `QualificationEngine` qui évalue les rapports ;
- d’une horloge injectée pour des tests déterministes.

L’ouverture exige :

- `EXECUTION_MODE=paper` ;
- la référence exacte d’un rapport émis par l’autorité injectée : une copie,
  une reconstruction ou un rapport désérialisé est refusé avant transaction ;
- un rapport `QUALIFIED` sans blocker ;
- une identité de ruleset (id, version, statut, fingerprint et score minimum),
  des modes de conditions et des seuils identiques au profil effectif injecté ;
- un quote mint autorisé ;
- une quote BUY et une quote SELL inverse compatibles ;
- une quantité et un résultat conservateur strictement positifs ;
- une perte aller-retour inférieure au plafond fourni dans la commande.

Le moteur remplit au `minimumAmountOutRaw`. Il ne promet donc ni prix réel, ni
sellabilité, ni profit.

L’autorisation de rapport est volontairement non sérialisable et ne survit pas
au redémarrage du processus. Après restart, l’appelant doit reconstruire les
inputs depuis des sources de confiance et les réévaluer avec le
`QualificationEngine` injecté. Le paper trading n’étant pas encore composé dans
le bootstrap de production, cette contrainte devra être respectée par sa future
composition, sans relecture implicite de profil dans le moteur paper.

La fermeture vend exactement la quantité paper encore détenue et utilise
également `minimumAmountOutRaw`. La V1 ferme la position entièrement.

### Calculs

Pour une entrée :

```text
baseFilledRaw = buy.minimumAmountOutRaw
quoteCostRaw = buy.amountInRaw
```

Pour la vérification aller-retour :

```text
roundTripReturnRaw = reverseSell.minimumAmountOutRaw
roundTripLossRaw = max(quoteCostRaw - roundTripReturnRaw, 0)
roundTripLossBps = ceil(roundTripLossRaw * 10_000 / quoteCostRaw)
```

Pour une fermeture :

```text
quoteProceedsRaw = sell.minimumAmountOutRaw
grossPnlQuoteRaw = sell.amountOutRaw - quoteCostRaw
netPnlQuoteRaw = quoteProceedsRaw - quoteCostRaw
```

Les divisions arrondissent explicitement. Aucun `number` n’intervient dans un
calcul financier.

## Idempotence et transactions

L’identifiant de position est dérivé du mint, de la stratégie, de sa version et
de l’événement déclencheur. Les trades BUY et SELL sont dérivés de la position
et du côté.

Le repository exécute chaque commande dans une transaction PostgreSQL :

1. verrouillage ou lecture de la position par identifiant ;
2. détection d’un replay ;
3. insertion append-only du trade ;
4. création ou mise à jour de la projection position ;
5. insertion de l’événement métier correspondant ;
6. commit atomique.

Un replay identique renvoie la projection existante. Un replay contradictoire
échoue avec une erreur typée et n’écrit rien. Le verrou advisory sérialise aussi
deux ouvertures concurrentes lorsqu’aucune ligne n’existait au premier
`SELECT`.

Une montée `processed -> confirmed -> finalized` enrichit atomiquement
l’événement paper existant. Un déclencheur non finalisé ensuite réconcilié
`orphaned` rend la position `PAPER_RETRACTED`, sans inventer de trade
compensatoire. La position, ses trades et ses événements deviennent terminaux
et purgeables après la fenêtre de rétention. Une transition
`finalized -> orphaned` reste un conflit de finalité.

## Persistance

La migration crée :

- `paper_positions` ;
- `paper_trades`.

Une seule position active est autorisée par mint et stratégie V1. Les colonnes
financières utilisent `NUMERIC(78,0)`. Les payloads conservent la quote et les
preuves versionnées.

Une position ouverte n’a pas de `purge_after`. À la fermeture ou à la
rétractation :

```text
purge_after = closed_at + DATA_RETENTION_HOURS
```

Les trades sont supprimés avec leur position par cascade.

## Événements

Le repository persiste un événement source-indépendant :

- `PaperPositionOpened` ;
- `PaperPositionClosed`.

`PaperPositionUpdated` reste réservé aux futures sorties partielles et
réévaluations. Les événements réutilisent l’événement déclencheur comme preuve
et n’inventent aucun curseur on-chain. Leur statut de confirmation est
réconcilié sur replay, y compris jusqu’à `orphaned`.

## Tests et acceptation

Les tests couvrent :

- refus du mode `observe` sans écriture ;
- refus d’un verdict non qualifié ou d’un blocker ;
- refus d’un quote mint hors allowlist ;
- calcul conservateur de l’aller-retour et du PnL ;
- validation des montants et basis points ;
- ouverture et fermeture atomiques ;
- replays idempotents et contradictions ;
- reprise d’une position ouverte ;
- rétention quatre heures ;
- absence de wallet, signer, transaction builder et envoi.

La PR est acceptable lorsque `npm test`, `npm run build`, `npm run check`,
`npm run lint` et les migrations sur base vide passent sans régression.
