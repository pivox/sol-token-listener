# Qualification RPC Solana

Cette procédure qualifie un endpoint Solana HTTP/WebSocket dédié avec une
charge bornée et strictement en lecture seule. Elle ne qualifie ni PostgreSQL,
ni le débit complet du listener, ni la capacité commerciale du fournisseur.

## Garanties de sécurité

La commande :

- n'accepte et n'utilise aucune clé privée ;
- ne signe, ne simule et n'envoie aucune transaction ;
- appelle uniquement la méthode JSON-RPC `getSlot` ;
- ouvre exactement deux souscriptions `logsSubscribe`, une pour Pump.fun et
  une pour PumpSwap, et exige leurs accusés de réception JSON-RPC ;
- ne conserve ni signature, ni logs, ni contenu de transaction ;
- n'affiche jamais les URL RPC, en-têtes ou messages d'erreur du transport ;
- n'accède pas à la base de données et ne modifie pas le listener actif.

Un deadline mural annule les appels HTTP, l'établissement WebSocket et son
nettoyage. Une déconnexion ou erreur après les accusés de réception invalide
également la santé WebSocket, même si les deux programmes ont déjà été vus.

Le test reste borné entre 5 secondes et 1 heure, avec un intervalle compris
entre 250 ms et 60 secondes et au maximum 10 000 échantillons HTTP.

## Préparation

Configurer les deux URL du même fournisseur dans un environnement local sûr :

```dotenv
SOLANA_HTTP_RPC_URL=https://endpoint-fourni.example
SOLANA_WS_RPC_URL=wss://endpoint-fourni.example
SOLANA_COMMITMENT=confirmed
RPC_SOAK_DURATION_SECONDS=60
RPC_SOAK_INTERVAL_MS=1000
```

Ne pas committer le fichier `.env`. Le soak utilise aussi la validation de
configuration V1 : toute configuration de clé privée est refusée.

Avant un test prolongé, relever dans le tableau de bord du fournisseur le
quota restant, les crédits par méthode et les limites de connexions WebSocket.
Ces données sont contractuelles et ne peuvent pas être déduites du rapport.

## Basculement HTTP de production

`SOLANA_HTTP_RPC_URL` reste l'endpoint principal. En production, on peut ajouter
`SOLANA_HTTP_RPC_FALLBACK_URLS` sous la forme d'une liste ordonnée, séparée par
des virgules, de fallbacks : au plus trois fallbacks (donc quatre endpoints au total).
Les URLs sont canonicalisées : les doublons canoniques, y compris le principal,
sont refusés, et tous les endpoints HTTP doivent avoir le même schéma HTTP
(`http` ou `https`). Dans une chaîne de basculement, les fragments d'URL sont interdits
car ils ne sont pas transmis par HTTP et ne peuvent donc pas identifier un endpoint.
Par exemple :

```dotenv
SOLANA_HTTP_RPC_URL=https://primary.example.invalid
SOLANA_HTTP_RPC_FALLBACK_URLS=https://fallback-one.example.invalid,https://fallback-two.example.invalid
SOLANA_WS_RPC_URL=wss://primary.example.invalid
SOLANA_WS_RPC_FALLBACK_URLS=wss://fallback-one.example.invalid,wss://fallback-two.example.invalid
```

Sans fallback, le listener conserve exactement le comportement à endpoint unique
de web3.js, y compris son rate-limit retry. Avec des fallbacks, le transport HTTP
de production ne bascule que sur un rejet réseau ou HTTP 429, 502, 503 et 504.
Il essaie chaque endpoint éligible au plus une fois par requête logique; le
dernier endpoint sain reste privilégié. Une réponse HTTP non réussie est
retournée sans rotation et réinitialise la préférence vers le principal pour
la requête logique suivante. Il ne bascule pas pour un autre 4xx, une erreur
JSON-RPC en HTTP 200, ou un résultat archive null applicatif.

`Retry-After` et le délai de refroidissement sont bornés à 60 secondes. Lorsque
tous les endpoints sont en refroidissement, il n'y a aucune attente interne :
l'épuisement fixe est propagé au comportement existant de démarrage ou de retry
durable. Les métriques V1 sont uniquement dérivées des logs. Les seuls
identifiants d'endpoint publiés sont
`primary`, `fallback-1`, `fallback-2` et `fallback-3`; les événements stables
sont `rpc.http_endpoint_degraded`, `rpc.http_failover` et
`rpc.http_endpoints_exhausted`. Les logs ne contiennent jamais URL, hôte,
en-tête, corps, erreur fournisseur, clé API, ni erreur fournisseur brute.

L'opérateur provisionne les endpoints indépendamment et vérifie auprès de chaque
fournisseur les quotas, la facturation et la cohérence archive. Ce dépôt ne peut
pas valider les contrats de quota ou de facturation des fournisseurs.

La configuration accepte désormais `SOLANA_WS_RPC_FALLBACK_URLS` comme liste
ordonnée appairée à la liste HTTP. Une liste HTTP sans liste WS conserve le
fallback HTTP-only de l'issue #56. Dès qu'une liste WS est renseignée, la liste
HTTP doit exister avec la même taille et chaque paire utilise `https/wss` ou
`http/ws`. Les identités publiques restent strictement positionnelles.
L'issue #59 valide et expose ce catalogue, mais ne l'active pas encore dans le
subscriber de production : le basculement WebSocket contrôlé ne sera
opérationnel qu'après l'issue #63.

Le basculement de production est distinct du soak : `npm run rpc:soak` reste
intentionnellement mono-fournisseur et ignore conceptuellement les listes de
fallbacks. Il qualifie exactement `SOLANA_HTTP_RPC_URL + SOLANA_WS_RPC_URL`
d'un seul fournisseur, pas une chaîne de basculement de production.

## Exécution

Commencer par le test par défaut :

```bash
npm run rpc:soak > rpc-soak-report.json
```

Le processus écrit exactement un objet JSON sur la sortie standard. Le fichier
est conçu pour être archivé sans endpoint ni secret, mais il peut révéler les
horodatages, slots et volumes d'observations de la fenêtre testée.

Pour une fenêtre de 15 minutes à un échantillon toutes les 2 secondes :

```bash
RPC_SOAK_DURATION_SECONDS=900 RPC_SOAK_INTERVAL_MS=2000 npm run rpc:soak > rpc-soak-report.json
```

Ne lancer qu'un soak à la fois pour un endpoint. Vérifier en parallèle le
tableau de bord du fournisseur afin de mesurer la consommation réelle.

## Interprétation

| Verdict | Code processus | Signification |
| --- | ---: | --- |
| `PASS` | 0 | Tous les appels HTTP réussissent, le slot avance, les deux programmes sont observés et le nettoyage WebSocket réussit. |
| `DEGRADED` | 2 | Le transport reste partiellement disponible, mais une perte HTTP, un 429, un slot immobile ou une absence d'observation programme est détecté. |
| `FAIL` | 1 | HTTP est indisponible, la souscription échoue ou le nettoyage WebSocket échoue. |

Les `reasonCodes` sont stables et expliquent le verdict. Le code
`SOAK_DEADLINE_EXCEEDED` signale une opération annulée au deadline et
`WS_CONNECTION_LOST` une session acquittée puis devenue défaillante. Les latences sont des
entiers en millisecondes ; les slots sont des chaînes décimales pour préserver
leur exactitude. L'absence d'événement Pump.fun ou PumpSwap pendant une fenêtre
courte peut refléter le trafic et produit donc `DEGRADED`, pas une preuve de
panne HTTP.

Le compteur HTTP `missed` augmente lorsqu'un établissement ou un appel lent a
déjà dépassé un ou plusieurs créneaux. Ces créneaux ne sont jamais rejoués en
rafale ; `HTTP_SCHEDULE_MISSED` rend le rapport `DEGRADED`.

Une erreur de configuration ou une panne inattendue produit uniquement le code
fixe `RPC_SOAK_COMMAND_FAILED` sur la sortie d'erreur et quitte avec le code 1.

## Critère opérationnel recommandé

Un endpoint ne doit pas être injecté en production sur la seule base d'un
`PASS` de 60 secondes. Exécuter d'abord la fenêtre courte, puis une fenêtre
représentative compatible avec le quota fournisseur. Conserver le rapport et
les métriques du tableau de bord, et valider explicitement :

1. aucun rate limit pendant la fenêtre retenue ;
2. latence p95 compatible avec le besoin du listener ;
3. stabilité des deux souscriptions ;
4. budget fournisseur suffisant pour le trafic attendu et les reprises ;
5. procédure d'arrêt et de retour à l'ancien endpoint documentée.

Le soak ne promet ni première position, ni présence dans le même slot, ni
sellabilité, ni profit. Il mesure seulement un petit contrat de disponibilité
RPC en observation.

La validation terrain Issue #49 à 50 positions Mainnet reste non exécutée et
non validée. Ce soak, comme le basculement, ne prouve donc ni la préparation
opérationnelle ni la profitabilité; le produit demeure observe/paper only, sans
wallet, signature ni soumission.
