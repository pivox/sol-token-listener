# Lot 5 — premier run réel : inventaire, checklist et dry-run

**Date :** 2026-10-07. **Base :** `main` à `d223abf2` (lots 1 à 4b mergés), plus le mini-lot 5a
(sonde de gate 10, migration 067, branche `docs/lot5-readiness`). Head de migration : **067**.
**Statut :** préparation seulement. Rien n'a été lancé : aucun RPC, aucun listener, aucune transaction.

### Décisions de l'utilisateur (2026-10-07)

1. **Gate 10 par une sonde.** Le listener écrit un intent de sonde non armable
   (`fast-entry-probe-v1`) quand la sonde est activée et qu'aucune enveloppe n'est `ACTIVE`. Le
   worker simulation-only le simule et produit l'artefact. Implémenté au mini-lot 5a (§A.7, point 1).
   Le gate 10 se fait démon auto-arm arrêté, puis la sonde est désactivée avant l'enveloppe.
2. **Base :** un conteneur PG16 dédié, publié sur `127.0.0.1:5433` (§A.4, étape B2).
3. **Fournisseur :** l'exécuteur **partage le Helius du listener** (même projet, même clé). Risque
   de sous-comptage et marge : voir §A.8.
4. **Montants :** 5 achats × 0,01 SOL, exposition cumulée 0,05 SOL, perte maximale 0,03 SOL,
   holding 180 s, wallet financé à 0,1 SOL (§B.2). La variante prudente à 3 achats est écartée.

Sources lues : checkpoint `2026-10-06-simple-path-CHECKPOINT.md`, runbook
`docs/operations/executor-live-canary.md` (sections lot 4a et lot 4b), spec
`2026-10-06-simple-path-design.md`, plan lot 4a (« Deviations », « Amendments »), `.env.example`,
`package.json`, les parseurs de configuration (`src/config/env.ts`, `src/executor/config.ts`,
`src/executor-live/config.ts`, `src/executor-live-recovery/config.ts`,
`src/executor-operations/config.ts`, `src/executor-readiness/config.ts`,
`src/provider-evidence/config.ts`, `src/preflight-bundle/config.ts`), `deploy/compose.yaml`,
`scripts/provision-executor-roles.sql`, `scripts/deployment-smoke.mjs`. Pour `live.env`, seuls les
noms de variables ont été lus, avec l'indication « valeur présente » ou « valeur vide ».

Étiquettes utilisées :

- **NO-NETWORK** : aucun accès réseau vers Solana ni vers un fournisseur.
- **READ-ONLY-RPC** : lit mainnet ou l'API d'un fournisseur, sans envoyer de transaction.
- **SENDS-TX** : une transaction réelle part.
- **TTY** : l'opérateur doit être devant un vrai terminal.

---

## 0. Résumé

### Bloquants : sans eux, même le dry-run est impossible

1. **Amorçage du gate 10 : impasse levée par la sonde (mini-lot 5a).** Constat d'origine :
   - `envelope prepare` exige un artefact de simulation `SUCCESS` de moins de 24 h (`prepareEnvelopeFacts`).
   - Le runbook en tire la consigne : « worker simulation-only sur un intent fast-entry ».
   - Le listener n'écrit un intent fast-entry que si une enveloppe `ACTIVE` existe. Sans elle, il
     rejette chaque mint en `NO_ENVELOPE_CAPACITY` (`precheckFastEntry`, `src/domain/fast-entry.ts:49`).
   - Une enveloppe exige elle-même une qualification qui contient le gate 10.
   - Sur une base neuve, aucun intent n'existe donc, ni artefact, ni enveloppe.
   - La phrase du runbook « worker simulation-only avec `ENTRY_MODE=fast` » ne tient pas : le worker
     ne lit pas `ENTRY_MODE`, seul le listener le lit.
   - Résolu : la sonde `fast-entry-probe-v1` (§A.7, point 1, étapes B11 et B12).
2. **Pas de base de production PG16 accessible.** Décision : conteneur dédié sur `127.0.0.1:5433`.
   - `solanabot` (natif, port 5432) est bloqué à la migration 050 (PostgreSQL < 15).
   - Les validateurs H2a, H2b et opérations exigent les options d'appartenance PG16
     (`ADMIN FALSE, INHERIT FALSE, SET TRUE`).
   - Le Postgres 16 de `deploy/compose.yaml` ne publie aucun port, donc les processus natifs ne
     peuvent pas l'atteindre.
   - Le 55432 est la base de test : il est exclu.
3. **Preuves et clés absentes.** Aucun de ces éléments n'existe :
   - le catalogue de gates (8 gates statiques, politique de risque, empreinte de stratégie) ;
   - la clé d'attestation Ed25519 (H2e et H2f) ;
   - la clé API Helius en fichier et l'UUID du projet (celui du listener, partagé : décision 3).
   H2e ne sait interroger que l'API Admin Helius.
4. **Environnements et logins absents.**
   - `live.env` suit l'ancien schéma `LIVE_*`, qu'aucun code actuel ne lit.
   - Il faut 9 fichiers d'environnement hors Git (§A.2) et 6 logins PostgreSQL mono-rôle (§A.5).
5. **Résolu dans la branche `fix/build-hash-per-transaction` (option a) : `EXECUTOR_BUILD_HASH`
   n'est plus comparé à l'empreinte de build de chaque transaction** (revue du mini-lot 5a,
   2026-10-07).
   - `buildFingerprint` (`src/executor-simulation/solana-simulation-gateway.ts`) hache le fee payer,
     les programmes, tous les comptes (mint, bonding curve) et les données (montant) : il est propre
     à **une** transaction. `exactSigningInputFrom` (`src/storage/execution-live.repository.ts`)
     exigeait `material.buildFingerprint === runtime.buildHash` (statique) : avec l'enveloppe
     (mint inconnu à l'avance), chaque BUY `fast-entry-v1` échouait fermé (`INVALID_INPUT`) en
     consommant un `buys_armed`. Seul CANARY v3 satisfaisait l'égalité ; tous les tests partageaient
     une constante entre les deux valeurs, d'où l'angle mort.
   - Correctif : cette seule égalité est retirée. La cohérence par transaction reste garantie deux
     fois (`unsignedSigningMaterialFrom` lie le matériel à sa simulation non signée,
     `fresh-execution.ts` lie l'artefact de simulation signée au matériel). `EXECUTOR_BUILD_HASH`
     reste l'ancre statique de la qualification, de l'armement et du verrou. Test :
     `tests/execution-live-envelope.repository.test.ts`, « ENVELOPE signing accepts a per-mint
     build fingerprint different from EXECUTOR_BUILD_HASH ».
   - À merger avant B23 (H2b).

### Pièges sans être bloquants

Ils figurent dans la checklist.

- **Saut de ligne final.** `envelope prepare` écrit le brouillon suivi d'un `\n`, alors que H2f exige
  un fichier strictement canonique, sans saut de ligne final. Une simple redirection `>` fait donc
  échouer H2f. Il faut retirer le saut de ligne (étape B16).
- **Catalogue canonique.** Le catalogue de gates doit être du JSON canonique, sans saut de ligne
  final. On le génère avec `canonicalStringifyJson` (étape B5).
- **`EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT=8`.** Cette valeur de `.env.example` est refusée par H2b
  et par auto-arm, qui exigent 12 à 16.
  - Le worker simulation-only doit utiliser exactement la valeur de H2b moins 6.
  - Raison : H2b recalcule l'empreinte de configuration avec `maxRpcCallsPerAttempt - 6`
    (`src/executor-live/main.ts`, `simulationConfig`), puis exige qu'elle soit égale à
    `EXECUTOR_CONFIGURATION_FINGERPRINT` (`src/executor-live/fresh-execution.ts`).
  - L'empreinte couvre aussi le fournisseur, le wallet, le genesis, l'allowlist, `QUOTE_MAX_AGE`,
    `SLIPPAGE`, `SNAPSHOT_MAX_SLOT_LAG`, `MAX_COMPUTE_UNITS`, `MAX_FEE_LAMPORTS`,
    `MAX_FEE_PAYER_LAMPORT_DEBIT`, `MAX_PRIORITY_FEE_LAMPORTS` et `RPC_TIMEOUT_MS`
    (`configurationFingerprint`, `src/executor-simulation/attempt-evaluator.ts`). Toutes ces
    valeurs doivent être identiques entre `worker-sim.env` et `live.env`.
  - Règle fragile : aucun outil ne compare les deux fichiers. Un écart n'apparaît qu'au premier
    BUY, qui échoue fermé (`Invalid live execution identity`) mais consomme un `buys_armed`.
    Faire le `diff` de l'étape B10.
- **`EXECUTOR_BUILD_HASH` n'est pas un hash de build logiciel.**
  - C'est le `build_fingerprint` de l'artefact gate 10 : un hash des instructions de cette
    transaction simulée précise (fee payer, comptes, données). H2b ne la compare plus à chaque
    transaction signée (bloquant 5 résolu) : elle n'ancre que la qualification, l'armement et le
    verrou.
  - `EXECUTOR_CONFIGURATION_FINGERPRINT` est de même le `configuration_fingerprint` de cet artefact.
  - On les lit en SQL après la simulation (étape B13).
- **`fast-path:report` ne charge pas `dotenv`.** Utiliser `node --env-file=…`.
- **Bannière npm.** `npm run` imprime une bannière sur la sortie standard. Pour toute commande dont
  la sortie est capturée, appeler `node dist/...` directement.
- **Brûlage de l'enveloppe.** Un armement jamais acheté (H2b arrêté) consomme un `buys_armed`.
  Le dry-run utilise donc sa propre enveloppe.

### Enveloppe du premier run (décidée le 2026-10-07)

Le détail des calculs est en §B.2.

| Paramètre | Valeur |
|---|---|
| `--per-buy-lamports` | `10000000` (0,01 SOL) |
| `--max-buys` | `5` |
| `--max-exposure-lamports` | `50000000` (cumulé : 5 × par achat) |
| `--max-loss-lamports` | `30000000` (0,03 SOL) |
| `--holding-ms` | `180000` (3 min, plafond lot 5 : 300 000) |
| `prepare --valid-ms` | `7200000` (2 h) |

Politique (catalogue) :

| Champ | Valeur |
|---|---|
| `initialCapitalLamports` = `maximumCapitalLamports` | `240000000` |
| `positionSizeBps` | `1000` |
| `maximumTotalExposureBps` | `500` |
| `maximumOpenPositions` | `1` |
| `feeReserveLamports` | `20000000` |
| `walletSnapshotMaxAgeMs` = `providerUsageMaxAgeMs` | `180000` |

Financement du wallet : **0,1 SOL**. La perte maximale théorique est d'environ 0,053 SOL.

---

## A. Inventaire

### A.1 Processus du lot 5

Toutes les commandes s'exécutent depuis la racine d'un checkout propre de `main` (`d223abf2`),
après `npm ci && npm run build:backend`. `L` désigne un répertoire privé hors du dépôt
(`/chemin/hors-git/lot5`, mode `0700`). Chaque fichier `L/env/*.env` est en `0600`.

| # | Processus | Commande | Login / rôle PostgreSQL | Durée de vie |
|---|---|---|---|---|
| 1 | Migration | `DOTENV_CONFIG_PATH=L/env/migrate.env npm run db:migrate:compiled` | propriétaire du schéma | one-shot |
| 2 | Provisioning des rôles | `psql -X -v ON_ERROR_STOP=1 -f scripts/provision-executor-roles.sql` (connexion par `PGSERVICE` et `PGPASSFILE`) | administrateur | one-shot, à rejouer après chaque migration |
| 3 | Listener (`ENTRY_MODE=fast`, `creates-only`) | `DOTENV_CONFIG_PATH=L/env/listener.env npm start` | login → `sol_token_listener_writer` | démon |
| 4 | Worker simulation-only (gate 10) | `DOTENV_CONFIG_PATH=L/env/worker-sim.env npm run executor:start` | login → `sol_token_executor_worker` | une fois, puis arrêt |
| 5 | H2e, preuve provider | `DOTENV_CONFIG_PATH=L/env/provider-evidence.env npm run executor:provider-evidence:start` | aucun (pas de base) | one-shot |
| 6 | H2d, readiness (génération et snapshots) | `DOTENV_CONFIG_PATH=L/env/readiness.env npm run executor:readiness:start` | login → `sol_token_executor_readiness` | one-shot |
| 7 | CLI opérations | `DOTENV_CONFIG_PATH=L/env/operations.env node dist/src/executor-operations/main.js <commande>` | login → `sol_token_executor_operations` | one-shot |
| 8 | H2f, signature hors ligne | `DOTENV_CONFIG_PATH=L/env/preflight-bundle.env npm run executor:preflight-bundle:start` | aucun | one-shot |
| 9 | Auto-arm | `DOTENV_CONFIG_PATH=L/env/operations.env npm run live:auto-arm` | même rôle operations (A21) | démon |
| 10 | H2a, récupération et sorties | `DOTENV_CONFIG_PATH=L/env/live-recovery.env npm run executor:live:recovery:start` | login → `sol_token_executor_live_recovery` | démon |
| 11 | H2b, exécuteur signant | `DOTENV_CONFIG_PATH=L/env/live.env npm run executor:live:start` | login → `sol_token_executor_live` | démon |
| 12 | Rapport | `node --env-file=L/env/report.env dist/src/cli/fast-path-report.js [--since=ISO] [--format=table\|json]` | propriétaire, en transaction `READ ONLY` | one-shot |

Processus optionnels : la console opérateur (`operator:api:start`, rôle `sol_token_operator_reader`)
et la rétention (`retention:start:compiled`, rôle `sol_token_retention_worker`).

Le job de rétention purge les armements et les artefacts 4 h après leur état terminal. Il doit donc
rester **arrêté** jusqu'à ce que le rapport soit pris.

Le worker dry-run (`EXECUTOR_MODE=dry-run`) n'a pas de rôle au lot 5. Il ne doit pas tourner : il
volerait les intents fast-entry.

### A.2 Variables requises par processus

Aucune valeur n'est donnée ici, seulement le format attendu. Un parseur qui échoue renvoie une
erreur générique sans détail (par exemple `INVALID_LIVE_EXECUTOR_CONFIG`). Il faut donc vérifier
chaque format à la main.

#### Valeurs runtime communes

Ces valeurs doivent être identiques dans `worker-sim`, `operations` (auto-arm), `live`, et
partiellement dans `live-recovery`.

| Variable | Valeur recommandée | Contrainte vérifiée par le code |
|---|---|---|
| `EXECUTOR_POLL_MS` | `1000` | inférieur au bail |
| `EXECUTOR_LEASE_MS` | `40000` | H2b et H2a : `rpc×4 + db×6 + 1000 ≤ lease` (5000×4 + 3000×6 + 1000 = 39 000). CANARY : ≤ 120 000. Auto-arm : `2×lease + 20000 ≤ 120000` (100 000) |
| `EXECUTOR_DB_STATEMENT_TIMEOUT_MS` | `3000` | `db×3 ≤ lease` ; `db + 1000 ≤ shutdownGrace` |
| `EXECUTOR_SHUTDOWN_GRACE_MS` | `10000` | 1000 à 60 000 |
| `EXECUTOR_RPC_TIMEOUT_MS` | `5000` | auto-arm : ≤ 20 000. Simulation : `rpc×3 + db×5 + 1000 ≤ lease` (31 000) |
| `EXECUTOR_QUOTE_MAX_AGE_MS` | `3000` | 1 à 60 000 |
| `EXECUTOR_SLIPPAGE_BPS` | `500` | 0 à 10 000 |
| `EXECUTOR_SNAPSHOT_MAX_SLOT_LAG` | `8` | 0 à 128 (auto-arm observe au plus 8) |
| `EXECUTOR_MAX_COMPUTE_UNITS` | `300000` | 1 à 1 400 000 |
| `EXECUTOR_MAX_FEE_LAMPORTS` | `100000` | 0 à 10 000 000 |
| `EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT` | `2500000` | 0 à 1e10 |
| `EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS` | `0` | exactement 0 |
| `EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT` | **`14`** pour H2b et auto-arm, **`8`** pour le worker simulation | H2b et auto-arm : 12 à 16. Simulation : 6 à 16, et elle **doit valoir H2b − 6** |
| `LIVE_QUOTE_MINT_ALLOWLIST` | `So11111111111111111111111111111111111111112` | WSOL exactement |

Avec ces valeurs, la marge minimale d'un intent candidat pour auto-arm vaut
`2×40000 + 2×5000 + 5000 = 95 000 ms`. Comme `95 000 + poll 1000 ≤ 120 000`, auto-arm doit
armer dans les **25 s** qui suivent la décision d'entrée (TTL de l'intent : 120 s).

Fraîcheur minimale exigée de la politique : `2×40000 + 30000 = 110 000 ms`.

#### `listener.env` (processus 3)

| Variable | Format |
|---|---|
| `DATABASE_URL` | `postgresql://<login-listener>:<secret>@127.0.0.1:5433/<db>?options=-c%20role%3Dsol_token_listener_writer` |
| `POSTGRES_AUTO_MIGRATE` | `false` |
| `SOLANA_CLUSTER` | `mainnet-beta` |
| `SOLANA_HTTP_RPC_URL` / `SOLANA_WS_RPC_URL` | `https://…` / `wss://…`, le Helius partagé avec l'exécuteur (décision 3) |
| `SOLANA_EXPECTED_GENESIS_HASH` | base58, 32 octets, vérifié indépendamment (obligatoire avec `LISTENER_ENABLED=true`) |
| `LISTENER_ENABLED` | `true` |
| `LISTENER_INGESTION_SCOPE` | `creates-only` |
| `ENTRY_MODE` | `fast` |
| `FAST_ENTRY_PROBE_ENABLED` | `true` **uniquement** pendant B11–B12, `false` ensuite (défaut `false`) |
| `FAST_ENTRY_PROBE_INTERVAL_MS` | `600000` par défaut (60 000 à 86 400 000) ; `60000` raccourcit l'attente au gate 10 |
| `EXECUTION_MODE` | `observe` |
| `EXECUTION_INTENT_EMISSION_ENABLED` / `PAPER_STRATEGY_ENABLED` | `false` / `false` |
| `RISK_MAX_ROUNDTRIP_LOSS_BPS` | `3000` (défaut) |
| `LISTENER_TRACKED_POOL_POLL_INTERVAL_MS` | `10000` (poller de curves, au plus 20 curves) |
| `API_ENABLED` / `API_HOST` / `API_PORT` | `true` / `127.0.0.1` / `3000` |

Le listener refuse toute variable de clé privée (`rejectPrivateKeyConfiguration`).

#### `worker-sim.env` (processus 4)

| Variable | Format |
|---|---|
| `DATABASE_URL` | login worker, avec `options=-c role=sol_token_executor_worker -c search_path=pg_catalog,public` (forme encodée du runbook) |
| `POSTGRES_AUTO_MIGRATE` | `false` |
| `EXECUTOR_MODE` / `LIVE_TRADING_ENABLED` | `simulation-only` / `false` |
| `EXECUTOR_PUBLIC_KEY` | adresse base58 du wallet de l'exécuteur |
| `EXECUTOR_RPC_PROVIDER_ID` | identifiant du fournisseur de l'exécuteur (par exemple `helius`), le même partout |
| `SOLANA_HTTP_RPC_URL` | endpoint Helius (partagé avec le listener) |
| `SOLANA_EXPECTED_GENESIS_HASH` | idem listener |
| Valeurs runtime communes | voir le tableau, avec `EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT=8` |

Aucun nom de keypair, même vide.

#### `provider-evidence.env` (H2e, processus 5)

| Variable | Format |
|---|---|
| `HELIUS_PROJECT_ID` | UUID du projet Helius (partagé avec le listener) |
| `HELIUS_API_KEY_PATH` | chemin absolu hors checkout, fichier `0600` |
| `EXECUTOR_RPC_PROVIDER_ID` | même identifiant que l'exécuteur |
| `EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH` | clé PEM PKCS#8 Ed25519 `0600` hors checkout |
| `EXECUTOR_PROVIDER_EVIDENCE_PATH` | sortie, chemin absolu hors checkout |
| `EXECUTOR_PROVIDER_EVIDENCE_TTL_MS` | `300000` (30 000 à 300 000) |
| `EXECUTOR_PROVIDER_EVIDENCE_TIMEOUT_MS` | `5000` |

Sont interdits : tout nom contenant `WALLET`, `DATABASE_URL`, `SOLANA_HTTP_RPC_URL`, `KEYPAIR`,
`EXECUTOR_MODE` ou `LIVE_TRADING_ENABLED`.

#### `readiness.env` (H2d, processus 6)

| Variable | Format |
|---|---|
| `DATABASE_URL` | login readiness |
| `SOLANA_CLUSTER` | `mainnet-beta` |
| `SOLANA_HTTP_RPC_URL` | `https://` exact, sans `user:pass` ni `#`, forme canonique (`new URL(v).href === v`, donc `https://hôte/?api-key=…` avec le `/`) |
| `SOLANA_EXPECTED_GENESIS_HASH` | base58 |
| `EXECUTOR_RPC_PROVIDER_ID` | idem |
| `EXECUTOR_PUBLIC_KEY` | base58 |
| `EXECUTOR_WALLET_GENERATION_NUMBER` | `1` |
| `EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64` | SPKI DER en base64, donné par le manifeste H2e |
| `EXECUTOR_PROVIDER_EVIDENCE_PATH` | fichier produit par H2e |
| `EXECUTOR_READINESS_MAX_SLOT_LAG` | `8` |
| `EXECUTOR_RPC_TIMEOUT_MS` | `5000` |

Sont interdits : tout nom contenant `PRIVATE_KEY`, `KEYPAIR`, `MNEMONIC`, `RECOVERY_PHRASE`,
`LIVE_TRADING_ENABLED` ou `EXECUTOR_MODE`.

#### `operations.env` (CLI et auto-arm, processus 7 et 9)

Un seul fichier suffit pour les deux : A21 établit qu'un login séparé ne change rien.

| Variable | Format |
|---|---|
| `DATABASE_URL` | login operations |
| `EXECUTOR_WALLET_GENERATION_ID` | `execution_wallet_generation_<64 hex>`, donné par le manifeste H2d |
| `EXECUTOR_PUBLIC_KEY` / `SOLANA_EXPECTED_GENESIS_HASH` | base58 |
| `EXECUTOR_RPC_PROVIDER_ID` | identifiant de l'exécuteur |
| `EXECUTOR_BUILD_HASH` | 64 hex = `build_fingerprint` de l'artefact gate 10 |
| `EXECUTOR_CONFIGURATION_FINGERPRINT` | 64 hex = `configuration_fingerprint` de l'artefact gate 10 |
| `EXECUTOR_STRATEGY_FINGERPRINT` | 64 hex choisi par l'opérateur, identique à `strategyFingerprint` du catalogue |
| `EXECUTOR_ACTIVATION_PHASE` | `CANARY` |
| `EXECUTOR_OPERATOR_ID` | `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` |
| `EXECUTOR_PREFLIGHT_EVIDENCE_PATH` | absolu : `qualification.json` produit par H2f (exigé par toutes les commandes, lu par `envelope create`) |
| `EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64` | idem readiness |
| `EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH` | absolu, catalogue canonique (`envelope prepare` et `envelope create`) |
| `SOLANA_HTTP_RPC_URL` | auto-arm : `https://` canonique, endpoint de l'exécuteur |
| `EXECUTOR_AUTO_ARM_POLL_MS` | `1000` |
| Valeurs runtime | les 8 valeurs runtime communes **identiques à H2b** (`QUOTE_MAX_AGE`, `SLIPPAGE`, `SNAPSHOT_MAX_SLOT_LAG`, `MAX_COMPUTE_UNITS`, `MAX_FEE_LAMPORTS`, `MAX_FEE_PAYER_LAMPORT_DEBIT`, `MAX_RPC_CALLS_PER_ATTEMPT=14`, `LEASE_MS`), plus `EXECUTOR_RPC_TIMEOUT_MS` |

- Est interdite la **présence** d'un nom de keypair ou de clé privée.
- `LIVE_TRADING_ENABLED` est absent ou vaut `false`.
- `EXECUTOR_MODE` est absent, ou vaut `dry-run` ou `simulation-only`.

#### `preflight-bundle.env` (H2f, processus 8)

| Variable | Format |
|---|---|
| `EXECUTOR_PREFLIGHT_DRAFT_PATH` | brouillon d'enveloppe, `0600`, hors checkout |
| `EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH` | clé Ed25519 d'attestation |
| `EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY` | répertoire **absent**, hors checkout |

Sont interdits : tout accès base, RPC, Helius, wallet ou live.

#### `live-recovery.env` (H2a, processus 10)

| Variable | Format |
|---|---|
| `EXECUTOR_LIVE_RECOVERY_ENABLED` / `EXECUTOR_MODE` / `SOLANA_CLUSTER` | `true` / `live` / `mainnet-beta` |
| `DATABASE_URL` | login recovery |
| `EXECUTOR_WALLET_GENERATION_ID`, `EXECUTOR_PUBLIC_KEY`, `EXECUTOR_RPC_PROVIDER_ID`, `SOLANA_HTTP_RPC_URL`, `SOLANA_EXPECTED_GENESIS_HASH` | identiques à `operations.env` (URL `http(s)`) |
| `EXECUTOR_POLL_MS`, `EXECUTOR_LEASE_MS`, `EXECUTOR_DB_STATEMENT_TIMEOUT_MS`, `EXECUTOR_SHUTDOWN_GRACE_MS`, `EXECUTOR_RPC_TIMEOUT_MS` | valeurs communes |
| `EXECUTOR_MAX_RPC_CALLS_PER_PASS` | `8` (6 à 16) |
| `EXECUTOR_LIVE_RECOVERY_OWNER_ID` | `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, unique |
| `EXIT_TAKE_PROFIT_BPS` / `EXIT_EXTERNAL_BUYERS_TARGET` / `EXIT_EXTERNAL_MIN_BUY_RAW` | optionnels : défauts 20000 / 10 / 1000000 |

Aucun nom de keypair, même vide.

#### `live.env` (H2b, processus 11)

Ce fichier remplace l'ancien `live.env` du checkout.

| Variable | Format |
|---|---|
| `EXECUTOR_MODE` / `LIVE_TRADING_ENABLED` / `SOLANA_CLUSTER` | `live` / `true` / `mainnet-beta` |
| `DATABASE_URL` | login live |
| `EXECUTOR_ACTIVATION_PHASE` | `CANARY` |
| `EXECUTOR_WALLET_GENERATION_ID`, `EXECUTOR_PUBLIC_KEY`, `EXECUTOR_RPC_PROVIDER_ID`, `SOLANA_HTTP_RPC_URL`, `SOLANA_EXPECTED_GENESIS_HASH` | identiques à `operations.env` |
| `EXECUTOR_BUILD_HASH`, `EXECUTOR_CONFIGURATION_FINGERPRINT`, `EXECUTOR_STRATEGY_FINGERPRINT` | identiques à `operations.env` |
| `EXECUTOR_KEYPAIR_PATH` | voir §A.6 |
| Valeurs runtime communes | toutes, avec `EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT=14`, `EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS=0` et `LIVE_QUOTE_MINT_ALLOWLIST=WSOL` |

`EXECUTOR_ENTRY_ENVELOPE_ENABLED` n'existe pas : l'écart 2 du lot 4a a supprimé ce flag, et faire
tourner le démon tient lieu d'interrupteur.

#### `migrate.env` et `report.env`

Chacun contient seulement `DATABASE_URL` du propriétaire du schéma. Pour `report.env`, le rapport
ouvre une transaction `READ ONLY`.

### A.3 Correspondance avec `live.env` (racine du checkout principal, non suivi)

Le fichier contient 29 noms, tous avec une valeur présente. Les valeurs n'ont pas été lues.
Le fichier et `.key` sont en `0600`.

**Obsolètes : lus par aucun code actuel** (`grep` dans `src/` et `scripts/` = 0). Chacun a un
équivalent dans le nouveau schéma :

| Ancien nom | Nouvel équivalent |
|---|---|
| `LIVE_RPC_URL` | `SOLANA_HTTP_RPC_URL` des environnements exécuteur (sim, auto-arm, H2a, H2b, H2d) |
| `LIVE_ENABLE` | `LIVE_TRADING_ENABLED=true` dans `live.env` de H2b uniquement |
| `LIVE_EXPECTED_GENESIS_HASH` | `SOLANA_EXPECTED_GENESIS_HASH` |
| `LIVE_EXPECTED_WALLET` | `EXECUTOR_PUBLIC_KEY` |
| `LIVE_KEYPAIR_FILE` | `EXECUTOR_KEYPAIR_PATH` (H2b uniquement) |
| `LIVE_BUY_AMOUNT_LAMPORTS` | `envelope create --per-buy-lamports` |
| `LIVE_MAX_EXPOSURE_LAMPORTS` | `--max-exposure-lamports` (sens **cumulé** au lot 4a) |
| `LIVE_MAX_LOSS_LAMPORTS` | `--max-loss-lamports` |
| `LIVE_MAX_BUYS` | `--max-buys` |
| `LIVE_EXIT_RESERVE_LAMPORTS` | `feeReserveLamports` de la politique du catalogue |
| `LIVE_MAX_PRIORITY_FEE_LAMPORTS` | `EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS`, qui **doit valoir 0** |
| `LIVE_MAX_SLIPPAGE_BPS` | `EXECUTOR_SLIPPAGE_BPS` |
| `LIVE_MAX_SESSION_SECONDS` | `envelope prepare --valid-ms` (× 1000, de 3 600 à 86 400 s) |
| `LIVE_OPERATOR_DATABASE_URL` | `OPERATOR_API_DATABASE_URL` (console optionnelle) |
| `LIVE_OPERATOR_HTTP_RPC_URL` | `SOLANA_HTTP_RPC_URL` de la console optionnelle |
| `QUOTE_OBSERVATION_ENABLED`, `QUOTE_OBSERVATION_PATH`, `DASHBOARD_ENABLED` | aucun (supprimés) |

L'utilisateur doit comparer lui-même les valeurs `LIVE_*` (montant, perte, slippage) aux
recommandations de §B.2.

**Encore lus et réutilisables**, à recopier dans `listener.env` après vérification :
`SOLANA_HTTP_RPC_URL`, `SOLANA_WS_RPC_URL`, `SOLANA_CLUSTER`, `SOLANA_COMMITMENT`,
`SOLANA_FINALITY_COMMITMENT`, `LISTENER_ENABLED`, `POSTGRES_AUTO_MIGRATE`, `EXECUTION_MODE`,
`PAPER_STRATEGY_ENABLED`, `API_ENABLED`.

`DATABASE_URL` est présent mais sa valeur n'a pas été lue. Il faut vérifier qu'il ne vise pas
`solanabot` sur le port 5432 (bloqué à 050) ni un login propriétaire pour le listener.

**Absents et requis :**

- tous les `EXECUTOR_*` (§A.2) ;
- `LISTENER_INGESTION_SCOPE=creates-only` et `ENTRY_MODE=fast` ;
- `SOLANA_EXPECTED_GENESIS_HASH` (sous ce nom) ;
- le chemin du catalogue, les chemins des preuves et de la clé d'attestation ;
- `HELIUS_PROJECT_ID` et `HELIUS_API_KEY_PATH` ;
- l'identifiant de génération, `EXECUTOR_OPERATOR_ID` et `EXECUTOR_LIVE_RECOVERY_OWNER_ID`.

**Conclusion :** ne pas réutiliser `live.env` tel quel. Créer les fichiers de §A.2 sous `L/env/`,
puis archiver ou supprimer l'ancien `live.env` et ses deux `.bak`, qui contiennent probablement des
secrets dans le checkout.

### A.4 Base de données

- **Décision :** une **base de production PostgreSQL 16** dédiée au lot 5, avec un volume persistant,
  dans un conteneur publié sur `127.0.0.1:5433`.
  - `solanabot` (natif, 5432) est exclu : bloqué à 050, PostgreSQL < 15.
  - La base de test sur 55432 est exclue.
- **Option retenue** (simple, réutilise l'image épinglée de `deploy/compose.yaml`) : un
  conteneur `postgres:16.14-alpine3.23` séparé, nommé (par exemple `sol-lot5-pg`), avec un volume
  nommé et un port publié uniquement sur `127.0.0.1:5433`. Ses identifiants viennent d'un fichier
  `--env-file` hors Git.
  - `deploy/compose.yaml` ne publie aucun port Postgres.
  - Son service `app` se connecte en propriétaire et non en `sol_token_listener_writer`.
  - Il ne convient donc pas tel quel aux processus natifs.
- **Provisioning**, dans l'ordre (étapes B2 à B4) :
  1. migrations jusqu'à `067_fast_entry_probe_unarmable.sql`, en propriétaire ;
  2. `scripts/provision-executor-roles.sql` en administrateur, une ou deux fois. Ce script crée les
     **rôles de groupe** `NOLOGIN` mais aucun login ;
  3. création de 6 **logins** :
     `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
     chacun avec `GRANT <groupe> TO <login> WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`.
     Groupes : `sol_token_listener_writer`, `sol_token_executor_worker`,
     `sol_token_executor_readiness`, `sol_token_executor_operations`,
     `sol_token_executor_live_recovery`, `sol_token_executor_live`.
     Ajouter `sol_token_operator_reader` si la console est utilisée.
  4. Les mots de passe sont saisis par `\password`. Ils ne figurent jamais dans une commande ni
     dans l'historique du shell.

### A.5 Logins PostgreSQL à créer

| Login, nom libre (exemple) | Groupe unique | Utilisé par |
|---|---|---|
| `lot5_listener` | `sol_token_listener_writer` | listener |
| `lot5_worker` | `sol_token_executor_worker` | worker simulation-only |
| `lot5_readiness` | `sol_token_executor_readiness` | H2d |
| `lot5_operations` | `sol_token_executor_operations` | CLI opérations et auto-arm |
| `lot5_recovery` | `sol_token_executor_live_recovery` | H2a |
| `lot5_live` | `sol_token_executor_live` | H2b |

### A.6 Keypair du wallet pour H2b

Le keypair n'a pas été lu.

- Seul `L/env/live.env` porte `EXECUTOR_KEYPAIR_PATH`.
- Le chemin est absolu et normalisé.
- Le fichier doit être régulier (ni symlink ni répertoire) et appartenir à l'utilisateur qui lance
  H2b, en mode exact `0400` ou `0600`.
- Il contient le JSON `solana-keygen` : un tableau de 64 entiers (`src/executor-live/keypair-loader.ts`).
- Au démarrage, H2b vérifie que la clé publique dérivée est égale à `EXECUTOR_PUBLIC_KEY`. Il ne
  charge le signer qu'**après** avoir validé le rôle, les migrations, la génération et le genesis.
- Les autres environnements ne doivent **pas** contenir le nom `EXECUTOR_KEYPAIR_PATH`, même vide.
  Les opérations et H2a refusent sa simple présence. Le worker refuse une valeur non vide.
  Readiness refuse tout nom contenant `KEYPAIR`.
- Le fichier `.key` (`0600`) se trouve à la racine du checkout principal et n'a pas été lu.
  - S'il s'agit du keypair du wallet, le déplacer hors du dépôt, par exemple dans
    `L/keys/executor-keypair.json` en `0400`.
  - `LIVE_KEYPAIR_FILE` désigne probablement ce fichier ou un autre ; c'est à vérifier par
    l'utilisateur.
- Recommandation : un **wallet neuf, dédié au lot 5**, qui ne détient que le financement décidé
  (0,1 SOL, §B.2).

### A.7 Ce que le code exige et qui n'existe pas encore

1. **Un producteur d'intent pour le gate 10, sur base neuve : la sonde (mini-lot 5a, fait).**
   - Avec `ENTRY_MODE=fast` et `FAST_ENTRY_PROBE_ENABLED=true`, quand un create passe les
     prechecks mais qu'aucune enveloppe n'existe (`NO_ENVELOPE_CAPACITY`), le listener garde ce
     rejet, puis écrit un intent BUY `fast-entry-probe-v1` de 0,001 SOL (quote BUY réelle).
   - Au plus une sonde par intervalle (`FAST_ENTRY_PROBE_INTERVAL_MS`, 10 min par défaut), et
     seulement si aucune enveloppe n'est à l'état `ACTIVE` : vérifié en base sous verrou
     consultatif, donc aussi entre redémarrages. La sonde ne réserve aucune exposition et
     n'écrit aucune décision `BUY`. Son événement `FastEntryDecided` porte le discriminant
     `probe: true` (et `envelopeId: null`, pas de `reverseQuote`) : tout consommateur qui compte
     les décisions doit l'exclure.
   - **Jamais armable, signée ni envoyée** :
     - auto-arm ne sélectionne que `fast-entry-v1` ; `armEnvelope` et le trigger 065 l'exigent aussi ;
     - CANARY v2 n'avait **aucun** contrôle de stratégie : la migration 067 ajoute
       `CHECK (strategy_id <> 'fast-entry-probe-v1' OR live_reserved = FALSE)`. Tout armement
       (CANARY v2, v3, enveloppe) passe `live_reserved` à `TRUE`, et tout claim H2b l'exige.
       Le CHECK tient même triggers désactivés ;
     - CANARY v3 (`live:arm`) exige en plus une paire preflight et une lignée paper, absentes
       (`candidate_id` NULL : le contrôle de lignée répond `LINEAGE_INVALID`).
     - Tests : `tests/fast-entry-probe.test.ts`, un refus par chemin (enveloppe, CANARY v2,
       CANARY v3, claim H2b, CHECK tenu en `session_replication_role=replica`).
   - Le worker simulation-only la prend sans changement : son claim `EXECUTE` ne filtre pas la
     stratégie, et `prepareEnvelopeFacts` ne filtre pas non plus la stratégie de l'artefact.
     Attention : le worker dry-run la prendrait aussi ; il reste arrêté.
   - Une sonde simulée finit `SUCCEEDED` avec `purge_after` à +4 h ; une sonde jamais prise
     expire (TTL 120 s) comme tout intent fast-entry. La rétention purge la sonde **et son
     artefact** comme tout intent (testé) : avec la rétention arrêtée (§A.1), l'artefact reste
     disponible pour `prepare` pendant ses 24 h ; sinon, `prepare` et `create` doivent passer
     moins de 4 h après la simulation.
   - Le runbook (procédure lot 4a, étape 1) est corrigé dans le même lot.
2. **Le catalogue de gates** `execution-preflight-gate-catalog.v1` (JSON canonique, `0600`, hors
   Git). Il contient :
   - `strategyFingerprint` ;
   - `policy` (16 champs, entiers longs au format `{"$solTokenListenerBigInt":"…"}`) ;
   - 8 gates statiques `PASSED`, dans cet ordre :
     1. `QUALITY_GATES_PASSED` / `CI_RUN`
     2. `MIGRATIONS_VERIFIED` / `MIGRATION_TEST`
     3. `ARCHITECTURE_BOUNDARIES_VERIFIED` / `ARCHITECTURE_TEST`
     4. `DRY_RUN_RECOVERY_VERIFIED` / `DRY_RUN_TEST`
     5. `SIMULATION_MATRIX_VERIFIED` / `SIMULATION_ARTIFACT`
     6. `FAULT_MATRIX_VERIFIED` / `FAULT_TEST`
     7. `RECONCILIATION_CLEAN` / `RECONCILIATION_STATE`
     8. `STOP_CONTROLS_VERIFIED` / `STOP_CONTROL_TEST`

     Chaque gate porte `evidenceId`, `evidenceFingerprint` (64 hex), `observedAtMs ≤ maintenant`
     et `expiresAtMs ≥` l'expiration de la qualification.
   - Aucun script du dépôt ne le génère : voir l'extrait de l'étape B5.
3. **La clé d'attestation Ed25519** (PEM PKCS#8, `0600`), la **clé API Helius** en fichier et
   `HELIUS_PROJECT_ID`.
4. **Le fournisseur RPC de l'exécuteur** : décision 3, il partage le Helius du listener (§A.8).
5. **La base PG16** sur `127.0.0.1:5433` et les 6 logins (§A.4).
6. **Les 9 fichiers d'environnement** de §A.2 et le keypair hors dépôt.
7. **Les valeurs dérivées**, qui n'existent qu'après certaines étapes :
   - `EXECUTOR_WALLET_GENERATION_ID` (manifeste H2d) ;
   - `EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64` (manifeste H2e) ;
   - `EXECUTOR_BUILD_HASH` et `EXECUTOR_CONFIGURATION_FINGERPRINT` (artefact gate 10).

### A.8 Helius partagé entre listener et exécuteur (décision 3)

- H2e mesure l'usage **du projet entier** (API Admin) : la mesure de départ inclut le listener.
- Ensuite, auto-arm reporte cet usage avec les seuls compteurs de l'exécuteur
  (`EXECUTOR_COUNTERS`). Les crédits consommés par le listener après H2e ne sont **pas comptés** :
  `used_units` est sous-estimé pendant toute la fenêtre de l'enveloppe (runbook, limites lot 4a, point 2).
- Le listener est le gros consommateur : quotes BUY et SELL à chaque create, poller de curves,
  WebSocket. Le risque réel n'est pas le compteur mais l'épuisement du plan ou des 429 au moment
  d'un SELL.
- Parades :
  - `providerSafetyMarginUnits` **généreux** : au moins **deux fois** la consommation attendue du
    listener sur toute la fenêtre de l'enveloppe (2 h), mesurée sur le tableau de bord Helius
    pendant le dry-run, et en tout cas très inférieur à `limit − used` ;
  - lancer H2e juste avant `create` (B14 à B18 enchaînés), pour partir d'une mesure fraîche ;
  - surveiller les 429 (heartbeat du listener, `fast-path:report`) ; à partir de 3 réponses 429
    récentes, les entrées sont bloquées (`ENTRY_BLOCKED`) ;
  - en cas de doute, `entry-stop` : les sorties continuent.
- Donnée à relever par l'utilisateur : la limite de crédits du plan Helius et l'usage du listener
  par heure, pour fixer `providerSafetyMarginUnits` dans le catalogue (B5).

---

## B. Checklist ordonnée, de zéro au premier achat réel

**Conventions :**

- `L=/chemin/hors-git/lot5`.
- Toujours passer `DOTENV_CONFIG_PATH`. Sans lui, `dotenv` chargerait un éventuel `.env` du checkout.
- Ne jamais mettre d'URL, de login ou de secret dans une ligne de commande.
- Pour toute sortie capturée dans un fichier, appeler `node dist/...` (pas `npm run`).
- S'arrêter et auditer après chaque étape.

### B.1 Étapes

**B1. Machine et checkout.** NO-NETWORK (sauf `npm ci`, réseau vers le registre npm, pas vers mainnet).

```bash
git -C <checkout> switch main && git -C <checkout> pull --ff-only   # attendu : d223abf2 ou plus récent
cd <checkout> && npm ci && npm run build:backend
umask 077 && mkdir -p "$L"/{env,keys,evidence} && chmod 0700 "$L"
```

À vérifier :

- `git rev-parse HEAD` vaut `d223abf2…` ;
- `dist/src/executor-live/main.js` existe ;
- `"$L"` est en `0700` ;
- l'horloge est synchronisée par NTP (A26 : `requested_at ≥ valid_from` repose sur l'horloge du listener).

**B2. Base PG16 de production.** NO-NETWORK (hors téléchargement de l'image Docker).

```bash
docker run -d --name sol-lot5-pg --restart unless-stopped \
  --env-file "$L/env/postgres-container.env" \
  -v sol-lot5-pgdata:/var/lib/postgresql/data -p 127.0.0.1:5433:5432 \
  postgres:16.14-alpine3.23@sha256:42b8b8b29c8a4e933d88943e5b03001a78794905cf786e6e7634e9f2abd5a0d3
```

À vérifier : `SELECT current_setting('server_version_num')` ≥ 160000. Le port est publié sur
127.0.0.1 uniquement. Ce n'est ni le 5432 ni le 55432.

**B3. Migration jusqu'à 067.** NO-NETWORK.

```bash
DOTENV_CONFIG_PATH="$L/env/migrate.env" npm run db:migrate:compiled
```

À vérifier, avec la connexion propriétaire :

```sql
SELECT max(version) FROM migration_history;
```

Le résultat attendu est `067_fast_entry_probe_unarmable.sql`, et le nombre de versions doit être
égal au nombre de fichiers dans `migrations/`.

**B4. Provisioning des rôles et logins.** NO-NETWORK.

```bash
psql -X -v ON_ERROR_STOP=1 -f scripts/provision-executor-roles.sql   # PGSERVICE/PGPASSFILE de l'administrateur
```

Puis, en administrateur, pour chacun des 6 logins de §A.5 :

```sql
CREATE ROLE lot5_live LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT sol_token_executor_live TO lot5_live WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
\password lot5_live
```

À vérifier :

- l'inventaire RLS du runbook (« Frontières des huit environnements PostgreSQL ») rend exactement
  `5 | 1 | t` ;
- chaque login appartient à un seul groupe et ne possède aucun objet.

**B5. Catalogue de gates.** NO-NETWORK.

L'opérateur renseigne les 8 preuves : identifiant et sha256 de la CI verte de `d223abf2`, du test
de migrations, etc. Il choisit `strategyFingerprint` (64 hex) et écrit ensuite le fichier canonique
sans saut de ligne final :

```bash
node --input-type=module -e "
  import { writeFileSync } from 'node:fs';
  import { canonicalStringifyJson } from './dist/src/utils/json.js';
  const now = Date.now(), exp = now + 2 * 86_400_000;
  const g = (gateId, evidenceType, evidenceId, evidenceFingerprint) => ({ payloadVersion: 1, gateId,
    status: 'PASSED', evidenceType, evidenceId, evidenceFingerprint, observedAtMs: now, expiresAtMs: exp });
  const catalog = { schemaVersion: 'execution-preflight-gate-catalog.v1',
    strategyFingerprint: '<64-hex>',
    policy: { quoteMintAllowlist: ['So11111111111111111111111111111111111111112'],
      initialCapitalLamports: 240000000n, maximumCapitalLamports: 240000000n, positionSizeBps: 1000n,
      maximumOpenPositions: 1, maximumTotalExposureBps: 500n, drawdownPauseBps: 2500n,
      feeReserveLamports: 20000000n, walletSnapshotMaxAgeMs: 180000, providerUsageMaxAgeMs: 180000,
      providerEntryCostUnits: 16n, providerExitCostUnitsPerPosition: 16n,
      providerConfirmationCostUnitsPerPosition: 16n, providerReconciliationCostUnitsPerPosition: 16n,
      providerSafetyMarginUnits: 10000n, maximumConsecutiveTechnicalFailures: 2 },
    gates: [ g('QUALITY_GATES_PASSED','CI_RUN','<id>','<64-hex>'), g('MIGRATIONS_VERIFIED','MIGRATION_TEST','<id>','<64-hex>'),
      g('ARCHITECTURE_BOUNDARIES_VERIFIED','ARCHITECTURE_TEST','<id>','<64-hex>'), g('DRY_RUN_RECOVERY_VERIFIED','DRY_RUN_TEST','<id>','<64-hex>'),
      g('SIMULATION_MATRIX_VERIFIED','SIMULATION_ARTIFACT','<id>','<64-hex>'), g('FAULT_MATRIX_VERIFIED','FAULT_TEST','<id>','<64-hex>'),
      g('RECONCILIATION_CLEAN','RECONCILIATION_STATE','<id>','<64-hex>'), g('STOP_CONTROLS_VERIFIED','STOP_CONTROL_TEST','<id>','<64-hex>') ] };
  writeFileSync('$L/evidence/gate-catalog.json', canonicalStringifyJson(catalog), { flag: 'wx', mode: 0o600 });
"
```

À vérifier :

- le fichier est en `0600` ;
- son dernier octet n'est pas `\n` (`tail -c1 … | xxd`) ;
- `createExecutionRiskPolicy(parseJson(...).policy)` (importé de `dist/src/domain/execution-risk-policy.js`)
  ne lève pas d'erreur.

Les expirations des gates (ici 48 h) doivent couvrir la qualification. Si `prepare` intervient plus
tard, il faut régénérer le catalogue.

**B6. Clé d'attestation Ed25519.** NO-NETWORK. Utiliser la commande `generateKeyPairSync('ed25519')`
du runbook (section « Produire la preuve Helius H2e »), avec `flag: 'wx'` et `mode: 0o600`, vers
`$L/keys/provider-attestation-key.pem`.

**B7. Fournisseur (Helius partagé, décision 3).** Action web manuelle de l'utilisateur, hors du bot.

- Enregistrer la clé API Helius du listener dans `$L/keys/helius-api-key` (`0600`).
- Noter l'UUID du projet, l'endpoint RPC mainnet, la limite de crédits du plan et l'usage horaire
  du listener (§A.8).
- Choisir l'identifiant `EXECUTOR_RPC_PROVIDER_ID`, par exemple `helius`, identique dans tous les
  environnements de l'exécuteur.

**B8. Wallet et keypair.** NO-NETWORK.

- Placer le keypair dans `$L/keys/executor-keypair.json` (`chmod 0400`), propriété de l'utilisateur
  qui lance H2b.
- Renseigner `EXECUTOR_PUBLIC_KEY` dans tous les environnements exécuteur.

À vérifier : `stat -f '%Lp %u' …` donne `400` et l'uid courant.

**B9. Financement minimal du wallet.** **SENDS-TX**, transaction manuelle depuis le wallet personnel
de l'utilisateur, hors du bot.

- Transférer **0,1 SOL** (100 000 000 lamports) vers `EXECUTOR_PUBLIC_KEY`.
- Ce financement est nécessaire **avant** le gate 10 : la simulation d'un BUY échoue si le fee payer
  n'est pas financé.

À vérifier : le solde est confirmé sur un explorateur, et le wallet ne détient aucun autre token.

**B10. Écrire les fichiers d'environnement.** NO-NETWORK.

- Écrire `listener.env`, `worker-sim.env`, `provider-evidence.env`, `readiness.env` et
  `preflight-bundle.env` selon §A.2.
- Écrire aussi `operations.env`, `live-recovery.env` et `live.env`, en laissant pour l'instant
  vides les champs dérivés : génération, build hash, empreinte de configuration, clé publique
  d'attestation.
- Tout est en `chmod 0600`.

À vérifier :

- `grep -c KEYPAIR` vaut 0 partout sauf dans `live.env` ;
- `EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT` vaut 14 dans `operations.env` et `live.env`, et 8 dans
  `worker-sim.env` ;
- toutes les autres valeurs de l'empreinte de configuration (voir « Pièges ») sont identiques
  entre `worker-sim.env` et `live.env`, y compris `EXECUTOR_RPC_TIMEOUT_MS` ;
- `listener.env` contient `FAST_ENTRY_PROBE_ENABLED=true` pour B11 ;
- les 8 valeurs runtime sont identiques entre `operations.env` et `live.env`
  (`diff <(grep -E '^EXECUTOR_(QUOTE|SLIPPAGE|SNAPSHOT|MAX_|LEASE)' …)`).

**B11. Gate 10, étape 1 : sonde.** READ-ONLY-RPC.

Auto-arm, H2a, H2b et le worker dry-run restent **arrêtés**. Aucune enveloppe n'existe.

```bash
DOTENV_CONFIG_PATH="$L/env/listener.env" npm start   # FAST_ENTRY_PROBE_ENABLED=true
```

À vérifier : un log `listener.fast_entry_probe` avec `outcome: "RECORDED"`, puis

```sql
SELECT id, status, live_reserved FROM execution_intents
WHERE strategy_id='fast-entry-probe-v1' ORDER BY requested_at DESC LIMIT 3;
```

**B12. Gate 10, étape 2 : simulation.** READ-ONLY-RPC (`simulateTransaction`, rien n'est signé ni
envoyé).

```bash
DOTENV_CONFIG_PATH="$L/env/worker-sim.env" npm run executor:start   # arrêter (Ctrl-C) après 1 artefact SUCCESS
```

- Lancer le worker **en même temps** que le listener de B11 : la sonde vit 120 s, et la suivante
  attend l'intervalle (10 min par défaut).
- Une simulation `FAILED` n'est pas bloquante : attendre la sonde suivante.
- Après le premier `SUCCESS` : arrêter le worker, arrêter le listener (`SIGINT`), passer
  `FAST_ENTRY_PROBE_ENABLED=false` dans `listener.env`. La sonde reste désactivée pour toute la
  suite (dry-run compris).
- Point non vérifié en dehors du réseau : la sonde à 0,001 SOL prouve la configuration, pas un
  BUY de 0,01 SOL. Si un BUY débite le fee payer de plus de `EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT`
  (2 500 000), le premier BUY réel échouera fermé. Regarder `simulated_fee_payer_lamport_debit` de
  l'artefact en B13.

**B13. Relever les empreintes du gate 10.** NO-NETWORK. Avec la connexion propriétaire :

```sql
SELECT artifact_id, strategy_id, build_fingerprint, configuration_fingerprint,
  simulated_fee_payer_lamport_debit, recorded_at
FROM execution_simulation_artifacts
WHERE result_kind='SUCCESS'
ORDER BY recorded_at DESC
LIMIT 3;
```

- Recopier `build_fingerprint` dans `EXECUTOR_BUILD_HASH`, et `configuration_fingerprint` dans
  `EXECUTOR_CONFIGURATION_FINGERPRINT`, dans `operations.env` et `live.env`.
- Ce sont des empreintes publiques.
- À vérifier : `strategy_id = 'fast-entry-probe-v1'` et `recorded_at` a moins de 24 h. Il faut
  enchaîner B14 à B17 dans cette fenêtre.
- Le job de rétention reste arrêté : il purge l'artefact 4 h après la fin de la sonde.

**B14. H2e, preuve provider.** READ-ONLY-RPC (une lecture de l'API Admin Helius, sans retry).

```bash
DOTENV_CONFIG_PATH="$L/env/provider-evidence.env" npm run executor:provider-evidence:start
```

- Auditer le manifeste redacted.
- Recopier `evidencePublicKeyBase64` dans `readiness.env` et `operations.env`.
- Le TTL de la preuve est d'au plus 300 s : lancer B15 **immédiatement**.

**B15. H2d, génération et snapshots.** READ-ONLY-RPC (genesis, solde, comptes de tokens).

```bash
DOTENV_CONFIG_PATH="$L/env/readiness.env" npm run executor:readiness:start
```

- Le résultat attendu est `READINESS_EVIDENCE_COLLECTED`.
- Recopier `generationId` dans `EXECUTOR_WALLET_GENERATION_ID` (`operations.env`,
  `live-recovery.env`, `live.env`).
- Vérifier : `walletLamports` ≥ 100 000 000 moins le coût de la simulation (nul), et
  `tokenBalanceCount = 0`.

**B16. Préparer l'enveloppe.** NO-NETWORK (base uniquement).

```bash
( umask 077; printf '%s' "$(DOTENV_CONFIG_PATH="$L/env/operations.env" \
    node dist/src/executor-operations/main.js envelope prepare --valid-ms=7200000)" \
    > "$L/evidence/envelope-draft.json" )
```

- `printf '%s' "$(…)"` retire le `\n` final, sans quoi H2f refuse le brouillon.
- À vérifier : le fichier est non vide, en `0600`, avec `schemaVersion`
  `execution-envelope-qualification-draft.v1`.
- Un échec `ENVELOPE_FACTS_UNAVAILABLE` signifie : pas d'artefact correspondant (fournisseur,
  wallet, genesis, build hash ou empreinte de configuration différents), ou artefact de plus de 24 h.

**B17. H2f, signature hors ligne.** NO-NETWORK.

```bash
DOTENV_CONFIG_PATH="$L/env/preflight-bundle.env" npm run executor:preflight-bundle:start
```

- Faire tourner la commande moins d'une heure après B16 : H2f exige une expiration au moins une heure plus tard.
- Le répertoire de sortie doit être absent. Il est créé en `0700` et contient `qualification.json`
  et `manifest.json`.
- Faire pointer `EXECUTOR_PREFLIGHT_EVIDENCE_PATH` vers `…/qualification.json`.

**B18. Créer l'enveloppe.** NO-NETWORK. **TTY**.

```bash
DOTENV_CONFIG_PATH="$L/env/operations.env" npm run live:envelope -- create \
  --per-buy-lamports=10000000 --max-buys=5 --max-exposure-lamports=50000000 \
  --max-loss-lamports=30000000 --holding-ms=180000
```

- Vérifier la ligne `ENVELOPE_DETAILS` et l'empreinte de politique.
- Recopier la phrase `CONFIRM ENVELOPE …` dans les 60 s.
- Résultat attendu : `envelopeId` et `validUntilMs` (environ maintenant + 2 h).

**B19. Reprendre.** NO-NETWORK. **TTY**.

```bash
DOTENV_CONFIG_PATH="$L/env/operations.env" npm run live:resume
DOTENV_CONFIG_PATH="$L/env/operations.env" npm run live:status
```

Résultat attendu : `controlState: RUNNING`, `activeArmamentId: null`.

**B20. Faire le dry-run complet (partie C)** avec une enveloppe de dry-run **distincte**, avant de
créer l'enveloppe réelle. Si le dry-run est fait avant B18 et B19, rejouer ensuite B14 à B19 pour
l'enveloppe réelle. Le gate 10 reste valable s'il a moins de 24 h.

**B21. Go / no-go** (section dédiée plus bas). **Accord explicite de l'utilisateur requis.**

**B22. Démarrer H2a.** READ-ONLY-RPC (aucune signature, pas de keypair).

```bash
DOTENV_CONFIG_PATH="$L/env/live-recovery.env" npm run executor:live:recovery:start
```

À vérifier dans les logs : démarrage validé (rôle, migration 067, génération, fournisseur, genesis), puis passes à vide.

**B23. Démarrer H2b.** **SENDS-TX** à partir de ce moment, dès qu'un armement existe.

```bash
DOTENV_CONFIG_PATH="$L/env/live.env" npm run executor:live:start
```

À vérifier : démarrage validé, aucun `GENERATION_BINDING_INVALID` ni `OPEN_WORK_BINDING_INVALID`,
puis passes à vide (aucun armement).

**B24. Démarrer auto-arm.** READ-ONLY-RPC, mais c'est l'interrupteur qui rend B23 actif.

```bash
DOTENV_CONFIG_PATH="$L/env/operations.env" npm run live:auto-arm
```

Résultat attendu : ticks `IDLE NO_INTENT`. Aucun `DEFERRED CONFIG_BINDING_MISMATCH` ni
`POLICY_FRESHNESS`.

**B25. Démarrer le listener.** READ-ONLY-RPC. Le premier BUY réel suit : **SENDS-TX** via H2b.

```bash
DOTENV_CONFIG_PATH="$L/env/listener.env" npm start
```

Il tourne avec `ENTRY_MODE=fast`, `LISTENER_INGESTION_SCOPE=creates-only` et
`FAST_ENTRY_PROBE_ENABLED=false`. Le worker simulation-only et le worker dry-run sont **arrêtés**.

À vérifier : décisions `listener.fast_entry_decision`, puis tick auto-arm `ARMED`, puis BUY H2b,
puis position `OPEN`, puis sortie H2a.

**B26. Surveillance en continu.** NO-NETWORK (base uniquement).

```bash
DOTENV_CONFIG_PATH="$L/env/operations.env" npm run live:envelope -- show
DOTENV_CONFIG_PATH="$L/env/operations.env" npm run live:status
node --env-file="$L/env/report.env" dist/src/cli/fast-path-report.js --format=table
```

À surveiller :

- `buys_armed`, `realized_loss_raw`, `state` (`ACTIVE`, `EXHAUSTED`, `REVOKED`, `EXPIRED`) ;
- `controlState` ;
- dans H2a : `VENUE_UNAVAILABLE` et `executor_live_recovery.reexit_cap_reached` ;
- `unknown_block`, toute issue `AMBIGUOUS` ou `MISMATCH`, `CONTROL_STOPPED` ;
- dans auto-arm : `INSUFFICIENT_WALLET`, `PROVIDER_*` et `CONFIG_BINDING_MISMATCH` ;
- les 429 du listener (compteurs du heartbeat) et de l'exécuteur : à partir de 3 réponses 429
  récentes, les entrées sont bloquées (`ENTRY_BLOCKED`).

Durée attendue : 5 achats × (environ 3 min de détention + latence), soit environ 20 à 30 min si les
créations passent les quotes.

**B27. Kill switches**, par ordre de préférence. Tous sont NO-NETWORK.

| Commande | Effet | TTY |
|---|---|---|
| `npm run live:envelope -- revoke --envelope-id=<id>` | arrête l'armement, révoque un armement `ARMED` ; la lane `exit` vend la position ouverte | non |
| `npm run live:kill-switch -- --mode=entry-stop --reason=OPERATOR_ENTRY_STOP` | plus aucun BUY signé ; les sorties continuent | non |
| `npm run live:kill-switch -- --mode=hard-stop --reason=OPERATOR_HARD_STOP` | arrête aussi les SELL. Dernier recours : une position peut alors rester ouverte | non |

Chaque commande s'exécute avec `DOTENV_CONFIG_PATH="$L/env/operations.env"`.

Ne **jamais** arrêter H2a ni auto-arm tant qu'une position est ouverte. Auto-arm rafraîchit le
snapshot fournisseur dont le SELL a besoin.

**B28. Arrêt et nettoyage.** Les étapes 7 et 8 sont **SENDS-TX** ; les autres sont NO-NETWORK.

1. Attendre que l'enveloppe soit `EXHAUSTED` ou `EXPIRED`, ou la révoquer.
2. Attendre que `live:status` n'affiche aucun armement actif, et que les positions soient `CLOSED`.
   Vérifier :
   ```sql
   SELECT state, count(*) FROM execution_live_positions GROUP BY 1;
   ```
3. `live:kill-switch --mode=entry-stop`.
4. Arrêter le listener (`SIGINT`), puis auto-arm (`SIGINT`), puis H2b (`SIGTERM`, arrêt borné).
5. Laisser H2a finaliser jusqu'à ce que plus aucun intent ne soit non terminal, puis l'arrêter.
6. Lancer `fast-path:report` **dans les 4 h** et archiver la sortie JSON hors Git.
7. Vérifier les soldes du wallet sur un explorateur : SOL restant, aucun token résiduel.
   Un token résiduel suit la procédure manuelle du runbook (vente à la main, hors du bot).
8. Retirer le SOL restant vers le wallet personnel. Transaction manuelle de l'utilisateur, hors du
   bot.
9. Laisser le job de rétention reprendre seulement après le rapport.
10. Conserver `L/evidence`. La clé Helius est celle du listener (partagée) : ne pas la révoquer.

### B.2 Paramètres d'enveloppe et de politique : calculs

Valeurs :

- par achat P = 10 000 000 ;
- perte maximale M = 30 000 000 ;
- capital C = `initialCapitalLamports` = `maximumCapitalLamports` = 240 000 000 ;
- réserve de frais R = 20 000 000 ;
- `positionSizeBps` = 1 000 ;
- `maximumTotalExposureBps` = 500 ;
- bail = 40 000.

| Contrainte (code) | Calcul | Résultat |
|---|---|---|
| `maximumTotalExposureBps ≤ 500` (`assertPolicyAdmitsEnvelope`) | 500 | OK |
| `maximumOpenPositions = 1` | 1 | OK |
| A17 : `P × 10 000 ≤ min(max(0, C − M), C) × 500` | 1,0e11 ≤ 210 000 000 × 500 = 1,05e11 | OK, marge de 5 % (avec C = 230 000 000 du runbook, on aurait l'égalité exacte) |
| `evaluateBuyRisk` à `realizedNetPnl = −M`, plafond de position | capital après réserve = 210 M − 20 M = 190 M ; × 10 % = 19 000 000 ≥ P | OK |
| idem, plafond d'exposition | 210 M × 5 % = 10 500 000 ≥ P | OK |
| drawdown (aucune position ouverte) | 0 < 2 500 | OK |
| exposition à la soumission du BUY, au départ | 240 M × 5 % = 12 000 000 ≥ P | OK |
| exposition cumulée (`(buys+1) × P ≤ maxExposure`) | 5 × P = 50 000 000 | 5 achats possibles |
| `maxExposure ≥ P`, `feeReserve ≤ maxCapital`, `initial ≤ maximum` | | OK |
| fraîcheur ≥ `2×bail + 30 000` | 180 000 ≥ 110 000 | OK (rafraîchissement fournisseur toutes les 90 s environ) |
| `providerUsageMaxAgeMs` entre 30 000 et 900 000, `walletSnapshotMaxAgeMs` ≤ 900 000 | 180 000 | OK |
| holding entre 30 000 et 900 000, et ≤ 300 000 au lot 5 | 180 000 | OK |
| fenêtre ≥ holding + 900 000 | 7 200 000 ≥ 1 080 000 | OK. On ne peut plus armer après `valid_until − 18 min`, soit environ 1 h 42 d'armement possible |
| `prepare --valid-ms` entre 3 600 000 et 86 400 000, et H2f exige une expiration ≥ maintenant + 1 h | 7 200 000 | OK si H2f tourne moins d'une heure après `prepare` |
| seuil wallet d'auto-arm : `P + R` | 30 000 000 | `INSUFFICIENT_WALLET` en dessous |

- **`initialCapitalLamports` est un paramètre du modèle de risque.** Il n'est pas comparé au solde
  réel : `wallet_lamports` est stocké mais n'entre pas dans `evaluateBuyRisk`. Les vraies bornes
  sont le solde du wallet et les plafonds de l'enveloppe.
- **Perte maximale théorique.**
  - Avant le dernier armement, la perte cumulée reste sous 30 000 000 (sinon `LOSS_CAP`).
  - La dernière position peut perdre au plus P, plus les débits fee payer : BUY ≤ 2 500 000,
    puis SELL et jusqu'à 3 re-sorties à ≤ 2 500 000 chacune.
  - Soit environ 30 + 10 + 2,5 + 10 = **52,5 M lamports (≈ 0,053 SOL)**.
- **Financement de 0,1 SOL.** Il couvre la simulation du gate 10, la perte maximale, et garde le
  seuil d'auto-arm de 30 000 000 atteignable après environ 30 M de pertes.
- **Coûts fournisseur.** `providerSafetyMarginUnits = 10 000` n'est qu'un exemple : voir §A.8. La
  marge doit rester très inférieure à `limit − used`. Les quatre coûts par position valent 16, soit
  `EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT` ou plus.
- Montants **décidés** par l'utilisateur (décision 4) : 5 × 0,01 SOL, exposition 0,05 SOL, perte
  0,03 SOL, holding 180 s, wallet 0,1 SOL.
- **Coûts fournisseur avec le Helius partagé** : `providerSafetyMarginUnits` suit §A.8 (au moins
  deux fois l'usage du listener sur la fenêtre), pas la valeur d'exemple `10000`.

---

## C. Dry-run sans envoi

### C.1 Ce que le code offre

- **Il n'existe aucun mode « no-send » dans H2b.**
  - `src/executor-live/` n'a aucun flag dry-run, simulation ou sans soumission.
  - Une fois démarré avec un armement et `controlState=RUNNING`, H2b signe et envoie.
- Les deux modes non signants existants (`EXECUTOR_MODE=dry-run` et `simulation-only`) sont ceux du
  worker H2j. Ils ne chargent jamais de clé et ne prennent jamais un intent `live_reserved=true`.
- Le dry-run de bout en bout consiste donc à faire tourner **toute la chaîne jusqu'à l'armement
  inclus, avec H2b arrêté.** H2b est le seul processus qui détient le keypair : sans lui, aucune
  transaction ne peut partir.

### C.2 Procédure

Prérequis : B1 à B17 réalisés (gate 10 produit par la sonde, sonde désactivée).

Créer une **enveloppe de dry-run** dédiée : un armement non acheté consomme un `buys_armed`
(limite 5 du lot 4a). Pour cela, refaire B16 et B17 (nouveau `prepare`, nouvelle signature H2f),
puis :

| # | Commande | Ce qui est vérifié | Étiquette |
|---|---|---|---|
| D1 | `live:envelope -- create --per-buy-lamports=10000000 --max-buys=2 --max-exposure-lamports=20000000 --max-loss-lamports=30000000 --holding-ms=180000` | TTY, phrase, politique, A17, âge du gate 10, liaison de la qualification | NO-NETWORK, **TTY** |
| D2 | `live:resume` puis `live:status` | passage en `RUNNING`, qualification `ENVELOPE` la plus récente | NO-NETWORK, **TTY** |
| D3 | Démarrer H2a (B22) | validateur de démarrage H2a : grants (dont SELECT sur `domain_events`), migration 067, génération, genesis ; passes à vide | READ-ONLY-RPC |
| D4 | **Ne pas démarrer H2b.** Vérifier qu'aucun processus H2b ne tourne (`pgrep -f executor-live/main.js` vide) | aucun processus ne détient la clé | NO-NETWORK |
| D5 | Démarrer auto-arm (B24) | parse de la configuration (contraintes de bail), genesis, rôle operations, ticks `IDLE NO_INTENT`, aucun `CONFIG_BINDING_MISMATCH` | READ-ONLY-RPC |
| D6 | Démarrer le listener (B25) | `creates-only`, quotes fast-entry à chaque create, `entry_decisions` BUY/REJECTED, intents `fast-entry-v1` | READ-ONLY-RPC |
| D7 | Logs auto-arm, puis requête SQL ci-dessous | tick `ARMED` : wallet observé, report du snapshot fournisseur, admission risque, triggers 065, réservation | NO-NETWORK |
| D8 | Comparer les colonnes runtime de l'armement avec les valeurs de `live.env` | les 8 valeurs runtime sont identiques, sinon H2b ne prendrait jamais l'intent | NO-NETWORK |
| D9 | Attendre l'expiration de l'armement (environ 2 min, celle de l'intent), puis le second `ARMED` ; l'enveloppe passe `EXHAUSTED` | transitions `ACTIVE_ARMAMENT` → expiration → réarmement → `CAPACITY` | NO-NETWORK |
| D10 | `live:envelope -- revoke --envelope-id=<id>` (lancé plus tôt, pendant un armement `ARMED`) | `armamentRevoked: true`, état `REVOKED` | NO-NETWORK |
| D11 | `live:kill-switch --mode=entry-stop`, puis `live:status` | `ENTRY_STOP` | NO-NETWORK |
| D12 | `fast-path:report --format=json` | entonnoir créations → décisions → intents → armés (soumis = 0), latences create → décision → armement, 429 | NO-NETWORK |
| D13 | Arrêter le listener, auto-arm et H2a | arrêt propre (`SIGINT`/`SIGTERM`) | NO-NETWORK |
| D14 (optionnel) | Fumée de démarrage H2b sous `ENTRY_STOP`, voir C.3 | validateur de démarrage H2b, chargement du keypair, correspondance de la clé publique | READ-ONLY-RPC (keypair chargé) |

Requête de D7 :

```sql
SELECT state, envelope_id, runtime_quote_max_age_ms, runtime_slippage_bps,
  runtime_snapshot_max_slot_lag, runtime_max_compute_units, runtime_max_fee_lamports,
  runtime_max_fee_payer_lamport_debit, runtime_max_rpc_calls_per_attempt, runtime_lease_ms
FROM execution_activation_armaments
ORDER BY armed_at DESC
LIMIT 1;
```

Ces 8 colonnes `runtime_*` (migration 039) doivent être égales aux valeurs de `live.env`.

Ensuite, pour le run réel : nouvelle enveloppe, en refaisant B14 à B19.

### C.3 Fumée de démarrage H2b (D14, optionnelle)

Elle n'est sûre que si **toutes** ces conditions sont vraies, vérifiées juste avant :

- `controlState = ENTRY_STOP` (ou `HARD_STOP`) ;
- aucune enveloppe `ACTIVE` ;
- aucun armement `ARMED` ou `LOCKED` ;
- aucune position non `CLOSED` ;
- auto-arm arrêté.

Dans ces conditions, la lane BUY exige `RUNNING` et refuse avec `CONTROL_STOPPED`
(`execution-live.repository.ts`). Aucune lane SELL n'a de travail.

Lancer B23, attendre la validation de démarrage et une passe à vide, puis `SIGTERM`.

Cette étape prouve la configuration de H2b et le keypair. Elle reste la plus sensible du dry-run :
c'est à l'utilisateur de décider s'il la fait.

### C.4 Ce que le dry-run prouve

- Les fichiers d'environnement passent les parseurs (sauf H2b, sauf à faire D14), ainsi que les
  contraintes de bail et de fraîcheur.
- Les rôles et grants sont corrects sur la base de production : listener, worker, readiness,
  operations, recovery.
- La chaîne H2e → H2d → `prepare` → H2f → `create` → `resume` fonctionne avec le vrai catalogue et
  la vraie politique.
- Les décisions d'entrée rapide se forment sur le vrai flux, avec la latence create → décision → armement.
- La charge RPC du listener tient avec une enveloppe active (quotes à chaque create, poller de curves),
  ou non (429). Avec le Helius partagé, c'est aussi la mesure de l'usage horaire pour §A.8.
- L'armement auto-arm de bout en bout fonctionne : RPC wallet, report fournisseur, admission,
  triggers 065, compteurs d'enveloppe, `EXHAUSTED`.
- `revoke` et `entry-stop` fonctionnent, ainsi que le rapport.
- Avec D14 : la liaison de démarrage de H2b (génération, build, configuration, stratégie,
  fournisseur, migration 067) et le keypair.

### C.5 Ce qu'il ne prouve pas

- La construction, la signature et la soumission réelles d'un BUY ou d'un SELL.
- La simulation signée, la preuve de blockhash, `maxRetries=0`, la classification `AMBIGUOUS`.
- L'égalité de l'empreinte de configuration recalculée par H2b (`maxRpcCalls − 6`) avec celle du gate 10.
  - Seule la règle « valeurs identiques, simulation = H2b − 6 » la garantit.
  - Un écart fait échouer le premier BUY en fermé (aucun envoi), mais consomme un `buys_armed`.
- La confirmation, la réconciliation, l'écriture du ledger et la `realized_loss`.
- La lane `exit` sur une vraie position : créateur, take-profit, acheteurs externes, échéance,
  `VENUE_UNAVAILABLE` après migration, re-sortie.
- Le rafraîchissement du snapshot fournisseur pendant une position : il n'a lieu qu'avec un BUY
  `LOCKED` réussi.
- La rentabilité, et la justesse des quotes face au suffixe `TradeEvent` opaque (#232).

---

## Go / no-go avant toute étape SENDS-TX

Tous les points doivent être vrais avant B23 (et avant B9 pour ceux qui concernent le wallet) :

1. [ ] Accord explicite de l'utilisateur pour le lot 5, avec les montants décidés (§B.2).
0. [ ] Le correctif du bloquant 5 (branche `fix/build-hash-per-transaction`, testé) est mergé
   dans `main` et déployé ; sinon H2b refuse chaque BUY fast-entry en consommant un `buys_armed`.
2. [ ] La base de production est en PG16 (`127.0.0.1:5433`), migrée à 067, avec les rôles
   reprovisionnés **après** 067 (inventaire RLS `5 | 1 | t`) et 6 logins mono-rôle.
3. [ ] Aucune position n'est `MISMATCH` (sur un SELL antérieur à 4b), `UNKNOWN` ou `EXIT_PENDING`,
   et `unknown_block = false` (base neuve : trivialement vrai).
4. [ ] Le dry-run C est passé en entier : au moins un `ARMED`, `revoke` vérifié, rapport lisible.
   Aucun `CONFIG_BINDING_MISMATCH`, `POLICY_FRESHNESS` ni 429 persistant.
5. [ ] Les 8 valeurs runtime sont identiques entre `operations.env` et `live.env`. Le worker de
   simulation utilise la valeur H2b − 6, et toutes ses autres valeurs sont identiques à H2b.
6. [ ] La preuve H2e du Helius partagé est fraîche (B14 et B15 enchaînés) et
   `providerSafetyMarginUnits` couvre au moins deux fois l'usage du listener sur la fenêtre (§A.8).
7. [ ] Le keypair est hors dépôt, en `0400`, sa clé publique est égale à `EXECUTOR_PUBLIC_KEY`, et
   le wallet est neuf et dédié.
8. [ ] Le wallet est financé à 0,1 SOL au plus, sans autre token.
9. [ ] L'enveloppe réelle est `ACTIVE`, avec `valid_until` à plus d'une heure, `holding ≤ 300 000`,
   `controlState = RUNNING`, et aucun armement actif.
10. [ ] Le worker simulation-only, le worker dry-run et la rétention sont arrêtés. Le listener
    tourne avec `FAST_ENTRY_PROBE_ENABLED=false`.
11. [ ] L'opérateur est présent pendant toute la durée du run, avec les commandes de kill switch
    prêtes (B27) et la procédure manuelle de vente du runbook relue.
12. [ ] Le créneau est choisi pour pouvoir lancer `fast-path:report` dans les 4 h.

---

## Questions ouvertes (réponses de l'utilisateur requises)

Tranché le 2026-10-07 : sonde de gate 10, base PG16 sur `127.0.0.1:5433`, Helius partagé,
montants (voir « Décisions de l'utilisateur » en tête). Reste :

1. **Machine du run** : le poste de l'opérateur ou un serveur ? Le run demande un TTY pour `create`
   et `resume`, la présence de l'opérateur, une horloge NTP et une connexion stable.
2. **Fichier `.key`** à la racine du checkout : est-ce le keypair du wallet (neuf et dédié) ? Où le
   ranger hors du dépôt (`$L/keys/executor-keypair.json` en `0400` proposé) ?
3. **`live.env` et ses deux `.bak`** à la racine du checkout : peut-on les archiver hors dépôt ou
   les supprimer une fois les nouveaux fichiers écrits ?
4. **Politique de sortie** : garder les défauts `EXIT_*` (take-profit 2×, 10 acheteurs externes
   ≥ 0,001 SOL) ?
5. **Fumée de démarrage H2b (D14)** : la faire avant le run réel ?
6. **Les 8 preuves statiques du catalogue** : quels artefacts concrets (identifiant de run CI, tests)
   l'utilisateur accepte-t-il comme preuve ?
