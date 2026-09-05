# Autorité PostgreSQL du worker de simulation — conception #51-H2j

**Version de spécification :** 1.0.0

**Version de la spécification parente visée :** 1.11.16

**Date :** 2026-09-05

**Statut :** APPROUVÉE

**Issue parente :** #51

**Dépendance :** #51-H2i fusionnée par la PR #85

## 1. Objectif

Rendre les modes `dry-run` et `simulation-only` exécutables sous un login
PostgreSQL dédié sans réutiliser le propriétaire de la base et sans leur
donner une capacité live. H2j ne charge aucun wallet, ne construit aucune
signature et ne soumet aucune transaction.

## 2. Choix d'architecture

Un seul groupe `NOLOGIN` et `NOINHERIT`, `sol_token_executor_worker`, couvre
les deux modes non signants déjà composés par `src/executor/main.ts`. Deux
rôles distincts amélioreraient marginalement l'isolation, mais ajouteraient
deux déploiements et deux jeux de credentials avant le canary sans réduire la
frontière entre simulation et live. Des droits de table complets sont refusés :
chaque opération est accordée par colonne.

Le provisioning est rejouable et reconstruit l'autorité depuis zéro. Il retire
les appartenances, ACL directes, default ACL, propriétés, droits de paramètre,
droits hérités de `PUBLIC` sur les objets `execution_*`, création de schéma et
création sur la base courante avant d'accorder l'allowlist.

## 3. Allowlist exacte

### 3.1 Commun aux deux modes

- `USAGE` sur le schéma `public` ;
- `execution_intents` : `SELECT` sur la projection canonique ; `UPDATE`
  uniquement sur le lease, l'état, la révision, le compteur de tentatives, la
  raison terminale et les timestamps de cycle de vie ;
- aucun `INSERT`, `DELETE`, `TRUNCATE`, `REFERENCES` ou `TRIGGER` sur
  `execution_intents` ;
- aucun accès à `execution_intent_tombstones`.

### 3.2 Mode `dry-run`

- `execution_dry_run_assessments` : `SELECT` et `INSERT` sur son contrat
  persistant complet ; aucun `UPDATE` ni `DELETE`.

### 3.3 Mode `simulation-only`

- `execution_attempts` : `SELECT`, `INSERT` de l'identité de tentative et
  `UPDATE` de son résultat borné ;
- `execution_intent_transitions` : `SELECT(intent_id)` et `INSERT` de la
  transition complète ;
- `USAGE` sur `execution_intent_transitions_sequence_seq` uniquement ;
- `execution_simulation_artifacts` : `SELECT` et `INSERT` sur l'artefact non
  signé complet ; aucun `UPDATE` ni `DELETE` ;
- `migrations` et `market_pools` : `SELECT` uniquement sur les colonnes
  requises pour prouver le pool PumpSwap canonique.

## 4. Exclusions live

Le worker n'accède à aucune génération ou photographie wallet, qualification
live, admission de risque, réservation d'exposition, contrôle, autorisation
opérateur, armement, lock pré-signature, transaction signée, budget RPC live,
soumission, révocation, position live, preuve de confirmation ou
réconciliation. Il n'obtient aucun droit de DDL, aucune autre séquence et aucun
`GRANT OPTION`.

## 5. Connexion

Le login de déploiement est mono-membre, `NOINHERIT`, sans privilège direct.
Chaque connexion active le groupe avec l'option PostgreSQL
`-c role=sol_token_executor_worker`. La migration automatique reste désactivée
et appartient à un processus administratif distinct. Aucun login, mot de
passe ou URL n'est accepté par le script de provisioning.

## 6. Validation

- test statique de chaque colonne accordée et de chaque exclusion live ;
- test PostgreSQL 16 qui injecte des dérives de rôle, `PUBLIC`, default ACL,
  paramètre et propriété, puis vérifie leur suppression ou leur rejet fermé ;
- inventaire dynamique de toutes les relations et séquences `execution_*` ;
- exécution réelle du flux `dry-run` sous le login dédié ;
- exécution réelle du flux `simulation-only` sous le même login, avec RPC
  simulé et artefact non signé ;
- build, check, lint, tests et documentation verts.

## 7. Hors périmètre

H2j ne collecte pas le quota Helius, ne produit pas le bundle H2c, ne choisit
pas une opportunité, ne convertit pas le wallet, n'arme pas une intention et
ne démarre pas le canary. `CANARY_NOT_STARTED` reste l'état obligatoire.
