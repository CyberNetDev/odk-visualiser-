# Connecteurs : état et feuille de route

ODK Visualizer lit **ODK Central**, **IASO** (Bluesquare), **CommCare HQ** (Dimagi), **DHIS2** et **mSupply**. Les mêmes fonctions marchent pour les cinq :

- graphiques, libellés, formateur ƒ ;
- cache et mises à jour incrémentales ;
- visualisations enregistrées et partagées.

| Plateforme | État | Fichier |
|---|---|---|
| ODK Central | ✅ en service | `connectors/odk.js` |
| IASO | ✅ fait (version 2.0) | `connectors/iaso.js` |
| CommCare HQ | ✅ fait (version 2.0), formulaires | `connectors/commcare.js` |
| DHIS2 | ✅ fait (version 2.1) : événements, tracker, agrégé | `connectors/dhis2.js` |
| mSupply | ✅ fait (version 2.1) : Open mSupply ; mSupply Desktop (API web v4, partiel) | `connectors/msupply.js` |

## Principe : un « connecteur » par plateforme

Le cœur de l'application ne change pas. Chaque connecteur fournit les mêmes opérations :

| Opération | ODK Central | IASO | CommCare | DHIS2 | mSupply (Open) |
|---|---|---|---|---|---|
| `login` | `POST /v1/sessions` | `POST /api/token/` (JWT) | `GET /api/v0.5/identity/` (`ApiKey` ou `Basic`) | `GET /api/me` (`Basic` ou `ApiToken`) | `authToken` (GraphQL) |
| `projects` / `forms` | projets → formulaires | `/api/projects/` → `/api/forms/` | domaines → applications | type de données → programmes / ensembles | magasins → jeux de données fixes |
| `fields` + `labels` | `/fields`, XForm | XForm (repli : descripteur, `possible_fields`) | questions de l'application | éléments, attributs, options, traductions | définitions du connecteur |
| `rows` | OData | `/api/instances/` | `/a/<domaine>/api/v0.5/form/` | `/api/tracker/events`, `/enrollments`, `/api/dataValueSets` | `stockLines`, `invoices`, `requisitions` |
| `changedSince` / `delta` | `__system/updatedAt` | `modificationDateFrom` | `server_modified_on_start` | `updatedAfter`, `lastUpdated` + `includeDeleted` | comptages par statut (pas de delta) |
| `access` | `GET /v1/projects/:p/forms/:f` | `GET /api/instances/?…&limit=1` | `GET …/form/?…&limit=1` | `GET /api/programs/:p` ou `/api/dataSets/:d` | magasins du compte |

Chaque connecteur convertit ses enregistrements dans la forme des lignes OData de Central (`connectors/records.js` pour IASO et CommCare). C'est ce qui rend tout le reste réutilisable.

## Ce qui a été vérifié dans le code source

Faute de serveur de test, chaque appel a été vérifié dans le code source des plateformes (ou, pour mSupply Desktop, dans sa documentation), puis testé contre des **simulateurs** (`test/sim-*.js`, `npm test`).

### IASO ([BLSQ/iaso](https://github.com/BLSQ/iaso))
- Jeton : `POST /api/token/` → `{access, refresh}` (simplejwt, durée très longue) ; la session de l'application est limitée à `SESSION_HOURS`.
- Soumissions : `file_content` est un JSON **à plat** (`flat_parse_xml_soup`) : les clés sont les noms des questions, les groupes disparaissent, seules les répétitions de premier niveau sont des listes. Le connecteur reconstruit les chemins à partir du XForm.
- Pagination `limit` / `page` ; une page au-delà de la dernière renvoie la dernière (on s'arrête sur `has_next`).
- `dateFrom` / `dateTo` portent sur `Coalesce(source_created_at, created_at)` ; `modificationDateFrom` sur `updated_at`, au jour près (le recouvrement est fusionné par identifiant).
- Les soumissions sont filtrées selon l'utilisateur (`filter_for_user`) : le cache est donc propre à chaque compte.
- Hiérarchie : `org_unit` de chaque soumission (sans parents) ; parents via `/api/orgunits/?smallSearch=true` (parents imbriqués) ; niveaux via `/api/v2/orgunittypes/?project=` (profondeur).
- Statut de validation : `APPROVED`, `REJECTED`, `PENDING` (`ValidationWorkflowArtefactStatus`).

### CommCare HQ ([dimagi/commcare-hq](https://github.com/dimagi/commcare-hq), `corehq/apps/api`)
- Authentification : `ApiKey <utilisateur>:<clé>` ; `Basic` accepte le mot de passe ou la clé API (`basic_auth_or_try_api_key_auth`).
- API des formulaires : droits `access_api` + `edit_data` ; filtres `xmlns`, `app_id`, `received_on_start/_end`, `server_modified_on_start`, `indexed_on_start` ; dates sans fuseau (`%Y-%m-%d`, `%Y-%m-%dT%H:%M:%S(.%f)`) ; tri `order_by=received_on|server_modified_on|indexed_on` ; `meta.next` / `meta.total_count`.
- Pagination par curseur sur `indexed_on` (avec décalage quand de nombreux formulaires ont le même horodatage), pour dépasser la fenêtre de 10 000 résultats d'Elasticsearch.
- Structure : `form.get_questions(langs, include_groups, include_translations)` → `value` (`/data/…`), `type` (`Text`, `Int`, `Select`, `MSelect`, `Repeat`, `DataBindOnly`…), `options`, `translations`.
- Une répétition à une seule entrée arrive comme un objet : elle est remise en liste. Les blocs `case` et `meta` sont écartés des champs.
- Limitation de débit : réponses 429 avec `Retry-After`, gérées par nouvel essai.

### DHIS2 ([dhis2/dhis2-core](https://github.com/dhis2/dhis2-core), `dhis-web-api/…/tracker/export`)
- Authentification `Basic` ou jeton d'accès personnel (`ApiToken d2pat_…`) ; version lue dans `/api/system/info`.
- Tracker 2.41+ : réponse `{pager: {page, pageSize, total, pageCount, nextPage}, events|enrollments}` ; sans unité d'organisation ni `orgUnitMode`, le mode est `ACCESSIBLE` (`RequestParamsValidator.validateOrgUnitMode`) ; `ouMode` a disparu des versions récentes. 2.36–2.40 : `{page, pageSize, total, instances}` avec `ouMode=ACCESSIBLE`.
- Paramètres vérifiés : événements `program`, `occurredAfter/Before`, `updatedAfter`, `includeDeleted`, `totalPages` ; inscriptions `enrolledAfter/Before`, `updatedAfter`, champs `attributes` et `events` dans la vue `Enrollment`.
- Les dates acceptées par DHIS2 incluent `yyyy-MM-dd'T'HH:mm:ss.SSSZ` (`DateUtils`) : le connecteur envoie des dates UTC.
- Valeurs : `COORDINATE` = `[longitude,latitude]`, `MULTI_TEXT` = codes séparés par des virgules, booléens `true`/`false`.
- Agrégé : `dataValueSets` demande un ensemble de données, des unités d'organisation et une période (`startDate`/`endDate` ou `lastUpdated`).

### Open mSupply ([msupply-foundation/open-msupply](https://github.com/msupply-foundation/open-msupply), `server/graphql`)
- `authToken` renvoie un jeton opaque (dans le corps et un cookie), à envoyer en `Authorization: Bearer` (`auth_data_from_request`).
- Pagination `page: {first, offset}` ; listes = unions (`… on InvoiceConnector { totalCount nodes }`) ; filtres `EqualFilter` (`equalTo`, `equalAny`) et `DatetimeFilter` (`afterOrEqualTo`, `beforeOrEqualTo`) ; clés de tri en camelCase, énumérations en majuscules.
- Erreurs d'accès : `Unauthenticated` / `Forbidden` (`StandardGraphqlError`) ; champ inconnu d'une version plus ancienne : retiré automatiquement.
- Aucun filtre « modifié depuis » sur les factures : détection par comptages par statut.

### mSupply Desktop (documentation de l'API REST v4)
- `POST /api/v4/login` (`username`, `password`, `loginType`) → JWT de 2 heures. La documentation dit qu'il est renvoyé dans un cookie : le connecteur prend le jeton du corps s'il existe, sinon le cookie.
- Utilisateur mSupply : `GET /storeCustomerInvoice?startDate&endDate` ; contact d'un magasin : `GET /stock`, `GET /customerInvoice`. Pas de pagination documentée.

## Limites connues
- **IASO** : les répétitions imbriquées sont aplaties par IASO lui-même (seule la dernière ligne est gardée) ; elles apparaissent comme un groupe de la répétition parente. Les libellés des listes `select_one_from_file` ne sont pas encore lus (le CSV joint au formulaire n'est pas téléchargé).
- **CommCare** : seuls les **formulaires** sont pris en charge, pas encore les **cas** (Case API v2). Les libellés sont ceux de la **dernière version** de l'application.
- **DHIS2** : les valeurs agrégées sont téléchargées une à une (pas encore l'API `analytics` ni les indicateurs) : préférer des périodes courtes pour un pays entier. Les valeurs de type unité d'organisation restent des identifiants. Avant 2.41, le filtre de dates du tracker est appliqué après téléchargement. Tracker : DHIS2 2.36 minimum.
- **mSupply** : jeux de données fixes (stock, transactions, réquisitions) ; pas encore les inventaires ni les mouvements détaillés (`itemLedger`). Les modifications d'une transaction sans changement de statut apparaissent au rechargement complet (au moins toutes les heures). mSupply Desktop : seulement ce que son API web expose, et la connexion par cookie JWT n'a pas pu être vérifiée sur un vrai serveur.
- À valider sur de vrais serveurs : volumes importants, comptes avec restrictions de lieu ou de magasin, applications liées (*linked apps*).

## Suites possibles

| # | Sujet | Pourquoi | Effort |
|---|---|---|---|
| 1 | **DHIS2 `analytics`** et indicateurs | Données déjà agrégées par DHIS2 : rapide pour un pays entier, indicateurs calculés | Moyen |
| 2 | **CommCare : cas** (`/a/<domaine>/api/case/v2/`) | Suivi longitudinal (patients, ménages) | Faible |
| 3 | **mSupply : inventaires et mouvements** (`stocktakes`, `itemLedger`) | Écarts d'inventaire, consommation par article | Faible |
| 4 | **Tableaux de bord** réunissant plusieurs visualisations, de plusieurs plateformes | Vue unique ODK + DHIS2 + mSupply | Moyen |

## Pour valider sur vos serveurs
1. Un **compte en lecture** sur un serveur réel ou de test (IASO, CommCare, DHIS2 — par exemple un serveur de démonstration `play.im.dhis2.org` — ou mSupply), avec quelques données.
2. Ouvrir chaque formulaire, comparer le nombre de soumissions et quelques graphiques avec la plateforme.
3. En cas d'écart, envoyer le message d'erreur et, si possible, une réponse JSON anonymisée de l'API.

## Sources
- IASO, code source : https://github.com/BLSQ/iaso (`iaso/api/instances/`, `iaso/api/forms/`, `iaso/api/org_units/`, `iaso/utils/__init__.py`)
- IASO, documentation des API : https://iaso.readthedocs.io/en/latest/pages/dev/how_to/use_iaso_apis/use_iaso_apis.html
- CommCare HQ, code source : https://github.com/dimagi/commcare-hq (`corehq/apps/api/`, `corehq/apps/app_manager/xform.py`, `corehq/apps/domain/auth.py`)
- DHIS2, code source : https://github.com/dhis2/dhis2-core (`dhis-web-api/src/main/java/org/hisp/dhis/webapi/controller/tracker/`)
- Open mSupply, code source : https://github.com/msupply-foundation/open-msupply (`server/graphql/`)
- mSupply Desktop, API REST v4 : https://docs.msupply.org.nz/web_interface:rest_api
- DHIS2, jetons d'accès personnels : https://docs.dhis2.org/en/use/user-guides/dhis-core-version-240/working-with-your-account/personal-access-tokens.html
- DHIS2, API Tracker : https://docs.dhis2.org/zh/develop/using-the-api/dhis-core-version-242/tracker.html
- mSupply, API REST : https://docs.msupply.org.nz/web_interface:rest_api
