# Cutover d’amorçage et observations rolling A/B — 2026-10-05

## Verdict

**BLOCKED — observation A n’a pas achevé le bootstrap strict après le cutover.** Le cutover unique autorisé a été appliqué une fois par programme. Le scanner a ensuite échoué sur `CATCH_UP_WINDOW_EXCEEDED` pendant son retry depuis la frontier market, avant que le runtime passe à `RUNNING`. Observation B n’a pas été lancée, conformément à la règle d’arrêt.

## Précontrôles

- Base: `127.0.0.1:5432/solanabot`, rôle `solanabot`, schéma `public`, `search_path="$user", public`, PostgreSQL 14.18. L’identité SQL correspond à la cible autorisée.
- Genesis RPC configuré: égal au genesis attendu et au genesis `mainnet-beta` canonique, vérifié contre le SDK Solana officiel ([`genesis_config.rs`](https://github.com/solana-labs/solana/blob/master/sdk/src/genesis_config.rs)).
- État live en lecture seule: 0 position, 0 ordre, 0 fill. Aucune autre session PostgreSQL ni aucun verrou advisory n’était présent.
- Les 22 fichiers de migration présents dans ce dépôt sont tous enregistrés. `022_recorded_live_edge_cutover.sql` apparaît une fois. Les 32 autres lignes de `migration_history` correspondent à l’autre lignée historique et ont été conservées; aucune migration n’a été exécutée pendant cette opération.
- Paramètres observés: `pageSize=1000`, `maxPages=20`, `LISTENER_ROLLING_CATCH_UP_INTERVAL_MS=15000`.
- Aucun fichier de clé n’a été lu. La commande d’observation a reçu `LIVE_ENABLE=false`, `LIVE_KEYPAIR_FILE=""`, `EXECUTION_MODE=observe`, paper/migrations/API/dashboard désactivés et `DOTENV_CONFIG_PATH=/dev/null`.

## Cutover appliqué

Les abonnements étaient actifs: le chemin de cutover vérifie l’état RUNNING des deux abonnements avant de journaliser chaque succès. Le cutover a conservé le checkpoint précédent, la frontier finalized, la signature, le slot, l’horodatage et le diagnostic de dépassement dans la transaction d’évidence/checkpoint.

| Programme | Ancien checkpoint | Nouvelle frontier/checkpoint | Scan justifiant le cutover | Evidence ID |
|---|---:|---:|---|---|
| launchpad | 453662738 | 453691421 | 20 pages, 20 000 signatures; slots observés 453691451 → 453691283; ancienne signature absente | `62e78992-606b-4c1f-b441-2fa80d8da4a6` |
| market | 453662739 | 453691421 | 20 pages, 20 000 signatures; slots observés 453691475 → 453691419; ancienne signature absente | `da4f91d6-7114-4373-a47f-0387b001ab96` |

Raison des deux preuves: `operator-approved-live-edge-cutover`. Les deux preuves antérieures `invalid-future-checkpoint` restent présentes (une par programme). Aucun second cutover n’a été fait.

## Observation A — une tentative, bootstrap échoué

Commande lancée une fois: `node --env-file=live.env --import tsx src/app.ts --allow-recorded-live-edge-cutover`, dans un environnement `env -i` avec les overrides observe-only ci-dessus. Aucun `live:run` n’a été lancé.

| Mesure | Résultat |
|---|---|
| `BOOTSTRAP_OK` | `false` |
| `WS_LAUNCHPAD_SUBSCRIBED` / `WS_MARKET_SUBSCRIBED` | `true` au point du cutover, établi par le contrôle RUNNING préalable au log d’application |
| `WS_CONNECTED` | `true` au point du cutover |
| `WEBSOCKET_EVENTS_RECEIVED` | compteur mémoire non émis avant l’échec; non déterminable précisément |
| `WEBSOCKET_ENQUEUES_COMPLETED` | compteur mémoire non émis avant l’échec; non déterminable précisément |
| Inbox | 20 579 lignes distinctes créées pendant la tentative avec provenance `WEBSOCKET`; ce chiffre n’est pas le nombre exact de callbacks ni d’enqueues réussis |
| Sweeps rolling réussis | launchpad 0; market 0. Aucun sweep périodique n’a été programmé, car le scan initial a échoué |
| `TRANSACTION_SUBMISSION` | `false` (événement `listener.foundation_ready`) |
| Durée avant `listener.start_failed` | environ 19,1 s; la fenêtre minimale de 90 s n’a pas été atteinte |
| `PROCESS_EXIT` | échec de démarrage, code de sortie 1; fermeture des ressources par le chemin d’erreur |

### Cause précise

Après avoir déplacé le checkpoint market sur sa frontier `453691421`, le scanner a réessayé la même recherche rétrograde d’une signature checkpoint depuis la tête mobile. Le diagnostic final était:

- programme `market`;
- checkpoint slot `453691421`, signature égale à la signature de frontier persistée;
- frontier slot `453691421`;
- `pageCount=20`, `signaturesRead=20000`;
- fenêtre lue: slot le plus récent `453691504`, le plus ancien `453691456`;
- signature du checkpoint non trouvée (`checkpointSignatureFound=false`), épuisement `page-budget-exhausted`.

Le retry a donc lui-même perdu la frontier dans la fenêtre avant de pouvoir achever le bootstrap. C’est une course dans la séquence de retry du bootstrap après cutover; le rolling périodique n’a pas commencé. Aucun total HTTP exact, percentile de durée de sweep ou compteur 429 n’a été disponible avant cet échec; ces valeurs ne sont pas déclarées nulles ou égales à zéro.

## Observation B

**NON LANCÉE.** La condition d’arrêt impose de ne pas démarrer B lorsque A échoue. Aucun rebase, reset, correction manuelle de checkpoint ou deuxième tentative d’observation n’a eu lieu.

## État durable après A

Lecture seule après l’arrêt: checkpoints launchpad et market à `453691421`, correspondant aux deux nouvelles preuves ci-dessus; 0 ordre, position et fill; 0 session DB et 0 verrou advisory. Le checkpoint est donc modifié uniquement par les deux cutovers explicitement autorisés. Les anciennes preuves n’ont pas été supprimées.

## Étape suivante

Ne pas lancer B ni répéter le cutover. Corriger et tester hors ligne le chemin qui, après un cutover documenté, relance une recherche rétrograde de la frontier déjà coupée alors que la tête continue d’avancer. Il faut d’abord définir une reprise qui préserve la signification de couverture durable; ensuite, obtenir une nouvelle autorisation pour une seule observation de validation. Les métriques/quota doivent être instrumentés ou rendus accessibles avant de conclure sur la cadence de 15 s.
