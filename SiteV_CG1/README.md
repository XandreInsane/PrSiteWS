# CampusLogis — V1.1

Comparateur responsive d'offres étudiantes. Le projet reste en HTML, CSS et JavaScript natifs, sans framework ni paquet à installer sur l'ordinateur de l'utilisateur.

## Ce qui a changé

- Toutes les annonces fictives ont été supprimées. Une carte n’est rendue que pour un résultat reçu du catalogue en ligne du portail officiel du CROUS, avec un identifiant de fiche et un loyer cohérent. L’API ne fournit pas systématiquement un booléen `available` ; la disponibilité détaillée et la date d’entrée doivent donc être confirmées sur la fiche source.
- Les cartes affichent les informations disponibles dans la réponse CROUS (intitulé, résidence, adresse, loyer, surface, équipements si présents) et mènent à la fiche officielle individuelle.
- Le loyer maximum, type de logement et tri sont appliqués aux offres reçues.
- Ajout de suggestions de villes via l'API publique geo.api.gouv.fr et de suggestions d'établissements via le jeu de données ouvert du Ministère de l'Enseignement supérieur.
- Favoris, notes privées, boutons et lien d'itinéraire sont raccordés aux annonces réelles. Les notes restent dans le navigateur actuel.
- Leboncoin, SeLoger, PAP, Lokaviz et Studapart sont disponibles comme recherches complémentaires, mais leurs annonces ne sont pas présentées comme importées dans les cartes.
- Pas de photo des fiches CROUS copiée dans CampusLogis : les cartes utilisent une illustration neutre. Les photos restent sur le portail officiel.

## Sources de données

### Offres CROUS en cours

- Recherche officielle : https://trouverunlogement.lescrous.fr/tools/47/search
- Fiches individuelles : `https://trouverunlogement.lescrous.fr/tools/47/accommodations/{id}`
- API publique utilisée par le site officiel (non documentée comme API développeur) : `POST https://trouverunlogement.lescrous.fr/api/fr/search/47`
- Identifiant `47` : offre complémentaire 2026-2027 au 12 octobre 2026. Cet identifiant de campagne peut changer à la prochaine année universitaire ; il est centralisé dans `app.js` et `functions/api/logements.js`.

Le site ne montre aucune donnée de remplacement quand la source ne répond pas. Les offres peuvent disparaître ou changer entre deux consultations : ouvrir la fiche officielle et vérifier avant de candidater. L’API peut ne pas renseigner de booléen universel de disponibilité : les résultats qu’elle retourne doivent être vérifiés sur leur fiche.

### Suggestions

- Communes françaises : `https://geo.api.gouv.fr/communes`
- Référentiel des établissements d'enseignement supérieur : API Explore du portail open data du Ministère, jeu `fr-esr-principaux-etablissements-enseignement-superieur`.

## Lancer en local

1. Décompresse le ZIP.
2. Ouvre `index.html` dans un navigateur récent.
3. Saisis une ville (ex. Rennes, Lyon ou Paris), accepte une suggestion si elle apparaît, puis clique sur **Rechercher**.

Aucun serveur local ni installation n'est nécessaire pour ouvrir l'interface. Il faut une connexion Internet pour les suggestions, l'API CROUS et les liens externes. Selon le navigateur, l'ouverture par `file://` peut bloquer la requête POST vers le portail CROUS (politique CORS du site source). Dans ce cas, aucune annonce fictive ne s'affiche : le message d'erreur propose le lien officiel. Pour un fonctionnement fiable après mise en ligne, utiliser la fonction serverless fournie ci-dessous.

## Mise en ligne gratuite, sans installation locale

Le dossier contient une Cloudflare Pages Function en `functions/api/logements.js`. Elle relaie uniquement les requêtes prédéfinies vers l'API CROUS afin que le navigateur parle à CampusLogis sur la même origine et évite le blocage CORS. Aucun token, aucune clé API, aucun paquet npm ou serveur à maintenir n'est nécessaire.

Avec un dépôt GitHub (créé et alimenté depuis l'interface web, sans Git local) :

1. Crée un dépôt GitHub et téléverse tous les fichiers de ce dossier, y compris le répertoire `functions/`.
2. Dans Cloudflare Pages, crée un projet relié à ce dépôt Git.
3. Choisis la configuration **None / sans framework**, avec comme commande de build `exit 0` et comme répertoire de sortie `.`.
4. Déploie le projet. Cloudflare Pages doit détecter le fichier `functions/api/logements.js` et créer la route `/api/logements`.

Documentation officielle : https://developers.cloudflare.com/pages/functions/get-started/ et https://developers.cloudflare.com/pages/framework-guides/deploy-anything/.

Pour les tests, si le déploiement sert la page mais ne reconnaît pas la fonction API, vérifier les journaux de build et que `functions/` est bien à la racine du projet (pas déplacé dans un sous-dossier de sortie).

## Limites actuelles

- Connecteur actif : offres du CROUS. Les portails privés (Leboncoin, SeLoger, PAP, Studapart) ne sont pas récupérés automatiquement : ils n'offrent pas ici d'API publique officielle et stable autorisant cette réutilisation. Le site ouvre une recherche spécifique dans leurs résultats publics.
- Les disponibilités CROUS sont la disponibilité annoncée par la source au moment de la requête. Elles doivent être re-vérifiées sur le portail officiel ; la candidature peut demander un compte étudiant et dépendre de critères d'éligibilité.
- Le mode de transport ouvre un itinéraire externe, mais le temps de trajet n'est pas encore calculé ni utilisé pour classer les résultats dans CampusLogis.
- Notes et favoris sont locaux au navigateur, non partagés entre étudiants. Le partage communautaire nécessitera ensuite une base de données, une authentification et de la modération.

## Architecture

- `index.html` : structure de l'interface.
- `styles.css` : styles responsive et états visuels.
- `app.js` : autocomplétion, accès aux données, filtrage, tri, rendu, liens, notes et favoris.
- `functions/api/logements.js` : relais serverless facultatif mais recommandé pour la mise en ligne.
