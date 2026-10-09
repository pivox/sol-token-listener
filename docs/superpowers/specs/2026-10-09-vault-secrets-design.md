# Secrets et configuration sous Vault (sous-projet 2)

- Date : 2026-10-09.
- Statut : design validé section par section avec l'utilisateur le 2026-10-09 ; amendé par le plan d'implémentation, puis par l'implémentation (section 13).
- Base :
  - le sous-projet 1, `docs/superpowers/specs/2026-10-09-full-bot-compose-design.md`, dont la section 7.3 prévoit cette jonction ;
  - la stack Compose fusionnée par la PR #263 (`78fa4d1c`).

## 1. Objet

Toutes les variables des processus du back passent dans un conteneur Vault de la stack : la
configuration non secrète de chaque rôle comme les secrets. L'opérateur les gère à un seul
endroit, avec historique, politiques par conteneur et audit. Le reste de la stack ne change pas :
les scripts d'entrée lisent Vault au démarrage et écrivent les mêmes fichiers qu'aujourd'hui, aux
mêmes chemins.

La liste des comptes Helius avec bascule automatique est le sous-projet 3. Il réutilisera ce
stockage : les trois URL Helius y deviendront une seule entrée, la liste JSON des comptes.

## 2. État actuel

Depuis la PR #263, l'hôte porte, sous `$SOL_HOST_DIR` :

| Fichier | Lecteurs |
|---|---|
| `secrets/db/postgres-admin-password` | `postgres`, `migrate` |
| `secrets/db/logins/pg-<login>-password` (9) | `migrate` ; `back` |
| `secrets/back/<nom>` (7 : trois URL Helius, clé d'administration Helius, clé privée des preuves, keypair, jeton de l'API opérateur) | `back` |
| `secrets/front/front-basic-auth-hash` | `front` |
| `config/<fichier>.env` (10 fichiers non secrets) | `back` |
| `compose.env` (images, mode, port) | Docker Compose |

Le back monte `secrets/db/logins` sur `/root/secrets/logins`, `secrets/back` sur
`/root/secrets/back` et `config` sur `/etc/sol/config`. Son script d'entrée copie ensuite les
secrets de chaque utilisateur Unix dans `/run/sol/<utilisateur>/` (`distribute-secrets`), et
`sol-run` assemble l'environnement de chaque processus. Les valeurs réelles vivent encore dans
`~/.sol-token-listener/lot5/env/*.env` et dans les fichiers de clés. La validation sur le Mac
(tâche 16 du plan du sous-projet 1) n'a pas eu lieu : aucune stack ne tourne avec de vraies clés.

## 3. Décisions de cadrage

| Sujet | Décision |
|---|---|
| Ordre | Vault d'abord, la liste Helius ensuite (sous-projet 3) |
| Périmètre | Secrets et configuration non secrète des rôles |
| Déverrouillage | Automatique, avec une clé dans un fichier de l'hôte |
| Accès à l'interface | Local seulement : `127.0.0.1:8200` sur le Mac, tunnel SSH sur le serveur |
| Branchement | Lecture au démarrage par les scripts d'entrée (approche A) |

Le déverrouillage automatique garde le bot autonome après une coupure. En contrepartie, qui est
root sur l'hôte peut déverrouiller Vault, comme il peut lire les fichiers aujourd'hui. Le gain de
Vault est ailleurs :
- un seul endroit pour toutes les valeurs ;
- un historique avec retour arrière ;
- des politiques au plus juste par conteneur ;
- un audit des lectures (13.7).

## 4. Approches considérées

### 4.1 Retenue : lecture au démarrage par les scripts d'entrée (A)

`back` et `migrate` s'authentifient à Vault au démarrage, lisent leurs entrées et les écrivent en
tmpfs aux chemins actuels. Le code applicatif, `sol-run`, la distribution par utilisateur et les
validations ne changent pas. Une modification dans Vault prend effet au redémarrage du conteneur.

### 4.2 Écartée : agent Vault dans le back (B)

Un `vault agent` sous `supervisord` régénère les fichiers quand une valeur change. Il faut un
modèle par clé (une trentaine), un processus de plus et une politique de redémarrage par
programme. Le gain est faible : tout redémarrage du back pose déjà l'entry-stop, par sécurité.

### 4.3 Écartée : lecture par chaque processus Node (C)

Chaque processus lit Vault avec son propre rôle : seul H2b pourrait lire la keypair. C'est le
moindre privilège réel, mais il faut changer le chargement de configuration de tous les points
d'entrée, et Vault devient une dépendance de chaque redémarrage de processus.

## 5. Topologie

- **Service `vault`** :
  - image officielle `hashicorp/vault`, version stable courante, épinglée par digest. Sa licence BSL autorise l'usage interne ; OpenBao, compatible, peut la remplacer ;
  - stockage intégré (raft) dans un volume `vault-data` ;
  - interface web activée ;
  - `disable_mlock`, recommandé avec raft en conteneur ;
  - `api_addr` et `cluster_addr` sur le nom `vault`.
- **Écoute** : HTTP sur le port 8200, sans TLS.
- **Réseaux** :
  - `internal` : `back`, `migrate` et les services ponctuels du profil `tools` (13.2) joignent `vault:8200` ;
  - `vault-ui`, réseau dédié qui ne sert qu'à publier `127.0.0.1:8200:8200` sur l'hôte, car Docker ne publie pas de port depuis un réseau interne.

  Sur le serveur, la publication reste locale ; l'accès passe par `ssh -L 8200:127.0.0.1:8200`.
- **Script d'entrée `vault-entrypoint`** :
  1. il lance `vault server` sous l'utilisateur non root de l'image ;
  2. il attend que l'API réponde ;
  3. si Vault est initialisé et verrouillé, il le déverrouille avec la clé du dossier `secrets/vault/unseal/`, monté en lecture seule. Une seule part de clé (Shamir 1 sur 1) ;
  4. si Vault n'est pas encore initialisé, il le laisse tourner : le script d'initialisation s'en charge (section 8.1).

  La clé n'apparaît ni dans l'environnement, ni dans les arguments, ni dans les journaux.
- **Santé et dépendances** :
  - la santé est `vault status`, sain seulement une fois initialisé et déverrouillé ;
  - `back` et `migrate` attendent `vault` sain ;
  - `postgres` et `front` n'en dépendent pas.
- **Exploitation** : `restart: unless-stopped` ; journaux `json-file` comme les autres services, qui portent aussi l'audit (13.7) ; même durcissement que le back (`no-new-privileges`, sans `NET_RAW` ni `MKNOD`, sans fichier core).
- **Ce qui reste en fichiers, et pourquoi** :
  - le mot de passe administrateur PostgreSQL : l'image `postgres` en a besoin pour initialiser la base, avant tout client Vault ;
  - l'empreinte bcrypt du front : Caddy n'a pas de client Vault ;
  - `compose.env` : ce sont des entrées de Docker, pas de l'application.

## 6. Données dans Vault

### 6.1 Arborescence

Moteur KV version 2 monté sur `sol/`. Chaque entrée garde ses versions précédentes (10 par
défaut), consultables et restaurables depuis l'interface.

| Chemin | Contenu | Remplace |
|---|---|---|
| `sol/config/<nom>` | une entrée par fichier de configuration (`listener`, `live`, `live-recovery`, `operations`, `operator-api`, `readiness`, `worker-sim`, `provider-evidence`, `preflight-bundle`, `retention`) ; une clé par variable | `config/<nom>.env` |
| `sol/secrets/back/<nom>` | les sept secrets du back, sous les noms de fichiers actuels ; champ `value` | `secrets/back/<nom>` |
| `sol/secrets/logins/<login>` | le mot de passe de chacun des neuf logins ; champ `value` | `secrets/db/logins/pg-<login>-password` |

La configuration obéit aux mêmes règles qu'aujourd'hui (`parseRoleConfig`) :
- aucune variable injectée ni nom de secret ;
- aucun identifiant dans une valeur ;
- une seule ligne par valeur.

La keypair est rangée telle quelle : le texte JSON du fichier. Toute valeur est du texte, jamais
un nombre, un booléen ou un tableau (13.7).

### 6.2 Politiques

Toutes au plus juste et versionnées dans `deploy/vault/policies/`, en lecture seule sauf celle de `operator` :

| Politique | Droits |
|---|---|
| `back` | lire `sol/data/config/*`, `sol/data/secrets/back/*`, `sol/data/secrets/logins/*` |
| `migrate` | lire `sol/data/secrets/logins/*` |
| `backup` | lire `sys/storage/raft/snapshot` |
| `operator` | créer, lire, modifier, supprimer et lister sous `sol/` (données, métadonnées, versions) ; rien sur les politiques ni l'authentification |

### 6.3 Authentification

- **Conteneurs** : un AppRole par politique conteneur (`back`, `migrate`, `backup`).
  - Le couple `role_id` / `secret_id` est un fichier 0600 de l'hôte, `secrets/vault/approle/<rôle>.json`, monté en lecture seule dans le seul conteneur concerné. Le fichier de `backup` n'est lu que par le script de sauvegarde de l'hôte.
  - Le jeton obtenu vit 5 minutes et ne sert qu'au démarrage.
  - Le `secret_id` n'expire pas, car un redémarrage peut survenir à tout moment ; sa rotation est une procédure documentée.
- **Opérateur** : un login `operator` (méthode userpass), dont le mot de passe est affiché une seule fois à l'initialisation et gardé dans le gestionnaire de mots de passe de l'utilisateur. Son jeton vit une heure, renouvelable jusqu'à 8 heures (13.6).
- **Jeton root** : il ne sert qu'au script d'initialisation, puis il est révoqué. Une modification ultérieure des politiques le régénère avec la clé de déverrouillage (`vault operator generate-root`, permis sans jeton : 13.8), selon une procédure documentée.

Le sous-projet 1 prévoyait un rôle Vault par utilisateur Unix (section 7.3). Le script d'entrée du
back tourne en root et devrait de toute façon détenir les identifiants de tous les utilisateurs :
un rôle par utilisateur n'isolerait rien de plus. L'isolation entre utilisateurs reste celle des
dossiers `/run/sol/<utilisateur>/` (0700, fichiers 0400).

## 7. Démarrage avec Vault

### 7.1 Back

- **Montages** : les trois montages de dossiers de l'hôte disparaissent :
  - `/root/secrets/logins` et `/root/secrets/back` sont remplacés par un tmpfs `/root/secrets` (0700) ;
  - `/etc/sol/config` est remplacé par un tmpfs (0755).

  S'y ajoute `secrets/vault/approle/back.json`, monté en lecture seule sur `/root/vault/approle.json`, avec `create_host_path: false` (13.9).
- **Première étape du script d'entrée qui contacte Vault** : `vault-pull back <mode>`, un client Node sans dépendance qui parle à l'API HTTP de Vault. La validation du mode et la préparation de `/run/sol` la précèdent (13.11). Il :
  1. s'authentifie : `POST /v1/auth/approle/login` ;
  2. lit les entrées du mode (`GET /v1/sol/data/<chemin>`). Une entrée obligatoire manquante arrête tout ; une entrée facultative absente est ignorée ;
  3. écrit les secrets dans `/root/secrets/{back,logins}/` (0600, root), sous les noms de fichiers actuels ;
  4. écrit chaque configuration en `/etc/sol/config/<nom>.env` (0644, lignes `VARIABLE=valeur` triées), validée par `parseRoleConfig` avant écriture ;
  5. révoque son jeton : `POST /v1/auth/token/revoke-self`.
- **Entrées du mode** :
  - Elles reprennent `secretGrants(mode)`. Les obligatoires sont celles des rôles que `supervisord` démarre dans ce mode (`REQUIRED_ROLES`), plus leurs fichiers de configuration. Les autres sont facultatives.
  - En mode `observe`, la keypair n'est jamais lue.
- **Suite du démarrage** : inchangée (distribution par utilisateur, entry-stop de démarrage en mode `live`, `supervisord`).
- **Journaux** : `vault-pull` n'écrit jamais une valeur. Seule une ligne JSON de synthèse sort : mode, nombre de secrets et de configurations lus, entrées facultatives absentes par nom.

### 7.2 Migrate

`sol-admin migrate` lit les neuf mots de passe de login avec l'AppRole `migrate`, dans un tmpfs
`/root/secrets/db/logins`. Le mot de passe administrateur reste le fichier de l'hôte, monté sur
`/root/secrets/db/postgres-admin-password`. `sol-admin report` n'a pas besoin de Vault.

### 7.3 Échecs

Aucun conteneur ne revient jamais à des fichiers de l'hôte quand Vault fait défaut.

| Cas | Comportement |
|---|---|
| Vault injoignable ou verrouillé | nouvelles tentatives toutes les 2 s pendant 60 s (`SOL_VAULT_PULL_TIMEOUT_MS`, 13.4), puis sortie 69 ; Docker relance le conteneur |
| AppRole refusé | sortie 77 immédiate |
| Entrée obligatoire manquante ou valeur invalide | sortie 78 immédiate ; le message nomme le chemin, jamais la valeur |
| Usage incorrect | sortie 64 |

Une fois démarré, le back ne parle plus à Vault : un Vault arrêté ne touche pas les processus en
cours. En revanche, si le back redémarre pendant que Vault est en panne, H2a et H2b ne démarrent
pas, et une position ouverte attend le retour de Vault. Le déverrouillage automatique et
`restart: unless-stopped` sur `vault` réduisent ce risque.

## 8. Exploitation

### 8.1 Initialisation

Le script `deploy/host/vault-init.sh` ne tourne qu'une fois. Il refuse un Vault déjà initialisé
et vérifie les dossiers de `secrets/vault/` (13.10). Il démarre ensuite `vault` seul, puis confie
les étapes ci-dessous au service ponctuel `vault-setup` (13.2). Ce service parle à l'API HTTP de
Vault depuis Node (13.3). Il :
1. initialise Vault avec une part de clé ;
2. écrit la clé de déverrouillage dans `secrets/vault/unseal/unseal-key` (0600), sans l'afficher ;
3. déverrouille Vault, active l'audit sur la sortie standard (13.7), `sol/` (KV v2), AppRole et
   userpass, et charge les quatre politiques ;
4. crée les trois AppRoles et écrit leurs fichiers ;
5. génère directement dans Vault les neuf mots de passe de login et le jeton de l'API opérateur,
   comme `init-secrets.sh` le fait aujourd'hui en fichiers ;
6. crée le login `operator`, dont il affiche une seule fois le mot de passe généré ;
7. révoque le jeton root.

### 8.2 Import

L'import tourne dans le service ponctuel `vault-import` (13.2), sur l'image back, avec les
sources montées en lecture seule. Le script `deploy/host/vault-import.sh` demande le mot de passe
du login `operator` et le transmet sur l'entrée standard. Le service parle à l'API HTTP de Vault
depuis Node (13.3). Il :
- lit les sources actuelles : les fichiers `lot5/env/*.env` et les fichiers de clés. Il reprend
  les correspondances des commandes de copie du runbook actuel, par exemple
  `SOLANA_HTTP_RPC_URL` de `listener.env` vers `helius-listener-http-url` ;
- retire de chaque configuration les variables que `sol-run` injecte, comme le fait aujourd'hui la commande `strip` du runbook ;
- réécrit les chemins de preuves vers `/var/lib/sol/evidence` ;
- fixe les adresses et ports d'écoute : `API_HOST=0.0.0.0` et `API_PORT=3000` pour `listener`,
  `OPERATOR_API_HOST=0.0.0.0` et `OPERATOR_API_PORT=3100` pour `operator-api` ;
- reprend de `deploy/config/<rôle>.env.example` le fichier d'un rôle absent de la source ;
- valide chaque entrée avec les mêmes règles que `vault-pull` ;
- écrit le tout dans Vault, sans afficher aucune valeur.

Il n'y a donc plus de copie intermédiaire en fichiers sur l'hôte. L'import peut être relancé : il
crée une nouvelle version de chaque entrée. Le relancer remplace les modifications faites depuis
dans Vault, qui restent dans les versions précédentes.

### 8.3 Modifications et rotation

- **Une valeur** : modifiée dans l'interface (`http://127.0.0.1:8200`, login `operator`) ou en ligne de commande, puis `sol_compose restart back`. Le redémarrage pose l'entry-stop : relancer `sol trading start`.
- **Le mot de passe d'un login** : modifié dans Vault, puis `sol_compose run --rm migrate`, puis redémarrage du back.
- **Le `secret_id` d'un AppRole** : jeton root régénéré (13.8), nouveau `secret_id` écrit dans son fichier, ancien révoqué, conteneur redémarré.

### 8.4 Sauvegardes

`deploy/host/backup.sh` ajoute un instantané raft de Vault à côté du `pg_dump`. Le service
ponctuel `vault-snapshot` (13.2) le prend par l'API HTTP de Vault (13.3). Le script lit le
fichier de l'AppRole `backup` sur l'hôte et le transmet sur l'entrée standard du service.
La rétention est la même, 14 jours, avec une empreinte SHA-256 pour chaque fichier. Le script ne
garde que des fichiers complets et non vides (13.10). L'instantané est chiffré, et le restaurer
exige la clé de déverrouillage, qui n'est jamais dans les sauvegardes. L'utilisateur garde une
copie de la clé de déverrouillage et du mot de passe `operator` dans son gestionnaire de mots de
passe.

### 8.5 Ce qui reste sur l'hôte

- `secrets/vault/unseal/unseal-key` et `secrets/vault/approle/{back,migrate,backup}.json` ;
- `secrets/db/postgres-admin-password` ;
- `secrets/front/front-basic-auth-hash` ;
- `compose.env`.

Les dossiers `config/`, `secrets/back/` et `secrets/db/logins/` disparaissent.
`deploy/host/init-secrets.sh` ne crée plus que ce qui reste en fichiers, et les deux dossiers
vides `secrets/vault/unseal/` et `secrets/vault/approle/` (0700), que `vault-init.sh` remplit.

### 8.6 Effets sur le sous-projet 1

- La validation sur le Mac (tâche 16) commence par l'initialisation et l'import, puis suit le runbook sans changement. Elle exige toujours le feu vert de l'utilisateur.
- La bascule vers le serveur copie `secrets/vault/` et restaure un instantané raft, ou copie le volume `vault-data`.
- Dans le spec du sous-projet 1, la section 7.3 renvoie vers ce document.

## 9. Invariants de sécurité

1. **Aucune valeur secrète visible** : ni dans un journal, un argument de processus, l'environnement d'un conteneur, le compose ou une image.
2. **Vault reste local** : il n'est joignable que depuis le réseau `internal` et sur `127.0.0.1` de l'hôte. Il n'est jamais relayé par le front.
3. **Pas de repli sur des fichiers** : `back` et `migrate` refusent de démarrer sans Vault.
4. **La keypair ne quitte Vault qu'en mode `live`** : seules les politiques `back` et `operator` peuvent la lire ; dans le back, seul l'utilisateur `h2b` la reçoit.
5. **Pas de jeton durable** : chaque politique de conteneur est en lecture seule sur ses chemins. Aucun jeton root ne survit à l'initialisation ; les jetons des conteneurs vivent 5 minutes puis sont révoqués, celui de l'opérateur une heure, 8 heures au plus.
6. **Fichiers de l'hôte protégés** : la clé de déverrouillage et les fichiers AppRole sont 0600. Hors de l'initialisation, chacun est monté en lecture seule dans un seul conteneur au plus ; pendant l'initialisation, le service ponctuel `vault-setup` monte `secrets/vault/` en écriture pour les créer. Hors de l'initialisation, celui de `backup` n'est monté nulle part : le script de sauvegarde de l'hôte le lit et le transmet sur l'entrée standard de `vault-snapshot`.

## 10. Tests et validation

### 10.1 Tests unitaires (node:test, sans réseau)

Le client `vault-pull`, contre un faux serveur Vault :
- authentification AppRole et chemins lus par mode, la keypair n'étant jamais lue en `observe` ;
- droits des fichiers écrits et rendu trié `VARIABLE=valeur` ;
- refus d'une valeur multi-ligne, d'un identifiant dans une valeur ou d'un nom de secret en configuration ;
- les codes de sortie 64, 69, 77 et 78 ;
- la révocation du jeton ;
- aucune valeur dans la sortie standard ni dans la sortie d'erreur ;
- `vault-setup`, `vault-import` et `vault-snapshot`, contre le même faux serveur : refus d'un Vault déjà initialisé (`vault-setup`), variables injectées retirées (`vault-import`), aucune valeur secrète en clair dans les sorties des trois.

### 10.2 Scripts de l'hôte

`vault-init`, l'import et la sauvegarde, avec un faux `docker` seulement (l'hôte n'a aucun client
Vault), comme les tests actuels d'`init-secrets` :
- refus d'un Vault déjà initialisé ;
- seule sortie autorisée : le mot de passe `operator` affiché une fois ;
- aucune valeur affichée.

### 10.3 Tests statiques

- les politiques au plus juste, sans joker sur `sys/` ;
- le service `vault` épinglé, publié seulement sur `127.0.0.1`, avec sa santé et les dépendances de `back` et `migrate` ;
- plus aucun montage de `config/`, `secrets/back/` ni `secrets/db/logins/`.

### 10.4 Smoke en CI (job `deployment-contract`)

Avec un vrai Vault jetable :
- initialisation, import de valeurs factices, stack démarrée, back sain ;
- Vault redémarré : il se redéverrouille seul ;
- Vault arrêté puis back redémarré : le back refuse de démarrer, sans jamais lancer `supervisord` ;
- aucune valeur secrète dans `docker inspect` ni dans les journaux ;
- instantané raft produit par `backup.sh`.

### 10.5 Validation sur le Mac

C'est la tâche 16, avec le feu vert de l'utilisateur :
1. initialisation ;
2. import depuis les fichiers `lot5` ;
3. connexion à l'interface en local ;
4. démarrage de la stack.

## 11. Hors périmètre

- La liste des comptes Helius avec bascule (sous-projet 3).
- TLS sur le réseau interne.
- Vault en haute disponibilité.
- Identifiants PostgreSQL dynamiques.
- Rechargement à chaud.
- Mot de passe administrateur PostgreSQL et empreinte du front dans Vault.
- Page de configuration dans la console.
- Exposition publique de Vault.

## 12. Critères d'acceptation

1. **Plus de dossiers de valeurs sur l'hôte** : la stack démarre sans `config/`, `secrets/back/` ni `secrets/db/logins/`. Le back est sain avec des valeurs lues dans Vault.
2. **Déverrouillage automatique** : Vault se redéverrouille seul après un redémarrage.
3. **Refus sans Vault** : `back` et `migrate` refusent de démarrer sans Vault, et le message ne contient aucune valeur.
4. **Effet d'une modification** : une valeur modifiée dans Vault prend effet au redémarrage suivant du back.
5. **Sauvegardes** : elles contiennent un instantané raft restaurable avec la clé de déverrouillage.
6. **Runbook** : il décrit l'initialisation, l'import, les modifications, les rotations, la sauvegarde et la restauration, et la bascule vers le serveur.

## 13. Amendements (plan d'implémentation et implémentation)

Le plan `docs/superpowers/plans/2026-10-09-vault-secrets.md` précise ce spec sur six points (1 à
6), puis l'implémentation sur cinq autres (7 à 11). Tous sont reportés dans les sections
concernées :

1. Les fichiers d'amorçage de Vault sur l'hôte vivent dans deux dossiers, `secrets/vault/unseal/`
   et `secrets/vault/approle/` (sections 5, 6.3, 7.1, 8.1 et 8.5).
   - La clé de déverrouillage n'existe pas au premier démarrage de `vault` : un montage de
     fichier absent ferait créer un dossier par Docker. `vault` monte donc le dossier `unseal/`.
   - `vault-setup` écrit les trois fichiers AppRole dans `approle/`. `back` et `migrate` montent
     le leur en syntaxe longue de Compose, avec `bind: {create_host_path: false}` : seul ce
     réglage fait échouer le démarrage sur un fichier absent au lieu de créer un dossier (13.9).
2. Trois services ponctuels sur l'image back, au profil `tools` : `vault-setup`, `vault-import`
   et `vault-snapshot` (sections 5, 8.1, 8.2, 8.4, 9 et 10). Les scripts de l'hôte les lancent par
   `docker compose run --no-deps` (13.10), jamais par `docker compose up`. Ils rejoignent le
   réseau `internal` :
   Vault n'est pas joignable depuis l'hôte, hors son port d'interface local, et l'hôte n'a
   besoin d'aucun client Vault.
3. Les quatre commandes `vault-pull`, `vault-setup`, `vault-import` et `vault-snapshot` appellent
   l'API HTTP de Vault depuis Node (sections 7.1, 8.1, 8.2 et 8.4). L'image back n'embarque pas
   le binaire `vault` ; l'image vault le garde pour son contrôle de santé (`vault status`) et les
   procédures manuelles.
4. `SOL_VAULT_PULL_TIMEOUT_MS` borne la durée des nouvelles tentatives de `vault-pull` : 60000 ms
   par défaut, les 60 s de la section 7.3. Le smoke la fixe à 5000 pour prouver le refus de
   démarrer en quelques secondes.
5. L'import reprend une partie de ce que le runbook faisait à la main (section 8.2) :
   - il retire les variables injectées ;
   - il réécrit les chemins de preuves vers `/var/lib/sol/evidence` ;
   - il fixe les adresses et ports d'écoute : `API_HOST=0.0.0.0` et `API_PORT=3000` pour
     `listener`, `OPERATOR_API_HOST=0.0.0.0` et `OPERATOR_API_PORT=3100` pour `operator-api`.

   Un fichier de rôle absent de la source est repris de `deploy/config/<rôle>.env.example`.
   `OPERATOR_API_ALLOWED_ORIGIN`, qui diffère entre le Mac et le serveur, reste à vérifier dans
   l'interface, comme les chemins de preuves.
6. Le login `operator` reçoit un jeton d'une heure, renouvelable jusqu'à 8 heures (sections 6.3
   et 9). La durée par défaut dans Vault, 32 jours, contredirait l'invariant 5.
7. Un audit tient la promesse des sections 1 et 3, qu'aucune tâche du plan ne réalisait
   (sections 3, 5, 6.1 et 8.1). Tant qu'il détient le jeton root, `vault-setup` active un audit
   `file` qui écrit sur la sortie standard du serveur.
   - La trace est le journal du conteneur, `docker logs` : chaque requête authentifiée et sa
     réponse.
   - Vault y masque les textes par HMAC, pas les nombres ni les booléens, qui paraissent en clair
     dans les réponses lues. Toute valeur de Vault est donc du texte : `vault-import` n'écrit que
     des chaînes, `vault-pull` refuse toute autre valeur, et la keypair reste le texte du fichier.
     L'invariant 1 en dépend.
   - La trace tourne avec les journaux `json-file` (5 fichiers de 20 Mo) et disparaît quand le
     conteneur est recréé : ce n'est pas un audit durable.
   - Elle est fail-closed : si la sortie standard du conteneur bloque, Vault cesse de répondre
     plutôt que de servir sans trace.
8. `deploy/vault/vault.hcl` fixe `enable_unauthenticated_access = ["generate-root"]` (sections 6.3
   et 8.3).
   - Pourquoi : depuis la version 2.0 (correctif de la CVE-2026-5807), Vault refuse un
     `generate-root` sans jeton. Or l'invariant 5 révoque le jeton root, et seul `generate-root`
     en régénère un, avec la clé de déverrouillage.
   - Risque résiduel : tout client de l'API peut lancer ou annuler une tentative. C'est une
     nuisance seulement, car terminer une tentative exige la clé de déverrouillage. Le runbook
     vérifie l'état et le nonce de la tentative avant de saisir la clé.
9. Les montages AppRole de `back` et `migrate` n'échouent sur un fichier absent qu'avec
   `bind: {create_host_path: false}` (sections 7.1 et 13.1). L'implémentation l'a montré : la
   syntaxe longue seule crée encore un dossier à la place du fichier manquant. Le point 1 est
   corrigé en ce sens.
10. Garde-fous de l'initialisation et des services ponctuels (sections 8.1, 8.4 et 13.2) :
    - `vault-init.sh` vérifie, avant `compose up vault`, que `secrets/vault/unseal/` et
      `secrets/vault/approle/` existent, appartiennent à l'appelant, lui sont inscriptibles et
      sont vides. Sinon, Docker créerait un dossier manquant au nom de root, et la clé, impossible
      à écrire, serait perdue après l'initialisation ;
    - les scripts de l'hôte lancent les services ponctuels avec `--no-deps` : ils ne démarrent ni
      ne recréent jamais Vault ;
    - `vault-setup` et `vault-snapshot` n'ont aucune copie de journal (pilote `none`) : leur
      sortie porte le mot de passe `operator` ou l'instantané brut ;
    - `vault-snapshot` lit l'instantané entier, vérifie son en-tête gzip, puis l'écrit d'un bloc.
      `backup.sh` ne garde un fichier que si l'outil réussit et que le fichier n'est pas vide.
11. Section 7.1 : `vault-pull` est la première étape du script d'entrée qui contacte Vault, pas la
    première étape tout court. La validation du mode et la préparation de `/run/sol` la
    précèdent.
