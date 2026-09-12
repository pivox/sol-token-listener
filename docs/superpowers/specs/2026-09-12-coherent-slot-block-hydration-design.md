# Source cohérente d'hydratation par slot

Version : 1.0.0 — 2026-09-12 — issue #110.

## But et statut

Cette spécification introduit une source alternative, `TransactionBlockRpc`,
et son consommateur explicite, `SolanaBlockTransactionLocator`. Ils permettent
de reconstruire une transaction et son `transactionIndex` depuis une seule
réponse `getBlock` complète. Cette source est **non activée** : la factory de
production conserve `SolanaTransactionLocator`, qui appelle actuellement
`getTransaction` puis `getBlockSignatures`.

Aucun cache, admission, throttle, changement de persistance, wallet, signature
ou envoi de transaction ne fait partie de cette étape.

## Contrat RPC

`SolanaRpcClient.getBlockTransactions(slot, confirmationStatus)` vérifie que
le slot est un `bigint` non négatif représentable exactement avant tout appel,
puis utilise exclusivement le SDK web3 officiel avec :

```ts
getBlock(slot, {
  commitment,
  transactionDetails: 'full',
  maxSupportedTransactionVersion: 0,
  rewards: false,
})
```

La réponse complète contient aussi les transactions non Pump.fun et les votes.
La position de la transaction dont la signature primaire égale la notification
est le `transactionIndex` canonique. La réponse sélectionnée est adaptée au
format déjà consommé par `normalizeTransaction`; les règles existantes sur les
transactions legacy, v0, lookups, inner instructions, soldes Token-2022 et
finalité sont donc conservées.

## Validation et erreurs

Avant normalisation, le locator contrôle sans appeler d'accesseur : enveloppe
réponse, `blockhash` et `previousBlockhash` base58 canoniques de 32 octets,
`parentSlot` strictement inférieur au slot demandé (sauf slot zéro, pour lequel
la convention est `parentSlot = 0`), `blockTime`, tableau dense borné à
`MAX_BLOCK_SIGNATURE_COUNT`, entrées data-only et signatures primaires uniques.
Chaque transaction, y compris une transaction non ciblée examinée pour sa
signature primaire, accepte au plus `MAX_TRANSACTION_SIGNATURES` (32)
signatures : aucune entrée hostile ne peut contourner cette borne avant la
recherche de l'index.

La transaction sélectionnée n'est jamais transmise brute au normaliseur. Ses
signatures, son header, ses instructions compilées (ou les instructions legacy
converties), et chaque champ `meta` consommé sont lus par des descripteurs de
données et copiés dans une nouvelle réponse. Les clés statiques et de lookup
sont dérivées des champs data-only `_bn` de `PublicKey`, puis projetées dans un
objet de clés local minimal ; ni `toBytes`, ni `toBase58`, ni
`getAccountKeys` du graphe RPC ne sont lus ou appelés. Les proxys sont rejetés
avant toute inspection de type dépendante de leur prototype. Un `Uint8Array`
est identifié par l'intrinsèque Node `isUint8Array`, puis copié par le chemin
interne du constructeur `Uint8Array` : ni itérateur, ni `Symbol.iterator`, ni
constructeur ou prototype du fournisseur ne sont consultés. Un accessor ou
une forme incompatible dans un champ consommé de la transaction sélectionnée
devient
`TransactionNormalizationError` sans être exécuté.

Les données base58 des instructions legacy sont refusées au-delà de 1 700
octets encodés ou 1 232 octets décodés, avant toute copie supplémentaire. Les
objets JSON copiés ont un prototype nul et conservent donc `__proto__` comme
propriété propre ordinaire. La valeur `version` doit aussi correspondre à la
forme du message : `legacy`/absente exige `accountKeys`, et `0` exige
`staticAccountKeys` avec ses lookups explicites.

- réponse `null` ou structure invalide : `BlockUnavailableError`, retryable ;
- rejet RPC : `RpcTransientError`, retryable ;
- signature absente ou dupliquée : `TransactionIndexNotFoundError`, terminal ;
- transaction sélectionnée non normalisable :
  `TransactionNormalizationError`, terminal.

`meta` est obligatoirement `null` ou un objet et `version` est absente,
`legacy` ou `0`, conformément à `maxSupportedTransactionVersion: 0`. Ces
champs appartiennent à la transaction sélectionnée : une valeur incompatible
ou un descripteur accessor est une erreur de normalisation, tandis qu'une
enveloppe de bloc invalide reste une indisponibilité retryable.

Les erreurs gardent le contrat fermé existant : aucun texte, URL, cause ou
payload fournisseur n'est incorporé à l'erreur exposée.

Une signature primaire illisible ou hors borne fait partie de l'enveloppe de
bloc et produit donc `BlockUnavailableError`, même si l'entrée correspondait
autrement à la signature cible. Les métadonnées et champs sélectionnés qui ne
peuvent pas être projetés proprement restent à la frontière
`TransactionNormalizationError`.

## Suite planifiée, hors de cette PR

Une PR ultérieure décidera, après mesure réelle, si la source devient active et
avec quelle politique de cache courte et bornée par `(slot, commitment)`. Un
cache de seules signatures ne suffit pas au flux H2i : il économise l'appel
`getBlockSignatures`, mais conserve un `getTransaction` par notification. Un
cache de blocs complets doit rester séparé car il pose des limites mémoire,
taille de réponse, reorg `confirmed`, provider/failover et quota pondéré.

Les scans stricts de catch-up et la réconciliation de finalité restent
indépendants et continuent d'utiliser leurs sources provider-affines.

La source applique des bornes de structures en mémoire, mais ne peut pas
imposer une limite HTTP inférieure à celle du transport web3/RPC : la taille
brute d'un `getBlock` complet, les crédits pondérés et le comportement de
failover doivent être mesurés avant toute activation.
