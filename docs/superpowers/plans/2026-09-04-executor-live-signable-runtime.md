# Executor Live Signable Runtime — plan de livraison #51-H2b

**Goal:** Livrer un runtime H2b signable mais désarmé, limité à la reprise et à
l'exécution BUY/SELL, sans déplacer dans ce processus les responsabilités H2a
ou H2c.

**Architecture:** H2b possède son pool PostgreSQL, son signer et ses sessions
RPC signables. Sa passe expose exactement quatre lanes : recover SELL, execute
SELL, recover BUY, execute BUY. H2a demeure le binaire séparé de finalité,
confirmation, réconciliation et deadline. H2c demeure le lot d'armement
opérateur et de canary.

**Tech Stack:** TypeScript ESM strict, Node.js 22, `node:test` via `tsx`,
PostgreSQL 16 avec `pg`, `@solana/web3.js` et RPC JSON local.

## 1. Contrat livré

- [x] Filtrer `LIVE_RECOVER` atomiquement par côté.
- [x] Composer uniquement recover SELL, execute SELL, recover BUY, execute BUY.
- [x] Arrêter la passe après le premier résultat `WORKED`.
- [x] Ne pas importer les lanes ou façades de finalité H2a.
- [x] Ne pas exposer armement, admission, création d'intention, confirmation,
  réconciliation, finalité, deadline ou canary dans les façades H2b.
- [x] Persister les octets signés avant simulation signée et soumission.
- [x] Reprendre les états pré-soumission sans reconstruction ni re-signature.
- [x] Utiliser `maxRetries=0` et rendre toute issue incertaine `AMBIGUOUS`.
- [x] Fermer le signer avant PostgreSQL lors de l'arrêt borné.

## 2. Autorité PostgreSQL

- [x] Utiliser un rôle H2b `NOLOGIN`, sans attribut privilégié, ownership ni
  rôle parent.
- [x] Exiger un login de déploiement sans privilège direct, membre uniquement
  de `sol_token_executor_live` avec les options PostgreSQL 16 exactes.
- [x] Appliquer `SET ROLE` et `search_path=pg_catalog,public` à chaque checkout.
- [x] Rejouer une allowlist uniquement par colonnes sur tous les schémas
  utilisateur et refuser droits table-wide, grant options, memberships,
  ownerships, default ACL et fonctions utilisateur `SECURITY DEFINER`.
- [x] Détecter DATABASE, SCHEMA, TABLE, COLUMN, SEQUENCE, FUNCTION, TYPE et
  LANGUAGE.
- [x] Durcir au niveau de la base le `PUBLIC TEMP` intrinsèque de PostgreSQL 16,
  car une relation temporaire homonyme pourrait masquer une relation `public`.
  Ne pas transformer cette révocation DB-scoped en révocation globale sur les
  autres bases ou rôles.
- [x] Reconnaître que `COPY TO` découle de `SELECT` pour les colonnes accordées.

## 3. Tests et documentation

- [x] Tester l'ordre exact des quatre lanes et l'arrêt au premier `WORKED`.
- [x] Tester les façades gelées et l'absence des capacités H2a/H2c.
- [x] Tester les droits permis et refusés avec un vrai rôle PostgreSQL 16.
- [x] Tester le provisioning rejoué et la fermeture des autorités résiduelles.
- [x] Tester uniquement contre des RPC locaux et des keypairs éphémères.
- [x] Mettre à jour la spécification parente en 1.10.0, l'orchestration en
  1.2.0 avec parent 1.10.0, la fondation live en 1.1.0 et le runbook en 1.4.0.
- [x] Laisser la spécification H2a 1.1.5 inchangée.
- [x] Ne déclarer ni canary exécuté, ni validation économique, ni `PASS`.

## 4. Vérifications finales

```bash
npx tsx --test tests/executor-live-main.integration.test.ts \
  tests/executor-live-lanes.test.ts tests/executor-architecture.test.ts \
  tests/executor-roles-provisioning.test.ts
npm run check:backend
npm run lint:backend
npm run docs:check
git diff --check
```

Les tests PostgreSQL réels exigent `TEST_DATABASE_URL` vers PostgreSQL 16 et un
utilisateur de test capable de créer une base et les rôles isolés. Aucun test
ne doit atteindre Mainnet.

## 5. État de remise

La publication du binaire H2b n'exécute pas `live:resume`, `live:arm` ou une
transaction. H2c conserve ces étapes manuelles. L'état exact de remise est :

```text
LIVE_SIGNABLE_RUNTIME_COMPOSED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```
