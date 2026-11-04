// CommCare HQ (Dimagi) connector.
//
// API used (checked against the CommCare HQ source code, github.com/dimagi/commcare-hq, corehq/apps/api):
//   Authorization: ApiKey <username>:<api key>   (or Basic <username>:<password>)
//   GET /api/v0.5/identity/                     who am I
//   GET /api/v0.5/user_domains/                 {objects: [{domain_name, project_name}]}  = "projects"
//   GET /a/<domain>/api/v0.5/application/       apps → modules → forms → questions (labels, options, repeats)
//   GET /a/<domain>/api/v0.5/form/?xmlns=…&app_id=…&limit=…&order_by=indexed_on&indexed_on_start=…
//       {meta: {next, total_count}, objects: [{id, form: {...nested answers...}, metadata, received_on,
//        server_modified_on, indexed_on, ...}]}. Filters: received_on_start/_end, server_modified_on_start.
//       Dates are accepted as %Y-%m-%d or %Y-%m-%dT%H:%M:%S(.%f), without time zone.
//   A repeat with a single entry comes as an object instead of a list.
//
// Rows are scoped to each user (permissions and location restrictions are CommCare's).

const { httpError, fetchWithTimeout, normalizeServer, memoize, enc, isoOrNull, toGeoPoint } = require('./common');
const { Schema, explode, collect } = require('./records');

const PAGE = Math.min(1000, Number(process.env.COMMCARE_PAGE_SIZE || 1000));
const META_MS = Number(process.env.CACHE_MINUTES || 5) * 60_000;
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

const TYPES = {
  Text: 'string', PhoneNumber: 'string', Secret: 'string', Barcode: 'barcode', Int: 'int', Long: 'int', Double: 'decimal',
  Date: 'date', DateTime: 'dateTime', Time: 'time', Geopoint: 'geopoint', Select: 'string', MSelect: 'string',
  Image: 'binary', Audio: 'binary', Video: 'binary', Signature: 'binary', Document: 'binary', DataBindOnly: 'string',
};
const SKIP_TYPES = new Set(['Trigger', 'SaveToCase', 'Label']);
const SKIP = p => /(^|\/)(meta|case|commcare_usercase)(\/|$)/.test(p) || /(^|\/)subcase_\d+(\/|$)/.test(p);

const userKey = sess => `commcare|${sess.server}|${sess.email}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// CommCare wants naive UTC timestamps: 2026-01-31T23:59:59.999999
const ccDate = iso => new Date(iso).toISOString().slice(0, 23);
const cursorOf = v => (String(v || '').match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)/) || [])[1] || null;

async function cc(sess, target) {
  const url = target.startsWith('http') ? target : `${sess.server}${target}`;
  if (!url.startsWith(sess.server + '/')) throw httpError(400, 'Requête hors du serveur CommCare connecté refusée.');
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetchWithTimeout(url, { headers: { Authorization: sess.token, Accept: 'application/json' } }, 180_000); }
    catch (e) { throw httpError(502, `Serveur CommCare injoignable (${e.name === 'AbortError' ? 'délai dépassé' : e.cause?.code || e.message}).`); }
    // CommCare throttles API calls: wait as asked and retry
    if ((res.status === 429 || res.status === 503) && attempt < 4) { await sleep(Math.min(60, Number(res.headers.get('retry-after')) || 2 ** attempt * 3) * 1000); continue; }
    if (res.status === 401) { const err = httpError(401, 'Session CommCare expirée ou clé API révoquée, reconnectez-vous.'); err.relogin = true; throw err; }
    if (res.status === 403) throw httpError(403, 'Votre compte CommCare n\'a pas accès à ces données (droits « Accès à l\'API » et « Modifier les données » requis).');
    if (res.status === 404) throw httpError(404, 'Ressource introuvable sur CommCare HQ (projet ou application supprimés ?).');
    if (!res.ok) throw httpError(res.status >= 500 ? 502 : res.status, `CommCare ${res.status} : ${(await res.text()).slice(0, 300)}`);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) throw httpError(502, 'Réponse inattendue de CommCare HQ (pas du JSON).');
    return res.json();
  }
}

async function list(sess, path) {
  const out = [];
  let next = path;
  for (let g = 0; next && g < 1000; g++) {
    const r = await cc(sess, next);
    out.push(...(r.objects || []));
    next = r.meta && r.meta.next ? (r.meta.next.startsWith('http') ? r.meta.next : r.meta.next.startsWith('/') ? r.meta.next : path.split('?')[0] + r.meta.next) : null;
  }
  return out;
}

const pickName = n => (n && typeof n === 'object' ? Object.values(n).find(Boolean) || '' : String(n || ''));

async function apps(sess, domain) {
  return memoize(`${userKey(sess)}|apps|${domain}`, () => list(sess, `/a/${enc(domain)}/api/v0.5/application/?limit=100`), META_MS);
}

async function formOf(sess, domain, fid) {
  const [appId, uid] = String(fid).split('.');
  const app = (await apps(sess, domain)).find(a => a.id === appId);
  if (!app) throw httpError(404, 'Application CommCare introuvable (supprimée, ou pas accessible avec ce compte).');
  for (const m of app.modules || []) for (const f of m.forms || []) if (f.unique_id === uid) return { app, module: m, form: f };
  throw httpError(404, 'Formulaire CommCare introuvable dans la dernière version de l\'application.');
}

function structure(sess, domain, fid) {
  return memoize(`${userKey(sess)}|structure|${domain}|${fid}`, async () => {
    const { app, form } = await formOf(sess, domain, fid);
    const fields = [], labels = { languages: [], defaultLang: '', fields: {}, choices: {} };
    const langs = [];
    const tr = (q) => {
      const t = q.translations && Object.keys(q.translations).length ? { ...q.translations } : q.label ? { '': String(q.label) } : null;
      if (t) for (const k of Object.keys(t)) if (k && !langs.includes(k)) langs.push(k);
      return t;
    };
    const seen = new Set();
    for (const q of form.questions || []) {
      const path = String(q.value || '').replace(/^\/+/, '').split('/').slice(1).join('/');
      if (!path || seen.has(path) || SKIP(path) || SKIP_TYPES.has(q.type) || q.tag === 'trigger') continue;
      seen.add(path);
      const name = path.split('/').pop();
      const L = tr(q);
      if (L) labels.fields[path] = L;
      if (q.type === 'Repeat' || q.tag === 'repeat') { fields.push({ path, name, type: 'repeat', selectMultiple: false, repeat: true }); continue; }
      if (q.type === 'Group' || q.type === 'FieldList' || q.is_group) { fields.push({ path, name, type: 'structure', selectMultiple: false, repeat: false }); continue; }
      fields.push({ path, name, type: TYPES[q.type] || 'string', selectMultiple: q.type === 'MSelect', repeat: false, hidden: q.type === 'DataBindOnly' });
      if (Array.isArray(q.options) && q.options.length) {
        const map = {};
        for (const o of q.options) if (o && o.value != null) map[String(o.value)] = tr(o) || {};
        labels.choices[path] = map;
      }
    }
    // repeats nested in a group the API did not list
    labels.languages = langs;
    labels.defaultLang = (app.langs && app.langs.find(l => langs.includes(l))) || langs[0] || '';
    return { schema: new Schema(fields), labels, xmlns: form.xmlns, appId: app.id };
  }, META_MS);
}

async function pageForms(sess, base) {
  const seen = new Map();
  let cursor = null, offset = 0;
  for (let g = 0; g < 100000; g++) {
    const url = `${base}&limit=${PAGE}&order_by=indexed_on${cursor ? `&indexed_on_start=${enc(cursor)}` : ''}${offset ? `&offset=${offset}` : ''}`;
    const r = await cc(sess, url);
    const objs = r.objects || [];
    for (const o of objs) if (!seen.has(o.id)) seen.set(o.id, o);
    if (!objs.length || !(r.meta && r.meta.next)) break;
    // keyset paging on indexed_on (deep offsets are slow or refused by Elasticsearch)
    const last = cursorOf(objs[objs.length - 1].indexed_on);
    if (!last || last === cursor) offset += objs.length; else { cursor = last; offset = 0; }
  }
  return [...seen.values()];
}

async function dataset(sess, domain, fid, filter, extra = '') {
  const st = await structure(sess, domain, fid);
  const base = `/a/${enc(domain)}/api/v0.5/form/?xmlns=${enc(st.xmlns)}&app_id=${enc(st.appId)}${filter ? '&' + filter : ''}${extra}`;
  const forms = await pageForms(sess, base);
  const records = forms.map(o => {
    const md = o.metadata || {};
    const meta = (o.form && o.form.meta) || {};
    const sys = {
      submissionDate: isoOrNull(o.received_on),
      updatedAt: isoOrNull(o.server_modified_on || o.received_on),
      timeStart: isoOrNull(md.timeStart || meta.timeStart),
      timeEnd: isoOrNull(md.timeEnd || meta.timeEnd),
      submitterName: md.username || meta.username || null,
      deviceId: md.deviceID || meta.deviceID || null,
      formVersion: (o.form && o.form['@version']) || o.version || null,
      appVersion: md.app_build_version != null ? String(md.app_build_version) : null,
      location: toGeoPoint(md.location || meta.location),
      edited: o.edited_on ? 'oui' : 'non',
    };
    return explode(o.id, o.form || {}, st.schema, sys, { skip: SKIP });
  });
  return collect(records);
}

const SYSTEM_FIELDS = [
  { path: '__system/submissionDate', name: 'Date de réception', type: 'dateTime', system: true },
  { path: '__system/timeStart', name: 'Début de saisie', type: 'dateTime', system: true },
  { path: '__system/timeEnd', name: 'Fin de saisie', type: 'dateTime', system: true },
  { path: '__system/updatedAt', name: 'Date de modification', type: 'dateTime', system: true },
  { path: '__system/submitterName', name: 'Utilisateur mobile', type: 'string', system: true },
  { path: '__system/deviceId', name: 'Appareil', type: 'string', system: true },
  { path: '__system/formVersion', name: 'Version de l\'application', type: 'string', system: true },
  { path: '__system/edited', name: 'Modifiée après envoi', type: 'string', system: true },
  { path: '__system/location', name: 'Position GPS (métadonnées)', type: 'geopoint', system: true },
];

module.exports = {
  id: 'commcare',
  label: 'CommCare',
  features: { reviewState: false },
  sharedCache: false,
  normalizeServer(s) {
    const n = normalizeServer(String(s || '').replace(/\/(a|accounts|api|hq|ng)\/.*$/i, ''), /\/(a|api)$/);
    return n.replace(/^https:\/\/commcarehq\.org$/i, 'https://www.commcarehq.org');
  },

  async login({ server, email, password }) {
    const username = String(email || '').trim();
    const secret = String(password || '');
    if (!username || !secret) throw httpError(400, 'Identifiant (e-mail) et clé API ou mot de passe obligatoires.');
    const tries = [`ApiKey ${username}:${secret}`, `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`];
    let me = null, token = null, last = null;
    for (const auth of tries) {
      let res;
      try { res = await fetchWithTimeout(`${server}/api/v0.5/identity/`, { headers: { Authorization: auth, Accept: 'application/json' } }); }
      catch (e) { throw httpError(502, `Impossible de joindre ${server} (${e.name === 'AbortError' ? 'délai dépassé' : e.cause?.code || e.message}). Vérifiez l'adresse.`); }
      last = res.status;
      if (res.status === 401 || res.status === 403) continue;
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('json')) throw httpError(502, `Ce serveur ne répond pas comme CommCare HQ (HTTP ${res.status}). Vérifiez l'adresse et la plateforme choisie.`);
      me = await res.json(); token = auth; break;
    }
    if (!me) throw httpError(401, last === 403 ? 'Compte CommCare sans accès à l\'API.' : 'Identifiant ou clé API CommCare incorrects. Avec la double authentification ou le SSO, utilisez une clé API (Paramètres du compte → Clés API).');
    const name = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username || username;
    return { email: me.username || username, name, token, expiresAt: new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString() };
  },

  async logout() { /* API keys are not revoked: they belong to the user */ },

  async access(sess, pid, fid) {
    await memoize(`${userKey(sess)}|access|${pid}|${fid}`, async () => {
      const st = await structure(sess, pid, fid);
      return cc(sess, `/a/${enc(pid)}/api/v0.5/form/?xmlns=${enc(st.xmlns)}&app_id=${enc(st.appId)}&limit=1`);
    }, 120_000);
  },

  async projects(sess) {
    const r = await list(sess, '/api/v0.5/user_domains/?limit=100');
    return r.map(d => ({ id: d.domain_name, name: d.project_name || d.domain_name }));
  },

  async forms(sess, pid) {
    const out = [];
    for (const app of await apps(sess, pid)) {
      if (app.is_deleted || app.doc_type === 'Application-Deleted') continue;
      for (const m of app.modules || []) for (const f of m.forms || []) {
        if (!f.unique_id) continue;
        out.push({ id: `${app.id}.${f.unique_id}`, name: [app.name, pickName(m.name), pickName(f.name)].filter(Boolean).join(' › ') });
      }
    }
    return out;
  },

  async tables(sess, pid, fid) { return (await structure(sess, pid, fid)).schema.tables(); },

  async fields(sess, pid, fid) {
    const st = await structure(sess, pid, fid);
    return [
      ...st.schema.fields.filter(f => f.type !== 'structure').map(({ path, name, type, selectMultiple, repeat }) => ({ path, name, type, selectMultiple: !!selectMultiple, repeat: !!repeat })),
      ...SYSTEM_FIELDS,
    ];
  },

  async labels(sess, pid, fid) { return (await structure(sess, pid, fid)).labels; },

  // received_on (server reception date)
  filterKey(table, q) {
    const p = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) p.push(`received_on_start=${q.from}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) p.push(`received_on_end=${q.to}T23:59:59.999999`);
    return p.join('&');
  },

  incremental: () => true,
  refuseIncremental: () => {},

  source(sess, pid, fid) {
    const url = async (filter, extra = '') => {
      const st = await structure(sess, pid, fid);
      return `/a/${enc(pid)}/api/v0.5/form/?xmlns=${enc(st.xmlns)}&app_id=${enc(st.appId)}${filter ? '&' + filter : ''}${extra}`;
    };
    const count = async (filter, extra) => (await cc(sess, `${await url(filter, extra)}&limit=1`)).meta.total_count;
    // one download serves every table of the form requested at the same time (Submissions + repeats)
    const all = filter => memoize(`${userKey(sess)}|ds|${pid}|${fid}|${filter}`, () => dataset(sess, pid, fid, filter), 10_000);
    return {
      async fetch(table, filter) {
        const ds = await all(filter);
        return { rows: ds.tables[table] || [], filtered: true, roots: table === 'Submissions' ? undefined : ds.roots };
      },
      rootSig: async () => `total:${await count('')}`,
      changedSince: iso => count('', `&server_modified_on_start=${ccDate(iso)}`),
      count: (table, filter) => count(filter),
      async delta(filter, iso, table = 'Submissions') {
        const since = ccDate(iso);
        const ds = await memoize(`${userKey(sess)}|delta|${pid}|${fid}|${filter}|${since.slice(0, 16)}`, () => dataset(sess, pid, fid, filter, `&server_modified_on_start=${since}`), 30_000);
        return { rows: ds.tables[table] || [], roots: ds.roots };
      },
      childDelta: true,
    };
  },
};
