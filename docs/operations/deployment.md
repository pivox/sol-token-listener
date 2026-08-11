# Déploiement de référence

Ce guide décrit la topologie Compose V1 de `sol-token-listener`. Elle observe
Pump.fun/PumpSwap et exécute des simulations paper : elle ne signe, ne construit
et n’envoie aucune transaction. Le déploiement reste à réplica unique.

## Prérequis

- Docker Engine, Docker Compose v2 et BuildKit ;
- accès au fichier d’environnement externe et à la sauvegarde PostgreSQL ;
- endpoints Solana HTTP/WebSocket dédiés ;
- un proxy TLS externe pour publier uniquement le frontend.

Le développement local demande Node.js 22.13+. L’image de référence emploie
Node.js 22.22.0 épinglé par digest : préférez cette image immuable au runtime
conteneurisé plutôt qu’un tag mutable.

## Images immuables

`Dockerfile` et `deploy/compose.yaml` épinglent les images de base par digest.
Avant un rollout, construisez ou tirez les images immuables validées et notez
le digest réellement déployé. Le backend Node et le frontend Nginx s’exécutent
sans root ; PostgreSQL, l’API backend et les secrets ne sont pas publics.

## Secrets externes

Conservez les valeurs sous contrôle opérateur, par exemple dans
`/etc/sol-token-listener/deploy.env` avec des permissions minimales.
`deploy/env.example` est un aide-mémoire et jamais un secret de production :
ses placeholders `.invalid` et `replace-with-a-secret` ne doivent pas être
déployés.

Fournissez séparément `POSTGRES_PASSWORD` et
`POSTGRES_PASSWORD_URI_ENCODED`, qui est l’encodage percent du mot de passe
dans `DATABASE_URL`. N’ajoutez aucune variable de wallet, clé privée, keypair
ou signature : elles sont interdites par la configuration V1.

Validez le rendu sans imprimer le fichier :

```bash
docker compose --env-file /etc/sol-token-listener/deploy.env -f deploy/compose.yaml --project-name sol-token-listener config --quiet
```

N’envoyez jamais ce fichier vers Git, les logs CI ou une image Docker.

## Migration et verrou consultatif

La topologie fixe `POSTGRES_AUTO_MIGRATE=false`. Le service `migrate` exécute
l’artefact compilé et prend `pg_advisory_lock(7347662125)` avant de consulter
l’historique. Ce verrou de session sérialise les rollouts concurrents ; une
connexion perdue le libère. Les migrations transactionnelles sont rejouables :
ne modifiez, ne supprimez et n’inversez jamais à la main une migration appliquée.

## Démarrage

Avant toute migration, effectuez et vérifiez une sauvegarde de la base. Puis
construisez ou tirez les images immuables validées. Depuis la racine du dépôt :

```bash
docker compose --env-file /etc/sol-token-listener/deploy.env -f deploy/compose.yaml --project-name sol-token-listener up -d postgres
docker compose --env-file /etc/sol-token-listener/deploy.env -f deploy/compose.yaml --project-name sol-token-listener run --rm --no-deps migrate
docker compose --env-file /etc/sol-token-listener/deploy.env -f deploy/compose.yaml --project-name sol-token-listener up -d --no-deps app retention
until docker compose --env-file /etc/sol-token-listener/deploy.env -f deploy/compose.yaml --project-name sol-token-listener exec -T app node dist/scripts/deployment-healthcheck.js; do sleep 2; done
docker compose --env-file /etc/sol-token-listener/deploy.env -f deploy/compose.yaml --project-name sol-token-listener up -d --no-deps frontend
```

Attendez PostgreSQL sain, lancez la migration one-shot, puis exactement une
application et un worker de rétention. La boucle attend le healthcheck compilé
avant de publier le frontend derrière le proxy TLS externe. Vérifiez health, SSE
et les logs de rétention :

```bash
curl --fail --silent --show-error http://127.0.0.1:8080/api/v1/health
curl --no-buffer --max-time 10 -H 'Accept: text/event-stream' http://127.0.0.1:8080/api/v1/events
docker compose --env-file /etc/sol-token-listener/deploy.env -f deploy/compose.yaml --project-name sol-token-listener logs --since=15m retention
```

## Arrêt normal

Respectez les 40 secondes de grâce pour fermer SSE et PostgreSQL proprement :

```bash
docker compose --env-file /etc/sol-token-listener/deploy.env -f deploy/compose.yaml --project-name sol-token-listener stop frontend app retention
docker compose --env-file /etc/sol-token-listener/deploy.env -f deploy/compose.yaml --project-name sol-token-listener stop postgres
```

`docker compose down --volumes` est destructif et ne doit jamais être utilisé
sur la production pendant un arrêt normal : il supprime le volume PostgreSQL.
Cette option est réservée aux projets de smoke isolés et jetables.

## Santé et supervision

Le healthcheck valide `/api/v1/health`, l’API `v1` et PostgreSQL `AVAILABLE`.
Surveillez aussi les logs structurés, sans recopier URL RPC, mots de passe ou
contenus sociaux bruts. `DEGRADED` est acceptable uniquement pour le smoke avec
listener désactivé. En production, un listener activé doit converger vers `OK`;
alertez sinon, ou si PostgreSQL, la rétention ou SSE échoue.

Avant tout changement de plateforme, exécutez :

```bash
npm run deployment:smoke
```

Le smoke utilise un projet Docker jetable, des URLs `.invalid` et un listener
désactivé ; il ne valide ni un RPC réel ni une performance de production.

## Rétention et confidentialité

La durée de conservation métier reste de 4 heures, portée par `purge_after`.
Le worker purge immédiatement au démarrage puis toutes les 15 minutes par
défaut (`RETENTION_PURGE_INTERVAL_MS=900000`). La cadence de purge et la durée
de 4 heures sont distinctes : le worker ne raccourcit pas la fenêtre existante.

Seuls des compteurs agrégés sont journalisés. Les opérations `processed` ou
`confirmed` ne sont jamais effacées avant réconciliation de finalité.

## Sauvegarde

La sauvegarde externe est sous responsabilité opérateur. Avant chaque migration,
réalisez une sauvegarde PostgreSQL cohérente, chiffrée et contrôlée, puis notez
l’image et la révision de schéma associées. Ne copiez pas un volume actif par
archive de fichiers : utilisez un `pg_dump`/snapshot cohérent de votre
plateforme.

## Répétition de restauration

Effectuez une répétition de restauration avant le premier rollout et selon une
cadence opérationnelle définie. Elle recrée une base isolée à partir d’une
sauvegarde, vérifie migrations et image compatible, puis démarre un listener
désactivé. Mesurez la durée ; ne branchez jamais cette répétition sur la base
de production.

## Rollback

Quand l’ancienne application est compatible avec le schéma, replacez les images
par leurs digests précédents et redémarrez les services. Le rollback se fait
sans inverser les migrations : le schéma est forward-only. Si la compatibilité
est impossible, préservez le volume et restaurez uniquement depuis une
sauvegarde dont la restauration a été répétée. Ne modifiez pas
`migration_history` pour contourner ce cas.

## Proxy SSE et TLS externe

Nginx sert `config.json` same-origin, relaie seulement `/api/v1/*` et désactive
buffering/cache pour `/api/v1/events`. Le proxy TLS externe doit préserver le
chemin SSE, les lectures longues et les en-têtes nécessaires, sans ajouter de
méthode d’écriture ni de CORS avec credentials. Le compose publie seulement
`127.0.0.1:${FRONTEND_PORT:-8080}` ; DNS, certificats, en-têtes de sécurité et
contrôle d’accès relèvent de ce proxy externe.

## Limite de réplica unique

V1 supporte un seul listener, un seul worker de rétention et un seul frontend.
Ne scalez pas `app` : aucune élection de leader ou distribution de leases
multi-réplica n’est fournie par cette topologie.

## Arrêt incident

En incident, arrêtez frontend, `app` et `retention` avec les commandes d’arrêt
normal. Préservez le volume PostgreSQL, les logs et les digests d’images. Si la
base doit être isolée, arrêtez PostgreSQL sans `down --volumes`; consignez l’état
health et les erreurs redacted. Une restauration non répétée exige une décision
humaine, jamais une suppression automatique de données.

## Frontière no-live

`EXECUTION_MODE=observe` est figé dans le compose. Les seuls modes admis sont
`observe` et `paper`; paper reste une simulation. Aucun wallet, clé privée,
ordre réel, signature ou transaction live n’est accepté ni envoyé par cette V1.
Le système ne garantit pas première position, même slot, sellabilité, sortie ou
profit.
