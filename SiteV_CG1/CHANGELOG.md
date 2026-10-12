# Journal des modifications

## V1.1 — 12 octobre 2026
- Suppression intégrale du jeu d'annonces fictives.
- Connexion aux offres CROUS 2026-2027 via leur endpoint public et fiches individuelles officielles.
- Filtrage des résultats réellement retournés par le catalogue du CROUS par ville, budget et catégorie ; la disponibilité exacte est à vérifier sur la fiche, car le booléen dédié n’est pas toujours fourni.
- Suggestions de villes et d'établissements depuis des référentiels publics.
- Réparation du flux de recherche, du tri, des filtres, des favoris, des notes et de la réinitialisation.
- Ajout d'une Cloudflare Pages Function pour contourner CORS en production sans clé ni dépendance.
- Ajout d'états explicites de chargement, erreur réseau et absence de résultats.

## V1.0
- Prototype responsive avec annonces de démonstration, filtres, favoris et notes locales.
