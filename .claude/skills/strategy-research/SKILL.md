---
name: strategy-research
description: Protocole de recherche d'une stratégie de trading avant tout argent réel — payeur nommé, données d'abord, frais exacts, pré-enregistrement, confirmation hors échantillon, revue indépendante. À charger pour toute question « est-ce que telle stratégie / tel marché gagne ? ».
---

# Recherche de stratégie : le protocole

Ce protocole a produit le résultat nul documenté sur pump.fun (octobre 2026 : six familles
rejetées hors échantillon, dont trois qui paraissaient gagnantes en exploration). Il s'applique
tel quel à tout nouveau marché. L'ordre des étapes est la discipline ; les sauter est ce qui
fait perdre de l'argent.

## 0. Avant d'écrire une ligne de code
- **Nommer le payeur.** Qui perd systématiquement face à nous, et pourquoi il accepte de
  perdre (il paie un service, un levier, une urgence) ? Sans réponse en une phrase, on
  s'arrête là. « Les prix montent puis baissent » n'est pas un payeur.
- **Vérifier que notre position est tenable** : latence (secondes chez nous, millisecondes
  chez les bundlers), capital (~9 SOL : les rendements absolus sont petits, dire-le), frais.
- **Référence à battre** : staking liquide (~6,5 %/an). Une stratégie qui ne le bat pas
  nettement n'existe pas.
- **Aucun RPC payant, aucun listener, aucune transaction réelle sans go explicite de
  l'utilisateur.** Les données publiques gratuites d'abord.

## 1. Données
- Vérifier la source **avant** le backtest : profondeur (≥ 12 mois, idéalement 2 ans),
  granularité, trous, changement de régime (hack, relance, changement de frais). Une heure
  de vérification peut arrêter le chantier ; c'est son but.
- Conserver les fichiers bruts (JSONL/CSV) sous `~/.sol-token-listener/lot5/evidence/research/`,
  mode 600, avec un fichier de provenance (URL, date, nombre de lignes).
- Jamais de secret dans les scripts ni les sorties ; scripts de recherche dans
  `scripts/research/` (non commités par convention, sauf demande).

## 2. Modèle de trade exact
- Frais **par jambe** au taux réel du moment (palier, maker/taker), rente ATA, frais de
  priorité, slippage modélisé, pas une moyenne.
- Latence réelle : l'entrée se fait à l'échantillon **suivant** la décision, jamais au même.
- Pour toute position à levier : marge heure par heure, « aurait-on été liquidé ? ».
- Taille fixée (0,05 SOL pour pump.fun ; à fixer par chantier).

## 3. Pré-enregistrement, puis confirmation
- Couper les données en **exploration / confirmation** (par période, jamais au hasard).
- Explorer librement sur l'exploration. Puis **geler par écrit** (fichier daté, heure UTC) :
  la règle primaire, au plus 4 secondaires, le critère de succès, la taille, les frais.
- Ne regarder la confirmation qu'après le gel. Un seul passage.
- Critère de go standard : moyenne nette > 0 avec **borne basse de l'IC 95 % > 0** (bootstrap
  **par jour**, pas par trade), correction de Holm sur les secondaires, toujours > 0 sans le
  top 1 % des trades, aucun jour > 40 % du PnL, pire mois acceptable, ≥ N opportunités/jour.
- Reporter aussi le pire cas réaliste : latence doublée, frais +100 bps, entrée retardée.

## 4. Pièges déjà rencontrés (à vérifier explicitement)
- **Malédiction du gagnant** : la meilleure cellule d'une grille est biaisée ; le +945 bps à
  n = 69 est devenu −362 à n = 465. Toujours donner n et le nombre de cellules testées.
- **Paradoxe de Simpson** (créateurs « prouvés ») ; **pooling** de régimes différents (Mayhem).
- **Prémisse fausse non vérifiée** (« venue pas chère » : PumpSwap était à 125 bps, pas 25).
- **Adversaire qui choisit le moment** : si la perte est une seule transaction de l'opérateur,
  aucun stop ne l'évite ; mesurer l'anatomie des pertes avant de proposer un stop.
- **Survie** : 99 % des tokens pumpés valent 4 % un jour plus tard ; une règle « tenir » se
  teste sur tous les tokens, pas sur ceux qui existent encore.

## 5. Rapport et revue
- Rapport daté dans le dossier des preuves : question, données, modèle, règles gelées,
  tableau primaire + secondaires avec n / moyenne / IC / win / médiane / sans top 1 %,
  robustesse, économie (SOL/jour, jours avant d'épuiser le plafond de pertes), décision.
- **Revue indépendante** avant toute décision : un agent Fable 5.1 effort max, contexte
  frais, qui reçoit uniquement les données, les règles gelées et le rapport, avec mission de
  chercher les erreurs (signes, unités, fuseaux, frais oubliés, biais) et de décider GO / NO-GO.
  Sa décision s'applique.
- GO ⇒ phase shadow (décisions enregistrées, zéro lamport) avant la phase réelle, avec le
  plafond de pertes fixé par l'utilisateur sur le solde mesuré avant le premier trade.
- NO-GO ⇒ résultat nul écrit, mémoire mise à jour, rien ne tourne.
