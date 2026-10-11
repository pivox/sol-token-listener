# Bot JitoSOL à déstaking différé

Le bot vise un surplus **en SOL** : acheter du JitoSOL décoté, retirer une délégation du pool Jito, la désactiver, puis récupérer les SOL lorsque le programme Stake autorise le retrait complet. Le cours SOL/USD n'entre pas dans la décision.

La configuration livrée est **désactivée**, sans portefeuille, sans clé et avec une autorisation de frais nulle. Aucun service de démarrage automatique n'est installé. Les commandes JitoSOL sont indépendantes du listener Pump.fun et de son exécuteur.

## Vérifier la livraison

Depuis la racine du dépôt, avec Node ≥22.13 et les dépendances du lockfile :

```bash
npm run jitosol:test
npm run check:backend
npm run build:backend
npm run jitosol:status
npm run jitosol:run
node dist/src/jitosol/main.js run
```

Les deux dernières commandes retournent `disabled`. Cette sortie se produit avant toute ouverture de journal d'exécution, lecture de clé privée ou connexion réseau. `status` lit uniquement la configuration et l'éventuel journal local ; il masque les transactions signées et les messages bruts des fournisseurs.

## Observer sans signer

```bash
npm run jitosol:observe
```

Cette commande demande une quote Jupiter pour 3 SOL et lit l'état public du pool. Elle affiche les montants entiers et les contrôles de fraîcheur. Elle ne vérifie pas le portefeuille ni la capacité de retrait d'un validateur et annonce toujours `executable: false`.

Pour vérifier aussi un portefeuille **public** et la capacité d'un retrait différé, copier `config/jitosol.example.json` hors du dépôt, renseigner `strategy.walletAddress`, puis utiliser :

```bash
npm run jitosol:preflight -- --config /chemin/vers/jitosol.json
```

`preflight` ne charge aucune clé privée et n'envoie aucune transaction. Son code de sortie est 0 si l'observation est admissible, 2 si elle est rejetée, 1 si la commande échoue. `eligible` signifie uniquement que cette observation satisfait les contrôles ; l'exécution impose une seconde observation et une simulation.

Les requêtes passent par `https://api.jup.ag` et le RPC HTTPS configuré. Si Jupiter exige un accès authentifié, `runtime.jupiterApiKeyFile` désigne un fichier privé 0600 contenant la clé API. Aucune recherche automatique dans les variables d'environnement, les fichiers `.env` ou un coffre de secrets n'est effectuée. Les réponses HTTP et leur lecture sont bornées en durée et en taille.

## Critères d'entrée

Le ticket est fixé à **3 SOL**, la quote à `ExactIn`, la route à un seul échange direct et le slippage à 10 points de base. Les routes ou variantes d'instructions non reconnues sont refusées. Le montant minimal est calculé prudemment à partir du montant et du slippage réellement encodés dans l'instruction Jupiter ; il peut être inférieur d'une unité atomique JitoSOL au seuil arrondi par l'API.

Le calcul utilise exclusivement des entiers : frais de retrait arrondis vers le haut en unités JitoSOL, puis conversion des unités restantes en lamports arrondie vers le bas. Avec les valeurs livrées :

| Poste | Lamports | SOL |
|---|---:|---:|
| Achat | 3 000 000 000 | 3 |
| Budget réseau du cycle | 1 000 000 | 0,001 |
| Coût d'immobilisation conventionnel, 72 h à 6,5 % annuel | 1 602 740 | 0,001602740 |
| Surplus minimal demandé | 9 000 000 | 0,009 |
| Retrait minimal nécessaire | **3 011 602 740** | **3,011602740** |

Le coût d'immobilisation est un filtre d'opportunité, pas un débit de transaction. Les 72 heures sont une hypothèse économique ; elles ne déclenchent jamais le retrait. La sortie attend une simulation réussie du retrait complet sur l'état effectif du programme Stake, même si le déstaking prend davantage de temps.

Deux observations admissibles, avec une quote et un contexte de chaîne renouvelés, doivent être espacées d'au moins 10 secondes. Les quotes, le pool, son époque, les slots et la capacité de retrait sont contrôlés. Une ancienneté de `updateContextSlot` excessive est un refus prudent de fraîcheur, et ne démontre pas à elle seule que le prix de la route est périmé.

L'achat exige aussi les SOL de réserve et les loyers des comptes. Le retrait prend uniquement les JitoSOL effectivement reçus par cet achat, en laissant un solde antérieur distinct. Cette implémentation utilise le fractionnement d'une délégation active admissible ; elle refuse une sortie disponible seulement via réserve, délégation transitoire ou retrait complet du validateur.

Le retrait emploie `WithdrawStakeWithSlippage` : son minimum de SOL hors loyer est encodé dans l'instruction et vérifié à nouveau dans le reçu finalisé. Ce minimum ne peut pas passer sous le seuil économique d'origine, y compris après un redémarrage. Si le taux ou les frais du pool se dégradent après l'achat au point de rendre ce seuil inaccessible, le bot s'arrête avec les JitoSOL détenus et demande une réconciliation opérateur. Il ne garantit pas qu'une sortie rentable restera disponible après l'entrée.

## Exécution future, uniquement après activation explicite

Cette procédure décrit les réglages disponibles ; la livraison ne les active pas.

1. Utiliser une copie privée du fichier de configuration, un portefeuille dédié et un chemin de journal stable. Renseigner son adresse publique et `runtime.keypairPath`. Le chargeur de clé existant exige un fichier régulier appartenant à l'utilisateur, en 0400 ou 0600, sans lien symbolique, contenant exactement le tableau JSON canonique des 64 octets, et vérifie l'adresse publique.
2. Fixer `strategy.maxTotalFeesLamports` explicitement : `"1000000"` autorise au maximum le budget réseau d'un cycle. Les frais estimés puis réellement finalisés sont comptabilisés. Le ticket reste 3 SOL et le nombre maximal de cycles reste 1 par défaut. Le plafond de frais individuel et les frais prioritaires sont également contrôlés.
3. Vérifier la copie avec `status`, `observe` et `preflight`. Renseigner `strategy.enabled: true` seulement pour l'exécution voulue.
4. Lancer au premier plan avec la seconde activation :

```bash
npm run jitosol:run -- --config /chemin/vers/jitosol.json --live
# Équivalent compilé, après build :
node dist/src/jitosol/main.js run --config /chemin/vers/jitosol.json --live
```

`enabled: true` seul et `--live` seul ne suffisent pas. Le RPC doit annoncer le genesis hash canonique de Solana mainnet. Le signataire doit correspondre au payeur unique. Les instructions, comptes, frais, changements de soldes et autorités sont vérifiés par simulation avant signature. Une transaction signée est écrite et synchronisée sur disque avant son premier envoi. Les montants réalisés ne proviennent que des reçus finalisés.

L'exécution reste bornée à sept jours au maximum par lancement (`maxRuntimeSeconds`). Elle se termine aussi lorsque la limite durable de cycles est atteinte, sur arrêt demandé ou sur anomalie bloquante. Une connexion réseau fonctionnelle reste nécessaire pendant les actions et la surveillance. Aucun fonctionnement ne dépend de la durée d'un abonnement ChatGPT.

## Arrêt et reprise

Le répertoire par défaut est `~/.sol-token-listener/jitosol-bot`, en 0700, avec `state.json` et `writer.lock` en 0600. Les chemins relatifs de configuration sont résolus depuis le répertoire de lancement ; un `stopFile` relatif est résolu dans le répertoire de journal. Préférer des chemins absolus pour une exploitation depuis plusieurs répertoires.

Créer le fichier `STOP` dans ce répertoire ou envoyer SIGINT/SIGTERM empêche les prochaines mutations. Une transaction déjà envoyée peut encore se finaliser. L'arrêt ne vend pas de position et n'annule pas un déstaking. Conserver le journal puis reprendre avec exactement la même configuration et le même répertoire ; le fichier `STOP` doit être retiré intentionnellement pour reprendre.

Après interruption, le bot vérifie la signature enregistrée. Il peut réémettre uniquement les mêmes octets signés encore admissibles ; il ne reconstruit pas silencieusement un achat de remplacement. Une quote d'achat dépassant son échéance n'est plus réémise. L'adresse du compte Stake est déterministe pour le portefeuille et la position.

Un journal `halted`, une signature expirée ou un reçu incohérent exige une réconciliation opérateur avec la chaîne. Aucune commande de réinitialisation automatique n'est fournie : **ne pas supprimer ou recréer le journal pour contourner l'arrêt**. Les détails privés sont conservés dans `state.json`. Un verrou laissé après arrêt brutal n'est jamais volé automatiquement ; vérifier que son PID n'existe plus et qu'aucun processus n'utilise ce répertoire avant de retirer uniquement `writer.lock`. Une modification de paramètres économiques après ouverture du journal est refusée par son empreinte de configuration.

Une erreur de transport pendant la lecture d'une signature conserve la transaction en attente et reporte sa vérification ; elle n'autorise ni transaction de remplacement ni réémission pendant cette lecture incertaine. Une incohérence des données reçues ou une signature inconnue après expiration déclenche l'arrêt pour réconciliation.

## Comptabilité et portée de validation

Le profit réalisé est le SOL retiré, moins le capital d'entrée, les frais réellement payés et les coûts non récupérables. Le loyer financé du compte Stake est exclu du profit lorsqu'il revient au portefeuille. Le loyer d'un compte de jetons encore ouvert reste un actif immobilisé ; il ne constitue pas du SOL liquide gagné. Le bot ne clôture pas automatiquement les comptes de jetons.

Les tests couvrent un cycle simulé complet, le déstaking au-delà de 72 h, les redémarrages, les limites de frais, les erreurs et plusieurs frontières d'interruption. Des fixtures publiques contrôlent le décodage du pool et les instructions. Cela ne remplace pas un cycle financé sur mainnet : **aucun achat réel ni déstaking financé n'a été exécuté pour cette livraison**.

Les contrôles publics du 11 octobre 2026 comprennent une vraie réponse Jupiter de construction d'instructions, compilée sans signature, et une simulation sans signature confirmant que le programme Stake Pool déployé reconnaît la variante de retrait avec minimum. Ces sondes ne déplacent aucun fonds et ne prouvent pas la réussite d'un cycle financé.

L'[observation du 11 octobre 2026](jitosol-observation-2026-10-11.md) n'a pas trouvé de décote répondant au seuil. La disponibilité du code ne valide donc ni une fréquence d'opportunités ni une rentabilité future.

## Références de protocole

- [Intégration du staking Jito](https://www.jito.network/docs/jitosol/jitosol-liquid-staking/for-developers/staking-integration/).
- [Programme SPL Stake Pool, version de source vérifiée](https://github.com/solana-program/stake-pool/tree/8abfd17428728bc4c1ce181c238a3357bab82ad5/program/src).
- [Référence Jito de retrait manuel](https://github.com/jito-foundation/jito-stake-unstake-reference/tree/b553e90d39e1ff583011dab344a11b5d9bfd284c).
- [IDL Jupiter Aggregator](https://github.com/jup-ag/jupiter-amm-implementation/blob/main/jupiter/idls/jupiter_aggregator.json).
- [Simulation Solana](https://solana.com/docs/rpc/http/simulatetransaction).
