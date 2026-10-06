# Préparation au premier live — validations et backlog

État courant après clôture P1 (rapport `docs/operations/audits/2026-10-04T2307Z/cloture-p1.md`) : **NO-GO**. Les neuf assertions historiques de migration sont corrigées et passent sur PostgreSQL jetable; suite live et build passent. Les valeurs d’environnement cible restent absentes; aucun RPC distant, accès DB cible, observation réseau ou essai live n’a été effectué. Modèle exact : `docs/operations/live-config-model.md`.

### P1 — état courant après clôture 2026-10-04T2307Z

| ID | État courant | Preuve / suite |
|---|---|---|
| LIVE-P1-01 | PASS local/hors ligne | `npm run check:backend`; tests migrations concernés 42/42; suite live/PumpSwap 61/61; aucun test ignoré dans ces suites. Le pipeline d’évidence temporaire passe 2/2. Causes historiques et diff dans le rapport de clôture. |
| LIVE-P1-02 | BLOQUÉ — configuration cible absente | Les commandes exactes et le modèle sont dans `docs/operations/live-config-model.md`. `live:config-check` et `live:network-preflight` refusent avec environnement vide, avant accès distant. Zéro requête RPC. |
| LIVE-P1-03 | NON EXÉCUTÉ — prérequis absents | Pas d’endpoint/base cible; `npm run dev` charge dotenv et écrit dans le store configuré. Ne pas exécuter avant choix d’un environnement isolé et validation de la borne. |
| LIVE-P1-04 | NON EXÉCUTÉ — interdit dans cette passe | Aucun achat/SELL autorisé pendant la validation; premier essai réservé à une action ultérieure explicite de l’utilisateur. |
| LIVE-P1-05 | NON APPLICABLE JUSTIFIÉ | Aucun premier essai n’a eu lieu. Le parcours export→signature→métadonnées→rapport est testé hors ligne, sans être un rapprochement de trade on-chain réel. |

Historique du rapport P1 précédent : garde `DATABASE_URL` explicite dans `src/cli/live-run.ts`; voir son rapport pour les résultats de cette passe.

Historique du snapshot PumpSwap/cashback : les chiffres de test indiqués ici décrivent ce snapshot; l’état courant est dans l’en-tête et le rapport de clôture.

État antérieur de profil et de reprise (historique, supersédé par le lot courant): `create_v2` Token-2022 avec `MetadataPointer`/`TokenMetadata`, quote wSOL SPL, refus des nouveaux BUY cashback et recheck opérateur borné avaient été testés hors ligne. À cette date, SELL cashback et lecture sans index n’étaient pas encore raccordés. Le lot courant les couvre hors ligne; aucun préflight cible ni essai réel n’a été exécuté.

## P0 — bloqueurs de l’activation

| ID | État | Action | Preuve d’acceptation |
|---|---|---|---|
| LIVE-P0-08 | FAIT (hors ligne) | Intégrer migration, résolution canonique, quote et vente PumpSwap index 0 SPL/SOL dans l’exécuteur et la persistance existants. | Test PostgreSQL multi-processus; journal un BUY/SELL confirmé, deux fills et position clôturée; aucun SELL Pump.fun après migration. |
| LIVE-P0-09 | FAIT HORS LIGNE — environnement/essai non validés | Les cashback sont refusés au BUY et supportés au SELL à partir de l’état on-chain courant pour les positions suivies sur Pump.fun/PumpSwap. Pool canonique découvert directement par PDA puis validé sans dépendance à l’index; recheck opérateur borné utilise ce lecteur. | T1/T2 cashback end-to-end, T3 opérateur avec schéma sans `market_pools`, T4 état de compte incohérent sans clôture ni SELL, et T5 régressions doivent tous passer dans la commande finale. Le test ne démontre ni mutation du flag ni exécution on-chain. Aucun gate environnemental P1 n’est déclaré passé. |
| LIVE-P0-10 | FAIT hors ligne — plafond chiffré cible à provisionner | `LIVE_MAX_PRIORITY_FEE_LAMPORTS` est consommé par la policy live puis vérifié dans le message v0 final par l’exécuteur commun BUY/SELL. Une transaction signée en attente garde ses octets; dépassement après baisse de configuration bloque la rediffusion et conserve l’état UNKNOWN. Aucun plafond réseau total n’est annoncé. | Tests de calcul au-dessous/à la limite/au-dessus, arrondi exact, instruction post-builder, Pump.fun BUY/SELL, PumpSwap SELL, reprise et refus avant signer/diffusion; compilation et lint ciblé. Le profil reste bloqué si la valeur est absente. |

## P1 — validations avant le premier essai

| ID | État | Action vérifiable | Preuve d’acceptation |
|---|---|---|---|
| LIVE-P1-01 | PASS local/hors ligne | Snapshot courant ci-dessus : migrations 42/42, live/PumpSwap 61/61, pipeline d’évidence 2/2, compilation passée. | Ne prouve ni environnement cible ni exécution mainnet. |
| LIVE-P1-02 | BLOQUÉ — configuration cible absente | Modèle et variables par commande dans `docs/operations/live-config-model.md`; les deux CLIs refusent avec environnement vide avant RPC. | Provisionner les choix de la liste consolidée; préflight cible en lecture seulement. |
| LIVE-P1-03 | NON EXÉCUTÉ — prérequis absents | Aucune URL/base cible et aucune observation lancée. | Préparer une cible isolée et un runtime borné avant observation. |
| LIVE-P1-04 | NON EXÉCUTÉ — interdit dans la passe P1 | Premier aller-retour réservé à un lancement ultérieur explicite de l’utilisateur après validations et revue. | Aucun essai réel n’a eu lieu et le présent passage n’autorisait pas son exécution. |
| LIVE-P1-05 | NON APPLICABLE JUSTIFIÉ | Aucun premier essai à rapprocher. Le parcours export→signature→métadonnées→rapport est validé par fixtures hors ligne seulement. | Rapprocher le premier essai réel avant toute session suivante. |

## P2 — chantiers distincts, non exécutés

| ID | Objectif | Dépendances | Fichiers probables | Critère d’acceptation |
|---|---|---|---|---|
| LIVE-P2-01 | Compléter le rapprochement historique r8, y compris les flux externes et frais non attribués. | Archives RPC récupérées, signatures et bornes wallet fiables; ne remplace pas les inconnues par zéro. | `scripts/report-transaction-evidence.ts`, `src/telemetry/transaction-evidence.ts`, nouveaux rapports sous `docs/operations/audits/`. | Chaque montant a une signature/compte/slot et une devise; écarts résiduels explicites. Les +9 083 040 lamports ATA ne sont pas acquis. |
| LIVE-P2-02 | Étudier MFE/MAE, activité acheteurs, volumes, créateur et liens wallet avec couverture comparable. | Enregistrements temporels complets et indicateurs de couverture; déduplication stable. | `src/telemetry/position.ts`, `src/telemetry/report.ts`, scripts offline. | Rapport distingue observation, données absentes et hypothèses; aucun wallet unique présenté comme acteur indépendant sans preuve. |
| LIVE-P2-03 | Comparer des variantes de manière causale sans optimisation sur six trades. | Replay historique reproductible, quotes disponibles à l’instant de décision, modèle d’exécution explicite. | `src/telemetry/dataset.ts`, `src/telemetry/report.ts`, nouveaux scénarios de replay. | Aucun scénario utilise une observation future pour décider; variantes annoncées exploratoires, sans prétention hors échantillon sur données déjà utilisées. |
| LIVE-P2-04 | Ajouter tableaux de bord, haute disponibilité et fournisseurs RPC multiples. | P0 durable terminé, mesure de fiabilité, budgets/quota définis et règles de bascule fail-closed. | `src/interfaces/http/`, `src/solana/rpc/`, télémétrie opérationnelle. | Tests de panne/quota/duplication; aucune bascule ne signe deux fois ni ne crée de transactions concurrentes. |
| LIVE-P2-05 | Étendre à d’autres stratégies, marchés et plusieurs positions simultanées. | BUY/SELL de bout en bout du périmètre initial, reprise sûre et sortie migration supportée. | `src/live/`, adaptateurs de marché et tests d’intégration. | Chaque nouveau couple marché/token a builder, quote, allowlist, sorties post-migration, rapprochement et tests; exposition simultanée plafonnée explicitement. |
