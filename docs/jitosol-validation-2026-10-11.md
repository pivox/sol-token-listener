# Validation de la livraison JitoSOL — 11 octobre 2026

Périmètre : bot complet livré désactivé, avec observation publique, achat, retrait Stake Pool gardé, désactivation, attente de disponibilité réelle et récupération des SOL. La livraison ne comporte aucune activation opérationnelle ni cycle financé.

Implémentation enregistrée dans le commit `8be68e98` et intégrée localement dans `main`. À 12:08, heure de Paris, la compilation, le contrôle TypeScript/IDL et les 139 tests JitoSOL ont été revérifiés depuis le dossier principal ; `status` confirme le mode désactivé et le binaire compilé reste désactivé avec `--live` et les ports réseau/signature interdits. L'échéance de 17:00 est respectée.

| Contrôle | Résultat |
|---|---|
| Tests JitoSOL après corrections de revue | 139 réussis, aucun échec |
| Suite backend complète, après compilation | 3 936 réussis, aucun échec, 820 ignorés sur 4 756 tests |
| `npm run check:backend` | Réussi : génération des IDL et TypeScript |
| `npm run build:backend` | Réussi ; migrations et profils empaquetés |
| `npm run lint:backend` | Réussi |
| Tests Python de recherche | 33 réussis |
| `git diff --check` | Réussi |
| Binaire compilé `run --live`, configuration fournie | `disabled`, même avec réseau et signature interdits par un préchargement de contrôle |
| `status`, configuration fournie | `enabled: false`, journal absent |
| Observation publique réelle | Réussie ; seuil économique non atteint, `executable: false` |
| Précontrôle public avec adresse jetable sans fonds | Retrait disponible ; entrée rejetée ; aucune signature ni diffusion |

Les tests PostgreSQL et autres intégrations conditionnelles ignorés le restent faute de leur environnement de test dédié. Aucun serveur de production, coffre ou portefeuille utilisateur n'a été ouvert pour les forcer. Les changements JitoSOL utilisent un journal local et ne modifient aucune migration ni service PostgreSQL.

La suite backend vérifie aussi les graphes compilés : exécuter `npm run build:backend` avant `npm run test:backend`. Les dépendances du lockfile sont installées dans le dossier principal. Le runtime validé sur cette machine est Node 24.21.0, disponible dans `~/.local/node/bin` ; le guide fournit la commande pour le sélectionner dans le shell.

Le test d'intégration JitoSOL emploie le vrai moteur, le vrai journal privé et le vrai adaptateur RPC, avec chaîne et signataire de test contrôlés. Il traverse les quatre actions, une interruption avec achat en attente, un redémarrage pendant le déstaking et une indisponibilité au-delà de 72 h. Il vérifie la persistance avant diffusion, les reçus finalisés, le minimum de retrait, les frais et les loyers, ainsi que la conservation d'un solde JitoSOL antérieur.

Les fixtures publiques comprennent les octets du pool Jito, une réponse réelle de construction d'instructions Jupiter et des sondes non signées du programme Stake Pool déployé. La quote Jupiter a été compilée sans signature ; le retrait avec minimum excessif a été rejeté en simulation par le contrôle de slippage. Ces contrôles ne prouvent pas la réussite d'une transaction financée.

Deux revues indépendantes sont conservées :

- [Code et cycle d'exécution](superpowers/reviews/2026-10-11-jitosol-final-review.md) : aucun point bloquant restant pour la livraison désactivée.
- [Rapport et preuves d'observation](superpowers/reviews/2026-10-11-jitosol-observation-review.md) : 70 réponses archivées vérifiées et calculs reproduits ; aucune conclusion de rentabilité ajoutée.

Le [guide opérateur](jitosol-bot.md) décrit les paramètres, commandes, limites, arrêts et reprises. Le [rapport d'observation](jitosol-observation-2026-10-11.md) conclut à l'absence de signal au seuil sur cette fenêtre courte. La rentabilité et un cycle financé sur mainnet restent non validés.
