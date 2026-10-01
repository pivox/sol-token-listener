# Mentions passives Pump.fun

Version 1.0.0 — issue #195, parent #120.

## Problème et preuve

`logsSubscribe.mentions` sélectionne les transactions référençant une adresse,
pas uniquement celles exécutant ce programme. Un échantillon borné Mainnet de
1 000 notifications contient 213 hints NONE, dont 204 sans invocation Pump.
Trois transactions relues confirment l'adresse parmi les comptes, une instruction
externe non-Pump, aucune interne et des logs RPC identiques aux logs WebSocket.

## Classification conservative

L'analyseur pur partage les limites existantes de logs. Il accepte uniquement
des frames runtime invoke/success correctement imbriquées, avec au moins une
invocation, sans Pump ni PumpSwap. Il tolère les messages `Program log:` comme
contenu opaque et les lignes consumed du programme actif. Il rejette les logs
vides, tronqués, surdimensionnés, avec accesseurs/proxies, les contrôles invalides,
les failures, return data, program data, les profondeurs incorrectes et toute
syntaxe inconnue. Un résultat incertain garde le traitement existant.

Cette preuve suppose les logs runtime intacts d'un fournisseur RPC de confiance.
Une suppression malveillante de frames entières n'est pas détectable par un
parseur. Aucune garantie d'authentification des logs n'est ajoutée.

## Intégration

- Admission OFF : comportement historique inchangé pour les deux transports.
- Admission ON, abonnement Pump : une preuve positive produit un motif fixe
  `PASSIVE_PUMP_ACCOUNT_MENTION`, avec hint NONE et mint nul.
- La session conserve son callback asynchrone et son drainage. Le superviseur
  applique les mêmes fences owner/session/controller et valide le motif.
- Le reporter dispose d'une observation d'activité sans enqueue. Les mises à
  jour de santé gardent les fences SQL existants. Un échec dégrade le reporter.
- Compteurs bornés d'observations filtrées, sans signature/mint/log ni historique
  non borné. Le superviseur distingue les providers; le subscriber direct ne
  s'invente pas de provider. Une répétition est une observation, pas un unique.
  En production, un événement structuré `websocket_passive_mentions_shutdown`
  expose les compteurs après fermeture du superviseur (réussie ou échouée).
  Ce bilan est local au processus, non persistant et uniquement à l'arrêt :
  ce n'est pas un flux de métriques temps réel. Un crash peut empêcher sa livraison.
  Un échec du journal ne masque jamais le résultat de fermeture.
- Aucun nouveau reçu de classification, checkpoint, changement de finalité,
  migration ou filtre catch-up. Celui-ci reste autoritaire pour la reprise.

## Limites et acceptation

La correction retire du travail inbox mais conserve le coût des observations
de santé et du catch-up. Elle ne suffit pas à valider la capacité #120.
Tests : parseur hostile/CPI/multi-instruction; transports ON/OFF; callback et
drainage; activité sans enqueue; fences et compteurs; rattrapage inchangé.
Deux cycles de revue maximum. Aucun wallet, armement ou transaction.

## Sources primaires

- https://solana.com/docs/rpc/websocket/logssubscribe
- https://github.com/anza-xyz/agave/blob/master/program-runtime/src/stable_log.rs
- https://github.com/anza-xyz/agave/blob/master/program-runtime/src/invoke_context.rs
- https://github.com/anza-xyz/agave/blob/master/svm-log-collector/src/lib.rs
