# Autorité PostgreSQL du listener canary — conception #51-H2i

**Version de spécification :** 1.0.0

**Version de la spécification parente :** 1.11.15

**Date :** 2026-09-05

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-H2h fusionnée par la PR #84

## 1. Problème confirmé

Le provisioning crée `sol_token_listener_writer`, mais ne lui accorde aucun
droit sur les projections du listener. Un login mono-membre échoue donc avant
le démarrage du dry-run paper. Utiliser le propriétaire de la base contournerait
la séparation H2c et donnerait au listener accès aux armements, locks et octets
signés.

## 2. Autorité fermée

Le script rejouable remet `sol_token_listener_writer` à zéro sur tous les
schémas utilisateur, relations, séquences, fonctions et paramètres, puis
accorde uniquement :

- `USAGE` sur `public` ;
- `SELECT` sur `migration_history` ;
- `SELECT`, `INSERT`, `UPDATE` et `DELETE` sur les tables métier réellement
  possédées par le listener et ses workers de projection ;
- `USAGE` sur les deux séquences requises par l'outbox API et le scheduler
  paper ;
- `SELECT` et `INSERT` bornés sur `execution_intents`, plus `SELECT` sur
  `execution_intent_tombstones`, uniquement pour l'émission neutre issue du
  paper.

Toutes les autres tables `execution_*` restent sans droit, notamment celles de
génération wallet, risque, qualification live, contrôle, armement, locks,
transactions signées, simulation live, soumission et réconciliation.

Comme tout rôle hérite des ACL de `PUBLIC`, le provisioning révoque aussi
dynamiquement les privilèges de table et de colonne de `PUBLIC` sur chaque
relation `execution_*` existante. Il supprime les ACL directes de type,
langage, base et les default ACL accordées au groupe listener. Une propriété
d'objet contournerait les ACL : elle provoque donc un échec fermé et doit être
réassignée par l'administrateur. Le script est rejoué après chaque migration
avant tout démarrage du listener.

## 3. Connexion et exploitation

Le login de déploiement reste `NOINHERIT`, mono-membre du groupe et sans
autorité directe. La connexion du listener fixe le rôle dès l'ouverture par
le paramètre PostgreSQL `options=-c role=sol_token_listener_writer`; ainsi
toutes les connexions du pool ont `current_user=sol_token_listener_writer`.
Le listener reste sans keypair et `EXECUTION_MODE=paper` n'est utilisé que
temporairement pour produire une intention BUY réelle par le flux normal.

Le provisioning n'accepte ni login, ni mot de passe, ni URL. Les credentials
restent dans un fichier externe `0600`. La migration automatique reste
désactivée avec ce rôle.

## 4. Validation

- test statique de l'allowlist et des exclusions live ;
- test PostgreSQL 16 optionnel qui injecte des dérives directes, `PUBLIC`, de
  type, de default ACL et de propriété, puis vérifie leur suppression ou leur
  rejet fermé ainsi que les droits effectifs de toutes les tables
  `execution_*` découvertes dans le catalogue ;
- dry-run paper Mainnet borné sous le login dédié ;
- build, check, lint, tests et documentation verts ;
- aucun wallet chargé, aucun armement et aucune transaction envoyée.

## 5. Hors périmètre

L'autorité `sol_token_executor_worker` reste vide et sera traitée dans la PR
H2j séparée avant la simulation #51-D. H2i ne produit pas de preuve provider,
ne qualifie pas les gates H2c et ne démarre pas le canary.
