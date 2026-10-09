# Bot complet sous Docker Compose : design

**Date :** 2026-10-09
**Statut :** validé section par section avec l'utilisateur (brainstorming du 2026-10-09)
**Sous-projet :** 1 sur 3. Suivront Vault (sous-projet 2) puis plusieurs comptes Helius
(sous-projet 3), chacun avec son propre spec.
**Relation avec l'existant :** étend `2026-08-11-deployment-foundation-design.md`. Ses
sections 3.2 (conteneur tout-en-un rejeté), 14 (invariants « aucune exécution réelle ») et
15 (non-objectifs) restent valables pour le mode `observe` ; le mode `live` défini ici les
remplace par les invariants de la section 13.

## 1. Objet

Faire tourner le bot complet, y compris l'exécution réelle, dans une stack Docker Compose
reproductible : d'abord sur le Mac de développement, puis 24/7 sur un serveur Linux. La stack
remplace les processus lancés à la main sur l'hôte avec `nohup` et les douze fichiers
d'environnement de `~/.sol-token-listener/lot5/env/`, sans affaiblir les garanties actuelles :
un login PostgreSQL par processus, une keypair accessible au seul exécuteur H2b, une
confirmation humaine avant tout nouvel achat.

## 2. État actuel

- `Dockerfile` multi-cible : `backend` (Node 22, utilisateur `node`, `dist/` compilé) et
  `frontend` (nginx non privilégié servant l'interface).
- `deploy/compose.yaml` : `postgres`, `migrate`, `app` (listener et API publique en mode
  `observe` figé), `retention`, `frontend`. Un seul superutilisateur PostgreSQL, des secrets en
  variables d'environnement, aucun processus d'exécution.
- Production réelle du 2026-10-08 : processus sur l'hôte (listener, H2b `executor-live`, H2a
  `executor-live-recovery`, auto-arm, API opérateur), base PostgreSQL 16 dans le conteneur
  `sol-token-listener-live-pg` sur le port 5433, logins `lot5_*` membres `NOINHERIT` d'un rôle
  de groupe créé par `scripts/provision-executor-roles.sql`.
- Secrets aujourd'hui en fichiers sur l'hôte : mots de passe des logins, URL Helius avec clé
  (projet listener, projet exécuteur), clé de l'API d'administration Helius, clé privée Ed25519
  de signature des preuves, keypair du wallet.

## 3. Décisions de cadrage

| Sujet | Décision |
|---|---|
| Hébergement | Validation sur le Mac (Docker Desktop), puis production 24/7 sur un serveur Linux |
| Données | Reprise de la base actuelle par dump et restauration ; même procédure pour le serveur et les sauvegardes |
| Accès au front | Public en HTTPS sur le serveur |
| Protection du front | Caddy avec mot de passe fort ; surface publique en lecture seule |
| Découpage | Trois conteneurs stricts : `postgres`, `back` (tous les processus Node), `front` |

## 4. Approches considérées

### 4.1 Retenue (décision de l'utilisateur) : trois conteneurs stricts

Un conteneur `back` exécute tous les processus Node sous un superviseur. Atténuation retenue :
chaque processus tourne sous son propre utilisateur Unix, avec ses propres secrets en mémoire,
de sorte que la keypair reste lisible par le seul utilisateur de H2b.

Le rejet de 2026-08-11 visait surtout le couplage de la base avec l'image applicative. Ici, la
base et le front restent séparés. Les autres reproches sont traités ainsi : santé agrégée par
processus (6.5), logs JSON nommés par service (6.6), arrêt propre par processus (6.2).

### 4.2 Recommandée mais non retenue : un conteneur par processus

Même image, un service compose par processus. Isolation la plus forte et redémarrages
indépendants. Écartée par l'utilisateur au profit de la simplicité de trois conteneurs.

### 4.3 Écartée : deux conteneurs back

Un conteneur observation et un conteneur exécution. Isolation grossière : H2a et auto-arm
partageraient le système de fichiers de la keypair, et un superviseur resterait nécessaire.

## 5. Topologie

| Conteneur | Image | Rôle |
|---|---|---|
| `postgres` | `postgres:16` épinglée par digest | Base, volume `postgres-data`, réseau `internal` seulement |
| `back` | cible `backend` du `Dockerfile` | Tous les processus Node sous `supervisord` |
| `front` | cible `frontend`, désormais Caddy | Interface, relais des API du back, HTTPS, mot de passe |

- **`migrate`**, tâche ponctuelle de l'image back : migrations sous le verrou consultatif
  existant, rejeu idempotent de `scripts/provision-executor-roles.sql`, création ou mise à jour
  des logins (section 9.1), puis arrêt. Elle seule reçoit le mot de passe administrateur.
- **Réseaux** : `internal` sans accès Internet (`postgres`, `migrate`, `back`) ; `egress` pour
  l'accès sortant du back vers Helius ; `edge` entre `front` et `back`.
- **Ports** : sur le Mac, seul le front écoute, sur `127.0.0.1:8080`. Sur le serveur, le front
  publie 80 et 443 ; ni la base ni le back ne publient de port.
- **Volumes** : `postgres-data`, `caddy-data` (certificats). Les logs vont sur la sortie
  standard.
- **Vault** sera ajouté plus tard comme quatrième conteneur sans changer cette topologie.

## 6. Conteneur back

### 6.1 Superviseur et utilisateurs

`tini` (option `init: true`) lance le script d'entrée en root, qui distribue les secrets
(7.2) puis exécute `supervisord` au premier plan. `supervisord` est le seul composant root ;
chaque programme tourne sous un utilisateur dédié, créé dans l'image avec un UID fixe :

| Utilisateur | UID | Usage |
|---|---|---|
| `listener` | 10001 | listener et API publique |
| `h2b` | 10002 | exécuteur live, seul lecteur de la keypair |
| `h2a` | 10003 | exécuteur de récupération |
| `autoarm` | 10004 | daemon auto-arm |
| `opapi` | 10005 | API opérateur |
| `retention` | 10006 | purge de rétention |
| `worker` | 10007 | worker de simulation (qualification) |
| `ops` | 10008 | commandes manuelles |

### 6.2 Programmes

| Programme | Commande | Démarrage | Login PostgreSQL → rôle de groupe |
|---|---|---|---|
| `listener` | `dist/src/app.js` | automatique | `sol_listener` → `sol_token_listener_writer` |
| `h2b` | boucle `sol-h2b` (6.3) | automatique, à la demande | `sol_live` → `sol_token_executor_live` |
| `h2a` | `dist/src/executor-live-recovery/main.js` | automatique | `sol_recovery` → `sol_token_executor_live_recovery` |
| `autoarm` | `dist/src/executor-operations/auto-arm-main.js` | jamais seul (6.4) | `sol_autoarm` → `sol_token_executor_operations` |
| `opapi` | `dist/src/operator-api/main.js` | automatique | `sol_reader` → `sol_token_operator_reader` |
| `retention` | `dist/scripts/purge-retained-data.js` | automatique | `sol_retention` → `sol_token_retention_worker` |
| `worker` | `dist/src/executor/main.js` | manuel, pendant une qualification | `sol_worker` → `sol_token_executor_worker` |

Chaque programme reçoit SIGTERM et dispose de 40 s pour s'arrêter ; le conteneur a un
`stop_grace_period` de 60 s. Le mode `observe` (`SOL_STACK_MODE=observe`, valeur par défaut)
ne démarre que `listener`, `opapi` et `retention` et n'exige aucun secret d'exécution : `opapi`
y utilise l'URL Helius du listener. Le mode `live` ajoute `h2b`, `h2a` et rend `autoarm` et
`worker` disponibles ; `opapi` y utilise l'URL Helius de l'exécuteur.

La qualification d'une enveloppe suspend la rétention pendant la sonde, comme dans le runbook
actuel : `sol qualify` arrête `retention` et la redémarre à la fin.

### 6.3 H2b à la demande

H2b refuse de démarrer quand il n'a aucun travail exécutable : ni armement prêt, ni BUY en vol,
ni position ouverte ou en sortie, ni enveloppe active (`RUNNABLE_WORK_SQL`). Une position en
sortie compte comme du travail même sans enveloppe active.

Seul changement applicatif : `src/executor-live/main.ts` termine avec le code 75 (EX_TEMPFAIL)
quand le démarrage échoue avec `LIVE_EXECUTOR_NO_WORK`, et garde le code 1 pour toute autre
erreur. La boucle `sol-h2b` relance H2b 15 s après un code 75. Après toute autre sortie, elle
attend selon une temporisation exponentielle plafonnée à 5 min, et signale l'état à la
vérification de santé. Après un redémarrage du serveur avec une position ouverte, H2b reprend
seul et la sortie s'exécute sans intervention.

### 6.4 Démarrage du trading

`sol trading start` exige une enveloppe active, attend au plus 60 s que H2b soit `RUNNING`, puis
démarre `autoarm` ; sans enveloppe active ou sans H2b prêt dans ce délai, la commande échoue
sans démarrer `autoarm`. `sol trading stop` arrête `autoarm`, puis laisse H2b finir son travail
en cours. Après un crash ou un redémarrage du conteneur, `autoarm` reste arrêté : aucun nouvel
achat ne part sans une commande humaine, alors que les sorties continuent.

### 6.5 Santé

`sol-health` interroge `supervisorctl` et l'endpoint `/api/v1/health` du listener. Le conteneur
est sain si chaque programme attendu dans le mode courant est `RUNNING`, si `h2b` est `RUNNING`
ou en attente normale de travail, et si `autoarm` est `RUNNING` lorsque le trading a été
démarré.

### 6.6 Logs

Chaque programme écrit sur la sortie standard du conteneur ; les lignes JSON portent déjà le
nom du service. Pilote `json-file` avec rotation : `max-size` 20 Mo, `max-file` 5.

### 6.7 Commandes manuelles

`docker compose exec -it back sol <rôle> <commande…>` : le wrapper `sol` charge la
configuration et les secrets du rôle demandé, puis exécute la commande sous l'utilisateur `ops`,
confirmations TTY comprises. Exemples : `sol ops envelope create …`, `sol ops resume`,
`sol ops status`, `sol readiness …`, `sol evidence provider`, `sol evidence bundle`,
`sol report`.

## 7. Secrets

### 7.1 Inventaire

| Secret | Fichier | Conteneur, utilisateur |
|---|---|---|
| Mot de passe administrateur PostgreSQL | `postgres-admin-password` | `postgres`, `migrate` |
| Mot de passe de chaque login (9) | `pg-<login>-password` | `migrate` ; `back`, utilisateur du login |
| URL HTTP et WS Helius du listener | `helius-listener-http-url`, `helius-listener-ws-url` | `back`, `listener` |
| URL HTTP Helius de l'exécuteur | `helius-executor-http-url` | `back`, `h2b`, `h2a`, `autoarm`, `opapi`, `worker`, `ops` |
| Clé de l'API d'administration Helius | `helius-admin-api-key` | `back`, `ops` |
| Clé privée Ed25519 des preuves | `evidence-private-key` | `back`, `ops` |
| Keypair du wallet | `wallet-keypair.json` | `back`, `h2b` |
| Empreinte bcrypt du mot de passe du front | `front-basic-auth-hash` | `front` |

### 7.2 Phase fichiers

- Dossier sur l'hôte, hors du dépôt, en 0700 : `~/.sol-token-listener/docker/secrets/` sur le
  Mac, `/srv/sol-token-listener/secrets/` sur le serveur. Un fichier par secret, en 0600.
- Chaque conteneur ne monte que les fichiers qu'il utilise, en lecture seule, sous
  `/root/secrets/` : seul root peut traverser `/root`.
- Le script d'entrée du back copie les secrets de chaque utilisateur dans
  `/run/sol/<utilisateur>/`, un tmpfs, avec le propriétaire de l'utilisateur et les droits
  0400, puis lance `supervisord`.
- La configuration non secrète par rôle (empreintes, hash de build, identifiant de génération,
  seuils) vit sur l'hôte dans `config/<rôle>.env`, montée en lecture seule. Le dépôt versionne
  les modèles `deploy/config/<rôle>.env.example`.
- Le lanceur `sol-run <rôle>` assemble configuration et secrets en variables d'environnement
  (`DATABASE_URL` avec mot de passe encodé, `SOLANA_HTTP_RPC_URL`, `EXECUTOR_KEYPAIR_PATH`
  vers le tmpfs de `h2b`), puis exécute Node. Le code applicatif ne change pas. Le lanceur
  n'écrit jamais de valeur secrète dans les logs.

### 7.3 Jonction avec Vault (sous-projet 2)

Seule la source change. Le script d'entrée s'authentifie auprès de Vault avec un rôle par
utilisateur, chaque politique ne donnant accès qu'aux secrets de cet utilisateur, et remplit
les mêmes dossiers `/run/sol/<utilisateur>/`. La keypair n'est lisible que par la politique de
`h2b`. Le reste de la stack ne voit aucune différence.

### 7.4 Rotation

Modifier le fichier, puis `docker compose restart back` ; pour un mot de passe PostgreSQL,
relancer `migrate` avant le back.

## 8. Front Caddy

- La cible `frontend` du `Dockerfile` passe de nginx à Caddy, image officielle épinglée par
  digest. Le `Caddyfile` est versionné dans `deploy/`.
- Routes reprises de `deploy/nginx.conf` : `index.html` et `config.json` sans cache, `/assets/`
  en cache long immuable, repli SPA vers `index.html`, flux SSE `/api/v1/events` sans tampon
  avec un délai d'une heure, `/api/v1` et `/api/v1/` vers le listener sur le port 3000.
- Route ajoutée : `/operator/v1/` vers l'API opérateur sur le port 3100. Celle-ci écoute sur
  toutes les interfaces du back (`OPERATOR_API_HOST=0.0.0.0`), joignable seulement depuis le
  réseau `edge`.
- Lecture seule : seules les méthodes GET et OPTIONS sont relayées, tout le reste reçoit 405.
  Règle de conception : aucune route d'écriture ne sera exposée sans authentification à deux
  facteurs.
- Authentification `basic_auth` sur toutes les routes, interface comprise. Mot de passe
  aléatoire d'au moins 24 caractères ; Caddy ne reçoit que son empreinte bcrypt, depuis le
  fichier secret, jamais dans le `Caddyfile` ni dans le compose.
- Mode Mac : HTTP sur `127.0.0.1:8080`. Mode serveur : nom de domaine en variable, certificat
  Let's Encrypt automatique sur 80 et 443, HSTS, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- Limite connue : pas de blocage des tentatives répétées dans Caddy. La longueur du mot de
  passe compense ; un fail2ban sur les logs Caddy reste une option côté serveur.

## 9. Base de données

### 9.1 Logins

`migrate` crée chaque login s'il n'existe pas, sinon met à jour son mot de passe, à partir des
fichiers secrets : `LOGIN NOINHERIT`, membre d'exactement un rôle de groupe (tableau 6.2), plus
`sol_ops` → `sol_token_executor_operations` et `sol_readiness` →
`sol_token_executor_readiness` pour les commandes manuelles. Les règles sont celles du runbook
`docs/operations/executor-live-canary.md`. L'administrateur s'appelle `sol_owner`, comme
aujourd'hui, pour que la propriété des tables reste identique après restauration.

### 9.2 Reprise de la base actuelle

1. Précondition : trading à l'arrêt, c'est-à-dire aucune enveloppe active, aucune position
   ouverte, aucune transaction en vol (vérifié par `ops status` et une requête de contrôle).
2. Arrêt des processus de l'hôte dans l'ordre : auto-arm, H2b, H2a, listener, API opérateur.
3. `pg_dump -Fc` de la base du port 5433, avec empreinte SHA-256 du fichier.
4. Dans le Postgres de compose : création des rôles de groupe vides, `pg_restore`, rejeu du
   script des droits, création des logins par `migrate`.
5. Vérification : nombre de lignes identique table par table, même version de migration, même
   état du wallet, des enveloppes, des positions et du contrôle ; puis `sol ops status`.
6. Démarrage de la stack en mode `live`, trading arrêté.

Aucune requalification n'est due à la bascule : wallet, fournisseur et configuration ne
changent pas, la génération de readiness reste valide.

### 9.3 Retour arrière

L'ancien conteneur est arrêté mais conservé sept jours. Tant qu'aucun trade n'a eu lieu dans
compose, il suffit de relancer les processus de l'hôte dessus ; après un trade, le retour passe
par un dump inverse.

### 9.4 Sauvegardes

`pg_dump -Fc` planifié depuis l'hôte, par `docker compose exec -T postgres`, avec rotation sur
14 jours : launchd sur le Mac, timer systemd sur le serveur. La copie hors machine reste à la
charge de l'exploitant. Le dossier des secrets n'est jamais inclus dans ces sauvegardes.

## 10. Bascule vers le serveur

Même procédure que 9.2, du Postgres du Mac vers celui du serveur. Préparation du serveur :
Docker et le plugin compose, pare-feu limité à SSH, 80 et 443, enregistrement DNS du domaine,
dossiers des secrets et de la configuration, Caddy en mode domaine, timer de sauvegarde.

Prérequis avant une production 24/7 : un budget RPC du listener tenable. Mesure du 2026-10-09 :
même avec l'abonnement WebSocket restreint aux créations, sa charge HTTP (battement de cœur,
réconciliateur de finalité, hydratation des créations, sondage des courbes) est estimée entre
20 000 et 55 000 crédits par heure, bien au-delà d'un forfait gratuit. Le sous-projet 3 traite
ce budget : réduction de la charge HTTP, répartition entre comptes, ou forfait payant.

## 11. Tests et validation

### 11.1 Tests statiques

`tests/deployment-artifacts.test.ts`, qui décrit aujourd'hui la stack d'observation, est adapté
pour vérifier :

- le compose définit exactement `postgres`, `migrate`, `back` et `front`, et ni la base ni le
  back ne publient de port ;
- aucun secret n'apparaît dans le compose, les modèles de configuration ou l'image ;
- le `Caddyfile` ne relaie que GET et OPTIONS, et `basic_auth` couvre toutes les routes ;
- dans la configuration de `supervisord`, `autoarm` n'a jamais `autostart=true`, et chaque
  programme a son utilisateur et ses délais d'arrêt ;
- seul le lanceur de `h2b` référence la keypair.

### 11.2 Tests de conteneur en CI

Dans le job `deployment-contract`, avec des secrets jetables, une keypair jetable sans fonds et
une base vide :

- `migrate` réussit et les logins existent avec les bons rôles ;
- en mode `observe`, le back devient sain ;
- le front exige le mot de passe, un GET passe, un POST reçoit 405 ;
- l'utilisateur `listener` ne peut pas lire `/run/sol/h2b/wallet-keypair.json` ;
- `sol ops status` répond ;
- aucune transaction n'est possible : pas d'enveloppe, H2b n'a pas de travail.

Le code de sortie 75 de H2b est couvert par un test unitaire de `src/executor-live/main.ts`.

### 11.3 Validation sur le Mac

Restauration d'une copie du dump de production dans le Postgres de compose, la base actuelle
restant intacte. Démarrage en mode `live` avec les vraies clés, trading arrêté. Vérification :
programmes, santé, `sol ops status`, front, `sol trading start` puis `stop` à vide, H2b en
attente normale. Ensuite seulement, la bascule de 9.2.

## 12. Phases

1. Implémentation, tests, validation et bascule sur le Mac.
2. Bascule vers le serveur (section 10).
3. Sous-projet 2 : Vault (spec dédié).
4. Sous-projet 3 : plusieurs comptes Helius affectés par rôle (spec dédié).

## 13. Invariants de sécurité du mode live

- La keypair n'est lisible que par l'utilisateur `h2b` ; elle n'apparaît jamais dans une image,
  le compose, une variable d'environnement de conteneur ou un log.
- Chaque processus se connecte avec son propre login PostgreSQL `NOINHERIT`, membre d'un seul
  rôle de groupe.
- `autoarm` ne démarre jamais sans `sol trading start` ; après tout redémarrage, aucun nouvel
  achat sans action humaine. Les sorties restent automatiques.
- Aucun port PostgreSQL ni port du back n'est publié sur le serveur.
- Le front n'expose que GET et OPTIONS, derrière HTTPS et un mot de passe fort ; aucune route
  d'écriture sans authentification à deux facteurs.
- Aucun secret dans le dépôt ni dans une couche d'image ; dossier des secrets en 0700 hors du
  dépôt, monté sous `/root` en lecture seule.

## 14. Hors périmètre

Vault et plusieurs comptes Helius (sous-projets suivants), Kubernetes, haute disponibilité,
copie de sauvegarde hors machine, actions d'écriture dans le front, fail2ban, collecte de
recherche dans la stack.

## 15. Critères d'acceptation

- Les tests statiques et les tests de conteneur passent en CI.
- Sur le Mac, la stack restaurée passe la validation de 11.3, puis la bascule de 9.2 se fait
  avec des comptes de lignes identiques.
- Le runbook `docs/operations/deployment.md` décrit le démarrage, l'arrêt, les commandes
  `sol`, la reprise de la base, les sauvegardes, le retour arrière et la bascule vers le
  serveur.
