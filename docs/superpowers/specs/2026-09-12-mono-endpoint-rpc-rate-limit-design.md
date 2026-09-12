# Politique RPC mono-endpoint sans retry 429 caché

Date : 2026-09-12

Issue : #106

Version : 1.0.1
Statut : implémentée

## Objectif

Un appel RPC logique adressé au provider HTTP principal doit produire une seule tentative fetch déclenchée par web3.js lorsque le provider répond HTTP `429`.
`disableRetryOnRateLimit: true` garantit qu’aucun retry 429 web3.js n’est ajouté.
La réponse est alors rendue immédiatement au listener, afin que sa reprise
explicite reste la seule source de nouvelles tentatives. Le comportement
standard de `fetch`, notamment ses éventuels redirects, n’est pas modifié.

## Périmètre

Le changement porte uniquement sur la configuration de la connexion HTTP
principale créée par `SolanaRpcClient` :

```ts
{
  commitment,
  wsEndpoint,
  disableRetryOnRateLimit: true,
}
```

Lorsque `httpRpcFallbackUrls` est vide, cette configuration conserve
`commitment` et `wsEndpoint`, n'injecte aucun `fetch` custom et désactive le
retry interne de `@solana/web3.js` pour les réponses HTTP `429`.

Le chemin multi-endpoint reste inchangé : il injecte le transport de failover
HTTP existant, conserve ses endpoints positionnels et configure déjà
`disableRetryOnRateLimit: true`. Le transport, ses limites, son refroidissement,
ses événements et sa sélection de fallback ne sont pas modifiés par cette
spécification.

## Contrat d'exécution

- Un `429` du principal mono-endpoint est retourné par `Connection` après une
  seule tentative fetch déclenchée par web3.js, sans retry 429 web3.js.
- Aucune attente, temporisation ou retry 429 web3.js supplémentaire n'est ajouté
  dans le chemin mono-endpoint.
- La reprise éventuelle relève uniquement des mécanismes explicites déjà
  présents dans le listener.
- Le WebSocket, son endpoint et sa gestion de reconnexion restent inchangés.
- Les erreurs HTTP autres que le comportement existant de web3.js restent
  hors du périmètre de cette modification.

## Tests et preuve

Le test de configuration mono-endpoint vérifie exactement les trois propriétés
publiques (`commitment`, `wsEndpoint`, `disableRetryOnRateLimit`) et confirme
qu'un `fetch`, une horloge ou un sink d'événements injectés sont ignorés quand
aucun fallback n'est configuré. Les tests multi-endpoint existants continuent
de vérifier le transport partagé et la rotation `429` vers le fallback.

La couverture ne modifie aucune admission, aucun quota, aucun décodeur, aucune
taxonomie de pipeline et aucune frontière wallet, signature ou soumission.

## Historique

- 1.0.1 — 2026-09-12 : précise qu’il s’agit d’une seule tentative fetch
  déclenchée par web3.js, sans promettre le nombre de requêtes réseau d’un
  éventuel redirect.
- 1.0.0 — 2026-09-12 : désactivation du retry HTTP `429` caché en
  mono-endpoint.
