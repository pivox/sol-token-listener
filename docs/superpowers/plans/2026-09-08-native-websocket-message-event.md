# Native WebSocket MessageEvent Implementation Plan

> **For agentic workers:** use test-driven development and verification before completion.

**Goal:** Permettre au listener Node.js 22 d'accepter les frames texte du
WebSocket natif sans élargir la frontière JSON-RPC ni exposer de données RPC.

**Architecture:** La voie existante des événements injectés avec une propriété
propre `data` reste inchangée. Quand elle est absente, la session appelle
directement le getter `MessageEvent.prototype.data` capturé au chargement du
module. Aucun getter arbitraire n'est traversé ; les proxies et les valeurs non
textuelles restent invalides.

**Tech Stack:** TypeScript strict ESM, Node.js 22 WebSocket/MessageEvent,
`node:test`, ESLint.

## Task 1 — Reproduire la frontière native

**Files:**

- Modify: `tests/ws-program-session.test.ts`

- [ ] Envoyer les deux ACK via de vrais `MessageEvent` Node dont `data` est un
  getter hérité et constater `PROTOCOL_INVALID` avant correction.
- [ ] Ajouter des cas hostiles : proxy de `MessageEvent` et getter hérité
  arbitraire, sans exécution de ce dernier.

## Task 2 — Corriger minimalement le décodage de frame

**Files:**

- Modify: `src/solana/rpc/ws-program-session.ts`

- [ ] Capturer le getter natif `MessageEvent.prototype.data`.
- [ ] Lire d'abord la propriété propre existante, puis utiliser uniquement le
  getter natif sur un objet non proxy.
- [ ] Conserver la taille maximale, le texte obligatoire et le parsing JSON
  stricts.

## Task 3 — Vérifier et livrer

- [ ] Exécuter les tests WebSocket ciblés, `build`, `check`, `lint`, puis la
  suite complète.
- [ ] Effectuer au plus deux cycles de revue, ouvrir une PR liée à #92 et ne
  fusionner qu'avec CI verte et aucun commentaire bloquant.
- [ ] Relancer H2i depuis `main` ; exiger un état durable autre que
  `PROTOCOL_INVALID` avant de reprendre #89.
