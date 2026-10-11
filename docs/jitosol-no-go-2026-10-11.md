# JitoSOL : résultat nul — 11 octobre 2026

Deux pistes ont été étudiées le même jour autour de JitoSOL. Les deux sont **NO-GO**. Le bot
livré reste désactivé ; aucun service ne tourne.

## 1. Décote JitoSOL (acheter sous la NAV, racheter à la NAV)

### Session réelle

Une session manuelle de quatre heures a été lancée par l'opérateur le 11 octobre 2026 à
12 h 56, heure de Paris, avec le lanceur Docker décrit dans le
[guide opérateur](jitosol-bot.md) : ticket de 3 SOL, un cycle au maximum, 0,001 SOL de frais
autorisés, arrêt observé à 0,5 SOL de perte estimée. L'opérateur a demandé l'arrêt à 16 h 34,
avant l'échéance de 16 h 56, une fois l'analyse ci-dessous établie ; le journal s'est arrêté en
état `paused` / `STOP_REQUESTED`, sans position ouverte.

| Résultat | Valeur |
|---|---:|
| Achats exécutés | 0 |
| Frais payés | 0 |
| Solde liquide, début et fin | 9,324704563 SOL |
| Observations refusées (12 h 56 → 16 h 13) | 1 144 |
| dont `STALE_QUOTE_CONTEXT` | 685 |
| dont `BELOW_PROFIT_THRESHOLD` | 386 |
| dont `OBSERVATION_UNAVAILABLE` | 73 |

### Mesure de la décote

Un observateur en lecture seule, séparé du bot, a relevé 89 devis Jupiter pour 3 SOL entre
15 h 00 et 16 h 30, heure de Paris, et la NAV du pool Jito au même slot. **JitoSOL se vendait
6,05 points de base sous la NAV** (prix 1,304927 SOL contre NAV 1,305717), sans variation
supérieure à 0,01 bp sur toute la période.

Décomposition de l'écart au seuil d'entrée, sur 3 SOL :

| Poste | SOL |
|---|---:|
| Décote captée (6 bp) | +0,0018 |
| Frais de retrait du pool Jito (0,1 %) | −0,0030 |
| Marge de slippage 10 bp (minimum garanti) | −0,0030 |
| Budget réseau | −0,0010 |
| Immobilisation 72 h à 6,5 %/an | −0,0016 |
| Profit minimal exigé | −0,0090 |
| **Écart au seuil** | **−0,0158** |

L'entrée exige une décote d'environ **58 bp** ; le marché en offrait 6. La décote observée est
inférieure aux seuls frais de retrait du pool : le trade perd même avec profit minimal et
immobilisation ramenés à zéro (−0,005 SOL ; −0,002 SOL en supposant une exécution sans marge
de slippage). Les planchers du schéma de configuration (profit ≥ 0,009 SOL, immobilisation
≥ 72 h à 6,5 %, ticket de 3 SOL) n'auraient de toute façon pas permis d'autres réglages.

### Le code `STALE_QUOTE_CONTEXT` n'est pas la cause

Il représente 60 % des refus, mais il se déclenche parce que le pool Manifest ou Raydium de la
route Jupiter traite rarement : son `updateContextSlot` reste inchangé pendant des minutes
(jusqu'à 334 slots relevés), et le contrôle `maxSourceSlotLag = 50` déclare périmé un prix
valide. Les relevés « frais » et « périmés » affichent la même décote de 6,05 bp ; 100 % des
89 relevés échouent sur l'économie, fraîcheur mise à part.

### Pourquoi la décote reste faible

Cet arbitrage est déjà pris par des teneurs de marché aux coûts plus bas, qui compriment l'écart
sous les frais du pool. Un écart figé à 6,05 bp pendant 1 h 30 est une cotation de teneur de
marché. Une décote de 58 bp n'apparaît que lors d'épisodes de stress ; attendre ces épisodes
avec du capital immobilisé n'a pas été étudié et n'est pas proposé.

### Décision

**NO-GO.** Ne plus lancer de session réelle par marché calme. Le code reste livré désactivé.
Une reprise exigerait une série historique montrant des décotes ≥ 58 bp fréquentes et captables,
puis le protocole complet de recherche.

Preuves locales, non commitées : journal de session
`/var/lib/sol/evidence/jitosol-manual-session-v1/state/events.jsonl` dans le conteneur `back`,
relevés de l'observateur `~/.sol-token-listener/jitosol-shadow/session-20261011T130037Z/`,
étude d'optimisation `docs/jitosol-optimization-evidence-2026-10-11.json` du répertoire de
travail. Le lanceur manuel, l'observateur et le tableau de bord développés le même jour n'étaient
pas commités à la rédaction de ce rapport.

## 2. Fourniture de liquidité SOL/JitoSOL (être le teneur de marché)

Piste inverse étudiée selon le protocole de recherche, arrêtée à l'étape 1 (vérification des
données), avant tout code de trading.

- **Payeur** : les échangeurs qui paient le frais de pool (1 bp) pour une conversion immédiate.
- **Référence** : détenir du JitoSOL, 4,86 %/an au 11 octobre 2026 (5,6 % sur 365 jours).
  La valeur d'un LP suit √p quand la détention suit p : sur une dérive annuelle s, le LP capte
  s/2 quelle que soit la largeur de sa fourchette. Ses frais nets en fourchette doivent donc
  dépasser **s/2 ≈ 2,43 %/an**, soit 2,8–2,9 % en frais bruts de pool (part LP de 87 % chez
  Orca et 84 % chez Raydium), avant temps hors fourchette et coûts de rééquilibrage
  (0,3–2 %/an sur ce capital).
- **Données** : DefiLlama Yields, séries quotidiennes de 626 à 1 343 jours pour Orca
  SOL-JITOSOL, Raydium CLMM 0,01 % et deux coffres Kamino, plus la référence de staking.
  Gel d'adaptateur identifié et exclu : série Orca figée du 25 mars au 25 novembre 2025.
- **Résultat** : frais bruts de **1,0 à 1,5 %/an** sur les 12 derniers mois, **0,2 à 0,3 %**
  en octobre 2026, en baisse continue depuis février ; aucun pool n'atteint la barre sur aucun
  mois depuis octobre 2025. Le seul régime où la stratégie payait (Raydium, février–mars et
  août–septembre 2025, volume 80 fois supérieur) a disparu. Avec 1 % de frais, un LP rend
  ~3,4 %/an contre 4,86 % en détention simple : sur 9,32 SOL, **−0,13 SOL/an** par rapport au
  staking (−0,09 à −0,24 selon le régime), avant coûts.
- **Concentration** : les coffres Kamino constituent 88–99 % de la liquidité des deux pools ;
  la « moyenne du pool » est déjà le rendement d'une position concentrée et rééquilibrée
  automatiquement. Battre cette moyenne à la main exige une fourchette 10 à 14 fois plus
  étroite dans le régime actuel ; meilleur cas plausible +0,09 SOL/an, régime actuel
  −0,20 SOL/an.
- **Décision** : **NO-GO**, confirmée par la revue indépendante du protocole
  (voir [revue](superpowers/reviews/2026-10-11-jitosol-lp-review.md)). Réouverture seulement si
  les frais bruts du pool dépassent 1,5 % (Raydium) ou 1,2 % (Orca) sur trois mois glissants,
  **et** si une concentration k ≥ 3 est mesurée, **et** si le coût d'un rééquilibrage est
  inférieur à 0,001 SOL.
- **Note de la revue sur la référence** : au 11 octobre 2026, jupSOL (5,53 %), INF (5,36 %) et
  hSOL (5,35 %) rapportent 0,5–0,7 %/an de plus que JitoSOL sans aucun travail ; tout plan
  futur doit se comparer à 5,3–5,5 %.

Rapport et données : `~/.sol-token-listener/lot5/evidence/research/jitosol-lp/`.

## Conclusion commune

Les trois chantiers de stratégie d'octobre 2026 (pump.fun, basis trade, JitoSOL) échouent pour
la même raison : nous sommes preneurs dans des arbitrages publics déjà comprimés par des acteurs
aux coûts plus bas, et même le côté teneur de marché de la paire SOL/JitoSOL ne couvre plus le
coût d'opportunité du staking. La référence à battre, détenir du JitoSOL, reste invaincue.
