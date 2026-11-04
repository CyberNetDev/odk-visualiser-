# Feuille de route : connecteurs IASO, DHIS2, CommCare, mSupply

Aujourd'hui, ODK Visualizer lit **ODK Central**. L'objectif est que les mêmes fonctions marchent avec d'autres plateformes :

- graphiques, libellés, formateur ƒ ;
- cache et mises à jour incrémentales ;
- visualisations enregistrées et partagées.

## Principe : un « connecteur » par plateforme

Le cœur de l'application ne change pas. Chaque plateforme reçoit un connecteur côté serveur qui fournit toujours les mêmes six opérations :

| Opération | ODK Central (existant) | Rôle |
|---|---|---|
| `login` | `POST /v1/sessions` | Connexion avec le compte de l'utilisateur ; ses droits sont respectés |
| `sources` | projets → formulaires | Ce que l'utilisateur peut choisir |
| `fields` + `labels` | `/fields`, XForm | Liste des champs, types, libellés des questions et des choix |
| `rows` | OData `Submissions` (+ répétitions) | Les enregistrements, page par page |
| `changedSince` | `$filter=__system/updatedAt gt …` | Mises à jour incrémentales pour le cache |
| `access` | `GET /v1/projects/:p/forms/:f` | Vérifier les droits avant de servir le cache partagé |

Sur l'écran de connexion, l'utilisateur choisirait sa plateforme : ODK Central, IASO, DHIS2, CommCare ou mSupply.

## Ordre conseillé

Critère : utilité pour les équipes santé et humanitaires, croisée avec l'effort technique et la possibilité de tester.

| # | Plateforme | Pourquoi à ce rang | Données | Effort |
|---|---|---|---|---|
| 1 | **IASO** | Utilise des formulaires **ODK (XForms)** : le lecteur de libellés et le formateur sont réutilisables tels quels. Apporte la **hiérarchie des unités d'organisation**, très demandée. | Soumissions + unités d'organisation | Moyen |
| 2 | **DHIS2** | Plateforme la plus répandue dans les ministères de la santé ; API très bien documentée ; serveurs de démonstration publics pour tester | **Tracker / événements** (enregistrements individuels, comme ODK) puis **agrégé** (analytics) | Moyen (tracker) à élevé (agrégé) |
| 3 | **CommCare** | Techniquement le plus simple : il expose déjà des **flux OData** (formulaires, cas), avec un flux par groupe répété, comme ODK | Formulaires + cas | Faible à moyen |
| 4 | **mSupply** | Données de **logistique** (stocks, factures, commandes) et non de formulaires : il faudra des vues adaptées (stocks par produit et par dépôt) | Stocks, transactions | Moyen, documentation partielle |

Si vos partenaires utilisent beaucoup CommCare, il peut passer en n°1 : c'est le connecteur le plus rapide à livrer.

## Ce que l'on sait de chaque API

### IASO (Bluesquare)
- Connexion : `POST /api/token/` avec `username` et `password`, puis `Authorization: Bearer <jeton>`.
- Soumissions : `GET /api/instances/` en JSON ; `format=csv` est disponible.
- **Non documenté publiquement** : filtres par formulaire, unité d'organisation et date ; liste des formulaires ; hiérarchie. Il faut un accès de test pour le vérifier.

### DHIS2
- Connexion : identifiant / mot de passe, ou **jeton d'accès personnel** (`Authorization: ApiToken d2pat_…`), recommandé pour une application.
- Tracker : `GET /api/tracker/events` et `/api/tracker/trackedEntities`, avec pagination et filtres par programme, unité d'organisation et dates.
- Agrégé : `GET /api/analytics` (éléments de données × périodes × unités d'organisation, déjà calculés par DHIS2).
- Avantages : hiérarchie des unités d'organisation et coordonnées pour les cartes.

### CommCare (Dimagi)
- **Flux OData** pour les formulaires et les cas, créés dans CommCare HQ. Leur URL se copie depuis l'export. Il y a une URL par groupe répété.
- Connexion : authentification de base avec le compte CommCare HQ. Avec la double authentification ou le SSO, on utilise la **clé API** comme mot de passe.
- Limite annoncée par Dimagi : les performances se dégradent vers **500 000 lignes** par export.

### mSupply
- Connexion : `POST api/v4/login`, qui renvoie un **jeton JWT valable 2 heures**.
- Données : `GET /stock` (filtres `code`, `name`), `GET /storeCustomerInvoice?startDate=…&endDate=…`, commandes clients.
- **Non documentés** : la pagination et la liste des produits et des dépôts.

## Ce qu'il faut pour démarrer chaque connecteur

1. L'**adresse d'un serveur de test** et un **compte en lecture seule**, avec quelques données réelles ou fictives.
2. À défaut : des **exemples de réponses** de l'API (JSON), anonymisés.
3. Les **questions à suivre en priorité** : par exemple « couverture vaccinale par district et par mois » (DHIS2), ou « ruptures de stock par dépôt » (mSupply).

## Étape 0, commune à tous

Avant le premier nouveau connecteur, il faut séparer le code propre à ODK dans `connectors/odk.js` et définir l'interface ci-dessus. Ce découpage ne change rien pour les utilisateurs. Il rend chaque nouveau connecteur indépendant et testable.

## Sources

- IASO : https://iaso.readthedocs.io/en/latest/pages/dev/how_to/use_iaso_apis/use_iaso_apis.html
- DHIS2, jetons d'accès personnels : https://docs.dhis2.org/en/use/user-guides/dhis-core-version-240/working-with-your-account/personal-access-tokens.html
- DHIS2, API Tracker : https://docs.dhis2.org/zh/develop/using-the-api/dhis-core-version-242/tracker.html
- CommCare, flux OData : https://dimagi.atlassian.net/wiki/spaces/commcarepublic/pages/2363031624/OData+Feeds+Overview
- mSupply, API REST : https://docs.msupply.org.nz/web_interface:rest_api
