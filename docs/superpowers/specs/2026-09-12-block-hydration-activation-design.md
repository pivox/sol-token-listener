# Activation de l’hydratation bloc

Version : 1.0.0 — 2026-09-12 — issue #114.

## Décision

L’activation est un choix de démarrage, désactivé par défaut. La valeur exacte
`LISTENER_BLOCK_HYDRATION_ENABLED=true` sélectionne
`CachedSolanaBlockTransactionLocator`; toute exécution normale conserve
`SolanaTransactionLocator`. Le processus ne relit pas ce flag. Le rollback est
`false` suivi d’un redémarrage. Une instance active ne lance jamais le locator
legacy en secours, afin de ne pas doubler silencieusement la consommation RPC.
Il n’existe aucun double appel ni fallback legacy.

Le caller production est le worker inbox V1, dont la chaîne `runTail` impose
une concurrence de locator égale à 1. Le lease guard reste acquis et renouvelé
avant toute hydratation. Cette PR n’ajoute ni migration, wallet, signer,
transaction, armement, ni appel Mainnet automatisé.

## Configuration

| Variable | Défaut | Bornes inclusives |
| --- | ---: | ---: |
| `LISTENER_BLOCK_HYDRATION_MAX_ENTRIES` | 64 | 1–256 |
| `LISTENER_BLOCK_HYDRATION_MAX_BYTES` | 67 108 864 | 1–268 435 456 |
| `LISTENER_BLOCK_HYDRATION_MAX_ENTRY_BYTES` | 8 388 608 | 1–67 108 864 |
| `LISTENER_BLOCK_HYDRATION_CONFIRMED_TTL_MS` | 10 000 | 1 000–60 000 |
| `LISTENER_BLOCK_HYDRATION_FINALIZED_TTL_MS` | 60 000 | 1 000–300 000 |
| `LISTENER_BLOCK_HYDRATION_FETCH_INTERVAL_MS` | 250 | 250–60 000 |

Les entiers sont décimaux canoniques. La taille par entrée ne dépasse jamais
la taille totale et le TTL finalized ne précède jamais le TTL confirmed. Toutes
les contraintes sont vérifiées même lorsque le flag est `false`.

## Métriques V1

Chaque heartbeat écrit dans le JSONB existant un objet
`blockHydration.version=1`. Il expose `enabled`, `callerConcurrency=1`, les
compteurs `locates`, `hits`, `misses`, `inFlightJoins`, `fetches`,
`forcedRefreshes`, `evictions`, `oversizeBypasses`, `fetchFailures` et
`epochInvalidations`; les jauges `retainedEntries`, `retainedBytes`,
`inFlightFetches`, `queuedFetches`; et `queueDelayMs.last/maximum`.

Les valeurs sont des entiers sûrs non négatifs et saturent à la limite sûre JS.
Le snapshot et son sous-objet sont gelés. L’API projette un ancien payload ou
un objet inconnu en `null` sans rendre tout le health indisponible. Aucun champ
ne peut contenir slot, signature, endpoint, credential ou contenu de bloc.

## Exploitation

La procédure canary normative est
[`block-hydration-canary.md`](../../operations/block-hydration-canary.md).
L’activation n’est pas un gate de trading et ne modifie pas les modes
`observe`/`paper`.
