# Implémentation live — état et reprise

## État courant — correction hors ligne du handoff cutover → rolling (2026-10-05)

- **FAIT / vérifié hors ligne** : un cutover confirmé est désormais terminal dans le bootstrap de son programme. Le scanner relit la borne durable, exige la même signature et le même slot que la preuve du cutover, puis retourne `RECORDED_LIVE_EDGE_CUTOVER` avec cette frontier; il ne rappelle pas la source historique pour rechercher cette signature.
- **FAIT / vérifié hors ligne** : dès que les deux bootstraps (stricts ou cutover) sont terminés, le premier sweep rolling part immédiatement par programme, puis chaque programme reprend sa cadence configurée. Launchpad et market peuvent sweeper en parallèle, avec au plus une passe active par programme. Les bornes restent 20 pages × 1 000 signatures.
- La passe rolling vérifie la signature finalized exacte F2 avant d’enfiler durablement les événements puis d’écrire le checkpoint F2. Si F2 manque, si RPC/catch-up échoue ou si le WS n’est plus sain, le checkpoint reste inchangé et la couverture devient `DEGRADED`. La garde bloque alors les nouveaux BUY; le suivi des positions existantes n’est pas touché. La couverture reste `WARMING_UP` tant que les deux premiers sweeps n’ont pas réussi.
- **Tests hors ligne** : `node --import tsx --test tests/listener-bootstrap.test.ts tests/listener-bootstrap-cutover.test.ts tests/rolling-catch-up.test.ts tests/catch-up-scanner.test.ts tests/listener-runtime.test.ts tests/live-decision-coverage-guard.test.ts` — **62 réussis, 0 échoué, 0 ignoré**. `npm run check:backend`, ESLint ciblé `--max-warnings=0` et `git diff --check` réussis. Aucun repository PostgreSQL n’a été modifié; aucun test sur une base n’était nécessaire.
- **Observations A/B NON EXÉCUTÉES** : ce lot était hors ligne uniquement. Aucun RPC, base cible, cutover, checkpoint, listener, signer ou transaction n’a été touché.
- **Prochaine action exacte** : demander/recevoir l’autorisation distincte pour les observations A/B, en conservant les bornes 20 × 1 000 et sans nouveau cutover automatique.

## État courant — cutover rolling et observation A bloquée (2026-10-05T2053Z)

- Précontrôles en lecture seule réussis sur `127.0.0.1:5432/solanabot`, rôle `solanabot`, schéma `public`; genesis du RPC égal au genesis mainnet attendu; 22 migrations locales appliquées; 0 position/ordre/fill live; aucune session DB ou verrou advisory concurrent.
- Cutover explicite autorisé et appliqué une fois par programme: launchpad `453662738 → 453691421`, evidence `62e78992-606b-4c1f-b441-2fa80d8da4a6`; market `453662739 → 453691421`, evidence `da4f91d6-7114-4373-a47f-0387b001ab96`. Les anciennes preuves invalid-future restent intactes.
- L’observation A observe-only a échoué au bootstrap après cutover avec `CATCH_UP_WINDOW_EXCEEDED` sur market: checkpoint/frontier `453691421`, 20 pages/20 000 signatures, plage parcourue `453691504 → 453691456`, signature checkpoint absente. Le retry rétrograde a perdu la frontier dans la fenêtre mobile avant la fin du bootstrap.
- Aucun sweep rolling périodique n’a réussi ou été démarré; A s’est arrêtée après ~19,1 s avec code 1, avant les 90 s. Le log confirme `transactionSubmission=false`. L’inbox contient 20 579 lignes distinctes créées pendant cette tentative avec source WebSocket, mais les compteurs mémoire exacts reçus/enqueues ne sont pas exposés après l’échec.
- **B NON LANCÉE** conformément à l’arrêt obligatoire après l’échec de A. Aucun nouveau cutover, rebase ou reset. Aucun trade, signer, keyfile, migration ni `live:run`.
- Rapport: [listener-rolling-cutover-ab-observation-2026-10-05.md](listener-rolling-cutover-ab-observation-2026-10-05.md).
- **Prochaine action exacte**: corriger et tester hors ligne le retry bootstrap post-cutover sans rechercher rétroactivement une frontier déjà dépassée; instrumenter requêtes RPC/429 et durées de sweep; obtenir ensuite une nouvelle autorisation avant observation B ou tout autre cutover.

## État courant — rolling catch-up durable (2026-10-05T2031Z)

- **FAIT / testé hors ligne** : après le bootstrap strict réussi, `StartupScanner` programme un catch-up finalized par programme avec le `CatchUpScanner` existant. Chaque passe capture une frontier fixe, enqueue l’intervalle complet via l’inbox idempotente, puis laisse le scanner existant écrire le checkpoint. Les abonnements WS restent actifs pendant tout le cycle. Aucun slot WS seul ne déplace un checkpoint.
- `LISTENER_ROLLING_CATCH_UP_INTERVAL_MS` vaut 15 000 ms par défaut (bornes 5 000–120 000). L’intervalle est mesuré entre débuts de sweeps; un sweep lent réduit le délai suivant jusqu’à zéro, sans chevauchement. Cadence basée sur la session observée: 45 601 événements market en 57 s ≈ 12 000 par intervalle de 15 s, sous 20 000 par programme avec une marge observée d’environ 8 000. Les pointes restent bornées à 20 pages × 1 000; dépassement, erreur RPC ou perte WS met le scanner en `DEGRADED`, visible dans `listener.rolling_catch_up_status`. Le quota contractuel du fournisseur n’est pas prouvé par cette extrapolation.
- **Crash-safety** : arrêt avant écriture du checkpoint rejoue l’intervalle depuis la borne durable et l’inbox déduplique. Un échec d’enqueue/catch-up n’avance pas la borne. Les sweeps déjà actifs sont attendus à l’arrêt; la sûreté ne repose pas sur cet arrêt gracieux.
- **FAIT / testé** : la garde de dispatch live bloque les nouveaux candidats si le scanner ou un WS est dégradé; aucun changement n’est apporté au suivi d’une position existante. Un échec de démarrage tardif ferme maintenant le scheduler rolling avant de fermer ses producteurs.
- **Tests** : suite ciblée rolling/bootstrap/runtime/config **86 réussis, 0 échoué, 0 ignoré**; `npm run check:backend`, ESLint ciblé et `git diff --check` réussis. La suite utilise des fixtures offline, sans DB cible.
- **Observations A/B NON EXÉCUTÉES** : le dernier diagnostic cible démontre que le checkpoint launchpad durable `453662738` est hors de la fenêtre initiale de 20 000 signatures (fenêtre observée `453680526 → 453680409`, signature du checkpoint absente). Sans cutover, rebase ou reset — tous exclus dans ce lot — l’observation A ne peut pas achever son bootstrap, donc B ne peut pas tester un redémarrage depuis les checkpoints qu’A aurait produits. Aucun nouvel essai réseau n’a été lancé.
- **Prochaine action exacte** : obtenir une autorisation distincte pour la procédure opérateur de discontinuité déjà existante, ou fournir une preuve que le checkpoint a été avancé par un mécanisme autorisé; ensuite seulement relancer A puis B sans modifier maxPages. Le canary reste bloqué tant que ce redémarrage strict n’est pas démontré.
- Rapport de ce lot : [listener-rolling-checkpoint-2026-10-05.md](listener-rolling-checkpoint-2026-10-05.md).

## État courant — frontiers finalized par programme et observation (2026-10-05)

- **FAIT / testé hors ligne** : après les ACK des deux WebSockets, le bootstrap prend la première signature finalized retournée séparément pour `launchpad` et `market`. Cette signature et son slot sont la frontier propre au programme. Le scanner, le cutover explicite et la preuve PostgreSQL utilisent cette même frontier; la recherche rétrospective après capture d’un slot global a été retirée. `maxPages=20` reste inchangé et chaque programme ne peut être cutover qu’une fois par démarrage.
- **FAIT** : les diagnostics gardent la preuve initiale `CATCH_UP_WINDOW_EXCEEDED` si le cutover échoue. Les messages URL sont entièrement masqués. Le chemin de démarrage reste strict sans `--allow-recorded-live-edge-cutover`.
- **Tests** : unitaires ciblés 56/56; PostgreSQL jetable 2/2; `npm run check:backend`; ESLint ciblé `--max-warnings=0`; `git diff --check` sans anomalie sur les fichiers suivis concernés. Aucun test ciblé ignoré.
- **Observation unique exécutée** avec `LIVE_ENABLE=false`, keyfile vide, `EXECUTION_MODE=observe`, stratégie paper, migrations, API et dashboard désactivés; option explicite de cutover. Cible vérifiée avant lancement : `solanabot`, rôle `solanabot`, `public`, PostgreSQL 14.18 sur `127.0.0.1:5432`; migration 022 présente une fois; aucune autre session active; checkpoints initiaux launchpad `453623653`, market `453623660`.
- **Cutovers enregistrés atomiquement** avec les abonnements déjà actifs : launchpad `453623653 → 453662738`, evidence `4bd4dd93-fe4d-4ca4-8fb5-31f500ff25cc`; market `453623660 → 453662739`, evidence `6ac03c36-33d6-4bee-b4b3-31b8757079fa`. Raison `operator-approved-live-edge-cutover`; les deux anciennes preuves `invalid-future-checkpoint` restent présentes.
- **Résultat observation** : bootstrap achevé; `subscriberState=RUNNING` et `scannerState=RUNNING` confirment les deux ACK et le catch-up terminé. Compteurs finaux du heartbeat : 67 052 notifications WebSocket reçues et 39 908 appels d’enqueue terminés. Warm-up depuis le dernier cutover : 46 s. `transactionSubmission=false`; arrêt par SIGINT propre, code 0, après 57 s. Aucun `listener.start_failed` / `CATCH_UP_WINDOW_EXCEEDED`.
- Portée des compteurs : les événements reçus comptent les callbacks WebSocket; les enqueues terminés comptent les appels `enqueue` réussis, pas le nombre de nouvelles lignes distinctes. Cette observation atteste le bootstrap et la réception, pas la stratégie ni le trading.
- **Prochaine action exacte** : effectuer la revue finale pré-canary de l’environnement et des limites; aucun `live:run` ni essai réel n’a été lancé ou autorisé par ce lot.

## État courant — migrations live appliquées à solanabot (2026-10-05)

- Rôle de sauvegarde `haythem.mabrouk` vérifié dans `pg_roles`: `LOGIN`, `SUPERUSER`, `CREATEDB`, `CREATEROLE`, sans expiration. Connexion TCP locale sans mot de passe fourni ou deviné réussie; identité SQL `solanabot`/`haythem.mabrouk`/`public`, hôte `127.0.0.1:5432`. Aucun attribut ni privilège source n’a été modifié.
- Sauvegarde complète custom PostgreSQL 14.18 réussie, code 0, zéro avertissement, inventaire d’archive lisible (1 757 entrées), sans exclusion et avec owners/ACL conservés : `/Users/haythem.mabrouk/Library/Application Support/sol-token-listener/backups/solanabot-20261005T20261005T100408685Z/solanabot-full-before-live-migrations.dump` (3 237 093 octets, mode 600; dossier mode 700).
- Restauration réelle avec `pg_restore --exit-on-error`, sans `--create`, vers la base distincte `solanabot_migverify_20261005_01`: code 0, zéro avertissement. Avant migration, copie et source avaient 47 mêmes lignes `migration_history`, 232 mêmes tables et des comptes de lignes identiques. Copie conservée pour preuve; aucune base n’a été supprimée.
- Essai de migration sur la copie, commande `npm run db:migrate` avec `DATABASE_URL` explicitement pointé sur cette copie et rôle applicatif `solanabot`: les cinq fichiers autorisés appliqués; le second passage a rendu `applied: []`. Les nouvelles tables sont possédées par `solanabot` et les droits DML requis sont présents.
- Migration de la source après revalidation en lecture seule : identité `127.0.0.1:5432` / `solanabot` / rôle `solanabot` / `public`; les seules candidates étaient les cinq fichiers autorisés, leurs SHA-256 correspondaient à l’essai, 0 verrou du migrateur et 0 autre session DB. `npm run db:migrate` a appliqué exactement ces cinq fichiers avec le rôle applicatif; aucune autre migration n’était candidate.
- Contrôle final en lecture seule : 52 versions, les 47 lignes historiques originales et leurs `applied_at` sont conservés; les cinq versions live exactes sont présentes; aucune migration restante. Les quatre tables attendues existent avec 53 colonnes, 32 contraintes et 10 index conformes aux scripts. Propriétaire `solanabot`, droits `SELECT/INSERT/UPDATE/DELETE` présents. Historique, propriétaires/ACL, définitions de colonnes, contraintes, index, schémas et comptes de lignes concordent avec la copie migrée. Les tables live sont vides; aucun faux ordre/fill n’a été inséré.
- Provisionnement : pour les commandes de migration, le sous-processus a reçu explicitement `DATABASE_URL` du rôle applicatif; aucun secret n’a été affiché. `live:run` ne charge pas `.env` et devra recevoir la même variable via l’environnement local protégé. Aucun `live:run`, runtime, wallet, RPC blockchain ou trading n’a été lancé.
- Prochaine action exacte : poursuivre uniquement les contrôles P1 d’environnement explicitement demandés; la base et le schéma live sont installés, mais cela ne valide ni l’environnement mainnet ni un essai de trading.

## Étape intermédiaire — première sauvegarde bloquée (2026-10-05)

- Identité en lecture seule confirmée depuis l’unique `DATABASE_URL` PostgreSQL déjà provisionné : `127.0.0.1:5432`, base `solanabot`, rôle `solanabot`, schéma `public`, `search_path` `"$user", public`, PostgreSQL 14.18. La transaction de contrôle était en lecture seule. Aucun runtime n’avait de session ouverte sur cette base au moment du contrôle.
- Les 47 lignes historiques sont conservées. En comparant les noms exacts du dépôt, les seules migrations pendantes sont `016_live_order_journal.sql` à `020_live_position_market_resolution.sql`, exactement les cinq autorisées.
- Sauvegarde complète bloquée avant toute migration : `pg_dump` 14.18 s’arrête sur le schéma `execution_live_buy_sell_creation_race_1228b5dc0e13461ea0fbfa097`, dont `solanabot` n’a pas `USAGE` et qui appartient à `haythem.mabrouk`. Aucune exclusion de schéma ni modification de droits n’a été faite. L’archive partielle vide (0 octet) est conservée sous `/var/folders/zm/xxmsn8rj14vb619z02pz6y6h0000gq/T/solanabot-upgrade-20261005-BCJxtS/solanabot-before-live-migrations.dump.INCOMPLETE`, mode 600 dans un répertoire mode 700; ce n’est pas une sauvegarde restaurable.
- Aucune restauration d’essai, migration sur copie ou migration cible n’a eu lieu. La base cible reste inchangée par cette opération.
- Prochaine action exacte : l’opérateur doit fournir une méthode de sauvegarde complète autorisée couvrant aussi le schéma inaccessible (ou faire traiter ses droits par son propriétaire/administrateur), puis reprendre par un nouveau dump vérifié, restauration jetable, migration de la copie et revalidation de la cible. Ne pas exécuter `npm run db:migrate` sur `solanabot` avant cette séquence.

## Correction courante — plafond de frais de priorité (2026-10-05)

- **FAIT hors ligne**: `LIVE_MAX_PRIORITY_FEE_LAMPORTS` est obligatoire pour `live:config-check` et `live:run`, en lamports par transaction; `0` autorise les transactions sans frais de priorité et refuse toute demande positive.
- `LiveTransactionExecutor` vérifie le message v0 compilé après assemblage des instructions et avant journalisation/signature. Il valide les variantes Compute Budget prises en charge, calcule le frais de priorité avec `bigint` et arrondi supérieur; sans CU limit explicite, il emploie une borne conservatrice de 200 000 CU par instruction hors Compute Budget, plafonnée à 1 400 000 CU.
- Une transaction signée en reprise n’est jamais modifiée. Si son frais demandé dépasse le plafond courant, le statut reste inconnu et les octets signés ne sont pas rediffusés. Les transferts System Program de premier niveau, donc les tips SOL arbitraires, sont refusés.
- Les SDK verrouillés (`@pump-fun/pump-sdk` 1.36.0, `@pump-fun/pump-swap-sdk` 1.19.0) ne construisent pas de Compute Budget ni de tip sur les BUY/SELL live ciblés; les deux côtés de Pump.fun et SELL PumpSwap traversent le garde commun. Aucun plafond du frais réseau de base n’est fourni ou annoncé.
- Tests ciblés **20/20**; `npm run check:backend`, ESLint ciblé et `git diff --check` passent. Signatures jetables hors ligne et faux transport uniquement; aucun RPC, wallet réel, ordre, base ou bot n’a été utilisé.
- Le plafond choisi par l’opérateur reste à provisionner; P1 cible reste NO-GO et aucun essai réel n’a été exécuté.

## État courant — clôture P1 (2026-10-04T2307Z)

- **NO-GO pour un premier essai** : les variables de cible restent absentes; le host observé est le workspace local, pas une cible d’exploitation confirmée. Aucun RPC distant, accès DB cible, observation ou essai live.
- Les neuf assertions de migrations figées à 015/15 ont été mises en cohérence sans retirer les tests fonctionnels. PostgreSQL temporaire : migrations ciblées **42/42**; suite live/PumpSwap **61/61**, zéro ignoré; `npm run check:backend` et `git diff --check` passent.
- Modèle exact : `docs/operations/live-config-model.md`; template à variables vides : `.env.live.example`.
- Rapprochement live minimal raccordé : export durable RO → index de signatures → cache/collecteur → calculateur transactionnel → rapport JSON/Markdown. Pipeline PostgreSQL jetable + réponses RPC simulées **2/2**, incluant tentative sans signature, transaction échouée et `result:null` sans zéro inventé. Le résultat économique d’une vraie session reste non calculable sans bornes wallet, couverture des flux externes et prix des reliquats.
- Rapport complet : `docs/operations/audits/2026-10-04T2307Z/cloture-p1.md`.

## État historique — validation P1 sur la machine disponible (2026-10-04T2227Z)

- **NO-GO pour un premier essai** : les variables endpoint/genesis, base cible, wallet public, keyfile externe et limites explicites ne sont pas provisionnées dans cet environnement. Aucun RPC distant ni accès à la base cible; `live:network-preflight` et `live:config-check` ont refusé avant action distante. Observation et essai réel non exécutés.
- Vérification offline dans une copie isolée depuis le lockfile : `npm ci --ignore-scripts --no-audit --no-fund`, `npm run check:backend` et suite live ciblée **129 réussis, 0 échoué, 0 ignoré**. La suite DB générale activée échoue sur **9 assertions historiques** qui attendent 015/15 migrations alors que le dépôt courant applique 016–020; détails au rapport P1 horodaté et backlog.
- Correctif matériel minimal : `live:run` exige désormais un `DATABASE_URL` explicite avant `loadConfig`, au lieu d’utiliser le DSN local par défaut. Test `live:run refuses the development database default before any RPC preflight` observé rouge avant correctif puis vert. Aucun autre code de production modifié dans cette passe.
- Fichiers ajoutés/modifiés dans cette passe : `src/cli/live-run.ts`, `tests/live-run.test.ts`, ce point de reprise, `docs/operations/live-readiness-backlog.md` et `docs/operations/audits/2026-10-04T2227Z/rapport-validation-p1.md`. Aucun fichier `.env`, `.key`, preuve ancienne ou base cible n’a été lu/écrit.
- Le contrôle de versions ne valide que le workspace disponible : Node 25.9.0, npm 11.12.1, HEAD de base `33cdd0f`, lockfile SHA-256 `72f9f140682e0ec95c53dda5af1e638eb63bdb7195b7992d057cd41c6e3846e9`; arbre local déjà sale avant cette passe.
- La procédure de premier essai est préparée dans le rapport P1. La commande de rapprochement générique par signature pour une nouvelle session n’est pas encore attestée; le rapport existant vise le format r8.

Prochaine action exacte : provisionner sur la vraie machine cible l’endpoint/quota, genesis hash, base cible et accès RO, wallet public/keyfile externe et profil de risque explicitement validés; lancer ensuite `live:network-preflight` et `live:config-check`, inspecter migrations/ordres/positions en lecture seule, puis réaliser une observation bornée seulement si elle est isolée. Ne pas lancer `live:run` dans cette passe.

## État courant — ventes cashback et découverte directe du pool (2026-10-04)

- B1 FAIT (hors ligne, tests intégrés): un holding suivi peut sortir selon l’état courant vérifié, même si `is_cashback_coin=true`. Pump.fun V2 SELL construit les comptes accumulator avec le Pump SDK verrouillé `@pump-fun/pump-sdk@1.36.0`; PumpSwap SELL ajoute les deux remaining accounts du PumpSwap SDK `@pump-fun/pump-swap-sdk@1.19.0`, valide le PDA Uva et son ATA quote/wSOL, et ajuste les positions des autres comptes dans l’exécuteur. Le flag est persisté dans l’intention SELL et revalidé au moment de construire; récompenses non encaissées ne sont pas ajoutées au produit de vente. Les BUY cashback restent rejetés.
- B2 FAIT (hors ligne, PostgreSQL temporaire + RPC simulé): `PumpSwapDirectPoolVenueReader` dérive la courbe Pump et le pool canonique index-0 à partir de la Pool Authority dérivée du mint, lit les comptes requis par `MarketRpcReader`, valide programme, index, creator PDA du pool, mint/paire, Token Programs, coffres et autorités, puis remet directement l’état à la route persistée et à la quote/vente. Il ne lit pas `market_pools`; l’index peut donc être absent. La provenance RPC/slot/heure et les comptes vérifiés sont persistés. Une absence de pool après courbe complète consomme le budget; une incohérence produit `UNKNOWN` sans vente.
- Test T3 FAIT: processus A ouvre la position puis épuise un contrôle du pool avec le tableau `market_pools` absent du schéma isolé; processus B exécute `live:position:operator recheck` via l’entrée applicative avec RPC de lecture simulé, trouve le PDA sans insertion en base, puis recrée contrôleur et worker; quote PumpSwap et SELL uniques clôturent la position. Le chemin operator ne reçoit qu’une interface de lecture et ne peut pas signer/envoyer.
- Test T4 FAIT: un coffre au mauvais propriétaire fait persister `UNKNOWN`; la position reste `OPEN`, quantité `12345`, seul le BUY confirmé est au journal et aucun SELL n’est signé/envoyé.
- Test T5 FAIT: le même ensemble couvre le refus pré-BUY cashback, les positions SPL et Token-2022 suivies, les ordres ambigus et la reprise sans deuxième SELL après crash.
- Verrou: les refus globaux liés aux anciennes positions cashback et à l’absence de pool indexé ont été retirés; l’admission BUY cashback, pair/extension, activation, risque, cluster/wallet, préflight et contrôles de diffusion restent en place. L’environnement cible et l’essai réel ne sont pas vérifiés/exécutés. Tests fixtures ne prouvent ni mutation on-chain ni exécution on-chain.
- Commandes reproductibles hors réseau utilisées pendant ce lot: `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin node --import tsx --test ...`; PostgreSQL temporaire uniquement via `LIVE_TEST_DATABASE_URL=postgres://codex_test@127.0.0.1:55432/postgres`. Aucun RPC distant, vrai `.env`, clé/wallet réel, bot ou transaction n’a été utilisé.

Vérifications finales exécutées sous environnement `env -i` et PostgreSQL jetable `LIVE_TEST_DATABASE_URL=postgres://codex_test@127.0.0.1:55432/postgres`: suites live/PumpSwap/PostgreSQL ciblées **35 réussies, 0 échouée, 0 ignorée**; suite backend complète **1213 réussies, 0 échouée, 107 ignorées** (tests exigeant `TEST_DATABASE_URL`, non fournie); `npm run check:backend` réussi; ESLint ciblé des modules/tests touchés réussi; `git diff --check` réussi. Le binding natif bigint absent a utilisé le fallback JavaScript. La cible, les quotas, les comptes RPC, préflight et essai réel restent non vérifiés/non exécutés.

Prochaine action exacte: effectuer le préflight P1 sur la machine cible avec endpoint, wallet dédié et limites explicitement choisis; puis revue opérateur avant tout essai réel borné. Aucun changement de stratégie n’est proposé dans ce lot.

## État au début du lot admission et reprise opérateur (historique, 2026-10-04)

- FAIT (hors ligne): le contrôleur consulte le compte bonding curve et le mint lus dans le même contexte que la quote avant BUY. Il refuse cashback, layouts/flags/extensions inconnus, Token Programs et quote pairs hors profil. Les refus sont journalisés sur stderr; les acceptations avec provenance/layout/slot/extensions sont persistées dans l’intention BUY avant signature.
- FAIT (hors ligne): profil de base `create_v2` Token-2022, extensions `MetadataPointer` et `TokenMetadata` seulement, quote wSOL sous SPL Token historique. L’aller-retour Token-2022 avec MetadataPointer traverse deux processus, Pump.fun BUY, migration, PumpSwap SELL, signatures jetables et PostgreSQL temporaire. Les autres extensions sont refusées avant BUY.
- FAIT (hors ligne): migration 019 persiste génération, budget explicite et historique de tentatives. `live:position:operator status` consulte l’incident sans signer/envoyer; `recheck` prend le verrou wallet, rapproche d’abord signatures ambiguës par lectures RPC, attribue un budget borné explicite, consulte le résolveur et valide les comptes du pool par l’adaptateur SELL sans signature ni diffusion.
- VALIDÉ (PostgreSQL temporaire): un test d’épuisement du budget, arrêt/recréation du résolveur, absence de renouvellement implicite, verrou wallet concurrent et réarmement avec une nouvelle génération/budget explicite passe. La suite ciblée actuelle passe 58/58, zéro ignoré; `npm run check:backend` et le lint ciblé du profil/reprise passent. Le lint élargi du chemin live signale 7 violations dans quatre modules déjà présents (`keypair-live-signer.ts`, `network-preflight.ts`, `postgres-live-order-journal.ts`, `pumpfun-bonding-curve-instructions.ts`); aucune correction cosmétique transversale n’a été appliquée.
- BLOQUÉ (activation mainnet): les anciennes positions cashback ne peuvent pas être sorties par les adaptateurs Pump.fun/PumpSwap installés. Le filtre empêche les nouveaux BUY cashback, mais l’immutabilité d’une position après admission n’est pas prouvée par les données locales; `assertPostMigrationExitProfileReady()` reste un refus global. Les comptes PumpSwap venant uniquement de l’index Postgres peuvent aussi manquer si aucune preuve de pool n’a été ingérée.
- Aucune lecture RPC distante, clé, wallet, `.env`, transaction, base existante, préflight cible ou essai réel n’a été utilisé pendant cette continuation.

### Matrice de capacités à ce point historique (SELL cashback ajouté ensuite)

| Base mint Program | Quote mint / Program | Type de coin | BUY bonding curve V2 | SELL bonding curve V2 | SELL après migration | État |
|---|---|---|---|---|---|---|
| SPL Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | wSOL `So11111111111111111111111111111111111111112` / SPL Token | non-cashback, layout reconnu | SDK Pump `1.36.0`, chemin testé | SDK Pump `1.36.0`, frais/quantité en état validé | PumpSwap index 0 / quote SPL, test multi-processus | admis par le chemin technique, live toujours fermé |
| Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | wSOL / SPL Token | non-cashback; `MetadataPointer` et `TokenMetadata` seulement; holder reward permis | SDK Pump `1.36.0`, construit avec Program réel | SELL V2 avec Program réel | PumpSwap SDK `1.19.0`, ATA/vault Token-2022 et extension allowlist stricte; e2e testé avec MetadataPointer | admis sous extensions listées |
| SPL Token ou Token-2022 ci-dessus | quote Token-2022, autre quote mint ou Token Program inconnu | tout | — | — | non couvert | rejet avant BUY |
| SPL Token ou Token-2022 | wSOL / SPL Token | cashback=true, flag/layout inconnu, mint/layout/extension non décodable ou périmé | — | cashback restant accounts non raccordés | cashback remaining accounts non raccordés | rejet; anciens holdings continuent de bloquer live |

Programmes: Pump `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`; PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`; Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. La compatibilité indique seulement que les interfaces locales sont raccordées; elle ne garantit ni liquidité ni exécution future.

Références protocolaires vérifiées: [création `create_v2`](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md) indique un mint Token-2022 avec Metadata Pointer; [cashback](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_CASHBACK_README.md) dit que la création cashback est dépréciée mais que les coins existants restent affectés et que les SELL ajoutent des remaining accounts; [holder rewards](https://github.com/pump-fun/pump-public-docs/blob/main/docs/HOLDER_REWARDS_README.md) documente le booléen ajouté après les champs existants, la conversion possible régulier→holder reward et les mêmes comptes de trade. Ces documents ne démontrent pas que `is_cashback_coin=false` est immuable; le gate ne s’appuie donc pas sur cette hypothèse.

### Commandes opérateur réellement câblées

- Consultation, sans RPC ni signer: `npm run live:position:operator -- status --position <positionId> --wallet <walletPubkey>` avec `LIVE_OPERATOR_DATABASE_URL`.
- Réarmement lecture seule borné: `LIVE_OPERATOR_DATABASE_URL=<url-db> LIVE_OPERATOR_HTTP_RPC_URL=<endpoint> npm run live:position:operator -- recheck --position <positionId> --wallet <walletPubkey> --additional-checks 3`. Remplacer `3` par 1–20 vérifications explicites. Cette commande ne signe pas et n’envoie aucune transaction; les ordres encore ambigus sont rapprochés ou bloquent la reprise.

Prochaine action exacte: ajouter un test PostgreSQL qui invoque `runLivePositionOperatorCli` avec un transport de lecture injecté, afin de vérifier le câblage de commande `recheck` sans RPC distant. Ensuite, raccorder une découverte canonique du pool indépendante de l’index local ou conserver explicitement ce cas en incident. Garder le verrou live fermé tant que les positions cashback restaurées n’ont pas de SELL pris en charge (ou une exclusion sûre prouvée), et tant que le pool ne peut pas être découvert après une migration manquée.

### Historique du lot PumpSwap post-migration

- FAIT (hors ligne): la position durable résout la courbe active, l’attente bornée de pool, l’épuisement des essais, le pool PumpSwap canonique et les états contradictoires. État de route et compteurs sont stockés dans `live_position_market_routes` (migration 018) et relus au redémarrage.
- FAIT (hors ligne): le contrôleur restaure les positions, résout de nouveau le marché sans nouvelle création, bloque une vente concurrente déjà ambiguë, produit une quote PumpSwap fraîche pour le reliquat et réévalue le marché juste avant un SELL préparé depuis la bonding curve.
- FAIT (hors ligne): `PumpSwapLiveSellAdapter` lit le pool, coffres, GlobalConfig, configuration de frais, mint et ATAs dans un seul slot; valide programme/paire/vaults/quantité; conserve le `virtual_quote_reserves` signé en `bigint`; compare montant et minimum au calcul du SDK verrouillé; le constructeur appelle `sellInstructions` réel de `@pump-fun/pump-swap-sdk@1.19.0`.
- FAIT (hors ligne): l’exécuteur vérifie la forme SELL PumpSwap, le pool, les ATA, programmes, coffres, PDA PoolV2 conditionnel et comptes buyback/ATA comparés à l’intention durable. Une vente utilise le journal, signer, transport et rapprochement existants.
- FAIT (PostgreSQL temporaire): deux processus testés; A achète via bonding curve, persiste la route WAITING_FOR_POOL quand migration observée sans pool puis s’arrête; B restaure, résout le pool via le reader de venue, cite et vend par PumpSwap, puis clôture avec un fill SELL unique. La fixture utilise un coin creator non nul pour traverser le compte PoolV2 conditionnel. Elle atteste 1 BUY, 1 SELL, montant 12 345, reliquat nul et aucune quote Pump.fun après migration.
- FAIT (décodage): `Pool.virtual_quote_reserves` garde son signe et sa précision. Le format historique sans le champ utilise zéro uniquement si le compte se termine exactement à l’offset antérieur; valeurs tronquées/partielles sont rejetées. Tests: négatif, zéro, positif et champ absent.
- BLOQUÉ (activation mainnet): la route cashback PumpSwap n’est pas supportée par ce profil et ne peut pas être exclue de façon fiable avant l’achat; `live:run` reste donc refusé avant préflight, signer ou RPC. Le succès hors ligne ne valide pas le programme on-chain.
- À FAIRE (opérations): définir une procédure CLI de reprise après épuisement du suivi du pool; valider l’environnement cible et exécuter l’essai réel ultérieurement par l’utilisateur.
- Aucun RPC distant, wallet réel, vrai `.env`, signature réelle, lancement live, déploiement ou migration de production n’a été utilisé dans ce lot.

### Vérifications du lot PumpSwap

- Avec `LIVE_TEST_DATABASE_URL` pointant uniquement sur PostgreSQL temporaire `codex_test@127.0.0.1:55432/postgres`, les tests live/PumpSwap/stratégie/positions concernés: **40 réussis, 0 échoué, 0 ignoré**. Les tests multi-processus couvrent route WAITING_FOR_POOL en A puis résolution canonique et SELL PumpSwap en B, plus un crash après soumission du SELL et sa résolution au redémarrage sans seconde vente.
- Reproduction de la suite: `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin LIVE_TEST_DATABASE_URL=postgres://codex_test@127.0.0.1:55432/postgres node --import tsx --test tests/live-application.integration.test.ts tests/live-position-repository.postgres.test.ts tests/live-run.test.ts tests/live-position-market-route.test.ts tests/pumpswap-live-sell-instructions.test.ts tests/pumpswap-reserve-reader.test.ts tests/pumpswap-quote.provider.test.ts tests/live-transaction-executor.test.ts tests/live-application.test.ts tests/live-token-reconciliation.test.ts tests/validated-external-buys.strategy.test.ts tests/live-rpc-adapter.test.ts`. L’URL vise l’instance PostgreSQL jetable locale, arrêtée après les tests.
- `npm run check:backend` — réussi, IDL générées Pump.fun/PumpSwap cohérentes et TypeScript compilé.
- ESLint ciblé sur le chemin live/PumpSwap, CLI et tests modifiés — réussi après correction des violations de type/retours dans les fichiers du chemin.
- `git diff --check` — réussi.
- Avertissement runtime non bloquant des dépendances Solana: binding natif bigint indisponible, fallback JavaScript utilisé; les tests passent.
- Les suites DB non incluses dans cette sélection n’ont pas été lancées. Aucun test de réseau ou d’exécution on-chain n’a été exécuté.

### Point de reprise avant le lot courant (historique)

Cette action est remplacée par l’état courant en tête de fichier: admission stricte et commandes opérateur sont implémentées; le gate live reste fermé pour les positions cashback restaurées non couvertes.

### Historique antérieur

Dernière mise à jour : 2026-10-04. Aucun bot, préflight réseau ni exécuteur live configuré n’a été lancé. Aucun wallet réel, vrai fichier de secrets, vrai `.env` ou vraie clé privée n’a été consulté pendant ce chantier; seules des clés jetables hors ligne ont été générées en test.

## Objectif et périmètre

Préparer un chemin live minimal, indépendant d’observe/paper, capable de gérer un aller-retour BUY→SELL ultérieur après activation explicite. Le chantier courant peut modifier code, configuration et documentation, mais n’autorise aucun envoi de transaction, accès à la clé réelle, déploiement ni migration de production.

## Points d’entrée identifiés — à vérifier

- Application observe/paper : `src/app.ts`, factory `src/application/production-listener-factory.ts`, CLI `src/cli/*`.
- Runtime paper : `PaperDecisionWorker`, `ValidatedExternalBuysStrategy`, `CanonicalPaperQuoteRouter`, providers Pump.fun/PumpSwap.
- Runner r8 historique : `docs/operations/evidence/2026-10-04-mainnet-microtrade-r8/canary.mjs` et `session.mjs` — lecture seule du code prévue, jamais exécution.
- Persistance actuelle : repositories Postgres et migrations du projet; compatibilité avec intentions d’ordres durables à établir avant choix d’architecture.

## Lots et tâches

| ID | Priorité | État | Portée / fichiers probables | Preuve ou blocage |
|---|---|---|---|---|
| LIVE-P0-01 | P0 | FAIT | Vérifier runners r8, signer/envoi/confirmation, SDK/IDL/programmes et points d’entrée actuels. | Le runner r8 reste sous preuves; le chemin maintenu actuel est désormais `src/live/` et utilise les dépendances verrouillées. |
| LIVE-P0-02 | P0 | FAIT HORS LIGNE | Frontière d’exécution live séparée; observe/paper sans signer ni envoyer. CLI et factory dédiées. | La composition `live:run` existe; validation de l’environnement cible reste P1. |
| LIVE-P0-03 | P0 | FAIT HORS LIGNE | Activation explicite, cluster/wallet attendu, chargement isolé de secrets, limites non implicites. | Policy et signer isolé testés avec fichiers jetables. La configuration cible et la correspondance du wallet restent non vérifiées. |
| LIVE-P0-04 | P0 | FAIT HORS LIGNE | BUY/SELL via adaptateurs réels, confirmation/quantités, migration et sortie. | BUY/SELL bonding curve et PumpSwap post-migration, cashback pour holdings suivis, rapprochement et reprise passent hors ligne; aucune exécution on-chain observée. |
| LIVE-P0-05 | P0 | FAIT (hors ligne) | Journal durable pré-envoi, verrou wallet, reprise et ambiguïtés. | Processus distincts testés contre PostgreSQL temporaire: un BUY soumis avant crash est restauré sous la même signature puis rapproché sans second BUY; aucun fill fictif avant confirmation. Aucune migration de production. |
| LIVE-P0-06 | P0 | FAIT (mesure câblée) | Raccord du recorder, preuves transactionnelles et rapprochement prudent. | Le recorder existant observe le vrai `CanonicalPaperQuoteRouter`; l’horodatage signal/quote/décision est distinct. Les preuves historiques restent incomplètes. |
| LIVE-P0-07 | P0 | FAIT (hors ligne) | Tests hors ligne d’entrée CLI, sécurité observe/paper, BUY/SELL/erreurs/reprise/limites. | Le scénario multi-processus PaperDecisionWorker→stratégie→contrôleur→exécuteur→PostgreSQL et PumpSwap passe; le CLI exige désormais activation, limites et DB explicites. Aucun test ne simule une validation on-chain réelle. |
| LIVE-P1-01 | P1 | PASS local/hors ligne | Reproductibilité et suites ciblées. | Migrations 42/42, live/PumpSwap 61/61, pipeline d’évidence 2/2, `npm run check:backend` réussi. |
| LIVE-P1-02 | P1 | BLOQUÉ — configuration cible absente | Voir `docs/operations/live-config-model.md`. | Préflight et config-check refusent avec environnement vide; zéro requête RPC. |
| LIVE-P1-03 | P1 | NON EXÉCUTÉ — prérequis absents | Observation réseau bornée sans ordre. | Aucun endpoint/base provisionné; aucun runtime lancé. |
| LIVE-P1-04 | P1 | NON EXÉCUTÉ — interdit dans cette passe | Essai utilisateur borné. | Aucun achat/vente réel autorisé ou exécuté. |
| LIVE-P1-05 | P1 | NON APPLICABLE JUSTIFIÉ | Rapprochement du premier essai avant session suivante. | Aucun premier essai; parcours export→signature→métadonnées→rapport testé hors ligne seulement. |
| LIVE-P2-01 | P2 | TODO | Rapprochement historique r8 et flux externes. | Ne bloque pas le code live; ne certifie pas la comptabilité. |
| LIVE-P2-02 | P2 | TODO | MFE/MAE, acheteurs, volumes et liens wallet. | Analytique hors périmètre d’implémentation. |
| LIVE-P2-03 | P2 | TODO | Études causales sans optimisation sur six trades. | Recherche postérieure, aucune optimisation présente. |
| LIVE-P2-04 | P2 | TODO | Dashboards avancés, HA, multi-RPC. | Évolutivité ultérieure. |
| LIVE-P2-05 | P2 | TODO | Autres stratégies, marchés et positions simultanées. | Profil initial limité à une position et aux venues/types prouvés. |

## Commandes et résultats

- `DOTENV_CONFIG_PATH=/dev/null node --import tsx --test tests/live-policy.test.ts tests/bootstrap-safety.test.ts tests/paper-trading-safety.test.ts` — 21 réussis, 0 échoué. Node a signalé que le binding natif `bigint` est absent et utilisera l’implémentation JS.
- Ces 21 tests avaient encore un environnement parent hérité et ne prouvent pas l’isolation demandée ensuite; ils sont supersédés par la commande `env -i` et le test du fichier sentinel temporaire ci-dessous.
- `env -i PATH=... npm run live:config-check` — refus attendu, code 2, `LIVE_ENABLE must be explicitly true`; aucun secret ou fichier de config chargé.
- `DOTENV_CONFIG_PATH=/dev/null node_modules/.bin/tsc -p tsconfig.json --noEmit` — réussi.
- `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin node --import tsx --test tests/config-isolation.test.ts tests/live-policy.test.ts tests/live-network-preflight.test.ts tests/runtime-quote-recorder.integration.test.ts tests/transaction-evidence.test.ts tests/validated-external-buys.strategy.test.ts tests/bootstrap-safety.test.ts tests/paper-trading-safety.test.ts tests/live-order-journal.test.ts tests/live-pumpfun-instructions.test.ts tests/causal-quote.test.ts tests/position-telemetry-isolation.test.ts tests/position-telemetry-evidence.test.ts tests/pumpfun-paper-quote.provider.test.ts` — 73 réussis, 0 échoué; transport RPC injecté, faux client SQL et états de marché fixtures uniquement. Aucun accès réseau/clé/base.
- `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin node_modules/.bin/tsc -p tsconfig.json --noEmit` — réussi après le lot.
- Avertissement natif `bigint: Failed to load bindings, pure JS will be used` observé pendant les tests; les assertions passent avec le fallback JavaScript.
- `live:network-preflight` — commande ajoutée, non exécutée; le test utilise un transport injecté, 0 requête réelle.
- `npx tsx --test ...` — premier essai bloqué par `EPERM` à l’ouverture d’un socket temporaire tsx; la forme `node --import tsx --test` fonctionne sans socket.
- Aucun runner, application, test connecté, signer ou transaction n’a été lancé.

### Rapprochement des quantités confirmées — lot du 2026-10-04

- `src/live/live-token-reconciliation.ts` calcule les deltas en unités entières natives en agrégeant les comptes token dont `owner` et `mint` correspondent. Il ignore les montants UI/décimales et ne convertit pas une métadonnée absente, un échec d’exécution ou des tableaux absents en quantité nulle.
- Une entrée absente sur un côté n’est traitée comme zéro uniquement si les tableaux `preTokenBalances` et `postTokenBalances` sont tous deux présents; cela couvre création/fermeture ATA lorsque l’autre côté prouve le solde.
- `tests/live-token-reconciliation.test.ts`: 3 tests passent (agrégation multi-comptes et filtrage owner/mint; création de compte; données absentes/échec). Justification: somme arithmétique indépendante des entiers bruts explicitement fournis par la fixture.
- Commande exécutée: `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin node --import tsx --test tests/live-token-reconciliation.test.ts tests/live-transaction-executor.test.ts tests/live-keypair-signer.test.ts tests/live-rpc-adapter.test.ts` — 9 réussis, 0 échoué.
- Compilation exécutée: `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin node_modules/.bin/tsc -p tsconfig.json --noEmit` — réussie. `git diff --check` — réussi.
- À la fin du lot précédent, ce calcul n’était pas encore appelé depuis l’exécuteur; le raccord exécuteur et le dépôt durable sont décrits dans les deux sections suivantes.

#### Liaison exécuteur → delta confirmé

- `src/live/live-transaction-executor.ts` appelle maintenant `reconcileLiveTokenBalance` après confirmation et retourne `tokenBalance` avec le résultat. Le mint provient de l’intention durable (`order.intent.mint`) et le propriétaire du wallet de l’ordre; un mint manquant ou des tableaux absents restent `UNKNOWN`.
- Le test d’exécution vérifie une quantité acquise de `12 345` unités brutes calculée de façon indépendante depuis une fixture de métadonnées où le solde pré-transaction est absent et le post-transaction vaut `12 345`.
- Le test ciblé a été exécuté avant le changement et a échoué car `tokenBalance` était absent; il passe après le raccord. Cette étape ne prouve toujours pas l’écriture du delta dans un dépôt de positions.

#### Dépôt durable des positions — lot courant

- `migrations/017_live_positions.sql` définit les positions live et les fills avec signature unique; `src/live/postgres-live-position-repository.ts` inscrit le fill et met à jour la position dans la même transaction SQL.
- Un BUY connu conserve séparément `walletTokenPreRaw` et `acquiredRaw`; le reliquat initial est le delta positif de la signature, jamais le solde total du wallet. Un BUY confirmé sans métadonnées crée seulement `RECONCILIATION_REQUIRED` avec quantités nulles.
- Chaque signature est idempotente. Un SELL dont les métadonnées sont absentes place la position en rapprochement requis; les métadonnées reçues ensuite pour la même signature peuvent résoudre le fill. Une vente partielle conserve un reliquat `OPEN`, et la clôture exige `remainingRaw=0` issu des deltas.
- Test PostgreSQL temporaire: `tests/live-position-repository.postgres.test.ts`; l’instance locale a été initialisée dans `/tmp/sol-token-live-pg-verify` avec le rôle factice `codex_test`, le port 55432, puis arrêtée. Aucun `.env`, secret, wallet ou réseau externe n’a été utilisé. Les schémas aléatoires créés par le test ont été supprimés par le `finally` du test.
- Commande exécutée en environnement isolé contre cette seule base: `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin LIVE_TEST_DATABASE_URL=postgres://codex_test@127.0.0.1:55432/postgres node --import tsx --test tests/live-position-repository.postgres.test.ts tests/live-order-journal.test.ts tests/live-transaction-executor.test.ts tests/live-token-reconciliation.test.ts` — 13 réussis.
- Un premier essai sandbox de la connexion loopback a échoué (`EPERM`); la même commande a ensuite passé sous l’autorisation d’exécution escaladée uniquement contre la base locale jetable. Pas d’accès RPC distant.
- Aucun test actuel ne traverse encore un candidat réel du `PaperDecisionWorker`, l’adaptateur de candidats, `ValidatedExternalBuysStrategy`, le journal, l’exécuteur, le dépôt de position, un redémarrage complet de l’application et la décision SELL. Aucune commande `live:run` n’existe encore. LIVE demeure bloqué.

### Vérifications après le lot de persistance

- Suite hors réseau avec environnement `env -i`, sans `LIVE_TEST_DATABASE_URL`: `50` réussis, `0` échoué, `2` ignorés (les deux tests PostgreSQL, séparément exécutés contre la base temporaire). Elle inclut `bootstrap-safety`, `paper-trading-safety`, `validated-external-buys.strategy`, `live-policy`, `live-network-preflight`, builders, journal, exécuteur et rapprochement token.
- `node_modules/.bin/tsc -p tsconfig.json --noEmit` — réussi; `git diff --check` — réussi.
- Aucun test ne prouve pour le moment la composition complète demandée; ne pas interpréter les 13 tests PostgreSQL de repository comme le test d’acceptation applicatif.

### Preuves du blocage de l’exécution

- `src/execution/transaction-confirmer.ts` retourne explicitement une erreur au lieu de signer/envoyer.
- `src/dex/raydium-cpmm/transaction-builder.ts` retourne explicitement une erreur.
- `src/launchpads/pumpfun/official-sdk.ts` expose les types et helpers du SDK; l’adaptateur maintenu d’instructions V2 est maintenant `src/live/pumpfun-bonding-curve-instructions.ts`, sans signer ni transport.
- Le seul constructeur Pump.fun V2 BUY/SELL trouvé est le runner historique `docs/operations/evidence/2026-10-04-mainnet-microtrade-r8/canary.mjs`; il charge une clé et envoie, donc il n’a pas été exécuté ni présenté comme exécuteur du projet.
- Aucune route de SELL PumpSwap n’est raccordée à une position live après migration.

### Complément isolation / mesures / réseau

- `src/config/env.ts` ne charge plus dotenv à l’import; `loadConfig(environment)` accepte maintenant une configuration injectée. Les vrais points d’entrée observe/paper chargent dotenv explicitement dans `src/app.ts` et `src/cli/paper-dry-run.ts`; les scripts RPC historiques ont leur propre chargement de CLI.
- `tests/config-isolation.test.ts` crée un fichier sentinel temporaire, lance un sous-processus avec une allowlist d’environnement et prouve que seul l’URL injecté est utilisé et que le sentinel n’est pas chargé.
- `src/live/network-preflight.ts` autorise uniquement `getGenesisHash`, `getVersion`, `getSlot`, séquentiellement, une fois chacun, timeout 5 s; endpoint masqué; aucune signature/transaction. Le préflight réseau sur la machine cible reste NON EXÉCUTÉ.
- `src/telemetry/quote-recorder.ts` garde les horodatages distincts: signal (`signalAtMs`), disponibilité (`availableAtMs`) et décision (`decisionAtMs`, événement séparé après retour de quote). Le test couvre quote disponible avant décision et quote disponible après décision sans réécriture.
- PnL net nul dans l’ancienne fixture car `economicCostRaw` et estimation de frais réseau étaient explicitement `null`. Le nouveau calcul conserve ces motifs; une seconde fixture calcule indépendamment `minimumAmountOut - coût économique - frais réseau connus`, sans retirer à nouveau les frais inclus dans min-out.
- Le collecteur conserve maintenant nom/type, message et cause/code nettoyés, `timeoutMs` et `httpStatus` nullable. Les 20 anciennes tentatives demeurent inchangées et ne sont pas requalifiées rétroactivement.
- Les 20 tentatives de la collecte historique restent toutes `NETWORK_ERROR` sans cause exploitable; aucune tentative de récupération supplémentaire n’a été faite. Le préflight de la machine cible n’a pas été lancé.
- `src/live/postgres-live-order-journal.ts` persiste `PREPARED → SIGNED → SUBMITTED` avant toute diffusion future, conserve exactement les octets signés et la signature, expose les états non résolus sans les transformer en échec et acquiert un verrou advisory par wallet sur une connexion dédiée.

### Adaptateur d’instructions Pump.fun — historique de son premier lot

- `src/live/pumpfun-bonding-curve-instructions.ts` appelle `PUMP_SDK.buyV2Instructions` et `sellV2Instructions` (`@pump-fun/pump-sdk@1.36.0` verrouillé); aucune transaction n’est signée ou diffusée.
- `PumpFunPaperQuoteProvider.quoteAndState()` réutilise la même lecture cohérente que la quote paper et expose Global/curve, le compte bonding curve, mint, Token Program propriétaire et slot décodé. Le constructeur reçoit cet objet comme une unité. `quote()` délègue à cette méthode et garde son contrat de retour inchangé.
- L’adaptateur vérifie la direction des mints, l’égalité du slot de quote et d’état, les bornes u64, les minima cohérents avec le slippage du SDK (précision 0,1 %), les programmes Token/SPL et la quote wSOL SPL. Pour le BUY, la limite de quote est calculée en amont pour que l’ajout de slippage interne du SDK reste sous le budget demandé.
- `tests/live-pumpfun-instructions.test.ts` vérifie les instructions décodées comme `buyV2`/`sellV2`, le refus d’un autre slot, le refus d’un minimum incohérent et le refus d’une bonding curve complète/migrée.
- `tests/live-pumpfun-instructions.test.ts` couvre le chemin quote canonique → état du même slot → instructions SDK. À cette étape historique il n’y avait pas encore de signer; le raccord actuel est décrit dans la section de continuation en fin de fichier.
- Le rapprochement r8 reste conditionnel: aucune métadonnée blockchain complète nouvelle; les `+9 083 040` lamports d’ATA ne sont toujours pas confirmés.

### Exécuteur signé et reprise — état initial de son lot

- `src/live/keypair-live-signer.ts` sépare chargement explicite du keyfile, signature et vérification cryptographique Ed25519. Les tests créent uniquement des keypairs et keyfiles temporaires; le module n’est pas importé par observe/paper.
- `src/live/live-transaction-executor.ts` valide l’allowlist de programmes/comptes et les montants V2, enregistre l’intention avec blockhash/`lastValidBlockHeight`, signe, persiste les octets, marque `SUBMITTED`, puis appelle le transport. Une seule diffusion initiale et un polling de confirmation borné; erreurs réseau/status ambigus restent `UNKNOWN`.
- `resume()` vérifie la signature des octets persistés, le wallet et le blockhash. Si la transaction est encore valide et sans statut trouvé, elle peut seulement rediffuser les mêmes octets/signature; blockhash expiré sans preuve suffisante reste `UNKNOWN` et bloque le remplacement.
- `src/live/solana-live-transaction-rpc.ts` utilise le véritable `Connection`, `maxRetries: 0`, la recherche d’historique de statut et une version transaction maximale 0. Les appels testés utilisent un faux transport; aucun RPC réel n’a été appelé.
- `tests/live-transaction-executor.test.ts` couvre BUY→SELL au niveau transactionnel, vérification des signatures, confirmation, résultat inconnu et reprise par mêmes octets. Les métadonnées du faux transport ne contiennent pas encore de variations de comptes permettant de rapprocher la quantité acquise/vendue.
- Limite à cette étape historique : l’entrée CLI, le signal du worker et le repository position n’étaient pas encore raccordés. Ce raccord est terminé hors ligne dans la section de continuation ci-dessous; PumpSwap et la validation environnementale restent bloquants.

## Prochaine action exacte — état antérieur à la continuation

Cette prochaine action a été exécutée dans la continuation ci-dessous. La prochaine tâche actuelle est indiquée au dernier paragraphe du fichier.

### Continuation du raccord applicatif — 2026-10-04

- Relecture faite: `docs/operations/live-readiness-backlog.md`; aucun `AGENTS.md` trouvé à la racine ou dans les répertoires parents recherchés. État Git initial conservé; il contenait déjà de nombreuses modifications utilisateur non attribuées à ce lot.
- `PaperDecisionWorker` expose le résultat issu d’un job persistant et de son snapshot au callback explicite du flux live candidat. Avec ce callback, la factory laisse le worker en observe et désactive les effets paper. Le comportement normal observe/paper reste inchangé.
- `ValidatedExternalBuysStrategy.evaluateLiveExternalBuys` réutilise les filtres canoniques de la stratégie sans ledger paper; le contrôleur live l’utilise avec les quantités persistées.
- `src/live/live-decision-controller.ts` relie restauration journal→fills/positions, BUY/SELL par l’exécuteur, rapprochement confirmé, déduplication des BUY externes et blocage des ambiguïtés. Le test multi-processus et la commande ne sont pas encore réalisés.
- Scénario rouge commencé: `tests/live-application.test.ts` a d’abord échoué, car `src/application/live-application.ts` n’existait pas. Le nouveau composant partagé CLI/tests impose verrou wallet → restauration → démarrage listener, permet l’arrêt des nouvelles entrées tout en maintenant le listener et libère les ressources à l’arrêt. Son test a révélé puis corrigé un attendu de test incomplet (appel explicite à `stopEntries`).
- Vérification intermédiaire: la compilation TypeScript a réussi; le test ciblé doit être relancé après la correction de son attendu.
- Prochaine action exacte: ajouter l’entrée `live:run` réellement composée avec le contrôleur et la factory listener, tout en refusant l’activation mainnet tant que SELL PumpSwap manque; ensuite prouver par deux processus avec PostgreSQL temporaire le flux PaperDecisionWorker→BUY→restauration→SELL. Aucun contournement de test/public ne sera ajouté.

#### Mise à jour du raccord et de la reprise multi-processus

- La frontière de production est `PaperDecisionWorker.complete()` (`src/application/paper-decision-worker.ts`): après reconstruction réelle du candidat depuis le snapshot canonique, il appelle le consommateur explicite avant de terminer le job. `createProductionListenerRuntime` l’active seulement lorsqu’un consommateur live est fourni; dans ce cas le worker reste en observe et `paperStrategyEnabled=false`. `ObservedTransactionPipeline` enfile un job pour les mints touchés à chaque transaction observée (`src/application/observed-transaction-pipeline.ts`, autour de l’enqueue `paper_decision_enqueue`), ce qui rend les trades ultérieurs disponibles sans nouveau signal de création.
- `src/live/live-decision-controller.ts` restaure d’abord les ordres non résolus puis les fills confirmés sans fill appliqué; il restaure ensuite les positions actives et bloque une nouvelle entrée si un état reste ambigu. Les entrées utilisent `ValidatedExternalBuysStrategy.prepare`; les sorties comptent les transactions canoniques via `evaluateLiveExternalBuys`, puis utilisent le delta confirmé du `LiveTransactionExecutor` et `PostgresLivePositionRepository`. Le dépôt n’utilise pas les soldes paper.
- `src/application/live-application.ts` est le cycle de vie partagé par la commande et le test: acquisition du verrou wallet, restauration, démarrage du listener; `stopEntries()` ne ferme pas le listener ni le suivi. En cas de restauration impossible, la diffusion n’est jamais démarrée.
- `src/cli/live-run.ts` et `package.json` ajoutent `npm run live:run [-- --stop-entries]`. Le CLI ne charge pas dotenv; il vérifie l’activation et le profil, puis son hard gate PumpSwap refuse avant la configuration RPC, le keyfile et le transport tant que la vente après migration n’est pas prise en charge. Aucun argument de test ne contourne ce verrou. `--stop-entries` refuse les nouvelles entrées mais conserve le worker pour suivre/vendre une position restaurée.
- Scénario d’acceptation `tests/live-application.integration.test.ts`: processus A calcule le candidat avec le vrai `PaperDecisionWorker` et `TradingCandidateService`, construit et signe le vrai BUY avec une Keypair jetable, puis le transport simulé termine le processus juste après la soumission. PostgreSQL temporaire contient alors un ordre BUY `SUBMITTED`, sans position ni faux fill. Le processus B reconstruit ses objets; sa fixture RPC ne confirme que la signature BUY lue du journal PostgreSQL, ne rediffuse pas ce BUY et compte exactement un nouvel envoi, le SELL. Il applique le delta +12 345, traite deux livraisons du même job sous `--stop-entries`, confirme une seule vente, puis persiste `CLOSED`, reliquat 0, deux signatures et deux fills appliqués. Les octets signés sont cryptographiquement vérifiés par le transport de fixture; aucun RPC réel n’est appelé.
- Les événements et les réponses RPC sont des fixtures injectées au bord listener/transport; le worker, le service candidat, la stratégie, le contrôleur, le constructeur Pump.fun V2, le signer jetable, l’exécuteur, le journal et le dépôt PostgreSQL sont réels. Le test appelle le même parseur CLI (`parseLiveRunArgs`) et le même cycle de vie (`startLiveApplication`) que le point d’entrée.
- PostgreSQL de test strictement temporaire: `LIVE_TEST_DATABASE_URL=postgres://codex_test@127.0.0.1:55432/postgres`, schéma aléatoire propre au test; migrations 016/017 appliquées uniquement dans ce schéma de test, puis schéma supprimé par le `finally`. L’instance PostgreSQL locale de test a été arrêtée après les vérifications.
- Résultat ciblé intermédiaire réellement exécuté avec `env -i` et cette URL: 60 tests passés, 0 échoué, 0 ignoré, incluant l’intégration multi-processus, worker, stratégie, journal, exécuteur, repository PostgreSQL et builders. Le scénario multi-processus renforcé a ensuite repassé séparément après ajout de la fixture de signature connue.
- Suite backend complète réellement exécutée après le dernier correctif: `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin LIVE_TEST_DATABASE_URL=postgres://codex_test@127.0.0.1:55432/postgres node --import tsx --test tests/*.test.ts` — 1 188 passés, 0 échoué, 107 ignorés (suites générales réclamant spécifiquement `TEST_DATABASE_URL`); le test live d’intégration PostgreSQL et les tests live repository ont utilisé `LIVE_TEST_DATABASE_URL`. Le serveur PostgreSQL jetable a été arrêté. `npm run check:backend` et le lint ciblé sur les fichiers applicatifs/tests ajoutés ont réussi; `git diff --check` réussi.
- Une passe ESLint plus large incluant les composants `live-decision-controller`, `postgres-live-order-journal`, `postgres-live-position-repository` et l’ancien test worker a retourné 30 violations de règles stylistiques/typées dans ces fichiers; cette passe n’est pas verte. Le lint des fichiers nouveaux de ce raccord, du helper d’intégration et de la stratégie/test modifiés a ensuite réussi. Aucun de ces avertissements n’a été transformé en changement transversal dans ce lot.
- Contrôle matériel ajouté au scénario: une identité de trade canonique répétée deux fois dans un même snapshot comptait deux fois dans l’évaluation live. Test d’abord rouge, puis corrigé par déduplication incrémentale dans `ValidatedExternalBuysStrategy`; le même ID ne peut plus atteindre prématurément la cible à lui seul. Cela protège l’idempotence des événements et ne change pas le seuil de stratégie.
- État restant: `LIVE-P0-02`/`LIVE-P0-04` ne permettent toujours pas l’activation mainnet. PumpSwap post-migration n’a pas de SELL live; le hard gate est en place. La commande production n’a pas été lancée; aucun préflight machine cible ni essai réel n’a eu lieu. L’intégration démontre le câblage hors ligne, pas l’exécution on-chain ni la rentabilité.
- Prochaine action exacte: implémenter et tester le SELL PumpSwap d’une position migrée dans un lot distinct; garder le hard gate de `live:run` jusqu’à réussite. Ensuite seulement, vérifier l’environnement cible (préflight RPC, endpoint/quota, keyfile externe et wallet dédié) puis laisser l’utilisateur décider d’un essai borné. Aucun live n’a été lancé ici.
## Continuation actuelle — bootstrap listener (2026-10-05)

- A1 confirmé par la vérification read-only bornée : le checkpoint launchpad slot `453623653` était plus ancien que le slot minimal `453638909` des 2 000 signatures lues (20 × 100), signature absente. Pas de rebase de plus dans ce lot.
- Démarrage local raccordé : ack WS d'abord, frontier finalized ensuite, catch-up filtré jusqu'à cette frontier, inbox existante pour la déduplication, checkpoint après enqueue durable. `maxPages` reste 20; page size par défaut passe à 1000. Une page courte sans retrouver un checkpoint durable est maintenant un échec, pas un gap silencieux.
- Tests ciblés : 101 passés. Suite isolée supplémentaire : 54 passés et 13 ignorés faute de `TEST_DATABASE_URL`. `npm run check:backend` et ESLint ciblé passés.
- Observation cible unique : code de sortie 1 après environ 7 s; `foundation_ready` confirme observe et `transactionSubmissionEnabled=false`; checkpoints inchangés. Aucun heartbeat frais, WS connecté ou compte d'événements obtenu. L'extracteur a cherché `diagnostic`, tandis que l'événement expose `diagnostics[]`; la cause de l'échec n'a pas été conservée. Aucun second lancement n'a été effectué.
- **État courant : bootstrap hors ligne testé, démarrage cible non validé.** Prochaine action exacte : après autorisation distincte, une seule nouvelle observation avec un extracteur qui lit `diagnostics[]` et n'émet que les champs sûrs ; ne pas rebaser automatiquement. Si une fenêtre reste dépassée, capturer programme et bornes avant toute décision.
