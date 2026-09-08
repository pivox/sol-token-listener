# Priorité durable des créations Pump.fun

**Version :** 1.0.0 — 2026-09-08

## Contexte

Le probe Mainnet H2i post-#95 a reçu 2 002 transactions Pump.fun en 45
secondes. Le traitement FIFO a laissé 1 888 lignes en attente sans projeter de
création dans cette fenêtre. Un `logsNotification` réussi peut toutefois
contenir le discriminator officiel de `CreateEvent` avant la récupération RPC
de la transaction complète.

Le snapshot IDL officiel est celui de
`pump-fun/pump-public-docs@9c82f61cb711b044a17f770ab8ce9f9bdf78f333`. Le
head officiel et le SHA-256 de `idl/pump.json` ont été revérifiés le
2026-09-08 et correspondent au manifeste versionné du dépôt.

## Décision

Le transport WebSocket produit un indice fermé et non autoritatif :
`NONE | PUMPFUN_CREATE`. Il inspecte uniquement des lignes `Program data: `
bornées et compare les huit octets décodés au discriminator
`PUMP_EVENTS.CreateEvent` généré depuis l'IDL officiel. Toute entrée absente,
malformée, creuse, proxy, getter ou hors limite donne `NONE` sans interrompre la
session.

Le superviseur traduit cet indice en `ingestionHint: null |
'PUMPFUN_CREATE'`. Les scanners catch-up ne produisent jamais d'indice. Aucun
log de `logsNotification` ne traverse ce contrat, PostgreSQL ou l'API. Cette
garantie ne concerne pas les logs RPC déjà présents dans le snapshot complet
normalisé, nécessaires au décodeur métier.

La migration 044 ajoute deux priorités durables ordonnées : `NORMAL` et
`LAUNCH_CANDIDATE`. Le repository dérive la priorité de l'indice et applique
une montée monotone atomique sur les doublons. Retry, lease, reprise, finalité,
orphaning et rétention ne la modifient jamais.

## Ordonnancement et équité

Le claim choisit normalement `LAUNCH_CANDIDATE`, puis le slot et la signature.
Un compteur PostgreSQL singleton sérialise uniquement la décision de claim.
Après 32 claims prioritaires consécutifs, le prochain claim éligible tente une
ligne `NORMAL`; faute de ligne normale prête, la sélection prioritaire reprend.
Une ligne normale éligible ne peut donc pas être affamée au-delà de 32 claims
de création, y compris avec plusieurs workers ou après redémarrage.

## Autorité et sécurité

L'indice ne crée aucun événement métier. La transaction RPC complète et le
décodeur Pump.fun restent la seule autorité pour `TokenLaunchDetected` et pour
l'achat initial éventuel de la même transaction. Un faux positif ne change que
l'ordre de traitement.

Cette livraison ne change ni qualification, ni stratégie, ni wallet, ni clé,
ni signature, ni armement, ni soumission. `CANARY_NOT_STARTED` reste vrai et
aucune conclusion `#49 PASS` n'est permise.

## Acceptation

- 2 000 lignes `NORMAL` puis une création tardive : la création est claimée
  avant le backlog ;
- montée `NORMAL -> LAUNCH_CANDIDATE` atomique et absence de downgrade ;
- une ligne `NORMAL` prête est claimée au plus tard après 32 créations ;
- index de claim utilisé sans tri ni scan séquentiel sur PostgreSQL 16 ;
- aucun log WebSocket persisté ou exposé ;
- migrations base vide, upgrade et rejeu verts ;
- build, check, lint et tests verts ;
- aucun changement de capacité d'exécution réelle.

