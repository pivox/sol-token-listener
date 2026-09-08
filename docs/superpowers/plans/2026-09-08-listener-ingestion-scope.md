# Plan d'implementation du scope d'ingestion #94

**But :** rendre H2i exploitable en excluant explicitement le flux global
PumpSwap des chemins WebSocket et catch-up, sans modifier le comportement par
defaut.

## Tache 1 — Contrat et configuration

- Ecrire les tests RED du parseur et de `.env.example`.
- Ajouter `ListenerIngestionScope` et la liste canonique immuable de programmes.
- Conserver `launchpad-and-market` comme defaut.

## Tache 2 — WebSocket et catch-up

- Ecrire les tests RED sur subscribe, ACK, notification et unsubscribe reduits.
- Injecter la liste de programmes dans `openWsProgramSession`.
- Ecrire les tests RED du scanner sans interaction market.
- Injecter la meme liste dans `StrictCatchUpScanner`.

## Tache 3 — Composition et sante

- Ecrire les tests RED de factory et de runtime.
- Deriver une seule liste depuis la configuration dans la factory.
- Publier PumpSwap `IDLE` quand le programme market est hors scope.

## Tache 4 — Documentation et validation

- Versionner la specification WebSocket, l'architecture, le runbook et
  `.env.example`.
- Executer les tests cibles puis build/check/lint/tests/docs/smoke complets.
- Ouvrir une PR liee a #94, effectuer au plus deux cycles de revue, fusionner
  uniquement avec CI verte et aucun thread bloquant.
- Rejouer H2i sur une base PostgreSQL propre, sans wallet, et mesurer le SLA
  creation vers paire sans revendiquer #49.
