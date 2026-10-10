---
name: sol-stack-ops
description: Opérer la stack live sol-token-listener (compose sur Ubuntu, Vault, supervisord) sans casser ni exposer quoi que ce soit — commandes sol, pièges connus, scripts de recherche dans le conteneur, crédits Helius, sauvegardes. À charger avant toute commande docker/sol/vault sur la stack.
---

# Opérer la stack live

Hôte : la machine Ubuntu (`ssh haythem@192.168.1.48`), projet compose `sol-token-listener`,
`SOL_HOST_DIR=~/.sol-token-listener/docker`. Services : postgres, vault (raft, auto-unseal),
back (supervisord : listener, opapi, retention, h2a, h2b, autoarm ; worker arrêté), front.

```bash
sc() { docker compose --env-file "$HOME/.sol-token-listener/docker/compose.env" -f deploy/compose.yaml "$@"; }
sc exec -T back sol status            # état global
sc exec -T back sol ops status        # côté exécution (ENTRY_STOP, armements)
sc exec -T back sol ctl status        # programmes supervisord
sc exec -T back sol ctl stop|start <programme>
sc exec -T back sol helius reload     # recharge les comptes Helius depuis Vault
```

## Règles absolues
- **Jamais le port 5432** (postgres natif de l'utilisateur) ; jamais toucher aux autres
  conteneurs de la machine. Les tests utilisent un postgres jetable sur un port libre.
- **Jamais afficher ni copier un secret** (clés, URL avec api-key, mots de passe, keypair,
  mot de passe opérateur Vault, clé d'unseal) : noms ou hachés seulement. Les commandes qui
  en affichent sont données à l'utilisateur pour son terminal (`! <commande>`).
- **Aucun listener, RPC ou transaction réelle sans accord explicite.** Trading : NO-GO
  permanent depuis le 2026-10-10 (`ENTRY_STOP`), le listener reste arrêté.
- Le mode automatique bloque l'arrêt des conteneurs de l'utilisateur, la copie de secrets
  vers un autre hôte et les écritures DB distantes : ne pas contourner, donner la commande.

## Pièges connus
- **`sol helius reload` relance le listener.** Après tout reload, `sol ctl stop listener`
  tant que le trading est NO-GO (il a tourné 7 h par erreur le 2026-10-10 et brûlé des crédits).
- Vault : l'édition KV par l'interface échoue, utiliser `vault kv patch` en CLI.
- Déploiement d'une migration : migrer, **re-provisionner les rôles**
  (`scripts/provision-executor-roles.sql`), redémarrer. Les triggers différés lisent des
  colonnes qui doivent être accordées au rôle retention (PR #266, #267).
- `pkill` absent dans le conteneur : tuer via `/proc/*/cmdline`.
- Node 18 de l'hôte est trop vieux ; Node 22 est dans `~/.local/node`.

## Scripts de recherche dans le conteneur
Modèle : `scripts/research/migration-history-run.sh` et `dump-anatomy.mjs`.
1. copier le script dans `back:/tmp/`, un répertoire de travail `back:/tmp/<run>` en
   `chown listener`, `chmod 700` ;
2. lancer `sc exec -T back sol-run listener node /tmp/<script>.mjs --output=... --rps=3
   --credit-cap=<N> --account=<nom>` (compte Helius épinglé : un rate limit par clé) ;
3. `sc cp` les sorties vers `~/.sol-token-listener/lot5/evidence/research/`, `chmod 600` ;
4. `sc exec -T back rm -rf /tmp/<run> /tmp/<script>.mjs`.
Crédits Helius : 1 crédit par appel ; compter chaque tentative ; plafond par run ; comptes
listener 02-a/03-b/04-c (01-ancien épuisé) ; la clé exécuteur n'est jamais partagée.

## Sauvegardes et rétention
- Cron quotidien 03:17 : `deploy/host/backup.sh` (dump postgres + instantané raft) vers
  `~/.sol-token-listener/docker/backups/`.
- Rétention des données de fondation : 5 h (`DATA_RETENTION_HOURS`), purge en une transaction
  (~27 min la première fois) ; dry-run possible en transformant COMMIT en
  `SET CONSTRAINTS ALL IMMEDIATE` + ROLLBACK.
- Espace disque Docker surveillé ; la machine Mac n'héberge plus que la copie de repli.
