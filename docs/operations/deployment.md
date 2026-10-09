# Déploiement du bot complet (Docker Compose)

Ce runbook exploite la stack décrite par le spec
`docs/superpowers/specs/2026-10-09-full-bot-compose-design.md` : trois conteneurs
(`postgres`, `back`, `front`) et une tâche `migrate`. Il remplace les processus lancés à la main
sur l'hôte. Les secrets sont des fichiers hors du dépôt, jamais affichés : ne lancez aucun `cat`,
`echo` ou `env` sur eux.

## Topologie

| Conteneur | Contenu | Réseaux | Ports publiés |
|---|---|---|---|
| `postgres` | PostgreSQL 16.14, volume `postgres-data` | `internal` | aucun |
| `migrate` | tâche ponctuelle : migrations, droits, neuf logins | `internal` | aucun |
| `back` | `supervisord` et un utilisateur Unix par processus | `internal`, `egress`, `edge` | aucun |
| `front` | Caddy : console, relais `/api/v1` et `/operator/v1/`, mot de passe | `edge` | Mac : `127.0.0.1:8080` ; serveur : 80 et 443 |

Programmes du back : `listener`, `opapi` et `retention` en mode `observe` ; s'y ajoutent `h2a`,
`h2b` (relancé à la demande) et `autoarm` en mode `live` ; `worker` ne tourne que pendant
`sol qualify`. `autoarm` n'arme rien tant que l'état de contrôle n'est pas `RUNNING`, ce que seul
`sol trading start` rétablit après un redémarrage.

## Prérequis

- Docker avec le plugin Compose 2.24.4 ou plus récent (Docker Desktop sur le Mac).
- `openssl`, et un checkout du dépôt au commit livré.
- Pour le mode `live` : les fichiers actuels de `~/.sol-token-listener/lot5/` (environnements,
  clés) et la base actuelle (conteneur `sol-token-listener-live-pg`, port 5433).

Préparer le shell, sur le Mac :

```bash
export SOL_HOST_DIR="$HOME/.sol-token-listener/docker"
export SOL_ENV="$SOL_HOST_DIR/compose.env"
sol_compose() {
  docker compose --env-file "$SOL_ENV" -f deploy/compose.yaml "$@"
}
```

Sur le serveur, le fichier `deploy/compose.server.yaml` publie 80 et 443 et active HTTPS :

```bash
export SOL_HOST_DIR=/srv/sol-token-listener
export SOL_ENV="$SOL_HOST_DIR/compose.env"
sol_compose() {
  docker compose --env-file "$SOL_ENV" -f deploy/compose.yaml -f deploy/compose.server.yaml "$@"
}
```

## Dossier hôte, secrets et configuration

Créer l'arborescence, les mots de passe PostgreSQL, le jeton de l'API opérateur et l'empreinte du
mot de passe du front. Le script ne remplace jamais un fichier existant. Il n'affiche qu'un seul
secret, le mot de passe du front, une seule fois : le ranger aussitôt dans un gestionnaire de mots
de passe.

```bash
deploy/host/init-secrets.sh "$SOL_HOST_DIR"
cp deploy/env.example "$SOL_ENV"
chmod 0600 "$SOL_ENV"
```

Dans `compose.env`, renseigner `SOL_HOST_DIR`, les images et `SOL_STACK_MODE`, puis `SITE_ADDRESS`
sur le serveur. Ce fichier ne contient aucun secret.

Les six secrets du back proviennent des fichiers actuels. Les commandes suivantes les recopient
sans jamais les afficher :

```bash
lot5="$HOME/.sol-token-listener/lot5/env"
back="$SOL_HOST_DIR/secrets/back"
value() { sed -n "s/^$1=//p" "$2"; }
value SOLANA_HTTP_RPC_URL "$lot5/listener.env" > "$back/helius-listener-http-url"
value SOLANA_WS_RPC_URL "$lot5/listener.env" > "$back/helius-listener-ws-url"
value SOLANA_HTTP_RPC_URL "$lot5/live.env" > "$back/helius-executor-http-url"
cp "$(value HELIUS_API_KEY_PATH "$lot5/provider-evidence.env")" "$back/helius-admin-api-key"
cp "$(value EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH "$lot5/provider-evidence.env")" "$back/evidence-private-key"
cp "$(value EXECUTOR_KEYPAIR_PATH "$lot5/live.env")" "$back/wallet-keypair.json"
chmod 0600 "$back"/*
```

Si une valeur est entourée de guillemets dans le fichier source, retirer les guillemets du
secret : `sol-run` refuse une URL qui n'en est pas une, sans afficher sa valeur.

La configuration non secrète de chaque rôle reprend les fichiers actuels, privés de toute
variable que `sol-run` injecte depuis les secrets :

```bash
lot5="$HOME/.sol-token-listener/lot5/env"
config="$SOL_HOST_DIR/config"
strip() {
  grep -v -E '^(DATABASE_URL|OPERATOR_API_DATABASE_URL|SOLANA_HTTP_RPC_URL|SOLANA_WS_RPC_URL|EXECUTOR_KEYPAIR_PATH|HELIUS_API_KEY_PATH|EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH|OPERATOR_API_TOKEN)=' "$1"
}
for name in listener live live-recovery operations operator-api readiness worker-sim provider-evidence preflight-bundle; do
  strip "$lot5/$name.env" > "$config/$name.env"
done
sed -i.bak "s#$HOME/.sol-token-listener/lot5/evidence#/var/lib/sol/evidence#g" "$config"/*.env
rm -f "$config"/*.env.bak
chmod 0644 "$config"/*.env
```

Puis compléter à la main, en s'appuyant sur les modèles `deploy/config/*.env.example` :

- `listener.env` : `API_HOST=0.0.0.0` et `API_PORT=3000`, pour que le front joigne l'API.
- `operator-api.env` : `OPERATOR_API_HOST=0.0.0.0`, `OPERATOR_API_PORT=3100` et
  `OPERATOR_API_ALLOWED_ORIGIN=http://127.0.0.1:8080`, ou `https://<SITE_ADDRESS>` sur le serveur.
  Le front réécrit l'en-tête Host de `/operator/v1/` en `0.0.0.0:3100`, seule valeur que l'API
  accepte.
- `operations.env` : `EXECUTOR_PREFLIGHT_EVIDENCE_PATH=/var/lib/sol/evidence/bundle/qualification.json`
  et `EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH=/var/lib/sol/evidence/<catalogue>.json`.
- `preflight-bundle.env` : `EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY=/var/lib/sol/evidence/bundle`.
- vérifier qu'aucun autre chemin ne pointe hors de `/var/lib/sol/evidence` :
  `grep -h '_PATH=\|_DIRECTORY=' "$SOL_HOST_DIR"/config/*.env`.

`sol-run` refuse de démarrer un processus dont la configuration contient un mot de passe, une
clé, un jeton, une URL avec identifiants ou une variable injectée. Le message nomme le fichier et
la variable, jamais la valeur.

Les preuves et le catalogue de gates vivent dans le volume `evidence`, propriété de l'utilisateur
`ops`. Pour y copier un fichier existant, une fois la stack créée :

```bash
evidence_file=gate-catalog.json
sol_compose cp "$HOME/.sol-token-listener/lot5/evidence/$evidence_file" "back:/var/lib/sol/evidence/$evidence_file"
sol_compose exec back chown ops:ops "/var/lib/sol/evidence/$evidence_file"
```

## Images

Construire les images sur l'hôte depuis le commit livré, avec une étiquette qui porte son SHA.
Renseigner ensuite ces étiquettes dans `compose.env` (`BACKEND_IMAGE`, `FRONTEND_IMAGE`) :

```bash
revision="$(git rev-parse --short=12 HEAD)"
printf 'BACKEND_IMAGE=sol-token-listener/backend:%s\nFRONTEND_IMAGE=sol-token-listener/frontend:%s\n' "$revision" "$revision"
sol_compose build back front
```

Le smoke isolé valide la topologie sans RPC ni secret réel : `npm run deployment:smoke`.

## Démarrage et arrêt

La tâche `migrate` s'exécute avant le back, sous le verrou consultatif `pg_advisory_lock` des
migrations. Elle applique les migrations, rejoue `scripts/provision-executor-roles.sql` et crée
ou met à jour les neuf logins `NOINHERIT`, chacun membre d'un seul rôle de groupe. Les migrations
restent forward-only.

```bash
sol_compose up --detach --wait --wait-timeout 180
sol_compose exec back sol status
```

En mode `live`, le script d'entrée du back ramène un état de contrôle `RUNNING` à `ENTRY_STOP`
avant de lancer les programmes : aucun nouvel achat ne part après un redémarrage, alors que H2a,
H2b et `autoarm` assurent les sorties. Si le back redémarre en boucle en mode `live`, lire
`sol_compose logs back` : la lecture de l'état de contrôle a échoué, souvent à cause d'une
configuration `operations.env` invalide.

Arrêt normal, qui conserve la base :

```bash
sol_compose stop --timeout 60
```

`down --volumes` est destructif : il efface la base. Ne jamais l'utiliser pour un arrêt normal.

## Commandes sol

Toutes s'exécutent dans le back, en root, qui les lance sous l'utilisateur `ops` avec la
configuration et les secrets du rôle demandé. Ajouter `-it` aux commandes qui demandent une
confirmation au TTY.

| Commande | Effet |
|---|---|
| `sol status` | programmes, mode, état de H2b |
| `sol ops status`, `sol ops envelope show` | état de contrôle, enveloppes |
| `sol ops envelope create …`, `sol ops resume` | création d'enveloppe, reprise (TTY) |
| `sol ops kill-switch --mode=hard-stop --reason=OPERATOR_HARD_STOP` | arrêt d'urgence, sorties comprises |
| `sol readiness` | H2d |
| `sol evidence provider`, `sol evidence bundle` | H2e, H2f |
| `sol qualify start`, `sol qualify stop` | sonde du gate 10 |
| `sol trading start`, `sol trading stop` | autoriser ou suspendre les achats |
| `sol ctl …` | `supervisorctl` (status, restart d'un programme) |

Le rapport fast-path lit la base en administrateur : il passe par la tâche `migrate`, seule
détentrice du mot de passe administrateur.

```bash
sol_compose run --rm migrate sol-admin report
```

## Trading

```bash
sol_compose exec -it back sol trading start
sol_compose exec back sol trading stop
```

`sol trading start` exige une enveloppe `ACTIVE` et attend au plus 60 s que H2b tourne depuis
15 s. Il lance ensuite `resume`, à confirmer au TTY. `sol trading stop` pose `ENTRY_STOP` : plus
aucun achat, mais les positions ouvertes continuent d'être vendues à leur échéance. Après tout
redémarrage du back, relancer `sol trading start`.

## Qualification d'une enveloppe (gate 10)

La procédure reprend celle du runbook canary (lot 4a). `sol qualify start` suspend la
rétention, active la sonde du listener et démarre le worker de simulation. La sonde écrit au plus
un intent de 0,001 SOL toutes les 10 minutes, jamais armable.

```bash
sol_compose exec back sol qualify start
sol_compose exec back sol evidence provider
sol_compose exec back sol readiness
sol_compose exec back sh -c 'sol ops envelope prepare --valid-ms=21600000 > /var/lib/sol/evidence/preflight-draft.json'
sol_compose exec back rm -rf /var/lib/sol/evidence/bundle
sol_compose exec back sol evidence bundle
sol_compose exec -it back sol ops envelope create --per-buy-lamports=10000000 --max-buys=5 \
  --max-exposure-lamports=10000000 --max-loss-lamports=30000000 --holding-ms=300000
sol_compose exec back sol qualify stop
sol_compose exec -it back sol trading start
```

`envelope prepare` échoue tant qu'aucun artefact de simulation `SUCCESS` de moins de 24 h
n'existe : attendre la sonde suivante, puis recommencer. H2f exige un répertoire de sortie absent,
d'où le `rm -rf` du paquet précédent, déjà consommé.

## Santé et journaux

- `sol_compose ps` : `back` est sain quand chaque programme du mode tourne, que H2b tourne ou attend
  du travail, et que l'API du listener répond `OK`. Avec `SOL_HEALTH_REQUIRE_OK=false`, l'état
  `DEGRADED` est aussi accepté, utile si le projet RPC du listener est épuisé.
- `sol_compose logs -f back` : une ligne JSON par événement, avec le nom du service. Le pilote
  `json-file` garde 5 fichiers de 20 Mo par conteneur.

Vérifier le flux SSE à travers le front ; `curl` demande le mot de passe du front :

```bash
set -euo pipefail
sse_headers="$(mktemp)"
sse_body="$(mktemp)"
trap 'rm -f "$sse_headers" "$sse_body"' EXIT
sse_status=0
curl --fail-with-body --silent --show-error --no-buffer --max-time 20 --user operator \
  --dump-header "$sse_headers" --output "$sse_body" http://127.0.0.1:8080/api/v1/events || sse_status=$?
if [ "$sse_status" -ne 28 ]; then
  echo "Le flux SSE s'est terminé avec le code $sse_status." >&2
  exit 1
fi
grep -Eiq '^content-type:[[:space:]]*text/event-stream' "$sse_headers"
grep -Fq ': heartbeat' "$sse_body"
```

## Sauvegardes

`deploy/host/backup.sh` lance `pg_dump -Fc` dans le conteneur `postgres`, écrit l'empreinte
SHA-256 à côté et garde 14 jours dans `$SOL_HOST_DIR/backups`. Le dossier des secrets n'est
jamais sauvegardé. La copie hors machine (sauvegarde externe) reste à la charge de l'opérateur.

Sur le Mac, avec launchd :

```bash
plist="$HOME/Library/LaunchAgents/com.sol-token-listener.backup.plist"
sed -e "s#__SOL_REPOSITORY__#$PWD#g" -e "s#__SOL_HOST_DIR__#$SOL_HOST_DIR#g" \
  deploy/host/com.sol-token-listener.backup.plist > "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
```

Sur le serveur, avec systemd, le dépôt étant cloné dans `/srv/sol-token-listener/repository` :

```bash
sudo cp deploy/host/sol-backup.service deploy/host/sol-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sol-backup.timer
```

La restauration doit être répétée régulièrement sur un projet jetable : les mêmes étapes que la
reprise ci-dessous, avec un autre `--project-name`.

## Reprise de la base actuelle

La base actuelle (conteneur `sol-token-listener-live-pg`, PostgreSQL 16.15 Debian) passe dans la
stack (PostgreSQL 16.14 Alpine). L'ordre de tri des textes change : glibc `en_US.utf8` d'un côté,
octets de l'autre, comme en CI. La restauration reconstruit les index ; seul l'ordre des
résultats textuels change.

1. Précondition, trading complètement arrêté. La ligne attendue est `0|0|0|0` : enveloppes
   actives, armements, positions ouvertes, transactions signées non terminales.

   ```bash
   docker exec -i sol-token-listener-live-pg psql -X -A -t -v ON_ERROR_STOP=1 -U sol_owner -d sol_token_listener \
     < deploy/sql/takeover-precondition.sql
   ```

2. Arrêter les processus de l'hôte, dans l'ordre : auto-arm, H2b, H2a, listener, API opérateur.

   ```bash
   for pattern in auto-arm-main.js executor-live/main.js executor-live-recovery/main.js dist/src/app.js operator-api/main.js; do
     pkill -TERM -f "$pattern" || true
     while pgrep -f "$pattern" > /dev/null; do sleep 1; done
   done
   ```

3. Exporter la base actuelle, avec son empreinte et le compte de lignes de chaque table.

   ```bash
   takeover="$SOL_HOST_DIR/backups/takeover-$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p "$takeover"
   docker exec sol-token-listener-live-pg pg_dump -Fc -U sol_owner -d sol_token_listener > "$takeover/source.dump"
   shasum -a 256 "$takeover/source.dump" > "$takeover/source.dump.sha256"
   docker exec -i sol-token-listener-live-pg psql -X -A -t -v ON_ERROR_STOP=1 -U sol_owner -d sol_token_listener \
     < deploy/sql/table-row-counts.sql > "$takeover/source.counts"
   ```

4. Restaurer dans la stack : base vide, rôles de groupe, `pg_restore` dans une seule transaction,
   comparaison, puis `migrate` (droits et logins).

   ```bash
   sol_compose up --detach --wait postgres
   sol_compose run --rm migrate sol-admin group-roles
   sol_compose exec -T postgres sh -c 'exec pg_restore --exit-on-error --single-transaction -U sol_owner -d "$POSTGRES_DB"' \
     < "$takeover/source.dump"
   sol_compose exec -T postgres sh -c 'exec psql -X -A -t -v ON_ERROR_STOP=1 -U sol_owner -d "$POSTGRES_DB"' \
     < deploy/sql/table-row-counts.sql > "$takeover/target.counts"
   diff "$takeover/source.counts" "$takeover/target.counts"
   sol_compose run --rm migrate
   ```

   Le `diff` doit être vide. Une erreur de `pg_restore` annule toute la restauration : corriger la
   cause, puis repartir d'une base vide avec `sol_compose down --volumes`, qui détruit seulement la
   base de la stack.

5. Démarrer en mode `live`, trading arrêté, puis vérifier.

   ```bash
   sed -i.bak 's/^SOL_STACK_MODE=.*/SOL_STACK_MODE=live/' "$SOL_ENV"
   rm -f "$SOL_ENV.bak"
   sol_compose up --detach --wait --wait-timeout 180
   sol_compose exec back sol status
   sol_compose exec back sol ops status
   sol_compose exec back sol ops envelope show
   ```

   `sol ops status` doit montrer `ENTRY_STOP` (ou `HARD_STOP`) et la même dernière qualification
   qu'avant la reprise. Aucune requalification n'est due : wallet, fournisseur et configuration
   n'ont pas changé.

6. Arrêter l'ancien conteneur sans le supprimer : `docker stop sol-token-listener-live-pg`.

## Retour arrière

L'ancien conteneur est conservé sept jours. Tant qu'aucun trade n'a eu lieu dans la stack :
`sol_compose stop --timeout 60`, `docker start sol-token-listener-live-pg`, puis relancer les
processus de l'hôte comme avant, depuis un `dist/` reconstruit sur `main`. Après un trade, le
retour passe par un dump inverse : les étapes 3 et 4 dans l'autre sens, de la stack vers une base
vide.

## Bascule vers le serveur

Prérequis :

- Docker et son plugin Compose ;
- un pare-feu limité à SSH, 80 et 443 ;
- l'enregistrement DNS de `SITE_ADDRESS` ;
- les dossiers `/srv/sol-token-listener/{secrets,config,backups}` ;
- le timer de sauvegarde ;
- un budget RPC du listener tenable. Sa charge HTTP est estimée entre 20 000 et 55 000 crédits par
  heure, au-delà d'un forfait gratuit.

Procédure :

- copier `secrets/` et `config/` du Mac par `scp -rp`, en conservant les modes ;
- arrêter la stack du Mac ;
- exporter sa base avec `sol_compose exec -T postgres pg_dump -Fc …` ;
- restaurer sur le serveur avec l'étape 4 ;
- démarrer avec `deploy/compose.server.yaml`. Caddy obtient le certificat Let's Encrypt au premier
  démarrage.

## Rotation des secrets

- Un fichier du back (URL Helius, clé, jeton) : remplacer le fichier, puis `sol_compose restart back`.
- Un mot de passe de login : remplacer le fichier, puis `sol_compose run --rm migrate` et
  `sol_compose restart back`.
- Le mot de passe du front : supprimer `secrets/front/front-basic-auth-hash`, relancer
  `deploy/host/init-secrets.sh "$SOL_HOST_DIR"`, puis `sol_compose restart front`.
- Le mot de passe administrateur : il passe par l'entrée standard, jamais par la ligne de
  commande.

  ```bash
  new_password="$(openssl rand -hex 32)"
  printf "ALTER ROLE sol_owner PASSWORD '%s';\n" "$new_password" \
    | sol_compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sol_owner -d sol_token_listener
  printf '%s\n' "$new_password" > "$SOL_HOST_DIR/secrets/db/postgres-admin-password"
  unset new_password
  ```

## Frontière de sécurité

- La keypair n'est lisible que par l'utilisateur `h2b`, dans un tmpfs. Elle n'apparaît dans aucune
  image, aucun compose, aucune variable d'environnement de conteneur et aucun log.
- Chaque processus se connecte avec son propre login PostgreSQL `NOINHERIT`, membre d'un seul rôle
  de groupe ; seul `migrate` reçoit le mot de passe administrateur.
- Aucun achat sans `sol trading start` après un redémarrage ; les sorties restent automatiques.
- Ni la base ni le back ne publient de port ; le front n'expose que GET, HEAD et OPTIONS, derrière
  un mot de passe ou, pour `/operator/v1/`, le jeton de l'API opérateur.
- Caddy ne bloque pas les tentatives répétées : la longueur du mot de passe (32 caractères
  aléatoires) compense, et un fail2ban sur les journaux de Caddy reste possible sur le serveur.
- La stack est limitée à un réplica unique. Elle n'offre aucune promesse de première position, de
  sellabilité ou de profit.
