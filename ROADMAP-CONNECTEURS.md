# Connecteurs : état et feuille de route

ODK Visualizer lit **ODK Central**, **IASO** (Bluesquare) et **CommCare HQ** (Dimagi). Les mêmes fonctions marchent pour les trois :

- graphiques, libellés, formateur ƒ ;
- cache et mises à jour incrémentales ;
- visualisations enregistrées et partagées.

| Plateforme | État | Fichier |
|---|---|---|
| ODK Central | ✅ en service | `connectors/odk.js` |
| IASO | ✅ fait (version 2.0) | `connectors/iaso.js` |
| CommCare HQ | ✅ fait (version 2.0), formulaires | `connectors/commcare.js` |
| DHIS2 | à faire | — |
| mSupply | à faire | — |

## Principe : un « connecteur » par plateforme

Le cœur de l'application ne change pas. Chaque connecteur fournit les mêmes opérations :

| Opération | ODK Central | IASO | CommCare |
|---|---|---|---|
| `login` | `POST /v1/sessions` | `POST /api/token/` (JWT) | `GET /api/v0.5/identity/` (`ApiKey` ou `Basic`) |
| `projects` / `forms` | projets → formulaires | `/api/projects/` → `/api/forms/?projectsIds=` | `/api/v0.5/user_domains/` → `/a/<domaine>/api/v0.5/application/` |
| `fields` + `labels` | `/fields`, XForm | XForm de la dernière version (repli : descripteur, `possible_fields`) | questions de l'application |
| `rows` | OData `Submissions` (+ répétitions) | `/api/instances/` (pages) | `/a/<domaine>/api/v0.5/form/` (curseur `indexed_on`) |
| `changedSince` / `delta` | `__system/updatedAt gt …` | `modificationDateFrom` | `server_modified_on_start` |
| `access` | `GET /v1/projects/:p/forms/:f` | `GET /api/instances/?form_ids=…&limit=1` | `GET …/form/?xmlns=…&limit=1` |

`connectors/records.js` convertit les enregistrements d'IASO et de CommCare dans la forme des lignes OData de Central. C'est ce qui rend tout le reste réutilisable.

## Ce qui a été vérifié dans le code source

Faute de serveur de test, chaque appel a été vérifié dans le code source des plateformes, puis testé contre des **simulateurs** fidèles (`test/sim-iaso.js`, `test/sim-commcare.js`, `npm test`).

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

## Limites connues
- **IASO** : les répétitions imbriquées sont aplaties par IASO lui-même (seule la dernière ligne est gardée) ; elles apparaissent comme un groupe de la répétition parente. Les libellés des listes `select_one_from_file` ne sont pas encore lus (le CSV joint au formulaire n'est pas téléchargé).
- **CommCare** : seuls les **formulaires** sont pris en charge, pas encore les **cas** (Case API v2). Les libellés sont ceux de la **dernière version** de l'application.
- À valider sur de vrais serveurs : volumes importants, comptes avec restrictions de lieu, applications liées (*linked apps*).

## Suite conseillée

| # | Plateforme | Pourquoi | Données | Effort |
|---|---|---|---|---|
| 1 | **DHIS2** | Plateforme la plus répandue dans les ministères de la santé ; API très documentée ; serveurs de démonstration publics | **Tracker / événements** (enregistrements individuels) puis **agrégé** (analytics) | Moyen (tracker) à élevé (agrégé) |
| 2 | **CommCare : cas** | Suivi longitudinal (patients, ménages) | `GET /a/<domaine>/api/case/v2/` | Faible |
| 3 | **mSupply** | Données de **logistique** (stocks, factures, commandes), qui demandent des vues adaptées | Stocks, transactions | Moyen, documentation partielle |

### DHIS2
- Connexion : identifiant / mot de passe, ou **jeton d'accès personnel** (`Authorization: ApiToken d2pat_…`).
- Tracker : `GET /api/tracker/events` et `/api/tracker/trackedEntities`, pagination et filtres par programme, unité d'organisation et dates.
- Agrégé : `GET /api/analytics` (éléments de données × périodes × unités d'organisation).

### mSupply
- Connexion : `POST api/v4/login` → JWT valable 2 heures.
- Données : `GET /stock`, `GET /storeCustomerInvoice?startDate=…&endDate=…`, commandes clients. Pagination non documentée.

## Pour valider sur vos serveurs
1. Un **compte en lecture** sur un serveur IASO ou CommCare réel (ou de test), avec quelques formulaires.
2. Ouvrir chaque formulaire, comparer le nombre de soumissions et quelques graphiques avec la plateforme.
3. En cas d'écart, envoyer le message d'erreur et, si possible, une réponse JSON anonymisée de l'API.

## Sources
- IASO, code source : https://github.com/BLSQ/iaso (`iaso/api/instances/`, `iaso/api/forms/`, `iaso/api/org_units/`, `iaso/utils/__init__.py`)
- IASO, documentation des API : https://iaso.readthedocs.io/en/latest/pages/dev/how_to/use_iaso_apis/use_iaso_apis.html
- CommCare HQ, code source : https://github.com/dimagi/commcare-hq (`corehq/apps/api/`, `corehq/apps/app_manager/xform.py`, `corehq/apps/domain/auth.py`)
- DHIS2, jetons d'accès personnels : https://docs.dhis2.org/en/use/user-guides/dhis-core-version-240/working-with-your-account/personal-access-tokens.html
- DHIS2, API Tracker : https://docs.dhis2.org/zh/develop/using-the-api/dhis-core-version-242/tracker.html
- mSupply, API REST : https://docs.msupply.org.nz/web_interface:rest_api
