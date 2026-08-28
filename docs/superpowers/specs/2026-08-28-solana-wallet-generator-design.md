# Générateur local de wallet Solana

## Objectif

Ajouter à `sol-token-listener` un petit outil isolé qui crée un wallet Solana compatible avec Phantom et avec le code du projet. Une exécution doit afficher les informations du wallet dans le terminal et les enregistrer dans un fichier JSON local documenté.

## Périmètre

L'outil résidera dans `wallet-generator/` à la racine du dépôt. Il sera lancé par la commande `npm run wallet:create` et n'effectuera aucune requête réseau. Il ne financera pas le wallet et ne modifiera pas la configuration applicative.

## Génération et compatibilité

Le script générera une phrase BIP39 anglaise de 12 mots à partir d'une source aléatoire cryptographiquement sûre. Il dérivera le premier compte Solana avec le chemin `m/44'/501'/0'/0'`, puis construira un `Keypair` Solana à partir de la graine Ed25519 dérivée.

Le résultat contiendra :

- l'adresse publique en Base58 ;
- la clé privée complète de 64 octets encodée en Base58, importable directement dans Phantom ;
- la même clé privée sous forme de tableau JSON de 64 entiers, utilisable avec `Keypair.fromSecretKey(Uint8Array.from(...))` dans `sol-token-listener` ;
- la phrase de récupération BIP39 de 12 mots, compatible avec la dérivation choisie.

Avant toute sortie, le script reconstruira le wallet à partir de la phrase et vérifiera que son adresse correspond à celle générée. Une incohérence interrompra l'exécution sans écrire de fichier.

## Format de sortie

Chaque valeur sera accompagnée d'un champ `description` en français :

```json
{
  "address": {
    "value": "...",
    "description": "Adresse publique Solana à recevoir et surveiller."
  },
  "privateKeyBase58": {
    "value": "...",
    "description": "Clé privée Base58 importable dans Phantom."
  },
  "privateKeyBytes": {
    "value": [1, 2, 3],
    "description": "Clé privée Solana au format tableau de 64 octets, utilisable par Keypair.fromSecretKey()."
  },
  "recoveryPhrase": {
    "value": "...",
    "description": "Phrase de récupération BIP39 de 12 mots utilisant le chemin Phantom/Solana m/44'/501'/0'/0'."
  }
}
```

Le même objet sera affiché dans le terminal en JSON lisible. Le fichier sera créé sous `wallet-generator/output/` avec un nom horodaté qui ne remplace pas une génération précédente.

## Sécurité et erreurs

`wallet-generator/output/` sera ignoré par Git. Le dossier sera créé avec des permissions réservées à l'utilisateur lorsque la plateforme le permet, et le fichier JSON recevra le mode `0600`. Le terminal affichera un avertissement indiquant de ne jamais partager les secrets ni committer le fichier.

En cas d'échec de génération, de dérivation, de validation ou d'écriture, le script affichera un message clair sur la sortie d'erreur et terminera avec un code non nul. Aucun secret partiel ne sera écrit.

## Dépendances et structure

Le projet réutilisera `@solana/web3.js` et `bs58`, déjà présents. Il ajoutera des bibliothèques ciblées pour BIP39 et la dérivation Ed25519 HD. Le dossier contiendra le script principal et un README court expliquant la commande, les formats, l'import Phantom et l'utilisation avec `Keypair.fromSecretKey`.

## Vérification

Des tests automatisés couvriront au minimum :

- la validité BIP39 de la phrase ;
- la présence de 12 mots ;
- la cohérence adresse/phrase/clé privée ;
- les deux formats de clé privée et leurs 64 octets ;
- la présence d'une description pour chaque valeur ;
- le refus d'écraser un fichier existant ou l'emploi d'un nom unique ;
- les permissions `0600` du fichier sur les systèmes compatibles POSIX.

Le contrôle TypeScript, le lint ciblé et les tests du générateur devront réussir avant livraison.
