# Canary Mainnet post-merge d’hydratation et admission Pump.fun — 15 minutes

Version : 1.0.0 — 2026-09-12 — issue #114.

Cette procédure post-merge est opérateur-only et observe-only. Elle ne connecte
ni ne lit aucun wallet ou clé privée, ne compose aucun executor, n'arme, ne
signe et ne soumet aucune transaction. Elle est séparée de ce merge : aucune
readiness Mainnet n'est déclarée avant que cette fenêtre ait passé. Utiliser une
seule réplique avec `LISTENER_INGESTION_SCOPE=launchpad-only`, en mode `observe`.
Archiver le health, les compteurs inbox, le RSS et le tableau fournisseur avant
activation.

## Déroulement

1. Copier `deploy/env.example` hors du dépôt et vérifier une baseline saine avec
   `LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false`. Vérifier le genesis
   canonique du cluster et une paire HTTP/WebSocket valide pour chaque provider.
   Puis configurer exactement le profil suivant :

   ```dotenv
   EXECUTION_MODE=observe
   LISTENER_ENABLED=true
   LISTENER_INGESTION_SCOPE=launchpad-only
   LISTENER_CATCH_UP_POLICY=live-edge
   LISTENER_BLOCK_HYDRATION_ENABLED=true
   LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=true
   ```

   Compose transmet ce flag restart-only uniquement à `app`; contrôler la
   configuration résolue avant le démarrage.
2. Redémarrer exactement une réplique. Aucun flag n'est modifiable à chaud.
3. Capturer `/api/v1/health`, backlog/échecs terminaux, RSS et compteurs HTTP du
   fournisseur à T0, T+5 min et T+15 min.
4. Classer la fenêtre `PASS`, `FAIL` ou `INCONCLUSIVE`. Un trafic insuffisant
   pour produire un delta `fetches` strictement positif rend le test
   `INCONCLUSIVE`, jamais `PASS` implicite.

## Gates PASS

- zéro HTTP 429 dans les métriques fournisseur ou les logs;
- `heartbeat.blockHydration.enabled=true`, `version=1` et
  `callerConcurrency=1` à chaque relevé T0, T+5 min et T+15 min; une valeur
  conforme prouve que le chemin activé est observé. Toute autre valeur entraîne
  `FAIL`;
- `pipeline.pumpswap=IDLE` à chaque relevé confirme que le scope effectif est
  `launchpad-only`; toute autre valeur entraîne `FAIL`;
- `queuedFetches <= 1` et `inFlightFetches <= 1` à chaque relevé, avec backlog
  inbox non croissant;
- aucun nouvel échec terminal inexpliqué;
- delta `fetches` strictement positif sur la fenêtre; un delta nul dû à un
  trafic insuffisant classe la fenêtre `INCONCLUSIVE` tant qu’aucun autre gate
  n’a échoué;
- delta `fetches` moyen inférieur ou égal à 4/s (nominal attendu ~2,5/s);
- p95 détection → traitement strictement inférieur à 45 s;
- aucun oversize récurrent (au plus un pendant la fenêtre);
- `retainedEntries <= 64`, `retainedBytes <= 67 108 864` et queue bornée;
- RSS final inférieur ou égal au RSS T+5 min augmenté du plus grand de 25 % ou
  128 MiB.
- `heartbeat.catchUpAdmission.version=1`, `enabled=true`, un `providerId` public
  cohérent et `workerClaimReady`/`scanActive` cohérents avec la phase observée;
  les catégories de backlog source sont disjointes et les priorités totalisent
  le backlog actionnable;
- l'affinité provider est conservée pendant chaque scan strict : aucun résultat
  ou cache d'un provider remplacé n'est réutilisé, et le cache unique reste à
  quatre fetches démarrés/s ou moins globalement;
- finalité et idempotence restent correctes sur les chevauchements
  WebSocket/catch-up; `DEFERRED`, `IGNORED` et `QUARANTINED` restent visibles et
  les receipts/admissions se conservent quatre heures;
- le shutdown arrête les nouvelles admissions, draine dans le délai borné et
  laisse le health final propre, sans fuite de file ou de cache.

Toute violation est `FAIL`. Pour rollback, remettre
`LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED=false`, redémarrer la réplique
et vérifier que la métrique brute `catchUpAdmission` est omise du heartbeat,
tandis que l'API projette `heartbeat.catchUpAdmission: null` ;
`heartbeat.blockHydration.enabled=true`, la file revient à zéro et le backlog
reprend sa tendance de baseline. Ne jamais supprimer checkpoint ou donnée durable
pour masquer un échec : les receipts historiques restent retenus quatre heures.
