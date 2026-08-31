# Executor V1 — preflight et opérations inertes (#51-F)

**Version :** 1.0.3 — 2026-08-31

#51-F ne permet pas de trader. Il ne charge aucune clé, ne signe rien et
n'envoie aucune transaction. `EXECUTOR_MODE=live` et
`LIVE_TRADING_ENABLED=true` restent refusés. Le paper Mainnet #49 reste
`NON_EXECUTED / NON_VALIDATED` ; #51-G et un canary explicitement armé restent
obligatoires avant le premier ordre réel.

## Préparation PostgreSQL

Appliquer d'abord les migrations avec le rôle propriétaire habituel :

```bash
npm run db:migrate:compiled
```

Un administrateur PostgreSQL peut ensuite exécuter
`scripts/provision-executor-roles.sql`. Le script crée uniquement cinq rôles de
groupe `NOLOGIN`, sans mot de passe ni privilège cluster élevé. Le compte de
déploiement réel est rattaché séparément au groupe requis :

- `sol_token_executor_operations` pour les commandes #51-F ;
- `sol_token_operator_reader` pour status/report ;
- les rôles listener, worker et API n'ont aucun accès aux tables #51-F.

Ne placez jamais de credential PostgreSQL dans ce script ou dans Git.

## Configuration publique obligatoire

```dotenv
DATABASE_URL=
EXECUTOR_WALLET_GENERATION_ID=
EXECUTOR_PUBLIC_KEY=
SOLANA_EXPECTED_GENESIS_HASH=
EXECUTOR_RPC_PROVIDER_ID=primary
EXECUTOR_BUILD_HASH=
EXECUTOR_CONFIGURATION_FINGERPRINT=
EXECUTOR_STRATEGY_FINGERPRINT=
EXECUTOR_ACTIVATION_PHASE=CANARY
EXECUTOR_OPERATOR_ID=
EXECUTOR_PREFLIGHT_EVIDENCE_PATH=/absolute/path/preflight-evidence.json
EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64=
LIVE_TRADING_ENABLED=false
```

Le fichier de preuves contient une enveloppe signée :

```json
{
  "payloadVersion": 1,
  "algorithm": "Ed25519",
  "signedPayloadBase64": "<qualification JSON exacte encodée en base64>",
  "signatureBase64": "<signature Ed25519 canonique>"
}
```

`EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64` contient la clé publique Ed25519 SPKI DER
de confiance, encodée en base64. La clé privée reste exclusivement dans le
pipeline externe qui produit l'attestation ; elle ne doit jamais être fournie
au listener, au CLI, à PostgreSQL ou au dépôt. Le payload signé contient les
onze gates dans l'ordre canonique de la spécification
`docs/superpowers/specs/2026-08-31-executor-preflight-operations-design.md`.
Chaque élément a un type, un identifiant, un fingerprint et une expiration ;
aucun score global ne remplace un élément manquant. Toutes les identités
build/configuration/stratégie/wallet/provider/cluster ainsi que le TTL exact
sont signées et doivent correspondre à la configuration locale.

La preuve finale `MAINNET_PREFLIGHT_SIMULATED` doit utiliser comme
`evidenceId` l'identifiant exact d'un artefact #51-D réussi. Son
`evidenceFingerprint` lie le `resultFingerprint` durable de cet artefact au
build, à la configuration, à la stratégie, au wallet public, au genesis hash
et au provider du preflight. Le repository vérifie également l'heure
d'observation et refuse un artefact absent, en échec ou divergent. Un simple
identifiant ou fingerprint inventé ne peut donc pas qualifier le preflight.

## Séquence opérateur

Après `npm run build` :

```bash
npm run live:preflight
npm run live:status
npm run live:resume
npm run live:arm -- \
  --maximum-lamports=500000 \
  --holding-ms=300000 \
  --reason='Mainnet canary manually approved.'
npm run live:report
```

`live:resume` et `live:arm` exigent un vrai TTY. La commande affiche une phrase
exacte contenant un nonce éphémère ; recopiez-la exactement. Seul son hash
contextuel est persisté. Il n'existe aucun flag non interactif de contournement.

L'armement produit est inerte. Aucun worker de #51-F ne le lit et aucun mode
live n'existe encore. Sa présence signifie seulement que la décision opérateur
a été enregistrée avec les bornes CANARY.

Au moment exact de l'armement, le backend relit sous le verrou de génération
les états `unknown_block` et `UNKNOWN_HELD`. Une incertitude apparue depuis le
resume refuse la commande sans consommer son autorisation. Un replay devenu
révoqué ou expiré échoue également au lieu de renvoyer un faux état `ARMED`.

Les lectures masquent immédiatement les armements expirés sans mutation ; ils
sont terminalisés sous verrou avant tout nouvel armement. Un arrêt révoque
l'armement actif dans la même transaction. Les événements,
armements terminaux, autorisations consommées et qualifications devenues
inutiles sont supprimés par cohortes après quatre heures ; l'état courant de
contrôle est conservé.

## Arrêt

L'arrêt d'entrée est utilisable sans TTY afin de rester disponible en urgence :

```bash
npm run live:kill-switch -- \
  --mode=entry-stop \
  --reason=OPERATOR_ENTRY_STOP
```

L'arrêt dur :

```bash
npm run live:kill-switch -- \
  --mode=hard-stop \
  --reason=OPERATOR_HARD_STOP
```

`ENTRY_STOP` est l'état initial. Il bloque les futurs BUY mais préservera les
sorties/réconciliations de #51-G. `HARD_STOP` ne peut pas être rétrogradé par
une seconde commande kill-switch. Seul `live:resume`, avec un preflight frais
et une nouvelle confirmation TTY, peut revenir à `RUNNING` ; il n'arme pas.

## Sorties et diagnostic

Chaque commande écrit un seul document JSON versionné. Les rapports n'exposent
ni URL RPC, ni URL PostgreSQL, ni contenu de preuve, ni nonce, ni montant de
position, ni erreur brute. Les champs
`paperMainnet49Status=NON_EXECUTED_NON_VALIDATED` et
`liveCapabilityPresent=false` sont toujours présents.

En cas d'échec, stderr contient uniquement le service, l'événement et le code
fixe `EXECUTION_OPERATIONS_FAILED`. Inspectez ensuite l'état durable avec un
compte read-only ; ne copiez jamais la configuration ou un credential dans un
ticket.
