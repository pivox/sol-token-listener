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
