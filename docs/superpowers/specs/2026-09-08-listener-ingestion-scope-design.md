# Scope d'ingestion du listener H2i — conception #94

**Version de specification :** 1.0.0

**Version de la specification WebSocket parente :** 1.4.3

**Date :** 2026-09-08

**Statut :** APPROUVEE PAR L'INSTRUCTION PERMANENTE D'UTILISER LA RECOMMANDATION V1

**Issue :** #94

## 1. Constat Mainnet

Apres la correction du transport WebSocket par #93, un probe H2i paper de
29 secondes a recu 21 405 transactions : 19 913 PumpSwap et 1 531 Pump.fun.
Le worker sequentiel n'en a traite que 60 et 21 344 sont restees en attente.
Le WebSocket etait `ACTIVE/RUNNING`, mais cette charge ne permet pas de prouver
qu'une creation sera traitee avant la fenetre d'entree de 45 secondes.

## 2. Decision

Le listener accepte un scope ferme :

- `launchpad-only` active Pump.fun et desactive l'ingestion globale PumpSwap ;
- `launchpad-and-market` active Pump.fun et PumpSwap et reste la valeur par
  defaut compatible.

Une liste canonique immuable de programmes est derivee une seule fois du
scope. La factory l'injecte dans la session WebSocket et dans chaque scanner
de catch-up provider-pinned. Un filtrage limite au WebSocket est interdit : le
catch-up recreerait sinon le meme backlog.

H2i emploie explicitement `launchpad-only`. La pipeline peut encore observer
la migration Pump.fun et sa preuve PumpSwap lorsqu'elles apparaissent dans la
meme transaction Pump.fun. Elle ne suit pas les swaps exclusivement PumpSwap
apres migration dans ce scope ; l'API doit donc publier `pumpswap=IDLE`.

## 3. Invariants

- Pump.fun est toujours actif ; aucun scope vide n'existe.
- Les valeurs inconnues, espaces et variantes de casse sont rejetes.
- Le comportement par defaut reste strictement Pump.fun plus PumpSwap.
- Le WebSocket n'attend que les ACK du scope et ne desabonne que ceux-ci.
- Le scanner ne lit, ne liste, ne compare-et-echange et ne resout aucune
  evidence du programme market lorsqu'il est hors scope.
- Une ancienne evidence market ne degrade pas un runtime `launchpad-only` ;
  elle reste persistee et redeviendra pertinente si le scope complet est
  reactive.
- Aucun droit PostgreSQL, migration, wallet, armement, signature ou transport
  de soumission n'est ajoute.

## 4. Limite explicite

La reduction observee attendue est d'environ 95 %, mais elle ne prouve pas a
elle seule le SLA de 45 secondes. Si le probe Pump.fun seul echoue encore, une
PR separee introduira la decouverte globale des `CreateEvent` comme indice,
puis des abonnements cibles aux bonding curves suivies et aux pools PumpSwap
canoniques avec checkpoints, backfill, TTL et reprise.

Les 21 405 lignes du probe precedent ne sont pas supprimees manuellement. Le
reprobe utilise une base propre ou attend leur terminalisation et leur
retention auditee.

## 5. Acceptation

- parsing de configuration teste pour le defaut, les deux valeurs et les
  rejets ;
- exactement un subscribe/ACK/unsubscribe en `launchpad-only` ;
- aucun appel ni checkpoint market pendant le catch-up reduit ;
- meme scope injecte dans les deux chemins par la factory ;
- etat API PumpSwap `IDLE` dans le scope reduit ;
- build, check, lint, tests, documentation, smoke et CI verts ;
- reprobe Mainnet court sans PumpSwap global, sans wallet et sans aucune
  revendication de validation paper Mainnet.

