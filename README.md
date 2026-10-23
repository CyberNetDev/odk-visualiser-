ODK Visualizer

Application de visualisation de données pour ODK Central, sur le modèle du Data Visualizer de DHIS2. Elle lit les formulaires via le flux OData de Central. On construit des graphiques, tableaux croisés et cartes GPS en glissant des champs dans Colonnes / Lignes / Filtre, sans export Excel.

DHIS2 Data Visualizer	ODK Visualizer
Éléments de données / indicateurs	Champs du formulaire
Unités d'organisation	N'importe quel champ de choix (région, district, formation sanitaire…)
Périodes	N'importe quel champ date, par jour / semaine / mois / trimestre / année
Valeurs	Nombre, % du total, ou Somme / Moyenne / Min / Max d'un champ numérique
Favoris	Visualisations enregistrées (lien partageable #/<id>)
Connexion ODK dans l'application

Il n'y a aucun identifiant ODK dans un fichier de configuration. Au démarrage, l'application affiche un écran de connexion :

Serveur ODK Central : l'adresse habituelle de Central, par ex. https://central.monorg.org. On peut coller l'URL complète du navigateur, elle est nettoyée automatiquement.
E-mail et mot de passe du compte ODK Central de l'utilisateur.

Ensuite :

Chaque utilisateur ne voit que les projets et formulaires autorisés pour son propre compte ODK. Les rôles et droits de Central s'appliquent tels quels.
Le mot de passe est transmis une seule fois à Central et n'est jamais enregistré. Le serveur garde seulement le jeton de session renvoyé par Central, en mémoire, lié à un cookie HttpOnly.
La session dure aussi longtemps que celle de Central (24 h par défaut). À l'expiration, l'écran de connexion réapparaît.
Se déconnecter ferme aussi la session côté ODK Central. Changer de serveur / compte permet de passer d'un serveur Central à un autre.
Le dernier serveur et le dernier e-mail utilisés sont proposés au retour, avec une liste des serveurs récents. Ils sont mémorisés sur l'appareil, jamais le mot de passe.
Un bouton Essayer avec des données de démonstration permet de tester sans serveur.

Les visualisations enregistrées sont rattachées au serveur ODK :

Elles sont visibles par les utilisateurs du même serveur qui ont accès au projet concerné.
Seul leur auteur peut les modifier ou les supprimer. Les autres utilisateurs peuvent en faire une copie avec « Enregistrer sous ».
Fonctionnalités
Types de visualisation : colonnes, colonnes empilées, barres, barres empilées, courbe, aires, secteurs, tableau croisé (avec totaux et coloration), valeur unique, carte des points GPS (colorée selon un champ).
Source de données : projet → formulaire → table (soumissions principales ou n'importe quel groupe répété).
Filtres :
par période de soumission et par état de revue (appliqués côté serveur avec $filter) ;
n'importe quel champ peut être limité à certaines valeurs.
Champs à choix multiples : chaque option cochée est comptée séparément.
Affichage : tri par libellé ou par valeur, Top N, masquer « (vide) », afficher les valeurs.
Export : PNG, tableau agrégé en CSV, données brutes filtrées en CSV.
Sans dépendance npm : seul Node 18+ est nécessaire.
Lancer
bash
docker compose up -d --build     # voir DOCKER.md
# ou sans Docker :
node server.js

Ouvrir http://localhost:3000. Le fichier .env est facultatif ; il sert seulement à des réglages comme le serveur par défaut. Voir .env.example.

Réglages facultatifs (.env)
Variable	Effet
ODK_DEFAULT_URL	Serveur proposé par défaut sur l'écran de connexion
ODK_LOCK_URL=true	Impose ce serveur : les utilisateurs saisissent seulement e-mail et mot de passe
ALLOWED_SERVERS	Liste blanche de serveurs Central autorisés, séparés par des virgules
ALLOW_DEMO=false	Masque le mode démonstration
CACHE_MINUTES	Durée du cache des soumissions (par utilisateur), 5 par défaut
COOKIE_SECURE	auto (défaut), true ou false
Fonctionnement technique

Le navigateur ne parle jamais directement à Central. server.js relaie les appels avec le jeton de l'utilisateur connecté :

Application	Appel ODK Central
POST /api/login	POST /v1/sessions, puis GET /v1/users/current
POST /api/logout	DELETE /v1/sessions/:token
/api/projects	GET /v1/projects
/api/projects/:p/forms	GET /v1/projects/:p/forms
…/fields	GET /v1/projects/:p/forms/:f/fields?odata=true
…/tables	GET …/:f.svc/$metadata
…/data	GET …/:f.svc/<table>?$top=1000&$skip=…&$count=true&$filter=… (toutes les pages, en cache)

L'agrégation se fait dans le navigateur ; c'est rapide jusqu'à environ 100 000 lignes par table.

Sécurité
Servez l'application en HTTPS : le mot de passe transite du navigateur vers l'application. Voir DOCKER.md, section HTTPS.
Le serveur se connecte à l'adresse saisie par l'utilisateur. Sur une installation publique, utilisez ODK_LOCK_URL ou ALLOWED_SERVERS pour limiter les serveurs joignables.
La connexion est bloquée après 10 échecs en 10 minutes depuis la même adresse IP.
Les requêtes qui modifient des données doivent être en JSON, ce qui protège contre le CSRF.
Pistes d'évolution
Afficher les libellés des choix tirés du XLSForm, au lieu des valeurs brutes.
Joindre les tables répétées aux champs parents, par exemple « membres par région ».
Ajouter les listes d'entités (Entities) comme source de données.
Ajouter des tableaux de bord réunissant plusieurs visualisations, comme l'app Dashboard de DHIS2.
Ajouter des cartes choroplèthes par limites administratives (GeoJSON).
Fichiers
server.js        connexion ODK par utilisateur, proxy OData, cache, visualisations, fichiers statiques
demo-data.js     données de démonstration
public/          index.html, app.js (connexion, mise en page, agrégation, graphiques), styles.css
.env.example     réglages facultatifs
Dockerfile, docker-compose.yml, docker-compose.central.yml, DOCKER.md
