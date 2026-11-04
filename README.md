# ODK Visualizer

Application de visualisation de données pour **ODK Central**, sur le modèle du *Data Visualizer* de DHIS2. Elle lit les formulaires via le **flux OData** de Central. On construit des graphiques, tableaux croisés et cartes GPS en glissant des champs dans **Colonnes / Lignes / Filtre**, sans export Excel.

| DHIS2 Data Visualizer | ODK Visualizer |
|---|---|
| Éléments de données / indicateurs | Champs du formulaire |
| Unités d'organisation | N'importe quel champ de choix (région, district, formation sanitaire…) |
| Périodes | N'importe quel champ date, par jour / semaine / mois / trimestre / année |
| Valeurs | Nombre, % du total, ou Somme / Moyenne / Min / Max d'un champ numérique |
| Favoris | Visualisations enregistrées (lien partageable `#/<id>`) |

En plus des graphiques du *Data Visualizer* de DHIS2, l'application propose 13 types de visualisation inspirés de la galerie d'**Apache Superset** (marqués ✦ dans la liste).

## Connexion ODK dans l'application

Il n'y a **aucun identifiant ODK dans un fichier de configuration**. Au démarrage, l'application affiche un écran de connexion :

1. **Serveur ODK Central** : l'adresse habituelle de Central, par ex. `https://central.monorg.org`. On peut coller l'URL complète du navigateur, elle est nettoyée automatiquement.
2. **E-mail** et **mot de passe** du compte ODK Central de l'utilisateur.

Ensuite :

- Chaque utilisateur ne voit **que les projets et formulaires autorisés pour son propre compte ODK**. Les rôles et droits de Central s'appliquent tels quels.
- Le mot de passe est transmis **une seule fois** à Central et n'est jamais enregistré. Le serveur garde seulement le jeton de session renvoyé par Central, en mémoire, lié à un cookie `HttpOnly`.
- La session dure aussi longtemps que celle de Central (24 h par défaut). À l'expiration, l'écran de connexion réapparaît.
- **Se déconnecter** ferme aussi la session côté ODK Central. **Changer de serveur / compte** permet de passer d'un serveur Central à un autre.
- Le dernier serveur et le dernier e-mail utilisés sont proposés au retour, avec une liste des serveurs récents. Ils sont mémorisés sur l'appareil, jamais le mot de passe.
- Un bouton **Essayer avec des données de démonstration** permet de tester sans serveur.

Les visualisations enregistrées sont rattachées au serveur ODK :

- Elles sont visibles par les utilisateurs du même serveur qui ont accès au projet concerné.
- Seul leur auteur peut les modifier ou les supprimer. Les autres utilisateurs peuvent en faire une copie avec « Enregistrer sous ».

## Fonctionnalités

### Types de visualisation

Ils sont classés par catégorie, comme dans la galerie d'Apache Superset ; ✦ = type inspiré de Superset.

| Catégorie | Types | Comment remplir la mise en page |
|---|---|---|
| Comparaison | Colonnes, Colonnes empilées, **Radar ✦** | Radar : Lignes = axes, Colonnes = séries |
| Classement | Barres, Barres empilées, **Entonnoir ✦** | Entonnoir : catégories en Lignes |
| Évolution | Courbe, Aires empilées, **Calendrier ✦** | Calendrier : valeur par jour (date de soumission par défaut) |
| Partie d'un tout | Secteurs, **Rose de Nightingale ✦**, **Treemap ✦**, **Sunburst ✦** | Treemap / Sunburst : Lignes puis Colonnes = niveaux de la hiérarchie |
| Corrélation | **Carte de chaleur ✦**, **Nuage de points ✦** | Nuage : champ numérique en Lignes (X), Valeur (Y), Colonnes = couleur ; droite de tendance et R² |
| Distribution | **Boîte à moustaches ✦**, **Histogramme ✦** | Champ numérique en Valeur ; Lignes/Colonnes = groupes |
| Flux | **Sankey ✦** | Au moins 2 champs : chaque champ est une étape |
| KPI | Grand nombre, **Grand nombre + tendance ✦**, **Jauge ✦** | Tendance : dernière période et évolution en % ; Jauge : option « Cible » |
| Tableau / Carte | Tableau croisé, Carte des points GPS | |

### Libellés du XLSForm

- L'application lit le **XForm publié** (`GET /v1/projects/:p/forms/:f.xml`). Les codes deviennent les libellés saisis dans le XLSForm, par exemple `protected_well` → « Puits protégé ». Cela vaut pour les graphiques, les légendes, les filtres, la liste des champs et les exports.
- **Toutes les langues** du formulaire (`label::Français (fr)`, `label::English (en)`…) sont proposées dans le menu **Libellés**, ainsi que « Valeurs brutes ».
- Les formes de choix prises en charge :
  - listes classiques, internes au formulaire ou en *itemset* (pyxform récent) ;
  - `choice_filter` ;
  - **select_one_from_file / select_multiple_from_file** et **listes d'entités** : le CSV joint au formulaire est lu, y compris les colonnes `label::langue`.
- Les catégories suivent l'**ordre des choix du formulaire**, pas l'ordre alphabétique.
- Dans les filtres, le code brut reste affiché à côté du libellé.
- Si le XForm n'est pas accessible, l'application affiche les codes en version lisible : `protected_well` → « Protected well ».

### Répétitions jointes à leurs parents

- Quand on choisit une table de répétition (par ex. « Membres du ménage »), l'application charge aussi la soumission parente et, pour les répétitions imbriquées, chaque niveau intermédiaire. Elle les relie grâce à la clé `__Submissions-id`.
- Les champs parents apparaissent dans la liste avec **↑** : région du ménage, date de soumission, enquêteur… On peut faire « membres vaccinés **par région** » ou « vaccins **par mois de soumission** ».
- Les filtres de période et d'état de revue s'appliquent aussi aux répétitions, par l'intermédiaire de la soumission parente (`$root/Submissions/...`). Pour les anciennes versions de Central, le filtrage se fait dans le navigateur.

### Cache des données (requêtes lourdes)

Télécharger toutes les soumissions d'un gros formulaire par OData peut prendre du temps. Le serveur garde donc chaque téléchargement en cache (une table × un filtre de période ou d'état de revue) :

- **Deux niveaux** : en mémoire (les plus utilisés) et sur le disque, en fichiers gzip (environ 10 à 20 fois plus petits). Le cache **survit aux redémarrages**. Les fichiers sont lisibles par le serveur seulement (droits 600).
- **Partagé entre utilisateurs** du même serveur ODK : si 20 personnes ouvrent le même formulaire, Central n'est sollicité qu'une fois. Avant de servir un cache, le serveur vérifie toujours que le compte ODK de l'utilisateur a accès au formulaire, avec une vérification toutes les 2 minutes.
- **Affichage immédiat** : les données de moins de `CACHE_MINUTES` sont servies directement. Plus anciennes, elles s'affichent tout de suite et se mettent à jour en arrière-plan ; le graphique se rafraîchit tout seul quand la mise à jour arrive.
- **Mise à jour incrémentale** :
  1. Une vérification légère est d'abord faite : quelques requêtes de comptage, sans télécharger de données. Si rien n'a changé, aucune donnée n'est téléchargée.
  2. Sinon, seules les soumissions **nouvelles ou modifiées** sont récupérées (`__system/submissionDate` / `__system/updatedAt`, ODK Central 1.3 et plus).
  3. Les suppressions et les changements d'état de revue sont détectés, et déclenchent alors un rechargement complet.
  4. Un rechargement complet a lieu au moins toutes les `CACHE_FULL_REFRESH_HOURS` heures.
- **Une seule requête à la fois** par donnée : des demandes simultanées attendent le même téléchargement.
- **Réponses compressées** (gzip) et **ETag** : un navigateur qui a déjà les données reçoit une réponse « 304 » vide.
- **Panneau « Cache des données »** (menu utilisateur) : pour chaque entrée, les lignes, la taille, la date de vérification, la dernière opération (complète, incrémentale ou vérifiée) et le nombre d'accès. Boutons pour actualiser, tout recharger, supprimer ou vider le cache.
- Le bouton **↻ actualiser** ne charge que les nouveautés ; **Maj + clic** recharge tout.

### Formateur de champs (ƒ)

Cliquez sur un champ, puis sur **« ƒ Formater / transformer… »**, ou sur **« + ƒ champ calculé »**. Un aperçu en direct, calculé sur les données chargées, montre des exemples avant → après, le nombre de valeurs converties et non reconnues, et la répartition du résultat.

| Transformation | Exemples |
|---|---|
| **Format d'affichage du nombre** | décimales, préfixe/suffixe (`FCFA`, `kg`), séparateur de milliers, échelle k / M, pourcentage. Seul l'affichage change, pas les données. |
| **Convertir en nombre** | texte « 1 234,5 », « 12 % », « 3000 FCFA » → nombre ; × / + ; arrondi |
| **Classes / tranches** | âge → `< 5 · 5 – 14 · 15 – 49 · 50 et +`, ou classes de même largeur, libellés personnalisés |
| **Regrouper / recoder** | `Forage`, `Robinet`, `Puits protégé` → « Eau améliorée » ; valeurs restantes gardées, en « Autre » ou ignorées ; fonctionne aussi sur les choix multiples |
| **Format du texte** | casse, espaces, accents, remplacer (expression régulière possible), extraire, N premiers caractères : « NIAMEY », « niamey » → « Niamey » |
| **Texte → date** | JJ/MM/AAAA, MM/JJ/AAAA, AAAA-MM-JJ, horodatage Unix, numéro de jour Excel |
| **Partie de date** | année, trimestre, mois, semaine ISO, jour de la semaine, heure… dans l'ordre du calendrier |
| **Âge / durée** | âge exact depuis une date de naissance ; durée d'entretien `start` → `end` en minutes ; jusqu'à aujourd'hui, la date de soumission ou un autre champ |
| **Calcul (formule)** | `${monthly_income} / ${hh_size}`, `if(${sex} = "female", 1, 0)`, `selected(${illnesses}, "malaria")`, `round(x, 1)`, `coalesce()`, `days_between()`, `concat()`… |

- Le résultat est un **nouveau champ** placé dans « ƒ Champs transformés ». Il sert comme n'importe quel champ : Colonnes, Lignes, Filtre, Valeur, tous les graphiques, les exports CSV.
- Les champs transformés d'une soumission sont aussi disponibles depuis ses **répétitions** (↑). Un champ transformé peut en utiliser un autre.
- Les transformations sont **enregistrées pour le formulaire** sur le serveur et partagées avec les utilisateurs qui y ont accès. Seul l'auteur peut les modifier ; les autres en font une copie.
- Une visualisation enregistrée embarque une copie des transformations qu'elle utilise : elle s'affiche même si le champ a été supprimé de la bibliothèque du formulaire.
- Les formules sont analysées par un interpréteur dédié : aucun code n'est exécuté (`eval` n'est jamais utilisé).
- Les dates ODK avec fuseau (`2026-03-05T00:30+01:00`) gardent la date et l'heure locales saisies sur l'appareil.

### Prise en main et confort d'utilisation

- **Page d'accueil** : l'écran de connexion présente l'outil (ce qu'il fait, ses fonctions principales, comment démarrer) et renvoie vers le guide.
- **Premiers pas** : à l'ouverture d'un formulaire, une carte explique comment créer le premier graphique. Le bouton **Montrer un exemple** en construit un automatiquement.
- **Guide d'utilisation** (`/aide.html`) : connexion, premier graphique, types de visualisation, filtres, libellés, répétitions, formateur, partage, raccourcis, questions fréquentes, glossaire DHIS2. Il contient des captures annotées et un champ de recherche, s'ouvre sans connexion et s'imprime. On y accède par le bouton **? Aide**.
- **Masquer le panneau latéral** : bouton à gauche de la barre du haut ou touche <kbd>P</kbd>. Le choix est mémorisé sur l'appareil.
- **Plein écran** du graphique : bouton en haut à droite du graphique ou touche <kbd>F</kbd>. Titre et filtres restent visibles. Sur iPhone, il y a un repli en plein fenêtre.
- **Rappel du contexte** sous le titre (formulaire, table, période, filtres), repris sur les **images PNG** téléchargées.

### Autres fonctions

- Source : projet → formulaire → table (soumissions ou n'importe quel groupe répété).
- N'importe quel champ peut être limité à certaines valeurs ; un champ à choix multiples compte chaque option cochée séparément.
- Tri par libellé ou par valeur, Top N, masquer « (vide) », afficher les valeurs.
- Export PNG, tableau agrégé en CSV (avec les libellés), données brutes en CSV (codes, plus une ligne de libellés de questions).
- Connexion avec son propre compte ODK Central, visualisations enregistrées et partagées par serveur.

## Lancer

```bash
docker compose up -d --build     # voir DOCKER.md
# ou sans Docker :
node server.js
```

Ouvrir `http://localhost:3000`. Le fichier `.env` est **facultatif** ; il sert seulement à des réglages comme le serveur par défaut. Voir `.env.example`.

## Réglages facultatifs (`.env`)

| Variable | Effet |
|---|---|
| `ODK_DEFAULT_URL` | Serveur proposé par défaut sur l'écran de connexion |
| `ODK_LOCK_URL=true` | Impose ce serveur : les utilisateurs saisissent seulement e-mail et mot de passe |
| `ALLOWED_SERVERS` | Liste blanche de serveurs Central autorisés, séparés par des virgules |
| `ALLOW_DEMO=false` | Masque le mode démonstration |
| `CACHE_MINUTES` | Fraîcheur du cache : au-delà, mise à jour en arrière-plan (5 min par défaut) |
| `CACHE_MAX_STALE_HOURS` | Au-delà, la mise à jour est attendue avant d'afficher (24 h) |
| `CACHE_FULL_REFRESH_HOURS` | Rechargement complet minimal (12 h) |
| `CACHE_PERSIST` | `false` = cache en mémoire seulement, rien sur le disque |
| `CACHE_MEMORY_MB` / `CACHE_DISK_MB` | Tailles maximales (256 Mo / 2 048 Mo, données compressées) |
| `COOKIE_SECURE` | `auto` (défaut), `true` ou `false` |

## Fonctionnement technique

Le navigateur ne parle jamais directement à Central. `server.js` relaie les appels avec le jeton de l'utilisateur connecté :

| Application | Appel ODK Central |
|---|---|
| `POST /api/login` | `POST /v1/sessions`, puis `GET /v1/users/current` |
| `POST /api/logout` | `DELETE /v1/sessions/:token` |
| `/api/projects` | `GET /v1/projects` |
| `/api/projects/:p/forms` | `GET /v1/projects/:p/forms` |
| `…/fields` | `GET /v1/projects/:p/forms/:f/fields?odata=true` |
| `…/tables` | `GET …/:f.svc/$metadata` |
| `…/labels` | `GET /v1/projects/:p/forms/:f.xml` + `GET …/attachments/:fichier.csv` |
| `…/data` | `GET …/:f.svc/<table>?$top=1000&$skip=…&$count=true&$filter=…` (toutes les pages ; `$root/Submissions/…` pour les répétitions), puis mises à jour par `$filter=__system/updatedAt gt …` et vérifications `$top=1&$count=true` |
| contrôle d'accès | `GET /v1/projects/:p/forms/:f` avec le jeton de l'utilisateur avant de servir un cache |

L'agrégation se fait dans le navigateur ; c'est rapide jusqu'à environ 100 000 lignes par table.

## Sécurité

- Servez l'application en **HTTPS** : le mot de passe transite du navigateur vers l'application. Voir DOCKER.md, section HTTPS.
- Le serveur se connecte à l'adresse saisie par l'utilisateur. Sur une installation publique, utilisez `ODK_LOCK_URL` ou `ALLOWED_SERVERS` pour limiter les serveurs joignables.
- La connexion est bloquée après 10 échecs en 10 minutes depuis la même adresse IP.
- Le cache sur disque contient des données de soumissions : il est dans le volume `data` (droits 600). Mettez `CACHE_PERSIST=false` si rien ne doit être écrit sur le disque.
- Les requêtes qui modifient des données doivent être en JSON, ce qui protège contre le CSRF.

## Pistes d'évolution

- **Connecteurs IASO, DHIS2, CommCare, mSupply** : voir [ROADMAP-CONNECTEURS.md](ROADMAP-CONNECTEURS.md) (ordre conseillé, API, prérequis).

- Ajouter les listes d'entités (*Entities*) comme source de données.
- Ajouter des tableaux de bord réunissant plusieurs visualisations, comme l'app Dashboard de DHIS2.
- Ajouter des cartes choroplèthes par limites administratives (GeoJSON).

## Fichiers

```
server.js        connexion ODK par utilisateur, proxy OData, cache, visualisations, fichiers statiques
xform.js         lecture des libellés du XForm (questions, choix, langues) et des CSV joints
cache.js         cache des données : mémoire LRU + fichiers gzip, une requête à la fois par donnée
public/transforms.js  moteur du formateur (conversions, classes, regroupements, dates, formules)
public/aide.html  guide d'utilisation (+ captures dans public/aide/)
ROADMAP-CONNECTEURS.md  plan des connecteurs IASO, DHIS2, CommCare, mSupply
demo-data.js     données de démonstration
public/          index.html, app.js (connexion, mise en page, agrégation, graphiques), styles.css
.env.example     réglages facultatifs
Dockerfile, docker-compose.yml, docker-compose.central.yml, DOCKER.md
```
