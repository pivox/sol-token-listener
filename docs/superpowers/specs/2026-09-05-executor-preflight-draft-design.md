# Construction offline du draft préflight — conception #51-H2g

**Version de spécification :** 1.0.0

**Version de la spécification parente :** 1.11.13

**Date :** 2026-09-05

**Statut :** APPROUVÉE — assemblage offline non signant

**Issue parente :** #51

**Dépendance :** #51-H2f fusionnée par la PR #82 (`e97724e`)

## 1. Objectif et découpage

H2f sait valider et signer un draft complet. H2g assemble ce draft depuis deux
artefacts canoniques protégés : un export des lignes persistées et un catalogue
de huit preuves statiques. Il vérifie toutes les liaisons et dérive uniquement
les trois gates ancrés par snapshots/simulation.

La lecture PostgreSQL et son rôle strictement read-only sont volontairement
isolés dans la PR suivante H2h. H2g n'accepte pas `DATABASE_URL` et ne prétend
pas que son fichier source a été collecté automatiquement.

L'état final reste :

```text
PREFLIGHT_DRAFT_ASSEMBLED
CANARY_NOT_STARTED
NON_EXECUTED / NON_VALIDATED
```

## 2. Frontière de sécurité

- aucune base, RPC, clé Ed25519/Solana, listener, signature, opération live ou
  soumission ;
- entrées et sortie owner-only, extérieures au checkout et sans symlink ;
- trois chemins distincts, sortie absente et écriture atomique `0600` ;
- erreur unique redacted, sans contenu, path, URL ou preuve dans stderr ;
- H2g ne crée aucune intention et ne change aucun état durable.

## 3. Entrées versionnées

La configuration dédiée contient exactement :

```dotenv
EXECUTOR_PREFLIGHT_SOURCE_PATH=/chemin/hors-git/source.json
EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH=/chemin/hors-git/gates.json
EXECUTOR_PREFLIGHT_DRAFT_PATH=/chemin/hors-git/draft.json
```

`execution-preflight-draft-source.v1` contient le manifeste H2d, la génération
complète avec son numéro permettant de recalculer son ID déterministe,
les snapshots complets, l'intention BUY complète avec son identité recalculable
et son absence exacte de lease, et l'artefact de simulation déjà lus
à une même photographie PostgreSQL, plus l'horloge de cette photographie.
H2h produira cet export ; avant H2h, une saisie manuelle ne vaut pas preuve.

`execution-preflight-gate-catalog.v1` contient exactement le fingerprint de
stratégie, les champs de policy et huit preuves `PASSED` ordonnées : quality,
migrations, architecture, dry-run, simulation matrix, fault matrix,
réconciliation et stop controls. H2g ne synthétise aucun de ces artefacts.

Les JSON sont canoniques, bornés à 1 MiB et utilisent le marqueur `bigint`
versionné du projet.

## 4. Liaisons et fraîcheur

H2g reconstruit snapshots, policy, qualification et sidecar avec les domaines
existants. Il exige :

- génération, wallet, provider, genesis et manifeste H2d exacts ;
- intention `BUY/PENDING`, WSOL/SPL/9, tentative zéro, non louée et fraîche ;
- artefact `SUCCESS` lié à la même intention/révision/décision/stratégie,
  au même wallet/provider/genesis, âgé d'au plus 30 secondes ;
- huit gates externes dans l'ordre et couvrant les cinq minutes de qualification ;
- snapshots dans les deadlines dérivées de la policy avec cinq secondes de marge.

Les gates provider et wallet réutilisent les IDs/fingerprints H2d. Le gate
Mainnet utilise `createMainnetSimulationEvidenceFingerprint`. Le sidecar expire
au plus tôt entre qualification, provider, policy wallet/provider et intention.

## 5. Sortie

La commande écrit sans overwrite un `execution-preflight-bundle-draft.v1`
canonique en `0600`, puis affiche seulement un manifeste redacted : IDs et
fingerprints publics, dates, `PREFLIGHT_DRAFT_ASSEMBLED`,
`CANARY_NOT_STARTED`, `NON_EXECUTED_NON_VALIDATED` et
`liveCapabilityPresent=false`.

## 6. Critères d'acceptation

- catalogue fermé à huit preuves statiques exactes ;
- gates dynamiques impossibles à substituer ;
- source/simulation/target/snapshots liés et frais ;
- draft directement accepté par H2f ;
- fichier atomique owner-only sans overwrite ;
- architecture sans DB, RPC, keypair, signer, live ou mutation ;
- build/check/lint/tests/docs verts, trois cycles de revue maximum.
