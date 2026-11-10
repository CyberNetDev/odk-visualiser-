# ODK Visualizer

Application de visualisation de données pour **ODK Central**, **IASO** (Bluesquare), **CommCare HQ** (Dimagi), **DHIS2** et **mSupply**, sur le modèle du *Data Visualizer* de DHIS2. Elle lit les données directement par l'API de chaque plateforme (flux OData pour Central) : soumissions de formulaires, programmes et données agrégées DHIS2, stock et transactions mSupply. On construit des graphiques, tableaux croisés et cartes GPS en glissant des champs dans **Colonnes / Lignes / Filtre**, sans export Excel.

| DHIS2 Data Visualizer | ODK Visualizer |
|---|---|
| Éléments de données / indicateurs | Champs du formulaire |
| Unités d'organisation | N'importe quel champ de choix (région, district, formation sanitaire…) ; avec IASO et DHIS2, la vraie hiérarchie d'unités d'organisation |
| Périodes | N'importe quel champ date, par jour / semaine / mois / trimestre / année |
| Valeurs | Nombre, % du total, ou Somme / Moyenne / Min / Max d'un champ numérique |
| Favoris | Visualisations enregistrées (lien partageable `#/<id>`) |

En plus des graphiques du *Data Visualizer* de DHIS2, l'application propose 13 types de visualisation inspirés de la galerie d'**Apache Superset** (marqués ✦ dans la liste).

## Plateformes prises en charge

| | ODK Central | IASO (Bluesquare) | CommCare HQ (Dimagi) |
|---|---|---|---|
| Connexion | e-mail + mot de passe du compte web | nom d'utilisateur + mot de passe | e-mail + **clé API** (ou mot de passe) |
| « Projets » | projets Central | projets IASO | espaces de projet |
| « Formulaires » | formulaires publiés | formulaires du projet | *Application › Module › Formulaire* |
| Libellés et langues | XForm publié + CSV joints | XForm de la dernière version (repli : descripteur pyxform, puis `possible_fields`) | structure de l'application (questions, options, traductions) |
| Répétitions | tables OData, tous niveaux | répétitions de premier niveau (IASO aplatit les suivantes) | tous niveaux (une répétition à une seule entrée est remise en liste) |
| Métadonnées | date de soumission, enquêteur, état de revue, appareil, version | date de création / modification / réception, créé par, période, statut, statut de validation, version, GPS | date de réception, début / fin de saisie, utilisateur mobile, appareil, version, GPS |
| En plus | filtre « État de revue » | **unité d'organisation, type et un champ par niveau de la pyramide** (pays › région › district…), position de l'unité | — |
| Filtre de dates | date de soumission | date de création (appareil, sinon serveur) | date de réception |
| Mise à jour incrémentale | `__system/updatedAt` (Central ≥ 1.3) | `modificationDateFrom` | `server_modified_on_start` |
| Cache | partagé entre utilisateurs du serveur (droits vérifiés) | **propre à chaque compte** (IASO filtre par unité d'organisation) | **propre à chaque compte** |

### DHIS2 et mSupply

| | DHIS2 | mSupply |
|---|---|---|
| Connexion | nom d'utilisateur + mot de passe, ou **jeton d'accès personnel** `d2pat_…` | nom d'utilisateur + mot de passe ; **Open mSupply** (GraphQL) ou **mSupply Desktop** (API REST v4), reconnu automatiquement |
| « Projets » | 3 types de données : programmes d'événements, programmes tracker, données agrégées | magasins du compte |
| « Formulaires » | programmes ou ensembles de données | stock disponible, expéditions sortantes, réceptions, dispensations, ajustements, réquisitions envoyées / reçues (Desktop : factures clients, stock du client) |
| Une ligne = | un événement ; une **inscription** (attributs) avec **une table jointe par étape** (événements) ; une **valeur** agrégée | un lot en stock ; une transaction, avec la table jointe **Lignes (articles)** |
| Libellés et langues | noms des éléments de données, attributs et options, avec les **traductions** DHIS2 | libellés français fixes (statuts, types) |
| En plus | **hiérarchie** (un champ par niveau), position de l'unité, début de la période (dates DHIS2 mensuelles, trimestrielles, hebdomadaires…) | péremption (périmé, < 3 mois…), unités = conditionnements × taille, valeur du stock, mois de stock |
| Filtre de dates | date de l'événement / d'inscription / périodes (agrégé : 12 derniers mois par défaut) | date de création des transactions (aucun pour le stock) |
| Mise à jour incrémentale | `updatedAfter` (événements, inscriptions et leurs événements) ; agrégé : `lastUpdated` + `includeDeleted` | non disponible : comptages par statut, rechargement complet au moins toutes les heures ; stock rechargé à chaque actualisation |
| Versions | 2.36 et plus (événements : aussi avant) ; 2.41+ : filtres de dates côté serveur | Open mSupply (champs inconnus d'un ancien serveur retirés automatiquement) ; Desktop : API web v4 |
| Cache | propre à chaque compte | propre à chaque compte |

Les enregistrements de toutes les plateformes sont convertis par le serveur dans la forme des lignes OData de Central (`__id`, `__system/…`, groupes imbriqués, tables `Submissions.<répétition>` reliées par `__Submissions-id`, points GPS en GeoJSON). Le reste de l'application (graphiques, libellés, formateur, cache, partage) fonctionne donc à l'identique pour les cinq plateformes.

## Connexion dans l'application

Il n'y a **aucun identifiant dans un fichier de configuration**. Au démarrage, l'application affiche un écran de connexion où l'utilisateur choisit sa plateforme puis saisit :

1. **Le serveur** : l'adresse habituelle, par ex. `https://central.monorg.org`, `https://iaso.bluesquare.org`, `https://www.commcarehq.org`, `https://dhis2.monministere.org` ou `https://msupply.monorg.org:8000` (les serveurs publics d'IASO et CommCare sont proposés). On peut coller l'URL complète du navigateur, elle est nettoyée automatiquement.
2. **Son identifiant** et **son mot de passe** (pour CommCare, de préférence une **clé API** ; pour DHIS2, un mot de passe ou un **jeton d'accès personnel**).

Ensuite :

- Chaque utilisateur ne voit **que les projets, formulaires et soumissions autorisés pour son propre compte**. Les rôles et droits de la plateforme s'appliquent tels quels.
- Le mot de passe n'est **jamais enregistré** (ni sur le disque ni dans le navigateur). Pour ODK Central et IASO, il est transmis **une seule fois** : le serveur garde ensuite le jeton de session renvoyé par la plateforme (jeton JWT pour IASO). CommCare et DHIS2 (authentification Basic ou jeton personnel) n'ont pas de jeton de session : la clé API, le jeton ou le mot de passe reste en mémoire sur le serveur pendant la session, car il accompagne chaque appel. Open mSupply renvoie un jeton de session, mSupply Desktop un jeton JWT de 2 h. Dans tous les cas, la session est liée à un cookie `HttpOnly`.
- La session dure aussi longtemps que celle de Central (24 h par défaut), 12 h pour IASO, CommCare, DHIS2 et Open mSupply (`SESSION_HOURS`), 2 h pour mSupply Desktop. À l'expiration, l'écran de connexion réapparaît.
- **Se déconnecter** ferme aussi la session côté ODK Central. **Changer de serveur / compte** permet de passer d'un serveur ou d'une plateforme à l'autre.
- Le dernier serveur et le dernier identifiant utilisés sont proposés au retour, pour chaque plateforme, avec une liste des serveurs récents. Ils sont mémorisés sur l'appareil, jamais le mot de passe.
- Un bouton **Essayer avec des données de démonstration** permet de tester sans serveur.

Les visualisations enregistrées et les champs transformés sont rattachés au serveur :

- Ils sont visibles par les utilisateurs du même serveur qui ont accès au projet concerné.
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
- **Partagé entre utilisateurs** du même serveur ODK : si 20 personnes ouvrent le même formulaire, Central n'est sollicité qu'une fois. Avant de servir un cache, le serveur vérifie toujours que le compte de l'utilisateur a accès au formulaire, avec une vérification toutes les 2 minutes. Pour IASO, CommCare, DHIS2 et mSupply, qui limitent les données visibles selon l'utilisateur (unités d'organisation, lieux, magasins), le cache est **propre à chaque compte**.
- **Affichage immédiat** : les données de moins de `CACHE_MINUTES` sont servies directement. Plus anciennes, elles s'affichent tout de suite et se mettent à jour en arrière-plan ; le graphique se rafraîchit tout seul quand la mise à jour arrive.
- **Mise à jour incrémentale** :
  1. Une vérification légère est d'abord faite : quelques requêtes de comptage, sans télécharger de données. Si rien n'a changé, aucune donnée n'est téléchargée.
  2. Sinon, seules les soumissions **nouvelles ou modifiées** sont récupérées (ODK Central 1.3 et plus : `__system/submissionDate` / `__system/updatedAt` ; IASO : `modificationDateFrom` ; CommCare : `server_modified_on_start` ; DHIS2 : `updatedAfter`, et pour l'agrégé `lastUpdated` avec les valeurs supprimées). Pour IASO, CommCare et les programmes tracker DHIS2, les **tables jointes** (répétitions, étapes) sont elles aussi mises à jour de façon incrémentale : les lignes des soumissions ou inscriptions modifiées sont remplacées. mSupply n'a pas de filtre « modifié depuis » : les nouvelles transactions et les changements de statut sont détectés par des comptages, et un rechargement complet a lieu au moins toutes les heures.
  3. Les suppressions, archivages et changements d'état de revue sont détectés, et déclenchent alors un rechargement complet.
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
- Connexion avec son propre compte ODK Central, IASO ou CommCare, visualisations enregistrées et partagées par serveur.

## Lancer

```bash
docker compose up -d --build     # voir DOCKER.md
# ou sans Docker :
node server.js
npm install && npm test         # tests des connecteurs contre des simulateurs (graphql : dépendance de test seulement)
```

Ouvrir `http://localhost:3000`. Le fichier `.env` est **facultatif** ; il sert seulement à des réglages comme le serveur par défaut. Voir `.env.example`.

## Réglages facultatifs (`.env`)

| Variable | Effet |
|---|---|
| `PLATFORMS` | Plateformes proposées, dans l'ordre : `odk,iaso,commcare,dhis2,msupply` (défaut). Ex. `dhis2,msupply` |
| `ODK_DEFAULT_URL`, `IASO_DEFAULT_URL`, `COMMCARE_DEFAULT_URL`, `DHIS2_DEFAULT_URL`, `MSUPPLY_DEFAULT_URL` | Serveur proposé par défaut pour chaque plateforme |
| `ODK_LOCK_URL=true` (idem `IASO_`, `COMMCARE_`, `DHIS2_`, `MSUPPLY_LOCK_URL`) | Impose ce serveur : les utilisateurs saisissent seulement identifiant et mot de passe |
| `ALLOWED_SERVERS` | Liste blanche de serveurs autorisés (toutes plateformes), séparés par des virgules |
| `SESSION_HOURS` | Durée maximale d'une session IASO, CommCare, DHIS2 ou Open mSupply (12 h) |
| `IASO_PAGE_SIZE`, `COMMCARE_PAGE_SIZE`, `DHIS2_PAGE_SIZE`, `MSUPPLY_PAGE_SIZE` | Taille des pages demandées (500 / 1000 / 1000 / 500) |
| `DHIS2_DEFAULT_MONTHS` | Données agrégées DHIS2 sans dates choisies : nombre de mois chargés (12) |
| `ALLOW_DEMO=false` | Masque le mode démonstration |
| `CACHE_MINUTES` | Fraîcheur du cache : au-delà, mise à jour en arrière-plan (5 min par défaut) |
| `CACHE_MAX_STALE_HOURS` | Au-delà, la mise à jour est attendue avant d'afficher (24 h) |
| `CACHE_FULL_REFRESH_HOURS` | Rechargement complet minimal (12 h) |
| `CACHE_PERSIST` | `false` = cache en mémoire seulement, rien sur le disque |
| `CACHE_MEMORY_MB` / `CACHE_DISK_MB` | Tailles maximales (256 Mo / 2 048 Mo, données compressées) |
| `COOKIE_SECURE` | `auto` (défaut), `true` ou `false` |

## Fonctionnement technique

Le navigateur ne parle jamais directement à la plateforme. `server.js` relaie les appels avec le jeton de l'utilisateur connecté, par l'intermédiaire d'un **connecteur** par plateforme (`connectors/odk.js`, `iaso.js`, `commcare.js`), qui fournit toujours les mêmes opérations : connexion, projets, formulaires, tables, champs, libellés, lignes, comptages et mises à jour incrémentales, contrôle d'accès.

### ODK Central

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

### IASO

Appels vérifiés dans le code source d'IASO ([BLSQ/iaso](https://github.com/BLSQ/iaso)).

| Application | Appel IASO |
|---|---|
| `POST /api/login` | `POST /api/token/` (`username`, `password` → jeton JWT), puis `GET /api/profiles/me/` |
| `/api/projects` | `GET /api/projects/` |
| `/api/projects/:p/forms` | `GET /api/forms/?projectsIds=:p` |
| `…/fields`, `…/labels`, `…/tables` | `GET /api/forms/:f/` puis le XForm de `latest_form_version.file` (le jeton n'est jamais envoyé à un autre hôte, par ex. S3) ; repli `GET /api/formversions/:v/?fields=descriptor`, puis `possible_fields` |
| hiérarchie | `GET /api/v2/orgunittypes/?project=:p` (niveaux par profondeur) et `GET /api/orgunits/?smallSearch=true&searches=[{"search":"ids:…"}]` (parents) |
| `…/data` | `GET /api/instances/?form_ids=:f&order=id&limit=500&page=…` (+ `dateFrom` / `dateTo`), puis `modificationDateFrom` ; vérifications `limit=1` (total) et `order=-updated_at&limit=100` |
| contrôle d'accès | `GET /api/instances/?form_ids=:f&limit=1` avec le jeton de l'utilisateur |

`file_content` d'IASO est « à plat » (clés = noms des questions, groupes supprimés) : le connecteur reconstruit les chemins complets grâce au XForm.

### CommCare HQ

Appels vérifiés dans le code source de CommCare HQ ([dimagi/commcare-hq](https://github.com/dimagi/commcare-hq), `corehq/apps/api`).

| Application | Appel CommCare |
|---|---|
| `POST /api/login` | `GET /api/v0.5/identity/` avec `Authorization: ApiKey <e-mail>:<clé>`, sinon `Basic` |
| `/api/projects` | `GET /api/v0.5/user_domains/` |
| `/api/projects/:domaine/forms`, `…/fields`, `…/labels` | `GET /a/:domaine/api/v0.5/application/` (modules, formulaires, questions, options, traductions) |
| `…/data` | `GET /a/:domaine/api/v0.5/form/?xmlns=…&app_id=…&limit=1000&order_by=indexed_on&indexed_on_start=…` (pagination par curseur : pas de limite des 10 000 résultats d'Elasticsearch), + `received_on_start` / `_end` ; mises à jour par `server_modified_on_start` |
| limitation de débit | réponses 429 : attente (`Retry-After`) puis nouvel essai |

### DHIS2

Appels vérifiés dans le code source de DHIS2 ([dhis2/dhis2-core](https://github.com/dhis2/dhis2-core), contrôleurs `tracker/export`) et sa documentation.

| Application | Appel DHIS2 |
|---|---|
| `POST /api/login` | `GET /api/me` avec `Authorization: Basic …` ou `ApiToken d2pat_…`, puis `GET /api/system/info` (version) |
| `/api/projects`, `…/forms` | `GET /api/programs?fields=id,displayName,programType`, `GET /api/dataSets` |
| `…/fields`, `…/labels`, `…/tables` | `GET /api/programs/:p?fields=programStages[programStageDataElements[dataElement[…,optionSet,translations]]],programTrackedEntityAttributes[…]` ; `GET /api/dataSets/:d?fields=dataSetElements[…],categoryCombo[categoryOptionCombos]` |
| hiérarchie | `GET /api/organisationUnitLevels`, `GET /api/organisationUnits?filter=id:in:[…]&fields=…,ancestors[…],geometry` |
| événements | `GET /api/tracker/events?program=…&page=…&pageSize=1000` (+ `occurredAfter/Before` en 2.41+) ; mises à jour `updatedAfter=…&includeDeleted=true` ; avant 2.36 : `GET /api/events` |
| tracker | `GET /api/tracker/enrollments?program=…&fields=…,attributes[…],events[…]` (+ `enrolledAfter/Before` en 2.41+) ; mises à jour : inscriptions et événements `updatedAfter`, puis `GET /api/tracker/enrollments/:id` |
| agrégé | `GET /api/dataValueSets.json?dataSet=…&orgUnit=<racines du compte>&children=true&startDate=…&endDate=…` ; mises à jour `lastUpdated=…&includeDeleted=true` |

Réponses en 2.41+ : `{pager, events|enrollments}`, mode d'unités d'organisation implicite (`ACCESSIBLE`) ; en 2.36–2.40 : `{page, total, instances}` avec `ouMode=ACCESSIBLE`. Le connecteur s'adapte à la version.

### mSupply

| Application | Open mSupply (GraphQL, `POST /graphql`, vérifié dans [msupply-foundation/open-msupply](https://github.com/msupply-foundation/open-msupply)) | mSupply Desktop (API REST v4, d'après la documentation) |
|---|---|---|
| connexion | `authToken(username, password)` → jeton, puis `Authorization: Bearer` ; `me { stores { nodes { id code name } } }` | `POST /api/v4/login` (`loginType` `storeInvoice` puis `invoice`) → jeton JWT (cookie) |
| stock | `stockLines(storeId, page: {first, offset}, sort: {key: itemName})` | `GET /api/v4/stock` (contact) |
| transactions | `invoices(storeId, page, sort, filter: {type: {equalAny: […]}, createdDatetime})` avec `lines { nodes { … } }` | `GET /api/v4/storeCustomerInvoice?startDate=…&endDate=…` (utilisateur), `GET /api/v4/customerInvoice` (contact) |
| réquisitions | `requisitions(storeId, page, sort, filter: {type, createdDatetime})` avec `lines` | — |
| changements | comptages par statut (un alias GraphQL par statut, une seule requête) | — |

Si un serveur Open mSupply plus ancien ne connaît pas un champ (« Unknown field »), le connecteur le retire de la requête et réessaie.

### Simulateurs et tests

`test/sim-iaso.js`, `test/sim-commcare.js`, `test/sim-dhis2.js` (versions 2.35, 2.40 ou 2.41) et `test/sim-msupply.js` (Open mSupply en GraphQL + mSupply Desktop) imitent les API des plateformes (formats de réponse, pagination, filtres, droits, restrictions par unité d'organisation ou magasin, limitation de débit), d'après leur code source ou leur documentation. `npm test` lance les simulateurs et le serveur, et vérifie les connecteurs de bout en bout. Les simulateurs servent aussi à essayer l'application sans compte : par exemple `npm run sim:dhis2`, puis se connecter à `http://localhost:4630` avec `admin` / `district` ; `npm run sim:msupply`, puis `http://localhost:4640` avec `admin` / `pass`.

L'agrégation se fait dans le navigateur ; c'est rapide jusqu'à environ 100 000 lignes par table.

## Sécurité

- Servez l'application en **HTTPS** : le mot de passe transite du navigateur vers l'application. Voir DOCKER.md, section HTTPS.
- Le serveur se connecte à l'adresse saisie par l'utilisateur. Sur une installation publique, utilisez les variables `…_LOCK_URL`, `PLATFORMS` ou `ALLOWED_SERVERS` pour limiter les serveurs joignables.
- La clé API ou le mot de passe CommCare, et le mot de passe ou le jeton DHIS2, restent en mémoire sur le serveur pendant la session, car ils servent à chaque appel ; ils ne sont jamais écrits sur le disque ni renvoyés au navigateur. Préférez une clé API (CommCare) ou un jeton d'accès personnel (DHIS2) : ils se révoquent sans changer de mot de passe.
- La connexion est bloquée après 10 échecs en 10 minutes depuis la même adresse IP.
- Le cache sur disque contient des données de soumissions : il est dans le volume `data` (droits 600). Mettez `CACHE_PERSIST=false` si rien ne doit être écrit sur le disque.
- Les requêtes qui modifient des données doivent être en JSON, ce qui protège contre le CSRF.

## Pistes d'évolution

- Connecteurs : état et limites dans [ROADMAP-CONNECTEURS.md](ROADMAP-CONNECTEURS.md).
- CommCare : ajouter les **cas** (Case API) comme source de données, en plus des formulaires.
- DHIS2 : ajouter les **indicateurs** et les données déjà agrégées par l'API `analytics` (plus rapide que les valeurs brutes pour les grands pays).

- Ajouter les listes d'entités (*Entities*) comme source de données.
- Ajouter des tableaux de bord réunissant plusieurs visualisations, comme l'app Dashboard de DHIS2.
- Ajouter des cartes choroplèthes par limites administratives (GeoJSON).

## Fichiers

```
server.js        sessions, routes, cache, visualisations, fichiers statiques
connectors/      un connecteur par plateforme : odk.js, iaso.js, commcare.js, dhis2.js, msupply.js (+ records.js : conversion
                 des enregistrements au format des lignes OData ; common.js : outils communs)
xform.js         lecture du XForm : champs, libellés (questions, choix, langues) et CSV joints
test/            tests (npm test), simulateurs IASO, CommCare, DHIS2 et mSupply, formulaires d'exemple
cache.js         cache des données : mémoire LRU + fichiers gzip, une requête à la fois par donnée
public/transforms.js  moteur du formateur (conversions, classes, regroupements, dates, formules)
public/aide.html  guide d'utilisation (+ captures dans public/aide/)
ROADMAP-CONNECTEURS.md  connecteurs : ce qui a été vérifié, limites connues, suites possibles
demo-data.js     données de démonstration
public/          index.html, app.js (connexion, mise en page, agrégation, graphiques), styles.css
.env.example     réglages facultatifs
Dockerfile, docker-compose.yml, docker-compose.central.yml, DOCKER.md
```
