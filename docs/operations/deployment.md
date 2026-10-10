# Déploiement du bot complet (Docker Compose)

Ce runbook exploite la stack décrite par deux specs :
`docs/superpowers/specs/2026-10-09-full-bot-compose-design.md` et
`docs/superpowers/specs/2026-10-09-vault-secrets-design.md`. Quatre conteneurs (`postgres`,
`vault`, `back`, `front`) et une tâche `migrate` remplacent les processus lancés à la main sur
l'hôte. Configuration et secrets vivent dans Vault. Sur l'hôte ne restent que les secrets
d'amorçage, des fichiers hors du dépôt, jamais affichés : ne lancez aucun `cat`, `echo` ou `env`
sur eux.

## Topologie

| Conteneur | Contenu | Réseaux | Ports publiés |
|---|---|---|---|
| `postgres` | PostgreSQL 16.14, volume `postgres-data` | `internal` | aucun |
| `vault` | HashiCorp Vault 2.1.2, stockage raft dans le volume `vault-data`, déverrouillage automatique | `internal`, `vault-ui` | `127.0.0.1:8200` (interface locale) |
| `migrate` | tâche ponctuelle : migrations, droits, neuf logins | `internal` | aucun |
| `back` | `supervisord` et un utilisateur Unix par processus | `internal`, `egress`, `edge` | aucun |
| `front` | Caddy : console, relais `/api/v1` et `/operator/v1/`, mot de passe | `edge` | Mac : `127.0.0.1:8080` ; serveur : 80 et 443 |

Programmes du back : `listener`, `opapi` et `retention` en mode `observe` ; s'y ajoutent `h2a`,
`h2b` (relancé à la demande) et `autoarm` en mode `live` ; `worker` ne tourne que pendant
`sol qualify`. `autoarm` n'arme rien tant que l'état de contrôle n'est pas `RUNNING`, ce que seul
`sol trading start` rétablit après un redémarrage.

Trois services ponctuels du profil `tools` tournent sur l'image back : `vault-setup`,
`vault-import` et `vault-snapshot`. `up` ne les démarre jamais. Les scripts de `deploy/host/` les
lancent par `docker compose run --no-deps`, qui ne démarre ni ne recrée Vault.

## Prérequis

- Docker avec le plugin Compose 2.24.4 ou plus récent (Docker Desktop sur le Mac).
- `openssl`, et un checkout du dépôt au commit livré.
- Pour le mode `live` : les fichiers actuels de `~/.sol-token-listener/lot5/` (environnements,
  clés) et la base actuelle (conteneur `sol-token-listener-live-pg`, port 5433).

Préparer le shell, sur le Mac :

```bash
export SOL_HOST_DIR="$HOME/.sol-token-listener/docker"
export SOL_ENV="$SOL_HOST_DIR/compose.env"
export COMPOSE_PROJECT_NAME=sol-token-listener
sol_compose() {
  docker compose --env-file "$SOL_ENV" -f deploy/compose.yaml "$@"
}
```

Sur le serveur, le fichier `deploy/compose.server.yaml` publie 80 et 443 et active HTTPS :

```bash
export SOL_HOST_DIR=/srv/sol-token-listener
export SOL_ENV="$SOL_HOST_DIR/compose.env"
export COMPOSE_PROJECT_NAME=sol-token-listener
sol_compose() {
  docker compose --env-file "$SOL_ENV" -f deploy/compose.yaml -f deploy/compose.server.yaml "$@"
}
```

`COMPOSE_PROJECT_NAME` nomme le projet, ses conteneurs et ses volumes, par exemple
`sol-token-listener_vault-data`. Un exercice sur un projet jetable ne change que cette variable et
le dossier hôte (« Sauvegardes »).

Sur l'un comme sur l'autre, `sol_vault` lance la CLI de Vault dans le conteneur `vault`. Elle
reçoit le jeton de la variable `VAULT_TOKEN` du shell, jamais sur la ligne de commande ni sur
disque :

```bash
sol_vault() {
  sol_compose exec -T -e VAULT_TOKEN vault vault "$@"
}
```

## Images

Après l'étape 1 de « Dossier hôte et Vault » : construire les images sur l'hôte depuis le commit
livré, avec une étiquette qui porte son SHA. Les commandes écrivent les trois étiquettes dans
`compose.env`, que la construction lit.

```bash
revision="$(git rev-parse --short=12 HEAD)"
sed -i.bak -e "s#^BACKEND_IMAGE=.*#BACKEND_IMAGE=sol-token-listener/backend:$revision#" \
  -e "s#^FRONTEND_IMAGE=.*#FRONTEND_IMAGE=sol-token-listener/frontend:$revision#" \
  -e "s#^VAULT_IMAGE=.*#VAULT_IMAGE=sol-token-listener/vault:$revision#" "$SOL_ENV"
rm -f "$SOL_ENV.bak"
sol_compose build back front vault
```

Le smoke isolé valide la topologie avec un Vault jetable, sans RPC ni secret réel :
`npm run deployment:smoke`.

## Dossier hôte et Vault

Les variables des processus vivent dans Vault : configuration de chaque rôle et secrets. Sur
l'hôte ne restent que les secrets d'amorçage :

- le mot de passe administrateur PostgreSQL ;
- l'empreinte du mot de passe du front ;
- la clé de déverrouillage de Vault ;
- les identifiants AppRole de `back`, `migrate` et de la sauvegarde.

1. Créer le dossier hôte. Le script ne remplace jamais un fichier existant. Il affiche une seule
   fois le mot de passe du front : le ranger aussitôt dans le gestionnaire de mots de passe.

   ```bash
   deploy/host/init-secrets.sh "$SOL_HOST_DIR"
   cp deploy/env.example "$SOL_ENV"
   chmod 0600 "$SOL_ENV"
   ```

   Il crée aussi les deux dossiers vides `secrets/vault/unseal/` et `secrets/vault/approle/`.

   Dans `compose.env`, renseigner :
   - `SOL_HOST_DIR` ;
   - les trois images `BACKEND_IMAGE`, `FRONTEND_IMAGE` et `VAULT_IMAGE`, que la section
     « Images » écrit pour une construction locale ;
   - `SOL_STACK_MODE` ;
   - `SITE_ADDRESS`, sur le serveur.

   Ce fichier ne contient aucun secret. Les scripts de `deploy/host/` le lisent à cet endroit,
   `$SOL_HOST_DIR/compose.env`.

2. Initialiser Vault, une seule fois. Les images doivent déjà exister : construites (section
   « Images ») ou tirées d'un registre.

   ```bash
   deploy/host/vault-init.sh
   ```

   Le script refuse de s'exécuter si `secrets/vault/unseal/` et `secrets/vault/approle/` ne sont
   pas des dossiers vides, à vous et inscriptibles. `init-secrets.sh` les crée ainsi. Sans cette
   vérification, Docker créerait un dossier manquant au nom de root : la clé ne pourrait pas y être
   écrite, et elle serait perdue alors que Vault serait déjà initialisé.

   Le script démarre `vault`, attend son API, puis lance `vault-setup` sous votre utilisateur.
   Celui-ci :
   - initialise Vault avec une seule part de clé ;
   - écrit la clé de déverrouillage dans `secrets/vault/unseal/` et les trois AppRoles dans
     `secrets/vault/approle/` ;
   - active le journal d'audit (section « Santé et journaux ») ;
   - génère dans Vault les neuf mots de passe de login et le jeton de l'API opérateur ;
   - crée le login `operator` et affiche une seule fois son mot de passe ;
   - révoque le jeton root.

   Le script finit par une ligne `next:`. Ranger aussitôt dans le gestionnaire de mots de passe :
   - le mot de passe Vault `operator`, distinct de celui du front ;
   - une copie de la clé, sans l'afficher : sur le Mac,
     `pbcopy < "$SOL_HOST_DIR/secrets/vault/unseal/unseal-key"`, puis vider le presse-papiers
     (`pbcopy < /dev/null`). Sans cette clé, aucune sauvegarde de Vault ne se restaure.

   Le presse-papiers expose la clé aux gestionnaires de presse-papiers et au presse-papiers
   universel d'Apple : désactiver ces gestionnaires et Handoff le temps de l'opération, ou saisir
   la clé à la main dans le gestionnaire de mots de passe.

   Vérifier une fois cette copie, sans l'afficher : la recopier depuis le gestionnaire de mots de
   passe, puis comparer. La commande doit afficher `copie identique` :

   ```bash
   [ "$(pbpaste | tr -d '\r\n' | shasum -a 256)" = "$(tr -d '\r\n' < "$SOL_HOST_DIR/secrets/vault/unseal/unseal-key" | shasum -a 256)" ] && echo 'copie identique'
   pbcopy < /dev/null
   ```

   Sur des restes d'une exécution précédente, le script s'arrête avec le code 78, sans lancer
   Docker. Ses messages :
   - `…unseal-key exists: Vault is already initialized: nothing to do (to start over, see the runbook)` :
     la clé et les trois fichiers AppRole sont là. Rien à faire, si l'exécution précédente a
     affiché sa ligne `next:` ; sinon, suivre le message de `vault-setup` de cette exécution ;
   - `…unseal-key exists but the AppRole files are missing: if vault-init never printed its next: line, start over as the runbook says; otherwise recreate the missing file as the runbook says` :
     sans ligne `next:`, l'initialisation précédente n'a pas abouti : repartir de zéro, comme
     ci-dessous. Après une ligne `next:`, Vault est en service et a perdu un fichier AppRole : le
     recréer, comme ci-dessous ;
   - `…approle holds AppRole files but …unseal-key is missing: Vault is already initialized: put the key back as the runbook says; do not start over` :
     Vault est en service et sa clé manque sur l'hôte. La remettre, comme ci-dessous ;
   - `…holds files of an earlier attempt: start over as the runbook says` : un autre reste occupe
     l'un des deux dossiers. Repartir de zéro, comme ci-dessous.

   Un Vault en service ne repart jamais de zéro. Il l'est si la stack a déjà tourné, ou si
   `sol_compose exec vault vault status` le montre initialisé et déverrouillé et que l'interface y
   montre des entrées. Il lui manque alors la clé, ou un fichier AppRole :
   - remettre la clé depuis le gestionnaire de mots de passe, ou depuis
     `secrets/unseal-key.sealed` (« Sceller Vault en urgence »), en mode 0600. Sur le Mac :
     `(umask 077 && set -C && pbpaste > "$SOL_HOST_DIR/secrets/vault/unseal/unseal-key")`, puis
     `pbcopy < /dev/null`. Lancer ensuite `sol_compose restart vault`, sans rien supprimer ;
   - recréer un fichier AppRole manquant comme à sa rotation (« Secret d'un AppRole ») : lecture
     du `role_id`, puis un nouveau `secret_id`.

   La clé existe, mais Vault est vide : après `sol_compose up --detach vault`,
   `sol_compose exec vault vault status` montre `Initialized false`. C'est le volume `vault-data`
   qui est perdu : restaurer le dernier instantané (« Restaurer Vault »). Seul `vault status` le
   prouve : le journal du premier démarrage peut montrer `vault.uninitialized`,
   `vault.unseal_key_missing` ou `vault.unseal_failed` sans que rien ne soit perdu.

   Seulement sans aucune copie, la clé est perdue : repartir de zéro, comme ci-dessous. Si
   `sol_compose exec vault vault status` montre encore `Sealed false`, ce Vault en marche est la
   dernière copie lisible des valeurs : ne pas le redémarrer, et relever dans l'interface les
   entrées modifiées depuis l'import avant d'effacer quoi que ce soit.

   Repartir de zéro aussi quand l'initialisation n'a jamais abouti : `vault-setup` a répondu
   `the unseal key is saved: start over as the runbook says` ou
   `Vault may be initialized but its unseal key was not saved: start over as the runbook says`, ou
   `vault-init.sh` répond
   `if vault-init never printed its next: line, start over as the runbook says` alors qu'aucune
   ligne `next:` n'est jamais apparue. Aucun mot de passe `operator` n'a alors été
   affiché : Vault ne contient encore rien. Garder une copie de `secrets/vault/`, puis supprimer
   le conteneur, le volume et les fichiers de `secrets/vault/`. Le bloc affiche le projet visé et
   ne fait rien tant que son nom n'est pas retapé :

   ```bash
   printf 'Projet %s : retaper son nom pour continuer : ' "$COMPOSE_PROJECT_NAME" && IFS= read -r confirm \
     && [ "$confirm" = "$COMPOSE_PROJECT_NAME" ] \
     && cp -Rp "$SOL_HOST_DIR/secrets/vault" "$SOL_HOST_DIR/secrets/vault.before-reset-$(date -u +%Y%m%dT%H%M%SZ)" \
     && sol_compose rm --stop --force --volumes vault \
     && docker volume rm "${COMPOSE_PROJECT_NAME:?}_vault-data" \
     && find "$SOL_HOST_DIR/secrets/vault/unseal" "$SOL_HOST_DIR/secrets/vault/approle" -mindepth 1 -delete
   ```

   Avec le dernier instantané, cette copie permet de revenir sur un départ à zéro fait par erreur ;
   `vault-init.sh` ne vérifie que `unseal/` et `approle/`. Puis relancer
   `deploy/host/vault-init.sh`, et l'import (étape 3). Repartir de zéro régénère les neuf mots de
   passe de login et le jeton de l'API opérateur : sur une stack qui a déjà tourné, lancer
   `sol_compose run --rm migrate` avant tout redémarrage du back.

3. Importer les fichiers actuels. Le script lit les fichiers de rôle du lot 5 et les fichiers de
   clés qu'ils nomment, demande le mot de passe `operator`, puis écrit le tout dans Vault sans
   afficher aucune valeur :

   ```bash
   deploy/host/vault-import.sh "$HOME/.sol-token-listener/lot5/env"
   ```

   L'import :
   - retire les variables que `sol-run` injecte ;
   - réécrit les chemins de preuves vers `/var/lib/sol/evidence`. Le second argument, facultatif,
     nomme le dossier de preuves d'origine ; par défaut, `evidence/` à côté du dossier source ;
   - fixe `API_HOST=0.0.0.0`, `API_PORT=3000`, `OPERATOR_API_HOST=0.0.0.0` et
     `OPERATOR_API_PORT=3100` ;
   - prend le modèle du dépôt pour un rôle absent de la source (`retention` par exemple) ;
   - valide chaque entrée avant la première écriture ;
   - n'affiche que les noms des entrées écrites (`vault.imported`).

   Vault doit tourner : l'import ne le démarre pas. Le relancer crée une nouvelle version de
   chaque entrée : il remplace les modifications faites depuis dans Vault, qui restent dans les
   versions précédentes.

4. Ouvrir l'interface, `http://127.0.0.1:8200` (login `operator`), et vérifier sous `sol/config/` :
   - `operator-api` : `OPERATOR_API_ALLOWED_ORIGIN=http://127.0.0.1:8080`, ou
     `https://<SITE_ADDRESS>` sur le serveur ;
   - les chemins, tous sous `/var/lib/sol/evidence` : `EXECUTOR_PREFLIGHT_EVIDENCE_PATH` et
     `EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH` (`operations`), `EXECUTOR_PREFLIGHT_DRAFT_PATH`
     (`preflight-bundle`), `EXECUTOR_PROVIDER_EVIDENCE_PATH` (`provider-evidence` et `readiness`) ;
   - `preflight-bundle` : `EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY=/var/lib/sol/evidence/bundle`.

   L'import ne réécrit que les chemins placés sous l'ancien dossier de preuves : corriger ici tout
   autre chemin. Le jeton de l'API opérateur, que la console demande pour `/operator/v1/`, se lit
   aussi dans l'interface : `sol/secrets/back/operator-api-token`. Sur le serveur, l'interface
   passe par un tunnel : `ssh -L 8200:127.0.0.1:8200 <serveur>`.

### Modifier une valeur

Dans l'interface, ou en ligne de commande dans une session `operator`. Le mot de passe passe par
l'entrée standard et le jeton reste dans la variable `VAULT_TOKEN` du shell : ni l'un ni l'autre
n'apparaît sur une ligne de commande ou sur disque.

```bash
printf 'Mot de passe operator : ' && IFS= read -rs password && printf '\n'
VAULT_TOKEN="$(printf '%s' "$password" | sol_compose exec -T vault vault write -field=token auth/userpass/login/operator password=-)"
export VAULT_TOKEN
unset password
```

Puis, par exemple :

```bash
sol_vault kv patch sol/config/live EXECUTOR_SLIPPAGE_BPS=300
```

Une valeur secrète (URL Helius, clé, jeton, keypair) ne passe jamais sur la ligne de commande :
l'historique du shell la garderait, et `ps` la montrerait. La lire sur l'entrée standard :

```bash
printf 'Valeur : ' && IFS= read -rs value && printf '\n'
printf '%s' "$value" | sol_vault kv put sol/secrets/back/helius-listener-http-url value=-
unset value
```

La keypair se donne telle quelle, texte exact de son fichier :
`sol_vault kv put sol/secrets/back/wallet-keypair.json value=- < "$keypair_file"`, `keypair_file`
désignant le chemin du fichier.

Fermer la session, puis redémarrer le back :

```bash
sol_vault token revoke -self > /dev/null
unset VAULT_TOKEN
sol_compose restart back
```

Chaque valeur de Vault est du texte :

- dans le mode JSON de l'interface, mettre les nombres entre guillemets :
  `"EXECUTOR_SLIPPAGE_BPS": "300"`, jamais `300` ;
- la keypair (`sol/secrets/back/wallet-keypair.json`, champ `value`) est le texte du fichier,
  jamais un tableau JSON ;
- la forme `sol_vault kv patch … VARIABLE=valeur` envoie déjà du texte.

Le journal d'audit masque les textes, pas les nombres ni les booléens : ceux-ci apparaîtraient en
clair dans `docker logs`, à chaque lecture.

Vault garde les versions précédentes de chaque entrée : le bouton de l'interface, ou
`sol_vault kv rollback -version=<n> sol/config/live` dans une session `operator`, les restaure. Le
back ne lit Vault qu'à son démarrage. Le redémarrage pose l'entry-stop : relancer
`sol trading start` (section « Trading »).

Vault accepte toute saisie : c'est `vault-pull`, au démarrage du back, qui refuse une entrée
invalide. Il refuse une configuration qui contient un mot de passe, une clé, un jeton, une URL avec
identifiants ou une variable injectée, et toute valeur sur plusieurs lignes ou qui n'est pas du
texte ; une valeur de configuration l'est aussi pour un `#`, des guillemets ou des espaces en
bord. Le back ne démarre pas, et le message nomme l'entrée et la variable, jamais la valeur. Une
fois l'entrée corrigée, le back, relancé en boucle par Docker, reprend seul.

Un secret mal formé (URL invalide, plusieurs lignes) passe `vault-pull` : `sol-run` refuse alors
de lancer le programme qui le lit (`BACKOFF`), et le message nomme le fichier.

Les preuves et le catalogue de gates vivent dans le volume `evidence`, propriété de l'utilisateur
`ops`. Pour y copier un fichier existant, une fois la stack créée :

```bash
evidence_file=gate-catalog.json
sol_compose cp "$HOME/.sol-token-listener/lot5/evidence/$evidence_file" "back:/var/lib/sol/evidence/$evidence_file"
sol_compose exec back chown ops:ops "/var/lib/sol/evidence/$evidence_file"
```

## Démarrage et arrêt

`vault` démarre et se déverrouille seul avec la clé de `secrets/vault/unseal/`. La tâche
`migrate` attend Vault et PostgreSQL, lit les mots de passe des logins dans Vault, puis s'exécute
sous le verrou consultatif `pg_advisory_lock` des migrations. Elle :
- applique les migrations ;
- rejoue `scripts/provision-executor-roles.sql` ;
- crée ou met à jour les neuf logins `NOINHERIT`, chacun membre d'un seul rôle de groupe.

Les migrations restent forward-only. Le back lit ensuite sa configuration et ses secrets dans
Vault. Sans Vault, ni `migrate` ni le back ne démarrent, et aucun ne se rabat sur des fichiers.

```bash
sol_compose up --detach --wait --wait-timeout 180
sol_compose exec back sol status
```

En mode `live`, le script d'entrée du back ramène un état de contrôle `RUNNING` à `ENTRY_STOP`
avant de lancer les programmes : aucun nouvel achat ne part après un redémarrage, alors que H2a,
H2b et `autoarm` assurent les sorties. Si le back redémarre en boucle en mode `live`, lire
`sol_compose logs back` : la lecture de l'état de contrôle a échoué, souvent à cause d'une
entrée `sol/config/operations` invalide.

Arrêt normal, qui conserve la base :

```bash
sol_compose stop
```

`stop` attend au plus 240 s (`stop_grace_period`) : `supervisord` arrête les programmes l'un
après l'autre. Il laisse 40 s à ceux qui ont leur propre délai d'arrêt de 30 s (listener, H2a,
H2b, auto-arm, worker) et 10 s aux autres. En pratique, chacun s'arrête en quelques secondes.
`vault`, arrêté après le back, dispose de 30 s pour fermer son stockage raft.

`down --volumes` efface tous les volumes de la stack : la base, mais aussi les preuves
(`evidence`), le certificat TLS (`caddy-data`) et tout le contenu de Vault (`vault-data`). Ne
jamais l'utiliser. Pour repartir d'une base vide, voir l'étape 4 de la reprise.

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
détentrice du mot de passe administrateur. Il ne lit que le fichier de ce mot de passe, jamais
Vault : avec `--no-deps`, Compose ne démarre ni ne recrée Vault pour lui.

```bash
sol_compose run --rm --no-deps migrate sol-admin report
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
sol_compose exec back sh -c 'umask 077 && sol ops envelope prepare --valid-ms=21600000 > /var/lib/sol/evidence/preflight-draft.json && chown ops:ops /var/lib/sol/evidence/preflight-draft.json'
sol_compose exec back rm -rf /var/lib/sol/evidence/bundle
sol_compose exec back sol evidence bundle
sol_compose exec -it back sol ops envelope create --per-buy-lamports=10000000 --max-buys=5 \
  --max-exposure-lamports=10000000 --max-loss-lamports=30000000 --holding-ms=300000
sol_compose exec back sol qualify stop
sol_compose exec -it back sol trading start
```

`envelope prepare` échoue tant qu'aucun artefact de simulation `SUCCESS` de moins de 24 h
n'existe : attendre la sonde suivante, puis recommencer. H2f ne lit le brouillon que s'il
appartient à `ops` en mode 0600 : la redirection, faite en root, le crée sous `umask 077`, puis
`chown` le rend à `ops`. H2f exige aussi un répertoire de sortie absent, d'où le `rm -rf` du
paquet précédent, déjà consommé.

## Santé et journaux

- `sol_compose ps` : `back` est sain quand chaque programme du mode tourne, que H2b tourne ou attend
  du travail, et que l'API du listener répond `OK`. Avec `SOL_HEALTH_REQUIRE_OK=false`, l'état
  `DEGRADED` est aussi accepté, utile si le projet RPC du listener est épuisé.
- Un programme qui ne démarre pas (base ou RPC indisponible) est relancé sans fin, avec un délai
  qui s'allonge d'une seconde à chaque échec : environ 1 min 30 après une heure de panne.
  `sol status` le montre en `BACKOFF`, et le message de `sol-health` nomme cet état. Une fois la
  cause corrigée, `sol_compose exec back sol ctl restart <programme>` le relance tout de suite.
- `sol_compose logs -f back` : une ligne JSON par événement, avec le nom du service. Le pilote
  `json-file` garde 5 fichiers de 20 Mo par conteneur.
- `vault` est sain une fois déverrouillé. Son journal montre `vault.unsealed` à chaque démarrage
  d'un Vault initialisé. Le premier démarrage, avant ou pendant `vault-init.sh` ou une
  restauration, peut laisser `vault.uninitialized`, `vault.unseal_key_missing` ou
  `vault.unseal_failed` : seul `sol_compose exec vault vault status` dit si le volume `vault-data`
  est perdu, en montrant `Initialized false` (« Restaurer Vault »). Plus tard, le journal montre
  `vault.unseal_key_missing` si le fichier de clé manque, `vault.unseal_failed` si le
  déverrouillage échoue, par exemple avec une mauvaise clé, et `vault.api_unavailable` si l'API
  n'a pas répondu après 60 essais. Après avoir remis le bon fichier dans `secrets/vault/unseal/`,
  lancer `sol_compose restart vault` : le script d'entrée ne déverrouille qu'au démarrage du
  conteneur.
- `vault-pull: Vault unavailable for 60 s` dans le journal du back : Vault était arrêté ou
  verrouillé pendant 60 s. Le back redémarre en boucle jusqu'au retour de Vault, puis reprend
  seul ; en mode `live`, relancer ensuite `sol trading start`.
- Le journal d'audit de Vault est `sol_compose logs vault` : chaque requête authentifiée et sa
  réponse, textes masqués (HMAC). Il tourne avec les autres journaux (`json-file`, 5 fichiers de
  20 Mo) et disparaît quand le conteneur est recréé. Une sortie bloquée arrête Vault plutôt que de
  le laisser servir sans trace, mais `json-file` peut perdre des lignes qu'il ne peut pas écrire,
  disque plein par exemple : ce journal n'est pas une preuve durable.

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

`deploy/host/backup.sh` lance `pg_dump -Fc` dans le conteneur `postgres` et prend un instantané
raft de Vault avec l'AppRole `backup`. Il écrit l'empreinte SHA-256 de chacun et garde 14 jours
dans `$SOL_HOST_DIR/backups`.

L'instantané est chiffré. Le restaurer exige la clé de déverrouillage, qui n'est jamais dans les
sauvegardes. Le dossier des secrets n'est jamais sauvegardé. La copie hors machine
(sauvegarde externe) reste à la charge de l'opérateur.

Le service `vault-snapshot` tourne avec `--no-deps` : la sauvegarde ne démarre ni ne recrée
Vault, et un Vault arrêté la fait échouer. Un échec garde ce qui est terminé (le dump, si seul
l'instantané échoue), jamais un fichier partiel ou vide. Sans `secrets/vault/approle/backup.json`,
le script s'arrête avec le code 78.

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

La restauration doit être répétée régulièrement sur un projet jetable, sans toucher à la stack :

1. Préparer un autre dossier hôte : une copie de `secrets/`, et dans `backups/` le dernier
   instantané, avec son empreinte, et le dernier dump. Y créer un `compose.env` comme à l'étape 1
   de « Dossier hôte et Vault », avec `FRONT_PORT=0` et `VAULT_PORT=0` (ports libres) et
   `SOL_HEALTH_REQUIRE_OK=false` (aucun RPC).
2. Dans le shell de l'exercice, pointer `SOL_HOST_DIR` et `SOL_ENV` sur ce dossier, et nommer le
   projet : `export COMPOSE_PROJECT_NAME=<jetable>`.
3. Suivre « Restaurer Vault » sans compléter la stack, puis l'étape 4 de la reprise avec le
   dernier dump à la place de `source.dump` : `pg_restore` doit aboutir.
4. Ne jamais compléter la stack de l'exercice : l'instantané contient les vraies URL Helius et la
   keypair, et `up` démarrerait un second listener.
5. Terminer en effaçant ce seul projet, puis le dossier hôte de l'exercice, qui garde une copie de
   la clé de déverrouillage et des fichiers AppRole :

   ```bash
   sol_compose -p '<jetable>' down --volumes
   rm -r -- '<dossier-hote-jetable>'
   ```

### Restaurer Vault

Restaurer remplace tout le contenu de Vault. Si `sol_compose exec vault vault status` montre
`Initialized true`, Vault n'est pas perdu : ne le restaurer que volontairement, après
`SOL_REPOSITORY="$PWD" deploy/host/backup.sh`.

Sur un Vault vide, avec la clé de déverrouillage d'origine et les fichiers AppRole d'origine dans
`secrets/vault/`. Un instantané antérieur à une rotation d'AppRole ne connaît que l'ancien
`secret_id` : il exige les fichiers AppRole d'avant cette rotation. Un instantané pris après
chaque rotation, une fois le jeton root révoqué (`SOL_REPOSITORY="$PWD" deploy/host/backup.sh`),
évite ce cas.

Vérifier d'abord l'empreinte de l'instantané. Elle doit afficher `OK` ; sur le serveur, remplacer
`shasum -a 256 -c` par `sha256sum -c`.

```bash
snapshot="$SOL_HOST_DIR/backups/vault-<horodatage>.snap"
(cd "$SOL_HOST_DIR/backups" && shasum -a 256 -c "$(basename "$snapshot").sha256")
```

Puis restaurer. La première commande affiche le projet visé et ne supprime rien tant que son nom
n'est pas retapé : un shell d'exercice qui aurait gardé le projet de la stack s'arrête là.

```bash
printf 'Projet %s : retaper son nom pour continuer : ' "$COMPOSE_PROJECT_NAME" && IFS= read -r confirm \
  && [ "$confirm" = "$COMPOSE_PROJECT_NAME" ] \
  && sol_compose rm --stop --force --volumes vault \
  && docker volume rm "${COMPOSE_PROJECT_NAME:?}_vault-data"
sol_compose up --detach vault
sol_compose exec -it vault vault operator init -key-shares=1 -key-threshold=1
sol_compose exec -it vault vault operator unseal
sol_compose cp "$snapshot" vault:/tmp/restore.snap
sol_compose exec -it vault sh -c 'VAULT_TOKEN="$(vault login -token-only)" && export VAULT_TOKEN && vault operator raft snapshot restore -force /tmp/restore.snap' \
  && sealed=no && for i in $(seq 60); do
    if sol_compose logs --since 2m vault | grep -q 'vault is sealed'; then sealed=yes; break; fi
    sleep 1
  done \
  && [ "$sealed" = yes ] \
  && sol_compose restart vault \
  && sol_compose exec vault rm -f /tmp/restore.snap \
  || echo "Restauration échouée, ou Vault non scellé après 60 essais : la reprendre depuis le début." >&2
```

Pendant la restauration :
- `--volumes` retire aussi le volume anonyme `/vault/logs` de l'image, jamais `vault-data`, que
  `docker volume rm` supprime ensuite ;
- `operator init` affiche une clé et un jeton root temporaires ;
- `operator unseal` et `vault login` les demandent au TTY ; `-token-only` garde le jeton hors du
  disque ;
- `restore -force` remplace ces clés et ces données par celles de l'instantané. Il rend la main
  avant la fin : Vault se scelle de lui-même quelques secondes plus tard, ce qu'attend la boucle,
  60 essais au plus, avant le redémarrage.

Si `restore -force` échoue, ou si Vault ne se scelle pas, rien ne redémarre et le bloc le dit.
Vault garde alors les clés temporaires, et un redémarrage montrerait `vault.unseal_failed` :
reprendre la restauration depuis la confirmation.

Le back qui tourne n'a pas besoin de Vault : le laisser tourner, ventes comprises. Sur un hôte où
la stack n'a jamais tourné, `docker volume rm` signale un volume absent : sans conséquence.

Au redémarrage, Vault se déverrouille avec la clé d'origine (`vault.unsealed`). Les AppRoles et le
login `operator` d'origine fonctionnent de nouveau. Compléter ensuite la stack ; si le back a
redémarré entre-temps, relancer `sol trading start` en mode `live` :

```bash
sol_compose up --detach --wait --wait-timeout 180
```

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
   sol_compose run --rm --no-deps migrate sol-admin group-roles
   sol_compose exec -T postgres sh -c 'exec pg_restore --exit-on-error --single-transaction -U sol_owner -d "$POSTGRES_DB"' \
     < "$takeover/source.dump"
   sol_compose exec -T postgres sh -c 'exec psql -X -A -t -v ON_ERROR_STOP=1 -U sol_owner -d "$POSTGRES_DB"' \
     < deploy/sql/table-row-counts.sql > "$takeover/target.counts"
   diff "$takeover/source.counts" "$takeover/target.counts"
   sol_compose run --rm migrate
   ```

   `group-roles` n'a pas besoin de Vault : avec `--no-deps`, il tourne sans lui. La dernière
   commande lit les mots de passe des logins dans Vault, qui doit donc être initialisé
   (« Dossier hôte et Vault »).

   Le `diff` doit être vide. Une erreur de `pg_restore` annule toute la restauration : corriger la
   cause, puis repartir d'une base vide en supprimant seulement le volume de la base (jamais
   `down --volumes`, qui efface aussi Vault, les preuves et le certificat TLS) :

   ```bash
   sol_compose down
   docker volume rm "${COMPOSE_PROJECT_NAME:?}_postgres-data"
   ```

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
`sol_compose stop`, `docker start sol-token-listener-live-pg`, puis relancer les
processus de l'hôte comme avant, depuis un `dist/` reconstruit sur `main`. Après un trade, le
retour passe par un dump inverse : les étapes 3 et 4 dans l'autre sens, de la stack vers une base
vide.

## Bascule vers le serveur

Prérequis :

- Docker et son plugin Compose ;
- un pare-feu limité à SSH, 80 et 443 ;
- l'enregistrement DNS de `SITE_ADDRESS` ;
- les dossiers `/srv/sol-token-listener/{secrets,backups}` ;
- le timer de sauvegarde ;
- un budget RPC du listener tenable. Sa charge HTTP est estimée entre 20 000 et 55 000 crédits par
  heure, au-delà d'un forfait gratuit.

Procédure : sur le Mac, amener d'abord la base à la précondition, puis la vérifier.
`sol_compose exec back sol trading stop` arrête les achats ; attendre que les positions ouvertes
soient vendues à leur échéance. Révoquer ensuite l'enveloppe que
`sol_compose exec back sol ops envelope show` donne `ACTIVE` :
`sol_compose exec back sol ops envelope revoke --envelope-id=<id>`. La ligne doit être `0|0|0|0` ;
sinon, ne pas aller plus loin.

```bash
sol_compose exec -T postgres sh -c 'exec psql -X -A -t -v ON_ERROR_STOP=1 -U sol_owner -d "$POSTGRES_DB"' \
  < deploy/sql/takeover-precondition.sql
```

Puis arrêter le back seul (la base et Vault restent démarrés), exporter comme à l'étape 3, prendre
un instantané à jour, et arrêter la stack :

```bash
sol_compose stop back
takeover="$SOL_HOST_DIR/backups/takeover-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$takeover"
sol_compose exec -T postgres sh -c 'exec pg_dump -Fc -U sol_owner -d "$POSTGRES_DB"' > "$takeover/source.dump"
shasum -a 256 "$takeover/source.dump" > "$takeover/source.dump.sha256"
sol_compose exec -T postgres sh -c 'exec psql -X -A -t -v ON_ERROR_STOP=1 -U sol_owner -d "$POSTGRES_DB"' \
  < deploy/sql/table-row-counts.sql > "$takeover/source.counts"
SOL_REPOSITORY="$PWD" deploy/host/backup.sh
sol_compose stop
```

Ensuite :

- copier `secrets/` et `backups/` vers le serveur par `scp -rp`, en conservant les modes ;
- sur le serveur, avec un checkout, `compose.env` et les images (« Images ») : « Restaurer Vault »,
  sans compléter la stack, puis l'étape 4, `takeover` désignant le dossier copié ;
- démarrer avec `deploy/compose.server.yaml`, puis `sol trading start` en mode `live`. Caddy obtient
  le certificat Let's Encrypt au premier démarrage.

La bascule restaure un instantané plutôt que de copier le volume `vault-data` : une copie directe
devrait garder l'uid 100 (l'utilisateur `vault` de l'image) sur chaque fichier.

Une fois le serveur validé et en trading, retirer la copie du Mac, qui garde toute la
configuration et les secrets :

1. Ne plus jamais redémarrer la stack du Mac en mode `live` : deux bots se partageraient le
   wallet.
2. Sur le Mac seulement, décharger la sauvegarde planifiée, puis effacer son projet et ses
   volumes, base et Vault compris. Le projet du serveur porte le même nom : la dernière commande
   refuse de s'exécuter hors de Docker Desktop, ou avec un autre dossier hôte que celui du Mac.
   Elle protège ainsi le serveur, même atteint par un contexte Docker ou `DOCKER_HOST`.

   ```bash
   launchctl bootout "gui/$(id -u)/com.sol-token-listener.backup"
   rm -f "$HOME/Library/LaunchAgents/com.sol-token-listener.backup.plist"
   [ "$(docker info --format '{{.OperatingSystem}}')" = 'Docker Desktop' ] && [ "$SOL_HOST_DIR" = "$HOME/.sol-token-listener/docker" ] && sol_compose -p sol-token-listener down --volumes
   ```

   Sans le fichier `.plist`, la sauvegarde ne revient pas à la connexion suivante.

3. Vérifier les sauvegardes hors machine et les copies du gestionnaire de mots de passe
   (`copie identique`), puis supprimer du Mac `"$SOL_HOST_DIR/secrets"` et les fichiers en clair du
   lot 5 : `~/.sol-token-listener/lot5/env` et les fichiers de clés que ses fichiers nomment.

## Rotation des secrets

- **Une valeur de Vault** (URL Helius, clé, jeton, configuration) : la modifier dans Vault
  (« Modifier une valeur », jamais sur la ligne de commande pour un secret), puis
  `sol_compose restart back` et `sol trading start`.
- **Le mot de passe d'un login :** le modifier dans Vault (`sol/secrets/logins/<login>`, sur
  l'entrée standard comme tout secret), puis aussitôt `sol_compose run --rm migrate`, avant tout
  redémarrage du back : un back redémarré entre-temps lirait un mot de passe que PostgreSQL ne
  connaît pas encore. Puis `sol_compose restart back` et `sol trading start`.
- **Le mot de passe du front :** supprimer `secrets/front/front-basic-auth-hash`, relancer
  `deploy/host/init-secrets.sh "$SOL_HOST_DIR"`, puis `sol_compose restart front`.
- **Le mot de passe administrateur PostgreSQL :** il passe par l'entrée standard, jamais par la
  ligne de commande.

  ```bash
  new_password="$(openssl rand -hex 32)"
  printf "ALTER ROLE sol_owner PASSWORD '%s';\n" "$new_password" \
    | sol_compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sol_owner -d sol_token_listener
  printf '%s\n' "$new_password" > "$SOL_HOST_DIR/secrets/db/postgres-admin-password"
  unset new_password
  ```
- **Le secret d'un AppRole** et **le mot de passe `operator`** demandent un jeton root : voir les
  sections suivantes.

Changer la clé de déverrouillage (`vault operator rekey`) sort du périmètre de ce runbook.

### Jeton root

`generate-root` fonctionne sans jeton parce que `deploy/vault/vault.hcl` fixe
`enable_unauthenticated_access = ["generate-root"]` : sans ce réglage, Vault 2 le refuse.
Quiconque joint l'API peut donc lancer ou annuler une tentative, mais seule la clé de
déverrouillage la termine.

Vérifier d'abord qu'aucune tentative n'est en cours (`Started false`) :

```bash
sol_vault operator generate-root -status
```

Une tentative en cours que vous n'avez pas lancée s'annule avec
`sol_vault operator generate-root -cancel`. Lancer ensuite la vôtre :

```bash
otp="$(sol_vault operator generate-root -generate-otp)"
nonce="$(sol_vault operator generate-root -init -otp="$otp" -format=json | sed -n 's/^ *"nonce": *"\([^"]*\)".*/\1/p')"
encoded="$(sol_vault operator generate-root -nonce="$nonce" -format=json - < "$SOL_HOST_DIR/secrets/vault/unseal/unseal-key" | sed -n 's/^ *"encoded_token": *"\([^"]*\)".*/\1/p')"
VAULT_TOKEN="$(printf '%s' "$encoded" | sol_vault operator generate-root -decode=- -otp="$otp")"
export VAULT_TOKEN
unset otp nonce encoded
```

- La clé passe sur l'entrée standard avec le nonce de votre tentative : si une autre tentative a
  pris sa place, Vault refuse la clé (`incorrect nonce supplied`).
- Le jeton encodé passe lui aussi sur l'entrée standard. Seul l'OTP figure dans les arguments, et
  il ne suffit pas à reconstituer le jeton.
- Le jeton root ne s'affiche jamais : il reste dans la variable `VAULT_TOKEN`, que `sol_vault`
  transmet.

Un jeton root n'expire pas. Le révoquer dès la fin, et même si la procédure s'interrompt :

```bash
sol_vault token revoke -self
unset VAULT_TOKEN
```

### Secret d'un AppRole

Avec le jeton root, pour `back`. Remplacer `back` par `migrate` ou `backup` pour les deux autres :
c'est aussi ainsi que se recrée un fichier AppRole manquant, avec le `role_id` lu et un nouveau
`secret_id`.

```bash
approle="$SOL_HOST_DIR/secrets/vault/approle/back.json"
role_id="$(sol_vault read -field=role_id auth/approle/role/back/role-id)"
created="$(sol_vault write -f -format=json auth/approle/role/back/secret-id)"
secret_id="$(printf '%s\n' "$created" | sed -n 's/^ *"secret_id": *"\([^"]*\)".*/\1/p')"
accessor="$(printf '%s\n' "$created" | sed -n 's/^ *"secret_id_accessor": *"\([^"]*\)".*/\1/p')"
unset created
printf '{"role_id":"%s","secret_id":"%s"}' "$role_id" "$secret_id" | sol_compose exec -T vault vault write -field=token_accessor auth/approle/login - > /dev/null \
  && echo 'secret_id valide' \
  && (umask 077 && printf '{"role_id":"%s","secret_id":"%s"}\n' "$role_id" "$secret_id" > "$approle.new") \
  && mv "$approle.new" "$approle" \
  && sol_compose restart back
unset role_id secret_id
```

Ni le `secret_id` ni le `role_id` ne s'affichent ou ne passent dans les arguments. Le fichier
n'est écrit, en mode 0600, puis le back redémarré, que si la connexion de vérification réussit
(`secret_id valide`) : un `secret_id` mal lu ne remplace jamais le fichier.

`sol_compose logs --since 2m back` doit montrer `vault.pulled`, et `sol_compose ps` le back
`healthy`. Sans `--since`, le journal montre aussi les démarrages précédents. Pour `migrate`,
remplacer `sol_compose restart back` par `sol_compose run --rm migrate`. Pour `backup`, le
retirer : la connexion de vérification suffit, et `backup.sh` prendrait un instantané pendant
que le jeton root vit encore.

Seulement alors, détruire chacun des anciens `secret_id`, c'est-à-dire chaque accessor listé autre
que le nouveau :

```bash
printf 'Nouvel accessor, à garder : %s\n' "$accessor"
sol_vault list auth/approle/role/back/secret-id
sol_vault write auth/approle/role/back/secret-id-accessor/destroy secret_id_accessor='<ancien>'
```

Puis révoquer le jeton root (« Jeton root »), relancer `sol trading start` en mode `live`, et
seulement alors prendre un instantané à jour : `SOL_REPOSITORY="$PWD" deploy/host/backup.sh`.

### Mot de passe `operator`

Avec le jeton root :

```bash
new_password="$(openssl rand -base64 24 | tr -d '\n')"
printf '%s' "$new_password" | sol_vault write auth/userpass/users/operator/password password=- \
  && printf 'Nouveau mot de passe operator, affiché une seule fois : %s\n' "$new_password"
unset new_password
```

Le ranger aussitôt dans le gestionnaire de mots de passe, puis révoquer le jeton root
(« Jeton root »).

## Frontière de sécurité

- La keypair n'est lisible que par l'utilisateur `h2b`, dans un tmpfs. Elle n'apparaît dans aucune
  image, aucun compose, aucune variable d'environnement de conteneur et aucun log.
- Chaque processus se connecte avec son propre login PostgreSQL `NOINHERIT`, membre d'un seul rôle
  de groupe ; seul `migrate` reçoit le mot de passe administrateur.
- Aucun achat sans `sol trading start` après un redémarrage ; les sorties restent automatiques.
- Ni la base ni le back ne publient de port ; le front n'expose que GET, HEAD et OPTIONS, derrière
  un mot de passe ou, pour `/operator/v1/`, le jeton de l'API opérateur. Caddy retire les
  identifiants du front de toute requête relayée vers le back.
- Caddy ne bloque pas les tentatives répétées : la longueur du mot de passe (32 caractères
  aléatoires) compense. Chaque tentative coûte une comparaison bcrypt de coût 10 et le front est
  limité à un demi-CPU : un flot de tentatives ne peut pas affamer le back. Un fail2ban sur les
  journaux de Caddy reste possible sur le serveur.
- Le back, `migrate`, `vault` et les services du profil `tools` tournent avec `no-new-privileges`,
  sans `NET_RAW` ni `MKNOD` et sans fichier core : aucun processus ne regagne un privilège, aucun
  vidage mémoire n'emporte un secret.
- `migrate` n'envoie à PostgreSQL que le vérificateur SCRAM de chaque mot de passe de login,
  jamais le mot de passe lui-même : une erreur journalisée ne peut pas le révéler.
- Vault n'est joignable que depuis le réseau `internal` et sur `127.0.0.1:8200` de l'hôte ; le
  front ne le relaie jamais. Sur Docker Desktop (Mac), tout conteneur le joint aussi par
  `host.docker.internal:8200` : la frontière reste la machine locale. Sur un serveur Linux, seuls
  les conteneurs du réseau `internal` et la boucle locale de l'hôte l'atteignent.
- Chaque conteneur lit Vault avec son propre AppRole, en lecture seule sur ses chemins, avec un
  jeton de 5 minutes révoqué après usage. Aucun jeton root ne survit à l'initialisation. Les
  procédures de ce runbook gardent leurs jetons dans la variable `VAULT_TOKEN` du shell, jamais
  sur disque ni sur une ligne de commande.
- Vault ne verrouille aucun login après des échecs : `vault-setup` désactive ce verrouillage sur
  `approle` et `userpass`. Les secrets sont aléatoires, et un fichier AppRole erroné aurait sinon
  bloqué le back 15 minutes, sorties comprises. Un fichier ou un mot de passe faux est simplement
  refusé (code 77).
- Le déverrouillage automatique garde le bot autonome : qui est root sur l'hôte peut lire la clé.
  Vault centralise et trace les accès ; il ne protège pas contre un hôte compromis.
- En mode `observe`, `vault-pull` ne lit jamais la keypair.
- La stack est limitée à un réplica unique. Elle n'offre aucune promesse de première position, de
  sellabilité ou de profit.

### Sceller Vault en urgence

`vault operator seal` ne tient pas : le déverrouillage automatique le défait au prochain démarrage
du conteneur. Il exige de plus un jeton root, que le login `operator` n'a pas. Pour garder Vault
scellé :

- arrêter le conteneur : `sol_compose stop vault`. Pour rouvrir : `sol_compose start vault`.
  Entre-temps, `sol_compose up`, `start` ou `restart` sans nom de service, ou `run` sans
  `--no-deps`, redémarrerait Vault et le déverrouillerait ;
- ou sortir la clé du dossier monté, sans la supprimer, puis redémarrer `vault` : il reste scellé
  (`vault.unseal_key_missing`).

  ```bash
  mv -n "$SOL_HOST_DIR/secrets/vault/unseal/unseal-key" "$SOL_HOST_DIR/secrets/unseal-key.sealed"
  sol_compose restart vault
  sol_compose exec vault vault status
  ```

  `vault status` doit montrer `Sealed true` : `mv -n` ne remplace pas un `unseal-key.sealed` déjà
  présent, et ne le signale pas. `secrets/` est en 0700 et aucun conteneur ne le monte. Pour
  rouvrir : le `mv -n` inverse, puis `sol_compose restart vault`. Ne supprimer la clé de l'hôte
  qu'après `copie identique` (« Dossier hôte et Vault », étape 2).

Le back déjà démarré continue de tourner, sorties comprises. Il ne redémarre plus tant que Vault
reste scellé : une position ouverte attendrait alors son retour.
