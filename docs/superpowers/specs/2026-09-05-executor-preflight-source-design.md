# Export PostgreSQL de la source préflight — conception #51-H2h

**Version de spécification :** 1.0.0

**Version de la spécification parente :** 1.11.14

**Date :** 2026-09-05

**Statut :** APPROUVÉE — export read-only non signant

**Issue parente :** #51

**Dépendance :** #51-H2g

## 1. Objectif

H2h produit `execution-preflight-draft-source.v1`, l'entrée persistante de
H2g. Il lit une génération, ses snapshots courants, une intention canary BUY
`PENDING` et un artefact de simulation `SUCCESS` explicitement désignés.

Il ne choisit jamais implicitement une ligne récente et ne crée, ne loue ou ne
modifie aucune intention.

## 2. Configuration et autorité

La commande exige exactement :

```dotenv
DATABASE_URL=postgresql://...
EXECUTOR_PREFLIGHT_GENERATION_ID=execution_wallet_generation_...
EXECUTOR_PREFLIGHT_TARGET_INTENT_ID=execution_intent_...
EXECUTOR_PREFLIGHT_SIMULATION_ARTIFACT_ID=execution_simulation_artifact_...
EXECUTOR_PREFLIGHT_SOURCE_PATH=/chemin/hors-git/source.json
```

Elle refuse RPC, Helius, wallet, keypair, signing, mode live et armement. Chaque
checkout fait `SET ROLE sol_token_operator_reader`, fixe le `search_path`, puis
valide PostgreSQL 16, le LOGIN mono-membre `NOINHERIT`, l'absence d'autorité
directe, de rôle parent, de fonction `SECURITY DEFINER`, de mutation et de
capacité à changer un paramètre serveur. Toute autorité dans un schéma privé,
ownership d'objet ou droit `CREATE` fait échouer le démarrage.

Le rôle opérateur reçoit seulement les lectures supplémentaires nécessaires :
snapshots wallet, colonnes non sensibles de l'intention, artefacts de
simulation et version de migration. Il ne reçoit jamais `lease_token` ni
`execution_signed_transactions.signed_transaction_bytes`.

## 3. Photographie causale

Une transaction unique utilise :

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
```

Elle capture `statement_timestamp()` puis charge exactement :

- la génération active demandée ;
- le snapshot wallet courant de cette génération ;
- le snapshot provider courant lié au wallet ;
- l'intention exacte, complète, `BUY/PENDING`, tentative zéro, sans lease ;
- l'artefact de simulation exact et complet.

Le manifeste H2d est reconstruit depuis les mêmes lignes. Le domaine H2g est
appelé avant commit afin de recalculer génération, intention, snapshots,
artefact, qualification et sidecar. Une incohérence entraîne `ROLLBACK` et une
erreur stable redacted.

## 4. Sortie et sécurité

La source canonique est publiée hors checkout en fichier nouveau `0600`, sans
overwrite, symlink ou donnée secrète, après fsync fichier et répertoire. stdout
contient uniquement un manifeste redacted. La commande n'importe aucun client
Solana et n'a aucune capacité de signature, armement ou soumission.

État publié :

```text
PREFLIGHT_SOURCE_EXPORTED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```

## 5. Critères d'acceptation

- IDs opérateur explicites et canoniques ;
- photographie PostgreSQL unique, read-only et rejouable ;
- rôle réel PostgreSQL 16 audité et sans mutation ;
- source complète acceptée immédiatement par H2g ;
- sortie atomique owner-only sans overwrite ;
- aucune clé/RPC/armement/soumission ;
- build, check, lint, tests, migrations et documentation verts.
