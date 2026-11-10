// DHIS2 connector: event programs, tracker programs and aggregate data sets.
//
// API used (checked against the DHIS2 source code, github.com/dhis2/dhis2-core, dhis-web-api
// .../controller/tracker/export, and the DHIS2 developer documentation):
//   Authorization: Basic <user:password>  or  ApiToken d2pat_…  (personal access token, DHIS2 ≥ 2.38)
//   GET /api/me, /api/system/info (version), /api/programs, /api/dataSets, /api/organisationUnits,
//       /api/organisationUnitLevels
//   GET /api/tracker/events       ?program=…&page=…&pageSize=…&totalPages=…&updatedAfter=…&occurredAfter=…
//   GET /api/tracker/enrollments  ?program=…&fields=…,attributes[…],events[…]&enrolledAfter=…&updatedAfter=…
//       DHIS2 ≥ 2.41: {pager: {page, pageSize, total}, events|enrollments: [...]}, org unit mode ACCESSIBLE
//       by default ; 2.36–2.40: {page, pageSize, total, instances: [...]} with ouMode=ACCESSIBLE.
//   GET /api/events (DHIS2 < 2.36, event programs only)
//   GET /api/dataValueSets.json   ?dataSet=…&orgUnit=…&children=true&startDate=…&endDate=…&lastUpdated=…
//
// "Projects" are the three kinds of DHIS2 data; "forms" are programs or data sets. A tracker program
// becomes one row per enrollment (tracked entity attributes) with one child table per program stage
// (events), joined like ODK repeats. Rows are per user (DHIS2 restricts data by org unit).

const { httpError, fetchWithTimeout, normalizeServer, memoize, enc, isoOrNull, toGeoPoint } = require('./common');

const PAGE = Number(process.env.DHIS2_PAGE_SIZE || 1000);
const EN_PAGE = Math.max(50, Math.floor(PAGE / 5)); // enrollments come with all their events
const META_MS = Number(process.env.CACHE_MINUTES || 5) * 60_000;
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const AGG_MONTHS = Number(process.env.DHIS2_DEFAULT_MONTHS || 12);

const KINDS = {
  evenements: 'Programmes d\'événements',
  tracker: 'Programmes tracker (avec inscription)',
  agrege: 'Données agrégées (ensembles de données)',
};
const PERIOD_TYPES = { Daily: 'quotidien', Weekly: 'hebdomadaire', WeeklyWednesday: 'hebdomadaire', WeeklyThursday: 'hebdomadaire', WeeklySaturday: 'hebdomadaire', WeeklySunday: 'hebdomadaire',
  BiWeekly: 'bimensuel', Monthly: 'mensuel', BiMonthly: 'bimestriel', Quarterly: 'trimestriel', QuarterlyNov: 'trimestriel', SixMonthly: 'semestriel', SixMonthlyApril: 'semestriel', SixMonthlyNov: 'semestriel',
  Yearly: 'annuel', FinancialApril: 'annuel (exercice avril)', FinancialJuly: 'annuel (exercice juillet)', FinancialOct: 'annuel (exercice octobre)', FinancialNov: 'annuel (exercice novembre)' };
const NUMERIC = new Set(['NUMBER', 'INTEGER', 'INTEGER_POSITIVE', 'INTEGER_NEGATIVE', 'INTEGER_ZERO_OR_POSITIVE', 'PERCENTAGE', 'UNIT_INTERVAL']);
const TYPE = vt => (NUMERIC.has(vt) ? (/^INTEGER/.test(vt) ? 'int' : 'decimal') : vt === 'DATE' || vt === 'AGE' ? 'date' : vt === 'DATETIME' ? 'dateTime' : vt === 'TIME' ? 'time'
  : vt === 'COORDINATE' ? 'geopoint' : vt === 'FILE_RESOURCE' || vt === 'IMAGE' ? 'binary' : 'string');
const EVENT_STATUS = { ACTIVE: 'Active', COMPLETED: 'Terminé', VISITED: 'Visité', SCHEDULE: 'Planifié', OVERDUE: 'En retard', SKIPPED: 'Ignoré' };
const ENROLLMENT_STATUS = { ACTIVE: 'Active', COMPLETED: 'Terminée', CANCELLED: 'Annulée' };
const YES_NO = { true: { '': 'Oui' }, false: { '': 'Non' } };
const fr = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { '': v }]));

const userKey = sess => `dhis2|${sess.server}|${sess.email}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const v41 = sess => (sess.d2v || 0) >= 41;
// org unit selection: implicit ACCESSIBLE from 2.41 (ouMode is refused together with orgUnitMode there)
const ou = sess => (v41(sess) ? '' : '&ouMode=ACCESSIBLE');

async function d2(sess, target) {
  const url = `${sess.server}${target}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetchWithTimeout(url, { headers: { Authorization: sess.token, Accept: 'application/json' }, redirect: 'manual' }, 300_000); }
    catch (e) { throw httpError(502, `Serveur DHIS2 injoignable (${e.name === 'AbortError' ? 'délai dépassé' : e.cause?.code || e.message}).`); }
    if ((res.status === 429 || res.status === 503) && attempt < 3) { await sleep(Math.min(30, Number(res.headers.get('retry-after')) || 2 ** attempt * 2) * 1000); continue; }
    // DHIS2 answers an expired session with 401, or a redirect to its login page
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) { const err = httpError(401, 'Session DHIS2 expirée ou jeton révoqué, reconnectez-vous.'); err.relogin = true; throw err; }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
    const msg = body && typeof body === 'object' ? body.message || body.httpStatus : String(body || '').slice(0, 200);
    if (res.status === 403) throw httpError(403, `Votre compte DHIS2 n'a pas accès à ces données${msg ? ` (${msg})` : ''}.`);
    if (res.status === 404) { const e = httpError(404, 'Ressource introuvable sur DHIS2.'); e.notFound = true; throw e; }
    if (!res.ok) throw httpError(res.status >= 500 ? 502 : 400, `DHIS2 ${res.status} : ${msg}`);
    if (!body || typeof body !== 'object') throw httpError(502, 'Réponse inattendue de DHIS2 (pas du JSON).');
    return body;
  }
}

// one page of a tracker export: 2.41+ {pager, events|enrollments}, 2.36–2.40 {page, total, instances}
const items = (r, key) => r[key] || r.instances || [];
const totalOf = r => (r.pager ? r.pager.total : r.total);

async function pages(sess, path, key, size = PAGE) {
  const out = [], seen = new Set();
  for (let page = 1; page < 100000; page++) {
    const r = await d2(sess, `${path}&page=${page}&pageSize=${size}`);
    const list = items(r, key);
    for (const x of list) { const id = x.event || x.enrollment || x.trackedEntity; if (!id || !seen.has(id)) { seen.add(id); out.push(x); } }
    if (list.length < size) break;
    const pc = r.pager ? r.pager.pageCount : r.pageCount;
    if (pc && page >= pc) break;
  }
  return out;
}

// ---------------------------------------------------------------- metadata
const programs = sess => memoize(`${userKey(sess)}|programs`, async () =>
  (await d2(sess, '/api/programs?fields=id,displayName,programType&paging=false')).programs || [], META_MS);
const dataSets = sess => memoize(`${userKey(sess)}|datasets`, async () =>
  (await d2(sess, '/api/dataSets?fields=id,displayName,periodType&paging=false')).dataSets || [], META_MS);
const levels = sess => memoize(`${userKey(sess)}|levels`, async () => {
  try {
    const r = await d2(sess, '/api/organisationUnitLevels?fields=level,displayName&paging=false');
    return (r.organisationUnitLevels || []).filter(l => l.level).sort((a, b) => a.level - b.level);
  } catch { return []; }
}, META_MS);

// translations → { <user locale>: displayName, <locale>: translation }
function labelOf(sess, o, langs) {
  const L = { [sess.locale || '']: o.displayFormName || o.displayName || o.name || o.code || o.id };
  const form = {}, name = {};
  for (const t of o.translations || []) {
    if (!t.locale || !t.value) continue;
    if (t.property === 'FORM_NAME') form[t.locale] = t.value;
    else if (t.property === 'NAME') name[t.locale] = t.value;
  }
  for (const loc of new Set([...Object.keys(name), ...Object.keys(form)])) { L[loc] = form[loc] || name[loc]; langs.add(loc); }
  return L;
}
function optionsOf(sess, os, langs) {
  if (!os || !os.options) return null;
  const map = {};
  for (const o of [...os.options].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))) if (o.code != null) map[o.code] = labelOf(sess, o, langs);
  return map;
}

const DE = 'id,code,displayName,displayFormName,valueType,translations[locale,property,value],optionSet[id,options[code,displayName,sortOrder,translations[locale,property,value]]]';
const safeName = (code, id) => (code && /^[A-Za-z_][\w.-]{0,60}$/.test(code) ? code : id);

function structure(sess, pid, fid) {
  return memoize(`${userKey(sess)}|structure|${fid}`, async () => {
    const langs = new Set([sess.locale || '']);
    const fields = [], labels = { languages: [], defaultLang: sess.locale || '', fields: {}, choices: {} };
    const types = new Map();
    const add = (path, name, o, L) => {
      const t = TYPE(o.valueType);
      fields.push({ path, name, type: t, selectMultiple: o.valueType === 'MULTI_TEXT', repeat: false });
      types.set(path, o.valueType);
      labels.fields[path] = L;
      const ch = optionsOf(sess, o.optionSet, langs) || (o.valueType === 'BOOLEAN' || o.valueType === 'TRUE_ONLY' ? YES_NO : null);
      if (ch) labels.choices[path] = ch;
    };
    let kind, stages = [];
    if (pid === 'agrege') {
      kind = 'agrege';
      const ds = await d2(sess, `/api/dataSets/${enc(fid)}?fields=id,displayName,periodType,categoryCombo[id,categoryOptionCombos[id,displayName]],dataSetElements[dataElement[${DE},categoryCombo[id,categoryOptionCombos[id,displayName]]]]`);
      const des = {}, cocs = {}, aocs = {};
      const numeric = new Set();
      for (const x of ds.dataSetElements || []) {
        const d = x.dataElement || {};
        des[d.id] = labelOf(sess, d, langs);
        if (NUMERIC.has(d.valueType)) numeric.add(d.id);
        for (const c of (d.categoryCombo && d.categoryCombo.categoryOptionCombos) || []) cocs[c.id] = { '': c.displayName === 'default' ? 'Total (sans désagrégation)' : c.displayName };
      }
      for (const c of (ds.categoryCombo && ds.categoryCombo.categoryOptionCombos) || []) aocs[c.id] = { '': c.displayName === 'default' ? '(par défaut)' : c.displayName };
      fields.push(
        { path: 'dataElement', name: 'dataElement', type: 'string', selectMultiple: false, repeat: false },
        { path: 'categoryOptionCombo', name: 'categoryOptionCombo', type: 'string', selectMultiple: false, repeat: false },
        { path: 'attributeOptionCombo', name: 'attributeOptionCombo', type: 'string', selectMultiple: false, repeat: false },
        { path: 'period', name: 'period', type: 'string', selectMultiple: false, repeat: false },
        { path: 'value', name: 'value', type: 'decimal', selectMultiple: false, repeat: false },
        { path: 'comment', name: 'comment', type: 'string', selectMultiple: false, repeat: false },
      );
      Object.assign(labels.fields, {
        dataElement: { '': 'Élément de données' }, categoryOptionCombo: { '': 'Désagrégation (catégories)' }, attributeOptionCombo: { '': 'Combinaison d\'attributs' },
        period: { '': 'Période (code DHIS2)' }, value: { '': 'Valeur' }, comment: { '': 'Commentaire' },
      });
      Object.assign(labels.choices, { dataElement: des, categoryOptionCombo: cocs, attributeOptionCombo: aocs });
      labels.languages = [...langs];
      return { kind, fields, labels, types, numeric, periodType: ds.periodType, stages };
    }
    const p = await d2(sess, `/api/programs/${enc(fid)}?fields=id,displayName,programType,programStages[id,displayName,sortOrder,repeatable,translations[locale,property,value],programStageDataElements[sortOrder,dataElement[${DE}]]],programTrackedEntityAttributes[sortOrder,trackedEntityAttribute[${DE}]]`);
    kind = p.programType === 'WITH_REGISTRATION' ? 'tracker' : 'evenements';
    stages = [...(p.programStages || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const sorted = list => [...(list || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    if (kind === 'evenements') {
      for (const s of stages) for (const x of sorted(s.programStageDataElements)) { const d = x.dataElement || {}; if (d.id && !types.has(d.id)) add(d.id, safeName(d.code, d.id), d, labelOf(sess, d, langs)); }
    } else {
      for (const x of sorted(p.programTrackedEntityAttributes)) { const a = x.trackedEntityAttribute || {}; if (a.id) add(a.id, safeName(a.code, a.id), a, labelOf(sess, a, langs)); }
      for (const s of stages) {
        fields.push({ path: s.id, name: safeName(null, s.id), type: 'repeat', selectMultiple: false, repeat: true });
        labels.fields[s.id] = labelOf(sess, s, langs);
        const meta = [['event_date', 'Date de l\'événement', 'dateTime'], ['event_due', 'Date prévue', 'dateTime'], ['event_status', 'Statut de l\'événement', 'string'],
          ['event_orgunit', 'Unité d\'organisation de l\'événement', 'string'], ['event_by', 'Saisi par', 'string'], ['event_location', 'Position GPS de l\'événement', 'geopoint']];
        for (const [k, name, type] of meta) { fields.push({ path: `${s.id}/${k}`, name: k, type, selectMultiple: false, repeat: false }); labels.fields[`${s.id}/${k}`] = { '': name }; }
        labels.choices[`${s.id}/event_status`] = fr(EVENT_STATUS);
        for (const x of sorted(s.programStageDataElements)) { const d = x.dataElement || {}; if (d.id) add(`${s.id}/${d.id}`, safeName(d.code, d.id), d, labelOf(sess, d, langs)); }
      }
    }
    labels.languages = [...langs];
    return { kind, fields, labels, types, stages };
  }, META_MS);
}

// ---------------------------------------------------------------- org units
const ouCache = new Map(); // user|id → { at, ou }
async function orgUnits(sess, ids) {
  const now = Date.now(), out = new Map(), missing = [];
  for (const id of ids) {
    const hit = ouCache.get(`${userKey(sess)}|${id}`);
    if (hit && now - hit.at < 30 * 60_000) out.set(id, hit.ou); else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    try {
      const r = await d2(sess, `/api/organisationUnits?filter=id:in:[${batch.map(enc).join(',')}]&fields=id,displayName,level,ancestors[id,displayName,level],geometry&paging=false`);
      for (const o of r.organisationUnits || []) { out.set(o.id, o); ouCache.set(`${userKey(sess)}|${o.id}`, { at: now, ou: o }); }
    } catch (e) { console.warn(`dhis2: unités d'organisation indisponibles (${e.message})`); break; }
  }
  if (ouCache.size > 100000) ouCache.clear();
  return out;
}
function placeOf(sys, o, prefix = '') {
  if (!o) return;
  sys[prefix + 'orgUnit'] = o.displayName;
  for (const a of [...(o.ancestors || []), o]) if (a.level) sys[`${prefix}level${a.level}`] = a.displayName;
  if (o.geometry && o.geometry.type === 'Point') sys[prefix + 'orgUnitLocation'] = toGeoPoint(o.geometry);
}

// ---------------------------------------------------------------- values
function valueOf(raw, valueType) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (NUMERIC.has(valueType)) { const n = Number(raw); return Number.isFinite(n) ? n : raw; }
  if (valueType === 'COORDINATE') { // "[lon,lat]"
    const m = String(raw).match(/(-?[\d.]+)\s*,\s*(-?[\d.]+)/);
    return m ? toGeoPoint(`${m[2]} ${m[1]}`) : null;
  }
  if (valueType === 'MULTI_TEXT') return String(raw).split(',').map(s => s.trim()).filter(Boolean).join(' ');
  return String(raw);
}
const geom = g => (g && g.type === 'Point' ? toGeoPoint(g) : null);
const who = x => (x.createdBy && (x.createdBy.username || x.createdBy.displayName)) || x.storedBy || null;
// (tracker API field names, with the names of the old /api/events as fallback)
const evDate = e => e.occurredAt || e.eventDate || null;

// period code → first day ("202401", "2024Q1", "2024W05", "2024April", "2024BiW3"...)
function periodStart(pe) {
  const s = String(pe || '');
  let m;
  const d = (y, mo, da = 1) => new Date(Date.UTC(y, mo - 1, da)).toISOString().slice(0, 10);
  const isoWeek = (y, w, shift = 0) => { const jan4 = new Date(Date.UTC(y, 0, 4)); const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 864e5); return new Date(monday.getTime() + ((w - 1) * 7 + shift) * 864e5).toISOString().slice(0, 10); };
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return d(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{4})(\d{2})$/))) return d(+m[1], +m[2]);
  if ((m = s.match(/^(\d{4})(\d{2})B$/))) return d(+m[1], (+m[2] - 1) * 2 + 1);
  if ((m = s.match(/^(\d{4})Q([1-4])$/))) return d(+m[1], (+m[2] - 1) * 3 + 1);
  if ((m = s.match(/^(\d{4})NovQ([1-4])$/))) return m[2] === '1' ? d(+m[1] - 1, 11) : d(+m[1], (+m[2] - 1) * 3 - 1); // Q1 = Nov–Jan
  if ((m = s.match(/^(\d{4})S([12])$/))) return d(+m[1], m[2] === '1' ? 1 : 7);
  if ((m = s.match(/^(\d{4})AprilS([12])$/))) return d(+m[1], m[2] === '1' ? 4 : 10);
  if ((m = s.match(/^(\d{4})NovS([12])$/))) return m[2] === '1' ? d(+m[1] - 1, 11) : d(+m[1], 5);
  if ((m = s.match(/^(\d{4})(Wed|Thu|Sat|Sun)?W(\d{1,2})$/))) return isoWeek(+m[1], +m[3], { Wed: 2, Thu: 3, Sat: 5, Sun: -1 }[m[2]] || 0);
  if ((m = s.match(/^(\d{4})BiW(\d{1,2})$/))) return isoWeek(+m[1], (+m[2] - 1) * 2 + 1);
  if ((m = s.match(/^(\d{4})(April|July|Oct|Nov)$/))) return d(+m[1], { April: 4, July: 7, Oct: 10, Nov: 11 }[m[2]]);
  if ((m = s.match(/^(\d{4})$/))) return d(+m[1], 1);
  return null;
}

// ---------------------------------------------------------------- rows
async function eventRows(sess, st, list) {
  const ous = await orgUnits(sess, [...new Set(list.map(e => e.orgUnit).filter(Boolean))]);
  return list.filter(e => !e.deleted).map(e => {
    const sys = {
      submissionDate: isoOrNull(evDate(e)), scheduledAt: isoOrNull(e.scheduledAt || e.dueDate), createdAt: isoOrNull(e.createdAt || e.created),
      updatedAt: isoOrNull(e.updatedAt || e.lastUpdated), status: e.status || null, submitterName: who(e), location: geom(e.geometry),
    };
    placeOf(sys, ous.get(e.orgUnit) || (e.orgUnitName ? { displayName: e.orgUnitName } : null));
    const row = { __id: e.event, __system: sys };
    for (const dv of e.dataValues || []) if (st.types.has(dv.dataElement)) row[dv.dataElement] = valueOf(dv.value, st.types.get(dv.dataElement));
    return row;
  });
}

async function enrollmentRows(sess, st, list) {
  const ids = new Set();
  for (const en of list) { if (en.orgUnit) ids.add(en.orgUnit); for (const e of en.events || []) if (e.orgUnit) ids.add(e.orgUnit); }
  const ous = await orgUnits(sess, [...ids]);
  const tables = { Submissions: [] }, roots = [];
  for (const s of st.stages) tables[`Submissions.${s.id}`] = [];
  for (const en of list) {
    if (en.deleted) continue;
    const sys = {
      submissionDate: isoOrNull(en.enrolledAt || en.enrollmentDate), incidentDate: isoOrNull(en.occurredAt || en.incidentDate),
      createdAt: isoOrNull(en.createdAt || en.created), updatedAt: isoOrNull(en.updatedAt || en.lastUpdated), status: en.status || null,
      submitterName: who(en), location: geom(en.geometry), trackedEntity: en.trackedEntity || null, followUp: en.followUp ? 'true' : 'false',
    };
    placeOf(sys, ous.get(en.orgUnit));
    const row = { __id: en.enrollment, __system: sys };
    for (const a of en.attributes || []) if (st.types.has(a.attribute)) row[a.attribute] = valueOf(a.value, st.types.get(a.attribute));
    tables.Submissions.push(row);
    roots.push(en.enrollment);
    for (const e of en.events || []) {
      const t = tables[`Submissions.${e.programStage}`];
      if (!t || e.deleted) continue;
      const o = ous.get(e.orgUnit);
      const ev = { __id: e.event, '__Submissions-id': en.enrollment, __root: en.enrollment,
        event_date: isoOrNull(evDate(e)), event_due: isoOrNull(e.scheduledAt || e.dueDate), event_status: e.status || null,
        event_orgunit: o ? o.displayName : null, event_by: who(e), event_location: geom(e.geometry) };
      for (const dv of e.dataValues || []) { const p = `${e.programStage}/${dv.dataElement}`; if (st.types.has(p)) ev[dv.dataElement] = valueOf(dv.value, st.types.get(p)); }
      t.push(ev);
    }
  }
  return { tables, roots };
}

async function aggregateRows(sess, st, list) {
  const ous = await orgUnits(sess, [...new Set(list.map(v => v.orgUnit))]);
  const rows = [], removed = [];
  for (const v of list) {
    const id = `${v.dataElement}|${v.period}|${v.orgUnit}|${v.categoryOptionCombo}|${v.attributeOptionCombo}`;
    if (v.deleted === true || v.deleted === 'true') { removed.push(id); continue; }
    const start = periodStart(v.period);
    const sys = { submissionDate: start ? `${start}T00:00:00.000Z` : null, createdAt: isoOrNull(v.created), updatedAt: isoOrNull(v.lastUpdated),
      submitterName: v.storedBy || null, followUp: v.followup ? 'true' : 'false' };
    placeOf(sys, ous.get(v.orgUnit));
    const n = Number(v.value);
    rows.push({ __id: id, __system: sys, dataElement: v.dataElement, categoryOptionCombo: v.categoryOptionCombo, attributeOptionCombo: v.attributeOptionCombo,
      period: v.period, value: v.value !== '' && Number.isFinite(n) && st.numeric.has(v.dataElement) ? n : v.value === '' ? null : v.value, comment: v.comment || null });
  }
  return { rows, removed };
}

// ---------------------------------------------------------------- system fields
function systemFields(kind, lv) {
  return systemFieldList(kind, lv).map(f => ({ group: 'Métadonnées DHIS2', ...f }));
}
function systemFieldList(kind, lv) {
  const OU = 'Unité d\'organisation et hiérarchie';
  const levelsF = (lv.length ? lv : [1, 2, 3, 4, 5].map(level => ({ level, displayName: '' })))
    .map(l => ({ path: `__system/level${l.level}`, name: `Niveau ${l.level}${l.displayName ? ' · ' + l.displayName : ''}`, type: 'string', system: true, group: OU, hierarchy: l.level }));
  const place = [
    { path: '__system/orgUnit', name: 'Unité d\'organisation', type: 'string', system: true, group: OU }, ...levelsF,
    { path: '__system/orgUnitLocation', name: 'Position de l\'unité d\'organisation', type: 'geopoint', system: true, group: OU },
  ];
  if (kind === 'agrege') return [
    { path: '__system/submissionDate', name: 'Début de la période', type: 'dateTime', system: true },
    { path: '__system/createdAt', name: 'Date de saisie', type: 'dateTime', system: true },
    { path: '__system/updatedAt', name: 'Date de modification', type: 'dateTime', system: true },
    { path: '__system/submitterName', name: 'Saisi par', type: 'string', system: true },
    { path: '__system/followUp', name: 'Marqué pour suivi', type: 'string', system: true }, ...place];
  if (kind === 'tracker') return [
    { path: '__system/submissionDate', name: 'Date d\'inscription', type: 'dateTime', system: true },
    { path: '__system/incidentDate', name: 'Date de l\'incident', type: 'dateTime', system: true },
    { path: '__system/status', name: 'Statut de l\'inscription', type: 'string', system: true },
    { path: '__system/createdAt', name: 'Date de saisie', type: 'dateTime', system: true },
    { path: '__system/updatedAt', name: 'Date de modification', type: 'dateTime', system: true },
    { path: '__system/submitterName', name: 'Inscrit par', type: 'string', system: true },
    { path: '__system/followUp', name: 'Marquée pour suivi', type: 'string', system: true },
    { path: '__system/trackedEntity', name: 'Identifiant de l\'entité suivie', type: 'string', system: true },
    { path: '__system/location', name: 'Position GPS de l\'inscription', type: 'geopoint', system: true }, ...place];
  return [
    { path: '__system/submissionDate', name: 'Date de l\'événement', type: 'dateTime', system: true },
    { path: '__system/scheduledAt', name: 'Date prévue', type: 'dateTime', system: true },
    { path: '__system/status', name: 'Statut de l\'événement', type: 'string', system: true },
    { path: '__system/createdAt', name: 'Date de saisie', type: 'dateTime', system: true },
    { path: '__system/updatedAt', name: 'Date de modification', type: 'dateTime', system: true },
    { path: '__system/submitterName', name: 'Saisi par', type: 'string', system: true },
    { path: '__system/location', name: 'Position GPS de l\'événement', type: 'geopoint', system: true }, ...place];
}

// ---------------------------------------------------------------- sources
const EV_FIELDS = 'event,program,programStage,enrollment,trackedEntity,status,orgUnit,occurredAt,scheduledAt,createdAt,updatedAt,deleted,geometry,storedBy,createdBy[username],dataValues[dataElement,value]';
const LEGACY_EV_FIELDS = 'event,program,programStage,status,orgUnit,orgUnitName,eventDate,dueDate,created,lastUpdated,deleted,geometry,storedBy,dataValues[dataElement,value]';
const EN_FIELDS = `enrollment,trackedEntity,program,status,orgUnit,enrolledAt,occurredAt,createdAt,updatedAt,followUp,deleted,geometry,createdBy[username],attributes[attribute,value],events[${EV_FIELDS}]`;

function dateParams(sess, kind, q, legacy) {
  if (!q.from && !q.to) return '';
  if (kind === 'agrege') return '';
  if (legacy) return `${q.from ? `&startDate=${q.from}` : ''}${q.to ? `&endDate=${q.to}` : ''}`;
  if (!v41(sess)) return ''; // older tracker APIs: filtered after download (parameter names changed over versions)
  if (kind === 'tracker') return `${q.from ? `&enrolledAfter=${q.from}` : ''}${q.to ? `&enrolledBefore=${q.to}` : ''}`;
  return `${q.from ? `&occurredAfter=${q.from}` : ''}${q.to ? `&occurredBefore=${q.to}` : ''}`;
}
// rows kept when the server could not filter (DHIS2 < 2.41)
const inRange = (iso, q) => { const d = String(iso || '').slice(0, 10); return (!q.from || d >= q.from) && (!q.to || (d && d <= q.to)); };

function aggregateWindow(q) {
  if (q.from || q.to) return `&startDate=${q.from || '1900-01-01'}&endDate=${q.to || '2100-12-31'}`;
  const start = new Date(); start.setUTCMonth(start.getUTCMonth() - AGG_MONTHS); start.setUTCDate(1);
  return `&startDate=${start.toISOString().slice(0, 10)}&endDate=2100-12-31`;
}

module.exports = {
  id: 'dhis2',
  label: 'DHIS2',
  features: { reviewState: false },
  sharedCache: false,
  normalizeServer: s => normalizeServer(String(s || '').replace(/\/(api|dhis-web-[\w-]+)(\/.*)?$/i, '').replace(/\/#.*$/, '')),

  async login({ server, email, password }) {
    const user = String(email || '').trim(), secret = String(password || '');
    const pat = /^d2pat_/.test(secret.trim());
    if (!secret || (!pat && !user)) throw httpError(400, 'Nom d\'utilisateur et mot de passe (ou jeton d\'accès personnel d2pat_…) obligatoires.');
    const token = pat ? `ApiToken ${secret.trim()}` : `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
    let res;
    try { res = await fetchWithTimeout(`${server}/api/me?fields=id,username,displayName,settings[keyUiLocale],organisationUnits[id],dataViewOrganisationUnits[id]`, { headers: { Authorization: token, Accept: 'application/json' }, redirect: 'manual' }); }
    catch (e) { throw httpError(502, `Impossible de joindre ${server} (${e.name === 'AbortError' ? 'délai dépassé' : e.cause?.code || e.message}). Vérifiez l'adresse.`); }
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) throw httpError(401, pat ? 'Jeton d\'accès personnel DHIS2 refusé (expiré, révoqué ou limité à d\'autres adresses).' : 'Nom d\'utilisateur ou mot de passe DHIS2 incorrect (ou compte verrouillé).');
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('json')) throw httpError(502, `Ce serveur ne répond pas comme DHIS2 (HTTP ${res.status}). Vérifiez l'adresse (sans /dhis-web-…) et la plateforme choisie.`);
    const me = await res.json();
    let version = '';
    try { const i = await fetchWithTimeout(`${server}/api/system/info`, { headers: { Authorization: token, Accept: 'application/json' } }, 10_000); if (i.ok) version = (await i.json()).version || ''; } catch { /* optional */ }
    const roots = ((me.dataViewOrganisationUnits && me.dataViewOrganisationUnits.length ? me.dataViewOrganisationUnits : me.organisationUnits) || []).map(o => o.id);
    return {
      email: me.username || user, name: me.displayName || me.username || user, token,
      expiresAt: new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString(),
      d2v: Number(String(version).split('.')[1]) || 0, version, roots, locale: (me.settings && me.settings.keyUiLocale) || 'en',
    };
  },

  async logout() { /* Basic auth / personal access token: nothing to close */ },

  async access(sess, pid, fid) {
    await memoize(`${userKey(sess)}|access|${pid}|${fid}`, async () => {
      if (pid === 'agrege') return d2(sess, `/api/dataSets/${enc(fid)}?fields=id`);
      return d2(sess, `/api/programs/${enc(fid)}?fields=id`);
    }, 120_000);
  },

  async projects(sess) {
    const [p, d] = await Promise.all([programs(sess), dataSets(sess).catch(() => [])]);
    const out = [];
    if (p.some(x => x.programType !== 'WITH_REGISTRATION')) out.push({ id: 'evenements', name: KINDS.evenements });
    if (p.some(x => x.programType === 'WITH_REGISTRATION')) out.push({ id: 'tracker', name: KINDS.tracker });
    if (d.length) out.push({ id: 'agrege', name: KINDS.agrege });
    return out;
  },

  async forms(sess, pid) {
    // unit: what a row of the main table is; dates: what the date filter applies to
    if (pid === 'agrege') return (await dataSets(sess)).map(d => ({ id: d.id, name: `${d.displayName}${PERIOD_TYPES[d.periodType] ? ` (${PERIOD_TYPES[d.periodType]})` : ''}`, unit: 'valeurs', dates: 'Périodes du' }));
    if (!KINDS[pid]) throw httpError(404, 'Catégorie DHIS2 inconnue.');
    const tracker = pid === 'tracker';
    return (await programs(sess)).filter(p => tracker === (p.programType === 'WITH_REGISTRATION'))
      .map(p => ({ id: p.id, name: p.displayName, unit: tracker ? 'inscriptions' : 'événements', dates: tracker ? 'Inscrits du' : 'Événements du' }));
  },

  async tables(sess, pid, fid) {
    const st = await structure(sess, pid, fid);
    return st.kind === 'tracker' ? ['Submissions', ...st.stages.map(s => `Submissions.${s.id}`)] : ['Submissions'];
  },

  async fields(sess, pid, fid) {
    const [st, lv] = await Promise.all([structure(sess, pid, fid), levels(sess)]);
    return [...st.fields.map(f => ({ ...f })), ...systemFields(st.kind, lv)];
  },

  async labels(sess, pid, fid) {
    const st = await structure(sess, pid, fid);
    const status = st.kind === 'tracker' ? ENROLLMENT_STATUS : EVENT_STATUS;
    return { ...st.labels, choices: { ...st.labels.choices, '__system/status': fr(status), '__system/followUp': YES_NO } };
  },

  filterKey(table, q) {
    const p = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) p.push(`from=${q.from}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) p.push(`to=${q.to}`);
    return p.join('&');
  },

  incremental: () => true,
  refuseIncremental: () => {},

  source(sess, pid, fid, params) {
    const q = { from: params.from || '', to: params.to || '' };
    const legacy = !!sess.d2v && sess.d2v < 36;
    const st = () => structure(sess, pid, fid);
    const filtered = !v41(sess) && !legacy && (q.from || q.to); // filtered here, after download

    if (pid === 'agrege') {
      const orgs = (sess.roots || []).map(id => `&orgUnit=${enc(id)}`).join('');
      if (!orgs) return { fetch: async () => { throw httpError(403, 'Votre compte DHIS2 n\'est rattaché à aucune unité d\'organisation.'); }, rootSig: async () => '', changedSince: async () => 0, count: null, delta: null };
      const base = `/api/dataValueSets.json?dataSet=${enc(fid)}${orgs}&children=true${aggregateWindow(q)}`;
      const deltaOf = since => memoize(`${userKey(sess)}|aggdelta|${fid}|${base}|${since.slice(0, 16)}`, async () =>
        aggregateRows(sess, await st(), (await d2(sess, `${base}&includeDeleted=true&lastUpdated=${enc(since)}`)).dataValues || []), 30_000);
      return {
        fetch: async () => ({ rows: (await aggregateRows(sess, await st(), (await d2(sess, base)).dataValues || [])).rows, filtered: true }),
        rootSig: async () => 'agrege',
        changedSince: async since => { const d = await deltaOf(since); return d.rows.length + d.removed.length; },
        count: null, // deletions are reported by includeDeleted
        delta: async (filter, since) => deltaOf(since),
      };
    }

    if (pid === 'evenements') {
      const path = legacy ? '/api/events' : '/api/tracker/events';
      const key = 'events';
      const base = `${path}?program=${enc(fid)}${ou(sess)}${dateParams(sess, 'evenements', q, legacy)}`;
      const fieldsP = `&fields=${legacy ? LEGACY_EV_FIELDS : EV_FIELDS}`;
      const keep = rows => (filtered ? rows.filter(r => inRange(r.__system.submissionDate, q)) : rows);
      const count = async extra => {
        const r = await d2(sess, `${base}${extra || ''}&fields=event&page=1&pageSize=1&totalPages=true`);
        return totalOf(r) ?? items(r, key).length;
      };
      // (the memo holds the download; the date filter of older versions is applied after it)
      const all = async () => keep(await memoize(`${userKey(sess)}|ev|${fid}|${base}`, async () => eventRows(sess, await st(), await pages(sess, `${base}${fieldsP}`, key)), 10_000));
      const upd = legacy ? 'lastUpdatedStartDate' : 'updatedAfter';
      return {
        fetch: async () => ({ rows: await all(), filtered: true }),
        rootSig: async () => `total:${await count('')}`,
        changedSince: since => count(`&${upd}=${enc(since)}`),
        count: filtered ? null : () => count(''),
        delta: async (filter, since) => {
          const list = await pages(sess, `${base}${fieldsP}&${upd}=${enc(since)}${legacy ? '' : '&includeDeleted=true'}`, key);
          return { rows: keep(await eventRows(sess, await st(), list)), removed: list.filter(e => e.deleted).map(e => e.event) };
        },
      };
    }

    // tracker program: one row per enrollment, events of each stage in child tables
    if (legacy) return { fetch: async () => { throw httpError(501, `Les programmes tracker demandent DHIS2 2.36 ou plus récent (serveur : ${sess.version || 'ancienne version'}).`); }, rootSig: async () => '', changedSince: async () => 0, count: null, delta: null };
    const base = `/api/tracker/enrollments?program=${enc(fid)}${ou(sess)}${dateParams(sess, 'tracker', q)}`;
    const count = async extra => {
      const r = await d2(sess, `${base}${extra || ''}&fields=enrollment&page=1&pageSize=1&totalPages=true`);
      return totalOf(r) ?? items(r, 'enrollments').length;
    };
    const keep = ds => {
      if (!filtered) return ds;
      const ok = new Set(ds.tables.Submissions.filter(r => inRange(r.__system.submissionDate, q)).map(r => r.__id));
      const tables = {};
      for (const [t, rows] of Object.entries(ds.tables)) tables[t] = rows.filter(r => ok.has(t === 'Submissions' ? r.__id : r.__root));
      return { tables, roots: ds.roots.filter(id => ok.has(id)) };
    };
    const all = async () => keep(await memoize(`${userKey(sess)}|en|${fid}|${base}`, async () => enrollmentRows(sess, await st(), await pages(sess, `${base}&fields=${EN_FIELDS}`, 'enrollments', EN_PAGE)), 10_000));
    const changed = async since => {
      // enrollments updated since, plus enrollments whose events changed (an event update does not
      // always touch its enrollment)
      const [ens, evs] = await Promise.all([
        pages(sess, `${base}&fields=enrollment&updatedAfter=${enc(since)}`, 'enrollments'),
        pages(sess, `/api/tracker/events?program=${enc(fid)}${ou(sess)}&fields=event,enrollment&updatedAfter=${enc(since)}&includeDeleted=true`, 'events'),
      ]);
      return [...new Set([...ens.map(e => e.enrollment), ...evs.map(e => e.enrollment)].filter(Boolean))];
    };
    return {
      async fetch(table) { const ds = await all(); return { rows: ds.tables[table] || [], filtered: true, roots: table === 'Submissions' ? undefined : ds.roots }; },
      rootSig: async () => `total:${await count('')}`,
      changedSince: async since => (await memoize(`${userKey(sess)}|enchg|${fid}|${since.slice(0, 16)}`, () => changed(since), 30_000)).length,
      count: filtered ? null : () => count(''),
      async delta(filter, since, table = 'Submissions') {
        const ds = await memoize(`${userKey(sess)}|endelta|${fid}|${base}|${since.slice(0, 16)}`, async () => {
          const ids = await memoize(`${userKey(sess)}|enchg|${fid}|${since.slice(0, 16)}`, () => changed(since), 30_000);
          const list = [];
          for (let i = 0; i < ids.length; i += 5) {
            const got = await Promise.all(ids.slice(i, i + 5).map(id => d2(sess, `/api/tracker/enrollments/${enc(id)}?fields=${EN_FIELDS}`).catch(e => (e.notFound ? null : Promise.reject(e)))));
            list.push(...got.filter(x => x && x.program === fid));
          }
          return enrollmentRows(sess, await st(), list);
        }, 30_000).then(keep);
        return { rows: ds.tables[table] || [], roots: ds.roots };
      },
      childDelta: true,
    };
  },
};
module.exports.periodStart = periodStart; // (tests)
