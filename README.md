Site récup api & scrapping pour affichage sur le site.
-hébergement géré par cloudflare


**Connecteurs interrogés à chaque recherche :** catalogue CROUS, pages publiques de ville/résidence ImmoJeune, et pages publiques d'agglomération/résidence Adele.
- Les cartes ne sont dessinées que lorsqu'une source renvoie une donnée exploitable avec un loyer et une URL d'origine. Aucune annonce de démonstration, photo copiée ou prix inventé n'est ajouté.
- Les résultats portent le nom de leur source et ouvrent la fiche d'origine. La disponibilité, les charges, le dépôt de garantie et l'éligibilité doivent être confirmés chez le fournisseur.
- Suggestions de communes via `geo.api.gouv.fr` et d'établissements via le jeu de données ouvert du Ministère de l'Enseignement supérieur.
- Filtres par budget et type, tri, favoris, notes privées enregistrées dans le navigateur, et itinéraire externe vers l'établissement.
- Leboncoin, SeLoger et PAP restent des recherches externes ciblées : leurs annonces ne sont pas présentées comme si elles avaient été importées.

## Important : mode local et mode en ligne

Un navigateur ne peut pas transformer seul un fichier `index.html` ouvert en `file://` en scraper multi-sites : les protections CORS empêchent généralement les requêtes nécessaires. **Pour que les trois connecteurs automatiques fonctionnent, il faut déployer une seule fois le dossier sur un hébergement compatible avec les fonctions serveur.** Cloudflare Pages propose une offre gratuite qui suffit à cette architecture. L'utilisateur final n'a rien à installer.

Quand `index.html` est ouvert en double-cliquant dessus, l'interface reste accessible pour inspection, mais la recherche multi-sites affiche explicitement qu'elle nécessite le déploiement. Ce n'est pas un bug de bouton : il n'existe pas de serveur API à l'adresse locale `file://`.

## Déploiement gratuit (sans installation locale)

1. Crée un dépôt GitHub depuis le site web GitHub et téléverse **tous les fichiers du dossier**, y compris `functions/api/logements.js` à la racine sous le répertoire `functions/`.
2. Connecte ce dépôt à Cloudflare Pages et crée un projet Pages.
3. Choisis la configuration sans framework. Utilise `.` comme répertoire de sortie. Si Cloudflare demande une commande de build, `exit 0` convient pour ce site statique.
4. Lance le déploiement et ouvre l'adresse `https://<ton-projet>.pages.dev` générée par Cloudflare.
5. Lance une recherche par une ville connue (par exemple Lyon, Rennes ou Paris). L'interface appelle alors `/api/logements` sur la même origine et peut agréger les sources côté serveur.

Documentation Cloudflare Pages Functions : https://developers.cloudflare.com/pages/functions/get-started/  
Documentation Cloudflare Pages : https://developers.cloudflare.com/pages/framework-guides/deploy-anything/

Aucun token, clé API payante, Node.js ou serveur à gérer n'est nécessaire. La fonction se trouve à `functions/api/logements.js`, exactement à cet emplacement pour que Cloudflare Pages découvre la route `/api/logements`.

## Sources et limites techniques

### CROUS

- Portail : https://trouverunlogement.lescrous.fr/tools/47/search
- L'interface officielle utilise un endpoint JSON côté serveur : `POST https://trouverunlogement.lescrous.fr/api/fr/search/47`.
- L'identifiant `47` est une campagne configurée à la date de développement et peut changer d'une année universitaire à l'autre. Il est centralisé dans `app.js` et `functions/api/logements.js`.

### ImmoJeune

- Pages publiques de ville construites depuis le nom et le département fournis par l'API française des communes, par exemple : https://www.immojeune.com/logement-etudiant/lyon-69.html
- La fonction recherche les fiches de résidences correspondantes et n'en conserve que les cartes où elle peut extraire un loyer réel. Elle n'importe pas de photos.
- Conditions d'utilisation : https://www.immojeune.com/conditions-generales-d-utilisation.html

### Adele

- Pages publiques d'agglomération, par exemple : https://www.adele.org/residence/agglomeration/lyon/logement-etudiant
- Pour limiter les requêtes, jusqu'à 8 fiches de résidences sont ouvertes par recherche. Les loyers et surfaces ne sont retenus que lorsque le texte de la fiche correspond au format compris par le parseur. La disponibilité reste à confirmer chez Adele.
- Informations sur le service : https://www.adele.org/faq

### Comportement prévu en cas d'échec

- Les sources sont indépendantes : si un site bloque une requête, renvoie une erreur ou modifie son HTML, la fonction remonte une erreur de source et conserve les résultats reçus des autres.
- Les limitations de débit et les délais d'attente sont appliqués ; la fonction n'essaie pas de contourner les protections, captchas, comptes ou paywalls. Si une source interdit les requêtes automatisées, si son `robots.txt` les bloque, ou si elle devient inaccessible, son connecteur est désactivé pour cette requête et les autres sources continuent.
- La structure HTML des portails peut changer. Ce connecteur est un scraper de pages publiques, pas une API officielle garantie : vérifie régulièrement son comportement et les conditions d'utilisation avant de publier largement le projet.
- Aucune source ne garantit qu'une annonce est encore disponible au moment où l'utilisateur ouvre la fiche. Les photos et descriptifs complets restent hébergés par leurs propriétaires.
- Les notes et favoris sont privés et enregistrés dans le navigateur ; ils ne sont pas partagés entre étudiants.
- Le filtre de budget et de type est appliqué localement après récupération. Le trajet est ouvert sur un service de cartes ; le calcul précis du temps de trajet ne filtre pas encore les annonces.

## Architecture

- `index.html` : interface et sections de sources.
- `styles.css` : styles responsive.
- `app.js` : autocomplétion, appel API, filtres, tri, cartes réelles, notes, favoris et liens externes.
- `functions/api/logements.js` : agrégateur serveur CROUS + ImmoJeune + Adele et parsers HTML conservateurs.

## Problèmes connus / dépannage

- Si l'erreur dit que tu as ouvert `index.html` depuis ton ordinateur, utilise l'adresse `pages.dev` après déploiement ; ne double-clique pas le fichier pour tester le scraping multi-sites.
- Si `/api/logements` répond 404, vérifie que `functions/api/logements.js` est bien inclus dans le dépôt à la racine et que le site est déployé via Cloudflare Pages.
- Si une source affiche zéro résultat, cela peut signifier qu'aucune offre n'est disponible dans la ville, que le parseur n'a pas reconnu le format actuel ou que le site a restreint la requête. Consulte le statut de recherche puis ouvre la source officielle.
