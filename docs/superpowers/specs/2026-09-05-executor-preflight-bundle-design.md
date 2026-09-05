# Paquet d'attestations du préflight canary — conception #51-H2f

**Version de spécification :** 1.0.2

**Version de la spécification parente :** 1.11.12

**Date :** 2026-09-05

**Statut :** APPROUVÉE — producteur hors ligne non signable Solana

**Issue parente :** #51

**Dépendances :** #51-H2c, #51-H2d et #51-H2e

## Historique des versions

- **1.0.2 — 2026-09-05 :** ferme les trois constats du dernier cycle de revue :
  fraîcheur dérivée de la policy, rollback après échec du `fsync` parent et
  refus explicite des credentials Helius dans l'environnement H2f.

- **1.0.1 — 2026-09-05 :** exige au packaging que qualification, sidecar et
  snapshots ne soient ni futurs ni à moins de cinq secondes de leur expiration.
- **1.0.0 — 2026-09-05 :** définit le producteur hors ligne atomique des deux
  enveloppes H2c.

## 1. Objectif

H2c vérifie deux enveloppes Ed25519 mais ne fournit volontairement pas leur
producteur. H2f ferme uniquement ce manque opérationnel. Une commande one-shot
valide un draft externe strict, reconstruit les objets de domaine, signe la
qualification à onze gates et le sidecar lié à une intention BUY exacte, puis
publie les deux enveloppes et un manifeste redacted dans un répertoire créé de
façon atomique.

H2f ne collecte aucune preuve, ne transforme aucun test en gate `PASSED`, ne
crée aucune intention et ne décide pas qu'un canary est sûr. Le signataire
externe reste responsable de fournir des artefacts authentiques et auditables.

L'état final de la commande est :

```text
PREFLIGHT_EVIDENCE_PACKAGED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```

## 2. Frontière de sécurité

Le processus H2f :

- n'importe aucun module listener, RPC, PostgreSQL, executor-live ou wallet ;
- refuse toute variable d'environnement RPC, base, live, keypair ou secret
  Solana ;
- accepte seulement une clé privée Ed25519 d'attestation dédiée, jamais une
  clé Solana ;
- ne possède ni commande `preflight`, `resume`, `arm`, ni transport réseau ;
- n'écrit jamais dans le checkout ;
- ne journalise ni clé, contenu signé, chemin protégé ou preuve détaillée.

La présence d'un paquet H2f n'autorise aucune dépense. Les arrêts
transactionnels et l'armement TTY H2c restent obligatoires.

## 3. Entrée versionnée

Le fichier protégé `execution-preflight-bundle-draft.v1` contient exactement :

- le manifeste redacted H2d complet ;
- les champs d'entrée d'une `ExecutionSafetyQualificationV1`, avec les onze
  gates ordonnés et déjà justifiés par leurs artefacts ;
- l'intention BUY exacte ciblée par son identifiant déterministe ;
- les champs d'entrée de la policy V1 ;
- les champs d'entrée complets des snapshots wallet et provider persistés par
  H2d ;
- les dates de capture et d'expiration du sidecar.

Les `bigint` utilisent le format JSON interne versionné
`{"$solTokenListenerBigInt":"<entier>"}`. Le draft est borné à 1 MiB et lu
depuis un fichier régulier owner-only `0400` ou `0600`, sans suivre de symlink.

Le producteur reconstruit tous les identifiants et fingerprints. Le manifeste
H2d doit correspondre exactement à la qualification et aux deux snapshots :
génération, wallet public, cluster, provider, identifiants, fingerprints,
solde, nombre de comptes token, observation et expiration. Une divergence
ferme la commande.

## 4. Signature et publication atomique

La clé d'attestation est un PKCS#8 Ed25519 owner-only. La commande signe les
payloads JSON canoniques que les vérificateurs H2c existants consomment déjà.
Elle vérifie immédiatement les deux signatures avec la clé publique dérivée.

Le répertoire de sortie ne doit pas exister. Les trois fichiers sont d'abord
écrits en mode `0600` dans un répertoire temporaire sibling en mode `0700`,
avec `fsync`, puis le répertoire est renommé atomiquement :

```text
qualification.json
canary.json
manifest.json
```

Le manifeste contient uniquement les versions, identifiants, fingerprints,
dates, cible publique et statuts non exécutés. Il ne contient ni payload,
signature, chemin, endpoint, credential, balance détaillée ou clé.

## 5. Configuration fermée

La commande utilise exactement les variables propres à H2f :

```dotenv
EXECUTOR_PREFLIGHT_DRAFT_PATH=/chemin/hors-git/draft.json
EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH=/chemin/hors-git/evidence-key.pem
EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY=/chemin/hors-git/bundle-unique
```

Les chemins doivent être absolus, normalisés, distincts et extérieurs au
checkout, y compris après résolution des parents. Le répertoire final doit
être absent afin qu'aucun paquet audité ne puisse être remplacé silencieusement.

## 6. Critères d'acceptation

- les constructeurs de domaine existants sont les seules sources des IDs et
  fingerprints ;
- les mismatches H2d, gates, snapshots, intention ou dates échouent fermés ;
- les deux enveloppes sont canoniques, signées et auto-vérifiées ;
- publication atomique, permissions `0700/0600`, zéro overwrite ;
- manifeste redacted et statuts `CANARY_NOT_STARTED` /
  `NON_EXECUTED_NON_VALIDATED` ;
- tests d'architecture prouvant l'absence de capacité Solana, réseau, base et
  armement ;
- build, check, lint, tests et documentation verts.
