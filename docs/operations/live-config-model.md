# Modèle de configuration live et observation

Ce modèle est extrait du code courant au 2026-10-05. Il ne contient aucune valeur de mise, aucun wallet de session historique et aucun endpoint récupéré dans une archive. Le fichier d’exemple associé est [`../../.env.live.example`](../../.env.live.example).

## Variables et validations effectives

| Variable | Unité / nature | Requise pour | Secret ? | Validation réellement appliquée |
|---|---|---|---|---|
| `LIVE_ENABLE` | booléen d’activation | `live:config-check`, `live:run` | Non | valeur exacte `true`; l’exemple reste `false` |
| `LIVE_EXPECTED_GENESIS_HASH` | hash genesis base58 | config-check, preflight, live | Public | clé base58 canonique de 32 octets |
| `LIVE_EXPECTED_WALLET` | clé publique base58 | config-check, live | Public | clé base58 canonique de 32 octets; doit correspondre au keyfile lors du chargement live |
| `LIVE_KEYPAIR_FILE` | chemin absolu externe au dépôt | config-check, live | Chemin sensible, contenu du fichier secret | chemin absolu hors racine du projet. `config-check` ne lit pas le fichier; live le charge après ses contrôles |
| `LIVE_BUY_AMOUNT_LAMPORTS` | lamports par achat | config-check, live | Non, mais valeur financière | entier décimal canonique strictement positif |
| `LIVE_MAX_EXPOSURE_LAMPORTS` | lamports d’exposition totale | config-check, live | Non, mais valeur financière | entier décimal canonique positif et supérieur ou égal au montant d’achat |
| `LIVE_MAX_LOSS_LAMPORTS` | lamports, seuil de protection | config-check, live | Non, mais valeur financière | entier décimal canonique positif, inférieur ou égal à l’exposition; ne garantit pas la perte finale |
| `LIVE_EXIT_RESERVE_LAMPORTS` | plancher de SOL natif laissé disponible après le débit maximal d'un nouveau BUY ; une vente d'une position suivie peut utiliser ce plancher | config-check, live BUY | Non, mais valeur financière | entier décimal canonique strictement positif; doit dépasser `LIVE_MAX_PRIORITY_FEE_LAMPORTS` |
| `LIVE_MAX_PRIORITY_FEE_LAMPORTS` | plafond de frais de priorité demandé, par transaction, en lamports | config-check, live | Non, mais valeur financière | entier décimal canonique supérieur ou égal à zéro; `0` interdit tout frais de priorité demandé. Contrôle le message v0 compilé avant signature, à partir des instructions Compute Budget finales |
| `MAX_PRIORITY_FEE_LAMPORTS` | variable héritée de configuration générale, en lamports | aucun contrôle de sécurité live | Non | parsée par `loadConfig`, mais le constructeur Raydium courant ne l’applique pas; ne la confondre pas avec `LIVE_MAX_PRIORITY_FEE_LAMPORTS` |
| `LIVE_MAX_SLIPPAGE_BPS` | points de base | config-check, live | Non | entier canonique de 1 à 1 000 |
| `LIVE_MAX_BUYS` | nombre d’achats | config-check, live | Non | entier canonique; seule valeur admise : `1` |
| `LIVE_MAX_SESSION_SECONDS` | secondes | config-check, live | Non | entier canonique de 1 à 3 600; arrête les entrées, pas le suivi d’une position |
| `LIVE_RPC_URL` | URL RPC HTTP(S) | `live:network-preflight` autonome | À traiter comme secret si credentialisée | HTTPS requis par le préflight; URL credentialisée refusée; trois lectures séquentielles au plus |
| `SOLANA_HTTP_RPC_URL` | URL RPC HTTP(S) | observation, live, collecte RPC | À traiter comme secret si credentialisée | URL HTTP(S) valide dans `loadConfig`; le préflight interne de live impose HTTPS |
| `SOLANA_WS_RPC_URL` | URL RPC WS(S) | observation et live | À traiter comme secret si credentialisée | URL `ws:` ou `wss:` valide; pour la cible, provisionner une URL sécurisée compatible avec le fournisseur |
| `DATABASE_URL` | DSN PostgreSQL | observation et live | Oui si identifiants intégrés | requis explicitement par `live:run`; ce chemin interdit le DSN de développement par défaut. Les migrations live 016–020 doivent déjà être appliquées |
| `SOLANA_CLUSTER` | identifiant de cluster | observation et live | Non | défaut `mainnet-beta`; live refuse toute autre valeur |
| `SOLANA_COMMITMENT` | niveau RPC | observation et live | Non | enum `processed`, `confirmed` ou `finalized`; défaut `confirmed` |
| `SOLANA_FINALITY_COMMITMENT` | niveau de confirmation | observation et live | Non | `confirmed` ou `finalized`; défaut `finalized` |
| `LISTENER_ENABLED` | booléen | observation et live | Non | `true`/`false`; live exige actif; défaut `true` |
| `LISTENER_ROLLING_CATCH_UP_INTERVAL_MS` | cadence fallback en millisecondes entre débuts de sweeps finalized | observation et live | Non | entier canonique de 5 000 à 120 000; défaut 15 000. Utilisée lorsqu’aucune cadence par programme n’est définie. Le réglage ne garantit pas la capacité. |
| `LISTENER_ROLLING_CATCH_UP_LAUNCHPAD_INTERVAL_MS` | cadence launchpad en millisecondes | observation et live | Non | entier canonique de 5 000 à 120 000; défaut/fallback global 15 000. Premier sweep immédiat; pas de chevauchement par programme. |
| `LISTENER_ROLLING_CATCH_UP_MARKET_INTERVAL_MS` | cadence market en millisecondes | observation et live | Non | entier canonique de 5 000 à 120 000; défaut/fallback global 15 000. La capacité doit être vérifiée avec les compteurs par sweep et le quota RPC; `DEGRADED` reste visible si la fenêtre de 20 000 signatures ou le quota est dépassé. |
| `POSTGRES_AUTO_MIGRATE` | booléen | observation et live | Non | `true`/`false`; live exige `false`; défaut `false` |
| `EXECUTION_MODE` | enum d’application | observation | Non | `observe` ou `paper`; défaut `observe`. Le mode live passe par `live:run`, pas par cette variable |
| `PAPER_STRATEGY_ENABLED` | booléen | observation | Non | `true`/`false`; défaut `false`; laisser explicitement `false` pour l’observation sans effet paper |
| `QUOTE_OBSERVATION_ENABLED` | booléen | observation instrumentée | Non | `true`/`false`; défaut `false` |
| `QUOTE_OBSERVATION_PATH` | chemin de fichier local | observation instrumentée | Non | chemin utilisé tel quel; défaut `data/quote-observations.v1.jsonl`; prévoir droits et espace disque |
| `API_ENABLED` | booléen | application d’observation | Non | `true`/`false`; utiliser `false` si l’API n’est pas requise |
| `DASHBOARD_ENABLED` | booléen | application d’observation | Non | `true`/`false`; utiliser `false` si le tableau de bord n’est pas requis |
| `SOLANA_KEYPAIR_PATH` | chemin de clé ancien | aucun; doit rester absent | Ne pas renseigner | le parser observe/paper/live refuse si cette variable contient une valeur |
| `SOLANA_PRIVATE_KEY_BASE58` | clé secrète ancienne | aucun; doit rester absent | Secret interdit dans ce chemin | le parser observe/paper/live refuse si cette variable contient une valeur |
| `LIVE_OPERATOR_DATABASE_URL` | DSN PostgreSQL opérateur | commandes status/recheck et export d’évidence | Oui si identifiants intégrés | non vide; exporter utilise une transaction PostgreSQL `READ ONLY`; aucun DSN cible n’est disponible à ce jour |
| `LIVE_OPERATOR_HTTP_RPC_URL` | URL HTTP RPC | `live:position:operator recheck` | À traiter comme secret si credentialisée | non vide dans le CLI, puis consommée par le client Solana; commande bornée en lectures; status n’en a pas besoin |

`live:config-check` consomme toutes les variables `LIVE_*` du tableau sauf `LIVE_RPC_URL`; il n’a besoin ni d’un accès RPC, ni d’un accès à la base, ni du contenu du keyfile. Le préflight autonome consomme seulement `LIVE_RPC_URL` et `LIVE_EXPECTED_GENESIS_HASH`; un keyfile absent ne doit donc pas bloquer cette vérification RPC indépendante.

`MAX_PRIORITY_FEE_LAMPORTS` n’applique pas ce garde-fou; le live utilise exclusivement le nouveau `LIVE_MAX_PRIORITY_FEE_LAMPORTS`. Celui-ci plafonne uniquement le frais de priorité demandé par une transaction. Avec `SetComputeUnitPrice` et `SetComputeUnitLimit`, le coût demandé est `ceil(price_microLamports × unit_limit / 1 000 000)` lamports, calculé en entiers exacts. Sans limite explicite d’unités, le contrôle emploie une borne conservatrice de 200 000 CU par instruction hors Compute Budget, plafonnée à 1 400 000 CU; l’allocation runtime exacte peut être inférieure selon la classe d’instruction et les features actives. Les variantes Compute Budget heap-frame et loaded-account-data reconnues sont validées; les variantes dépréciées/inconnues, données mal formées et doublons sont refusés avant signature. Ce plafond ne couvre ni les frais Pump/PumpSwap, ni les loyers de comptes. Les builders Pump.fun V2 et PumpSwap verrouillés (`@pump-fun/pump-sdk` 1.36.0 et `@pump-fun/pump-swap-sdk` 1.19.0) ne construisent actuellement ni instruction Compute Budget ni tip. L’exécuteur refuse également tout transfert System Program de premier niveau, donc aucun tip SOL arbitraire n’est accepté; le garde inspecte le message final après assemblage. Une transaction signée déjà persistée est reprise avec ses octets d’origine : si elle dépasse le plafond actuellement configuré, elle n’est pas rediffusée et reste non résolue; ses octets ne sont jamais modifiés.

Avant le journal critique et la signature d’un BUY, l’exécuteur lit le solde SOL du wallet et exige une observation datée et contextualisée, âgée d’au plus `paperQuoteMaxAgeMs` (5 secondes dans la cible actuelle). Il calcule en lamports entiers : `budget BUY maximal + getFeeForMessage(message final) + loyer minimum d’un ATA base éventuellement créé + LIVE_EXIT_RESERVE_LAMPORTS`. `getFeeForMessage` couvre déjà frais de base et de priorité : le plafond de priorité n’est pas additionné une seconde fois. La création d’ATA est limitée à l’ATA dérivée pour le mint/programme de la position; sa taille est la taille SPL de base (165 octets), le profil d’éligibilité refusant les extensions Token-2022 qui imposeraient une taille de compte différente. Balance, contexte de frais, loyer ou montant manquant/périmé : BUY refusé avant journalisation, signature et diffusion. Le garde ne bloque pas le SELL d’une position existante, qui peut consommer la réserve.

Le config-check applique un minimum statique prudent : `LIVE_EXIT_RESERVE_LAMPORTS > LIVE_MAX_PRIORITY_FEE_LAMPORTS`, afin que le plancher puisse couvrir le plafond de priorité maximal et laisser quelque chose pour le frais de base. Cela ne prouve pas que la réserve suffira à tous les frais futurs d’un SELL ni au financement d’un ATA quote wSOL éventuellement créé sur PumpSwap; le chemin SELL vérifie ses besoins au moment de l’exécution et un déficit reste un incident, jamais une clôture fictive. Les frais protocole et les loyers immobilisés/récupérables ne sont pas bornés par ces deux variables.

`live:config-check` exige aussi `LIVE_ENABLE=true` et vérifie uniquement les champs; il ne signe ni n’envoie. Le modèle garde `LIVE_ENABLE=false` pour bloquer par défaut. Pour contrôler une politique complète, l’opérateur devra activer `true` dans l’environnement temporaire de ce seul processus; ne réutiliser ce même environnement pour `live:run` qu’après une autorisation distincte.

Le chemin `npm run dev` appelle `dotenv.config()` dans `src/app.ts` et peut donc charger le `.env` du répertoire courant. Les commandes `live:config-check`, `live:network-preflight`, `live:run`, `live:position:operator`, `live:evidence:export`, `live:evidence:collect` et `live:evidence:report` ne chargent pas automatiquement dotenv : elles lisent l’environnement du processus. Le fichier `.env.live.example` est un modèle et n’est pas chargé automatiquement. Injecter les valeurs par le gestionnaire de secrets de la machine ou l’environnement du service/processus; ne pas mettre les valeurs credentialisées en arguments de commande ni dans l’historique shell.

L’observation démarre un vrai listener et écrit dans la base désignée. `EXECUTION_MODE=observe` et `PAPER_STRATEGY_ENABLED=false` empêchent les ordres paper/live dans cette application, mais le chemin peut recevoir des événements réseau et persister des données. Le recorder n’écrit des quotes que lorsqu’un chemin applicatif produit effectivement une quote; son activation ne crée pas de quote artificielle.

## Modèle sans valeur financière implicite

Les champs financiers restent vides exprès. Remplir ces choix avant `live:config-check`; ne remplacer aucun champ par un solde wallet ou un ancien montant de session.

```dotenv
# Préflight RPC autonome: peut être fourni sans keyfile ni base.
LIVE_RPC_URL=
LIVE_EXPECTED_GENESIS_HASH=

# Profil live explicite; LIVE_ENABLE reste false jusqu'à une décision ultérieure.
LIVE_ENABLE=false
LIVE_EXPECTED_WALLET=
LIVE_KEYPAIR_FILE=
LIVE_BUY_AMOUNT_LAMPORTS=
LIVE_MAX_EXPOSURE_LAMPORTS=
LIVE_MAX_LOSS_LAMPORTS=
LIVE_EXIT_RESERVE_LAMPORTS=
LIVE_MAX_PRIORITY_FEE_LAMPORTS=
LIVE_MAX_SLIPPAGE_BPS=
LIVE_MAX_BUYS=1
LIVE_MAX_SESSION_SECONDS=

# Transport et stockage explicitement ciblés.
SOLANA_HTTP_RPC_URL=
SOLANA_WS_RPC_URL=
DATABASE_URL=
SOLANA_CLUSTER=mainnet-beta
SOLANA_COMMITMENT=confirmed
SOLANA_FINALITY_COMMITMENT=finalized
LISTENER_ENABLED=true
POSTGRES_AUTO_MIGRATE=false

# Observation seule.
EXECUTION_MODE=observe
PAPER_STRATEGY_ENABLED=false
QUOTE_OBSERVATION_ENABLED=true
QUOTE_OBSERVATION_PATH=data/quote-observations.v1.jsonl
API_ENABLED=false
DASHBOARD_ENABLED=false

# Outils de reprise et rapprochement, à provisionner séparément.
LIVE_OPERATOR_DATABASE_URL=
LIVE_OPERATOR_HTTP_RPC_URL=
```

## Commandes de vérification et procédure de rapprochement

- `npm run live:config-check` : validation locale de la politique; pas de réseau, base, lecture de keyfile ni signature.
- `npm run live:network-preflight` : préflight autonome; lit seulement `LIVE_RPC_URL`, le hash attendu et exécute getGenesisHash/getVersion/getSlot. Jusqu’à trois requêtes, aucune signature/diffusion.
- `npm run dev` : démarre le listener d’observation; comme il charge dotenv, fournir une configuration d’observation explicitement isolée. Ne pas le lancer tant que la base, l’endpoint et la borne de 120 s ne sont pas validés.
- `npm run live:evidence:export -- --session <SESSION_ID> --wallet <PUBKEY> --out <NOUVEAU_DOSSIER>` : exporte les ordres de la session depuis le journal durable; DSN `LIVE_OPERATOR_DATABASE_URL`; requête en lecture seule. Exporte aussi les intentions sans signature, sans exporter les octets signés.
- `npm run live:evidence:collect -- --source <DOSSIER_EXPORT> --out <NOUVEAU_CACHE> --index-only` : indexe les signatures sans réseau.
- Pour les métadonnées RPC, remplacer `--index-only` par `--budget-rpc-requests <1..20> --commitment finalized --max-supported-version 0`; injecter `SOLANA_HTTP_RPC_URL` (HTTPS). La collecte fait d’abord une tentative pour chaque signature, respecte le cache existant et ne collecte pas les transactions versionnées au-delà de la version 0.
- `npm run live:evidence:report -- --source <DOSSIER_EXPORT> --transactions <NOUVEAU_CACHE>/transactions.v1.jsonl --wallet <PUBKEY> --session <SESSION_ID> --out <NOUVEAU_DOSSIER_RAPPORT>` : produit JSON et Markdown; sortie neuve requise.

Le rapport distingue l’acquisition/vente observées par delta de chaque signature, les quantités durablement attribuées, SOL et wSOL, frais de réseau (déjà inclus dans le delta SOL du fee payer), transferts, création/fermeture de comptes et remboursements observés. Il conserve les tentatives avec ou sans signature. Les bornes du solde wallet, la couverture des flux externes et la valeur de liquidation des reliquats ne sont pas actuellement stockées par le journal live : le résultat économique de session reste donc `null` jusqu’à collecte explicite de ces preuves. Une réponse RPC `result:null` conserve tous les soldes et frais à `null`, jamais à zéro.

## Choix opérateur restant à fournir

Une liste consolidée, sans valeur déduite :

1. Confirmer la machine et le répertoire cible sur lesquels les commandes seront réellement lancées.
2. Choisir l’endpoint RPC, son fournisseur/quota, le WS associé et le genesis hash attendu; transmettre l’endpoint credentialisé par gestionnaire de secrets/processus.
3. Fournir la base PostgreSQL cible et son schéma; confirmer en lecture seule que les migrations 016–020 sont appliquées, qu’aucun ordre/position n’est ambigu et qu’aucune instance ne détient le verrou. `DATABASE_URL` et DSN opérateur sont distincts tant que l’opérateur ne choisit pas explicitement de les faire pointer sur la même cible.
4. Choisir un wallet dédié, sa clé publique attendue, et provisionner hors dépôt un keyfile externe. L’opérateur vérifie localement que le fichier correspond à la clé publique; je n’ai ni lu ni inspecté de keyfile.
5. Renseigner le montant par achat, l’exposition maximale, le déclencheur de perte, la réserve de sortie, le slippage maximal et la durée de session. Aucun montant ne peut être calculé depuis le solde seul.
6. Choisir une rétention/destination locale pour l’export d’évidence et une politique de permissions pour les fichiers de sortie.
7. Après validation P1 séparée, décider explicitement du lancement du premier essai; le présent travail ne l’autorise ni ne le lance.
