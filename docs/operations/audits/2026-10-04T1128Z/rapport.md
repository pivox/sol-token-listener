# Audit technique et économique — sol-token-listener / microtrade Pump.fun

**État de l’audit : partiel, arrêté aux preuves locales disponibles.** Périmètre principal : la session de 10:24–11:03 UTC du 4 octobre 2026, celle qui correspond aux six mints abrégés et au solde final de 0,402939765 SOL. Aucun ordre, transfert, signature, accès RPC, lancement de bot, migration, ni chargement de clé n’a été effectué pendant cet audit. Les fichiers locaux préexistants ont été conservés.

## Résultats par session et configuration

Les sessions ne sont pas agrégées ici : seuils, limites de détention, taille de population et qualité des preuves changent d’une relance à l’autre.

| Session | Déclencheur / durée observés | Résultat rapporté | Lecture indépendante et limites |
|---|---|---:|---|
| 3 oct. 16:41, premier trade | 5 acheteurs externes finalisés distincts ; une première sortie a expiré puis la récupération a vendu | −0,347863 USDT | Le journal canary montre cinq clés wallet différentes et le départ de sortie à cinq acheteurs. Le détail brut RPC des tentatives expirées n’est pas archivé ici pour recalculer les frais exacts. |
| 3 oct. 17:33, relance 2 | 5 acheteurs externes finalisés distincts | +0,017196 USDT | Cinq événements `external_buyer_finalized` distincts précèdent la vente. Le log mentionne 45 000 lamports de frais par transaction confirmée. Le code complet de cette version n’est pas archivé dans son dossier. |
| 3 oct. 17:48, relance 3 | Observation seulement ; test de la population candidate avec une attente de cinq acheteurs | 0 trade | 15 mints, aucune sélection ; les journaux d’activité n’ont pas montré de flux suffisant pour la règle visée. Zéro trade n’est pas zéro coût futur ni une validation économique. |
| 3 oct. 18:07–21:20, relance 4 | Mélange de 5 wallets acheteurs distincts, de 3 événements BUY externes plus gros que notre BUY et de 3 événements SELL plus gros que notre BUY ; détention maximale 15 min | −0,7242 USDT estimés | Les trois événements sont des transactions, pas trois wallets. La fonction comparait le champ `solAmountLamports` au montant de notre événement BUY ; elle excluait notre wallet et les slots antérieurs/égaux. Les résultats incluent 5 tentatives d’achat échouées et nécessitent leurs métadonnées brutes pour les attribuer précisément. |
| 3 oct. 21:36–22:06, relance 5 | +0,01 USDT net estimé ; timeout 15 min | −0,471589 USDT | Deux positions : une sortie au seuil (+0,029639) et un timeout (-0,501228). La règle vise le produit estimé de liquidation totale, moins coût économique BUY et réserve réseau SELL, pas une hausse de prix unitaire. |
| 3 oct. 22:39–22:48, relance 6 | +0,01 USDT net estimé ; timeout 5 min | +0,013141 USDT | Un trade clôturé. Échantillon trop petit pour conclure que ce timeout ou ce seuil améliore le résultat. Le `status.json` écrasé par un redémarrage à vide ne contient plus ce trade ; il reste dans le journal et le rapport détaillé. |
| 3 oct. 22:52–4 oct. 03:00, relance 7-A | +0,01 par défaut dans le code ; timeout 5 min ; récupération après SELL expiré | −0,5489 USDT estimés | Une position. Ne pas confondre avec la relance suivante enregistrée dans le même dossier r7. |
| 4 oct. 05:58–06:54, relance 7-B (ligne « 8 » du bilan consolidé) | 11 BUY soumis / 11 SELL confirmés ; 6 seuils, 4 timeouts 5 min, 1 récupération | −0,871946 USDT estimés | Cette exécution précède la session auditée ci-dessous et finit à 0,420861924 SOL. Le résumé toutes sessions s’arrête à cette exécution. |
| **4 oct. 10:24–11:03, preuves r8 analysées ici** | **+0,05 USDT net estimé ; timeout 5 min ; budget voisin de 1 USDT par achat ; six achats** | **−1,07264519845 USDT estimés** | **Recalculé depuis les journaux canary et les variations natives : −8 839 119 lamports, en supposant les six loyers d’ATA récupérables. Ce n’est pas un PnL en USDT réalisé.** |

Le bilan toutes sessions est daté de 09:01 UTC, avant le démarrage de 10:24 UTC. Son r8 décrit le lot antérieur à 05:58 ; son montant −2,934119 USDT ne comprend donc pas les six trades audités ici. L’addition indicative ferait −4,006764 USDT, mais je ne la présente pas comme un total vérifié : le bilan signale lui-même des conventions de change et de loyer différentes entre sessions.

### Sens exact des règles « 3 », « 5 » et « +0,01 »

- **Cinq buyers (r1/r2)** : le résultat enregistré attend cinq acheteurs externes finalisés ; les journaux r1/r2 conservent des événements avec wallet et signature, mais le code complet de ces versions manque. En r4, le motif `five_distinct_finalized_buyers` correspond bien à cinq wallets distincts après le BUY.
- **Trois BUY/SELL (r4)** : trois transactions externes de sens donné, chacune avec `solAmountLamports` supérieur au montant de l’événement BUY du bot. La fonction [buy-exit-policy.mjs](../../evidence/2026-10-03-mainnet-microtrade-r4/buy-exit-policy.mjs) ne déduplique pas les wallets ; un même wallet peut donc produire plusieurs événements comptés. Ce n’est ni trois wallets, ni un volume net BUY, ni un profit de position.
- **Trois wallets (sélection r4–r8)** : le filtre de candidature vérifie au moins trois `uniqueBuyers` dans la fenêtre de suivi d’activité de 45 secondes. Ce filtre sert à choisir un mint ; il ne déclenche pas à lui seul la vente.
- **+0,01 USDT net (r5–r7 par défaut)** : la fonction convertit le seuil en lamports au cours SOL/USDT lu avant le BUY. Elle compare une quote de vente portant sur toute la quantité détenue avec le coût BUY mesuré et une réserve fixe de 50 000 lamports pour le réseau SELL.
- **r8 analysé ici : +0,05 USDT net** : ce seuil est présent dans les préflights de chacun des six canaries et dans le rapport de la session. Le code d’exécution a un défaut de repli à 0,01, mais les valeurs effectivement journalisées sont 0,05. Le seuil n’est pas un profit réalisé garanti, une variation du prix unitaire ou un montant brut de vente.

## Preuves, provenance et version

La stack du dépôt est TypeScript/Node.js avec PostgreSQL et Solana Web3. Le pipeline de production présent dans le dépôt est observation Pump.fun → événements/projections Postgres → décision papier/qualification → adaptateurs de marché/exécution abstraite → rapports. **Les microtrades r1–r8 n’ont pas utilisé ce pipeline API/frontend** : les scripts directs du dossier `docs/operations/evidence/...` ont lancé des sous-processus autonomes, lu les courbes Pump.fun, signé et envoyé des transactions. Leur simple présence sous `evidence/` ne rend pas leurs commandes sans effet.

Pour r8, le runner et le canary archivés importent les modules compilés du worktree `.worktrees/unissued-work-inventory`, à la révision `a2cd6abee7b9071860185dd2d012ca1071095a41` (`2026-10-03T11:53:15+02:00`). Le SDK Pump déclaré dans ce worktree est `1.36.0`. Les scripts de session/configuration et journaux sont présents. **Le hash des fichiers `dist/` réellement exécutés, le manifeste exact des variables d’environnement et la version historique du programme/fee config sur chaîne ne sont pas liés à un build immuable** : compatibilité complète du binaire et des frais historiques non déterminable.

Sources principales : [rapport session r8](../../mainnet-microtrade-2026-10-04-relance-8.md), [status.json](../../evidence/2026-10-04-mainnet-microtrade-r8/status.json), [session.jsonl](../../evidence/2026-10-04-mainnet-microtrade-r8/session.jsonl), [scripts r8](../../evidence/2026-10-04-mainnet-microtrade-r8/), [politique de profit](../../evidence/2026-10-04-mainnet-microtrade-r8/profit-policy.mjs), [filtre de sélection](../../evidence/2026-10-04-mainnet-microtrade-r8/selection-policy.mjs).

Les preuves de sélection r8 couvrent 9 vagues, 135 événements `pumpfun_create` et 135 lignes de candidat finalisé. Les vagues 1–8 ont une fenêtre d’activité complète et une sélection persistée ; la vague 9 a été interrompue en phase d’activité. Chaque capture de création déduplique localement les mints ; le recomptage hors ligne trouve **135 mints distincts et zéro répétition inter-vagues**. La vague 9 conserve 15 candidats et un échantillon d’activité, mais aucun arrêt de fenêtre ni décision de sélection.

L’activité r8 archive le nombre BUY/SELL, les wallets BUY uniques, les signatures, slots et sens. Elle ne conserve pas les montants de quote des événements de marché dans `activity.jsonl`, ni leur statut finalisé individuel. Les captures sont en commitment `confirmed`, ignorent les logs `err`, et dédupliquent au niveau signature. Il n’existe pas de journal de reconnexion, de couverture garantie, de mesure de volume, de financement de wallet ou d’indépendance d’acteur. Les 135 observations ne prouvent donc pas 135 lancements économiques indépendants, et le nombre de wallets n’établit pas le nombre d’acteurs indépendants.

## Reconstitution comptable de la session r8

### A. Positions clôturées et calcul natif

Les six journaux montrent un BUY et un SELL confirmés par position, un solde de jetons final de zéro et des frais `meta.fee` enregistrés de 45 000 lamports par transaction. La reconstruction par trade est :

```text
coût économique BUY = solde wallet avant BUY − solde après BUY − loyer ATA
flux wallet SELL    = solde après SELL − solde avant SELL
PnL position        = flux wallet SELL − coût économique BUY
PnL session         = somme des PnL position
```

Le coût BUY contient déjà ses frais réseau et ses autres débits. Le flux SELL contient déjà les frais réseau SELL et tout crédit/débit wallet de la transaction. **Les 540 000 lamports de frais réseau confirmés ne sont pas soustraits une deuxième fois.** La réserve de 50 000 lamports n’est qu’un coussin dans la règle de déclenchement ; pour le PnL réalisé recalculé, elle est remplacée par le frais SELL réellement journalisé de 45 000.

| Vague | Mint | Coût BUY hors loyer (lamports) | Quote SELL avant envoi | Frais réseau BUY+SELL | PnL réalisé recalculé (lamports) | Conversion au cours Kraken SOLUSDT préflight |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `HKEZKN1ev8hD2utDdefpcujufTwALCsVvdRcJXwGpump` | 8 035 114 | 7 158 008 | 90 000 | −922 106 | −0,111943668 USDT |
| 2 | `Bvh9xjVqTWA2AAM7HE2Lt11fbhsdAf3WyEALQwHMgSut` | 8 039 065 | 5 369 731 | 90 000 | −2 714 334 | −0,329357288 USDT |
| 3 | `3bqjGQ7HQC7JxG6fq8K6U3QYGKNMWEYsfAGn1HWc27yY` | 7 640 656 | 8 366 273 | 90 000 | +680 617 | +0,082538424 USDT |
| 4 | `2Uc6S4C5aQ5NH1J5Co4HPwdSuZCS8QGmBPd5SRxppump` | 8 043 679 | 5 638 698 | 90 000 | −1 820 821 | −0,220810963 USDT |
| 7 | `BQgvrXhbCgTG94DG4UToJY4Ggv1mmXRKw72z4eb9pump` | 8 035 772 | 5 821 718 | 90 000 | −2 259 054 | −0,274226565 USDT |
| 8 | `Cbq36xHU7ynVrrwcAN75SDYkvCmLZRX5cwUPYmUJpump` | 8 050 339 | 6 291 918 | 90 000 | −1 803 421 | −0,218845138 USDT |
| **Total** |  |  |  | **540 000** | **−8 839 119** | **−1,072645198 USDT estimés** |

Chaque transaction a un frais total observé de 45 000 lamports. Les deux frais par trade, soit 90 000 lamports, sont déjà intégrés dans le PnL par les changements de soldes. Il n’y a pas de tip explicite dans le constructeur d’instruction archivé ; le code pose 400 000 unités de calcul et 100 000 micro-lamports par unité de prix, compatibles avec le frais de 45 000 observé. Le partage entre frais de venue, créateur et intermédiaire n’est pas détaillé par les journaux.

Le champ d’événement BUY `solAmountLamports` est inférieur au coût wallet BUY hors loyer de 138 774 à 143 832 lamports selon le trade. Après déduction du frais réseau de 45 000, le résidu est de 93 774 à 98 832 lamports. **C’est un résidu de flux, pas une ventilation prouvée des frais Pump.fun/créateur** : l’événement IDL et les instructions internes nécessaires à cette attribution ne sont pas archivés. Le SDK calcule sa quote Pump.fun avec `global`, `feeConfig`, supply et état de courbe, mais ces valeurs historiques ne sont pas conservées avec chaque décision.

### B. Trésorerie, loyers et rapprochement

| Élément | SOL natif | Lamports | Statut |
|---|---:|---:|---|
| Wallet au préflight de vague 1 | 0,420861924 | 420 861 924 | OBSERVÉ dans le journal BUY/meta et le status |
| Wallet final | 0,402939765 | 402 939 765 | OBSERVÉ dans le SELL final et le status |
| Variation de trésorerie | −0,017922159 | −17 922 159 | RECALCULÉE par différence entière |
| Six ATA vides, loyer conservé | +0,009083040 | +9 083 040 | RECALCULÉ à 1 513 840 par compte ; récupérable si fermeture réussie, non remboursé ici |
| PnL économique natif, trésorerie + loyer | −0,008839119 | −8 839 119 | RECALCULÉ ; rapproche exactement la somme des six positions |
| Écart arithmétique entre les deux voies | 0 | 0 | RECALCULÉ ; ne remplace pas les métadonnées brutes manquantes |

Il n’y a pas de reliquat token positif rapporté. Les six comptes token demeurent ouverts avec solde nul ; leur loyer est immobilisé, pas une dépense définitive. Aucun remboursement de compte n’est compté. Le journal n’inventorie pas d’éventuels transferts externes entre snapshots de session, mais chaque calcul par trade est encadré par les soldes pré/post de ses transactions BUY/SELL.

**Réponse au “−1,0726 USDT” : reproduit, pas confirmé comme USDT réalisé.** Le montant fiable dans les preuves présentes est **−8 839 119 lamports de résultat économique estimé**, sous l’hypothèse que les six loyers de 1 513 840 lamports sont récupérables et que les changements wallet inclus dans les transactions sont attribuables aux swaps/frais. La conversion utilise les lectures Kraken `SOLUSDT` préflight (121,27–121,40) : **−1,07264519845 USDT indicatifs**. Aucun USDT n’a été échangé ni reçu ; cours exact à l’inclusion et prix de sortie USDT ne sont pas démontrés. Les métadonnées RPC historiques complètes manquent, donc les sous-postes programme/créateur, wSOL, propriétaire/fee payer résolus et toute instruction de crédit non standard restent incertains.

### C. Écart quote / exécution

Pour cinq ventes, le mouvement wallet postérieur au frais de 45 000 lamports correspond exactement à la quote SELL loguée. Pour le mint `2Uc6…ppump`, le mouvement wallet SELL est de 6 222 858 lamports ; après ajout du frais logué, le produit wallet implicite est 6 267 858 lamports, soit **+629 160 lamports** par rapport à la quote pré-envoi de 5 638 698. Le PnL recalculé utilise le mouvement wallet effectivement rapporté, donc il inclut cet écart une seule fois. Le compte token était encore lisible après la vente avec quantité zéro ; le retour de loyer n’explique pas, à lui seul, ce crédit. Sans `preBalances/postBalances`, clés de comptes résolues, `innerInstructions` et `pre/postTokenBalances` bruts, on ne peut pas décider s’il s’agit d’un meilleur remplissage dû au marché, d’un transfert/crédit d’instruction ou d’une autre composante. **Ne pas interpréter automatiquement cet écart comme un gain de slippage.**

## Quotes, PnL, exécution et autopsie

Le prix marginal n’est pas utilisé pour la sortie : `getSellSolAmountFromTokenAmount` est appelé avec la quantité entière de l’ATA, et prend l’état de la bonding curve, la supply, `global` et `feeConfig`. Cette quote tient donc compte de l’impact de taille à l’état lu et des frais Pump encodés par le SDK. Elle n’est pas une exécution garantie. Le BUY vise environ 1 USD de SOL (budget observé proche de 8,24 millions de lamports) et la quantité dérivée est conservée en unités raw ; les événements ne sérialisent pas les décimales du mint pour une conversion de quantité lisible.

Le seuil profit exige `quoteSell ≥ coût économique BUY + 50 000 lamports réseau SELL + seuil USDT converti en lamports`. Pour les sorties au timeout, le `minAmountOut` est 90 % de la quote courante ; pour le seuil profit, il est le minimum absolu requis. Il n’y a donc pas de confusion entre seuil brut et net dans le code de r8. Le suivi lit une quote toutes les cinq secondes, mais ne journalise ni slot de quote ni âge/slot des réserves. Le code relit courbe et état de vente séparément avec plusieurs appels RPC : un état mixte ou périmé reste un risque technique, non une cause démontrée ici.

T0 est le compteur `Date.now()` initialisé immédiatement après `position_open` et la confirmation BUY ; les journaux arrondissent les secondes. Les horodatages ci-dessous sont ceux des événements locaux du même runner ; les slots BUY/SELL sont ceux lus de la transaction confirmée et ne servent pas à soustraire des horloges différentes. Les checkpoints proviennent du premier `price_progress` à l’instant demandé ou après. Une cellule vide signifie qu’aucune observation n’existe après la sortie, pas un résultat nul.

| Mint | Premier PnL net quote observé | Plus favorable observé | Plus défavorable observé | Motif/fait de sortie | Classe |
|---|---:|---:|---:|---|---|
| HKEZKN…Gpump | −140 025 lamports, T+0 | −140 025, T+0 | −927 106, T+228 | max hold ; confirmé ~5:05 après BUY | A |
| Bvh9xj…Sut | −1 554 444, T+0 | −1 554 444, T+0 | −2 719 334, T+264 | max hold ; confirmé ~5:05 après BUY | A |
| 3bqjGQ…c27yY | −485 245, T+0 | +588 136, T+16 | −1 285 481, T+10 | seuil +0,05 atteint, SELL soumis puis confirmé ; résultat +680 617 lamports | C |
| 2Uc6S4…ppump | −551 882, T+0 | −551 882, T+0 | −3 609 662, T+289 | max hold ; quote SELL/exécution montre écart favorable non attribué | A |
| BQgvrX…pump | −287 909, T+0 | −265 941, T+10 | −2 264 054, T+289 | max hold | A |
| Cbq36x…pump | −292 665, T+0 | −38 773, T+5 | −1 824 793, T+21 | max hold | A |

Classe A signifie « aucune observation quote positive nette des coûts de sortie de la stratégie pendant cette position », selon un échantillonnage d’environ cinq secondes. Classe C est le seul déclenchement profit positif ; il a effectivement lancé une vente confirmée. Pas de classe B, D ou E parmi ces six positions achetées. La vague 9, elle, est **E pour l’entonnoir de sélection**, car sa fenêtre d’activité et sa décision sont incomplètes.

Les cinq trades perdants avaient déjà une valeur estimée de liquidation négative à leur premier snapshot post-BUY. Leurs déficits cumulés à ce point représentent environ −0,343006 USDT ; le sixième trade avait lui aussi un déficit initial (−0,058846), puis a rebondi et fini gagnant (+0,082538). Les cinq pertes clôturées totalisent −1,155184 USDT, soit une dégradation cumulée de −0,812177 sur ces cinq trajectoires. Le gain réalisé du trade 3 compense en partie cette baisse ; sur les six positions, la variation entre le premier snapshot et le résultat réalisé est −0,670793 USDT. Les coûts immédiats BUY→vente estimée expliquent donc une partie du déficit initial ; la dégradation ultérieure explique le reste. Ces décompositions restent basées sur quotes, pas sur des ventes alternatives réellement exécutées.

Le timeout de 5 min n’est pas la cause initiale des cinq pertes : elles sont sous le seuil de rentabilité dès le premier état post-BUY. Il a néanmoins laissé quatre de ces cinq positions atteindre des déficits bien plus grands que leur premier snapshot. Les trajectoires diffèrent : pour BQgvr, le plus favorable reste proche du départ avant une baisse marquée ; pour 2Uc6 et Cbq36, l’extrême défavorable survient avant l’échéance et la quote remonte légèrement ensuite ; pour HKEZKN et Bvh9, les quotes restent très négatives. Six positions ne permettent pas de choisir un timeout général.

### Rejeu limité des timeouts

Le dossier ne contient pas assez de tick/slot et de métadonnées d’exécution pour rejouer une vente hypothétique fidèlement. Le fichier `timeout-snapshot-r8.csv` montre uniquement une **simulation descriptive par snapshot** à T+30/60/120 : quote observée pendant que la position réelle était encore ouverte, frais SELL remplacés par les 45 000 lamports observés, sans délai d’inclusion ni impact de la vente contrefactuelle. Le trade 3bqj conserve son véritable profit trigger avant timeout. Les agrégats indicatifs sont −0,866122 USDT à T+30, −0,930983 à T+60 et −0,939758 à T+120, contre le baseline réellement exécuté à 300 s : −1,072645. Cinq pertes demeurent à chaque variante ; ces chiffres ne justifient ni une nouvelle règle ni un timeout de 30 s.

Le replay causal complet demandé ne peut pas être reconstruit : aucun historique quote précis en slot, prix d’inclusion contrefactuel, ordre de tous les événements, frais exacts venue ou profondeur post-vente n’est persisté. Une vente plus précoce aurait aussi modifié la courbe et l’heure à laquelle la vague suivante démarre. Le script ne compare pas de paramètres par trade et ne transforme donc pas ces snapshots en validation.

## Siffleur, sélection et non-achats r8

| Étape | Nombre vérifiable |
|---|---:|
| Événements `CreateEvent` capturés | 135 |
| Mints uniques dans et entre les vagues | 135 |
| Lignes de métadonnées de candidats finalisées | 135 |
| Candidats avec activité de 45 s et décision persistées (vagues 1–8) | 120 |
| Éligibles après recheck frais et classement | 7 |
| Éligibles choisis par ordre (wallets uniques puis réserve) | 6 |
| BUY confirmés | 6 |
| SELL confirmés | 6 |
| Vague sans décision complète | 1 (15 candidats en vague 9) |

Motifs exclusifs attribués aux 120 candidats complets, suivant l’ordre des tests du code :

| Motif d’absence d’achat / statut | Candidats |
|---|---:|
| <3 wallets BUY distincts observés en 45 s | 57 |
| `mayhem` actif | 31 |
| Quote asset différente de SOL natif | 11 |
| Courbe déjà complétée | 3 |
| Réserve SOL réelle <2 SOL | 3 |
| Réserve réelle ≥20 SOL | 1 |
| Propriétaire mint différent de Token-2022 | 3 |
| Recheck frais non éligible | 4 |
| Éligible mais classé après le choisi | 1 (`FpMapm…Ezs`, 7 wallets contre 32 pour le choisi de vague 2) |
| Choisi et BUY soumis/confirmé | 6 |

La sélection donne priorité au nombre de wallets BUY uniques observés puis à la réserve SOL. Elle ne compare ni volume BUY/SELL, ni flux net quote, ni taille par acheteur, ni ventes du créateur au moment de décision. Pour les six gagnants de sélection, les wallets observés en 45 s étaient 5, 32, 65, 38, 4 et 3 ; cette mesure n’implique pas un acteur indépendant par wallet. Les montants de flux, liens de financement et données de cluster ne sont pas présents dans les journaux r8. On ne peut donc pas dire que les 129 non-achats auraient été meilleurs ou pires ; il manque des trajectoires comparables après le même instant de décision.

Le compteur `failed=1` du status est expliqué par la vague 9 : `discover.mjs` retourne `code:null` quand le marqueur STOP interrompt le sous-processus, et `session.mjs` augmente alors `failed`. Ce n’est pas une transaction BUY/SELL échouée. Les six canaries ont chacun BUY et SELL confirmés ; le dossier n’apporte pas de preuve d’une tentative on-chain échouée en r8.

## Audit de l’instrumentation récente

Le collecteur `position_telemetry.v1` est une instrumentation utile déjà présente : normalisation en whitelist, nombres bruts, `BigInt`, journal append-only/fsync et idempotent, quotes causales jusqu’à 10 s, état inconnu séparé de zéro, sorties clôturées non remplacées par un dernier prix, événements finalisés uniquement pour les analyses d’activité, et lecture Postgres dans une transaction `READ ONLY` bornée. Les tests vérifiés couvrent l’isolation, le journal déchiré/reprise, les montants très grands, les duplicates, same-slot, orphan, frais estimés sans double comptage et états manquants.

Limites pour cet audit : le collecteur r7/r8 **ne capture pas les métadonnées RPC brutes de BUY/SELL**, ni le slot exact des quotes, frais de venue/impact, ni la branche canonique complète des quotes. L’analyse historique `--history --no-db` peut reconstruire les quotes déjà écrites dans les canary logs, mais elle ne crée pas les volumes de marché manquants et ne couvre pas la vague 9 de manière causale. Les lectures DB n’ajoutent des participants que si le listener les a déjà ingérés ; `docs/operations/position-telemetry.md` note qu’au contrôle le store local ne contenait que quatre launches, avec activité s’arrêtant au 12 septembre. Les tests Postgres exécutés utilisent un faux pool ; ils ne valident ni la disponibilité ni l’exhaustivité de la DB réelle. Il faut étendre cette instrumentation existante et son schéma de preuve ; une deuxième télémétrie parallèle serait redondante.

## Constats structurés

| ID | Gravité | Statut | Preuve / mécanisme | Impact mesurable | Correctif proposé | Validation |
|---|---|---|---|---|---|---|
| AUD-01 | Haute | **Recalculé sous hypothèses** | Six paires de logs `buy_confirmed`/`sell_confirmed`, status r8 et loyers d’ATA ; rapprochement ci-dessus | −8 839 119 lamports ; −1,072645198 USDT au taux indicatif du préflight | Conserver PnL natif en quote raw puis calculer à partir des métadonnées RPC archivées ; qualifier USDT d’indicatif | Réconcilier mêmes signatures par pre/post balances/token balances et comparer sans ajouter de frais à nouveau |
| AUD-02 | Haute | **Observé** | `price_progress` et `max_hold_5_minutes` dans les six `canary-runner.log` | 5/6 positions perdantes déjà négatives à T0 ; cinq sorties négatives totalisent −1,1552 USDT estimés | Avant toute reprise réelle, produire et auditer le gate de liquidation pleine position et conserver trajectoire par slot | Rejeu hors ligne causal avec fills quote d’origine ; aucune validation statistique revendiquée |
| AUD-03 | Haute | **Risque économique** | `selection-policy.mjs`, `discover.mjs`, `selection-funnel-r8.csv` | 6 achats parmi 120 décisions complètes ; 57/120 échouent déjà le seuil d’uniques ; volume et flux net absents | Étendre le journal de sélection à BUY/SELL quote brut et net, fenêtres/slot, créateur et couverture ; ne pas traiter un wallet comme un acteur prouvé | Tests BigInt/duplicats/reorg puis observation non-trading à couverture explicitement mesurée |
| AUD-04 | Moyenne | **Écart observé, cause inconnue** | Quote SELL vs deltas wallet du trade 2Uc6… | +629 160 lamports vs quote pré-envoi | Archiver pour chaque signature `meta`, clés résolues, instructions internes et balances avant/après | Réconcilier lamports jusqu’au compte/authority destinataire ; ne pas le classer comme slippage sans preuve |
| AUD-05 | Haute | **Manque de preuve** | Seuls quelques champs de `meta` sont recopiés par `sendSimulated`; aucune transaction JSON complète dans evidence | Frais Pump/créateur, wSOL, destinataire, transferts annexes et rôle fee payer indépendamment invérifiables | Étendre l’archive existante avec le RPC transaction response nettoyé, version, account keys résolues, token balances, err, fee, blockTime, slot et inner instructions | Fixtures buy/sell/failed/partiel/ATA-close et comparaison signature par signature au bilan wallet |
| AUD-06 | Moyenne | **Risque technique, effet r8 non établi** | Courbe et `fetchBuyState` lus séparément ; slot/âge de quote non journalisés ; SELL normal accepte un minimum à 90 % | Aucun écart défavorable déterminé sauf le gap de 2Uc6 ci-dessus ; une quote périmée/incluse tard peut changer le fill | Ajouter slot/horodatage état, âge maximal et cause `QUOTE_UNAVAILABLE/STALE`, relier décision et simulation à la même version de réserves | Replay stale/missing, bounds min-out, aucun envoi réseau dans les tests |
| AUD-07 | Faible | **Reporting ambigu confirmé** | `failed++` sur tout `discover.code !== 0`; r8 vague 9 est `code:null` et interrompue par STOP | Le chiffre d’échecs 1 surestime les échecs de transactions ; aucune transaction d’échec r8 démontrée | Séparer `discoveryErrors`, `tradeErrors`, `failedOnChainTransactions` et `unknownSubprocessExit` | Fixture `code:null` et transaction `meta.err` doivent tomber dans des compteurs distincts |
| AUD-08 | Moyenne | **Limite instrumentation confirmée** | Télémétrie existante couvre les quotes runner mais pas le corps de métadonnées RPC ni les montants d’activité r8 | Le passé ne peut pas être complété par collecte rétroactive ; le store décrit comme stale ne remplace pas l’archive | Étendre `position_telemetry.v1` et le format des preuves source au runner direct ; préserver `null/UNAVAILABLE` | Test isolation CLI, test source immuable, test read-only DB, fixtures signature/slot et manque de couverture |

**Bugs de trading confirmés comme cause des pertes : aucun.** Aucun cas r8 ne montre qu’un signal profit a été manqué ou qu’une position a été déclarée fermée avant confirmation. La cause économique observée est une entrée dont la liquidation immédiate estimée était déjà sous le coût complet, puis des baisses rapides pour cinq tokens. Les filtres par réserve et activité unique n’ont pas empêché ces pertes. Les frais et frais de programme participent au seuil de rentabilité mais les seules commissions réseau explicites (0,00054 SOL au total) n’expliquent pas à elles seules −0,008839119 SOL.

## Trois priorités et données minimales suivantes

1. **Ne pas redémarrer le microtrade réel avant une preuve complète par signature.** Archiver chaque réponse `getTransaction` historique pour les 12 signatures r8 : `meta.err`, `meta.fee`, blockTime, slot, account keys (versionnées résolues), pre/postBalances, pre/postTokenBalances, inner instructions, loaded addresses, token program et fee payer. Vérifier les six comptes ATA, owners, décimales et soldes à zéro ; ne compter le loyer comme récupérable qu’après preuve d’owner et de possibilité de fermeture, jamais avant remboursement.
2. **Étendre le collecteur existant avant toute nouvelle décision live.** Une ligne de décision doit lier version/config exacte, instant local, slot de marché, quantités raw + decimals, coût wallet BUY, quote pleine liquidation, `minAmountOut`, fraîcheur et détail frais. Une ligne d’activité doit conserver chaque signature/slot/side/wallet/quote amount/finalité et couverture, ainsi que `null` explicite en cas de trou. Le collecteur ne doit pas signer, lire une clé, ni ajouter de RPC au chemin de décision.
3. **Rejouer et mesurer en observation/paper avant de risquer davantage.** Reproduire d’abord les versions réellement archivées et le seuil net exact, vérifier les contre-exemples (frais, ATA rent/close, failed tx, partial sale, duplicate/out-of-order, missing/stale quote et compétition timeout/profit). Comparer les timeouts sur un dataset ultérieur distinct ; les six trades ne valident aucun paramètre.

Le contrôle minimal avant toute future session comprend : source/build hash et environnement non secret archivés ; quote de liquidation sur quantité réelle après BUY ; budget/cap et fee reserve explicités ; flux net/volumes/uniques avec couverture et finalité vérifiées ; balance de wallet rapprochée des signatures ; journal append-only hors chemin d’exécution ; compteur d’erreurs distinguant découverte, envoi, inclusion et résultat incertain. **Aucun de ces constats n’autorise à augmenter la mise ; aucune rentabilité n’est déduite.**

## Scripts, tests et commandes de reproduction

Analyseur local ajouté uniquement dans ce dossier : [analyze-r8.mjs](./analyze-r8.mjs). Il lit les journaux r8, ne lit aucun `.env`/fichier clé, n’ouvre aucun RPC/DB et écrit uniquement les CSV/JSON voisins : [trades-r8.csv](./trades-r8.csv), [trajectories-r8.csv](./trajectories-r8.csv), [timeout-snapshot-r8.csv](./timeout-snapshot-r8.csv), [selection-funnel-r8.csv](./selection-funnel-r8.csv), [reconciliation-r8.json](./reconciliation-r8.json).

Commandes exécutées :

```sh
node --test docs/operations/audits/2026-10-04T1128Z/analyze-r8.test.mjs
node docs/operations/audits/2026-10-04T1128Z/analyze-r8.mjs
node --import tsx --test tests/position-telemetry.test.ts tests/position-telemetry-report.test.ts tests/position-telemetry-evidence.test.ts tests/position-telemetry-isolation.test.ts tests/position-telemetry-postgres.test.ts
```

**Résultat :** 4 tests d’audit isolés réussis ; 15 tests d’instrumentation isolés réussis ; aucun échec, skip ou test bloqué. Le test d’isolation utilise un endpoint loopback invalide et un chemin de clé inexistant, et force `--history --no-db` ; aucun signer, wallet, RPC ou PostgreSQL n’a été contacté. Les fixtures vérifient frais, loyer, écart quote, gros entiers, unknown, orphan, duplication, same-slot et persistance/reprise. Les cas “échec de transaction on-chain facturé” et “vente partielle réelle” ne sont pas testés contre r8 faute de fixture transactionnelle brute ; ils restent à ajouter après extension du format d’archive.
