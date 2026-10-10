# Comptes Helius du listener avec bascule (sous-projet 3)

- Date : 2026-10-10.
- Statut : design validé section par section avec l'utilisateur le 2026-10-10.
- Base :
  - le sous-projet 1, `docs/superpowers/specs/2026-10-09-full-bot-compose-design.md` ;
  - le sous-projet 2, `docs/superpowers/specs/2026-10-09-vault-secrets-design.md`, dont la section 1 annonce cette entrée ;
  - la stack en service sur le Mac depuis le 2026-10-10, `main` à `de862ccf`.

## 1. Objet

Le listener lit un seul compte Helius. Quand le quota de ce compte est épuisé, il devient sourd : c'est le cas depuis le 2026-10-09 à 00:19, où chaque appel reçoit un HTTP 429 « max usage reached ».

Ce sous-projet range dans Vault une liste ordonnée de comptes Helius du listener. Quand le compte courant est épuisé, ou que sa clé est refusée, le listener passe seul au compte suivant.

## 2. État actuel

- **Secrets**
  - `helius-listener-http-url` et `helius-listener-ws-url` portent chacun une URL avec sa clé.
  - `sol-run` les injecte dans `SOLANA_HTTP_RPC_URL` et `SOLANA_WS_RPC_URL`.
  - En mode observe, l'API opérateur lit aussi l'URL HTTP du listener, pour un seul usage : le solde du wallet (`getBalance`).
- **Bascule du listener**
  - Elle a quatre positions, `primary` et `fallback-1` à `fallback-3`, prévues pour des fournisseurs différents.
  - Les URL de secours viennent de la configuration, qui refuse toute URL portant une clé : aucune URL Helius de secours n'est donc possible.
  - Le transport HTTP bascule sur une erreur réseau, un 429 ou un 502 à 504. Il ne lit jamais le corps des réponses.
  - Il met une position à l'écart pour 1 s, ou pour la durée de `Retry-After`, plafonnée à 60 s. Un 401 ou un 403 ne déclenche aucune bascule.
  - La WebSocket bascule entre positions. Chaque tentative commence par une vérification de la genèse en HTTP sur la position visée.
  - Les sources épinglées (rattrapage, finalité, blocs) restent sur leur position. Un rattrapage en pause reste attaché à sa position, même épuisée : le listener reste alors dégradé.
- **Exécuteur**
  - Il a une seule URL et aucune bascule.
  - Son projet Helius est lié à la comptabilité de quota : preuve fournisseur, gate 7, report d'enveloppe.
- Aucun code ne reconnaît « max usage reached ».

## 3. Décisions de cadrage

| Question | Décision |
|---|---|
| Processus | Le listener seul. L'exécuteur garde son compte dédié, changé à la main avec une requalification. Sa clé n'entre jamais dans la liste. |
| Déclencheurs | Quota épuisé : HTTP 429 dont le corps contient « max usage reached ». Clé refusée : HTTP 401 ou 403. Un 429 de débit garde le comportement actuel. |
| Phase 2, plus tard | Un 429 de débit fait aussi passer au compte suivant, pour gagner du débit. |
| Approche | Rotation des comptes derrière la position `primary` (4.1). |
| Ordre | Ordre alphabétique des noms de compte. Le listener reste sur un compte tant qu'il répond, puis prend le suivant, et revient au début après le dernier. |
| Entrées Vault | La liste remplace les deux URL du listener. L'URL de l'exécuteur reste une entrée à part. |

La section 1 de la spec Vault prévoyait que les trois URL Helius deviendraient une seule entrée. La deuxième ligne du tableau l'exclut : la clé de l'exécuteur reste hors de la liste.

## 4. Approches considérées

### 4.1 Retenue : rotation des comptes derrière la position `primary` (A)

Tous les comptes sont chez Helius : même infrastructure, même vue de la chaîne. Seuls leurs quotas diffèrent. Un sélecteur de compte et un `fetch` rotatif, placés sous les connexions RPC du listener, changent la clé des requêtes de la position `primary`.

Ce choix a trois effets :
- le fournisseur reste `primary`, donc aucune migration n'est nécessaire ;
- le rattrapage épinglé suit le changement de compte ;
- le nombre de comptes n'est pas limité par la base.

### 4.2 Écartée : un compte par position (B)

La liste remplirait les positions `primary` à `fallback-3`, et la bascule actuelle servirait telle quelle. Trois raisons l'écartent :
- quatre comptes au plus, à cause des contraintes de la base ;
- des positions prévues pour des fournisseurs différents porteraient des comptes du même fournisseur ;
- il faudrait détacher le rattrapage épinglé d'une position épuisée.

### 4.3 Écartée : rotation par redémarrage (C)

Un superviseur lirait les journaux et relancerait le listener avec le compte suivant. Chaque bascule couperait l'écoute et imposerait un rattrapage. La détection dépendrait du texte des journaux.

## 5. L'entrée Vault

### 5.1 Format

- **Entrée :** `sol/secrets/back/helius-listener-accounts`, avec un champ par compte. Le nom du champ est le nom du compte ; sa valeur est la clé API Helius.
- **Noms :** `^[a-z0-9][a-z0-9-]{0,31}$`.
- **Clés :** une ligne imprimable sans espace, de 4 096 caractères au plus. C'est la règle actuelle des secrets.
- **Nombre :** de 1 à 32 comptes.
- **Ordre :** l'ordre alphabétique des noms. Un préfixe numérique fixe l'ordre : `01-perso`, `02-pro`.
- C'est la seule entrée secrète à plusieurs champs. Les autres n'ont qu'un champ `value`.

### 5.2 Édition

Les clés passent par stdin et ne s'affichent jamais. Un ajout ou un retrait ne fait repasser aucune autre clé par le terminal.

```bash
# Ajouter ou remplacer un compte
IFS= read -rs cle && printf '%s' "$cle" | sol_vault kv patch sol/secrets/back/helius-listener-accounts 02-pro=- ; unset cle
# Retirer un compte
sol_vault kv patch -remove-data=02-pro sol/secrets/back/helius-listener-accounts
```

La création de l'entrée utilise `kv put` avec le premier compte, toujours par stdin. `kv get` sur cette entrée affiche les clés : le runbook l'interdit. Les noms des comptes se lisent dans la sortie de `sol helius reload` (7.1).

### 5.3 Adresses Helius

Les adresses, sans clé, sont de la configuration non secrète du listener :
- `HELIUS_RPC_HTTP_URL`, par défaut `https://mainnet.helius-rpc.com/` ;
- `HELIUS_RPC_WS_URL`, par défaut `wss://mainnet.helius-rpc.com/`.

Les règles actuelles des configurations s'appliquent : une adresse qui porte une clé est refusée. Le schéma doit être https pour l'une, wss pour l'autre.

### 5.4 Lecture au démarrage et distribution

- **`vault-pull`**
  - Il lit l'entrée et écrit `back/helius-listener-accounts` en tmpfs (le nom de l'entrée, comme pour les autres secrets) : un objet JSON compact, noms triés.
  - Il refuse une entrée invalide avec le code 78, comme toute entrée invalide. Le message nomme le champ en faute, jamais sa valeur.
  - L'entrée est requise dans les deux modes, puisque le listener tourne dans les deux.
- **Distribution :** le fichier ne va qu'à l'utilisateur `listener`, avec les droits des autres secrets distribués.
- **`sol-run listener`**
  - Il valide le fichier avec les règles de 5.1.
  - Il exporte `SOLANA_HTTP_RPC_URL` et `SOLANA_WS_RPC_URL` : les adresses de 5.3 avec le paramètre `api-key` du premier compte.
  - Il exporte aussi `LISTENER_HELIUS_ACCOUNTS_PATH`, le chemin du fichier.

  La configuration ne peut fixer aucune de ces trois variables.
- **API opérateur :** elle prend l'URL de l'exécuteur dans les deux modes. Le sélecteur « par mode » disparaît. C'est déjà le cas en `live`, et c'est ce que prévoit l'inventaire de la section 7.1 du sous-projet 1. En mode observe, ses lectures de solde comptent sur le projet de l'exécuteur, soit quelques crédits.
- **Anciennes entrées :** `helius-listener-http-url` et `helius-listener-ws-url` sortent de la disposition. Plus aucun processus ne les lit, et le runbook dit de les supprimer.

### 5.5 Import

`vault-import` convertit `SOLANA_HTTP_RPC_URL` et `SOLANA_WS_RPC_URL` du `listener.env` d'origine :
- les deux URL doivent porter la même clé `api-key` ;
- l'entrée devient un seul compte, `01` ;
- les deux adresses, sans clé, vont dans la configuration du listener, sous `HELIUS_RPC_HTTP_URL` et `HELIUS_RPC_WS_URL`.

## 6. Rotation dans le listener

Sans `LISTENER_HELIUS_ACCOUNTS_PATH`, le listener garde son comportement actuel : un seul compte, aucune rotation. C'est le cas hors de la stack, en développement et dans les tests existants.

### 6.1 Sélecteur de compte

- **Instance :** un objet par processus, en mémoire, créé par la fabrique du listener.
  - Il lit le fichier des comptes au démarrage, avec les règles de 5.1.
  - Il connaît le compte courant et, pour chaque compte, la fin de sa mise à l'écart et sa raison.
  - Il démarre sur le premier compte.
- **Mise à l'écart :**
  - Elle est idempotente.
  - Si le compte mis à l'écart est le compte courant, le sélecteur prend le suivant disponible dans l'ordre, en revenant au début après le dernier.
  - Elle dure `LISTENER_HELIUS_ACCOUNT_COOLDOWN_MS`, par défaut 3 600 000 ms (1 h), entre 60 000 ms et 86 400 000 ms.
  - Ensuite, le compte redevient candidat. Il n'est retenté que lorsqu'un changement de compte est nécessaire.
- **Tous les comptes à l'écart :** le compte courant ne change pas, et ses requêtes échouent comme aujourd'hui avec un compte épuisé. Le listener se dégrade puis réessaie. La première mise à l'écart qui se termine rend son compte de nouveau candidat.

### 6.2 `fetch` rotatif

- **Place :**
  - Il se trouve sous les quatre connexions RPC du listener : le client partagé et les sources épinglées de rattrapage, de finalité et de blocs.
  - Il est placé sous les couches existantes de mesure et de délai, au plus près du réseau.
  - Il ne réécrit que les requêtes dont l'origine et le chemin sont ceux de `SOLANA_HTTP_RPC_URL`, c'est-à-dire la position `primary`. Toute autre requête passe telle quelle.
- **Pour chaque requête :**
  1. Il remplace le paramètre `api-key` par la clé du compte courant.
  2. Il classe la réponse :
     - un 429 dont le corps contient « max usage reached », sans tenir compte de la casse, donne `QUOTA_EXHAUSTED` ;
     - un 401 ou un 403 donne `KEY_REFUSED`.

     Dans les deux cas, il met le compte à l'écart et rejoue la requête sur le nouveau compte courant, au plus une fois par compte.
  3. Il rend toute autre réponse telle quelle, y compris un 429 de débit.
  4. Quand plus aucun compte n'est disponible, il rend la dernière réponse.
- **Corps :** le corps d'un 429 est lu sur un clone, et la réponse rendue reste lisible. Le corps d'une requête JSON-RPC est une chaîne, donc la requête peut être rejouée.
- **Requêtes simultanées :** quand plusieurs requêtes voient le même 429, la mise à l'écart ne compte qu'une fois, et toutes repartent sur le nouveau compte courant.

### 6.3 WebSocket

- **Clé :** une nouvelle connexion de la position `primary` prend la clé du compte courant au moment de la connexion.
- **Ordre des étapes :** chaque tentative commence par la vérification de la genèse en HTTP, qui passe par le `fetch` rotatif. Un compte épuisé est donc remplacé avant même l'ouverture du socket.
- **Session ouverte :** un changement de compte ne coupe pas une session en cours. Si celle-ci tombe, sa reprise prend la nouvelle clé.

### 6.4 Rattrapage et finalité

- Ils restent attachés à la position `primary`.
- Leurs requêtes passent par le `fetch` rotatif. Un rattrapage en pause reprend donc sur le compte suivant.

### 6.5 Journaux

Chaque événement donne le nom du compte, jamais sa clé ni une URL complète.
- `rpc.helius_account_selected`, en information, au démarrage et à chaque changement de compte.
- `rpc.helius_account_set_aside`, en avertissement. Il donne le compte, la raison, le statut HTTP, la fin de la mise à l'écart, le compte suivant et le nombre de comptes encore disponibles.
- `rpc.helius_accounts_unavailable`, en erreur, une fois par fenêtre de mise à l'écart. Il donne le nombre de comptes et l'heure du prochain essai.

## 7. Exploitation

### 7.1 `sol helius reload`

La commande se lance en root dans `back` :
1. `vault-pull back <mode>`, avec l'AppRole du démarrage ;
2. la distribution des secrets ;
3. `supervisorctl restart listener`.

- **Sortie :** seulement les noms, sous la forme `{"event":"helius.reloaded","accounts":["01-perso","02-pro"]}`.
- **Échec :** si Vault refuse, ou si la liste est invalide, la commande s'arrête avant le redémarrage, et le listener garde son ancienne liste.
- **Autres programmes :**
  - la commande ne touche pas au trading ;
  - les autres entrées relues ne prennent effet qu'au prochain démarrage de leur programme.

Une autre modification de Vault demande toujours de redémarrer `back`.

### 7.2 Runbook

Une section « Comptes Helius du listener » dans `docs/operations/deployment.md` couvre :
- la création de l'entrée, l'ajout et le retrait d'un compte, puis le rechargement ;
- la lecture de l'état dans les journaux : `sol_compose logs back | grep helius_account` ;
- quoi faire quand tous les comptes sont épuisés : ajouter un compte, ou attendre un renouvellement ;
- la suppression des deux anciennes entrées.

Elle met à jour l'inventaire des secrets.

### 7.3 Mise en place sur le Mac

1. Agrandir le disque de Docker Desktop, rempli à 88 % le 2026-10-10.
2. Construire les images au commit de fusion.
3. Créer l'entrée :
   - `01-ancien` porte la clé actuelle, épuisée ;
   - `02-nouveau` porte la nouvelle clé.
4. Supprimer `helius-listener-http-url` et `helius-listener-ws-url`.
5. Recréer `back` avec la nouvelle image, puis arrêter la rétention, qui reste cassée (tâche #68). Le listener, lui, reste actif.
6. Vérifier dans les journaux :
   - la mise à l'écart de `01-ancien` avec `QUOTA_EXHAUSTED` ;
   - la sélection de `02-nouveau` ;
   - l'arrivée des créations de tokens.

   Les requêtes refusées par un compte épuisé ne devraient consommer aucun crédit : le tableau de bord de Helius le confirmera.

## 8. Invariants de sécurité

1. La clé de l'exécuteur n'entre jamais dans la liste du listener. Seul l'utilisateur `listener` lit le fichier des comptes.
2. Aucune clé ni URL complète n'apparaît dans un journal, un message d'erreur, argv ou la sortie d'une commande.
3. Toutes les valeurs de l'entrée sont du texte, pour le masquage de l'audit Vault.
4. Le démarrage reste fermé en cas d'échec :
   - une liste invalide arrête le démarrage du back (code 78) ;
   - `sol helius reload` ne redémarre rien en cas d'échec.

## 9. Tests et validation

### 9.1 Tests unitaires (node:test, sans réseau)

- **Liste :**
  - la validation : nombre, noms, clés ;
  - l'ordre alphabétique ;
  - le rendu par `vault-pull` ;
  - des messages qui nomment le champ et jamais la valeur.
- **`sol-run` :**
  - le listener reçoit les deux URL du premier compte et le chemin du fichier ;
  - les adresses par défaut sont appliquées ;
  - une adresse qui porte une clé est refusée ;
  - la configuration ne peut pas fixer les variables injectées.
- **Distribution :**
  - seul l'utilisateur `listener` reçoit le fichier ;
  - l'API opérateur reçoit l'URL de l'exécuteur dans les deux modes ;
  - le mode observe ne tire toujours pas la keypair.
- **Import :**
  - les deux URL d'origine deviennent le compte `01` et les deux adresses ;
  - deux clés différentes sont refusées.
- **Sélecteur et `fetch` rotatif :**
  - « max usage reached » fait basculer et rejouer la requête ;
  - un 401 ou un 403 fait de même ;
  - un 429 de débit est rendu tel quel ;
  - quand tous les comptes sont à l'écart, la dernière réponse est rendue avec un seul journal ;
  - la fin de mise à l'écart est respectée ;
  - une requête hors de `primary` n'est pas touchée ;
  - des 429 simultanés ne comptent qu'une mise à l'écart ;
  - aucune clé n'apparaît dans les journaux.
- **WebSocket :** une nouvelle connexion prend la clé du compte courant.
- **Câblage :** les quatre connexions de `primary` passent par le `fetch` rotatif. Un faux `fetch` note la clé de chaque requête.

### 9.2 Smoke en CI (job `deployment-contract`)

- Le Vault jetable porte deux comptes factices.
- Le fichier n'est distribué qu'au listener.
- `sol helius reload` ne redémarre que le listener.
- La recherche de fuites couvre les deux clés.

### 9.3 Validation sur le Mac

La mise en place de 7.3, qui demande l'accord explicite de l'utilisateur.

## 10. Hors périmètre

- La phase 2 : un 429 de débit fait aussi passer au compte suivant.
- L'affichage du compte courant dans la console.
- L'exécuteur.
- La réduction de la charge HTTP du listener : abonnement restreint aux créations, sondage des courbes.
- Les positions de secours d'autres fournisseurs, qui ne changent pas.

## 11. Critères d'acceptation

- Avec deux comptes dont le premier est épuisé, le listener démarre sur le second sans intervention, et le journalise.
- Un 429 de débit ne fait pas changer de compte.
- Un ajout de compte suivi de `sol helius reload` ne redémarre que le listener et ne touche pas au trading.
- Aucune clé n'apparaît dans les journaux ni dans `docker inspect`, ce que vérifie la recherche du smoke.
- La CI est verte : `quality`, `deployment-contract`, `frontend-e2e`.
