# Plan — priorité durable des créations Pump.fun

**Spec :** `docs/superpowers/specs/2026-09-08-pumpfun-launch-priority-design.md` v1.0.0

1. Écrire les tests du classificateur borné et du transport WebSocket.
2. Ajouter le contrat d'indice fermé et sa traduction par le superviseur.
3. Écrire les tests PostgreSQL de priorité, montée monotone, équité et plan.
4. Ajouter la migration 044 et adapter enqueue/claim sans modifier le worker.
5. Mettre à jour les versions d'architecture, runbook et le head canonique.
6. Exécuter les tests ciblés, puis build/check/lint/tests complets.
7. Ouvrir la PR, effectuer au plus deux cycles de revue, corriger uniquement
   les retours de cette PR, puis fusionner lorsque CI et revue sont vertes.

