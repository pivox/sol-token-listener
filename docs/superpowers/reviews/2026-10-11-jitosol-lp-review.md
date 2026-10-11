# Revue indépendante — fourniture de liquidité SOL/JitoSOL (rapport d'étape 1)

Date : 2026-10-11, 14:57 UTC. Relecteur : agent Fable 5.1, contexte frais, effort max, sans
contexte préalable. Protocole appliqué : `.claude/skills/strategy-research/SKILL.md` (§5, revue
indépendante). Aucune transaction, aucun RPC, aucune clé ; réseau limité à `yields.llama.fi` et à
des pages de documentation publiques (Orca, Raydium, adaptateurs DefiLlama).

## Pièces examinées

- `~/.sol-token-listener/lot5/evidence/research/jitosol-lp/report-20261011.md` (14:40 UTC).
- `raw/provenance.txt` (récupération 14:37:36 UTC), `raw/pools-all.json` (16 882 pools),
  `raw/chart-orca-sol-jitosol.json` (1 343 lignes), `raw/chart-raydium-wsol-jitosol-clmm-1bp.json`
  (626), `raw/chart-kamino-sol-jitosol.json` (1 023), `raw/chart-kamino-jitosol-sol-2.json` (828),
  `raw/chart-jito-liquid-staking.json` (565). Nombres de lignes conformes à la provenance.
- `scripts/llama_chart_stats.py` et `scripts/llama_filter.py`, exécutés avec `python3 -I` : leurs
  sorties reproduisent les tableaux du rapport.
- Recalculs indépendants (scripts de session, non conservés) à partir des fichiers bruts ; tous les
  chiffres ci-dessous en proviennent.
- Compléments consultés : trois séries supplémentaires DefiLlama récupérées à 14:48 UTC
  (`/chart/d10d3258-…` jupSOL/JitoSOL Orca, `/chart/d7d14b5c-…` mSOL/JitoSOL Orca,
  `/chart/fdcccd6a-…` troisième coffre Kamino SOL-JITOSOL) ; `docs.orca.so/liquidity/concepts/trading-fees`,
  `docs.orca.so/reference/fees` ; `docs.raydium.io/reference/fee-comparison` ; adaptateurs
  `DefiLlama/yield-server` (`orca-dex/index.ts`, `kamino-liquidity/index.js`, `raydium-amm/index.js`).

## Vérifications

### 1. Définition de `apyBase` et instantané du jour

- Adaptateur Orca : `apyBase = stats["24h"].fees / tvlUsdc × 365 × 100` (API `api.orca.so/v2`).
  Recalcul : 185 797,94 $ × 0,0001 × 365 / 6 239 146 $ = 0,1087 % ; affiché 0,10864 % (écart
  0,05 %, arrondi ou fenêtre). Taux de frais implicite = 1,00 bp : le chiffre est **brut**. Frais
  totaux du pool ce jour : 18,58 $.
- Adaptateur Raydium : `apyBase = day.feeApr` (API Raydium v3). Recalcul : 122 975,51 $ × 0,0001 ×
  365 / 1 789 842 $ = 0,2508 % ; affiché 0,25 %. Brut. Frais totaux : 12,30 $/jour.
- Adaptateur Kamino : `apyBase = kaminoApy.vault.apy24h × 100` (API Kamino), c'est-à-dire le
  rendement réalisé du coffre sur 24 h, pas une formule volume × frais. Le taux implicite
  (0,86–0,87 bp) est inférieur à 1 bp, cohérent avec un chiffre net.
- Part protocole, d'après les documentations : Orca **87 % aux LP**, 12 % trésorerie, 1 % fonds
  climat ; Raydium CLMM **84 % aux LP**, 12 % protocole, 4 % fonds (`protocol_fee_rate = 120000`,
  `fund_fee_rate = 40000`), palier 0,01 % avec tick spacing 1. Le LP touche donc 0,87 × `apyBase`
  (Orca) et 0,84 × `apyBase` (Raydium). Le rapport dit « moins » sans chiffrer : direction exacte.
- Unités : pour cent par an. Cohérence : 0,1087 %/an × 6,24 M$ / 365 = 18,6 $/jour = volume × 1 bp.
  Le staking Jito à 4,88 est bien 4,88 %/an.

### 2. La barre « moitié du staking »

- Démonstration : la valeur d'un LP pleine gamme en SOL est proportionnelle à √p (p = prix du
  JitoSOL en SOL), la détention de JitoSOL à p. Sur un an à s = 4,86 % : √1,0486 = 1,0240 contre
  1,0486 ; le LP capte 2,40 points sur 4,86, soit la moitié moins 0,03 point d'IL. Pour une
  position concentrée [pa, pb] traversée par la dérive, valeur finale / valeur si détention =
  √(pa/pb) ; pour une largeur w la perte est ≈ w/2 par traversée et il y a s/w traversées par
  an : perte ≈ s/2 par an, **indépendante de la largeur**. Une position 100 % JitoSOL placée
  au-dessus du prix rapporte s tant qu'elle est hors fourchette mais ne touche aucun frais ; dès
  qu'elle est en fourchette, mêmes économies. Conclusion : les frais nets perçus **en fourchette**
  doivent dépasser s/2. La barre du rapport est correcte et le choix de la fourchette ne
  l'abaisse pas.
- Ce qui la relève : part protocole (`apyBase` brut requis = 2,43/0,87 = **2,79 %** sur Orca,
  2,43/0,84 = **2,89 %** sur Raydium, à 4,86 % de staking) ; temps hors fourchette ; coûts de
  rééquilibrage : ~3 transactions (collecte/fermeture, swap, ouverture), 0,0005–0,002 SOL de frais
  réseau et priorité, 1 bp sur la moitié de la position (0,00005 SOL), loyer de position
  0,0088 SOL remboursable, TickArray 0,07 SOL non remboursable (rare près de la NAV) ; à
  50–100 rééquilibrages par an : 0,03–0,2 SOL, soit **0,3–2 %/an de 9,32 SOL**. La LVR hors
  dérive est faible sur cette paire (décote qui revient à la moyenne, actif remboursable) ; la
  dérive elle-même est le terme s/2.
- Ce qui la baisserait : le SOL d'une position CLMM ne peut pas être prêté (non) ; les
  récompenses Raydium ont plafonné à 0,87 %/an en moyenne mensuelle et sont nulles depuis juin
  2026 (non) ; un pool JitoSOL/autre LST, dont la barre est ≈ 0,5 × |écart de staking| ≈ 0,3 %/an
  (jupSOL 5,53 % contre JitoSOL 4,88 % au 2026-10-11) : examiné au point 7, ne renverse pas.

### 3. Statistiques, trous, périodes figées, unités

- Profondeur et trous (par date UTC) : Orca 1 343 points, 2023-02-06 → 2026-10-11, 1 trou (1 jour
  manquant, 2026-06-17) ; Raydium 626, 1 trou (2026-09-11) ; Kamino SOL-JITOSOL 1 023, 31 trous
  (40 jours manquants) ; Kamino JITOSOL-SOL 828, 29 trous (38 jours) ; Jito 565, 0 trou. Aucune
  valeur nulle, aucune date dupliquée. Instantanés à 23:01 UTC, dernier point intraday à 14:01 UTC.
- Le script de l'auteur prend « les 365 derniers points » (≈ 405 jours pour Kamino à cause des
  trous). Par fenêtre de dates (2025-10-12 → 2026-10-11) les moyennes sont identiques à trois
  décimales : Orca **1,076** (1,071 hors gel), Raydium **1,498**, Kamino **0,789 / 0,768**, Jito
  **5,608**. Sans le top 1 % des jours : 0,973 / 1,444 / 0,727 / 0,680. Sur 90 jours : 0,49 / 0,70 /
  0,36 / 0,35. Sur 30 jours : 0,30 / 0,45 / 0,23 / 0,27.
- Période figée Orca : exactement **2025-03-25 → 2025-11-25, 246 points** à `apyBase` 1,11534 et
  TVL 31 439 174 $ (le rapport dit « avril → novembre »), plus deux runs courts 2025-02-28 →
  03-05 (6 points) et 03-13 → 03-19 (7 points). Le gel est à l'échelle de l'adaptateur Orca : le
  pool mSOL/JitoSOL est figé à 0,79 % / 794 418 $ sur la même période. Exclusion : moyenne
  365 jours 1,071 contre 1,076, sans effet sur la conclusion.
- Erreur de lecture : la « médiane depuis l'origine 1,12 » d'Orca est la valeur figée elle-même
  (246 jours à 1,11534 sur 1 343) ; hors gel, la médiane depuis l'origine est 1,26–1,29
  (n = 1 084–1 097). Toujours sous la barre : sans conséquence.
- Table mensuelle : reproduite à ±0,05 point (l'auteur prend l'élément n//2 et non la vraie
  médiane). Barre **contemporaine** (0,5 × staking du mois) : aucun pool ne l'atteint sur aucun
  mois depuis 2025-10. Raydium l'a dépassée 4 mois sur 21 (2025-02, 03, 08, 09 ; en septembre
  2025 : 5,70 % contre 3,28 %), tous hors de la fenêtre 365 jours et hors de la table du rapport,
  qui commence en 2025-12. Jour par jour sur 12 mois : Raydium ≥ barre 49 jours sur 364 (13 %),
  Orca 22 sur 319 (7 %) ; moyenne de (`apyBase` − barre) = −1,31 point (Raydium) et −1,71 point
  (Orca).
- Pics : Orca 188,28 % le **2025-01-21** (le rapport dit le 19), TVL 36,9 M$, volume implicite
  1,9 G$ sur la journée, invraisemblable (artefact probable) ; Raydium 116,88 % le 2025-02-18.
  Les inclure gonfle les moyennes, donc favorise la stratégie ; la conclusion tient.
- Volume implicite (`apyBase` × TVL / 1 bp), moyenne mensuelle : Raydium 14,3 M$/jour en
  septembre 2025 → 0,18 M$/jour en octobre 2026 (÷ 80) ; Orca 4,8 M$/jour en novembre 2025 →
  0,41 M$/jour (÷ 12). Le rapport parle d'une TVL ÷ 5–6 ; le volume a baissé davantage.
- Staking : 4,88 % au dernier point (4,86 % = moyenne 30 jours), 5,61 % sur 365 jours, 8,0–8,3 %
  en mars–mai 2025. Conforme.

### 4. Économie sur 9,32 SOL

- Détention : 9,32 × 4,86 % = 0,4530 SOL/an. LP à (0,5 × 4,86 + 1,0) % = 3,43 % : 0,3197 SOL/an.
  Écart **−0,133 SOL/an** : signe et montant exacts.
- Variantes : frais d'octobre 2026 (0,23 / 0,34 %) : −0,205 / −0,195 ; Raydium 365 jours (1,51 %) :
  −0,086 ; avec la part LP (0,87 / 0,84) sur les frais 365 jours : −0,16 (Orca) / −0,11 (Raydium) ;
  staking 365 jours (5,61 %) en référence : −0,17 à −0,24. Égalité à 2,43 % de frais nets.
- Unités : `apyBase` est un ratio USD/USD entre deux actifs libellés en SOL, donc identique en SOL.
- Non chiffré par l'auteur : la valeur en dollars du capital, nécessaire aux coûts fixes par
  transaction. À 100–200 $/SOL la position vaut 0,9–1,9 k$ ; chaque rééquilibrage coûte
  0,05–0,30 $, soit 0,3–2 %/an à 50–100 rééquilibrages.

### 5. « La gestion active n'y change rien » (coffres Kamino)

- Prémisse fausse : les coffres ne sont pas une contre-vérification indépendante, **ils sont les
  pools**. Kamino SOL-JITOSOL (`55616349…`) : TVL = 0,99 × TVL du pool Orca (médiane 2026,
  p10 0,91, p90 1,15 ; 0,995 sur 2024-01 → 2025-03), corrélation quotidienne des `apyBase` 0,92 en
  2026. Troisième coffre Kamino SOL-JITOSOL (`fdcccd6a…`, absent du rapport) : TVL = 0,88 × TVL du
  pool Raydium (médiane 2026, p10 0,82, p90 0,98), `apyBase` ≈ 0,84 × celui de Raydium. Les deux
  pools sont donc à 88–99 % de la liquidité gérée par Kamino ; « pas mieux que la moyenne des
  pools » est une tautologie.
- Ce que cela implique : la liquidité des deux pools est déjà une stratégie concentrée et
  rééquilibrée automatiquement ; la « moyenne du pool » est le rendement de cette stratégie. Une
  position tenue à la main ne capte davantage que si sa fourchette est plus étroite que celle du
  coffre : part des frais ≈ (notre valeur / valeur du coffre) × k, avec k = largeur du coffre /
  notre largeur ; rendement ≈ k × `apyBase` du pool × part LP × temps en fourchette.
- k nécessaire pour atteindre 2,43 % (part LP 0,87 / 0,84, 85 % du temps en fourchette, avant
  coûts de rééquilibrage) : régime d'octobre 2026 : **14** (Orca) / **10** (Raydium) ; 90 jours :
  6,7 / 4,8 ; 365 jours : 3,1 / 2,3. La largeur des fourchettes Kamino n'est pas mesurable avec ces
  données. Un k de 10 suppose une fourchette dix fois plus étroite que celle d'un coffre déjà
  calé sur la NAV (par exemple ±0,1 % contre ±1 %), traversée par la seule dérive (1,33 bp/jour)
  en ~15 jours et plus souvent par le bruit de décote : au moins 50 rééquilibrages par an, une
  surveillance quotidienne et 0,3–2 %/an de coûts fixes.
- Ordres de grandeur : meilleur cas plausible (régime 365 jours, k = 5, Orca) : 5 × 1,07 × 0,87 ×
  0,85 = 3,96 % − 2,43 − ~0,6 ≈ **+0,9 %/an = +0,09 SOL/an** ; régime actuel, mêmes hypothèses :
  0,85 % − 2,43 − 0,6 ≈ **−2,2 %/an = −0,20 SOL/an**. Avis : le point 3 du rapport est mal
  argumenté, mais sa conclusion tient ; aucun scénario plausible ne bat « nettement » la
  détention, et le seul régime où il l'aurait fait (Raydium, août–septembre 2025, 3,7–5,7 % à
  l'échelle du pool) a disparu.

### 6. Pièges du protocole

- Malédiction du gagnant : pas de grille optimisée, la décision est négative. Le risque
  symétrique (rejeter sur le pire mois) est écarté : les moyennes 12 mois de tous les pools sont
  sous la barre, pas seulement octobre.
- Pooling de régimes : la moyenne 365 jours mélange octobre–novembre 2025 (Raydium 6 M$/jour) et
  2026 (0,2–1 M$/jour) ; ce pooling favorise la stratégie et la conclusion tient sans lui. Le
  régime 2025-Q3, hors fenêtre, aurait dû être montré et daté : c'est le seul où la stratégie
  payait.
- Prémisse fausse : `apyBase` vérifié numériquement (oui) ; part LP non chiffrée (87 / 84 %,
  direction exacte) ; coffres Kamino comme preuve indépendante (faux, point 5) ; « 50/50 »
  (démontré au point 2) ; référence : JitoSOL n'est pas le meilleur LST passif au 2026-10-11
  (jupSOL 5,53 %, INF 5,36 %, hSOL 5,35 % contre 4,88 %), ce qui ne change pas la décision mais
  relève la référence de tout plan futur.
- Adversaire qui choisit le moment : les arbitragistes ne traitent que lorsque l'écart prix/NAV
  dépasse 1 bp ; le LP subit ce flux par construction ; il est capturé par le terme s/2, et
  aucun stop ne s'applique. Traité.
- Survie : les pools étudiés sont les survivants ; sans effet sur un NO-GO. Le gel d'adaptateur a
  été détecté par l'auteur. Simpson : sans objet.

### 7. Ce que l'auteur n'a pas regardé, et complément (gratuit, sans clé, 14:48 UTC)

- jupSOL/JitoSOL Orca (`d10d3258…`) : 319 points depuis 2025-11-26, TVL 64–92 k$. `apyBase` :
  365 jours moyenne 3,92 % / médiane 1,58 % (février 2026 à 14,1 % tire la moyenne) ; 90 jours
  1,78 / 0,86 ; octobre 0,98 / 0,33. Frais totaux du pool : 2–10 $/jour. Barre ≈ 0,3 % + coûts
  contre la détention de jupSOL. Sur le papier, +1 à +2 %/an contre la détention de JitoSOL dans
  le régime récent, soit 0,1–0,2 SOL/an, avec 2 % d'un pool de 80 k$ (notre part des frais :
  0,04–0,2 $/jour) et la même tendance baissière. Pas « nettement » ; la simple détention de
  jupSOL fait +0,65 %/an sans rien faire.
- mSOL/JitoSOL Orca (`d7d14b5c…`) : figé juillet → novembre 2025 (même gel), puis 365 jours
  1,01 / médiane 0,28, 90 jours 0,31 / 0,11, TVL 100–160 k$. Inexploitable.
- Kamino SOL-JITOSOL `fdcccd6a…` : identifié comme le pool Raydium (point 5) ; 365 jours 1,24 %,
  90 jours 0,59 %, octobre 0,27 %, 0 au dernier point.
- Non couvert et non vérifiable dans le périmètre de cette revue : Meteora DLMM (absent de la
  couverture Solana de DefiLlama : 1 283 pools Raydium, 794 Orca, 54 Kamino, 0 Meteora) ;
  distribution de la liquidité par tick (k) ; dynamique de la décote (fréquence de
  rééquilibrage). Dans le régime actuel (k requis ≥ 10), aucun de ces points ne peut renverser la
  décision.

## Erreurs trouvées

1. Point 3 du rapport : les coffres Kamino sont présentés comme preuve indépendante de la
   gestion active ; ils constituent 88–99 % de la TVL des deux pools étudiés. Prémisse fausse,
   conclusion inchangée.
2. « Médiane depuis l'origine 1,12 » (Orca) : c'est la valeur figée ; hors gel 1,26–1,29. Sans
   conséquence.
3. Dates : gel Orca du 2025-03-25 au 2025-11-25 (pas « avril → novembre ») ; pic Orca le
   2025-01-21 (pas le 19). Sans conséquence.
4. Omission : la part LP (87 % Orca, 84 % Raydium) n'est pas chiffrée ; la barre en `apyBase` brut
   est 2,8–2,9 %, pas 2,4 %. Renforce le NO-GO.
5. Omission : les quatre mois où Raydium a dépassé la barre (février–mars et août–septembre 2025)
   ne sont pas montrés ; ils datent le régime perdu et auraient renforcé l'argument de régime.
6. Formulation : « 2–12 %/mois annualisé » désigne des moyennes mensuelles d'un taux annualisé.

Aucune erreur de signe, d'unité, de fuseau horaire ou de formule.

## Ce qui manque

- La valeur en dollars du capital et un coût fixe par rééquilibrage (nécessaires pour toute
  position concentrée ; ils ne peuvent qu'aggraver le résultat sur ~1–2 k$).
- La largeur des fourchettes Kamino, ou directement la distribution de liquidité par tick, pour
  mesurer k ; accessible sans clé via l'API publique Orca, hors périmètre réseau de cette revue.
- Une condition de réouverture écrite. Proposition : `apyBase` du pool ≥ 1,5 % (Raydium) ou
  ≥ 1,2 % (Orca) en moyenne glissante sur trois mois, **et** k mesuré ≥ 3, **et** coût fixe par
  rééquilibrage mesuré < 0,001 SOL. Tant que ces trois conditions ne sont pas réunies, rien à
  tester.
- Un mot sur la référence : si l'objectif est le meilleur rendement passif en SOL, la détention
  d'un LST à 5,3–5,5 % (jupSOL, INF, hSOL) bat JitoSOL de 0,5–0,7 %/an sans travail ; toute
  stratégie future devra se comparer à cela.

## Décision : NO-GO

Les frais bruts à l'échelle des pools (0,2–0,3 %/an en octobre 2026, 1,0–1,5 % sur douze mois,
en baisse continue depuis février) sont sous la barre démontrée de s/2 (2,43 % net, 2,8–2,9 %
brut) chaque mois depuis douze mois et 87–93 % des jours, et l'écart sur 9,32 SOL est de −0,09 à
−0,24 SOL/an selon le régime. La seule objection sérieuse, la concentration d'une position tenue
à la main, exigerait un facteur k de 10 à 14 dans le régime actuel face à des pools qui sont
déjà, à 88–99 %, des coffres concentrés et rééquilibrés automatiquement, avec des coûts fixes
de 0,3–2 %/an sur un capital de cette taille ; le meilleur cas plausible rapporte +0,09 SOL/an,
ce qui n'est pas « nettement ». Les erreurs trouvées (prémisse Kamino, médiane figée, dates,
part LP non chiffrée) ne renversent pas la décision ; deux d'entre elles la renforcent.
