# Session Mainnet r8

Ce dossier est réservé à une nouvelle session. Les journaux et les vagues seront créés au démarrage ; aucun résultat de r7 n’y est copié.

Pour lancer depuis la racine du dépôt :

```sh
SESSION_DURATION_MINUTES=240 CANARY_MIN_NET_PROFIT_USDT=0.05 node docs/operations/evidence/2026-10-04-mainnet-microtrade-r8/session.mjs
```

Le script écrit le suivi dans `session.jsonl`, l’état dans `status.json`, le rapport dans `docs/operations/mainnet-microtrade-2026-10-04-relance-8.md` et les preuves sous `wave-NNN/`. Pour demander un arrêt opérateur, créer `STOP` dans ce dossier.
