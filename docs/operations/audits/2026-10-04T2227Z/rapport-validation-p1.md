# Validation P1 de l’environnement — 2026-10-04T2227Z

## Résultat exécutif

**NO-GO pour un essai mainnet borné.** Le code ciblé compile et 129 tests live/PumpSwap/telemetry passent dans un environnement isolé, mais cette machine n’a reçu ni endpoint RPC, ni base cible, ni wallet public dédié, ni keyfile désigné, ni limites monétaires. Le préflight réseau n’a donc effectué **aucune requête**. La cible de production n’est pas identifiée et n’a pas été validée.

Une garde logicielle minimale a aussi été ajoutée : `live:run` exige désormais un `DATABASE_URL` explicite et refuse le DSN de développement implicite avant de charger la configuration ou de contacter RPC. Son test a été observé rouge puis vert. Cela ne fournit pas la configuration absente.

## Machine, version et isolation

- Machine du workspace : `mac-90221-jn13.user.as30781.net`; répertoire : `/Users/haythem.mabrouk/workspace/perso/sol-token-listener`. Cette identité ne prouve pas qu’il s’agit de la machine cible d’exploitation.
- Node `v25.9.0`, npm `11.12.1`.
- Commit de base `33cdd0f`; arbre déjà sale avant cette passe : 106 entrées modifiées/non suivies. Aucun changement préexistant n’a été réinitialisé ni nettoyé.
- SHA-256 de `package-lock.json` : `72f9f140682e0ec95c53dda5af1e638eb63bdb7195b7992d057cd41c6e3846e9`.
- Reproductibilité vérifiée dans `/tmp/sol-token-listener-p1.7ktyiQ/project`, copie de l’arbre de travail comprenant ses changements, sans `.git`, `.worktrees`, `.env`, `.key`, `node_modules`, `dist` ni `.idea`. Les fichiers `.env`/`.key` n’ont pas été lus. `npm ci --ignore-scripts --no-audit --no-fund` a installé 445 paquets depuis le lockfile.
- PostgreSQL utilisé pour les tests seulement : instance temporaire locale `127.0.0.1:55432`, base `postgres`, schémas de tests aléatoires. Aucune URL de base cible n’était disponible. L’instance temporaire a été arrêtée après les contrôles.

## Résultats des contrôles

| Contrôle | Statut | Commande exécutée | Preuve / action restante |
|---|---|---|---|
| Installation lockfile isolée | PASS | `npm ci --ignore-scripts --no-audit --no-fund` | 445 paquets installés dans la copie temporaire; aucune modification du workspace par npm. |
| Compilation backend et IDL | PASS | `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin npm run check:backend` | Générateurs Pump/PumpSwap et `tsc --noEmit` terminés avec code 0, après la garde DB. |
| Tests du chemin live | PASS | `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin LIVE_TEST_DATABASE_URL=postgres://codex_test@127.0.0.1:55432/postgres node --import tsx --test tests/live-*.test.ts tests/pumpswap-*.test.ts tests/validated-external-buys.strategy.test.ts tests/causal-quote.test.ts tests/runtime-quote-recorder.integration.test.ts tests/position-telemetry*.test.ts` | 129 réussis, 0 échoué, 0 ignoré. PostgreSQL jetable; réseau Solana simulé; clés jetables seulement dans les tests existants. |
| Suite backend sans `TEST_DATABASE_URL` | PARTIEL | `env -i PATH=... LIVE_TEST_DATABASE_URL=... node --import tsx --test tests/*.test.ts` | Exécution antérieure à la garde : 1 213 réussis, 0 échoué, 107 ignorés. Les ignorés sont des tests PostgreSQL génériques exigeant `TEST_DATABASE_URL`; ce n’est pas une validation de ces tests. |
| Suite backend avec les deux URL pointant vers PostgreSQL jetable | FAIL | `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin TEST_DATABASE_URL=postgres://codex_test@127.0.0.1:55432/postgres LIVE_TEST_DATABASE_URL=postgres://codex_test@127.0.0.1:55432/postgres node --import tsx --test --test-reporter=dot tests/*.test.ts` | Code de sortie 1, 9 tests historiques échouent : leurs assertions s’arrêtent à `015_paper_active_session_per_mint.sql`, tandis que le migrateur courant applique aussi `016–020`. La suite ciblée des migrations donne 33/42, 9 échecs, 0 ignoré, pour la même divergence (dont `migration-lock.test.ts`, 20 migrations reçues contre 15 attendues). Les assertions sont obsolètes vis-à-vis des migrations live présentes; aucune erreur de migration live n’a été démontrée. Ces tests génériques ne sont pas corrigés dans ce passage. |
| Garde d’absence de `DATABASE_URL` | PASS | `env -i PATH=... node --import tsx --test tests/live-run.test.ts` | TDD : le nouveau test a échoué avant changement car la configuration atteignait `loadConfig`; après garde, 4/4 tests passent. Aucun RPC n’est appelé dans le test (URL `file:` rejetée après la nouvelle garde). |
| `live:network-preflight` | NON EXÉCUTÉ — configuration refusée | `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin npm run live:network-preflight` | Code 2 : `LIVE_RPC_URL and LIVE_EXPECTED_GENESIS_HASH are required`; 0 requête HTTP. Aucun RPC public n’a été choisi par défaut. |
| `live:config-check` | NON EXÉCUTÉ — configuration refusée | `env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin npm run live:config-check` | Code 2 : `LIVE_ENABLE must be explicitly true`. Aucun signer ni keyfile chargé. |
| Base cible, schéma, migrations, ordres, positions, instance concurrente | NON EXÉCUTÉ | Aucune commande DB cible | `DATABASE_URL` et `LIVE_OPERATOR_DATABASE_URL` absents. Pas d’accès en lecture possible. Migrations requises par `live:run` : `016_live_order_journal.sql` à `020_live_position_market_resolution.sql`; leur état cible est inconnu. |
| Solde, genesis, programmes, comptes Pump, bonding curve et pool canonique | NON EXÉCUTÉ | Aucun RPC distant | Endpoint, genesis attendu et wallet public manquants. 0 requête de ce passage; aucun quota consommé. |
| Observation réseau sans ordre | NON EXÉCUTÉ | Aucune commande d’observation lancée | `npm run dev` utilise le bootstrap d’application qui charge dotenv et peut migrer/écrire en base; le listener est durable et sans borne de 120 s intégrée. `paper:dry-run` lit aussi sa configuration et ses dépendances. Sans endpoint/base isolés, ces chemins n’ont pas été lancés. Les tests prouvent des frontières d’import, pas une observation sur la cible. |
| Simulation réseau non signée | NON EXÉCUTÉ | — | Pas de transport/état de cible disponible. Les tests hors ligne ne simulent pas les comptes du wallet cible. |
| Keyfile cible et correspondance avec la clé publique | NON EXÉCUTÉ | Aucun fichier inspecté | Aucun chemin `LIVE_KEYPAIR_FILE` fourni. Aucun `.key` n’a été ouvert, staté ou chargé. |
| Premier aller-retour et rapprochement | NON EXÉCUTÉ | Aucune commande de trading lancée | Explicitement hors périmètre de cette passe. Aucun `live:run`, envoi, signature réelle ou transaction n’a eu lieu. |

### Diagnostic de la suite DB générique

Les neuf échecs sont concentrés sur les migrations historiques : les tests attendent encore que la dernière migration soit `015` (ou 15 migrations), alors que le répertoire courant contient également les migrations live `016–020`. La suite ciblée du chemin live passe séparément avec PostgreSQL jetable. Cette passe ne conclut pas à un défaut du migrateur live, mais la suite backend complète avec toutes les variables DB activées n’est pas verte et doit être remise en cohérence avant de revendiquer une validation complète de toutes les suites.

## Configuration et actions opérateur manquantes

Valeurs à fournir par le gestionnaire de secrets/provisionnement de la cible, sans les inscrire dans le dépôt, l’historique shell ou ce rapport :

1. Endpoint HTTPS autorisé et quota explicite. Fournir `LIVE_RPC_URL` pour le préflight et le même fournisseur sur `SOLANA_HTTP_RPC_URL` pour le runtime; `SOLANA_WS_RPC_URL` doit aussi être défini. Ne pas mettre les credentials dans le rapport. Fournir le genesis hash mainnet attendu.
2. Nom/host/base/schéma cible et accès de lecture permettant l’inspection; URL d’écriture live `DATABASE_URL` explicite. Le test du schéma doit confirmer migrations 016–020, et les lectures doivent rechercher ordres/positions non résolus et verrous/instances du wallet.
3. Clé publique canonique du wallet dédié, endpoint de lecture pour l’opérateur, chemin absolu d’un keyfile externe protégé. L’opérateur doit dériver la clé publique localement (par exemple avec un outil wallet local qui n’imprime que la clé publique), comparer au `LIVE_EXPECTED_WALLET`, puis vérifier les permissions du fichier. Cette vérification n’a pas été faite ici.
4. Profil de risque choisi explicitement : `LIVE_BUY_AMOUNT_LAMPORTS`, `LIVE_MAX_EXPOSURE_LAMPORTS`, `LIVE_MAX_LOSS_LAMPORTS`, `LIVE_EXIT_RESERVE_LAMPORTS`, `LIVE_MAX_SLIPPAGE_BPS`, `LIVE_MAX_SESSION_SECONDS`; `LIVE_MAX_BUYS=1` est imposé par le parseur. Aucun montant ne peut être repris du solde ou d’une ancienne session.
5. Activation explicite `LIVE_ENABLE=true`, listener/configuration stratégie v1 valide, paire wSOL permise, `POSTGRES_AUTO_MIGRATE=false`, vérification du préflight depuis la machine cible et revue des positions/ordres existants.
6. Une commande générique de rapprochement du premier essai reste à établir. `scripts/report-transaction-evidence.ts` lit un format `wave-*/canary.jsonl` et produit un rapport explicitement étiqueté r8; `scripts/report-position-telemetry.ts` n’est pas un rapprochement blockchain par signature. Ne pas présenter ces commandes comme un rapprochement de la nouvelle session.

La base cible ne peut pas être déclarée en retard puisque son état n’a pas été lu. Après raccord d’une session SQL explicitement RO à la base/schéma cible, ces requêtes ne modifient rien et permettent l’inspection :

```sql
SELECT version FROM migration_history
WHERE version = ANY(ARRAY[
  '016_live_order_journal.sql', '017_live_positions.sql',
  '018_live_position_market_route.sql', '019_live_position_market_route_recovery.sql',
  '020_live_position_market_resolution.sql'
]::text[])
ORDER BY version;

SELECT order_id, side, status, signature, position_id, created_at
FROM live_orders
WHERE wallet = '<walletPubkey>'
  AND status IN ('PREPARED', 'SIGNED', 'SUBMITTED', 'UNKNOWN')
ORDER BY created_at, order_id;

SELECT position_id, mint, token_program, status, remaining_raw,
       buy_signature, sell_signature, updated_at
FROM live_positions
WHERE wallet = '<walletPubkey>'
  AND status <> 'CLOSED'
ORDER BY updated_at, position_id;
```

Remplacer le wallet public localement et confirmer le `search_path` de la session SQL. Si une lecture RO établit que des migrations manquent, la commande existante est `npm run db:migrate`; elle applique les migrations et importe dotenv, donc elle **n’a pas été exécutée** et doit être planifiée séparément sur la base explicitement vérifiée, après sauvegarde et approbation opérateur. `live:run` ne migre jamais et refusera si 016–020 sont absentes.

## Procédure préparée — à ne pas exécuter pendant ce passage

Avant tout lancement, injecter les valeurs ci-dessus depuis le gestionnaire de secrets sur la machine cible, puis vérifier que `LIVE_RPC_URL` et `SOLANA_HTTP_RPC_URL` visent la même cible. Aucun argument CLI ne porte de secret.

1. `npm run live:network-preflight` — lecture de genesis/health bornée; exige endpoint et genesis hash.
2. `npm run live:config-check` — valide l’activation et les limites; `CONFIGURATION_VALID_ONLY` ne signifie pas readiness.
3. Inspection DB en lecture seule (outil SQL opérateur) : schéma cible, migrations 016–020, ordres/positions actifs ou inconnus, instance et verrou wallet.
4. Premier démarrage, lancé uniquement par l’utilisateur : `npm run live:run`. La politique actuelle impose un seul BUY maximum durable par wallet, y compris après redémarrage, et une position active à la fois. `LIVE_MAX_SESSION_SECONDS` arrête les nouvelles entrées mais ne termine pas le suivi d’une position existante. Ne pas terminer le processus tant qu’une position reste gérée ou qu’un incident n’est pas traité.
5. Surveillance sans signer : `LIVE_OPERATOR_DATABASE_URL='<dsn-operateur>' npm run live:position:operator -- status --position '<positionId>' --wallet '<walletPubkey>'`. Remplacer les marqueurs localement; ne pas copier le DSN dans le shell partagé.
6. Si reprise de vérification de pool nécessaire : arrêter d’abord le processus live et attendre libération du verrou; puis `LIVE_OPERATOR_DATABASE_URL='<dsn-operateur>' LIVE_OPERATOR_HTTP_RPC_URL='<endpoint-autorise>' npm run live:position:operator -- recheck --position '<positionId>' --wallet '<walletPubkey>' --additional-checks '<1..20>'`. Remplacer les marqueurs localement. C’est une lecture opérateur bornée, pas une autorisation de SELL. Pour reprendre le suivi après arrêt, lancer une seule instance : `npm run live:run -- --stop-entries`.
7. Arrêt propre après clôture/incidence résolue : envoyer SIGINT au processus live courant. `--stop-entries` est un argument de démarrage, pas un contrôle adressé à un processus déjà lancé; ne démarrer aucune seconde instance avec le même wallet.
8. Après le futur essai, ne pas démarrer une seconde session avant qu’un outil de rapprochement par signatures BUY/SELL, fee payer, balances, fees et reliquats soit validé. Aucun script générique adapté au format du nouveau live n’est actuellement attesté.

Aucune migration, observation réseau, transaction simulée sur un RPC, commande `live:run`, signature réelle, transfert, vente ou achat n’a été exécuté.
