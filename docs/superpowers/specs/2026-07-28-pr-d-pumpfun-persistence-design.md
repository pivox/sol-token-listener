# PR D — Persistance Pump.fun : métadonnées et bonding curve

## Objectif

Ajouter un socle PostgreSQL idempotent pour conserver les observations Pump.fun
nécessaires au suivi d’un token : snapshots de métadonnées publiques,
snapshots de bonding curve et trades décodés. La PR ne compose pas le listener,
n’active aucun appel de production et n’envoie aucune transaction.

## Périmètre

La migration ajoute :

- `token_metadata_snapshots` : URI, statut de récupération, contenu normalisé,
  horodatage, version du schéma et empreinte du payload public ;
- `bonding_curve_snapshots` : mint, quote asset, réserves réelles et virtuelles,
  progression, état `complete` et curseur Solana complet ;
- `launch_trades` : achat/vente de bonding curve, montants entiers, trader,
  quote asset, curseur, confirmation et identifiant déterministe.

Les données sont liées à `token_launches`. Les valeurs financières restent des
entiers sérialisés en `NUMERIC(78,0)` ; aucun `float` ne représente un montant,
un prix ou une réserve.

## Architecture

`MetadataProvider` est un port asynchrone injecté. Son implémentation HTTP :

1. valide l’URI `http`/`https` ;
2. applique timeout, taille maximale et nombre borné de redirections ;
3. récupère un JSON public ;
4. normalise `name`, `symbol`, `description`, média, site, X et Telegram ;
5. retourne un résultat typé : snapshot résolu ou échec documenté.

Un échec réseau, JSON invalide ou contenu trop grand est stocké comme preuve
typée ; il ne fabrique aucune métadonnée. Les liens sociaux sont seulement
extraits : leur vérification appartient à la PR E.

`PumpFunBondingCurveStateReader` reste injecté. La PR fournit des contrats de
persistance et de projection, pas une lecture RPC composée au runtime. Chaque
snapshot inclut le mint de quote et ses décimales/programme afin de ne jamais
supposer SOL.

## Idempotence et finalité

Les clés naturelles sont :

- metadata : `mint + fetched_at + payload_hash` ;
- bonding curve : `mint + slot + transaction_index + instruction_index +
  inner_instruction_index` ;
- trade : identifiant déterministe émis par l’adaptateur.

Les écritures rejouées ne dupliquent pas les projections. Les statuts
`processed`, `confirmed`, `finalized` et `orphaned` restent conservés ; une
réconciliation de finalité met à jour la projection sans inventer de nouveau
trade.

## Rétention et confidentialité

Les snapshots publics suivent la politique existante : lorsque le lancement est
terminal, sans position paper ouverte, `purge_after = terminal_at + 4 heures`.
Le purgeur supprime les projections dépendantes avant le lancement. Aucun
secret, entête d’autorisation, wallet, clé privée, réponse RPC brute ou contenu
social privé ne doit être persisté.

## Tests et critères d’acceptation

- migrations rejouables sur base vide ;
- repositories idempotents et compatibles bigint ;
- metadata HTTP : URI invalide, timeout, redirection excessive, taille dépassée,
  JSON invalide et snapshot normalisé ;
- rétention de quatre heures et suppression ordonnée ;
- build, check, lint et tests existants verts ;
- `src/app.ts` inchangé et aucun chemin d’exécution réelle ajouté.

## Hors périmètre

La qualification, les scores, les blockers, le paper trading, la lecture RPC
de courbe, la migration PumpSwap, l’API front-end et l’analyse des wallets ne
font pas partie de PR D.
