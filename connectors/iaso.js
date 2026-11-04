// IASO (Bluesquare) connector. IASO collects data with ODK forms (XForms), so labels and field types are
// read from the form's XForm, exactly like ODK Central; submissions come from /api/instances/.
//
// API used (checked against the IASO source code, github.com/BLSQ/iaso):
//   POST /api/token/                      {username, password} → {access, refresh} (JWT, "Bearer")
//   GET  /api/profiles/me/                display name
//   GET  /api/projects/                   {projects: [...]}
//   GET  /api/forms/?projectsIds=…        {forms: [...]}; /api/forms/<id>/ (latest_form_version, possible_fields)
//   GET  /api/formversions/<id>/?fields=descriptor   pyxform JSON (fallback when the XForm file can't be read)
//   GET  /api/instances/?form_ids=…&limit=…&page=…   {count, instances, has_next, ...}
//        file_content = flat JSON of the submission: keys are question *names* (groups dropped),
//        first-level repeats are lists of flat objects.
//   GET  /api/orgunits/?smallSearch=true&limit=…&searches=[{"search":"ids:1,2"}]   org units + parents
//   GET  /api/v2/orgunittypes/?project=…  org unit types (depth) → hierarchy levels
//
// Rows are scoped to each user (IASO restricts submissions to the user's org units).

const { extractLabels, extractFields } = require('../xform');
const { httpError, fetchWithTimeout, normalizeServer, memoize, enc, isoOrNull, toGeoPoint } = require('./common');
const { Schema, explode, collect, descriptorSchema } = require('./records');

const PAGE = Number(process.env.IASO_PAGE_SIZE || 500);
const META_MS = Number(process.env.CACHE_MINUTES || 5) * 60_000;
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

const STATUS_LABELS = { READY: 'Prête', DUPLICATED: 'Doublon', EXPORTED: 'Exportée' };
// validation workflow (iaso/models/common.py, ValidationWorkflowArtefactStatus)
const VALIDATION_LABELS = { APPROVED: 'Approuvée', REJECTED: 'Rejetée', PENDING: 'En attente' };
const PF_TYPES = { integer: 'int', decimal: 'decimal', date: 'date', datetime: 'dateTime', time: 'time', geopoint: 'geopoint', calculate: 'string' };

const userKey = sess => `iaso|${sess.server}|${sess.email}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function iaso(sess, target, { raw = false, external = false } = {}) {
  const url = target.startsWith('http') ? target : `${sess.server}${target}`;
  const own = url.startsWith(sess.server + '/');
  // other hosts: only the form files IASO points to (signed storage URLs), without credentials, and over
  // HTTPS when the IASO server itself uses HTTPS
  if (!own && (!external || !(/^https:\/\//i.test(url) || /^http:\/\//i.test(sess.server)))) throw httpError(400, 'Requête hors du serveur IASO connecté refusée.');
  // the token is only ever sent to the IASO server itself (form files may live on S3 with a signed URL)
  const headers = own ? { Authorization: `Bearer ${sess.token}`, Accept: raw ? '*/*' : 'application/json' } : {};
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetchWithTimeout(url, { headers }, 180_000); }
    catch (e) { throw httpError(502, `Serveur IASO injoignable (${e.name === 'AbortError' ? 'délai dépassé' : e.cause?.code || e.message}).`); }
    if ((res.status === 429 || res.status === 503) && attempt < 3) { await sleep(Math.min(30, Number(res.headers.get('retry-after')) || 2 ** attempt * 2) * 1000); continue; }
    if (res.status === 401 && own) { const err = httpError(401, 'Session IASO expirée, reconnectez-vous.'); err.relogin = true; throw err; }
    if (res.status === 403) throw httpError(403, 'Votre compte IASO n\'a pas accès à cette ressource (droit « Soumissions » requis).');
    if (res.status === 404) throw httpError(404, 'Ressource introuvable sur le serveur IASO.');
    if (!res.ok) throw httpError(res.status >= 500 ? 502 : res.status, `IASO ${res.status} : ${(await res.text()).slice(0, 300)}`);
    if (raw) return res.text();
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) throw httpError(502, 'Réponse inattendue du serveur IASO (pas du JSON).');
    return res.json();
  }
}

function jwtExpiry(token) {
  try { const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); return p.exp ? p.exp * 1000 : null; } catch { return null; }
}

// ---------------------------------------------------------------- form structure
async function formDetail(sess, fid) {
  return memoize(`${userKey(sess)}|form|${fid}`, () =>
    iaso(sess, `/api/forms/${enc(fid)}/?fields=id,name,form_id,latest_form_version,possible_fields,org_unit_types,period_type,projects`), META_MS);
}

async function structure(sess, pid, fid) {
  return memoize(`${userKey(sess)}|structure|${fid}`, async () => {
    const form = await formDetail(sess, fid);
    const v = form.latest_form_version || {};
    let fields = null, labels = null, source = '';
    if (v.file) {
      try {
        const xml = await iaso(sess, new URL(v.file, sess.server + '/').href, { raw: true, external: true });
        if (/<h:html|<html|<model/.test(xml)) {
          fields = extractFields(xml); labels = extractLabels(xml); delete labels.externals; source = 'xform';
        }
      } catch (e) { console.warn(`iaso: XForm du formulaire ${fid} illisible (${e.message}), essai du descripteur`); }
    }
    if (!(fields && fields.length) && v.id != null) {
      try {
        const d = await iaso(sess, `/api/formversions/${enc(v.id)}/?fields=descriptor`);
        if (d.descriptor && d.descriptor.children) { ({ fields, labels } = descriptorSchema(d.descriptor)); source = 'descriptor'; }
      } catch (e) { console.warn(`iaso: descripteur du formulaire ${fid} indisponible (${e.message})`); }
    }
    fields = (fields || []).filter(f => f.path !== 'formhub' && !f.path.startsWith('formhub/'));
    labels ||= { languages: [], defaultLang: '', fields: {}, choices: {} };
    // questions of older versions (possible_fields = flat list of every question ever in the form)
    const known = new Set(fields.filter(f => f.type !== 'structure').map(f => f.name));
    for (const pf of form.possible_fields || []) {
      if (!pf || !pf.name || known.has(pf.name)) continue;
      const t = String(pf.type || '').toLowerCase();
      if (t === 'note' || t === 'group' || t === 'repeat') continue;
      fields.push({ path: pf.name, name: pf.name, type: /^select/.test(t) ? 'string' : PF_TYPES[t] || 'string', selectMultiple: /all that apply|multiple/.test(t), repeat: false, old: true });
      if (pf.label) labels.fields[pf.name] ||= { '': String(pf.label) };
    }
    // IASO stores first-level repeats as lists; deeper repeats are flattened (IASO keeps their last entry):
    // treat them as groups of the enclosing repeat.
    const reps = fields.filter(f => f.repeat).map(f => f.path);
    for (const f of fields) if (f.repeat && reps.some(r => f.path.startsWith(r + '/'))) { f.repeat = false; f.type = 'structure'; f.flattened = true; }
    const schema = new Schema(fields);
    // flat key (question name) → full path, per context ('' = submission, or a repeat path)
    const leaves = new Map(), repeatsByName = new Map();
    const ctxMap = (m, ctx) => m.get(ctx) || m.set(ctx, new Map()).get(ctx);
    for (const f of fields) {
      if (f.repeat) { const own = schema.ownerOf(f.path); if (!ctxMap(repeatsByName, own).has(f.name)) ctxMap(repeatsByName, own).set(f.name, f.path); continue; }
      if (f.type === 'structure') continue;
      const own = schema.ownerOf(f.path);
      if (!ctxMap(leaves, own).has(f.name)) ctxMap(leaves, own).set(f.name, f.path);
    }
    const repeatLeafNames = new Set();
    for (const [ctx, m] of leaves) if (ctx) for (const name of m.keys()) if (!leaves.get('')?.has(name)) repeatLeafNames.add(name);
    return { form, schema, labels, leaves, repeatsByName, repeatLeafNames, source };
  }, META_MS);
}

// org unit types of the project → hierarchy levels (by depth)
async function levels(sess, pid) {
  return memoize(`${userKey(sess)}|levels|${pid}`, async () => {
    try {
      const r = await iaso(sess, `/api/v2/orgunittypes/?project=${enc(pid)}`);
      const types = (r.orgUnitTypes || r.results || (Array.isArray(r) ? r : [])).filter(t => t && t.name && t.depth != null);
      const depths = [...new Set(types.map(t => Number(t.depth)))].sort((a, b) => a - b);
      if (!depths.length) throw new Error('aucun type');
      const byName = new Map(types.map(t => [t.name, depths.indexOf(Number(t.depth)) + 1]));
      const names = depths.map(d => [...new Set(types.filter(t => Number(t.depth) === d).map(t => t.short_name || t.name))].join(' / '));
      return { byName, names };
    } catch { return { byName: null, names: ['', '', '', '', ''] }; }
  }, META_MS);
}

// ancestors of org units: id → [{ name, type }] from the root down to the unit itself
const chains = new Map(); // `${server}|${user}|${id}` → { at, chain }
async function orgUnitChains(sess, units) {
  const now = Date.now(), out = new Map(), missing = [];
  for (const [id] of units) {
    const hit = chains.get(`${userKey(sess)}|${id}`);
    if (hit && now - hit.at < 30 * 60_000) out.set(id, hit.chain); else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const ids = missing.slice(i, i + 100);
    try {
      const searches = JSON.stringify([{ validation_status: 'all', search: `ids:${ids.join(',')}` }]);
      const r = await iaso(sess, `/api/orgunits/?limit=${ids.length}&page=1&smallSearch=true&order=id&searches=${enc(searches)}`);
      for (const ou of r.orgunits || r.orgUnits || []) {
        const chain = [];
        for (let n = ou, g = 0; n && g < 20; n = n.parent, g++) chain.unshift({ name: n.name, type: n.org_unit_type_name });
        out.set(String(ou.id), chain);
        chains.set(`${userKey(sess)}|${ou.id}`, { at: now, chain });
      }
    } catch (e) { console.warn(`iaso: hiérarchie des unités d'organisation indisponible (${e.message})`); break; }
  }
  if (chains.size > 50000) chains.clear();
  for (const [id, ou] of units) if (!out.has(id)) out.set(id, [{ name: ou.name, type: ou.org_unit_type_name }]);
  return out;
}

// flat file_content → nested tree using the form structure
function treeOf(flat, ctx, st) {
  const tree = {};
  const L = st.leaves.get(ctx) || new Map(), R = st.repeatsByName.get(ctx) || new Map();
  const rel = p => (ctx ? p.slice(ctx.length + 1) : p);
  const set = (p, v) => { const segs = p.split('/'); let o = tree; for (const s of segs.slice(0, -1)) o = (o[s] && typeof o[s] === 'object' && !Array.isArray(o[s])) ? o[s] : (o[s] = {}); o[segs[segs.length - 1]] = v; };
  for (const [k, v] of Object.entries(flat || {})) {
    if (k === '_version') continue;
    if (Array.isArray(v)) {
      const rp = R.get(k);
      if (rp) set(rel(rp), v.map(item => treeOf(item, rp, st)));
      continue;
    }
    if (v && typeof v === 'object') continue;
    const p = L.get(k);
    if (p) set(rel(p), v);
    // unknown key at the top: keep it, unless it belongs to a repeat that IASO stored flat (rebuilt below)
    else if (!ctx && !R.has(k) && !st.repeatLeafNames.has(k)) set(k, v);
  }
  // repeats IASO flattened because the form version was unknown: rebuild a single entry
  for (const [name, rp] of R) {
    if (flat && Array.isArray(flat[name])) continue;
    const inner = st.leaves.get(rp);
    if (!inner) continue;
    const item = {};
    for (const [leaf] of inner) if (flat && flat[leaf] !== undefined && !(L.has(leaf))) item[leaf] = flat[leaf];
    if (Object.keys(item).length) set(rel(rp), [treeOf(item, rp, st)]);
  }
  return tree;
}

async function pageAll(sess, base) {
  const out = [];
  for (let page = 1; page < 100000; page++) {
    const r = await iaso(sess, `${base}&limit=${PAGE}&page=${page}`);
    out.push(...(r.instances || []));
    if (!r.has_next || !(r.instances || []).length) break;
  }
  return out;
}

const INSTANCE_FIELDS = 'id,uuid,file_content,created_at,updated_at,source_created_at,org_unit,latitude,longitude,altitude,period,status,validation_status,created_by,last_modified_by';

async function dataset(sess, pid, fid, filter, extra = '') {
  const [st, lv] = await Promise.all([structure(sess, pid, fid), levels(sess, pid)]);
  const list = await pageAll(sess, `/api/instances/?form_ids=${enc(fid)}&order=id&fields=${INSTANCE_FIELDS}${filter ? '&' + filter : ''}${extra}`);
  const units = new Map();
  for (const i of list) if (i.org_unit && i.org_unit.id != null) units.set(String(i.org_unit.id), i.org_unit);
  const ch = units.size ? await orgUnitChains(sess, units) : new Map();
  const records = list.map(i => {
    const ou = i.org_unit || null;
    const fc = i.file_content || {};
    const by = i.created_by;
    const sys = {
      submissionDate: isoOrNull(i.source_created_at ?? i.created_at),
      updatedAt: isoOrNull(i.updated_at),
      receivedAt: isoOrNull(i.created_at),
      submitterName: by ? ([by.first_name, by.last_name].filter(Boolean).join(' ') || by.username) : null,
      orgUnit: ou ? ou.name : null,
      orgUnitType: ou ? ou.org_unit_type_name : null,
      period: i.period || null,
      status: i.status || null,
      validationStatus: i.validation_status || null,
      formVersion: fc._version || null,
      location: i.latitude != null && i.longitude != null ? toGeoPoint(`${i.latitude} ${i.longitude} ${i.altitude ?? ''}`) : null,
      orgUnitLocation: ou && ou.latitude != null && ou.longitude != null ? toGeoPoint(`${ou.latitude} ${ou.longitude}`) : null,
    };
    const chain = ou ? ch.get(String(ou.id)) || [] : [];
    if (lv.byName) { for (const n of chain) { const k = lv.byName.get(n.type); if (k) sys['level' + k] = n.name; } }
    else chain.slice(0, lv.names.length).forEach((n, k) => { sys['level' + (k + 1)] = n.name; });
    return explode(i.id, treeOf(fc, '', st), st.schema, sys);
  });
  return collect(records);
}

function systemFields(lv) {
  const OU = 'Unité d\'organisation et hiérarchie';
  return [
    { path: '__system/submissionDate', name: 'Date de création', type: 'dateTime', system: true },
    { path: '__system/updatedAt', name: 'Date de modification', type: 'dateTime', system: true },
    { path: '__system/receivedAt', name: 'Date de réception sur le serveur', type: 'dateTime', system: true },
    { path: '__system/submitterName', name: 'Créée par', type: 'string', system: true },
    { path: '__system/period', name: 'Période', type: 'string', system: true },
    { path: '__system/status', name: 'Statut', type: 'string', system: true },
    { path: '__system/validationStatus', name: 'Statut de validation', type: 'string', system: true },
    { path: '__system/formVersion', name: 'Version du formulaire', type: 'string', system: true },
    { path: '__system/location', name: 'Position GPS (soumission)', type: 'geopoint', system: true },
    { path: '__system/orgUnit', name: 'Unité d\'organisation', type: 'string', system: true, group: OU },
    { path: '__system/orgUnitType', name: 'Type d\'unité d\'organisation', type: 'string', system: true, group: OU },
    ...lv.names.map((n, k) => ({ path: `__system/level${k + 1}`, name: `Niveau ${k + 1}${n ? ' · ' + n : ''}`, type: 'string', system: true, group: OU, hierarchy: k + 1 })),
    { path: '__system/orgUnitLocation', name: 'Position de l\'unité d\'organisation', type: 'geopoint', system: true, group: OU },
  ];
}

module.exports = {
  id: 'iaso',
  label: 'IASO',
  features: { reviewState: false },
  sharedCache: false,
  normalizeServer: s => normalizeServer(String(s || '').replace(/\/(dashboard|api)(\/.*)?$/i, '')),

  async login({ server, email, password }) {
    const username = String(email || '').trim();
    if (!username || !password) throw httpError(400, 'Identifiant et mot de passe obligatoires.');
    let res;
    try {
      res = await fetchWithTimeout(`${server}/api/token/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ username, password }) });
    } catch (e) {
      throw httpError(502, `Impossible de joindre ${server} (${e.name === 'AbortError' ? 'délai dépassé' : e.cause?.code || e.message}). Vérifiez l'adresse.`);
    }
    if (res.status === 401 || res.status === 400) throw httpError(401, 'Identifiant ou mot de passe IASO incorrect (ou compte désactivé).');
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('json')) throw httpError(502, `Ce serveur ne répond pas comme IASO (HTTP ${res.status}). Vérifiez l'adresse et la plateforme choisie.`);
    const t = await res.json();
    if (!t.access) throw httpError(502, 'Réponse inattendue du serveur IASO.');
    let name = username;
    try {
      const me = await fetchWithTimeout(`${server}/api/profiles/me/`, { headers: { Authorization: `Bearer ${t.access}`, Accept: 'application/json' } }, 10_000);
      if (me.ok) { const p = await me.json(); name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.user_name || username; }
    } catch { /* optional */ }
    const exp = jwtExpiry(t.access);
    const until = Date.now() + SESSION_HOURS * 3600e3;
    return { email: username, name, token: t.access, expiresAt: new Date(exp ? Math.min(exp, until) : until).toISOString() };
  },

  async logout() { /* JWT: nothing to revoke server-side */ },

  // Before serving cached rows: the user's own account must be able to list this form's submissions.
  async access(sess, pid, fid) {
    await memoize(`${userKey(sess)}|access|${fid}`, () => iaso(sess, `/api/instances/?form_ids=${enc(fid)}&limit=1&page=1&fields=id`), 120_000);
  },

  async projects(sess) {
    const r = await iaso(sess, '/api/projects/');
    return (r.projects || r.results || []).map(p => ({ id: p.id, name: p.name }));
  },

  async forms(sess, pid) {
    const r = await iaso(sess, `/api/forms/?projectsIds=${enc(pid)}&order=name&fields=id,name,form_id,instances_count,projects`);
    return (r.forms || r.results || [])
      .filter(f => !f.projects || !f.projects.length || f.projects.some(p => String(p.id ?? p) === String(pid)))
      .map(f => ({ id: String(f.id), name: f.name || f.form_id, submissions: f.instances_count }));
  },

  async tables(sess, pid, fid) { return (await structure(sess, pid, fid)).schema.tables(); },

  async fields(sess, pid, fid) {
    const [st, lv] = await Promise.all([structure(sess, pid, fid), levels(sess, pid)]);
    return [
      ...st.schema.fields.filter(f => f.type !== 'structure' && !f.path.startsWith('meta/'))
        .map(({ path, name, type, selectMultiple, repeat }) => ({ path, name, type, selectMultiple: !!selectMultiple, repeat: !!repeat })),
      ...systemFields(lv),
    ];
  },

  async labels(sess, pid, fid) {
    const L = (await structure(sess, pid, fid)).labels;
    const fr = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { '': v }]));
    return { ...L, choices: { ...L.choices, '__system/status': fr(STATUS_LABELS), '__system/validationStatus': fr(VALIDATION_LABELS) } };
  },

  // IASO filters on the creation date (device date, else server date), by day
  filterKey(table, q) {
    const p = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) p.push(`dateFrom=${q.from}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) p.push(`dateTo=${q.to}`);
    return p.join('&');
  },

  incremental: () => true,
  refuseIncremental: () => {},

  source(sess, pid, fid) {
    const base = `/api/instances/?form_ids=${enc(fid)}`;
    const count = async filter => (await iaso(sess, `${base}${filter ? '&' + filter : ''}&limit=1&page=1&fields=id`)).count;
    // one download serves every table of the form requested at the same time (Submissions + repeats)
    const all = filter => memoize(`${userKey(sess)}|ds|${fid}|${filter}`, () => dataset(sess, pid, fid, filter), 10_000);
    return {
      async fetch(table, filter) {
        const ds = await all(filter);
        return { rows: ds.tables[table] || [], filtered: true, roots: table === 'Submissions' ? undefined : ds.roots };
      },
      rootSig: async () => `total:${await count('')}`,
      // most recently modified submissions (light request): how many changed after `iso`
      async changedSince(iso) {
        const r = await iaso(sess, `${base}&order=-updated_at&limit=100&page=1&fields=id,updated_at`);
        const t = Date.parse(iso);
        return (r.instances || []).filter(i => (i.updated_at || 0) * 1000 > t).length;
      },
      count: (table, filter) => count(filter),
      // modificationDateFrom is by day: the overlap is merged by __id
      async delta(filter, iso, table = 'Submissions') {
        const day = new Date(iso).toISOString().slice(0, 10);
        const ds = await memoize(`${userKey(sess)}|delta|${fid}|${filter}|${day}`, () => dataset(sess, pid, fid, filter, `&modificationDateFrom=${day}`), 30_000);
        return { rows: ds.tables[table] || [], roots: ds.roots };
      },
      childDelta: true,
    };
  },
};
