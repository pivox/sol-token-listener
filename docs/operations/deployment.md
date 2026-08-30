# Déploiement de référence

Ce guide décrit la topologie Compose V1 de `sol-token-listener`. Elle observe
Pump.fun/PumpSwap et exécute des simulations paper : elle ne signe, ne construit
et n’envoie aucune transaction. Le déploiement reste à réplica unique.

## Prérequis

- Docker Engine, Docker Compose v2 avec `up --wait --wait-timeout`, et BuildKit ;
- accès au fichier d’environnement externe et à la sauvegarde PostgreSQL ;
- endpoints Solana HTTP/WebSocket dédiés ;
- un proxy TLS externe pour publier uniquement le frontend.

Le développement local demande Node.js 22.13+. L’image de référence emploie
Node.js 22.22.0 épinglé par digest : préférez cette image immuable au runtime
conteneurisé plutôt qu’un tag mutable.

## Images immuables

`Dockerfile` épingle les images de base par digest. Le fichier opérateur doit
aussi définir `BACKEND_IMAGE` et `FRONTEND_IMAGE` comme références publiées par
digest (`registre/dépôt@sha256:…`) ; les valeurs `registry.invalid` du template
ne fonctionnent volontairement pas. Avant un rollout, tirez ces artefacts
immuables validés et notez les digests réellement déployés. Le backend Node et
le frontend Nginx s’exécutent sans root ; PostgreSQL, l’API backend et les
secrets ne sont pas publics.

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

Quand `LISTENER_ENABLED=true`, fournissez aussi
`SOLANA_EXPECTED_GENESIS_HASH`. C’est le hash de genèse canonique base58 de
32 octets du cluster ciblé. Obtenez `getGenesisHash` indépendamment auprès de
plusieurs sources de confiance, comparez-les avant de renseigner la valeur et
ne la copiez jamais dans les logs. L’exemple conserve volontairement une valeur
vide : un hash fictif ne constitue pas une configuration sûre.

Définissez le chemin une fois puis validez le rendu sans imprimer le fichier :

```bash
export DEPLOY_ENV=/etc/sol-token-listener/deploy.env
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener config --quiet
```

N’envoyez jamais ce fichier vers Git, les logs CI ou une image Docker.

## Migration et verrou consultatif

La topologie fixe `POSTGRES_AUTO_MIGRATE=false`. Le service `migrate` exécute
l’artefact compilé et prend `pg_advisory_lock(7347662125)` avant de consulter
l’historique. Ce verrou de session sérialise uniquement les migrateurs
concurrents. Il n’arrête ni l’application ni le worker de rétention : les
services applicatifs doivent donc être arrêtés explicitement avant la migration.
Une connexion perdue libère le verrou. Les migrations transactionnelles sont
rejouables : ne modifiez, ne supprimez et n’inversez jamais à la main une
migration appliquée.

La migration `021_paper_mvp_runner_hardening.sql` ajoute le propriétaire durable
et la raison de fin des runs Paper MVP. Elle marque les rapports `COMPLETED`
existants avec `completionReason=LEGACY` sans modifier leur verdict, leur statut
technique ni leurs gates. Les runs `RUNNING` reçoivent un propriétaire de
compatibilité que le prochain runner revendique. Arrêtez donc impérativement tout
ancien runner Paper MVP avant la fenêtre de migration et ne le redémarrez qu'avec
l'image contenant la migration 021.

La migration additive `022_paper_mvp_coverage_indexes.sql` indexe les fenêtres
de couverture des launches et candidats du runner. Elle doit être appliquée
avant de lancer la commande Paper MVP correspondante ; les migrations 018 à 021
restent immuables.

## Démarrage

La séquence opérationnelle minimale, depuis un fichier opérateur vérifié
`deploy/.env`, est la suivante. Elle démarre la migration avant les services
applicatifs et exige une santé `OK` :

```bash
DOTENV_CONFIG_PATH=deploy/.env npm run rpc:check
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d migrate
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --wait --wait-timeout 60 app frontend retention
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T app \
  node dist/scripts/deployment-healthcheck.js --require-ok
```

La supervision active attend le double ACK, vérifie la frontière stricte toutes
les 30 secondes et utilise seulement les IDs positionnels. Elle ne revient pas
automatiquement à `SolanaProgramSubscriber`; elle reste strictement
observe/paper only, sans wallet, signature ni soumission.

Avant toute migration, effectuez et vérifiez une sauvegarde de la base. Puis
construisez ou tirez les images immuables validées. Depuis la racine du dépôt :

```bash
set -euo pipefail
DOTENV_CONFIG_PATH="$DEPLOY_ENV" npm run rpc:check
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener config --images migrate app retention frontend | grep -Fvx 'postgres:16.14-alpine3.23@sha256:42b8b8b29c8a4e933d88943e5b03001a78794905cf786e6e7634e9f2abd5a0d3' | npm run --silent deployment:validate-images
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener pull postgres migrate app retention frontend
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener stop --timeout 40 frontend app retention
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener up --detach --wait --wait-timeout 60 --no-build postgres
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener run --rm --no-deps migrate
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener up -d --wait --wait-timeout 60 --no-build --no-deps app retention
health_attempt=0
until docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener exec -T app node dist/scripts/deployment-healthcheck.js --require-ok; do
  health_attempt=$((health_attempt + 1))
  if [ "$health_attempt" -ge 30 ]; then
    if ! docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener stop --timeout 40 app retention; then
      echo 'Le healthcheck strict a échoué et l’arrêt de sécurité app/retention a aussi échoué.' >&2
    fi
    echo 'Le healthcheck strict n’a pas convergé ; le déploiement est interrompu.' >&2
    exit 1
  fi
  sleep 2
done
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener up -d --no-build --no-deps frontend
```

La première pipeline retire uniquement l’image PostgreSQL déjà épinglée dans le
Compose, puis valide les quatre images applicatives effectivement rendues après
application du fichier et des éventuelles variables d’environnement du shell.
Elle refuse tout tag mutable, digest non canonique, cinquième image inattendue ou
partage incorrect avant le premier `pull`.

La commande `stop` attend la fin des trois services et ouvre une période
d’indisponibilité planifiée. Elle commence avant la migration et se termine
seulement lorsque le nouveau frontend est publié après le healthcheck. N’exécutez
pas la migration tant que cette commande n’est pas terminée.

La commande PostgreSQL attend explicitement un état sain, avec une borne de 60
secondes ; une migration `--no-deps` ne part donc pas sur une base seulement
démarrée. Lancez ensuite la migration one-shot, puis exactement une application
et un worker de rétention, dont la préparation est aussi attendue avec une
borne de 60 secondes. La boucle confirme ensuite le healthcheck compilé
avant de publier le frontend derrière le proxy TLS externe. Vérifiez health, SSE
et les logs de rétention. La sonde SSE attend 20 secondes, donc au-delà du
heartbeat par défaut de 15 secondes. Un `curl` encore connecté doit terminer
uniquement sur son timeout attendu (code 28), puis les deux preuves sont
vérifiées avant de supprimer les fichiers temporaires :

```bash
curl --fail --silent --show-error http://127.0.0.1:8080/api/v1/health
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener logs --since=15m retention

(
  set -eu
  sse_headers="$(mktemp)"
  sse_body="$(mktemp)"
  trap 'rm -f "$sse_headers" "$sse_body"' EXIT
  set +e
  curl --fail-with-body --silent --show-error --no-buffer --max-time 20 \
    --dump-header "$sse_headers" \
    --output "$sse_body" \
    --header 'Accept: text/event-stream' \
    http://127.0.0.1:8080/api/v1/events
  sse_status=$?
  set -e
  if [ "$sse_status" -ne 28 ]; then
    echo 'La sonde SSE ne s’est pas terminée sur le timeout attendu.' >&2
    exit 1
  fi
  grep -Eiq '^content-type:[[:space:]]*text/event-stream([;[:space:]]|$)' "$sse_headers"
  grep -Fq ': heartbeat' "$sse_body"
)
```

## Arrêt normal

Respectez les 40 secondes de grâce pour fermer SSE et PostgreSQL proprement :

```bash
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener stop frontend app retention
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener stop postgres
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

Il n’existe pas de raccourci « stop puis up » : redémarrer la même image ne
constitue pas un rollback. La procédure unique ci-dessous remplace explicitement
les images et ne bascule jamais vers le subscriber legacy dans le processus en
cours. Elle ne modifie jamais `EXECUTION_MODE` au-delà de `observe` ou `paper`.

Quand l’ancienne application est compatible avec le schéma, arrêtez d’abord les
trois services applicatifs avec les digests encore déployés :

```bash
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener stop --timeout 40 frontend app retention
```

La commande attend leur fin avant toute modification de version. Avant le
premier `pull`, l’opérateur remplace explicitement dans `$DEPLOY_ENV` les valeurs
non vides `BACKEND_IMAGE` et `FRONTEND_IMAGE` par les références immuables précédentes
exactes, de forme `repository@sha256:…`. Ne recopiez jamais un faux digest valide
ni un placeholder : `config --quiet` et `deployment:validate-images` refusent une
valeur vide, mutable, mal formée ou partagée avec le mauvais service. Ensuite
seulement, appliquez ce gate strict :

```bash
set -euo pipefail
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener config --quiet
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener config --images migrate app retention frontend | grep -Fvx 'postgres:16.14-alpine3.23@sha256:42b8b8b29c8a4e933d88943e5b03001a78794905cf786e6e7634e9f2abd5a0d3' | npm run --silent deployment:validate-images
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener pull app frontend retention
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener up -d --wait --wait-timeout 60 --no-build --no-deps app retention
health_attempt=0
until docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener exec -T app node dist/scripts/deployment-healthcheck.js --require-ok; do
  health_attempt=$((health_attempt + 1))
  if [ "$health_attempt" -ge 30 ]; then
    if ! docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener stop --timeout 40 app retention; then
      echo 'Le healthcheck strict a échoué et l’arrêt de sécurité app/retention a aussi échoué.' >&2
    fi
    echo 'Le healthcheck strict n’a pas convergé ; le déploiement est interrompu.' >&2
    exit 1
  fi
  sleep 2
done
docker compose --env-file "$DEPLOY_ENV" -f deploy/compose.yaml --project-name sol-token-listener up -d --wait --wait-timeout 60 --no-build --no-deps frontend
```

Le frontend reste volontairement arrêté jusqu’au healthcheck strict de `app` ;
la dernière commande le réexpose seulement après sa réussite.

Le rollback se fait sans inverser les migrations : le schéma est forward-only.
Ne relancez pas une ancienne image avant d’avoir vérifié sa compatibilité avec
le schéma déjà appliqué. Si la compatibilité est impossible, préservez le volume
et restaurez uniquement depuis une sauvegarde dont la restauration a été
répétée. Ne modifiez pas `migration_history` pour contourner ce cas.

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
