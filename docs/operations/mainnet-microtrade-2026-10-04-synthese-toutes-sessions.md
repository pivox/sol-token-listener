# Bilan consolidé des sessions de microtrade Mainnet

**Période couverte :** 3–4 octobre 2026 (UTC).  
**État vérifié :** 4 octobre 2026 à 06:54 UTC. Aucun processus r4–r7 ne tournait au contrôle. Le RPC répondait sur Mainnet, le wallet détenait **0,420861924 SOL** et aucun compte token n’avait de solde non nul.

## Résumé exécutif

Huit sessions opérationnelles sont documentées, plus un redémarrage r6 arrêté immédiatement par un ancien marqueur STOP. Les deux premières sessions ont exécuté un trade chacune ; la troisième était une observation sans ordre. Les cinq sessions suivantes ont utilisé le runner direct, dont deux invocations dans le dossier r7.

Au total, **28 trades ont été achetés puis vendus** dans les sessions résumées. En additionnant les résultats économiques publiés ou enregistrés pour chacune, le PnL estimé cumulé est d’environ **−2,934119 USDT**. Cette somme est indicative : les premiers rapports donnent un résultat après frais réseau issu de la réconciliation on-chain ; les runners ultérieurs convertissent les variations wallet en USDT au prix Kraken du BUY et réintègrent le loyer récupérable. Elle ne remplace pas une comptabilité en USDC/USDT.

Le solde SOL liquide est passé de **0,465847782 SOL** avant le premier trade à **0,420861924 SOL** au dernier contrôle, soit une baisse de **0,044985858 SOL**. La différence avec le PnL USDT estimé vient notamment des dépôts de comptes token, du taux SOL/USDT variable et des méthodes d’estimation.

## Chronologie et résultats

| # | Session (UTC) | Activité | Résultat enregistré | Solde SOL à la fin |
|---:|---|---|---|---:|
| 1 | 3 oct., 16:41–16:55 | Premier trade réel ; 15 créations inspectées ; 1 BUY et 1 SELL de récupération après expiration du premier SELL. | **−0,347863 USDT** après frais réseau ; baisse de prix durant l’exposition. | 0,460082101 |
| 2 | 3 oct., 17:33–17:38 | Deuxième aller-retour réel ; SELL après 5 BUY externes finalisés. | **+0,017196 USDT** après frais réseau. | 0,458711705 |
| 3 | 3 oct., 17:48–17:53 | 15 nouvelles créations observées et contrôlées ; aucun candidat conforme, aucun ordre. | **0 trade** ; wallet inchangé. | 0,458711705 |
| 4 | 3 oct., 18:07–21:20 | Relance prévue pour 4 h ; 42 vagues, 630 créations observées, 12 BUY soumis, 11 ventes confirmées, 5 tentatives échouées. Arrêt avant l’échéance après une découverte interrompue (`code:null`). | **−0,7242 USDT** estimés. | 0,453142550 |
| 5 | 3 oct., 21:36–22:06 | 30 min ; 6 vagues, 90 créations, 2 trades vendus. Premier trade : +0,0296 USDT au seuil ; second : −0,5012 USDT à la sortie de sécurité 15 min. | **−0,4716 USDT** estimés. | 0,446173140 |
| 6 | 3 oct., 22:39–22:48 | 30 min, arrêt opérateur ; 6 vagues, 90 créations, 1 trade vendu au seuil net. | **+0,0131 USDT** estimés. | 0,444768915 |
| 6 bis | 3 oct., 22:50 | Tentative de redémarrage avec durée demandée de 4 h. Le marqueur STOP encore présent a arrêté le runner après le préflight. | **0 vague, aucun ordre**, solde inchangé. | 0,444768915 |
| 7 | 3 oct., 22:52–4 oct., 03:00 | Invocation de 4 h ; un trade acheté puis vendu via récupération après expiration ; fin avec arrêt opérateur. | **−0,5489 USDT** estimés. | 0,438673339 |
| 8 | 4 oct., 05:58–06:53 | Invocation de 4 h interrompue par SIGINT ; 21 vagues, 333 créations selon l’état enregistré, 11 BUY soumis, 11 ventes confirmées, 3 tentatives échouées. | **−0,8719 USDT** estimés. | 0,420861924 |

Les lignes 7 et 8 réutilisent le même dossier r7 mais correspondent à deux démarrages distincts, séparés par une fin de session. La huitième session a été interrompue environ 56 minutes après son démarrage, avant son échéance prévue à 09:58 UTC.

## Détail des sorties r7 du 4 octobre

Sur les 11 positions vendues de la huitième session, 6 sont sorties au seuil de **+0,01 USDT net estimé**, 4 par la limite de détention de **5 minutes** et 1 par récupération d’un SELL expiré. Le PnL estimé des 11 ventes totalise −0,871946 USDT : les gains au seuil n’ont pas compensé les pertes des sorties de sécurité et de récupération. Un candidat supplémentaire a été sélectionné mais son BUY n’a pas été soumis.

| Mint | PnL estimé (USDT) | Motif de sortie |
|---|---:|---|
| `AhGVNyb2e2vBWb4K3QxevvHen3UWyunDPMsSXvaJpump` | −0,548892 | récupération après SELL expiré |
| `6DuBD4VBULnczvzjuk3Vbw7QV8PaVqee29CsVghhSp2a` | +0,076588 | seuil net |
| `EcZA7iCq3gvLa5n8Ptkcmz1dTyXJAvoGoWJUSJxiqWyE` | −0,516090 | limite 5 min |
| `CGN5pk1m6Xg6geGtNjUvV7VWJTU81bYheEr1YxDSpump` | −0,241502 | limite 5 min |
| `6ABYqydVkPdwd1iiKjLHtdBjGt1XfN2DoJSkuYMkxPEn` | −0,159798 | limite 5 min |
| `3K54y2t7Jy14wj8qbuDPGKkC1cEi7NezuaascZcQpump` | +0,020194 | seuil net |
| `Eh2mEHB5vyphRsH675NSGQDeWCLX3BAMz1o5D6wMYB42` | −0,099507 | limite 5 min |
| `DCzyKYrwaxK3Bi1vMCfGf4j2jaYicYmgbGpDgoKbpump` | +0,041083 | seuil net |
| `FjBYQ4cXVfu5ad8cZjap417kRBQYD7jtHaNYt751pump` | +0,095196 | seuil net |
| `61Bq32jbEfi8ebLvExvcvZj8gMRnPpmKK9eCvu2ypump` | +0,177480 | seuil net |
| `Fi12c5G7vne4FoMFZQyUQUxD3G1oeBn6pvEh6Q1ra2HX` | +0,283302 | seuil net |

## Ce que les sessions ont établi

- Le seuil de vente net a déclenché plusieurs ventes gagnantes, mais ne garantit pas que le résultat global de la session soit positif.
- La limite de 5 minutes coupe certaines pertes rapidement, mais les quatre sorties r7 déclenchées par cette limite ont tout de même été perdantes.
- Une vente peut être retardée par une transaction expirée ; la récupération a fonctionné, mais le prix peut évoluer fortement pendant ce délai.
- Les critères de sélection ont souvent écarté les créations observées ; la troisième session n’a passé aucun ordre malgré 15 tokens inspectés.
- Les opérations ont été exécutées par des scripts ponctuels hors du pipeline API/frontend du projet. Elles ne constituent pas une validation du canary formel #89. Le résidu de décodage TradeEvent de 24 octets suivi par #215 figure encore dans les rapports de session.

## Qualité et limites des données

Les états r6/r7 ont été réutilisés lors de redémarrages. Les fichiers `session.jsonl` sont append-only et contiennent plusieurs exécutions ; `status.json` ne décrit que la dernière exécution écrite dans le dossier. En particulier, le `status.json` r6 reflète le redémarrage sans ordre, tandis que le journal et le rapport détaillé conservent le trade r6 à +0,0131 USDT. Le rapport détaillé r7 déjà présent décrit la première exécution r7 à −0,5489 USDT ; il ne couvre pas les 11 trades de la seconde exécution. Ce bilan consolide les bornes `preflight_ok`/`session_finished`, l’état final r7 et les journaux de trades.

Le PnL cumulé **−2,934119 USDT** est une addition des estimations par session. Les prix de conversion et la façon de traiter les loyers de comptes ne sont pas parfaitement homogènes entre les premiers rapports on-chain et les sessions scriptées. Les résultats ne sont donc pas une mesure comptable auditée. Au dernier contrôle Mainnet, le solde token non nul était **nul** ; des comptes token vides peuvent toujours retenir leur dépôt de loyer.

## Rapports et preuves par session

- [Premier microtrade](mainnet-microtrade-2026-10-03.md) et ses [preuves](evidence/2026-10-03-mainnet-microtrade/)
- [Deuxième trade](mainnet-microtrade-2026-10-03-relance.md) et ses [preuves](evidence/2026-10-03-mainnet-microtrade-r2/)
- [Troisième session sans ordre](mainnet-microtrade-2026-10-03-relance-2.md) et ses [preuves](evidence/2026-10-03-mainnet-microtrade-r3/)
- [Quatrième relance](mainnet-microtrade-2026-10-03-relance-3.md), [bilan détaillé](mainnet-microtrade-2026-10-03-relance-3-detail.md) et [preuves](evidence/2026-10-03-mainnet-microtrade-r4/)
- [Cinquième relance](mainnet-microtrade-2026-10-03-relance-5.md), [bilan détaillé](mainnet-microtrade-2026-10-03-relance-5-detail.md) et [preuves](evidence/2026-10-03-mainnet-microtrade-r5/)
- [Sixième relance enregistrée](mainnet-microtrade-2026-10-03-relance-6.md), [bilan détaillé du trade](mainnet-microtrade-2026-10-03-relance-6-detail.md) et [journal r6](evidence/2026-10-03-mainnet-microtrade-r6/session.jsonl)
- [Journal consolidable r7](evidence/2026-10-03-mainnet-microtrade-r7/session.jsonl), [état final r7](evidence/2026-10-03-mainnet-microtrade-r7/status.json) et [journal des alertes](evidence/2026-10-03-mainnet-microtrade-r7/alerts.jsonl)
