# Bootstrap de readiness externe — conception #51-H2d

**Version de spécification :** 1.0.11

**Version de la spécification parente :** 1.11.13

**Date :** 2026-09-05

**Statut :** APPROUVÉE — préparation non signable du préflight

**Issue parente :** #51

**Dépendance :** #51-H2c fusionnée par la PR #79 (`d966c267`)

## Historique des versions

- **1.0.11 — 2026-09-05 :** référence H2g comme consommateur offline des
  identités H2d via l'export canonique H2h à venir.

- **1.0.10 — 2026-09-05 :** référence H2f comme consommateur strict du
  manifeste redacted et des snapshots H2d, sans élargir l'autorité readiness.

- **1.0.9 — 2026-09-05 :** aligne H2e sur la marge transactionnelle H2d de
  cinq secondes avant le commit readiness.

- **1.0.8 — 2026-09-05 :** référence la procédure portable Node.js 22 de
  génération de la clé d'attestation externe H2e.

- **1.0.7 — 2026-09-05 :** exige une preuve H2e encore fraîche après écriture
  avant de démarrer la collecte H2d.

- **1.0.6 — 2026-09-05 :** référence le producteur Helius H2e comme source
  externe de l'enveloppe Ed25519, sans élargir le processus H2d.

- **1.0.5 — 2026-09-05 :** ferme les deux constats du troisième cycle de
  revue : zéro autorité directe du login et zéro privilège de table effectif,
  y compris via `PUBLIC`.

- **1.0.4 — 2026-09-05 :** ferme les trois constats du deuxième cycle de
  revue : privilèges effectifs hérités de `PUBLIC`, fraîcheur au commit selon
  l'horloge PostgreSQL et positions actives recherchées sur toutes les
  générations du wallet.

- **1.0.3 — 2026-09-05 :** ferme les quatre constats du premier cycle de
  revue : ACL exactes par tuple, expiration revérifiée après la collecte,
  corps RPC borné pendant le streaming et block time attaché au slot retenu.

- **1.0.2 — 2026-09-05 :** précise la fermeture des enveloppes JSON-RPC et
  des trois preuves imbriquées avant toute connexion PostgreSQL.

- **1.0.1 — 2026-09-05 :** aligne la supersession sur la contrainte de
  rétention existante : `superseded_at` et son `purge_after` exact à quatre
  heures sont les deux seules colonnes mutables des snapshots.

- **1.0.0 — 2026-09-05 :** définit le processus one-shot non signable qui
  enregistre la génération wallet, collecte un snapshot wallet finalisé,
  importe un snapshot quota fournisseur attesté et exporte le manifeste
  canonique nécessaire au préflight H2c.

## 1. Problème constaté

H2c sait vérifier une qualification et un sidecar signés, réserver
l'exposition puis armer une intention BUY exacte. Les données publiques qui
alimentent ces preuves ont cependant seulement des repositories : aucun chemin
de production n'appelle `registerWalletGeneration`, `appendWalletSnapshot` ou
`appendProviderUsage`.

Créer ces lignes à la main en SQL rendrait le canary non reproductible,
contournerait les constructeurs canoniques et empêcherait d'attribuer les
preuves à une collecte versionnée. H2d ferme uniquement cette lacune. Son état
final reste :

```text
READINESS_EVIDENCE_COLLECTED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```

## 2. Approches évaluées

| Approche | Décision | Motif |
| --- | --- | --- |
| Insérer génération et snapshots avec un compte administrateur et du SQL manuel | Rejetée | Bypass des validateurs, procédure non rejouable et autorité excessive. |
| Ajouter les lectures RPC au processus `executor-operations` | Rejetée | Mélange collecte réseau et décision opérateur, et élargit l'autorité H2c. |
| Nouveau processus one-shot `executor-readiness` avec rôle DB fermé | Retenue | Produit les seules projections publiques manquantes sans signer, armer ou lire les artefacts live. |
| Service SaaS ou daemon permanent de preuves | Reportée | Inutile pour le premier canary et ajoute disponibilité, credentials et rétention. |

## 3. Périmètre

### 3.1 Inclus

- commande one-shot `npm run executor:readiness:start` ;
- configuration dédiée, fermée et sans variable de secret wallet ;
- vérification Mainnet du genesis attendu avant toute écriture ;
- génération wallet V1 déterministe et rejouable ;
- snapshot wallet `finalized` construit depuis des réponses RPC bornées ;
- comptage borné des comptes SPL Token et Token-2022 ;
- vérification d'absence de position live ouverte divergente ;
- enveloppe Ed25519 de quota fournisseur produite hors processus ;
- snapshot fournisseur canonique `AUTHORITATIVE_PROBE` ou
  `OPERATOR_REPORT`, frais et unités exprimés en entiers ;
- rôle PostgreSQL `sol_token_executor_readiness` et validation de son autorité
  effective à chaque checkout ;
- manifeste JSON canonique `execution-readiness-bootstrap.v1`, redacted et
  écrit sur stdout ;
- tests unitaires, intégration PostgreSQL 16, contrats RPC, architecture,
  rétention et smoke.

### 3.2 Exclus

- lecture, conversion ou copie du fichier wallet réel ;
- clé privée Solana ou clé privée Ed25519 d'attestation ;
- signature Solana, construction de transaction, simulation ou soumission ;
- création d'intention, qualification à onze gates, `live:resume`,
  `live:arm`, démarrage H2a/H2b ou financement ;
- apprentissage automatique du genesis depuis le même endpoint ;
- conversion fiat, oracle de prix, USDT live ou augmentation de plafond ;
- promotion automatique vers `MICRO_LIVE` ou `PILOT` ;
- route HTTP publique et daemon permanent.

## 4. Identité de génération

Le CLI reçoit `EXECUTOR_WALLET_GENERATION_NUMBER`, entier canonique compris
entre 1 et 2 147 483 647. Il calcule :

```text
generationId = "execution_wallet_generation_" + sha256LengthPrefixed(
  "execution-wallet-generation-v1",
  walletPublicKey,
  cluster,
  genesisHash,
  generationNumber
)
```

Pour le premier canary, le numéro vaut `1`. Le même tuple rejoue la même ligne.
Une ligne portant le même identifiant avec un contenu différent, une génération
retirée ou une autre génération active pour le même wallet/cluster est refusée.
H2d ne retire et ne remplace jamais une génération automatiquement.

Le CLI affiche l'identifiant calculé mais n'accepte pas un identifiant fourni
par l'opérateur. Les configurations H2a, H2b et opérations doivent ensuite
réutiliser exactement cet identifiant.

## 5. Collecte wallet finalisée

Le transport RPC H2d possède uniquement :

- `getGenesisHash` ;
- `getSlot` avec commitment `finalized` ;
- `getBlockTime` pour le slot retenu ;
- `getBalance` du wallet au même commitment ;
- `getTokenAccountsByOwner` pour SPL Token puis Token-2022.

Chaque appel possède un timeout, une réponse maximale et un schéma fermé. La
limite est appliquée pendant la lecture du flux HTTP, même sans
`Content-Length`, et non après sa matérialisation en mémoire.
L'enveloppe de réponse contient exactement `jsonrpc`, l'identifiant numérique
égal à celui de la requête, et `result` ; tout champ supplémentaire, erreur ou
identifiant divergent est refusé. Le genesis renvoyé doit égaler
`SOLANA_EXPECTED_GENESIS_HASH`, préalablement
approuvé par l'opérateur. Le snapshot est rejeté si les slots de contexte des
lectures financières divergent de plus de
`EXECUTOR_READINESS_MAX_SLOT_LAG`, entier borné à 0–8.

Le snapshot contient uniquement des entiers et les données publiques déjà
définies par `ExecutionWalletSnapshotV1` : lamports, nombre total de comptes
token, zéro position initiale et PnL réalisé nul pour une nouvelle génération.
Un wallet avec une position live durable, un état de risque inconnu ou un
snapshot plus récent divergent ferme la collecte. Un solde non nul est rendu
visible dans le manifeste comme chaîne décimale ; il ne constitue pas une
autorisation de dépense.

La collecte ne télécharge pas l'historique du wallet et ne déduit pas qu'un
wallet est sûr de son seul solde.

Le slot persisté est le plus haut slot cohérent des lectures financières et
`blockTime` est demandé pour ce même slot. Il n'est jamais repris du slot de
départ lorsque les réponses ont avancé dans la tolérance autorisée.

## 6. Preuve de quota fournisseur

Le quota contractuel ne peut pas être appris de Solana. H2d lit donc
`EXECUTOR_PROVIDER_EVIDENCE_PATH`, chemin absolu hors Git vers une enveloppe
Ed25519 V1 signée par la même autorité publique que H2c. Le payload canonique
contient exactement les champs d'entrée de `ProviderUsageSnapshotV1` :

- provider, plan et période de facturation ;
- début et fin de période ;
- unités maximales et utilisées ;
- date de mesure et expiration ;
- provenance `AUTHORITATIVE_PROBE` ou `OPERATOR_REPORT`.

La durée de validité ne dépasse pas cinq minutes pour
`OPERATOR_REPORT` et quinze minutes pour `AUTHORITATIVE_PROBE`. Le provider doit
égaler `EXECUTOR_RPC_PROVIDER_ID`, la mesure ne peut être future et les unités
sont des `bigint` décimaux non négatifs. La signature est vérifiée avant toute
écriture. L'horloge est relue après les appels réseau et avant cette
vérification ; une preuve expirée pendant la collecte est refusée. H2d ne
contient aucun générateur de cette enveloppe et n'accepte pas
un JSON non signé.

Le repository refuse également tout champ supplémentaire dans la génération,
le snapshot wallet ou le snapshot provider avant d'ouvrir une connexion. Il
conserve le comportement existant : rejeu exact idempotent,
supersession du snapshot précédent sous verrou provider et conflit sur toute
divergence.

Juste avant le commit, le repository relit l'horloge PostgreSQL et exige encore
au moins cinq secondes de validité sur la preuve provider. Une attente de pool,
de verrou ou de transaction qui consomme cette marge annule tout le commit.

## 7. Manifeste de sortie

Après commit atomique de la génération et des deux snapshots, stdout contient
exactement un objet canonique :

```json
{
  "schemaVersion": "execution-readiness-bootstrap.v1",
  "state": "READINESS_EVIDENCE_COLLECTED",
  "generationId": "execution_wallet_generation_<sha256>",
  "walletPublicKey": "<base58 public>",
  "cluster": "mainnet-beta",
  "providerId": "primary",
  "walletSnapshotId": "execution_wallet_snapshot_<sha256>",
  "walletSnapshotFingerprint": "<sha256>",
  "providerSnapshotId": "execution_provider_usage_<sha256>",
  "providerSnapshotFingerprint": "<sha256>",
  "walletLamports": "<u64 decimal>",
  "tokenBalanceCount": 0,
  "observedAtMs": 0,
  "expiresAtMs": 0,
  "canaryStatus": "CANARY_NOT_STARTED",
  "paperMainnet49Status": "NON_EXECUTED_NON_VALIDATED"
}
```

Les dates réelles remplacent les zéros de l'exemple. Le rapport ne contient ni
URL, hôte, credential, chemin, contenu d'attestation, erreur brute, signature
de transaction, balance token détaillée ou clé privée. Une erreur écrit
uniquement `EXECUTION_READINESS_FAILED` sur stderr et retourne un code non nul.

Le manifeste fournit les identités exactes que le producteur externe utilise
ensuite pour les gates `WALLET_CHAIN_LIMITS_VERIFIED` et
`PROVIDER_EXIT_CAPACITY_VERIFIED`. Il n'est lui-même ni une qualification ni un
sidecar canary signé.

## 8. Autorité PostgreSQL

Le provisioning ajoute `sol_token_executor_readiness`, rôle de groupe
`NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS`. Un login de déploiement PostgreSQL 16 :

- est membre uniquement de ce rôle avec `ADMIN FALSE, INHERIT FALSE, SET TRUE` ;
- ne possède aucun objet, rôle parent, default ACL ou privilège direct ;
- reçoit l'usage du schéma public et les séquences strictement requises ;
- lit seulement l'historique des migrations, la génération ciblée, l'état de
  risque courant, les positions ouvertes et les snapshots publics ciblés ;
- insère uniquement génération, état risque initial, snapshots wallet et
  provider ;
- met uniquement `superseded_at` et le `purge_after` exact à quatre heures sur
  l'ancien snapshot wallet/provider sous les verrous existants.

Il ne peut lire ou modifier aucune intention, qualification, autorisation,
armement, lock pré-signature, bytes signés, preuve de soumission ou contrôle
opérateur. Listener, API, opérations, H2a et H2b ne gagnent aucune autorité H2d.

Chaque checkout force `SET ROLE sol_token_executor_readiness`,
`search_path=pg_catalog,public` et `session_replication_role=origin`, puis
revalide PostgreSQL 16, le membership exact, la migration 039 et l'allowlist
effective complète.

L'allowlist de colonnes est comparée tuple par tuple (`grantee`, `table`,
`colonne`, `privilège`) dans un ordre canonique. Les droits accordés à
`PUBLIC` sont inclus dans l'observation effective. Une dérive qui révoque un
droit autorisé et ajoute un droit sensible avec la même cardinalité est donc
refusée.

Le login de déploiement ne doit posséder aucun objet, ACL direct, default ACL
ou privilège de paramètre. Après `SET ROLE`, aucun privilège de table complet
(`DELETE`, `TRUNCATE`, etc.) n'est accepté pour le rôle ou `PUBLIC` : tous les
droits utiles H2d restent exclusivement des grants de colonnes énumérés.

## 9. Atomicité, reprise et rétention

Une exécution utilise une transaction unique après la collecte réseau :

1. verrou génération ;
2. validation ou insertion de la génération ;
3. vérification qu'aucune génération du même wallet ne porte une position
   `OPEN`, `EXIT_PENDING` ou `UNKNOWN` ;
4. validation ou insertion du snapshot wallet ;
5. verrou provider ;
6. validation/supersession puis insertion du snapshot provider ;
7. contrôle de fraîcheur sur l'horloge PostgreSQL ;
8. commit ;
9. rendu du manifeste depuis les objets commités.

Un crash avant commit ne laisse aucune projection partielle. Un replay exact
retourne les mêmes identifiants. Une collecte différente crée de nouveaux
snapshots canoniques et ne modifie jamais les anciennes preuves. Les snapshots
superseded et devenus inutiles suivent la rétention existante de quatre heures.
Les générations actives et les preuves référencées par un état non terminal ne
sont jamais purgées.

## 10. Configuration

Le processus accepte seulement les paramètres publics ou credentials
infrastructure déjà nécessaires :

```dotenv
DATABASE_URL=postgresql://<login-readiness-dedie>:...@<postgres16>/<database>
SOLANA_CLUSTER=mainnet-beta
SOLANA_HTTP_RPC_URL=https://<endpoint-mainnet-qualifie>
SOLANA_EXPECTED_GENESIS_HASH=<genesis-mainnet-approuve>
EXECUTOR_RPC_PROVIDER_ID=primary
EXECUTOR_PUBLIC_KEY=<adresse-publique>
EXECUTOR_WALLET_GENERATION_NUMBER=1
EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64=<cle-publique-spki-der-base64>
EXECUTOR_PROVIDER_EVIDENCE_PATH=/chemin/hors-git/provider-evidence.json
EXECUTOR_READINESS_MAX_SLOT_LAG=8
EXECUTOR_RPC_TIMEOUT_MS=5000
```

La présence de toute variable connue de keypair, secret wallet, phrase de
récupération ou activation live invalide la configuration, même si sa valeur
est vide. Le processus exige `mainnet-beta`, mais ne reçoit ni
`LIVE_TRADING_ENABLED=true` ni `EXECUTOR_MODE=live`.

## 11. Tests et critères d'acceptation

- identifiant de génération déterministe, rejouable et sensible à chaque
  champ causal ;
- RPC borné, genesis divergent, timeout, 429, corps excessif et schéma inconnu
  refusés avec erreurs typées ;
- réponses wallet finalisées et lag de slots revalidés ;
- SPL Token et Token-2022 comptés sans float ;
- attestation provider absente, altérée, expirée ou liée à un autre provider
  refusée avant écriture ;
- commit atomique, replay exact et crash sans état partiel ;
- rôle PostgreSQL 16 exact et absence d'accès live/signed ;
- graphes source et `dist` sans keypair, signer, construction, simulation,
  `sendTransaction` ou import H2a/H2b ;
- migration/provisioning depuis base vide et replay ;
- sortie JSON canonique, bornée et redacted ;
- build, check, lint, tests, docs, frontend E2E et smoke verts ;
- aucun endpoint réel, secret ou wallet privé dans Git, test ou CI ;
- aucun `live:resume`, `live:arm` ou canary déclenché par la PR.

## 12. Suite après H2d

L'opérateur exécute H2d avec l'environnement Mainnet qualifié et conserve le
manifeste. Le producteur d'attestation externe lie ensuite ces identités aux
onze gates H2c et au sidecar de l'unique intention BUY paper. Le dernier
checkpoint humain reste obligatoire avant toute conversion temporaire du
wallet au format H2b, chargement du signer, `live:resume` ou armement.
