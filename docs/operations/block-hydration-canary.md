# Canary Mainnet d’hydratation bloc — 15 minutes

Version : 1.0.0 — 2026-09-12 — issue #114.

Cette procédure est opérateur-only. Elle ne connecte aucun wallet et n’arme ni
n’envoie aucune transaction. Utiliser une seule réplique, de préférence avec
`LISTENER_INGESTION_SCOPE=launchpad-only`, en mode `observe`. Archiver le health,
les compteurs inbox, le RSS et le tableau fournisseur avant activation.

## Déroulement

1. Copier `deploy/env.example` hors du dépôt, vérifier une baseline saine avec
   le flag `false`, puis configurer les sept valeurs suivies dans ce fichier
   opérateur avec `LISTENER_BLOCK_HYDRATION_ENABLED=true`.
2. Redémarrer exactement une réplique. Ne jamais changer le flag à chaud.
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

Toute violation est `FAIL`. Pour rollback, remettre
`LISTENER_BLOCK_HYDRATION_ENABLED=false`, redémarrer la réplique et vérifier que
`heartbeat.blockHydration.enabled=false`, que la file revient à zéro et que le
backlog reprend sa tendance de baseline. Ne jamais supprimer checkpoint ou
donnée durable pour masquer un échec.
