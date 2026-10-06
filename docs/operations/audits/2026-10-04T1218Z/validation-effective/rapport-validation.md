# Validation effective — preuves RPC et recorder de quotes

Date : 2026-10-04. Ce rapport poursuit [fiabilisation-mesures.md](../fiabilisation-mesures.md) sans le remplacer. Les preuves RPC brutes et le rapprochement précédent restent intacts.

## Résultats

| Point | Résultat | Preuve et impact |
|---|---|---|
| Collecte des 12 BUY/SELL | **TENTÉE, NON EXPLOITABLE** | 20 tentatives réseau pour 12 signatures uniques ; 0 réponse HTTP/RPC, 0 transaction avec métadonnées utilisables. Les 20 lignes sont conservées dans [`transactions.v1.jsonl`](../historical-rpc-ready/transactions.v1.jsonl). |
| Cause réseau | **NON DÉTERMINABLE** | Les lignes ne conservent que `NETWORK_ERROR`, sans code de cause, statut HTTP, corps ou réponse RPC. Il n’est pas possible d’affirmer que le fournisseur a refusé la requête plutôt qu’une restriction ou une panne de transport. Aucune seconde voie réseau n’a été essayée. |
| Rapprochement on-chain | **INCOMPLET** | Le calcul a été relancé depuis les réponses réellement conservées : 12 signatures tentées, 0 métadonnée exploitable ; frais, deltas, token balances, fee payer, reliquats et cycle ATA restent `null`. Voir [`session-reconciliation.md`](../reconciliation-rpc-final/session-reconciliation.md) et [`signature-ledger.v1.jsonl`](../reconciliation-rpc-final/signature-ledger.v1.jsonl). |
| Trésorerie locale | **REPRODUITE, NON RAPPROCHÉE PAR RPC** | −17 922 159 lamports d’après les bornes locales déjà documentées. Les 12 signatures ne permettent pas d’expliquer ce delta sans leurs métadonnées ni l’historique complet du wallet. |
| +9 083 040 lamports d’ATA | **NON JUSTIFIÉS PAR COMPTE** | La valeur reste une hypothèse agrégée, sans montant confirmé pour aucun des six comptes. Le résultat −8 839 119 lamports demeure conditionnel à cet ajustement, aux flux externes supposés nuls et aux reliquats supposés nuls. Le −1,0726 USDT n’est donc pas confirmé par cette passe. |
| Producteur → recorder | **BRANCHÉ ET VALIDÉ HORS LIGNE** | `ValidatedExternalBuysStrategy` transmet le contexte de sortie au `CanonicalPaperQuoteRouter`; celui-ci choisit le provider Pump.fun ou PumpSwap, valide la vraie quote, puis appelle le recorder sans attendre son écriture. Le test complet produit et relit un enregistrement JSONL. |
| Essai réseau en observation seule | **NON EXÉCUTÉ** | Le runtime de production n’est pas un harnais isolé : sa factory construit RPC, catch-up, souscription, workers paper/social et lecteur de venue Postgres. Aucun lanceur réseau dédié, borné à des mints choisis et sans ces composants, n’existait dans le dépôt. Aucun runtime de production n’a été lancé. L’intégration locale prouve le chemin de quote et d’écriture avec un lecteur en mémoire, pas une observation mainnet. |

## Collecte réellement effectuée

Commande exécutée :

```sh
SOLANA_HTTP_RPC_URL=https://api.mainnet.solana.com node --import tsx scripts/collect-transaction-evidence.ts \
  --source docs/operations/evidence/2026-10-04-mainnet-microtrade-r8 \
  --out docs/operations/audits/2026-10-04T1218Z/historical-rpc-ready \
  --roles BUY,SELL --expected-signatures 12 --budget-rpc-requests 20 \
  --retries 1 --commitment finalized --max-supported-version 0
```

Le collecteur a fait 12 premières tentatives, puis consommé le budget restant par 8 nouvelles tentatives séquentielles. Il n’a utilisé que `getTransaction`, `encoding=jsonParsed`, `commitment=finalized` et `maxSupportedTransactionVersion=0`. Aucun batch, aucune concurrence, aucune lecture de compte, aucune clé ni wallet n’a été chargé. La limite demandée autorise les transactions legacy et version 0 ; le code résout les `loadedAddresses` de version 0. Aucune réponse n’étant arrivée, aucune version réelle n’a pu être constatée.

Résultat terminal enregistré : `signatureCount=12`, `rpcRequests=20`, `rpcBudget=20`, `retriesUsed=8`, `haltedReason=null`, `RPC_ERROR=12`. Le fichier brut contient 20 événements de tentative, 12 signatures distinctes, 20 statuts `RPC_ERROR`, 20 catégories `NETWORK_ERROR`, aucun statut HTTP, aucune réponse et aucun `Retry-After`. Les causes détaillées ne figurent pas dans ces événements historiques ; le code actuel conserve le code de transport sûr lorsqu’il est disponible et s’arrête sur un refus explicite.

**Défaut de mesure constaté dans cette collecte :** le champ `attempt` vaut `1` sur les 20 lignes, y compris les 8 nouvelles tentatives. Le nombre physique d’événements par signature montre 8 signatures à deux lignes et 4 à une ligne, mais l’ordinal enregistré n’est pas fiable. Il ne change pas le plafond réseau observé. Le code a été ajusté pour accepter un ordinal de départ et un test vérifie ce chemin ; les preuves déjà écrites n’ont pas été retouchées. Les événements stockent l’heure de fin de tentative, pas l’heure de démarrage HTTP ; l’espacement exact des débuts de requête n’est donc pas recalculable depuis l’archive seule.

Rapprochement exécuté hors ligne :

```sh
node --import tsx scripts/report-transaction-evidence.ts \
  --source docs/operations/evidence/2026-10-04-mainnet-microtrade-r8 \
  --transactions docs/operations/audits/2026-10-04T1218Z/historical-rpc-ready/transactions.v1.jsonl \
  --out docs/operations/audits/2026-10-04T1218Z/reconciliation-rpc-final
```

La commande a produit 12 lignes de ledger signature avec `RPC_ERROR` et 0 transaction exploitable. Le compteur « 0 candidat de transfert externe » de ce rapport signifie seulement qu’aucune réponse collectée n’en montre ; la couverture du wallet reste explicitement incomplète. Les 12 signatures ne prouvent pas l’absence d’autres transferts, tentatives facturées ou mouvements de comptes.

## Contrôle des six ATA

Les adresses sont celles dérivées et consignées dans le rapprochement hors ligne avec le programme Token-2022. La colonne `montant attribuable sur +9 083 040` reste `INCONNU` pour chaque compte : aucune ligne ne répartit artificiellement le total.

| Mint / vague | ATA suivie | BUY source | SELL source | Montant attribuable | Préexistence / financement / remboursement / immobilisation | Autorité et destination |
|---|---|---|---|---:|---|---|
| HKEZKN… / 1 | `8UmaYwrHcmjBn1xzmaLRjxVRHYZqwcrWybRJEKqM3JYE` | `43zoVkSwd749ja5iTzvty93DV9cKbyBVTZw3Rc1FhCuNp95DxhGGQKuuUd4EWcxNS78a6GaDwkbCqhMdrTtTNR99` | `Xs5QUTAfpS5XVz6WxNyTUBjaPi64VESt9nhGEAbZvxEQ9tJMbtBqckB6RXdDgPLpXiSmwfWtN6FWo3xHpM2AURM` | INCONNU | INCONNU | INCONNU |
| Bvh9xj… / 2 | `5iPwwccgYqoeBHk3MnnFVDsTjjUmZAaaCN7RejN1QvRo` | `5vN5Q8LvGRdf4jRJJGmz8xEWxkLoQBzCcAJkzuMQJ4myqnRumehZJfzXkCxz4x1Ga1Q9RNw4wRxZsaUi82vCiGc8` | `4WSJSSj55gWA8bikD9wjuZEpaWjtDRzDCsPCk5LPi7Fkr9FnMx6FjedtCVumEqU7rnVe9SvqhMbxZSMTqWZMMTDB` | INCONNU | INCONNU | INCONNU |
| 3bqjGQ… / 3 | `GdtyZRokXvaR8Lx82r12SDtCXyPgCUJ9EcKEufSK9LzB` | `4xHtQLMx9WpaVXsRDBHMhtcoauFiqvG2ZjGfvxGsWhjYLNNcWsMrbTnoZMfa9M7PzCafPwofJ9uUx1M9atm1K1Bp` | `2eNr8uRteftEb7oorecw3RwvsSTDzLhmCYxSfrnznoSRXsgVAjUwubtFpGjQJc8cmSmXf5hUoix2ZAd8SpNbrz4h` | INCONNU | INCONNU | INCONNU |
| 2Uc6S4… / 4 | `HXa6WT2ezrddpLyo1FDr965WCSWC4P7ytoB1aRbRcWQq` | `2WjRhYkTSUFL64msgwiqu6jaTDqLciGD8ndAoaMC8qUCNAuop46uscnRbBKCj6PXWBisyesfQLnqTPhpsAokykGc` | `3ntQh5YwLWTSMkM1LEy1gD2F5rfEbHGMfaMVc6nLTq4Br9qzCbp1MKfKNP1BonvvRNgUFQmdLajF2HMcXJcaCRk3` | INCONNU | INCONNU | INCONNU |
| BQgvrX… / 7 | `hkWVomAdPmPkqvb6DX4wZkibtii4eJ411Zwid2765Vi` | `5iRpc16DexuYPwSKLwEXdw65x2tRJo7q1Cwp31pDTzsDosYPmvtptPyQZdCEb8VzYojT68AJ5KY8mcUWW4aR94up` | `4gWkjZvjgmCwvY6yQwFTyBtAEwpy4bbcnDvPL6JxEGuzb1nNfQ2DHmifvqsDzENXNqwKh7E7wqzW41HhMSAe6tg8` | INCONNU | INCONNU | INCONNU |
| Cbq36x… / 8 | `7i3sGjE4cPFGj1ean2EfVRmCeFa2YDkVd3szLjMww1WV` | `3TVpSP47WK4ZEZaaKUvW8D69AMXnifLjXXHaiZtd8xX6TgXAAHdQXzBbWavutNEqkyqAnaf95usYJk6XQnFo6UvJ` | `4CQmUtKmD8qHwdwkeM2LdaWVUhaErUUpeX9SkKRXm324gRVeDcaumPQquHLneTNS55RopKxhUZDP5CyfasRUaL7g` | INCONNU | INCONNU | INCONNU |

Pour les six comptes, le résultat RPC est `RPC_ERROR/RPC_ERROR`; aucun pré-balance, post-balance, owner, close authority, instruction de fermeture, destinataire ou solde token historique n’est disponible. Le montant encore immobilisé à la fin de la session et un remboursement déjà encaissé restent indiscernables. Les nombres nuls ne sont pas substitués aux champs absents.

## Branchement des mesures de quote

Chemin exact de sortie paper :

```text
ValidatedExternalBuysStrategy.reconcile()
  → PaperQuoteRouter.quote(SELL + session/position/trade + decisionAtMs)
  → CanonicalPaperQuoteRouter
      → PumpFunPaperQuoteProvider (courbe active)
      → PumpSwapMarketAdapter.quote (courbe complète + pool canonique)
  → validation âge/slot/mints/montant
  → buildRuntimeQuoteObservationRow()
  → QuoteObservationRecorder.record() sans await
  → createQuoteObservationFileSink() append JSONL
```

Le recorder est créé dans la factory du runtime, mais désactivé par défaut par `QUOTE_OBSERVATION_ENABLED=false` implicite. Son chemin par défaut est `data/quote-observations.v1.jsonl`; aucun `.env`, exemple d’environnement ou réglage actif n’a été modifié. Le fichier est append-only, créé en mode privé, et les erreurs/pertes sont comptées puis signalées au logger sans propager d’erreur dans la stratégie. Les frais programme Pump.fun/PumpSwap sont déjà dans la sortie de quote et ne sont pas retranchés une seconde fois. Le PnL net est `null`, car une quote runtime papier ne fournit pas le coût économique rapproché de la position.

Les providers inscrivent le temps de réception après le retour des lectures RPC, le slot, le temps de calcul, la quantité entière et les montants bruts/minimum. Le routeur inscrit aussi l’instant de disponibilité et la décision qui a demandé la quote. Si le calcul est postérieur à `decisionAtMs`, la ligne indique `availableAtDecision=false` et `QUOTE_CALCULATED_AFTER_DECISION`, même si le slot est ancien et la quote courante. Si timing ou slot manquent, sa validité est `UNKNOWN`. Cette passe ne crée aucun polling périodique : les quotes produites hors d’une demande SELL contextualisée ne sont pas enregistrées en observations de position.

Test d’intégration exécuté :

```sh
node --import tsx --test tests/runtime-quote-recorder.integration.test.ts
```

Il utilise le vrai `PumpFunPaperQuoteProvider`, un état SDK encodé et contrôlé, le vrai `CanonicalPaperQuoteRouter`, un sink JSONL temporaire puis une relecture JSON. Résultat : **1 quote calculée et enregistrée**, `validity=VALID`, slot `123`, quantité simulée `10000`, frais marqués déjà inclus, PnL net `null`, disponibilité à la décision `false` puisque calculée après l’heure de décision de fixture ; `writeErrors=0`, `dropped=0`. Le test instancie uniquement un lecteur en mémoire et ne charge pas de signer; cet adaptateur n’a aucune méthode d’envoi et le test vérifie qu’aucun chemin `sendTransaction`/`signTransaction` n’est présent.

Ce test est un contrôle d’intégration **hors ligne**, pas une observation mainnet, pas un replay historique, et pas une mesure de performance.

## Tests et fichiers

Commande de tests ciblés exécutée après neutralisation explicite de dotenv :

```sh
DOTENV_CONFIG_PATH=/dev/null node --import tsx --test \
  tests/runtime-quote-recorder.integration.test.ts \
  tests/pumpfun-paper-quote.provider.test.ts tests/paper-quote-router.test.ts \
  tests/validated-external-buys.strategy.test.ts tests/config-safety.test.ts \
  tests/causal-quote.test.ts tests/transaction-evidence.test.ts \
  tests/pumpswap-reserve-reader.test.ts
```

Résultat final : **65 réussis, 0 échoué**. Les contrôles `./node_modules/.bin/tsc -p tsconfig.json --noEmit` et ESLint sur les fichiers ciblés réussissent. Aucun test connecté au trading n’a été lancé.

**Écart de périmètre à signaler :** lors du tout premier lancement des tests ciblés, `tests/config-safety.test.ts` a été exécuté sans neutraliser son import `dotenv/config`. Ce hook peut charger les variables d’un `.env` présent dans le processus de test. Aucun contenu de variable ni secret n’a été affiché ou écrit par cette commande, et l’existence d’un `.env` n’a pas été vérifiée. La nouvelle exécution de tests utilise `DOTENV_CONFIG_PATH=/dev/null`.

Fichiers ajoutés ou ciblés par ce chantier :

- [`src/telemetry/quote-observation-file.ts`](../../../../../src/telemetry/quote-observation-file.ts)
- [`tests/helpers/pumpfun-paper-quote-state.ts`](../../../../../tests/helpers/pumpfun-paper-quote-state.ts)
- [`tests/runtime-quote-recorder.integration.test.ts`](../../../../../tests/runtime-quote-recorder.integration.test.ts)
- [`validation-effective/rapport-validation.md`](./rapport-validation.md)

Le câblage minimal touche aussi `src/ports/paper-quote-router.ts`, `src/domain/paper-trading.ts`, `src/domain/market.ts`, `src/paper/paper-quote-router.ts`, les providers Pump.fun/PumpSwap, le lecteur des frais PumpSwap, `src/application/validated-external-buys.strategy.ts`, `src/application/production-listener-factory.ts` et `src/config/env.ts`. Les preuves antérieures, leurs rapports et la configuration active n’ont pas été modifiés par cette passe.

## État final

- **Confirmé par les archives locales :** les 12 signatures attendues, reliées aux six positions et aux six ATA suivies ; le delta local de trésorerie −17 922 159 lamports.
- **Nouvelle observation RPC :** 20 tentatives enregistrées, zéro réponse ; elle n’améliore pas la certitude comptable.
- **Toujours estimé :** +9 083 040 lamports ATA, −8 839 119 lamports économiques, −1,0726 USDT.
- **Validation technique :** le vrai calculateur de quote Pump.fun passe le routeur runtime et alimente effectivement le recorder puis le JSONL en test isolé.
- **Pas validé :** lecture mainnet, marché PumpSwap via test de bout en bout, sampling temporel périodique, performance et rentabilité. Pas de correction de stratégie proposée dans ce chantier.

La prochaine mesure minimale est une collecte RPC depuis un environnement autorisé qui expose explicitement son accès en lecture et son quota, puis le rapprochement complet des 12 signatures. Pour une collecte temporelle mainnet, il faut en plus un harnais séparé qui accepte une liste courte de mints choisis, utilise uniquement `getAccountInfo/getMultipleAccounts`, contrôle le temps, le nombre de requêtes et le débit, et n’importe aucun signer ni runtime de trading.
