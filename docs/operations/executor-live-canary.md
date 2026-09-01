# Executor live — préparation du canary Mainnet (#51-G)

**Version :** 1.0.0 — 2026-08-31

Ce document décrit l'état réellement livré et la procédure qui deviendra
applicable après composition du runtime. Le binaire production est actuellement
non composé et donc indémarrable : aucun script `executor:live:start` n'est
publié. Il est interdit de contourner ce verrou avec un script ad hoc.

La validation paper Mainnet #49 reste `NON_EXECUTED / NON_VALIDATED`. Les
briques #51-G ne prouvent ni rentabilité, ni sellabilité générale, ni avantage
de position. Leur présence ne crée aucun armement, ne change pas `ENTRY_STOP`
et n'autorise aucune dépense. Aucune commande ci-dessous ne les enchaîne
automatiquement.

## État et frontière de sécurité

La migration 036, le ledger live, la signature locale, la soumission exacte,
la confirmation, la réconciliation et la sortie à deadline disposent de
contrats testables séparés. Il manque encore une composition production qui
valide configuration et schéma avant de charger le secret, injecte tous les
ports réels, respecte l'ordre réconciliation → confirmation → SELL → deadline
→ BUY, puis ferme les ressources dans un délai borné.

Tant que ce graphe n'est pas livré et revu, les commandes opérateur restent
inertes et aucun canary réel ne doit être tenté.

## PostgreSQL et rétention

Après les migrations, un administrateur peut appliquer
`scripts/provision-executor-roles.sql`. Il crée des rôles de groupe `NOLOGIN`,
sans mot de passe ni privilège cluster. Le compte LOGIN du futur processus live
doit recevoir seulement `sol_token_executor_live`.

Ce rôle est le seul rôle applicatif autorisé à lire les octets signés et les
détails de positions live. Listener, worker dry-run, opérations, lecteur
opérateur et API publique n'y ont aucun accès. Aucun rôle applicatif ne reçoit
`DELETE`.

La purge supprime après quatre heures, par cohorte et dans l'ordre enfant
d'abord, uniquement :

- les artefacts `RECONCILED` ou `REVOKED_NO_SEND` et leurs événements ;
- les autorisations `CONSUMED` ou `REVOKED` sans artefact restant ;
- les positions `CLOSED` sans autorisation restante.

Un artefact `AMBIGUOUS`, une position `OPEN`, `EXIT_PENDING` ou `UNKNOWN`, et
une autorisation `ACTIVE` ou `LOCKED` ne sont jamais candidats. Les tombstones
anti-rejeu minimaux des intentions restent durables.

## Préparation publique, sans secret

Le fichier `.env.example` liste les limites publiques. Un futur déploiement
devra épingler notamment le build, la configuration, la stratégie, le wallet,
le provider, le genesis hash, le quote mint WSOL et le plafond brut en
lamports. Le keypair dédié restera hors du dépôt dans un fichier régulier non
symlink, propriétaire du processus et mode `0600`.

Ne jamais écrire le contenu du keypair dans `.env`, PostgreSQL, un log, une
preuve ou un ticket. Ne pas financer le wallet avant que le runtime composé et
ses gates complets aient passé la revue.

## Séquence opérateur réservée au futur runtime

Après livraison et revue du graphe manquant, l'ordre manuel obligatoire sera :

```bash
npm run live:preflight
npm run live:status
npm run live:report
npm run live:resume
npm run live:status
npm run live:arm -- \
  --maximum-lamports=500000 \
  --holding-ms=300000 \
  --reason='Mainnet canary manually approved.'
npm run live:status
```

`resume` et `arm` nécessitent chacun un vrai TTY et une confirmation distincte.
Le montant montré est un exemple technique, pas une recommandation. Le plafond
doit être validé humainement en lamports. Avant l'armement, chacune des onze
gates #51-F doit être fraîche et `PASSED`, sans `UNKNOWN`, `AMBIGUOUS` ou
`UNKNOWN_HELD`.

Le démarrage du futur binaire ne devra ni exécuter `resume`, ni armer, ni
modifier l'état de contrôle. Après démarrage manuel séparé, la surveillance
reposera sur :

```bash
npm run live:status
npm run live:report
```

## Kill switches et arrêt

L'arrêt d'entrée bloque les nouveaux BUY mais préservera sorties et
réconciliation :

```bash
npm run live:kill-switch -- \
  --mode=entry-stop \
  --reason=OPERATOR_ENTRY_STOP
```

L'arrêt dur est réservé au cas où continuer à signer ou envoyer est plus
risqué qu'une position non clôturée :

```bash
npm run live:kill-switch -- \
  --mode=hard-stop \
  --reason=OPERATOR_HARD_STOP
```

Une soumission incertaine impose la réconciliation des mêmes octets et de la
même signature. Elle n'autorise ni nouveau blockhash, ni nouvel ordre logique,
ni réarmement. Le futur arrêt normal appliquera d'abord `entry-stop`, enverra
`SIGTERM`, attendra l'arrêt borné, puis relira `live:status` et `live:report`.

## Critère de constat futur

Un canary ne pourra être déclaré `PASS` qu'avec un BUY et un SELL finalisés et
réconciliés, zéro double ordre, zéro résiduel inattendu, position `CLOSED`,
autorisation et armement consommés, et aucun état inconnu. Une absence
d'opportunité, un BUY refusé ou une fermeture sans transaction ne vaut pas
`PASS`.

Pour l'instant, le constat obligatoire est : `LIVE_RUNTIME_NOT_COMPOSED`,
`CANARY_NOT_STARTED`, `NON_EXECUTED / NON_VALIDATED`.
