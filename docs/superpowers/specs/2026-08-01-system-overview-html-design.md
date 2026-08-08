# Conception du document HTML d’architecture et d’exploitation

## Objectif

Créer `docs/system-overview.html`, une page autonome qui explique le produit
`sol-token-listener` après la livraison de l’ingestion transactionnelle durable.
Le document doit permettre à un responsable produit, un développeur ou un
opérateur de comprendre ce qui est réellement opérationnel, comment les données
circulent et quelles garanties ou limites s’appliquent.

La page est une documentation. Elle ne doit effectuer aucun appel RPC, aucune
lecture de secret, aucune écriture en base et aucune action de trading.

## Format retenu

- HTML5 statique en français ;
- mise en page responsive fondée sur Bootstrap 5 ;
- feuille Bootstrap conservée localement sous `docs/assets/vendor/bootstrap/` ;
- licence Bootstrap conservée avec l’actif distribué ;
- diagrammes SVG intégrés dans le HTML ;
- aucun JavaScript requis au chargement ;
- ouverture possible directement depuis le système de fichiers, hors ligne ;
- impression lisible grâce à des règles CSS dédiées.

Le HTML ne dépend pas de `node_modules`, d’un CDN ou du serveur applicatif.

## Structure éditoriale

La page contient une barre de navigation interne et les sections suivantes :

1. résumé exécutif et état opérationnel ;
2. périmètre produit, garanties et limites ;
3. architecture en couches et dépendances autorisées ;
4. flux fonctionnel Pump.fun vers PumpSwap ;
5. acquisition Solana par WebSocket et catch-up HTTP ;
6. transaction inbox, leases, retries et reprise après arrêt ;
7. décodage externe/interne, multi-instruction et multi-quote ;
8. finalité processed/confirmed/finalized/orphaned ;
9. métadonnées, signaux sociaux, créateur et graphes de wallets ;
10. qualification, scores séparés et conditions éliminatoires ;
11. paper trading et garanties d’absence d’exécution réelle ;
12. persistance PostgreSQL, projections, audit et rétention quatre heures ;
13. API REST/SSE et contrat du futur front-end ;
14. runtime, health, arrêt gracieux et exploitation ;
15. tests, reprise transactionnelle et critères d’acceptation ;
16. limites connues et prochaines étapes.

Chaque section distingue explicitement les capacités actives, les fondations
présentes mais incomplètes et les extensions futures.

## Diagrammes

Les graphes sont dessinés en SVG avec texte accessible et une légende. Ils
couvrent au minimum :

- la chaîne produit Pump.fun → qualification → paper → PumpSwap ;
- les couches adapters/application/domain/storage/interfaces ;
- la séquence WebSocket/catch-up → inbox → worker → pipeline ;
- la machine de finalité avec réconciliation et orphaning ;
- le modèle de données entre événements bruts, projections et API ;
- la séquence de reprise après panne sur les cinq frontières persistantes ;
- les barrières de sécurité entre observation, paper et ancien code live isolé.

Les diagrammes doivent rester compréhensibles sans couleur et sur un écran
étroit. Les informations essentielles sont répétées dans le texte voisin.

## Fidélité technique

Les affirmations sont vérifiées contre les sources fusionnées : bootstrap,
factory de production, pipeline observé, worker, repository inbox, reconciler,
migrations `001` à `010`, contrats API et tests d’intégration.

Le document précise notamment :

- écoute active des programmes Pump.fun et PumpSwap ;
- deux abonnements WebSocket et catch-up borné ;
- récupération canonique de l’index de transaction ;
- traitement séquentiel par signature et snapshots durables ;
- backoff exponentiel à partir de 500 ms, délai plafonné à 60 secondes et
  absence actuelle de plafond du nombre de tentatives ;
- finalité prudente et seuil de sondages manquants avant orphaning ;
- dissolution des projections courantes lors d’un replay orphaned ;
- rétention attendue de quatre heures pour les données devenues purgeables ;
- backlog de health incluant les échecs retryables ;
- support multi-quote dans le domaine, avec allowlist paper initiale SOL ;
- absence de signer, clé privée et soumission dans le runtime V1 ;
- Raydium CPMM conservé mais absent du flux de production principal.

Aucune promesse de première position, même slot, sellabilité ou profit ne doit
apparaître.

## Présentation

La page utilise :

- un en-tête sombre avec état `observe/paper only` ;
- des cartes Bootstrap pour les capacités et garanties ;
- des alertes pour les limites et risques opératoires ;
- des tableaux responsive pour les modules, événements, tables et routes ;
- des badges cohérents pour `ACTIF`, `PARTIEL`, `ISOLÉ` et `FUTUR` ;
- une typographie et des contrastes conformes aux usages Bootstrap ;
- une table des matières avec ancres stables.

## Vérification

Avant publication :

- valider la structure HTML et l’absence de ressources réseau ;
- vérifier toutes les ancres internes et tous les chemins locaux ;
- vérifier que chaque diagramme possède un titre et une description ;
- ouvrir la page localement dans le navigateur et contrôler les largeurs bureau
  et mobile ;
- rechercher toute référence à une clé, un signer ou une exécution live active ;
- exécuter `npm run check`, `npm run lint` et `git diff --check` ;
- confirmer que le worktree est propre après commit ;
- pousser le commit sur `main` seulement si toutes les vérifications réussissent.

## Hors périmètre

- modification du runtime, de l’API ou du schéma PostgreSQL ;
- génération dynamique de la page par le backend ;
- connexion à une source de données réelle ;
- ajout d’un framework front-end ;
- activation de l’exécution réelle ;
- suppression ou modification de l’adaptateur Raydium CPMM.
