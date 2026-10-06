# Clôture P1 — modèle de configuration et deux corrections limitées

Date : 2026-10-04 23:07 UTC. Cette passe n’a consulté aucun `.env`, keyfile, secret manager, wallet ni DSN cible; aucune lecture RPC, observation réseau, signature, diffusion, exécution live ou migration cible n’a eu lieu.

## Résultat

- Modèle de variables réellement lues et template vide : [`live-config-model.md`](../../live-config-model.md) et [`.env.live.example`](../../../.env.live.example).
- Les neuf échecs de tests de migration venaient de versions attendues figées à 015/15 alors que la migration courante applique 016–020. Les assertions fonctionnelles restent en place; les suites PostgreSQL concernées passent maintenant.
- Export du journal live en transaction PostgreSQL `READ ONLY`, indexation par signature, récupération des réponses brutes via le collecteur existant et rapport générique de session sont reliés et testés avec PostgreSQL local jetable et réponses RPC simulées.
- La cible réelle est encore non identifiée/provisionnée. Le verdict d’exploitation reste **NO-GO**.

## Neuf assertions de migration : cause et vérification

| Test | Assertion obsolète | Correction | Vérification fonctionnelle conservée |
|---|---|---|---|
| `api-event-stream-migration.test.ts` | La liste attendait les migrations 006–015 seulement. | L’attendu historique est suivi explicitement de 016–020. | Backfill et idempotence de l’outbox; événements legacy `legacy-live` et `backfill-live` conservés; tables live actuelles présentes. |
| `migration-lock.test.ts` | Le nombre canonical était fixé à 15. | Vérifie les migrations 015, 016, 020 et un ensemble courant d’au moins 20; l’ensemble appliqué doit correspondre aux fichiers découverts. | Verrou concurrent, absence de chevauchement, chaque migration enregistrée une seule fois. |
| `paper-active-session-migration.test.ts` | `applied.at(-1)` devait être 015. | Vérifie que 015 et chacune des migrations live 016–020 sont appliquées. | Index unique par mint et replay idempotent. |
| `participant-analytics-migration.test.ts` | `applied.at(-1)` devait être 015. | Vérifie la migration 007 testée et les migrations live 016–020. | Projection SSE/participants et contrainte d’événement. |
| `social-persistence-retry-migration.test.ts` | `applied.at(-1)` devait être 015. | Vérifie 014 et les migrations live 016–020. | Défaut `0 NOT NULL` et replay conservés. |
| `transaction-inbox-retry-migration.test.ts` | `applied.at(-1)` devait être 015. | Vérifie 011 et les migrations live 016–020. | Backfills retryables/déterministes, rétention et limites conservés. |
| `transaction-inbox-timestamp-migration.test.ts` | `applied.at(-1)` devait être 015. | Vérifie 010 et les migrations live 016–020. | Insertion de 20 000 lignes et ordre des timestamps conservés. |
| `transaction-ingestion-migration.test.ts` | `applied.at(-1)` devait être 015. | Vérifie 009 et les migrations live 016–020. | Inbox, backfills, lifecycle et purge conservés. |
| `wallet-graph-migration.test.ts` | `applied.at(-1)` devait être 015. | Vérifie 008 et les migrations live 016–020. | Tables wallet graph, relations et replay conservés. |

Le helper `tests/helpers/current-migration-assertions.ts` évite de faire croire que la migration ciblée est la dernière migration du dépôt. Il vérifie séparément la migration couverte par le test et les cinq migrations live présentes.

### PostgreSQL jetable

Le cluster de test a été initialisé localement sous `/tmp/sol-token-listener-p1-pg`, port 55433, rôle local sans mot de passe, puis utilisé uniquement par les tests. Le premier essai avec un rôle `postgres` absent de l’ancien cluster temporaire n’a pas lancé les assertions; le DSN de test a ensuite été corrigé vers le rôle réel du nouveau cluster.

Commande de reproduction des neuf fichiers :

```sh
TEST_DATABASE_URL=postgresql://<utilisateur-local>@127.0.0.1:55433/postgres \
  node --import tsx --test \
  tests/api-event-stream-migration.test.ts \
  tests/migration-lock.test.ts \
  tests/paper-active-session-migration.test.ts \
  tests/participant-analytics-migration.test.ts \
  tests/social-persistence-retry-migration.test.ts \
  tests/transaction-inbox-retry-migration.test.ts \
  tests/transaction-inbox-timestamp-migration.test.ts \
  tests/transaction-ingestion-migration.test.ts \
  tests/wallet-graph-migration.test.ts
```

Résultat : **42 réussis, 0 échoué, 0 ignoré**. Le test concurrent installe toutes les migrations actuelles dans un schéma neuf. Le scénario d’évolution historique installe d’abord 001–005, insère deux événements, applique 006–020 et confirme conservation des deux événements et présence des tables `live_orders` et `live_position_market_routes`. Aucune migration n’a été appliquée à une base préexistante ou cible.

Suite live/PumpSwap hors ligne, y compris les tests à processus distinct, exécutée ainsi :

```sh
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin \
  TEST_DATABASE_URL=postgresql://<utilisateur-local>@127.0.0.1:55433/postgres \
  LIVE_TEST_DATABASE_URL=postgresql://<utilisateur-local>@127.0.0.1:55433/postgres \
  node --import tsx --test tests/live-*.test.ts tests/pumpswap-live-sell-instructions.test.ts
```

Résultat : **61 réussis, 0 échoué, 0 ignoré**. `npm run check:backend` termine avec code 0. Les avertissements `bigint` signalent le fallback JavaScript lorsque le binding natif est absent; ils n’ont pas fait échouer les tests.

## Parcours de rapprochement du premier essai

Commandes réellement ajoutées :

```sh
LIVE_OPERATOR_DATABASE_URL=<DSN opérateur en lecture seule> \
  npm run live:evidence:export -- \
  --session <SESSION_ID> --wallet <PUBKEY> --out <NOUVEAU_DOSSIER>

npm run live:evidence:collect -- \
  --source <DOSSIER_EXPORT> --out <NOUVEAU_CACHE> --index-only

# Collecte historique optionnelle seulement après validation du fournisseur/quota :
SOLANA_HTTP_RPC_URL=<ENDPOINT_HTTPS> npm run live:evidence:collect -- \
  --source <DOSSIER_EXPORT> --out <NOUVEAU_CACHE> \
  --budget-rpc-requests <1..20> --commitment finalized --max-supported-version 0

npm run live:evidence:report -- \
  --source <DOSSIER_EXPORT> \
  --transactions <NOUVEAU_CACHE>/transactions.v1.jsonl \
  --wallet <PUBKEY> --session <SESSION_ID> --out <NOUVEAU_RAPPORT>
```

L’exporteur sélectionne le wallet et la session explicitement, ouvre une transaction `READ ONLY` et ne sort jamais les octets signés. Il exporte aussi les ordres sans signature pour ne pas cacher les tentatives supplémentaires. Le collecteur conserve les liens vers position/ordre et les réponses brutes; `--index-only` n’effectue aucune requête réseau. Le rapport utilise `classifyRpcTransaction`, `reconcileTransaction` et l’arithmétique native entière existants.

Test de bout en bout exécuté : l’export lit trois ordres dans PostgreSQL jetable (BUY confirmé, tentative échouée, intention PREPARED sans signature); deux signatures sont indexées; des réponses RPC JSON simulées sont archivées; le rapport est relu. Résultat : **2 réussis, 0 échoué, 0 ignoré**.

Une seconde fixture complète contient BUY +100 unités, SELL −60, un autre SELL en `UNKNOWN` avec `result:null`, une erreur de transport avec réponse HTTP absente, un BUY exécuté avec `meta.err` et une fermeture de compte dont le delta net du destinataire correspond au solde antérieur du compte fermé. Le rapport distingue `RPC_NULL` de `RPC_ERROR`; les deux conservent les soldes/frais indisponibles. Il affiche acquisition observée `100`, vente observée `60`, reliquat `INCONNU` et aucun delta lamport/frais/wSOL total inventé. `meta.fee` reste associé au delta wallet et n’est jamais soustrait une deuxième fois. Les créations/fermetures de comptes, soldes et destinations sont consignés par signature; un remboursement est décrit séparément par son candidat et le delta effectivement observé à destination. Les soldes historiques de fin de session restent inconnus si absents. Le résultat économique reste `null`, faute de soldes wallet fiables aux bornes, de couverture des mouvements externes et de prix des reliquats.

Cette fixture valide le câblage et le traitement des données; elle n’est pas une collecte blockchain. Aucun appel `getTransaction` distant n’a été fait.

## Contrôles P1 et environnement

| Contrôle | Statut | Commande/preuve | Action restante |
|---|---|---|---|
| Machine/répertoire local | PASS local seulement | Darwin arm64; dépôt courant; Node v25.9.0; npm 11.12.1; HEAD `33cdd0f`. | Confirmer que cette machine et ce checkout sont bien la cible d’exploitation. |
| Paramètres provisionnés | FAIL — absents | Contrôle de présence limité aux noms des variables du modèle; toutes `LIVE_*`, `SOLANA_*`, `DATABASE_URL` et variables `LIVE_OPERATOR_*` ciblées sont absentes. Aucune valeur n’a été affichée. | Provisionner la liste opérateur ci-dessous. |
| `live:config-check` | FAIL fermé avant suite de contrôles | `env -i PATH=... npm run live:config-check`; refuse sur `LIVE_ENABLE` absent. | Renseigner la politique complète; commande sans réseau/keyfile. |
| `live:network-preflight` | FAIL fermé avant réseau | `env -i PATH=... npm run live:network-preflight`; refuse avec `LIVE_RPC_URL` et genesis absents; zéro requête. | Fournir endpoint public choisi et genesis attendu; relancer une fois. |
| Build TypeScript/IDL | PASS | `npm run check:backend`; sortie 0. | Rien pour ce contrôle local. |
| Suite live | PASS hors ligne | `env -i` avec `TEST_DATABASE_URL` et `LIVE_TEST_DATABASE_URL` limités au PG jetable; 61 réussis, 0 échoué, 0 ignoré. | Aucune preuve d’environnement ou d’exécution mainnet n’en découle. |
| Schéma et migrations de cible | NON EXÉCUTÉ | Aucun `DATABASE_URL` ni `LIVE_OPERATOR_DATABASE_URL` cible. | Lecture seule après identification explicite de la base. |
| Préflight RPC complet | NON EXÉCUTÉ | Pas d’endpoint/quota provisionné; aucun accès tenté. | Lecture ciblée bornée après provisionnement. |
| Observation de 120 s | NON EXÉCUTÉ | Pas d’endpoint/base cible; `npm run dev` charge `.env` du cwd, donc ne pas le lancer sur cette machine non configurée. | Configurer environnement d’observation isolé, puis exécuter séparément. |
| Keyfile/wallet | NON EXÉCUTÉ | Aucun keyfile consulté; aucune vraie clé chargée. | L’opérateur rapproche localement le keyfile du wallet public choisi. |
| Essai borné | NON EXÉCUTÉ — interdit ici | Aucun `live:run`, ordre, signature ou diffusion. | Décision séparée de l’utilisateur après P1. |

## Liste unique des décisions et valeurs encore nécessaires

1. Confirmer la machine, le répertoire et le commit/configuration cible.
2. Choisir endpoint HTTP RPC et WS, fournisseur/quota, genesis hash attendu et confirmer l’accès réseau autorisé.
3. Identifier la base/schéma cible et fournir les DSN nécessaires par gestionnaire de secrets; confirmer en lecture seule migrations 016–020, ordres/positions non résolus et absence d’instance concurrente.
4. Choisir un wallet dédié et sa clé publique; provisionner hors dépôt le chemin absolu du keyfile protégé et faire vérifier localement leur correspondance par l’opérateur.
5. Fixer explicitement montant d’achat, exposition maximale, seuil de perte, réserve de sortie, slippage maximal et durée. `LIVE_MAX_BUYS=1` est la seule valeur autorisée; aucune somme n’est héritée d’une session précédente.
6. Choisir l’emplacement/perms de l’export, du cache RPC et du rapport.
7. Une fois les contrôles PASS, autoriser séparément l’observation et, ultérieurement, le lancement borné; cette passe ne l’a pas autorisé.

## Diff ciblé

- `.env.live.example`, `docs/operations/live-config-model.md` : modèle et distinction des variables par commande.
- `tests/helpers/current-migration-assertions.ts` et neuf tests migration : assertions mises en cohérence avec 016–020 et couverture du schéma actuel.
- `scripts/export-live-session-evidence.ts`, `scripts/report-live-session-evidence.ts`, `src/telemetry/live-session-reconciliation.ts`, `src/telemetry/signature-index.ts`, `scripts/collect-transaction-evidence.ts`, `package.json` : export RO, liaison position/ordre/signature, rapport générique et commandes.
- `tests/live-session-reconciliation.test.ts` : pipeline PostgreSQL temporaire → index de signatures → métadonnées simulées → rapport, et cas `result:null`.

`git diff --check` et `npm run check:backend` passent. Les autres fichiers modifiés avant cette passe n’ont pas été nettoyés, réinitialisés ni attribués à ce travail.
